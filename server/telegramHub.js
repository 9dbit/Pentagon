"use strict";

// Pentagon Telegram Hub. All tenant identity comes from a verified merchant
// session. A Telegram deep link is an untrusted claim, not activation;
// authenticated dashboard confirmation is mandatory.
const express = require("express");
const crypto = require("node:crypto");
const axios = require("axios");
const { pool } = require("./db");
const { getTelegramConfig, answerCallbackQuery, editMessageReplyMarkup } = require("./telegram");
const { requireMerchantAdmin } = require("./customerViewerAuth");
const { markAcknowledged } = require("./noticeState");
const { clearRecurringAlert } = require("./scheduler");
const permanentGroups = require("./telegramPermanentGroups");
const merchantActivation = require("./telegramMerchantActivation");
const merchantAutoGroups = require("./telegramMerchantAutoProvisioner");

const BASE_URL = "https://pentagon-web-production.up.railway.app";
const HUB_PATH = "/api/telegram/hub/webhook";
const VALID_INTERVALS = new Set([10, 30, 60, 180, 1440]);
let schemaReady = null;
let botUsername = "";
let opsChatId = "";
let workerStarted = false;
let initialized = false;

function hubEnabled() { return process.env.TELEGRAM_HUB_ENABLED === "true"; }
function botToken() { return String(getTelegramConfig().token || ""); }
function webhookSecret() {
  const token = botToken();
  return token ? crypto.createHmac("sha256", token).update("pentagon-hub-v1-webhook").digest("hex") : "";
}
function verifyWebhookSecret(header) {
  const secret = webhookSecret();
  if (!hubEnabled() || !secret || typeof header !== "string") return false;
  const a = Buffer.from(header), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hashToken(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function permittedTenant(v) {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(String(v || "")) &&
    !/^(demo|test|staging|sandbox|sample)(?:[-_]|$)/i.test(String(v || ""));
}
function safeUsername(s) {
  const v = String(s || "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{5,32}$/.test(v) ? v : "";
}
function numericChatId(value) { return /^-?[0-9]{5,20}$/.test(String(value || "")); }
function configuredOpsChatId() {
  const id = process.env.TELEGRAM_OPS_MAIN_CHAT_ID || getTelegramConfig().chatId;
  return numericChatId(id) ? String(id) : "";
}
function safeGroupTitle(value) {
  return String(value || "").replace(/[\x00-\x1F\x7F]/g," ").trim().slice(0,100);
}
function mask(s) {
  const x = String(s || "");
  return x ? x.slice(0, Math.min(3, x.length)) + "••••" + x.slice(-3) : "";
}
async function tg(method, payload, timeout = 10000) {
  const token = botToken();
  if (!token) throw Object.assign(new Error("BOT_NOT_CONFIGURED"), { code: "BOT_NOT_CONFIGURED" });
  const response = await axios.post("https://api.telegram.org/bot" + token + "/" + method, payload, {
    timeout, validateStatus: () => true
  });
  if (!response.data?.ok) {
    const code = response.data?.error_code || response.status;
    throw Object.assign(new Error("TELEGRAM_API_ERROR"), { code: "TELEGRAM_HTTP_" + code });
  }
  return response.data.result;
}
function configResult() {
  return { bot_configured: Boolean(botToken()), bot_username: botUsername,
    enabled: hubEnabled(), main_forum_configured: Boolean(opsChatId) };
}
async function ensureTables(db = pool) {
  if (db === pool && schemaReady) return schemaReady;
  const run = async () => {
    await db.query([
      "CREATE TABLE IF NOT EXISTS telegram_hub_links (",
      "token_hash CHAR(64) PRIMARY KEY, request_id UUID NOT NULL UNIQUE,",
      "tenant TEXT NOT NULL, requester_email TEXT NOT NULL, mode TEXT NOT NULL",
      "CHECK(mode IN ('private','group')), expires_at TIMESTAMPTZ NOT NULL,",
      "claimed_at TIMESTAMPTZ, claimed_chat_id TEXT, claimed_user_id TEXT,",
      "claimed_username TEXT, claimed_chat_type TEXT, claimed_chat_title TEXT, consumed_at TIMESTAMPTZ,",
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    await db.query([
      "CREATE TABLE IF NOT EXISTS telegram_hub_connections (",
      "tenant TEXT PRIMARY KEY, chat_id TEXT, telegram_user_id TEXT,",
      "telegram_username TEXT, chat_type TEXT CHECK(chat_type IN ('private','group','supergroup')), chat_title TEXT,",
      "enabled BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'disconnected'",
      "CHECK(status IN ('connected','paused','disconnected')),",
      "interval_minutes INTEGER NOT NULL DEFAULT 60,",
      "digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,",
      "immediate_alert BOOLEAN NOT NULL DEFAULT TRUE, recovery_alert BOOLEAN NOT NULL DEFAULT TRUE,",
      "node_warning BOOLEAN NOT NULL DEFAULT TRUE, rank_report BOOLEAN NOT NULL DEFAULT TRUE,",
      "next_report_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '60 minutes',",
      "connected_at TIMESTAMPTZ, last_report_at TIMESTAMPTZ, last_delivery_at TIMESTAMPTZ,",
      "last_delivery_status TEXT NOT NULL DEFAULT 'not_tested',",
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    await db.query([
      "CREATE TABLE IF NOT EXISTS telegram_hub_ops_topics (",
      "tenant TEXT PRIMARY KEY, chat_id TEXT, message_thread_id BIGINT,",
      "status TEXT NOT NULL DEFAULT 'not_configured',",
      "last_attempt_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    await db.query([
      "CREATE TABLE IF NOT EXISTS telegram_hub_report_outbox (",
      "id BIGSERIAL PRIMARY KEY, tenant TEXT NOT NULL, chat_id TEXT NOT NULL,",
      "kind TEXT NOT NULL, message TEXT NOT NULL,",
      "status TEXT NOT NULL DEFAULT 'pending'",
      "CHECK(status IN ('pending','retry','sending','sent','failed','uncertain','cancelled')),",
      "attempts INTEGER NOT NULL DEFAULT 0,",
      "next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
      "claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,",
      "last_error_code TEXT NOT NULL DEFAULT '',",
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ].join(" "));
    // Existing production tables predate group-name metadata. Additive only.
    await db.query("ALTER TABLE telegram_hub_links ADD COLUMN IF NOT EXISTS claimed_chat_title TEXT");
    await db.query("ALTER TABLE telegram_hub_connections ADD COLUMN IF NOT EXISTS chat_title TEXT");
    // Additive rich rendering; old queued legacy HTML messages remain readable.
    await db.query("ALTER TABLE telegram_hub_report_outbox ADD COLUMN IF NOT EXISTS rich_message JSONB");
    // Existing production tables were created with rank_report=false. Change only
    // the default; explicit merchant choices in existing rows remain unchanged.
    await db.query("ALTER TABLE telegram_hub_connections ALTER COLUMN rank_report SET DEFAULT TRUE");
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_unique_connected_group ON telegram_hub_connections(chat_id) WHERE enabled=TRUE AND status='connected' AND chat_type IN ('group','supergroup') AND chat_id IS NOT NULL");
    await db.query("CREATE TABLE IF NOT EXISTS telegram_hub_webhook_updates (update_id BIGINT PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await db.query("CREATE INDEX IF NOT EXISTS idx_hub_links_tenant ON telegram_hub_links(tenant,requester_email,created_at DESC)");
    await db.query("CREATE INDEX IF NOT EXISTS idx_hub_report_due ON telegram_hub_report_outbox(status,next_attempt_at)");
    for (const table of ["telegram_hub_links","telegram_hub_connections","telegram_hub_ops_topics","telegram_hub_report_outbox","telegram_hub_webhook_updates"]) {
      await db.query("ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY");
      await db.query("REVOKE ALL ON TABLE " + table + " FROM PUBLIC");
      // Supabase roles exist in production, but vanilla PostgreSQL test
      // fixtures do not define them.
      for (const role of ["anon","authenticated"]) {
        const present=await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role]);
        if (present.rows.length) await db.query("REVOKE ALL ON TABLE " + table + " FROM " + role);
      }
    }
  };
  if (db !== pool) return run();
  schemaReady = run().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

async function getOpsForum() {
  const configured = configuredOpsChatId();
  if (!configured) return "";
  try {
    const chat = await tg("getChat", { chat_id: configured });
    const ready=chat?.type === "supergroup" && chat?.is_forum === true;
    console.log("[Telegram Hub] ops getChat result:", ready?"forum_ready":"not_forum", "type="+String(chat?.type||"unknown").slice(0,20), "is_forum="+String(chat?.is_forum===true));
    return ready ? String(configured) : "";
  } catch (e) {
    console.warn("[Telegram Hub] ops getChat unavailable:",String(e.code||"UNKNOWN").slice(0,35));
    return "";
  }
}
async function ensureOpsTopic(tenant, db = pool) {
  if (!opsChatId || !permittedTenant(tenant)) return "not_configured";
  await ensureTables(db);
  const claim = await db.query(
    "INSERT INTO telegram_hub_ops_topics(tenant,chat_id,status,last_attempt_at) " +
    "VALUES($1,$2,'provisioning',NOW()) ON CONFLICT(tenant) DO UPDATE SET " +
    "status='provisioning',chat_id=EXCLUDED.chat_id,last_attempt_at=NOW(),updated_at=NOW() " +
    "WHERE telegram_hub_ops_topics.status='not_configured' " +
    "RETURNING tenant",
    [tenant,opsChatId]
  );
  if (!claim.rowCount) return "existing";
  try {
    const topic = await tg("createForumTopic", {
      chat_id: opsChatId, name: "Merchant • " + tenant.slice(0, 80)
    });
    await db.query(
      "UPDATE telegram_hub_ops_topics SET status='ready',message_thread_id=$2,updated_at=NOW() WHERE tenant=$1",
      [tenant,topic.message_thread_id]
    );
    return "ready";
  } catch (_) {
    // A timeout is ambiguous: never retry automatically and create duplicates.
    await db.query(
      "UPDATE telegram_hub_ops_topics SET status='needs_attention',updated_at=NOW() WHERE tenant=$1",
      [tenant]
    );
    return "needs_attention";
  }
}
async function botName() {
  if (botUsername) return botUsername;
  const me = await tg("getMe", {});
  botUsername = safeUsername(me?.username);
  return botUsername;
}

function createMerchantTelegramHubRouter(db = pool) {
  const router = express.Router();
  router.use(requireMerchantAdmin);
  router.use((_req,res,next) => { res.set("Cache-Control","private, no-store"); next(); });
  function tenant(req) { return req.merchantTenant; }
  function owner(req) { return String(req.session?.adminEmail || "").toLowerCase(); }
  const guard = fn => async (req,res) => {
    if (!hubEnabled()) return res.status(503).json({ error:"TELEGRAM_HUB_NOT_ENABLED" });
    try { await ensureTables(db); return await fn(req,res); }
    catch (err) {
      console.warn("[Telegram Hub] merchant operation failed",String(err.code || "UNAVAILABLE").slice(0,40));
      return res.status(503).json({error:"TELEGRAM_HUB_UNAVAILABLE"});
    }
  };
  router.get("/status",guard(async(req,res) => {
    const t=tenant(req);
    if (!permittedTenant(t)) return res.status(403).json({error:"INVALID_TENANT"});
    await permanentGroups.ensurePermanentGroupTables(db);
    const [connections,pending,count,ops,hint,permanent]=await Promise.all([
      db.query("SELECT tenant,telegram_username,chat_type,chat_title,chat_id,enabled,status,interval_minutes,"+
        "digest_enabled,immediate_alert,recovery_alert,node_warning,rank_report,"+
        "connected_at,last_report_at,last_delivery_at,last_delivery_status "+
        "FROM telegram_hub_connections WHERE tenant=$1",[t]),
      db.query("SELECT request_id,mode,expires_at,claimed_at,claimed_username,claimed_chat_type,claimed_chat_title "+
        "FROM telegram_hub_links WHERE tenant=$1 AND requester_email=$2 "+
        "AND consumed_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1",[t,owner(req)]),
      db.query("SELECT COUNT(DISTINCT LOWER(TRIM(k.domain)))::int AS total "+
        "FROM rank_keyword_domains k JOIN rank_keyword_groups g ON g.id=k.group_id "+
        "JOIN domains d ON LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)) AND d.tenant=g.tenant "+
        "WHERE g.tenant=$1 AND g.is_active=TRUE AND k.is_whitelisted=TRUE AND d.is_active=TRUE",[t]),
      db.query("SELECT status FROM telegram_hub_ops_topics WHERE tenant=$1",[t]),
      db.query("SELECT value FROM app_settings WHERE key=$1 LIMIT 1",["merchant_telegram_username_hint_"+t]),
      db.query("SELECT chat_title,verified_at FROM telegram_merchant_groups WHERE tenant=$1 LIMIT 1",[t])
    ]);
    const c=connections.rows[0] || null;
    if (opsChatId && !ops.rows[0]) {
      ensureOpsTopic(t,db).catch(()=>{});
    }
    return res.json({
      ...configResult(), tenant:t,
       permanent_group_ready:Boolean(permanent.rows[0]),
       permanent_group_title:permanent.rows[0]?.chat_title||"",
       permanent_group_verified_at:permanent.rows[0]?.verified_at||null,
      status:c?.status||"not_connected", connected:Boolean(c?.chat_id&&c?.enabled),
      chat_type:c?.chat_type||null,chat_title:c?.chat_title||"",telegram_username:c?.telegram_username||"",
      chat_masked:mask(c?.chat_id),connected_at:c?.connected_at||null,
      last_report_at:c?.last_report_at||null,
      last_delivery_at:c?.last_delivery_at||null,
      last_delivery_status:c?.last_delivery_status||"not_tested",
      whitelist_count:count.rows[0]?.total||0,
      identity_hint:hint.rows[0]?.value||"",
      ops_topic_status:ops.rows[0]?.status || (opsChatId ? "provisioning" : "not_configured"),
      pending:pending.rows[0]||null,
      preferences_saved:Boolean(c),
      preferences:{
        digest_enabled:c?.digest_enabled??true,
        immediate_alert:c?.immediate_alert??true,
        recovery_alert:c?.recovery_alert??true,
        node_warning:c?.node_warning??true,
        rank_report:c?.rank_report??true,
        interval_minutes:c?.interval_minutes||60
      }
    });
  }));
  router.patch("/identity-hint",guard(async(req,res)=>{
    const username=safeUsername(req.body?.username);
    if(!username)return res.status(400).json({error:"INVALID_TELEGRAM_USERNAME"});
    await db.query("INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) "+
      "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
      ["merchant_telegram_username_hint_"+tenant(req),username]);
    return res.json({ok:true,identity_hint:username,verified:false});
  }));
  router.post("/activate",guard(async(req,res)=>{
    // Legacy /startgroup links require the merchant to choose a group, creating
    // cross-tenant delivery risk. The sole path is an admin-bound permanent group.
    return res.status(410).json({error:"USE_PERMANENT_REPORT_GROUP_QR"});
    const t=tenant(req),email=owner(req);
    // Merchant reports default to a dedicated group; DM remains explicit opt-in.
    const mode=req.body?.mode==="private"?"private":"group";
    if (!permittedTenant(t)||!email) return res.status(403).json({error:"INVALID_TENANT"});
    const username=await botName();
    if (!username) return res.status(503).json({error:"BOT_USERNAME_UNAVAILABLE"});
    await db.query("DELETE FROM telegram_hub_links WHERE tenant=$1 AND requester_email=$2 AND consumed_at IS NULL",[t,email]);
    const token=crypto.randomBytes(24).toString("base64url");
    const requestId=crypto.randomUUID();
    await db.query(
      "INSERT INTO telegram_hub_links(token_hash,request_id,tenant,requester_email,mode,expires_at) "+
      "VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')",
      [hashToken(token),requestId,t,email,mode]
    );
    const param=mode==="group"?"startgroup":"start";
    const url="https://t.me/"+username+"?"+param+"=pt_"+token;
    return res.status(201).json({request_id:requestId,mode,expires_in_seconds:600,url,bot_username:username});
  }));
  router.get("/activate/:requestId",guard(async(req,res)=>{
    if(!/^[0-9a-f-]{36}$/i.test(req.params.requestId))
      return res.status(400).json({error:"INVALID_REQUEST"});
    const {rows}=await db.query(
      "SELECT request_id,mode,expires_at,claimed_at,claimed_username,claimed_chat_type,claimed_chat_title "+
      "FROM telegram_hub_links WHERE request_id=$1 AND tenant=$2 AND requester_email=$3 "+
      "AND consumed_at IS NULL AND expires_at>NOW() LIMIT 1",
      [req.params.requestId,tenant(req),owner(req)]
    );
    if (!rows.length) return res.status(404).json({error:"ACTIVATION_EXPIRED"});
    return res.json({...rows[0],claimed:Boolean(rows[0].claimed_at)});
  }));
  router.post("/confirm",guard(async(req,res)=>{
    return res.status(410).json({error:"USE_PERMANENT_REPORT_GROUP_QR"});
    const id=String(req.body?.request_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({error:"INVALID_REQUEST"});
    const tx=await db.connect();
    try {
      await tx.query("BEGIN");
      const {rows}=await tx.query(
        "SELECT * FROM telegram_hub_links WHERE request_id=$1 AND tenant=$2 AND requester_email=$3 "+
        "AND claimed_at IS NOT NULL AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [id,tenant(req),owner(req)]
      );
      if(!rows.length){await tx.query("ROLLBACK");return res.status(409).json({error:"TELEGRAM_CONFIRMATION_NOT_READY"});}
      const link=rows[0];
      if(!numericChatId(link.claimed_chat_id)||!numericChatId(link.claimed_user_id)) {
        await tx.query("ROLLBACK");return res.status(409).json({error:"TELEGRAM_IDENTITY_INVALID"});
      }
      const isGroup=["group","supergroup"].includes(link.claimed_chat_type);
      if ((link.mode==="group"&&!isGroup) || (link.mode==="private"&&link.claimed_chat_type!=="private") ||
          (isGroup&&String(link.claimed_chat_id)===configuredOpsChatId())) {
        await tx.query("ROLLBACK");return res.status(409).json({error:"MERCHANT_GROUP_REQUIRED"});
      }
      if(isGroup){
        const existing=await tx.query(
          "SELECT tenant FROM telegram_hub_connections WHERE chat_id=$1 AND tenant<>$2 "+
          "AND enabled=TRUE AND status='connected' AND chat_type IN ('group','supergroup') LIMIT 1 FOR UPDATE",
          [link.claimed_chat_id,tenant(req)]
        );
        if(existing.rows.length){
          await tx.query("ROLLBACK");return res.status(409).json({error:"GROUP_ALREADY_LINKED"});
        }
      }
      await tx.query(
        "INSERT INTO telegram_hub_connections(tenant,chat_id,telegram_user_id,telegram_username,chat_type,chat_title,enabled,status,connected_at,next_report_at) "+
        "VALUES($1,$2,$3,$4,$5,$6,TRUE,'connected',NOW(),NOW()+INTERVAL '60 minutes') "+
        "ON CONFLICT(tenant) DO UPDATE SET chat_id=EXCLUDED.chat_id,telegram_user_id=EXCLUDED.telegram_user_id,"+
        "telegram_username=EXCLUDED.telegram_username,chat_type=EXCLUDED.chat_type,chat_title=EXCLUDED.chat_title,"+
        "enabled=TRUE,status='connected',connected_at=NOW(),next_report_at=NOW()+INTERVAL '60 minutes',"+
        "last_delivery_status='not_tested',updated_at=NOW()",
        [tenant(req),link.claimed_chat_id,link.claimed_user_id,link.claimed_username,link.claimed_chat_type,
          isGroup?safeGroupTitle(link.claimed_chat_title):""]
      );
      // Bridge existing immediate TrustPositif outbox, but only with a verified chat.
      await tx.query(
        "INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) "+
        "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
        ["merchant_telegram_"+tenant(req),JSON.stringify({enabled:true,chat_id:link.claimed_chat_id})]
      );
      await tx.query("UPDATE telegram_hub_links SET consumed_at=NOW() WHERE request_id=$1",[id]);
      await tx.query("DELETE FROM telegram_hub_links WHERE tenant=$1 AND consumed_at IS NULL",[tenant(req)]);
      await tx.query("COMMIT");
      return res.json({ok:true,connected:true,chat_type:link.claimed_chat_type,
        chat_title:isGroup?safeGroupTitle(link.claimed_chat_title):"",username:link.claimed_username});
    }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e;}
    finally{tx.release();}
  }));
  router.patch("/preferences",guard(async(req,res)=>{
    const t=tenant(req);
    if(!permittedTenant(t))return res.status(403).json({error:"INVALID_TENANT"});
    const body=req.body||{};
    const allowed=["digest_enabled","immediate_alert","recovery_alert","node_warning","rank_report"];
    const keys=["tenant"],values=[t],updates=[];
    for(const key of allowed){
      if(!Object.prototype.hasOwnProperty.call(body,key))continue;
      if(typeof body[key]!=="boolean")return res.status(400).json({error:"INVALID_PREFERENCES"});
      keys.push(key);values.push(body[key]);updates.push(key+"=EXCLUDED."+key);
    }
    if(Object.prototype.hasOwnProperty.call(body,"interval_minutes")){
      const minutes=Number(body.interval_minutes);
      if(!Number.isInteger(minutes)||!VALID_INTERVALS.has(minutes))
        return res.status(400).json({error:"INVALID_INTERVAL"});
      keys.push("interval_minutes");values.push(minutes);
      updates.push("interval_minutes=EXCLUDED.interval_minutes");
      updates.push("next_report_at=NOW()+(EXCLUDED.interval_minutes*INTERVAL '1 minute')");
    }
    if(!updates.length)return res.status(400).json({error:"EMPTY_PREFERENCES"});
    // Save preferences before a group is provisioned. The new row remains
    // disconnected, disabled, and without a chat_id; it cannot send messages.
    // A later verified permanent group binding preserves all preferences.
    const placeholders=values.map((_,i)=>"$"+(i+1));
    const {rows}=await db.query(
      "INSERT INTO telegram_hub_connections("+keys.join(",")+",enabled,status) "+
      "VALUES("+placeholders.join(",")+",FALSE,'disconnected') "+
      "ON CONFLICT(tenant) DO UPDATE SET "+updates.join(",")+",updated_at=NOW() "+
      "RETURNING tenant,status,chat_id,enabled",values
    );
    const record=rows[0];
    return res.json({ok:true,saved:true,
      delivery_active:record?.status==="connected"&&record?.enabled===true&&Boolean(record?.chat_id)});
  }));
  router.post("/pause",guard(async(req,res)=>{
    const {rows}=await db.query("UPDATE telegram_hub_connections SET enabled=FALSE,status='paused',updated_at=NOW() "+
      "WHERE tenant=$1 AND status='connected' RETURNING tenant",[tenant(req)]);
    if(!rows.length)return res.status(409).json({error:"TELEGRAM_NOT_CONNECTED"});
    await db.query("UPDATE app_settings SET value=$2,updated_at=NOW() WHERE key=$1",
      ["merchant_telegram_"+tenant(req),JSON.stringify({enabled:false,chat_id:""})]);
    return res.json({ok:true,status:"paused"});
  }));
  router.post("/resume",guard(async(req,res)=>{
    const {rows}=await db.query("UPDATE telegram_hub_connections SET enabled=TRUE,status='connected',updated_at=NOW() "+
      "WHERE tenant=$1 AND status='paused' AND chat_id IS NOT NULL RETURNING chat_id",[tenant(req)]);
    if(!rows.length)return res.status(409).json({error:"TELEGRAM_RECONNECT_REQUIRED"});
    await db.query("INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) "+
      "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
      ["merchant_telegram_"+tenant(req),JSON.stringify({enabled:true,chat_id:rows[0].chat_id})]);
    return res.json({ok:true,status:"connected"});
  }));
  router.post("/disconnect",guard(async(req,res)=>{
    return res.status(409).json({error:"PERMANENT_GROUP_CANNOT_BE_DISCONNECTED_BY_MERCHANT"});
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");
      await tx.query("UPDATE telegram_hub_connections SET enabled=FALSE,status='disconnected',chat_id=NULL,"+
        "telegram_user_id=NULL,telegram_username=NULL,chat_type=NULL,updated_at=NOW() WHERE tenant=$1",[tenant(req)]);
      await tx.query("DELETE FROM telegram_hub_links WHERE tenant=$1",[tenant(req)]);
      await tx.query("UPDATE telegram_hub_report_outbox SET status='cancelled',updated_at=NOW() "+
        "WHERE tenant=$1 AND status IN('pending','retry')",[tenant(req)]);
      await tx.query("INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) "+
        "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
        ["merchant_telegram_"+tenant(req),JSON.stringify({enabled:false,chat_id:""})]);
      await tx.query("COMMIT");
      return res.json({ok:true,status:"disconnected"});
    }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e;}finally{tx.release();}
  }));
  router.post("/test",guard(async(req,res)=>{
    const {rows}=await db.query(
      "SELECT c.chat_id FROM telegram_hub_connections c "+
      "JOIN telegram_merchant_groups g ON g.tenant=c.tenant AND g.chat_id=c.chat_id "+
      "WHERE c.tenant=$1 AND c.enabled=TRUE AND c.status='connected'",
      [tenant(req)]
    );
    if(!rows.length)return res.status(409).json({error:"TELEGRAM_NOT_CONNECTED"});
    try{
      await tg("sendMessage",{chat_id:rows[0].chat_id,text:"Pentagon Telegram Hub: koneksi merchant terverifikasi. Report otomatis aktif."});
      await db.query("UPDATE telegram_hub_connections SET last_delivery_at=NOW(),last_delivery_status='sent' WHERE tenant=$1",[tenant(req)]);
      return res.json({ok:true,sent:true});
    }catch(e){return res.status(502).json({error:"TELEGRAM_SEND_FAILED"});}
  }));
  router.post("/report/send-now",guard(async(req,res)=>{
    const {queueMerchantReport}=require("./telegramHubReports");
    const n=await queueMerchantReport(tenant(req),db,{force:true});
    return n>0?res.status(202).json({ok:true,queued:n}):res.status(409).json({error:"TELEGRAM_REPORT_NOT_AVAILABLE"});
  }));
  router.all("*",(req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  return router;
}

async function handleTelegramUpdate(update, db = pool) {
  // Never accept old one-time /start or /startgroup claims as group routing.
  return;
  const msg=update?.message;
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;
  const match=String(msg.text||"").trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+pt_([A-Za-z0-9_-]{20,50})$/i);
  if (!match) return;
  const type=String(msg.chat.type||"");
  const mode=type==="private"?"private":(["group","supergroup"].includes(type)?"group":"invalid");
  if(mode==="invalid")return;
  if(mode==="private"&&String(msg.from.id)!==String(msg.chat.id))return;
  if(mode==="group"&&String(msg.chat.id)===configuredOpsChatId()){
    // An internal operations forum contains other tenants' information.
    // Never allow it to be bound as a customer-facing report group.
    await tg("sendMessage",{chat_id:msg.chat.id,
      text:"Pentagon: this is the internal operations forum. Choose a private merchant report group instead."}).catch(()=>{});
    return;
  }
  if(mode==="group"){
    try{
      const member=await tg("getChatMember",{chat_id:msg.chat.id,user_id:msg.from.id});
      if(!["creator","administrator"].includes(member.status)){
        await tg("sendMessage",{chat_id:msg.chat.id,text:"Pentagon: hanya administrator grup dapat menghubungkan report."});
        return;
      }
    }catch(_){return;}
  }
  const {rows}=await db.query(
    "UPDATE telegram_hub_links SET claimed_at=NOW(),claimed_chat_id=$2,claimed_user_id=$3,"+
    "claimed_username=$4,claimed_chat_type=$5,claimed_chat_title=$7 "+
    "WHERE token_hash=$1 AND mode=$6 AND consumed_at IS NULL AND claimed_at IS NULL "+
    "AND expires_at>NOW() RETURNING request_id",
    [hashToken(match[1]),String(msg.chat.id),String(msg.from.id),
      safeUsername(msg.from.username)||"",type,mode,mode==="group"?safeGroupTitle(msg.chat.title):""]
  );
  await tg("sendMessage",{
    chat_id:msg.chat.id,
    text:rows.length
      ?(mode==="group"?"Pentagon: grup laporan diterima. Kembali ke dashboard dan konfirmasi grup ini untuk mengaktifkan report.":"Pentagon: akun Telegram diterima. Kembali ke dashboard dan konfirmasi untuk mengaktifkan report.")
      :"Pentagon: tautan tidak valid atau sudah kedaluwarsa. Buat tautan baru di dashboard."
  }).catch(()=>{});
}
function telegramHubWebhookRouter(db = pool) {
  const router=express.Router();
  router.post("/",async(req,res)=>{
    if(!verifyWebhookSecret(req.get("X-Telegram-Bot-Api-Secret-Token")))
      return res.status(403).json({error:"WEBHOOK_NOT_AUTHORIZED"});
    const update=req.body||{};
    if(!Number.isSafeInteger(update.update_id))return res.status(400).json({error:"INVALID_UPDATE"});
    try{
      await ensureTables(db);
      const inserted=await db.query(
        "INSERT INTO telegram_hub_webhook_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id",
        [update.update_id]
      );
      if(!inserted.rowCount)return res.json({ok:true,duplicate:true});
      if(update.message){
        const enrolled=await merchantActivation.confirmBotIdentity(update.message,db,{tg});
        if(enrolled){
          // Group may have been provisioned before the merchant verified their
          // identity. If so, enable its connection and send a direct invitation.
          const userId=String(update.message.from?.id||"");
          const {rows}=await db.query(
            "SELECT tenant FROM telegram_merchant_activations WHERE telegram_user_id=$1 AND verified_at IS NOT NULL",
            [userId]
          );
          if(rows[0])await merchantAutoGroups.activateAfterIdentity(rows[0].tenant,db,{tg});
        }else{
          const handled=await permanentGroups.handlePermanentGroupBind(update.message,db,
            {tg,opsChatId:configuredOpsChatId()});
          if(!handled)await handleTelegramUpdate(update,db);
        }
      }
      else if(update.callback_query){
        const cb=update.callback_query;
        const parts=String(cb.data||"").split(":");
        if(parts[0]==="noticed"&&/^[0-9]{1,10}$/.test(parts[1]||"")&&parts[2]==="blocked"){
          await markAcknowledged(Number(parts[1]),cb.from||{});
          await clearRecurringAlert(Number(parts[1])).catch(()=>{});
          await answerCallbackQuery(cb.id,"Noticed");
          if(cb.message?.chat?.id&&cb.message?.message_id)
            await editMessageReplyMarkup(cb.message.chat.id,cb.message.message_id,{
              inline_keyboard:[[{text:"✅ Noticed",callback_data:"noticed_done"}]]
            });
        }
      }
      return res.json({ok:true});
    }catch(e){
      // Allow Telegram to retry failed updates without silently losing them.
      await db.query("DELETE FROM telegram_hub_webhook_updates WHERE update_id=$1",[update.update_id]).catch(()=>{});
      console.warn("[Telegram Hub] update processing failed",String(e.code||"RETRY").slice(0,32));
      return res.status(503).json({error:"UPDATE_RETRY"});
    }
  });
  return router;
}
async function startTelegramHub() {
  if(initialized||!hubEnabled())return;
  initialized=true;
  try{
    await ensureTables();
    await permanentGroups.ensurePermanentGroupTables();
    await botName();
    console.log("[Telegram Hub] bot identity:",botUsername);
    // Keep the existing @DomainRadarAi_Bot identity and all bound merchant
    // groups intact; rename only the Telegram-visible display name.
    try{
      const {ensureTelegramBotBrand}=require("./telegramHubBrand");
      const state=await ensureTelegramBotBrand(tg);
      console.log("[Telegram Hub] bot display name:",state.name,
        "verified_languages="+state.verified,"updated_languages="+state.updated);
    }catch(err){
      // Branding must never block the webhook, merchant reports, or alerts.
      console.warn("[Telegram Hub] bot display name update pending",
        String(err.code||"TELEGRAM_UNAVAILABLE").slice(0,40));
    }
    const url=String(process.env.TELEGRAM_HUB_WEBHOOK_BASE_URL||BASE_URL).replace(/\/+$/,"")+HUB_PATH;
    if(!/^https:\/\/[A-Za-z0-9.-]+\/api\/telegram\/hub\/webhook$/.test(url))
      throw Object.assign(new Error("WEBHOOK_URL_INVALID"),{code:"WEBHOOK_URL_INVALID"});
    await tg("setWebhook",{
      url,secret_token:webhookSecret(),allowed_updates:["message","callback_query"],
      drop_pending_updates:false,max_connections:10
    });
    console.log("[Telegram Hub] webhook registered, bot identity verified");
    opsChatId=await getOpsForum();
    if(opsChatId)console.log("[Telegram Hub] internal ops forum ready");
    else console.log("[Telegram Hub] internal ops forum requires existing forum and bot admin permissions");
    const {tickTelegramHub}=require("./telegramHubReports");
    if(!workerStarted){
      workerStarted=true;
      const run=()=>tickTelegramHub().catch(e=>console.warn("[Telegram Hub] report tick unavailable",String(e.code||"DB_UNAVAILABLE").slice(0,30)));
      const first=setTimeout(run,15000);first.unref?.();
      const timer=setInterval(run,60000);timer.unref?.();
      // Independent bounded merchant VPS rank scanner. The full legacy
      // scheduler remains off; scans run only for tenant-verified report groups.
      const {runMerchantRankScans}=require("./telegramMerchantRankScanner");
      const runRanks=()=>runMerchantRankScans().catch(e=>
        console.warn("[Merchant Rank Auto] unavailable",String(e.code||"SCAN_UNAVAILABLE").slice(0,36)));
      const firstRanks=setTimeout(runRanks,45000);firstRanks.unref?.();
      const rankTimer=setInterval(runRanks,300000);rankTimer.unref?.();
      merchantAutoGroups.startProvisioning({tg,opsChatId:configuredOpsChatId()});
    }
  }catch(e){
    initialized=false;
    console.warn("[Telegram Hub] initialization pending",String(e.code||"UNAVAILABLE").slice(0,40));
    const retry=setTimeout(()=>startTelegramHub().catch(()=>{}),60000);
    retry.unref?.();
  }
}
module.exports={
  createMerchantTelegramHubRouter,telegramHubWebhookRouter,startTelegramHub,
  ensureTables,ensureOpsTopic,verifyWebhookSecret,hashToken,permittedTenant,
  configResult,hubEnabled,botName,tg
};
