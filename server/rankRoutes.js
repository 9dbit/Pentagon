const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("./db");
const { normalizeDomain } = require("./checker");
const { sendTelegram, sendTelegramToProject } = require("./telegram");

const router = express.Router();
const nodeCheckRouter = express.Router();

const DEFAULT_ALLOWED_EXTERNAL = ["medium.com", "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "reddit.com", "behance.net", "github.com", "github.io", "linktr.ee", "heylink.me", "bit.ly", "x.com", "twitter.com"];

async function ensureRankTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_keywords (id SERIAL PRIMARY KEY, project_name TEXT DEFAULT '', domain TEXT NOT NULL, keyword TEXT NOT NULL, target_url TEXT DEFAULT '', is_active BOOLEAN DEFAULT TRUE, last_position INTEGER, last_page INTEGER, last_checked_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(domain, keyword))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_results (id SERIAL PRIMARY KEY, keyword_id INTEGER, keyword TEXT NOT NULL, domain TEXT NOT NULL, position INTEGER, page INTEGER, matched_url TEXT, source TEXT DEFAULT 'google_custom_search', checked_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_keyword_groups (id SERIAL PRIMARY KEY, project_name TEXT DEFAULT '', keyword TEXT NOT NULL, keyword_lc TEXT NOT NULL UNIQUE, is_active BOOLEAN DEFAULT TRUE, last_checked_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_keyword_domains (id SERIAL PRIMARY KEY, group_id INTEGER REFERENCES rank_keyword_groups(id) ON DELETE CASCADE, domain TEXT NOT NULL, target_url TEXT DEFAULT '', is_whitelisted BOOLEAN DEFAULT TRUE, last_position INTEGER, last_page INTEGER, last_matched_url TEXT, last_status TEXT DEFAULT 'pending', last_checked_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(group_id, domain))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_scan_results (id SERIAL PRIMARY KEY, group_id INTEGER REFERENCES rank_keyword_groups(id) ON DELETE CASCADE, keyword TEXT NOT NULL, position INTEGER, page INTEGER, title TEXT, link TEXT, snippet TEXT, host TEXT, classification TEXT DEFAULT 'unknown', reason TEXT DEFAULT '', checked_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`ALTER TABLE rank_scan_results ADD COLUMN IF NOT EXISTS node_id INTEGER`);
  await pool.query(`CREATE TABLE IF NOT EXISTS domain_intel_cache (domain TEXT PRIMARY KEY, ip TEXT, nameservers JSONB DEFAULT '[]'::jsonb, registrar TEXT DEFAULT '', abuse_email TEXT DEFAULT '', network_name TEXT DEFAULT '', asn TEXT DEFAULT '', report_url TEXT DEFAULT '', checked_at TIMESTAMP DEFAULT NOW(), raw JSONB DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rank_suspicious_seen (id SERIAL PRIMARY KEY, group_id INTEGER REFERENCES rank_keyword_groups(id) ON DELETE CASCADE, host TEXT NOT NULL, first_seen_at TIMESTAMP DEFAULT NOW(), last_seen_at TIMESTAMP DEFAULT NOW(), last_position INTEGER, last_page INTEGER, UNIQUE(group_id, host))`);
  await pool.query(`ALTER TABLE rank_keyword_groups ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'admin'`);
  try { await pool.query(`ALTER TABLE rank_keyword_groups DROP CONSTRAINT IF EXISTS rank_keyword_groups_keyword_lc_key`); } catch(_) {}
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS rank_keyword_groups_keyword_lc_tenant_unique ON rank_keyword_groups (keyword_lc, tenant)`);
}

function hostFromUrl(url) { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (_) { return ""; } }
function domainMatches(linkOrHost, domain) { const raw = String(linkOrHost || ""); const host = raw.includes("/") ? hostFromUrl(raw) : raw.replace(/^www\./, "").toLowerCase(); const clean = normalizeDomain(domain).replace(/^www\./, ""); return host === clean || host.endsWith(`.${clean}`); }
function parseDomainList(value) { return String(value || "").split(/[\n,;\t ]+/).map((x) => normalizeDomain(x.trim())).filter(Boolean); }
function allowedExternalDomains() { const envList = String(process.env.RANK_ALLOWED_EXTERNAL_DOMAINS || "").split(/[,\n;]/).map((x) => normalizeDomain(x.trim())).filter(Boolean); return [...new Set([...DEFAULT_ALLOWED_EXTERNAL, ...envList])]; }
function keywordTokens(keyword) { return String(keyword || "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3); }

function classifyResult(item, whitelistDomains, allowedExternal) {
  const host = hostFromUrl(item.link || "");
  const title = String(item.title || "").toLowerCase();
  const snippet = String(item.snippet || "").toLowerCase();
  const link = String(item.link || "").toLowerCase();
  const tokens = keywordTokens(item.keyword || "");
  if (!host) return { classification: "unknown", reason: "No host detected" };
  if (whitelistDomains.some((d) => domainMatches(host, d))) return { classification: "whitelisted", reason: "Matched monitored whitelist domain" };
  if (allowedExternal.some((d) => domainMatches(host, d))) return { classification: "external_safe", reason: "Matched allowed external platform" };
  const brandSignal = tokens.some((t) => host.includes(t) || title.includes(t) || snippet.includes(t) || link.includes(t));
  if (brandSignal) return { classification: "suspicious", reason: "Non-whitelisted result contains brand/keyword signal" };
  return { classification: "unknown", reason: "Non-whitelisted result" };
}

async function getKeywordGroup(id) {
  const group = (await pool.query("SELECT * FROM rank_keyword_groups WHERE id=$1", [id])).rows[0];
  if (!group) return null;
  const domains = (await pool.query(
    `SELECT rkd.*, d.label AS domain_label
     FROM rank_keyword_domains rkd
     LEFT JOIN domains d ON d.domain = rkd.domain AND d.project_name = $2 AND d.label IN ('landing_page', 'ms') AND d.is_active = true
     WHERE rkd.group_id = $1
     ORDER BY rkd.id ASC`,
    [id, group.project_name]
  )).rows;
  const best = domains.filter((d) => d.last_position).sort((a, b) => a.last_position - b.last_position)[0] || null;
  const suspicious = (await pool.query("SELECT COUNT(*)::int AS count FROM rank_scan_results WHERE group_id=$1 AND classification='suspicious' AND checked_at > NOW() - INTERVAL '7 days'", [id])).rows[0]?.count || 0;
  return { ...group, domains, domain_count: domains.length, suspicious_count: suspicious, domain: domains.map((d) => d.domain).join(", "), last_position: best?.last_position || null, last_page: best?.last_page || null, last_matched_url: best?.last_matched_url || "", last_status: best ? "found" : (domains.length ? "not_found" : "pending"), best_domain: best?.domain || "" };
}

async function upsertKeywordGroup({ project, keyword, domains, targetUrl, tenant = 'admin' }) {
  const keywordClean = String(keyword || "").trim();
  const keywordLc = keywordClean.toLowerCase();
  if (!keywordClean) throw new Error("Keyword required");
  const group = (await pool.query(`INSERT INTO rank_keyword_groups (project_name, keyword, keyword_lc, tenant) VALUES ($1,$2,$3,$4) ON CONFLICT (keyword_lc, tenant) DO UPDATE SET project_name=COALESCE(NULLIF(EXCLUDED.project_name,''), rank_keyword_groups.project_name), keyword=EXCLUDED.keyword RETURNING *`, [project || "", keywordClean, keywordLc, tenant])).rows[0];
  for (const domain of domains) {
    await pool.query(`INSERT INTO rank_keyword_domains (group_id, domain, target_url, is_whitelisted) VALUES ($1,$2,$3,true) ON CONFLICT (group_id, domain) DO UPDATE SET target_url=COALESCE(NULLIF(EXCLUDED.target_url,''), rank_keyword_domains.target_url), is_whitelisted=true`, [group.id, domain, targetUrl || ""]);
    await pool.query(`INSERT INTO rank_keywords (project_name, domain, keyword, target_url) VALUES ($1,$2,$3,$4) ON CONFLICT (domain, keyword) DO UPDATE SET project_name=EXCLUDED.project_name, target_url=EXCLUDED.target_url`, [project || "", domain, keywordClean, targetUrl || ""]).catch(() => {});
  }
  if (project) {
    try {
      const { rows: lpMs } = await pool.query(
        "SELECT domain FROM domains WHERE project_name=$1 AND label IN ('landing_page', 'ms') AND is_active=true",
        [project]
      );
      for (const d of lpMs) {
        await pool.query(
          `INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) VALUES ($1,$2,true) ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true`,
          [group.id, d.domain]
        );
      }
    } catch (err) {
      console.warn("[LP/MS auto-include]", err.message);
    }
  }
  return getKeywordGroup(group.id);
}

function normalizeSerpItem(item, position, keyword) {
  return { title: item.title || "", link: item.link || "", snippet: item.snippet || "", position, page: Math.ceil(position / 10), keyword };
}

async function fetchSerperResults(keyword) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY is missing");
  const maxPages = Math.min(10, Math.max(1, Number(process.env.RANK_MAX_PAGES || 10)));
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await axios.post("https://google.serper.dev/search", {
      q: keyword,
      gl: process.env.RANK_SERPER_GL || "id",
      hl: process.env.RANK_SERPER_HL || "id",
      num: 10,
      page
    }, {
      timeout: 25000,
      headers: { "X-API-KEY": key, "Content-Type": "application/json" }
    });
    const organic = Array.isArray(data.organic) ? data.organic : [];
    organic.forEach((item, i) => all.push(normalizeSerpItem(item, (page - 1) * 10 + i + 1, keyword)));
    if (organic.length < 10) break;
  }
  return all.slice(0, 100);
}

async function fetchCustomSearchResults(keyword) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) throw new Error("Missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX");
  const maxPages = Math.min(10, Math.max(1, Number(process.env.RANK_MAX_PAGES || 10)));
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const start = page * 10 + 1;
    const { data } = await axios.get("https://www.googleapis.com/customsearch/v1", { timeout: 25000, params: { key, cx, q: keyword, start, num: 10 } });
    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach((item, i) => all.push({ title: item.title || "", link: item.link || "", snippet: item.snippet || "", position: start + i, page: Math.ceil((start + i) / 10), keyword }));
    if (items.length < 10) break;
  }
  return all.slice(0, 100);
}

async function fetchGoogleResults(keyword) {
  if (process.env.SERPER_API_KEY) return fetchSerperResults(keyword);
  return fetchCustomSearchResults(keyword);
}

async function lookupDomainIntel(domain) {
  const clean = normalizeDomain(domain).replace(/^www\./, "");
  if (!clean) return null;
  const cached = await pool.query("SELECT * FROM domain_intel_cache WHERE domain=$1 AND checked_at > NOW() - INTERVAL '24 hours'", [clean]);
  if (cached.rows[0]) return cached.rows[0];
  let ip = "", nameservers = [], registrar = "", abuseEmail = "", networkName = "", asn = "", reportUrl = "";
  const raw = {};
  try { const records = await dns.resolve4(clean); ip = records[0] || ""; raw.a = records; } catch (err) { raw.a_error = err.code || err.message; }
  try { nameservers = await dns.resolveNs(clean); raw.ns = nameservers; } catch (err) { raw.ns_error = err.code || err.message; }
  try {
    const { data } = await axios.get(`https://rdap.org/domain/${clean}`, { timeout: 12000 });
    raw.domain_rdap = data;
    registrar = data?.registrar?.name || data?.entities?.find((e) => Array.isArray(e.roles) && e.roles.includes("registrar"))?.vcardArray?.[1]?.find((v) => v[0] === "fn")?.[3] || "";
    const emails = [];
    for (const entity of Array.isArray(data.entities) ? data.entities : []) for (const c of entity?.vcardArray?.[1] || []) if (c[0] === "email" && c[3]) emails.push(c[3]);
    abuseEmail = emails.find((e) => /abuse/i.test(e)) || emails[0] || "";
  } catch (err) { raw.domain_rdap_error = err.code || err.message; }
  if (ip) {
    try {
      const { data } = await axios.get(`https://rdap.org/ip/${ip}`, { timeout: 12000 });
      raw.ip_rdap = data;
      networkName = data?.name || data?.handle || "";
      asn = data?.handle || "";
      const emails = [];
      for (const entity of Array.isArray(data.entities) ? data.entities : []) for (const c of entity?.vcardArray?.[1] || []) if (c[0] === "email" && c[3]) emails.push(c[3]);
      if (!abuseEmail) abuseEmail = emails.find((e) => /abuse/i.test(e)) || emails[0] || "";
    } catch (err) { raw.ip_rdap_error = err.code || err.message; }
  }
  const nsJoined = nameservers.join(" ").toLowerCase();
  if (nsJoined.includes("cloudflare")) reportUrl = "https://abuse.cloudflare.com/";
  else if (abuseEmail) reportUrl = `mailto:${abuseEmail}`;
  else reportUrl = `https://www.google.com/search?q=${encodeURIComponent(`${clean} abuse report hosting registrar`)}`;
  return (await pool.query(`INSERT INTO domain_intel_cache (domain, ip, nameservers, registrar, abuse_email, network_name, asn, report_url, raw, checked_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,NOW()) ON CONFLICT (domain) DO UPDATE SET ip=EXCLUDED.ip, nameservers=EXCLUDED.nameservers, registrar=EXCLUDED.registrar, abuse_email=EXCLUDED.abuse_email, network_name=EXCLUDED.network_name, asn=EXCLUDED.asn, report_url=EXCLUDED.report_url, raw=EXCLUDED.raw, checked_at=NOW() RETURNING *`, [clean, ip, JSON.stringify(nameservers), registrar, abuseEmail, networkName, asn, reportUrl, JSON.stringify(raw)])).rows[0];
}

