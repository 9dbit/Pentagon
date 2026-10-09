require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const PgSessionStore = require("./pgSessionStore");
const { pool } = require("./db");
const { runChecks, runManualCheck, startScheduler, maybeAddProviderRegistryResult, clearRecurringAlert, getScanCycleHealth } = require("./scheduler");
const { normalizeDomain, checkDomain, calculateGlobalStatus } = require("./checker");
const settingsRoutes = require("./settingsRoutes");
const projectRoutes = require("./projectRoutes");
const { router: rankRoutes, nodeCheckRouter } = require("./rankRoutes");
const analyticsRoutes = require("./analyticsRoutes");
const projectTelegramRoutes = require("./projectTelegramRoutes");
const trustpositifRoutes = require("./trustpositifRoutes");
const { router: nodeRoutes } = require("./nodeRoutes");
const { router: agentPollRoutes } = require("./agentPollRoutes");
const { getActiveNodes, checkViaNode } = require("./nodeChecker");
const { loadSettings } = require("./settingsStore");
const { sendTelegram, answerCallbackQuery, editMessageReplyMarkup } = require("./telegram");
const { markAcknowledged } = require("./noticeState");
const { normalizeEmail, isEmailWhitelistEnabled, isEmailAllowed } = require("./authAllowlist");
const axios = require("axios");
const { seedDemoData } = require("./demoSeed");

const app = express();
const sessionSecret = process.env.SESSION_SECRET || "domain-radar-dev-session-secret";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const ipCountryCache = {};
async function getCountry(ip) {
  const clean = (ip||'').replace(/^::ffff:/,'').split(',')[0].trim();
  if (!clean || clean==='127.0.0.1' || clean.startsWith('192.168.') || clean.startsWith('10.') || clean.startsWith('172.') || clean==='::1') return '';
  if (ipCountryCache[clean] !== undefined) return ipCountryCache[clean];
  try {
    const resp = await fetch(`http://ip-api.com/json/${clean}?fields=countryCode`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    ipCountryCache[clean] = data.countryCode || '';
  } catch(_) { ipCountryCache[clean] = ''; }
  return ipCountryCache[clean];
}

app.set("trust proxy", 1);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(session({ store: new PgSessionStore(pool), name: "domain_radar_sid", secret: sessionSecret, resave: false, saveUninitialized: false, proxy: true, cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 1000 * 60 * 60 * 24 * 7 } }));

function requireAdmin(req, res, next) { if (!adminPassword) return next(); if (req.session && req.session.isAdmin) return next(); return res.status(401).json({ error: "Unauthorized" }); }
function getTenant(req) { return (req.session && req.session.tenant) || 'admin'; }
function requireNotDemo(req, res, next) { if (req.session && req.session.isDemo) return res.status(403).json({ error: "Demo mode — read only" }); next(); }
function requireNotDemoWrite(req, res, next) { if (req.method !== 'GET' && req.session && req.session.isDemo) return res.status(403).json({ error: "Demo mode — read only" }); next(); }
function attachTenant(req, res, next) { req.tenant = getTenant(req); next(); }
function csvEscape(value) { if (value === null || value === undefined) return ""; const text = String(value).replace(/"/g, '""'); return /[",\n\r]/.test(text) ? `"${text}"` : text; }
function sendCsv(res, filename, rows) { const headers = rows.length ? Object.keys(rows[0]) : []; const body = [headers.join(",")].concat(rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","))).join("\n"); res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`); res.send(body); }
function parseBulkLine(line) { const raw = String(line || "").trim(); if (!raw) return null; const parts = raw.split(/[,;\t]/).map((x) => x.trim()); return { domain: normalizeDomain(parts[0] || ""), project_name: parts.slice(1).join(" ") || "" }; }

async function runSingleDomainCheck(domainRow) {
  const proxies = (await pool.query("SELECT * FROM proxies WHERE is_active=true")).rows;
  const nodes = await getActiveNodes();
  const checks = [checkDomain(domainRow.domain, { type: "direct", provider_name: "Direct" })];
  for (const proxy of proxies) checks.push(checkDomain(domainRow.domain, { type: "proxy", provider_name: proxy.provider_name || proxy.name, proxy }));
  for (const node of nodes) checks.push(checkViaNode(domainRow.domain, node));
  const results = await Promise.all(checks);
  await maybeAddProviderRegistryResult(domainRow, results);
  for (const result of results) {
    await pool.query(`INSERT INTO check_results (domain_id, checker_type, provider_name, status, http_status, final_url, dns_result, latency_ms, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [domainRow.id, result.checker_type, result.provider_name, result.status, result.http_status, result.final_url, result.dns_result, result.latency_ms, result.reason]);
  }
  const oldStatus = domainRow.global_status || "unknown";
  const newStatus = calculateGlobalStatus(results);
  await pool.query("UPDATE domains SET last_status=$1, global_status=$2, last_checked_at=NOW() WHERE id=$3", [oldStatus, newStatus, domainRow.id]);
  if (oldStatus !== newStatus) {
    const message = `DOMAIN STATUS CHANGED\n\nDomain: ${domainRow.domain}\nOld: ${oldStatus}\nNew: ${newStatus}\nMode: Single manual check`;
    const sent = await sendTelegram(message);
    await pool.query("INSERT INTO alerts (domain_id, old_status, new_status, message, sent_to_telegram) VALUES ($1,$2,$3,$4,$5)", [domainRow.id, oldStatus, newStatus, message, sent]);
  }
  return { old_status: oldStatus, new_status: newStatus, results };
}

