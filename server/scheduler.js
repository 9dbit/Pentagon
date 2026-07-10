const cron = require("node-cron");
const { pool } = require("./db");
const { checkDomain, calculateGlobalStatus } = require("./checker");
const { sendTelegram, sendTelegramToProject } = require("./telegram");
const { decide } = require("./confirm");
const { getRuntimeSettings } = require("./runtimeSettings");
const { getActiveNodes, checkViaNode } = require("./nodeChecker");
const { classifyReasonType, reasonTypeLabel } = require("./reasonClassifier");
const { verifyProviderBlock } = require("./providerBlockVerifier");
const { isAcknowledged, clearAcknowledged } = require("./noticeState");
const { checkGroup: rankCheckGroup } = require("./rankRoutes");

let running = false;
let manualRunning = false;
let lastChecksCompletedAt = 0;
let lastCycleDomainCount = 0;
let lastCycleErrorCount = 0;
let lastCycleDurationMs = 0;
let _currentCycleErrors = 0;
let reasonTypeColumnReady = false;
let digestRunning = false;
let digestWatchdogStarted = false;
let recurringAlertsTableReady = false;

const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 60);
const DIGEST_INTERVAL_MINUTES = Number(process.env.DIGEST_INTERVAL_MINUTES || 10);
const HOURLY_DIGEST_MINUTES = Number(process.env.HOURLY_DIGEST_MINUTES || 60);
const DIGEST_LIMIT = Number(process.env.TELEGRAM_DIGEST_LIMIT || 120);
const DIGEST_WATCHDOG_MINUTES = Number(process.env.TELEGRAM_DIGEST_WATCHDOG_MINUTES || 5);
const DOMAIN_CHECK_CONCURRENCY = Number(process.env.DOMAIN_CHECK_CONCURRENCY || 5);
const TRUSTPOSITIF_ON_DIRECT_WARNING = String(process.env.TRUSTPOSITIF_ON_DIRECT_WARNING || "true").toLowerCase() !== "false";
const DASHBOARD_URL = process.env.DOMAIN_RADAR_DASHBOARD_URL || "https://domain-radar.org";
const RANK_CHECK_INTERVAL_MINUTES = Number(process.env.RANK_CHECK_INTERVAL_MINUTES || 20);