async function checkGroup(group, nodeId = null, nodeName = null) {
  const domains = (await pool.query("SELECT * FROM rank_keyword_domains WHERE group_id=$1 AND is_whitelisted=true ORDER BY id ASC", [group.id])).rows;
  const whitelistDomains = domains.map((d) => d.domain);
  const items = await fetchGoogleResults(group.keyword);
  const now = new Date();
  const suspicious = [];
  const checkerLabel = nodeName || "VPS Central";
  if (!nodeId) {
    await pool.query("DELETE FROM rank_scan_results WHERE group_id=$1 AND node_id IS NULL AND checked_at < NOW() - INTERVAL '30 days'", [group.id]);
  }
  for (const item of items) {
    const host = hostFromUrl(item.link || "");
    const classified = classifyResult(item, whitelistDomains, allowedExternalDomains());
    await pool.query(
      `INSERT INTO rank_scan_results (group_id, keyword, position, page, title, link, snippet, host, classification, reason, checked_at, node_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [group.id, group.keyword, item.position, item.page, item.title || "", item.link || "", item.snippet || "", host, classified.classification, classified.reason, now, nodeId || null]
    );
    if (classified.classification === "suspicious") suspicious.push({ ...item, host, ...classified });
  }
  for (const d of domains) {
    const match = items.find((item) => domainMatches(item.link || "", d.domain));
    const newPos = match?.position || null;
    const newPage = match?.page || null;
    if (!nodeId) {
      await pool.query(`UPDATE rank_keyword_domains SET last_position=$1, last_page=$2, last_matched_url=$3, last_status=$4, last_checked_at=NOW() WHERE id=$5`, [newPos, newPage, match?.link || "", match ? "found" : "not_found", d.id]);
      await pool.query(`INSERT INTO rank_results (keyword_id, keyword, domain, position, page, matched_url, source) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [d.id, group.keyword, d.domain, newPos, newPage, match?.link || "", process.env.SERPER_API_KEY ? "serper" : "google_custom_search"]).catch(() => {});
    }
    if (newPos !== null) {
      let prevPos = null;
      let prevPage = null;
      if (nodeId) {
        const normalizedHost = d.domain.replace(/^www\./, '').toLowerCase();
        const prevRow = await pool.query(
          `SELECT position, page FROM rank_scan_results
           WHERE group_id=$1 AND node_id=$2
             AND (host = $3 OR host LIKE $4 OR $3 LIKE CONCAT('%.', host))
             AND checked_at < NOW() - INTERVAL '30 seconds'
           ORDER BY checked_at DESC LIMIT 1`,
          [group.id, nodeId, normalizedHost, `%.${normalizedHost}`]
        ).catch(() => ({ rows: [] }));
        prevPos = prevRow.rows[0]?.position ?? null;
        prevPage = prevRow.rows[0]?.page ?? null;
      } else {
        prevPos = d.last_position;
        prevPage = d.last_page;
      }
      if (prevPos !== null && prevPos !== newPos) {
        const dir = newPos < prevPos ? "⬆️" : "⬇️";
        let msg = `${dir} RANK CHANGE\n\nProject: ${group.project_name || "-"}\nKeyword: ${group.keyword}\nDomain: ${d.domain}\nOld: #${prevPos} (page ${prevPage || "?"})\nNew: #${newPos} (page ${newPage || "?"})\nChecker: ${checkerLabel}`;

        if (newPos > prevPos) {
          const normalizedD = d.domain.replace(/^www\./, '').toLowerCase();
          const { rows: overtakers } = await pool.query(`
            WITH latest_scan AS (
              SELECT MAX(checked_at) AS ts
              FROM rank_scan_results
              WHERE group_id = $1
                AND (node_id IS NOT DISTINCT FROM $2)
            )
            SELECT DISTINCT ON (rsr.host) rsr.host, rsr.position, rsr.classification
            FROM rank_scan_results rsr, latest_scan
            WHERE rsr.group_id = $1
              AND (rsr.node_id IS NOT DISTINCT FROM $2)
              AND rsr.position >= $3 AND rsr.position < $4
              AND NOT (rsr.host = $5 OR rsr.host LIKE $6 OR $5 LIKE CONCAT('%.', rsr.host))
              AND rsr.checked_at >= latest_scan.ts - INTERVAL '60 seconds'
            ORDER BY rsr.host, rsr.position ASC
          `, [group.id, nodeId || null, prevPos, newPos, normalizedD, `%.${normalizedD}`]).catch(() => ({ rows: [] }));

          if (overtakers.length) {
            msg += '\n\n📈 DOMAIN DI ATAS:';
            for (const o of overtakers) {
              const flag = o.classification === 'suspicious' ? ' 🎣' : '';
              msg += `\n#${o.position} ${o.host}${flag}`;
            }
            const phishing = overtakers.filter(o => o.classification === 'suspicious');
            if (phishing.length) {
              msg += `\n\n⚠️ PHISING TERDETEKSI: ${phishing.length} domain mencurigakan di atas posisi kamu!`;
            }
          }
        }

        sendTelegramToProject(group.project_name, msg).catch(() => false);
      }
    }
  }
  if (!nodeId) {
    for (const s of suspicious.slice(0, 25)) {
      const seen = await pool.query(`INSERT INTO rank_suspicious_seen (group_id, host, last_position, last_page) VALUES ($1,$2,$3,$4) ON CONFLICT (group_id, host) DO UPDATE SET last_seen_at=NOW(), last_position=EXCLUDED.last_position, last_page=EXCLUDED.last_page RETURNING (xmax = 0) AS is_new`, [group.id, s.host, s.position, s.page]);
      s.intel = await lookupDomainIntel(s.host).catch((err) => ({ domain: s.host, error: err.message }));
      if (seen.rows[0]?.is_new && s.position <= Number(process.env.RANK_SUSPICIOUS_ALERT_MAX_POSITION || 30)) await sendTelegram(`SUSPICIOUS GOOGLE RESULT\n\nKeyword: ${group.keyword}\nHost: ${s.host}\nRank: ${s.position}\nPage: ${s.page}\nURL: ${s.link}\nReason: ${s.reason}\nReport: ${s.intel?.report_url || "n/a"}`).catch(() => false);
    }
  }
  await pool.query("UPDATE rank_keyword_groups SET last_checked_at=NOW() WHERE id=$1", [group.id]);
  return { provider: process.env.SERPER_API_KEY ? "serper" : "google_custom_search", node_id: nodeId, checker: checkerLabel, total_results: items.length, suspicious_count: suspicious.length, suspicious };
}