app.get("/api/health", async (req, res) => { try { await pool.query("SELECT 1"); res.json({ ok: true, database: "connected", auth_enabled: Boolean(adminPassword), email_whitelist_enabled: isEmailWhitelistEnabled() }); } catch (err) { res.status(500).json({ ok: false, database: "error", message: err.message }); } });
app.get("/api/provider-node/releases/latest", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key=$1 LIMIT 1", ["provider_node_release"]);
    if (!rows[0]?.value) return res.status(404).json({ error: "No provider node release published" });
    let release;
    try { release = JSON.parse(rows[0].value); }
    catch (_) { return res.status(500).json({ error: "Invalid provider node release metadata" }); }
    return res.json(release);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Release lookup failed" });
  }
});
app.get("/api/provider-node/releases/cloud/latest", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    const base = String(process.env.PROVIDER_NODE_CLOUD_RELEASE_URL || "").replace(/\/+$/, "");
    if (!base) return res.status(503).json({ error: "Cloud provider node release channel is not configured" });
    const response = await axios.get(`${base}/latest.json?t=${Date.now()}`, {
      timeout: 12000,
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": "PentagonReleaseProxy/1.0" },
      validateStatus: (status) => status >= 200 && status < 500
    });
    if (response.status !== 200) return res.status(502).json({ error: "Release service unavailable", upstream_status: response.status });
    return res.json(response.data);
  } catch (err) {
    return res.status(502).json({ error: err.message || "Cloud release lookup failed" });
  }
});
app.get("/api/scan-cycle-health", requireAdmin, (req, res) => { res.json(getScanCycleHealth()); });
app.get("/api/auth/me", (req, res) => res.json({ authenticated: !adminPassword || Boolean(req.session && req.session.isAdmin), email: req.session?.adminEmail || "", isDemo: Boolean(req.session?.isDemo), tenant: req.session?.tenant || "admin" }));
app.post("/api/auth/login", (req, res) => { const email = normalizeEmail(req.body.email || ""); const password = String(req.body.password || ""); const demoPassword = process.env.DEMO_PASSWORD || "Domainradar123"; if (email === "demo@domain-radar.org" && password === demoPassword) { req.session.isAdmin = true; req.session.isDemo = true; req.session.tenant = "demo"; req.session.adminEmail = email; return res.json({ ok: true, email, isDemo: true }); } if (!adminPassword) { req.session.isAdmin = true; req.session.isDemo = false; req.session.tenant = "admin"; req.session.adminEmail = email; return res.json({ ok: true }); } if (password !== adminPassword) return res.status(401).json({ error: "Invalid password" }); if (isEmailWhitelistEnabled() && !email) return res.status(401).json({ error: "Email required" }); if (!isEmailAllowed(email)) return res.status(403).json({ error: "Email not whitelisted" }); req.session.isAdmin = true; req.session.isDemo = false; req.session.tenant = "admin"; req.session.adminEmail = email; res.json({ ok: true, email }); });
app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => { res.clearCookie("domain_radar_sid"); res.json({ ok: true }); }); });

