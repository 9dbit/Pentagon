"use strict";
const express=require("express");
const crypto=require("node:crypto");
const {pool}=require("./db");
const {requireMerchantAdmin}=require("./customerViewerAuth");
const {isProductionTenant}=require("./customerWhitelistSync");
const {groupForTenant,expectedTitle}=require("./telegramPermanentGroups");

const PREFIX="pma_";
const TOKEN_AGE_MINUTES=10;
let schemaReady=null;
const sha=value=>crypto.createHash("sha256").update(String(value)).digest("hex");
const safeName=value=>String(value||"").replace(/[^A-Za-z0-9_]/g,"").slice(0,32);
const validIdentity=value=>{
  const text=String(value||"").trim().replace(/^https:\/\/t\.me\//i,"").replace(/^@/,"");
  if(/^[0-9]{5,20}$/.test(text))return {kind:"id",value:text};
  if(/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(text)&&!/^joinchat$/i.test(text))
    return {kind:"username",value:text.toLowerCase()};
  return null;
};
function bridgeAvailable(){
  return Boolean(process.env.PENTAGON_TELEGRAM_MT_BRIDGE_URL &&
    process.env.PENTAGON_TELEGRAM_MT_BRIDGE_KEY);
}
async function ensureTables(db=pool){
  const create=async()=>{
    await db.query("CREATE TABLE IF NOT EXISTS telegram_merchant_activations ("+
      "tenant TEXT PRIMARY KEY,requester_email TEXT NOT NULL DEFAULT '',"+
      "token_hash CHAR(64) UNIQUE,token_expires_at TIMESTAMPTZ,"+
      "identity_hint TEXT,identity_hint_kind TEXT,"+
      "telegram_user_id TEXT,telegram_username TEXT,verified_at TIMESTAMPTZ,"+
      "group_state TEXT NOT NULL DEFAULT 'queued' "+
      "CHECK(group_state IN ('queued','creating','securing','ready','retry','needs_provisioner')),"+
      "created_group_chat_id TEXT,group_error TEXT NOT NULL DEFAULT '',"+
      "group_attempts INTEGER NOT NULL DEFAULT 0,"+
      "next_provision_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"+
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"+
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_activation_user_unique "+
      "ON telegram_merchant_activations(telegram_user_id) WHERE telegram_user_id IS NOT NULL");
    await db.query("CREATE INDEX IF NOT EXISTS idx_tg_activation_due "+
      "ON telegram_merchant_activations(group_state,next_provision_at)");
    await db.query("ALTER TABLE telegram_merchant_activations ENABLE ROW LEVEL SECURITY");
    await db.query("REVOKE ALL ON TABLE telegram_merchant_activations FROM PUBLIC");
    for(const name of ["anon","authenticated"]){
      const found=await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[name]);
      if(found.rows.length)await db.query("REVOKE ALL ON TABLE telegram_merchant_activations FROM "+name);
    }
  };
  if(db!==pool)return create();
  if(!schemaReady)schemaReady=create().catch(err=>{schemaReady=null;throw err;});
  return schemaReady;
}
async function prepareMerchantTenant(tenant,requesterEmail="",db=pool){
  if(!isProductionTenant(tenant))return false;
  await ensureTables(db);
  await db.query(
    "INSERT INTO telegram_merchant_activations(tenant,requester_email) VALUES($1,$2) "+
    "ON CONFLICT(tenant) DO NOTHING",[tenant,String(requesterEmail||"").slice(0,254)]
  );
  // Bootstrap must not alter a previously bound group or merchant's
  // verified Telegram identity. It only prepares a durable onboarding job.
  return true;
}
function createActivationRouter(db=pool,{botName,tg}={}){
  const router=express.Router();
  router.use(requireMerchantAdmin);
  router.use((_req,res,next)=>{res.set("Cache-Control","private, no-store");next();});
  const guarded=fn=>async(req,res)=>{
    const tenant=req.merchantTenant;
    if(!isProductionTenant(tenant))return res.status(403).json({error:"INVALID_MERCHANT"});
    try{
      await prepareMerchantTenant(tenant,req.session.adminEmail,db);
      return await fn(req,res,tenant);
    }catch(e){
      console.warn("[Telegram Merchant Activation] unavailable",String(e.code||"UNAVAILABLE").slice(0,30));
      return res.status(503).json({error:"ACTIVATION_UNAVAILABLE"});
    }
  };
  router.get("/status",guarded(async(req,res,tenant)=>{
    const [record,group]=await Promise.all([
      db.query("SELECT tenant,identity_hint,identity_hint_kind,telegram_user_id,telegram_username,"+
        "verified_at,group_state,group_error,created_group_chat_id,updated_at "+
        "FROM telegram_merchant_activations WHERE tenant=$1",[tenant]),
      groupForTenant(tenant,db)
    ]);
    const row=record.rows[0]||{};
    res.json({tenant,group_title:expectedTitle(tenant),
      group_ready:Boolean(group),
      group_state:group?"ready":row.group_state||"queued",
      group_error:row.group_error||"",
      identity_verified:Boolean(row.verified_at&&row.telegram_user_id),
      telegram_username:row.telegram_username||"",
      telegram_user_id_masked:row.telegram_user_id?
        "••••"+row.telegram_user_id.slice(-4):"",
      identity_hint:row.identity_hint||"",
      provisioner_configured:bridgeAvailable(),
      updated_at:row.updated_at||null});
  }));
  router.post("/activate",guarded(async(req,res,tenant)=>{
    const username=typeof botName==="function"?await botName():"";
    if(!/^[A-Za-z0-9_]{5,32}$/.test(String(username||"")))
      return res.status(503).json({error:"TELEGRAM_BOT_NOT_READY"});
    const raw=crypto.randomBytes(24).toString("base64url");
    await db.query(
      "UPDATE telegram_merchant_activations SET token_hash=$2,"+
      "token_expires_at=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE tenant=$1",
      [tenant,sha(raw)]
    );
    return res.status(201).json({tenant,expires_in_seconds:TOKEN_AGE_MINUTES*60,
      url:"https://t.me/"+username+"?start="+PREFIX+raw});
  }));
  router.post("/identity-hint",guarded(async(req,res,tenant)=>{
    const parsed=validIdentity(req.body?.identity);
    if(!parsed)return res.status(400).json({error:"INVALID_TELEGRAM_IDENTITY"});
    const result=await db.query(
      "UPDATE telegram_merchant_activations SET identity_hint=$2,identity_hint_kind=$3,"+
      "updated_at=NOW() WHERE tenant=$1 AND verified_at IS NULL RETURNING tenant",
      [tenant,parsed.value,parsed.kind]
    );
    if(!result.rows.length)return res.status(409).json({error:"TELEGRAM_IDENTITY_ALREADY_VERIFIED"});
    return res.json({ok:true,identity_hint:parsed.value,verified:false,
      message:"Identity hint saved. Telegram confirmation is still required."});
  }));
  router.get("/deliveries",guarded(async(req,res,tenant)=>{
    const {rows}=await db.query(
      "SELECT kind,status,attempts,created_at,sent_at,last_error_code FROM ("+
      "SELECT kind,status,attempts,created_at,sent_at,last_error_code "+
      "FROM telegram_hub_report_outbox WHERE tenant=$1 "+
      "UNION ALL "+
      "SELECT 'tp_'||o.event_type AS kind,o.status,o.attempts,o.created_at,"+
      "o.sent_at,o.last_error_code FROM trustpositif_notification_outbox o "+
      "JOIN domains d ON d.id=o.domain_id WHERE d.tenant=$1"+
      ") events ORDER BY created_at DESC LIMIT 30",[tenant]
    );
    res.json({tenant,deliveries:rows});
  }));
  return router;
}
async function confirmBotIdentity(message,db=pool,{tg,opsChatId}={}){
  const match=String(message?.text||"").trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+pma_([A-Za-z0-9_-]{32})$/);
  if(!match)return false;
  if(message?.chat?.type!=="private"||String(message.from?.id||"")!==String(message.chat?.id||""))
    return true;
  const telegramId=String(message.from.id||"");
  if(!/^[0-9]{5,20}$/.test(telegramId))return true;
  await ensureTables(db);
  const tx=await db.connect();
  let tenant=null,verified=false;
  try{
    await tx.query("BEGIN");
    const {rows}=await tx.query(
      "SELECT tenant,identity_hint,identity_hint_kind,verified_at,telegram_user_id "+
      "FROM telegram_merchant_activations WHERE token_hash=$1 "+
      "AND token_expires_at>NOW() FOR UPDATE",[sha(match[1])]
    );
    const row=rows[0];
    if(!row){
      await tx.query("ROLLBACK");
      if(tg)await tg("sendMessage",{chat_id:telegramId,text:"Pentagon: activation QR expired. Generate a new QR from your merchant dashboard."}).catch(()=>{});
      return true;
    }
    const realUsername=safeName(message.from?.username).toLowerCase();
    if(row.identity_hint && (
      (row.identity_hint_kind==="id" && row.identity_hint!==telegramId) ||
      (row.identity_hint_kind==="username" && row.identity_hint!==realUsername)
    )){
      await tx.query("ROLLBACK");
      if(tg)await tg("sendMessage",{chat_id:telegramId,text:"Pentagon: Telegram identity does not match the one provided on the merchant dashboard."}).catch(()=>{});
      return true;
    }
    if(row.verified_at && row.telegram_user_id!==telegramId){
      await tx.query("ROLLBACK");
      return true;
    }
    tenant=row.tenant;
    const duplicate=await tx.query(
      "SELECT tenant FROM telegram_merchant_activations "+
      "WHERE telegram_user_id=$1 AND tenant<>$2 LIMIT 1",[telegramId,tenant]
    );
    if(duplicate.rows.length){await tx.query("ROLLBACK");return true;}
    await tx.query(
      "UPDATE telegram_merchant_activations SET verified_at=NOW(),"+
      "telegram_user_id=$2,telegram_username=$3,token_hash=NULL,"+
      "token_expires_at=NULL,updated_at=NOW() WHERE tenant=$1",
      [tenant,telegramId,realUsername]
    );
    await tx.query("COMMIT");verified=true;
  }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e;}
  finally{tx.release();}
  if(verified){
    let msg="Pentagon: Telegram identity verified for "+tenant.toUpperCase()+
      ". Your private report group is assigned automatically by Pentagon.";
    if(!bridgeAvailable())msg+=" Group creation is pending service-account configuration.";
    if(tg)await tg("sendMessage",{chat_id:telegramId,text:msg}).catch(()=>{});
    // The worker checks the verified Telegram identity when preparing the
    // direct invite. No user can select a group or tenant via a bot command.
  }
  return true;
}
module.exports={
  ensureTables,prepareMerchantTenant,createActivationRouter,
  confirmBotIdentity,bridgeAvailable,validIdentity
};