router.get("/keywords", async (req, res, next) => { try { await ensureRankTables(); const tenant = req.tenant || 'admin'; const groups = (await pool.query("SELECT * FROM rank_keyword_groups WHERE tenant=$1 ORDER BY id DESC", [tenant])).rows; const out = []; for (const g of groups) out.push(await getKeywordGroup(g.id)); res.json(out.filter(Boolean)); } catch (err) { next(err); } });
router.post("/keywords", async (req, res, next) => { try { await ensureRankTables(); const domains = parseDomainList(req.body.domain || req.body.domains || ""); const keyword = String(req.body.keyword || "").trim(); const project = String(req.body.project_name || "").trim(); const targetUrl = String(req.body.target_url || "").trim(); if (!domains.length || !keyword) return res.status(400).json({ error: "Domain and keyword required" }); res.json(await upsertKeywordGroup({ project, keyword, domains, targetUrl, tenant: req.tenant || 'admin' })); } catch (err) { next(err); } });
router.delete("/keywords/:id", async (req, res, next) => { try { await ensureRankTables(); await pool.query("DELETE FROM rank_keyword_groups WHERE id=$1", [req.params.id]); await pool.query("DELETE FROM rank_keywords WHERE id=$1", [req.params.id]).catch(() => {}); res.json({ ok: true }); } catch (err) { next(err); } });
router.get("/results", async (req, res, next) => { try { await ensureRankTables(); const tenant = req.tenant || 'admin'; const { rows } = await pool.query("SELECT r.id, r.group_id, r.keyword, r.host AS domain, r.position, r.page, r.link AS matched_url, r.title, r.snippet, r.classification, r.reason, r.checked_at, r.node_id FROM rank_scan_results r JOIN rank_keyword_groups g ON g.id = r.group_id WHERE g.tenant=$1 ORDER BY r.checked_at DESC, r.position ASC LIMIT 1000", [tenant]); res.json(rows); } catch (err) { next(err); } });