app.get("/api/auth/users", requireAdmin, requireNotDemo, async (req, res, next) => {
  try {
    let emails;
    if (isEmailWhitelistEnabled()) {
      emails = require("./authAllowlist").getAdminEmailWhitelist();
    } else {
      const sessionEmail = req.session.adminEmail || "";
      const envEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : "";
      emails = [sessionEmail || envEmail || "admin"];
    }
    const nickRows = emails.length
      ? (await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [emails.map(e => `user_nick_${e}`)]) ).rows
      : [];
    const nickMap = {};
    nickRows.forEach(r => { nickMap[r.key] = r.value; });
    const users = emails.map(email => ({ email, nickname: nickMap[`user_nick_${email}`] || "" }));
    res.json(users);
  } catch (err) { next(err); }
});

app.patch("/api/auth/users/nickname", requireAdmin, requireNotDemo, async (req, res, next) => {
  try {
    const { email, nickname } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    const key = `user_nick_${String(email).trim().toLowerCase()}`;
    const val = String(nickname || "").trim();
    if (val) {
      await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, val]);
    } else {
      await pool.query(`DELETE FROM app_settings WHERE key=$1`, [key]);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.use("/api/agent", agentPollRoutes);
app.use("/api/settings", requireAdmin, requireNotDemoWrite, settingsRoutes);
app.use("/api/projects", requireAdmin, requireNotDemoWrite, attachTenant, projectRoutes);
app.use("/api/rank", nodeCheckRouter);
app.use("/api/rank", requireAdmin, requireNotDemoWrite, attachTenant, rankRoutes);
app.use("/api/analytics", requireAdmin, requireNotDemo, analyticsRoutes);
app.use("/api/nodes", requireAdmin, requireNotDemoWrite, attachTenant, nodeRoutes);
app.use("/api/project-telegram", requireAdmin, requireNotDemoWrite, projectTelegramRoutes);
app.use("/api", requireAdmin, trustpositifRoutes);

app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const callback = req.body && req.body.callback_query;
    if (!callback || !callback.data) return res.json({ ok: true });

    const parts = String(callback.data).split(":");
    if (parts[0] !== "noticed") return res.json({ ok: true });

    const domainId = Number(parts[1]);
    const status = parts[2] || "blocked";
    if (!Number.isFinite(domainId) || status !== "blocked") {
      await answerCallbackQuery(callback.id, "Invalid notice");
      return res.json({ ok: true });
    }

    await markAcknowledged(domainId, callback.from || {});
    await clearRecurringAlert(domainId).catch(() => {});
    await answerCallbackQuery(callback.id, "Noticed. Blocked alert acknowledged.");

    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, {
        inline_keyboard: [[{ text: "✅ Noticed", callback_data: "noticed_done" }]]
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.json({ ok: false });
  }
});