function getRetryLimit() {
  const value = Number(getRuntimeSettings().retry_confirmations || 3);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function getCronExpr() {
  const interval = Number(getRuntimeSettings().check_interval_seconds || 60);
  return interval <= 60 ? "* * * * *" : `*/${Math.ceil(interval / 60)} * * * *`;
}

function nowWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function normalizeStatus(status) {
  const value = String(status || "unknown").toLowerCase().trim();
  if (["normal", "ok", "online", "success"].includes(value)) return "working";
  if (["warn", "warning", "timeout", "error"].includes(value)) return "warning";
  if (["block", "blocked", "down", "offline"].includes(value)) return "blocked";
  return value || "unknown";
}

function isNodeTimeout(result) {
  const text = String(result?.reason || "").toLowerCase();
  return text.includes("node polling timeout") || text.includes("no response from device");
}

function hasProviderNodeWarning(results) {
  return results.some((r) => {
    const checker = String(r.checker_type || "").toLowerCase();
    return checker.includes("node") && normalizeStatus(r.status) === "warning" && !isNodeTimeout(r);
  });
}

function hasDirectWarning(results) {
  return results.some((r) => {
    const checker = String(r.checker_type || "").toLowerCase();
    return checker === "direct" && normalizeStatus(r.status) === "warning";
  });
}

function shouldCheckProviderRegistry(domain, results) {
  // No longer skip already-blocked domains — they need re-validation to self-correct

  if (hasProviderNodeWarning(results)) {
    return { check: true, reason: "provider node warning" };
  }

  // Also trigger when nodes report blocked (to confirm or deny ISP block)
  if (results.some(r => String(r.checker_type || "").startsWith("node:") && r.status === "blocked")) {
    return { check: true, reason: "provider node blocked" };
  }

  if (TRUSTPOSITIF_ON_DIRECT_WARNING && hasDirectWarning(results)) {
    return { check: true, reason: "direct warning" };
  }

  // Also trigger when direct check reports blocked
  if (results.some(r => r.checker_type === "direct" && r.status === "blocked")) {
    return { check: true, reason: "direct blocked" };
  }

  return { check: false, reason: "no provider-node/direct warning or block" };
}

async function maybeAddProviderRegistryResult(domain, results) {
  const decision = shouldCheckProviderRegistry(domain, results);
  if (!decision.check) {
    if (process.env.TRUSTPOSITIF_DEBUG === "true") {
      console.log(`[TrustPositif] skip ${domain.domain}: ${decision.reason}`);
    }
    return;
  }

  try {
    console.log(`[TrustPositif] checking ${domain.domain}: ${decision.reason}`);
    const registry = await verifyProviderBlock(domain.domain);

    if (!registry.checked) {
      console.log(`[TrustPositif] error ${domain.domain}: ${registry.reason || registry.status || "unchecked"}`);
      return;
    }

    const result = registry.blocked
      ? {
          checker_type: "provider_registry",
          provider_name: "TrustPositif",
          status: "blocked",
          http_status: 451,
          final_url: "",
          dns_result: "",
          latency_ms: null,
          reason: "TrustPositif status Ada"
        }
      : {
          checker_type: "provider_registry",
          provider_name: "TrustPositif",
          status: "working",
          http_status: 200,
          final_url: "",
          dns_result: "",
          latency_ms: null,
          reason: "TrustPositif status Tidak Ada"
        };

    results.push(result);
    console.log(`[TrustPositif] result ${domain.domain}: ${result.status} / ${result.reason}`);
  } catch (err) {
    console.error("Provider registry verification error:", domain.domain, err.message);
  }
}

function isImportantTransition(oldStatus, newStatus, worst) {
  const oldValue = normalizeStatus(oldStatus);
  const newValue = normalizeStatus(newStatus);

  if (oldValue === newValue) return false;
  if (isNodeTimeout(worst)) return false;

  if (oldValue === "working" && newValue === "warning") return true;
  if (["working", "warning", "unknown"].includes(oldValue) && newValue === "blocked") return true;

  return false;
}

async function ensureReasonTypeColumn() {
  if (reasonTypeColumnReady) return;
  await pool.query("ALTER TABLE check_results ADD COLUMN IF NOT EXISTS reason_type TEXT DEFAULT 'UNKNOWN'");
  reasonTypeColumnReady = true;
}

async function sentRecently(domainId, newStatus) {
  const { rows } = await pool.query(
    `SELECT id
     FROM alerts
     WHERE domain_id=$1
       AND new_status=$2
       AND sent_to_telegram=true
       AND created_at > NOW() - ($3::text || ' minutes')::interval
     LIMIT 1`,
    [domainId, newStatus, String(ALERT_COOLDOWN_MINUTES)]
  );

  return Boolean(rows[0]);
}

async function ensureDigestTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_digest_state (
      key TEXT PRIMARY KEY,
      last_sent_at TIMESTAMP
    )
  `);
}

async function ensureRecurringAlertsTable() {
  if (recurringAlertsTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_recurring_alerts (
      id SERIAL PRIMARY KEY,
      domain_id INTEGER UNIQUE NOT NULL,
      domain_name TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      last_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  recurringAlertsTableReady = true;
}

async function upsertRecurringAlert(domainId, domainName, message) {
  await ensureRecurringAlertsTable();
  await pool.query(`
    INSERT INTO telegram_recurring_alerts (domain_id, domain_name, message, last_sent_at)
    VALUES ($1, $2, $3, NULL)
    ON CONFLICT (domain_id) DO UPDATE SET
      message = EXCLUDED.message,
      domain_name = EXCLUDED.domain_name,
      last_sent_at = NULL
  `, [domainId, String(domainName || ''), String(message || '')]);
}

async function clearRecurringAlert(domainId) {
  try {
    await ensureRecurringAlertsTable();
    await pool.query('DELETE FROM telegram_recurring_alerts WHERE domain_id=$1', [domainId]);
  } catch (err) {
    console.error('[RecurringAlerts] clearRecurringAlert error:', err.message);
  }
}

async function sendPendingRecurringAlerts() {
  try {
    await ensureRecurringAlertsTable();
    const { rows } = await pool.query(`
      SELECT * FROM telegram_recurring_alerts
      WHERE last_sent_at IS NULL OR last_sent_at < NOW() - INTERVAL '60 seconds'
    `);
    for (const alert of rows) {
      if (await isAcknowledged(alert.domain_id)) {
        await clearRecurringAlert(alert.domain_id);
        continue;
      }
      await sendTelegram(alert.message, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Noticed — Tandai Dilihat', callback_data: `noticed:${alert.domain_id}:blocked` }
          ]]
        }
      }).catch((err) => console.error('[RecurringAlerts] send error:', err.message));
      await pool.query('UPDATE telegram_recurring_alerts SET last_sent_at=NOW() WHERE domain_id=$1', [alert.domain_id]);
    }
  } catch (err) {
    console.error('[RecurringAlerts] sendPendingRecurringAlerts error:', err.message);
  }
}

function buildEmergencyBlockedMessage(domain, results) {
  const providerResult = results.find(r => r.checker_type === 'provider_registry' && r.status === 'blocked');
  const worst = results.find(r => r.status === 'blocked') || results[0] || {};
  return [
    `🚨 <b>DOMAIN BLOCKED — EMERGENCY ALERT</b>`,
    ``,
    `<b>Domain</b>   : <code>${htmlEsc(domain.domain)}</code>`,
    `<b>Status</b>   : WARNING → BLOCKED`,
    `<b>Checker</b>  : ${htmlEsc(providerResult?.provider_name || 'InternetPositif')}`,
    `<b>Reason</b>   : ${htmlEsc(providerResult?.reason || 'Terdaftar di Internet Positif')}`,
    `<b>Redirect</b> : ${htmlEsc(worst?.final_url || '-')}`,
    `<b>Time</b>     : ${htmlEsc(nowWib())} WIB`,
    ``,
    `<i>Alert dikirim setiap 1 menit hingga tombol Noticed diklik.</i>`
  ].join('\n');
}

async function getNodesWithTelemetry() {
  try {
    const { rows } = await pool.query(`
      SELECT n.id, n.name, n.provider_name, n.network_type, n.last_health_status,
        t.signal_percent, t.signal_label, t.battery_percent, t.is_charging,
        t.network_operator, t.last_seen_at AS telemetry_last_seen_at
      FROM provider_nodes n
      LEFT JOIN LATERAL (
        SELECT signal_percent, signal_label, battery_percent, is_charging, network_operator, last_seen_at
        FROM node_telemetry WHERE node_id = n.id ORDER BY last_seen_at DESC LIMIT 1
      ) t ON TRUE
      WHERE n.is_active = TRUE
      ORDER BY n.id ASC
    `);
    return rows;
  } catch (_) {
    return [];
  }
}

async function buildProjectRankReports() {
  // All active provider nodes (for column headers)
  const { rows: activeNodes } = await pool.query(
    `SELECT id, name, provider_name FROM provider_nodes WHERE is_active=TRUE ORDER BY id ASC`
  ).catch(() => ({ rows: [] }));

  // Checkers: VPS (node_id=null) first, then each active node
  const checkers = [
    { id: null, label: 'VPS' },
    ...activeNodes.map(n => ({
      id: n.id,
      label: safeCell(n.name || n.provider_name).replace(/\s+/g, '').slice(0, 4).toUpperCase() || `N${n.id}`
    }))
  ];

  // Live positions from last 30 min, per checker, per whitelisted rank domain
  const { rows: liveRows } = await pool.query(`
    SELECT
      rkg.project_name,
      rkd.domain,
      COALESCE(d.label, 'landing_page') AS domain_label,
      rsr.node_id,
      MIN(rsr.position) AS best_pos
    FROM rank_keyword_groups rkg
    JOIN rank_keyword_domains rkd ON rkd.group_id = rkg.id AND rkd.is_whitelisted = TRUE
    LEFT JOIN domains d ON d.domain = rkd.domain
      AND d.project_name = rkg.project_name
      AND d.label IN ('landing_page','ms')
      AND d.is_active = true
    JOIN rank_scan_results rsr ON rsr.group_id = rkg.id
      AND rsr.classification = 'whitelisted'
      AND (rsr.host = rkd.domain OR rsr.host LIKE '%.' || rkd.domain OR rkd.domain LIKE '%.' || rsr.host)
      AND rsr.checked_at >= NOW() - INTERVAL '30 minutes'
    WHERE rkg.is_active = TRUE
    GROUP BY rkg.project_name, rkd.domain, COALESCE(d.label, 'landing_page'), rsr.node_id
  `).catch(() => ({ rows: [] }));

  // Fallback: last known VPS position from rank_keyword_domains
  const { rows: fallbackRows } = await pool.query(`
    SELECT rkg.project_name, rkd.domain, COALESCE(d.label, 'landing_page') AS domain_label, MIN(rkd.last_position) AS last_pos
    FROM rank_keyword_groups rkg
    JOIN rank_keyword_domains rkd ON rkd.group_id = rkg.id AND rkd.is_whitelisted = TRUE
    LEFT JOIN domains d ON d.domain = rkd.domain
      AND d.project_name = rkg.project_name
      AND d.label IN ('landing_page','ms')
      AND d.is_active = true
    WHERE rkg.is_active = TRUE
    GROUP BY rkg.project_name, rkd.domain, COALESCE(d.label, 'landing_page')
  `).catch(() => ({ rows: [] }));

  // Build domain map: key=`project|domain` -> { project, domain, label, pos: Map<checkerKey, pos> }
  const domainMap = new Map();
  const domKey = (proj, dom) => `${proj}|${dom}`;

  for (const r of fallbackRows) {
    const proj = r.project_name || 'No Project';
    const k = domKey(proj, r.domain);
    if (!domainMap.has(k)) {
      domainMap.set(k, { project: proj, domain: r.domain, label: r.domain_label, pos: new Map() });
    }
    if (r.last_pos != null) {
      domainMap.get(k).pos.set('null', Number(r.last_pos));
    }
  }

  for (const r of liveRows) {
    const proj = r.project_name || 'No Project';
    const k = domKey(proj, r.domain);
    if (!domainMap.has(k)) {
      domainMap.set(k, { project: proj, domain: r.domain, label: r.domain_label, pos: new Map() });
    }
    const ck = r.node_id == null ? 'null' : String(r.node_id);
    const existing = domainMap.get(k).pos.get(ck);
    const fresh = Number(r.best_pos);
    if (existing == null || fresh < existing) {
      domainMap.get(k).pos.set(ck, fresh);
    }
  }

  // Group by project
  const projectMap = new Map();
  for (const entry of domainMap.values()) {
    if (!projectMap.has(entry.project)) projectMap.set(entry.project, []);
    projectMap.get(entry.project).push(entry);
  }

  if (!projectMap.size) return [];

  const DOMAIN_W = 18;
  const LB_W = 2;
  const POS_W = 4;
  const messages = [];

  for (const [proj, entries] of [...projectMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    entries.sort((a, b) => {
      const ord = l => l === 'landing_page' ? 0 : 1;
      return ord(a.label) - ord(b.label) || a.domain.localeCompare(b.domain);
    });

    const headers = ['DOMAIN', 'LB', ...checkers.map(c => c.label)];
    const widths = [DOMAIN_W, LB_W, ...checkers.map(() => POS_W)];

    const tableRows = entries.map(entry => {
      const lb = entry.label === 'landing_page' ? 'LP' : entry.label === 'ms' ? 'MS' : '-';
      const posCells = checkers.map(c => {
        const ck = c.id == null ? 'null' : String(c.id);
        const p = entry.pos.get(ck);
        return p != null ? `#${p}` : '-';
      });
      return [safeCell(entry.domain).slice(0, DOMAIN_W), lb, ...posCells];
    });

    const lpCount = entries.filter(e => e.label === 'landing_page').length;
    const msCount = entries.filter(e => e.label === 'ms').length;
    const table = monoTable(headers, widths, tableRows, 1);

    const msgLines = [
      `📊 <b>RANK — ${htmlEsc(proj)}</b>`,
      `🕐 <i>${htmlEsc(nowWib())} WIB</i>`,
      `📌 LP: ${lpCount}  MS: ${msCount}`,
      `<pre>${htmlEsc(table)}</pre>`
    ];

    messages.push({ project: proj, message: msgLines.join('\n') });
  }

  return messages;
}


