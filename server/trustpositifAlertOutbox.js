"use strict";

// Isolated, fail-closed TrustPositif Telegram outbox.
// State transitions, dashboard alerts and queue insertion share one SQL transaction.
// "uncertain" and abandoned "sending" records are NOT automatically resent:
// Telegram has no sendMessage idempotency key, so replay after an ambiguous
// network result could spam the recipient.
const axios = require("axios");
const { pool } = require("./db");
const { getTelegramConfig } = require("./telegram");
const { isProductionTenant,TENANT_SQL,NON_PRODUCTION_SQL } = require("./customerWhitelistSync");

const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 60000;
const RETRY_CAP_MS = 3600000;
let readyPromise = null;
let draining = false;

async function ensureOutboxTables(db = pool) {
  if (db === pool && readyPromise) return readyPromise;
  const prepare = async () => {
    await db.query([
      "CREATE TABLE IF NOT EXISTS trustpositif_notification_outbox (",
      "id BIGSERIAL PRIMARY KEY,",
      "alert_id INTEGER NOT NULL UNIQUE REFERENCES alerts(id) ON DELETE CASCADE,",
      "domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,",
      "event_type TEXT NOT NULL CHECK (event_type IN ('BLOCKED','REGISTRY_DELISTED')),",
      "message TEXT NOT NULL,",
      "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retry','sending','sent','failed','uncertain','cancelled')),",
      "attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
      "claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, last_error_code TEXT NOT NULL DEFAULT '',",
      "telegram_message_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    await db.query([
      "CREATE TABLE IF NOT EXISTS trustpositif_notification_attempts (",
      "id BIGSERIAL PRIMARY KEY, outbox_id BIGINT NOT NULL",
      "REFERENCES trustpositif_notification_outbox(id) ON DELETE CASCADE,",
      "attempt_no INTEGER NOT NULL, outcome TEXT NOT NULL,",
      "error_code TEXT NOT NULL DEFAULT '', attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    await db.query("CREATE INDEX IF NOT EXISTS idx_tp_outbox_due ON trustpositif_notification_outbox(status, next_attempt_at, created_at)");
    await db.query("CREATE INDEX IF NOT EXISTS idx_tp_outbox_domain ON trustpositif_notification_outbox(domain_id, created_at DESC)");
    // Created by the backend's private database role; no anon/authenticated
    // SELECT/INSERT/UPDATE policies or grants. Data API callers cannot read it.
    await db.query("ALTER TABLE trustpositif_notification_outbox ENABLE ROW LEVEL SECURITY");
    await db.query("ALTER TABLE trustpositif_notification_attempts ENABLE ROW LEVEL SECURITY");
  };
  if (db !== pool) return prepare();
  readyPromise = prepare().catch(err => { readyPromise = null; throw err; });
  return readyPromise;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wib(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "Not available";
  return date.toLocaleString("id-ID", {
    timeZone:"Asia/Jakarta", day:"2-digit", month:"2-digit", year:"numeric",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  }) + " WIB";
}

function formatEventMessage({ domain, tenant, project, eventType, nodes = [], confirmedAt, detectedAt, source, newStatus }) {
  const blocked = eventType === "BLOCKED";
  const uniqueProviders = [...new Set(nodes.map(n => String(n.provider || "").trim()).filter(Boolean))];
  const names = nodes.map(n => n.name || String(n.id)).filter(Boolean);
  return [
    blocked ? "🚨 <b>PENTAGON SECURITY ALERT</b>" : "🛡️ <b>PENTAGON TRUSTPOSITIF UPDATE</b>",
    "",
    "<b>Status:</b> " + (blocked
      ? "BLOCKED (2-node WARNING trigger + TRADEVICEPC official registry match)"
      : newStatus==="working"
        ? "REGISTRY DELISTED (independent network recovery verified)"
        : "REGISTRY DELISTED (network not yet cleared)"),
    "<b>Domain:</b> <code>" + escapeHtml(domain) + "</code>",
    "<b>Customer:</b> " + escapeHtml(tenant || "admin"),
    "<b>Project:</b> " + escapeHtml(project || "Not available"),
    "<b>First detected:</b> " + escapeHtml(wib(detectedAt)),
    "<b>Confirmed:</b> " + escapeHtml(wib(confirmedAt)),
    "<b>Warning trigger nodes:</b> " + String(nodes.length),
    "<b>Nodes:</b> " + escapeHtml(names.join(", ") || "Not available"),
    "<b>Providers:</b> " + escapeHtml(uniqueProviders.join(", ") || "Not available"),
    "<b>TrustPositif:</b> " + (blocked
      ? "Verified TRADEVICEPC exact-match snapshot; node warnings were trigger only"
      : "Exact official registry delisting; network requires separate WORKING confirmation"),
    "<b>Source:</b> " + escapeHtml(source || "Not available"),
    "<b>Severity:</b> " + (blocked ? "High" : "Informational"),
    "",
    blocked ? "Action: Review Pentagon Defence Center." :
      "Action: Verify independent network recovery before marking Healthy."
  ].join("\n");
}

async function enqueueTransition({ domain, oldStatus, newStatus, eventType, message, db = pool }) {
  if (!domain || !isProductionTenant(domain.tenant) || !["BLOCKED", "REGISTRY_DELISTED"].includes(eventType))
    throw new Error("INVALID_TRUSTPOSITIF_EVENT");
  await ensureOutboxTables(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE domains SET last_status=$1,global_status=$2,last_checked_at=NOW() " +
      "WHERE id=$3 AND tenant=$5 AND is_active=TRUE AND COALESCE(global_status,'unknown')=$4 RETURNING id",
      [oldStatus, newStatus, domain.id, oldStatus, domain.tenant]
    );
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return { queued:false, reason:"STALE_TRANSITION" };
    }
    const alert = await client.query(
      "INSERT INTO alerts(domain_id,old_status,new_status,message,sent_to_telegram) VALUES ($1,$2,$3,$4,FALSE) RETURNING id",
      [domain.id, oldStatus, newStatus, message]
    );
    const created = await client.query(
      "INSERT INTO trustpositif_notification_outbox(alert_id,domain_id,event_type,message) " +
      "VALUES ($1,$2,$3,$4) ON CONFLICT (alert_id) DO NOTHING RETURNING id",
      [alert.rows[0].id, domain.id, eventType, message]
    );
    await client.query("COMMIT");
    return { queued:Boolean(created.rowCount), alertId:alert.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function errorCode(code) {
  return String(code || "DELIVERY_UNKNOWN").replace(/[^A-Za-z0-9_]/g, "").slice(0,64) || "DELIVERY_UNKNOWN";
}

// Resolve alert recipient from the database-owned domain tenant, never from a
// request/body parameter. Merchant settings override the platform fallback.
async function outboxRecipient(entry, db = pool, defaults = getTelegramConfig()) {
  if (!entry?.domain_id) return { ...defaults, outcome:null };
  const { rows } = await db.query(
    "SELECT d.tenant,s.value FROM domains d LEFT JOIN app_settings s " +
    "ON s.key='merchant_telegram_'||d.tenant WHERE d.id=$1 AND d.is_active=TRUE LIMIT 1",
    [entry.domain_id]
  );
  if (!rows.length) return { outcome:"cancelled", code:"DOMAIN_NOT_ACTIVE" };
  const row=rows[0];
  // Production customer alerts never fall back to the shared Domain Radar
  // operations chat. A destination is eligible ONLY when an administrator has
  // permanently bound that merchant to a unique verified report group.
  if (db === pool && process.env.TELEGRAM_HUB_ENABLED === "true" && row.tenant !== "admin") {
    const hub = await db.query(
      "SELECT c.chat_id,c.enabled,c.status,c.immediate_alert,c.recovery_alert "+
      "FROM telegram_merchant_groups g JOIN telegram_hub_connections c "+
      "ON c.tenant=g.tenant AND c.chat_id=g.chat_id WHERE g.tenant=$1 LIMIT 1",[row.tenant]
    );
    const verified=hub.rows[0];
    if (!verified) return { outcome:"cancelled",code:"MERCHANT_PERMANENT_GROUP_NOT_READY" };
    if (verified.enabled !== true || verified.status !== "connected" || !verified.chat_id)
      return { outcome:"cancelled", code:"MERCHANT_HUB_NOT_CONNECTED" };
    if (entry.event_type === "BLOCKED" && verified.immediate_alert !== true)
      return { outcome:"cancelled", code:"MERCHANT_BLOCK_ALERT_DISABLED" };
    if (entry.event_type === "REGISTRY_DELISTED" && verified.recovery_alert !== true)
      return { outcome:"cancelled", code:"MERCHANT_RECOVERY_ALERT_DISABLED" };
    return { token:defaults.token,chatId:verified.chat_id,outcome:null };
  }
  if (row.value === null || row.value === undefined || row.value === "") {
    return { ...defaults, outcome:null };
  }
  try {
    const cfg = JSON.parse(row.value);
    if (cfg.enabled !== true) return { outcome:"cancelled", code:"MERCHANT_NOTIFICATIONS_DISABLED" };
    if (!/^-?[0-9]{5,20}$/.test(String(cfg.chat_id||""))) {
      return { outcome:"failed", code:"MERCHANT_CHAT_ID_INVALID" };
    }
    return { token:defaults.token,chatId:String(cfg.chat_id),outcome:null };
  } catch (_) {
    return { outcome:"failed", code:"MERCHANT_SETTINGS_MALFORMED" };
  }
}

async function deliverTelegram(message, entry = null, options = {}) {
  let recipient;
  try {
    recipient = await outboxRecipient(entry, options.db || pool, options.botConfig || getTelegramConfig());
  } catch (err) {
    return { outcome:"retry", code:"MERCHANT_ROUTING_UNAVAILABLE" };
  }
  if (recipient.outcome) return { outcome:recipient.outcome, code:recipient.code };
  const { token, chatId } = recipient;
  if (!token || !chatId) return { outcome:"retry", code:"TELEGRAM_NOT_CONFIGURED" };
  try {
    const response = await (options.transport || axios).post("https://api.telegram.org/bot" + token + "/sendMessage", {
      chat_id:chatId, text:String(message).slice(0,3900), parse_mode:"HTML",
      disable_web_page_preview:true,
      ...(entry?.event_type ? {
        protect_content:true,
        reply_markup:{inline_keyboard:[[{text:"🛡️ Review Defence Center",
          url:"https://pentagon.quest"}]]}
      } : {})
    }, { timeout:12000, validateStatus:() => true });
    const status = Number(response.status || 0);
    const payload = response.data || {};
    if (status >= 200 && status < 300 && payload.ok === true)
      return { outcome:"sent", messageId:String(payload.result?.message_id || "") };
    if (status === 429)
      return { outcome:"retry", code:"TELEGRAM_RATE_LIMITED",
        retryAfterMs:Math.min(3600000,Math.max(0,Number(payload.parameters?.retry_after || 60)*1000)) };
    if (status >= 400 && status < 500)
      return { outcome:"failed", code:"TELEGRAM_HTTP_" + status };
    return { outcome:"uncertain", code:"TELEGRAM_UPSTREAM_AMBIGUOUS" };
  } catch (err) {
    const code = errorCode(err?.code);
    if (["ENOTFOUND","EAI_AGAIN","ECONNREFUSED","ENETUNREACH","EHOSTUNREACH"].includes(code))
      return { outcome:"retry", code };
    return { outcome:"uncertain", code: code === "DELIVERY_UNKNOWN" ? "AMBIGUOUS_NETWORK" : code };
  }
}

function backoffMs(attemptNo) {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, Math.min(8, Math.max(0,attemptNo-1))));
}

async function finalizeAttempt(db, entry, result, now = new Date()) {
  const client = await db.connect();
  let outcome = ["sent","retry","failed","uncertain","cancelled"].includes(result?.outcome)
    ? result.outcome : "uncertain";
  if (outcome === "retry" && entry.attempts >= MAX_ATTEMPTS) outcome = "failed";
  const delay = outcome === "retry"
    ? Math.max(backoffMs(entry.attempts), Number(result.retryAfterMs || 0)) : 0;
  const dueAt = new Date(now.getTime() + delay);
  const safeCode = errorCode(result?.code || "");
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE trustpositif_notification_outbox SET status=$2,next_attempt_at=$3," +
      "sent_at=CASE WHEN $2='sent' THEN $4 ELSE sent_at END," +
      "telegram_message_id=CASE WHEN $2='sent' THEN $5 ELSE telegram_message_id END," +
      "last_error_code=$6,updated_at=$4 WHERE id=$1 AND status='sending'",
      [entry.id, outcome, dueAt, now, result?.messageId || null, outcome === "sent" ? "" : safeCode]
    );
    await client.query(
      "INSERT INTO trustpositif_notification_attempts(outbox_id,attempt_no,outcome,error_code) VALUES ($1,$2,$3,$4)",
      [entry.id,entry.attempts,outcome,outcome === "sent" ? "" : safeCode]
    );
    if (outcome === "sent") {
      await client.query("UPDATE alerts SET sent_to_telegram=TRUE WHERE id=$1", [entry.alert_id]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return outcome;
}

async function drainOutbox({ db = pool, sender = deliverTelegram, limit = 5, now = new Date() } = {}) {
  if (db === pool && draining) return { claimed:0, busy:true };
  if (db === pool) draining = true;
  try {
    await ensureOutboxTables(db);
    const candidates = await db.query(
      "WITH chosen AS (SELECT id FROM trustpositif_notification_outbox " +
      "WHERE status IN ('pending','retry') AND next_attempt_at<=$2::timestamptz " +
      "ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1) " +
      "UPDATE trustpositif_notification_outbox o SET status='sending'," +
      "attempts=attempts+1,claimed_at=NOW(),updated_at=NOW() " +
      "FROM chosen WHERE o.id=chosen.id RETURNING o.*",
      [Math.max(1,Math.min(20,Number(limit)||5)),now]
    );
    const outcomes = [];
    for (const entry of candidates.rows) {
      const current = await db.query(
        "SELECT global_status FROM domains WHERE id=$1 AND is_active=TRUE AND " +
        "tenant ~ $2 AND tenant !~* $3 LIMIT 1",
        [entry.domain_id,TENANT_SQL,NON_PRODUCTION_SQL]
      );
      const currentStatus = current.rows[0]?.global_status || "unknown";
      const stale = !current.rows.length ||
        (entry.event_type === "BLOCKED" && currentStatus !== "blocked") ||
        (entry.event_type === "REGISTRY_DELISTED" && currentStatus === "blocked");
      let result;
      if (stale) result = { outcome:"cancelled",code:"EVENT_SUPERSEDED" };
      else {
        try { result = await sender(entry.message,entry); }
        catch (_) { result = { outcome:"uncertain",code:"SENDER_THROW_AMBIGUOUS" }; }
      }
      outcomes.push(await finalizeAttempt(db,entry,result,now));
    }
    return { claimed:candidates.rows.length, outcomes };
  } finally {
    if (db === pool) draining = false;
  }
}

async function deliverySummary(tenant = "admin", db = pool) {
  try {
    const { rows } = await db.query(
      "SELECT COUNT(*) FILTER (WHERE o.status IN ('pending','retry'))::int AS queued," +
      "COUNT(*) FILTER (WHERE o.status='sent')::int AS sent," +
      "COUNT(*) FILTER (WHERE o.status IN ('failed','uncertain','sending'))::int AS attention," +
      "MAX(o.updated_at) AS last_activity " +
      "FROM trustpositif_notification_outbox o JOIN domains d ON d.id=o.domain_id " +
      "WHERE (($1='admin' AND d.tenant ~ $2 AND d.tenant !~* $3) OR ($1<>'admin' AND d.tenant=$1))",
      [tenant,TENANT_SQL,NON_PRODUCTION_SQL]
    );
    return rows[0] || { queued:0,sent:0,attention:0,last_activity:null };
  } catch (err) {
    if (err.code === "42P01") return { queued:0,sent:0,attention:0,last_activity:null,unavailable:true };
    throw err;
  }
}

async function recentNotificationLog(tenant = "admin", db = pool, limit = 20) {
  try {
    const { rows } = await db.query(
      "SELECT o.id,o.event_type,o.status,o.attempts,o.created_at,o.updated_at,o.sent_at," +
      "o.last_error_code,d.domain,d.project_name,d.tenant," +
      "COALESCE((SELECT jsonb_agg(jsonb_build_object(" +
      "'at',a.attempted_at,'outcome',a.outcome,'code',a.error_code) " +
      "ORDER BY a.attempted_at DESC) FROM trustpositif_notification_attempts a " +
      "WHERE a.outbox_id=o.id),'[]'::jsonb) AS history " +
      "FROM trustpositif_notification_outbox o JOIN domains d ON d.id=o.domain_id " +
      "WHERE (($1='admin' AND d.tenant ~ $3 AND d.tenant !~* $4) OR " +
      "($1<>'admin' AND d.tenant=$1)) ORDER BY o.id DESC LIMIT $2",
      [tenant,Math.max(1,Math.min(50,Number(limit)||20)),TENANT_SQL,NON_PRODUCTION_SQL]
    );
    return rows;
  } catch (err) {
    if (err.code === "42P01") return [];
    throw err;
  }
}

module.exports = {
  ensureOutboxTables,enqueueTransition,drainOutbox,deliverySummary,recentNotificationLog,
  deliverTelegram,formatEventMessage,backoffMs
};