app.post("/api/telegram/test", requireAdmin, requireNotDemo, async (req, res) => { const message = `DOMAIN RADAR TEST\n\nTelegram alert is working.\nTime: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`; const sent = await sendTelegram(message); res.json({ ok: sent }); });
app.get("/api/overview", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE global_status='working')::int AS working, COUNT(*) FILTER (WHERE global_status='warning')::int AS warning, COUNT(*) FILTER (WHERE global_status='blocked')::int AS blocked, MAX(last_checked_at) AS last_checked FROM domains WHERE tenant=$1`, [tenant]); res.json(rows[0]); });
app.get("/api/alerts", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query(`SELECT a.*, d.domain, d.project_name FROM alerts a JOIN domains d ON d.id = a.domain_id WHERE d.tenant=$1 ORDER BY a.created_at DESC LIMIT 100`, [tenant]); res.json(rows); });
app.get("/api/domains", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query("SELECT * FROM domains WHERE tenant=$1 ORDER BY id DESC", [tenant]); res.json(rows); });
app.post("/api/domains", requireAdmin, requireNotDemo, async (req, res) => { const domain = normalizeDomain(req.body.domain || ""); const project = req.body.project_name || ""; if (!domain) return res.status(400).json({ error: "Domain required" }); const { rows } = await pool.query(`INSERT INTO domains (domain, project_name) VALUES ($1,$2) ON CONFLICT (domain) DO UPDATE SET project_name=EXCLUDED.project_name RETURNING *`, [domain, project]); res.json(rows[0]); });
app.post("/api/domains/bulk", requireAdmin, requireNotDemo, async (req, res) => { const items = String(req.body.text || "").split(/\r?\n/).map(parseBulkLine).filter((x) => x && x.domain); const inserted = []; for (const item of items) { const { rows } = await pool.query(`INSERT INTO domains (domain, project_name) VALUES ($1,$2) ON CONFLICT (domain) DO UPDATE SET project_name=COALESCE(NULLIF(EXCLUDED.project_name,''), domains.project_name) RETURNING *`, [item.domain, item.project_name]); if (rows[0]) inserted.push(rows[0]); } res.json({ inserted_count: inserted.length, inserted }); });
app.patch("/api/domains/:id", requireAdmin, requireNotDemo, async (req, res) => {
  const { domain, is_active, project_name, label } = req.body;
  const cleanDomain = domain !== undefined ? normalizeDomain(domain) : undefined;
  const labelVal = label !== undefined ? String(label) : null;
  const { rows } = await pool.query(
    `UPDATE domains SET domain=COALESCE($1,domain), is_active=COALESCE($2,is_active), project_name=COALESCE($3,project_name), label=CASE WHEN $5::text IS NOT NULL THEN $5 ELSE label END WHERE id=$4 RETURNING *`,
    [cleanDomain || null, is_active, project_name, req.params.id, labelVal]
  );
  const updated = rows[0];
  if (updated && (updated.label === "landing_page" || updated.label === "ms") && updated.project_name) {
    try {
      const { rows: groups } = await pool.query(
        "SELECT id FROM rank_keyword_groups WHERE project_name=$1",
        [updated.project_name]
      );
      for (const g of groups) {
        await pool.query(
          `INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) VALUES ($1,$2,true) ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true`,
          [g.id, updated.domain]
        );
      }
    } catch (syncErr) {
      console.warn("[LP/MS sync]", syncErr.message);
    }
  }
  res.json(updated);
});
app.delete("/api/domains/:id", requireAdmin, requireNotDemo, async (req, res) => { await pool.query("DELETE FROM domains WHERE id=$1", [req.params.id]); res.json({ ok: true }); });
app.get("/api/proxies", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query("SELECT * FROM proxies WHERE tenant=$1 ORDER BY id DESC", [tenant]); res.json(rows); });
app.post("/api/proxies", requireAdmin, requireNotDemo, async (req, res) => { const { name, provider_name, proxy_url, proxy_type } = req.body; const { rows } = await pool.query(`INSERT INTO proxies (name, provider_name, proxy_url, proxy_type) VALUES ($1,$2,$3,$4) RETURNING *`, [name, provider_name, proxy_url, proxy_type || "http"]); res.json(rows[0]); });
app.delete("/api/proxies/:id", requireAdmin, requireNotDemo, async (req, res) => { await pool.query("DELETE FROM proxies WHERE id=$1", [req.params.id]); res.json({ ok: true }); });
app.get("/api/results", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query(`SELECT r.*, d.domain FROM check_results r JOIN domains d ON d.id = r.domain_id WHERE d.tenant=$1 ORDER BY r.checked_at DESC LIMIT 300`, [tenant]); res.json(rows); });
app.get("/api/export/domains.csv", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query("SELECT id, domain, project_name, is_active, global_status, last_status, last_checked_at, created_at FROM domains WHERE tenant=$1 ORDER BY id DESC", [tenant]); sendCsv(res, "domains.csv", rows); });
app.get("/api/export/results.csv", requireAdmin, async (req, res) => { const tenant = getTenant(req); const { rows } = await pool.query(`SELECT r.checked_at, d.domain, r.provider_name, r.checker_type, r.status, r.http_status, r.latency_ms, r.final_url, r.reason FROM check_results r JOIN domains d ON d.id = r.domain_id WHERE d.tenant=$1 ORDER BY r.checked_at DESC LIMIT 5000`, [tenant]); sendCsv(res, "check-results.csv", rows); });
app.post("/api/check/manual", requireAdmin, requireNotDemo, (req, res) => {
  runManualCheck().catch((err) => console.error("[manual check]", err.message));
  res.json({ ok: true });
});
app.post("/api/check/domain/:id", requireAdmin, requireNotDemo, async (req, res) => { const { rows } = await pool.query("SELECT * FROM domains WHERE id=$1", [req.params.id]); if (!rows[0]) return res.status(404).json({ error: "Domain not found" }); const result = await runSingleDomainCheck(rows[0]); res.json({ ok: true, ...result }); });

app.post("/api/activity/heartbeat", requireAdmin, requireNotDemo, async (req, res) => { const { session_id, page } = req.body; if (!session_id) return res.status(400).json({ error: "session_id required" }); const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(); const ua = req.headers['user-agent'] || ''; const email = req.session.adminEmail || ''; let nickname = ''; if (email) { try { const nr = await pool.query('SELECT value FROM app_settings WHERE key=$1', [`user_nick_${email}`]); nickname = nr.rows[0]?.value || ''; } catch(_) {} } const country = await getCountry(ip); try { await pool.query(`INSERT INTO user_sessions (session_id, user_agent, ip, page, email, nickname, country, first_seen_at, last_seen_at, heartbeat_count) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),1) ON CONFLICT (session_id) DO UPDATE SET last_seen_at=NOW(), page=EXCLUDED.page, email=EXCLUDED.email, nickname=EXCLUDED.nickname, country=CASE WHEN user_sessions.country='' THEN EXCLUDED.country ELSE user_sessions.country END, heartbeat_count=user_sessions.heartbeat_count+1`, [session_id, ua, ip, page || 'dashboard', email, nickname, country]); res.json({ ok: true }); } catch(e) { console.error("heartbeat error:", e.message); res.status(500).json({ error: "heartbeat failed" }); } });
app.get("/api/activity/sessions", requireAdmin, requireNotDemo, async (req, res) => { try { const { rows } = await pool.query(`SELECT *, last_seen_at > NOW() - interval '3 minutes' AS is_active, EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)) AS duration_seconds FROM user_sessions WHERE last_seen_at > NOW() - interval '7 days' ORDER BY last_seen_at DESC LIMIT 300`); res.json(rows); } catch(e) { console.error("sessions error:", e.message); res.json([]); } });
app.get("/api/activity/hourly", requireAdmin, requireNotDemo, async (req, res) => { try { const { rows } = await pool.query(`SELECT date_trunc('hour', last_seen_at) AS hour, COUNT(*) AS session_count FROM user_sessions WHERE last_seen_at > NOW() - interval '24 hours' GROUP BY 1 ORDER BY 1`); res.json(rows); } catch(e) { console.error("hourly error:", e.message); res.json([]); } });
app.get("/api/activity/watch-hours", requireAdmin, requireNotDemo, async (req, res) => { const p = req.query.period; try { if (p === 'today') { const { rows } = await pool.query(`SELECT email, MAX(nickname) AS nickname, date_trunc('hour', last_seen_at) AS bucket, SUM(heartbeat_count * 30)::int AS watch_seconds FROM user_sessions WHERE last_seen_at >= NOW()::date AND last_seen_at < NOW()::date + INTERVAL '1 day' AND email != '' GROUP BY email, date_trunc('hour', last_seen_at) ORDER BY bucket, email`); return res.json(rows); } let interval, trunc; if (p === 'weekly') { interval = '12 weeks'; trunc = 'week'; } else if (p === 'monthly') { interval = '12 months'; trunc = 'month'; } else { interval = '30 days'; trunc = 'day'; } const { rows } = await pool.query(`SELECT email, MAX(nickname) AS nickname, date_trunc('${trunc}', last_seen_at) AS bucket, SUM(heartbeat_count * 30)::int AS watch_seconds FROM user_sessions WHERE last_seen_at > NOW() - interval '${interval}' AND email != '' GROUP BY email, date_trunc('${trunc}', last_seen_at) ORDER BY bucket, email`); res.json(rows); } catch(e) { console.error("watch-hours error:", e.message); res.json([]); } });
let _aiEndpointCache = null;
app.get("/api/ai-endpoint-status", requireAdmin, async (req, res) => {
  if (_aiEndpointCache && Date.now() - _aiEndpointCache.ts < 30000) return res.json(_aiEndpointCache.data);
  try {
    const result = await checkDomain("api.openai.com", { type: "direct", provider_name: "Direct" });
    const data = { ok: result.status === "working", status: result.status, latencyMs: result.latency_ms, reason: result.reason, checkedAt: new Date().toISOString() };
    _aiEndpointCache = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    const data = { ok: false, status: "warning", latencyMs: null, reason: err.message, checkedAt: new Date().toISOString() };
    _aiEndpointCache = { ts: Date.now(), data };
    res.json(data);
  }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || "Internal server error" }); });
const distPath = path.join(__dirname, "../dist");
const importedFrontendIndex = path.join(distPath, "replit-index.html");
app.get("/", (req, res, next) => {
  if (fs.existsSync(importedFrontendIndex)) return res.sendFile(importedFrontendIndex);
  next();
});
app.use(express.static(distPath, { index: false }));
app.get("*", (req, res) => {
  if (fs.existsSync(importedFrontendIndex)) return res.sendFile(importedFrontendIndex);
  const indexPath = path.join(distPath, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.json({ ok: true, message: "API server is running. Run npm run client for the dashboard during development." });
});
const port = process.env.PORT || 3000;
async function boot() { try { await pool.query("ALTER TABLE domains ADD COLUMN IF NOT EXISTS label TEXT DEFAULT ''"); } catch(e) { console.warn("label migration:", e.message); } for (const t of ['domains','proxies','projects','provider_nodes']) { try { await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'admin'`); } catch(e) { console.warn(`tenant col ${t}:`, e.message); } } try { await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (session_id TEXT PRIMARY KEY, user_agent TEXT, ip TEXT, page TEXT DEFAULT 'dashboard', email TEXT DEFAULT '', nickname TEXT DEFAULT '', country TEXT DEFAULT '', first_seen_at TIMESTAMPTZ DEFAULT NOW(), last_seen_at TIMESTAMPTZ DEFAULT NOW(), heartbeat_count INT DEFAULT 1)`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS page TEXT DEFAULT 'dashboard'`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS nickname TEXT DEFAULT ''`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS country TEXT DEFAULT ''`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`); await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS heartbeat_count INT DEFAULT 1`); await pool.query(`DELETE FROM user_sessions WHERE last_seen_at < NOW() - INTERVAL '90 days'`); console.log("user_sessions table ready, old rows pruned"); } catch(e) { console.warn("user_sessions migration:", e.message); } try { await seedDemoData(); console.log("Demo data seeded"); } catch(e) { console.warn("Demo seed:", e.message); } try { await loadSettings(); console.log("Settings loaded from database"); } catch (err) { console.error("Settings load failed, using env defaults:", err.message); } app.listen(port, () => { console.log(`Server running on ${port}`); startScheduler(); }); }
boot();