function iconFor(status, finalUrl = "") {
  const value = normalizeStatus(status);
  if (value === "working") return "✅";
  if (value === "warning") return "⚠️";
  if (value === "blocked" && finalUrl) return "➡️";
  if (value === "blocked") return "❗";
  return "•";
}

function projectName(value) {
  return String(value || "").trim() || "No Project";
}

function safeCell(value) {
  return String(value || "-").replace(/\|/g, "/").replace(/[\r\n]+/g, " ").trim() || "-";
}

function truncateCell(value, max = 80) {
  const text = safeCell(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function htmlEsc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function padEnd(str, len) {
  const s = String(str ?? '-');
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

function formatAge(ts) {
  if (!ts) return '-';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function monoTable(headers, widths, rows, gap = 2) {
  const sepStr = ' '.repeat(gap);
  const head = headers.map((h, i) => padEnd(h, widths[i])).join(sepStr);
  const sep = widths.map(w => '-'.repeat(w)).join(sepStr);
  const body = rows.map(r => r.map((c, i) => padEnd(String(c ?? '-'), widths[i])).join(sepStr)).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

function buildProjectSummary(domains) {
  const map = new Map();

  for (const domain of domains) {
    const project = projectName(domain.project_name);
    if (!map.has(project)) {
      map.set(project, { project, normal: 0, warning: 0, blocked: 0, redirected: 0, total: 0 });
    }

    const row = map.get(project);
    const status = normalizeStatus(domain.global_status);
    const redirected = Boolean(domain.final_url);

    row.total += 1;
    if (status === "working") row.normal += 1;
    else if (status === "warning") row.warning += 1;
    else if (status === "blocked" && redirected) row.redirected += 1;
    else if (status === "blocked") row.blocked += 1;
  }

  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

function formatProjectSummaryTable(rows) {
  if (!rows.length) return "-";

  const lines = [
    "| Project | Domain | Status |",
    "|---|---:|---|"
  ];

  for (const row of rows) {
    if (row.normal) lines.push(`| ${safeCell(row.project)} | ${row.normal} | 🟢 Normal |`);
    if (row.warning) lines.push(`| ${safeCell(row.project)} | ${row.warning} | 🟡 Warning |`);
    if (row.blocked) lines.push(`| ${safeCell(row.project)} | ${row.blocked} | 🔴 Blocked |`);
    if (row.redirected) lines.push(`| ${safeCell(row.project)} | ${row.redirected} | ➡️ Redirected |`);
  }

  return lines.join("\n");
}

function formatDetailedDomainTable(title, rows, mode) {
  if (!rows.length) return `${title}\n-`;

  const lines = [
    title,
    "| Project | Domain | Provider / Direct | Detail |",
    "|---|---|---|---|"
  ];

  for (const row of rows.slice(0, DIGEST_LIMIT)) {
    const provider = row.provider_name || row.checker_type || "-";
    const detail = mode === "redirected" ? `➡️ ${row.final_url || "-"}` : (row.reason || "Blocked");
    lines.push(`| ${safeCell(projectName(row.project_name))} | ${safeCell(row.domain)} | ${safeCell(provider)} | ${truncateCell(detail, 90)} |`);
  }

  if (rows.length > DIGEST_LIMIT) {
    lines.push(`...and ${rows.length - DIGEST_LIMIT} more`);
  }

  return lines.join("\n");
}

async function latestDomainStatusRows() {
  const { rows } = await pool.query(`
    SELECT
      d.id,
      d.domain,
      d.project_name,
      d.global_status,
      d.label,
      latest.provider_name,
      latest.checker_type,
      latest.reason,
      latest.checked_at,
      COALESCE(final.final_url, latest.final_url, '') AS final_url
    FROM domains d
    LEFT JOIN LATERAL (
      SELECT provider_name, checker_type, reason, final_url, checked_at
      FROM check_results r
      WHERE r.domain_id = d.id
      ORDER BY r.checked_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT final_url
      FROM check_results r
      WHERE r.domain_id = d.id AND COALESCE(r.final_url, '') <> ''
      ORDER BY r.checked_at DESC
      LIMIT 1
    ) final ON TRUE
    WHERE d.is_active=true
    ORDER BY COALESCE(NULLIF(d.project_name, ''), 'No Project') ASC, d.domain ASC
  `);

  return rows;
}

async function getNodesSummary() {
  try {
    const { rows } = await pool.query(
      `SELECT last_health_status FROM provider_nodes WHERE is_active = TRUE`
    );
    const online = rows.filter(r => r.last_health_status === 'online').length;
    const offline = rows.filter(r => r.last_health_status === 'offline').length;
    return { online, offline, total: rows.length };
  } catch (_) {
    return { online: 0, offline: 0, total: 0 };
  }
}


async function sendHourlyDigest(source) {
  const domains = await latestDomainStatusRows();
  const normal = domains.filter((d) => normalizeStatus(d.global_status) === "working");
  const warning = domains.filter((d) => normalizeStatus(d.global_status) === "warning");
  const blockedAll = domains.filter((d) => normalizeStatus(d.global_status) === "blocked");
  const blocked = blockedAll.filter((d) => !d.final_url);
  const redirected = blockedAll.filter((d) => Boolean(d.final_url));
  const summaryRows = buildProjectSummary(domains);

  const statusTable = monoTable(
    ['OK', 'WRN', 'BLK', 'RDR', 'TOT'],
    [6, 6, 6, 6, 6],
    [[normal.length, warning.length, blocked.length, redirected.length, domains.length]],
    1
  );

  const projTable = monoTable(
    ['PROJECT', 'TOT', 'OK', 'WRN', 'BLK'],
    [20, 3, 3, 3, 3],
    summaryRows.map(r => [
      safeCell(r.project).slice(0, 20),
      r.total,
      r.normal,
      r.warning,
      r.blocked + r.redirected
    ]),
    1
  );

  const message = [
    `🛸 <b>DOMAIN RADAR — LAPORAN JAM</b> ⏰`,
    `<i>${htmlEsc(nowWib())} WIB</i>`,
    '',
    '<b>STATUS</b>',
    `<pre>${htmlEsc(statusTable)}</pre>`,
    '<b>PER PROJECT</b>',
    `<pre>${htmlEsc(projTable)}</pre>`
  ].join('\n');

  const sent = await sendTelegram(message, {
    reply_markup: { inline_keyboard: [[{ text: '🔍 Cek domain-radar.org', url: DASHBOARD_URL }]] }
  });

  if (sent) {
    await pool.query(`
      INSERT INTO telegram_digest_state (key, last_sent_at)
      VALUES ('hourly_status_report', NOW())
      ON CONFLICT (key) DO UPDATE SET last_sent_at=NOW()
    `);
    await pool.query(`
      INSERT INTO telegram_digest_state (key, last_sent_at)
      VALUES ('alternating_report', NOW())
      ON CONFLICT (key) DO UPDATE SET last_sent_at=NOW()
    `);
    console.log(`[TelegramDigest] hourly sent by ${source} at ${nowWib()} WIB`);
  } else {
    console.warn(`[TelegramDigest] hourly failed by ${source}`);
  }
  return sent;
}

async function sendHourlyDigestIfDue(source = "scheduler") {
  if (digestRunning) {
    console.log(`[TelegramDigest] skipped ${source}: digest already running`);
    return false;
  }

  digestRunning = true;

  try {
    await ensureDigestTable();

    const now = Date.now();
    const altIntervalMs = DIGEST_INTERVAL_MINUTES * 60 * 1000;
    const hourlyIntervalMs = HOURLY_DIGEST_MINUTES * 60 * 1000;

    const [{ rows: hourlyState }, { rows: altState }] = await Promise.all([
      pool.query("SELECT last_sent_at FROM telegram_digest_state WHERE key='hourly_status_report' LIMIT 1"),
      pool.query("SELECT last_sent_at FROM telegram_digest_state WHERE key='alternating_report' LIMIT 1")
    ]);

    const hourlyLastAt = hourlyState[0]?.last_sent_at ? new Date(hourlyState[0].last_sent_at).getTime() : 0;
    const altLastAt = altState[0]?.last_sent_at ? new Date(altState[0].last_sent_at).getTime() : 0;

    const isHourlyDue = now - hourlyLastAt >= hourlyIntervalMs;
    const isAltDue = now - altLastAt >= altIntervalMs;

    if (!isHourlyDue && !isAltDue) return false;

    if (isHourlyDue) {
      return await sendHourlyDigest(source);
    }

    if (isAltDue) {
      const reports = await buildProjectRankReports();
      let sent = false;

      if (!reports.length) {
        const msg = [
          `📊 <b>RANK REPORT</b>`,
          `🕐 <i>${htmlEsc(nowWib())} WIB</i>`,
          '',
          '<i>Tidak ada data rank LP/MS saat ini.</i>'
        ].join('\n');
        sent = await sendTelegram(msg, { reply_markup: { inline_keyboard: [[{ text: '🔍 domain-radar.org', url: DASHBOARD_URL }]] } });
      } else {
        for (const { project, message } of reports) {
          const ok = await sendTelegramToProject(project, message, {
            reply_markup: { inline_keyboard: [[{ text: '🔍 domain-radar.org', url: DASHBOARD_URL }]] }
          });
          if (ok) sent = true;
        }
        console.log(`[TelegramDigest] rank report (${reports.length} projects) sent by ${source}`);
      }

      if (sent) {
        await pool.query(`
          INSERT INTO telegram_digest_state (key, last_sent_at)
          VALUES ('alternating_report', NOW())
          ON CONFLICT (key) DO UPDATE SET last_sent_at=NOW()
        `);
      }
      return sent;
    }

    return false;
  } catch (err) {
    console.error(`[TelegramDigest] error from ${source}:`, err.message);
    return false;
  } finally {
    digestRunning = false;
  }
}

async function checkOneDomain(domain, proxies, nodes, retryLimit) {
  try {
    const results = [];

    const directResult = await checkDomain(domain.domain, { type: "direct", provider_name: "Direct" });
    results.push(directResult);

    for (const proxy of proxies) {
      const proxyResult = await checkDomain(domain.domain, { type: "proxy", provider_name: proxy.provider_name, proxy });
      results.push(proxyResult);
    }

    for (const node of nodes) {
      const nodeResult = await checkViaNode(domain.domain, node);
      results.push(nodeResult);
    }

    await maybeAddProviderRegistryResult(domain, results);

    for (const r of results) {
      await pool.query(
        `INSERT INTO check_results
        (domain_id, checker_type, provider_name, status, http_status, final_url, dns_result, latency_ms, reason, reason_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [domain.id, r.checker_type, r.provider_name, r.status, r.http_status, r.final_url, r.dns_result, r.latency_ms, r.reason, classifyReasonType(r)]
      );
    }

    const domainResults = results.filter((r) => !isNodeTimeout(r));
    const effectiveResults = domainResults.length ? domainResults : results;

    const newStatus = calculateGlobalStatus(effectiveResults);
    const oldStatus = domain.global_status || "unknown";

    if (normalizeStatus(newStatus) !== "blocked") {
      await clearAcknowledged(domain.id);
      await clearRecurringAlert(domain.id);
    }

    const decision = decide(domain.id, oldStatus, newStatus, retryLimit);

    if (!decision.apply) {
      await pool.query(
        "UPDATE domains SET last_status=$1, last_checked_at=NOW() WHERE id=$2",
        [decision.value ? `pending:${decision.value}:${decision.count}/${decision.max}` : oldStatus, domain.id]
      );
      return;
    }

    await pool.query(
      "UPDATE domains SET last_status=$1, global_status=$2, last_checked_at=NOW() WHERE id=$3",
      [oldStatus, newStatus, domain.id]
    );

    if (oldStatus !== newStatus) {
      const worst =
        effectiveResults.find((r) => r.status === "blocked") ||
        effectiveResults.find((r) => r.status === "warning") ||
        effectiveResults[0];

      let sent = false;
      let message = `SILENT STATUS CHANGE\n\nDomain: ${domain.domain}\nOld: ${oldStatus}\nNew: ${newStatus}\nChecker: ${worst.provider_name}\nReason Type: ${reasonTypeLabel(classifyReasonType(worst))}\nReason: ${worst.reason}\nTime: ${nowWib()} WIB`;

      if (isImportantTransition(oldStatus, newStatus, worst) && !(await sentRecently(domain.id, newStatus)) && !(normalizeStatus(newStatus) === "blocked" && await isAcknowledged(domain.id))) {
        const icon = iconFor(newStatus, worst.final_url);
        const title = normalizeStatus(newStatus) === "blocked"
          ? `${icon} BLOCKED STATUS CHANGE CONFIRMED`
          : `${icon} WARNING STATUS CHANGE CONFIRMED`;

        const redirectLine = normalizeStatus(newStatus) === "blocked" && worst.final_url
          ? `\nRedirected: ➡️ ${worst.final_url}`
          : "";

        message = `${title}\n\nDomain: ${domain.domain}\nOld: ${oldStatus}\nNew: ${newStatus}\nConfirmed: ${retryLimit} checks\nChecker: ${worst.provider_name}\nReason: ${worst.reason}\nFinal URL: ${worst.final_url || "-"}${redirectLine}\nTime: ${nowWib()} WIB`;

        const telegramExtra = normalizeStatus(newStatus) === "blocked"
          ? {
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Noticed", callback_data: `noticed:${domain.id}:blocked` }
                ]]
              }
            }
          : {};

        sent = await sendTelegram(message, telegramExtra);
      }

      await pool.query(
        "INSERT INTO alerts (domain_id, old_status, new_status, message, sent_to_telegram) VALUES ($1,$2,$3,$4,$5)",
        [domain.id, oldStatus, newStatus, message, sent]
      );

      if (normalizeStatus(newStatus) === 'blocked') {
        const ipBlocked = effectiveResults.some(r => r.checker_type === 'provider_registry' && r.status === 'blocked');
        if (ipBlocked && !(await isAcknowledged(domain.id))) {
          const emergencyMsg = buildEmergencyBlockedMessage(domain, effectiveResults);
          await upsertRecurringAlert(domain.id, domain.domain, emergencyMsg);
          await sendPendingRecurringAlerts();
        }
      } else if (normalizeStatus(newStatus) === 'warning') {
        try {
          const ipResult = await verifyProviderBlock(domain.domain);
          if (ipResult && ipResult.blocked === true && !(await isAcknowledged(domain.id))) {
            const canonicalIpResult = {
              checker_type: 'provider_registry',
              provider_name: 'InternetPositif',
              status: 'blocked',
              reason: `Terdaftar di Internet Positif (${ipResult.raw_excerpt ? ipResult.raw_excerpt.slice(0, 80) : 'Ada'})`,
              final_url: null,
              latency_ms: null
            };
            await pool.query(
              `INSERT INTO check_results (domain_id, checker_type, provider_name, status, reason) VALUES ($1,$2,$3,$4,$5)`,
              [domain.id, canonicalIpResult.checker_type, canonicalIpResult.provider_name, canonicalIpResult.status, canonicalIpResult.reason]
            ).catch(() => {});
            await pool.query(
              `UPDATE domains SET global_status='blocked', last_checked_at=NOW() WHERE id=$1`,
              [domain.id]
            ).catch(() => {});
            const allResults = [...effectiveResults, canonicalIpResult];
            const emergencyMsg = buildEmergencyBlockedMessage(domain, allResults);
            await upsertRecurringAlert(domain.id, domain.domain, emergencyMsg);
            await sendPendingRecurringAlerts();
          }
        } catch (ipErr) {
          console.error(`[WarningIPCheck] ${domain.domain}:`, ipErr.message);
        }
      }
    }
  } catch (err) {
    console.error(`[checkOneDomain] ${domain.domain}:`, err.message);
    _currentCycleErrors++;
  }
}

async function runChecks() {
  if (running) return;
  running = true;
  _currentCycleErrors = 0;
  const cycleStartedAt = Date.now();

  try {
    await ensureReasonTypeColumn();

    const retryLimit = getRetryLimit();
    const { rows: domains } = await pool.query("SELECT * FROM domains WHERE is_active = TRUE AND tenant='admin' ORDER BY id ASC");
    const { rows: proxies } = await pool.query("SELECT * FROM proxies WHERE is_active = TRUE AND tenant='admin' ORDER BY id ASC");
    const nodes = await getActiveNodes();

    const concurrency = Number.isFinite(DOMAIN_CHECK_CONCURRENCY) && DOMAIN_CHECK_CONCURRENCY > 0
      ? DOMAIN_CHECK_CONCURRENCY : 5;

    for (let i = 0; i < domains.length; i += concurrency) {
      const batch = domains.slice(i, i + concurrency);
      await Promise.allSettled(batch.map(domain => checkOneDomain(domain, proxies, nodes, retryLimit)));
    }

    lastCycleDomainCount = domains.length;
    await sendHourlyDigestIfDue("runChecks");
  } catch (err) {
    console.error("Scheduler error:", err);
  } finally {
    running = false;
    lastChecksCompletedAt = Date.now();
    lastCycleErrorCount = _currentCycleErrors;
    lastCycleDurationMs = Date.now() - cycleStartedAt;
  }
}

async function runManualCheck() {
  manualRunning = true;
  try {
    await runChecks();
  } finally {
    manualRunning = false;
  }
}

function getScanCycleHealth() {
  return {
    lastCompletedAt: lastChecksCompletedAt || null,
    domainCount: lastCycleDomainCount,
    errorCount: lastCycleErrorCount,
    durationMs: lastCycleDurationMs,
    running: running || manualRunning,
  };
}

function startDigestWatchdog() {
  if (digestWatchdogStarted) return;
  digestWatchdogStarted = true;

  const minutes = Number.isFinite(DIGEST_WATCHDOG_MINUTES) && DIGEST_WATCHDOG_MINUTES > 0 ? DIGEST_WATCHDOG_MINUTES : 5;
  const intervalMs = minutes * 60 * 1000;

  console.log(`Telegram digest watchdog started: every ${minutes} minutes, digest interval ${DIGEST_INTERVAL_MINUTES} min (alternating), hourly every ${HOURLY_DIGEST_MINUTES} min`);

  setTimeout(() => {
    sendHourlyDigestIfDue("startup-watchdog").catch((err) => console.error("Telegram digest startup watchdog error:", err.message));
  }, 30 * 1000);

  setInterval(() => {
    sendHourlyDigestIfDue("interval-watchdog").catch((err) => console.error("Telegram digest interval watchdog error:", err.message));
  }, intervalMs);

  setInterval(() => {
    sendPendingRecurringAlerts().catch((err) => console.error("Recurring alerts ticker error:", err.message));
  }, 60 * 1000);
}

let rankCheckRunning = false;

async function runAutoRankChecks() {
  if (rankCheckRunning) return;
  rankCheckRunning = true;
  try {
    const { rows: groups } = await pool.query(
      `SELECT * FROM rank_keyword_groups WHERE is_active=true ORDER BY id ASC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    if (!groups.length) return;

    const { rows: activeNodes } = await pool.query(
      `SELECT id, name FROM provider_nodes WHERE is_active=TRUE ORDER BY id ASC`
    ).catch(() => ({ rows: [] }));

    for (const group of groups) {
      await rankCheckGroup(group).catch(err =>
        console.warn(`[RankAuto] VPS group ${group.id}:`, err.message)
      );
    }

    for (const node of activeNodes) {
      for (const group of groups) {
        await rankCheckGroup(group, node.id, node.name).catch(err =>
          console.warn(`[RankAuto] node ${node.id} group ${group.id}:`, err.message)
        );
      }
    }

    console.log(`[RankAuto] Done: ${groups.length} groups × ${activeNodes.length + 1} checkers`);
  } catch (err) {
    console.error('[RankAuto] Error:', err.message);
  } finally {
    rankCheckRunning = false;
  }
}

function startScheduler() {
  const cronExpr = getCronExpr();
  cron.schedule(cronExpr, runChecks);
  startDigestWatchdog();

  if (RANK_CHECK_INTERVAL_MINUTES > 0) {
    setInterval(() => {
      runAutoRankChecks().catch(err => console.error('[RankAuto] interval error:', err.message));
    }, RANK_CHECK_INTERVAL_MINUTES * 60 * 1000);
    setTimeout(() => {
      runAutoRankChecks().catch(err => console.error('[RankAuto] startup error:', err.message));
    }, 90 * 1000);
    console.log(`Rank auto-check: every ${RANK_CHECK_INTERVAL_MINUTES} min`);
  }

  console.log("Scheduler started:", cronExpr, "confirmations:", getRetryLimit());
}

module.exports = { startScheduler, runChecks, runManualCheck, maybeAddProviderRegistryResult, sendHourlyDigestIfDue, clearRecurringAlert, getScanCycleHealth };