router.get("/node-positions", async (req, res, next) => {
  try {
    await ensureRankTables();
    const tenant = req.tenant || 'admin';
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (r.group_id, r.host, r.node_id)
        r.group_id, r.host AS domain, r.node_id, r.position, r.page, r.checked_at
      FROM rank_scan_results r
      JOIN rank_keyword_groups g ON g.id = r.group_id
      WHERE r.classification = 'whitelisted'
        AND r.checked_at >= NOW() - INTERVAL '24 hours'
        AND g.tenant=$1
      ORDER BY r.group_id, r.host, r.node_id, r.checked_at DESC
    `, [tenant]);
    res.json(rows);
  } catch (err) { next(err); }
});
router.get("/intel/:domain", async (req, res, next) => { try { await ensureRankTables(); res.json(await lookupDomainIntel(req.params.domain)); } catch (err) { next(err); } });
router.get("/test", async (req, res, next) => { try { const keyword = String(req.query.q || "empire88"); const items = await fetchGoogleResults(keyword); res.json({ ok: true, provider: process.env.SERPER_API_KEY ? "serper" : "google_custom_search", keyword, count: items.length, first: items[0] || null }); } catch (err) { next(err); } });
router.post("/check/:id", async (req, res, next) => { try { await ensureRankTables(); const group = await getKeywordGroup(req.params.id); if (!group) return res.status(404).json({ error: "Keyword group not found" }); const result = await checkGroup(group); res.json({ ok: true, ...result, group: await getKeywordGroup(req.params.id) }); } catch (err) { next(err); } });
router.post("/check-all", async (req, res, next) => { try { await ensureRankTables(); const tenant = req.tenant || 'admin'; const { rows } = await pool.query("SELECT * FROM rank_keyword_groups WHERE is_active=true AND tenant=$1 ORDER BY id DESC LIMIT 50", [tenant]); const checked = []; for (const group of rows) { try { checked.push({ id: group.id, keyword: group.keyword, ...(await checkGroup(group)) }); } catch (err) { checked.push({ id: group.id, keyword: group.keyword, error: err.message }); } } res.json({ ok: true, checked }); } catch (err) { next(err); } });

router.post("/sync-lp-ms", async (req, res, next) => {
  try {
    await ensureRankTables();
    const { rows: lpMs } = await pool.query(
      "SELECT domain, project_name FROM domains WHERE label IN ('landing_page', 'ms') AND project_name IS NOT NULL AND project_name != '' AND is_active=true"
    );
    let synced = 0;
    for (const d of lpMs) {
      const { rows: groups } = await pool.query(
        "SELECT id FROM rank_keyword_groups WHERE project_name=$1",
        [d.project_name]
      );
      for (const g of groups) {
        await pool.query(
          `INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) VALUES ($1,$2,true) ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true`,
          [g.id, d.domain]
        );
        synced++;
      }
    }
    res.json({ ok: true, synced });
  } catch (err) { next(err); }
});

async function handleNodeCheck(req, res, next) {
  try {
    await ensureRankTables();
    const nodeId = Number(req.params.nodeId);
    if (!Number.isFinite(nodeId)) return res.status(400).json({ error: "Invalid node ID" });
    const nodeSecret = String(req.headers["x-domain-radar-secret"] || req.headers["x-node-secret"] || "");
    const { rows: nodeRows } = await pool.query("SELECT * FROM provider_nodes WHERE id=$1", [nodeId]);
    if (!nodeRows[0]) return res.status(404).json({ error: "Node not found" });
    const node = nodeRows[0];
    if (!node.secret_key) {
      return res.status(401).json({ error: "Node has no secret configured — access denied" });
    }
    if (nodeSecret !== node.secret_key) {
      return res.status(401).json({ error: "Invalid node secret" });
    }
    const { rows: groups } = await pool.query("SELECT * FROM rank_keyword_groups WHERE is_active=true ORDER BY id ASC LIMIT 50");
    const checked = [];
    for (const group of groups) {
      try {
        checked.push({ id: group.id, keyword: group.keyword, ...(await checkGroup(group, node.id, node.name)) });
      } catch (err) {
        checked.push({ id: group.id, keyword: group.keyword, error: err.message });
      }
    }
    res.json({ ok: true, node_id: node.id, node_name: node.name, checked });
  } catch (err) { next(err); }
}

router.post("/check-all-node/:nodeId", handleNodeCheck);
nodeCheckRouter.post("/check-all-node/:nodeId", handleNodeCheck);

router.post("/keywords/:groupId/whitelist-domain", async (req, res, next) => {
  try {
    await ensureRankTables();
    const groupId = Number(req.params.groupId);
    const domain = normalizeDomain(String(req.body.domain || "").trim());
    if (!domain) return res.status(400).json({ error: "Domain required" });
    const group = (await pool.query("SELECT id FROM rank_keyword_groups WHERE id=$1", [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: "Group not found" });
    await pool.query(
      `INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) VALUES ($1,$2,true) ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true`,
      [groupId, domain]
    );
    res.json({ ok: true, domain });
  } catch (err) { next(err); }
});

router.post("/results/:id/classify", async (req, res, next) => {
  try {
    await ensureRankTables();
    const id = Number(req.params.id);
    const classification = String(req.body.classification || "").trim();
    if (!classification) return res.status(400).json({ error: "Classification required" });
    const { rowCount } = await pool.query(
      "UPDATE rank_scan_results SET classification=$1 WHERE id=$2",
      [classification, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Result not found" });
    res.json({ ok: true, id, classification });
  } catch (err) { next(err); }
});

router.put("/keywords/:id", async (req, res, next) => {
  try {
    await ensureRankTables();
    const id = Number(req.params.id);
    const { project_name, keyword, domains } = req.body;
    const keywordClean = keyword ? String(keyword).trim() : undefined;
    const keywordLc = keywordClean ? keywordClean.toLowerCase() : undefined;
    const fields = [];
    const vals = [];
    let idx = 1;
    if (project_name !== undefined) { fields.push(`project_name=$${idx++}`); vals.push(String(project_name || "")); }
    if (keywordClean !== undefined) { fields.push(`keyword=$${idx++}`); vals.push(keywordClean); fields.push(`keyword_lc=$${idx++}`); vals.push(keywordLc); }
    if (fields.length) {
      vals.push(id);
      const { rows } = await pool.query(
        `UPDATE rank_keyword_groups SET ${fields.join(", ")} WHERE id=$${idx} RETURNING *`,
        vals
      );
      if (!rows[0]) return res.status(404).json({ error: "Keyword group not found" });
    }
    if (domains !== undefined) {
      const domainList = parseDomainList(String(domains || ""));
      const targetUrlVal = req.body.target_url !== undefined ? String(req.body.target_url || "") : null;
      const existing = (await pool.query("SELECT domain FROM rank_keyword_domains WHERE group_id=$1", [id])).rows.map((r) => r.domain);
      for (const d of domainList) {
        if (targetUrlVal !== null) {
          await pool.query(
            `INSERT INTO rank_keyword_domains (group_id, domain, target_url, is_whitelisted) VALUES ($1,$2,$3,true)
             ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true, target_url=EXCLUDED.target_url`,
            [id, d, targetUrlVal]
          );
        } else {
          await pool.query(
            `INSERT INTO rank_keyword_domains (group_id, domain, is_whitelisted) VALUES ($1,$2,true)
             ON CONFLICT (group_id, domain) DO UPDATE SET is_whitelisted=true`,
            [id, d]
          );
        }
      }
      for (const d of existing) {
        if (!domainList.includes(d)) {
          await pool.query("UPDATE rank_keyword_domains SET is_whitelisted=false WHERE group_id=$1 AND domain=$2", [id, d]);
        }
      }
    } else if (req.body.target_url !== undefined) {
      await pool.query("UPDATE rank_keyword_domains SET target_url=$1 WHERE group_id=$2", [String(req.body.target_url || ""), id]);
    }
    res.json(await getKeywordGroup(id));
  } catch (err) { next(err); }
});

router.delete("/keywords/:groupId/whitelist-domain", async (req, res, next) => {
  try {
    await ensureRankTables();
    const groupId = Number(req.params.groupId);
    const domain = normalizeDomain(String(req.body.domain || "").trim());
    if (!domain) return res.status(400).json({ error: "Domain required" });
    await pool.query(
      "UPDATE rank_keyword_domains SET is_whitelisted=false WHERE group_id=$1 AND domain=$2",
      [groupId, domain]
    );
    res.json({ ok: true, domain });
  } catch (err) { next(err); }
});

module.exports = { router, nodeCheckRouter, checkGroup, ensureRankTables };
