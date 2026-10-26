"use strict";

// A Telegram bot cannot create groups. Operations provisions a dedicated
// group once; authenticated merchants receive a direct, short-lived group
// invite QR, never a Telegram "choose a group" selector.
// A shared operations forum/topic is never a merchant group.
const express=require("express");
const crypto=require("node:crypto");
const {pool}=require("./db");
const {requireMerchantAdmin}=require("./customerViewerAuth");
const {isProductionTenant}=require("./customerWhitelistSync");

const SETUP_TTL_MIN=10;
const INVITE_TTL_SEC=600;
let ready=null;
function hash(v){return crypto.createHash("sha256").update(String(v)).digest("hex");}
function numericChatId(v){return /^-?[0-9]{5,20}$/.test(String(v||""));}
function expectedTitle(t){return "PENTAGON | "+String(t).toUpperCase()+" | REPORTS";}
function commandMatch(text){
  return String(text||"").trim().match(/^\/bindreport(?:@[A-Za-z0-9_]+)?\s+([a-z][a-z0-9_-]{0,63})\s+([A-Za-z0-9_-]{20,60})$/);
}
async function ensurePermanentGroupTables(db=pool){
  const exec=async()=>{
    await db.query("CREATE TABLE IF NOT EXISTS telegram_merchant_groups ("+
      "tenant TEXT PRIMARY KEY,chat_id TEXT NOT NULL UNIQUE,chat_title TEXT NOT NULL,"+
      "provisioned_by TEXT NOT NULL,verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await db.query("CREATE TABLE IF NOT EXISTS telegram_merchant_group_setup ("+
      "token_hash CHAR(64) PRIMARY KEY,tenant TEXT NOT NULL,requester_email TEXT NOT NULL,"+
      "expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,"+
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    for(const table of ["telegram_merchant_groups","telegram_merchant_group_setup"]){
      await db.query("ALTER TABLE "+table+" ENABLE ROW LEVEL SECURITY");
      await db.query("REVOKE ALL ON TABLE "+table+" FROM PUBLIC");
      for(const role of ["anon","authenticated"]){
        const r=await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role]);
        if(r.rows.length)await db.query("REVOKE ALL ON TABLE "+table+" FROM "+role);
      }
    }
  };
  if(db!==pool)return exec();
  if(!ready)ready=exec().catch(e=>{ready=null;throw e;});
  return ready;
}
async function groupForTenant(tenant,db=pool){
  await ensurePermanentGroupTables(db);
  const {rows}=await db.query(
    "SELECT tenant,chat_id,chat_title,verified_at FROM telegram_merchant_groups WHERE tenant=$1 LIMIT 1",[tenant]);
  return rows[0]||null;
}
function safeError(e){
  return String(e?.code||e?.message||"UNKNOWN").replace(/[^A-Za-z0-9_]/g,"").slice(0,60);
}
function createPermanentGroupAdminRouter(db=pool){
  const router=express.Router();
  router.use((req,res,next)=>{
    if(req.session?.isAdmin!==true||req.session?.isCustomerViewer===true||req.session?.isDemo===true)
      return res.status(403).json({error:"SUPER_ADMIN_REQUIRED"});
    res.set("Cache-Control","private, no-store");next();
  });
  router.get("/list",async(_req,res)=>{
    try{
      await ensurePermanentGroupTables(db);
      const {rows}=await db.query(
        "SELECT tenant,chat_title,verified_at FROM telegram_merchant_groups ORDER BY tenant LIMIT 500");
      res.json({groups:rows});
    }catch(e){res.status(503).json({error:"REPORT_GROUP_DIRECTORY_UNAVAILABLE"});}
  });
  router.post("/setup",async(req,res)=>{
    const tenant=String(req.body?.tenant||"").trim().toLowerCase();
    if(!isProductionTenant(tenant))return res.status(400).json({error:"INVALID_MERCHANT"});
    try{
      await ensurePermanentGroupTables(db);
      const existing=await groupForTenant(tenant,db);
      if(existing)return res.status(409).json({error:"MERCHANT_GROUP_PERMANENTLY_BOUND",chat_title:existing.chat_title});
      const found=await db.query(
        "SELECT EXISTS (SELECT 1 FROM domains WHERE tenant=$1 AND is_active=TRUE) OR "+
        "EXISTS (SELECT 1 FROM rank_keyword_groups WHERE tenant=$1 AND is_active=TRUE) AS exists",[tenant]);
      if(found.rows[0]?.exists!==true)return res.status(404).json({error:"MERCHANT_NOT_FOUND"});
      const secret=crypto.randomBytes(24).toString("base64url");
      const tx=await db.connect();
      try{
        await tx.query("BEGIN");
        await tx.query("DELETE FROM telegram_merchant_group_setup WHERE tenant=$1 AND used_at IS NULL",[tenant]);
        await tx.query("INSERT INTO telegram_merchant_group_setup(token_hash,tenant,requester_email,expires_at) "+
          "VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')",
          [hash(secret),tenant,String(req.session.adminEmail||"admin").slice(0,255)]);
        await tx.query("COMMIT");
      }catch(e){await tx.query("ROLLBACK").catch(()=>{});throw e;}finally{tx.release();}
      // This secret is available only to super admin; never log or store plaintext.
      res.status(201).json({tenant,expires_in_seconds:SETUP_TTL_MIN*60,
        title:expectedTitle(tenant),command:"/bindreport "+tenant+" "+secret});
    }catch(e){res.status(503).json({error:"REPORT_GROUP_SETUP_UNAVAILABLE"});}
  });
  return router;
}
async function handlePermanentGroupBind(msg,db=pool,{tg,opsChatId}={}){
  const matched=commandMatch(msg?.text);
  if(!matched)return false;
  const tenant=matched[1],secret=matched[2];
  // Keep untrusted commands silent except in genuine private groups.
  if(!isProductionTenant(tenant) || !["group","supergroup"].includes(msg?.chat?.type))return true;
  const chatId=String(msg.chat.id||"");
  const reply=async text=>{await tg("sendMessage",{chat_id:chatId,text}).catch(()=>{});};
  if(!numericChatId(chatId)||chatId===String(opsChatId||"")){
    await reply("Pentagon: internal operations forum is not a merchant report group.");return true;
  }
  await ensurePermanentGroupTables(db);
  const pending=await db.query(
    "SELECT 1 FROM telegram_merchant_group_setup WHERE token_hash=$1 AND tenant=$2 "+
    "AND used_at IS NULL AND expires_at>NOW() LIMIT 1",[hash(secret),tenant]);
  if(!pending.rows.length){await reply("Pentagon: setup token invalid or expired.");return true;}
  try{
    // Both the group and the bot's invite rights are verified via Telegram.
    const [chat,initiator,me]=await Promise.all([
      tg("getChat",{chat_id:chatId}),
      tg("getChatMember",{chat_id:chatId,user_id:msg.from.id}),
      tg("getMe",{})
    ]);
    if(!["group","supergroup"].includes(String(chat?.type||""))||
       String(chat?.title||"")!==expectedTitle(tenant) ||
       !["administrator","creator"].includes(String(initiator?.status||""))){
      await reply("Pentagon: wrong group name or setup sender is not a group administrator. Required title: "+expectedTitle(tenant));
      return true;
    }
    const bot=await tg("getChatMember",{chat_id:chatId,user_id:me.id});
    if(!["administrator","creator"].includes(String(bot?.status||"")) ||
       (bot?.status==="administrator" && bot.can_invite_users!==true)){
      await reply("Pentagon: make this bot a group administrator with invite-user rights.");return true;
    }
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");
      const lock=await tx.query("SELECT tenant FROM telegram_merchant_group_setup WHERE tenant=$1 "+
        "AND token_hash=$2 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE",[tenant,hash(secret)]);
      if(!lock.rows.length){await tx.query("ROLLBACK");await reply("Pentagon: setup already used.");return true;}
      const duplicate=await tx.query("SELECT tenant FROM telegram_merchant_groups "+
        "WHERE tenant=$1 OR chat_id=$2 FOR UPDATE",[tenant,chatId]);
      const connected=await tx.query("SELECT chat_id FROM telegram_hub_connections "+
        "WHERE tenant=$1 FOR UPDATE",[tenant]);
      if(duplicate.rows.length || connected.rows.some(r=>r.chat_id)){
        await tx.query("ROLLBACK");await reply("Pentagon: group or merchant is already bound. No changes made.");return true;
      }
      await tx.query("INSERT INTO telegram_merchant_groups(tenant,chat_id,chat_title,provisioned_by) VALUES($1,$2,$3,$4)",
        [tenant,chatId,expectedTitle(tenant),String(msg.from.id)]);
      await tx.query("INSERT INTO telegram_hub_connections "+
        "(tenant,chat_id,telegram_user_id,telegram_username,chat_type,chat_title,enabled,status,connected_at,next_report_at) "+
        "VALUES($1,$2,$3,'',$4,$5,TRUE,'connected',NOW(),NOW()+INTERVAL '60 minutes') "+
        "ON CONFLICT(tenant) DO UPDATE SET chat_id=EXCLUDED.chat_id,telegram_user_id=EXCLUDED.telegram_user_id,"+
        "chat_type=EXCLUDED.chat_type,chat_title=EXCLUDED.chat_title,enabled=TRUE,status='connected',"+
        "connected_at=NOW(),next_report_at=NOW()+INTERVAL '60 minutes',updated_at=NOW()",
        [tenant,chatId,String(msg.from.id),chat.type,expectedTitle(tenant)]);
      await tx.query("UPDATE telegram_merchant_group_setup SET used_at=NOW() WHERE tenant=$1 AND token_hash=$2",
        [tenant,hash(secret)]);
      await tx.query("COMMIT");
      await reply("Pentagon: dedicated report group secured for "+tenant.toUpperCase()+". Merchant QR now opens this group directly.");
    }catch(e){
      await tx.query("ROLLBACK").catch(()=>{});
      await reply("Pentagon: registration failed. Group binding was not changed.");
    }finally{tx.release();}
  }catch(e){await reply("Pentagon: could not verify Telegram group administrator or bot permissions.");}
  return true;
}
function createPermanentGroupMerchantRouter(db=pool,{tg,opsChatId}={}){
  const router=express.Router();
  router.use(requireMerchantAdmin);
  router.use((_req,res,next)=>{res.set("Cache-Control","private, no-store");next();});
  router.post("/invite",async(req,res)=>{
    try{
      const tenant=req.merchantTenant;
      if(!isProductionTenant(tenant))return res.status(403).json({error:"INVALID_MERCHANT"});
      const group=await groupForTenant(tenant,db);
      if(!group)return res.status(409).json({error:"PERMANENT_REPORT_GROUP_NOT_READY"});
      if(!numericChatId(group.chat_id)||String(group.chat_id)===String(opsChatId||""))
        return res.status(409).json({error:"REPORT_GROUP_CONFIGURATION_INVALID"});
      const verified=await db.query(
        "SELECT 1 FROM telegram_hub_connections WHERE tenant=$1 AND chat_id=$2 "+
        "AND status IN ('connected','paused') LIMIT 1",[tenant,group.chat_id]);
      if(!verified.rows.length)return res.status(409).json({error:"REPORT_GROUP_CONNECTION_MISMATCH"});
      const [chat,me]=await Promise.all([
        tg("getChat",{chat_id:group.chat_id}),tg("getMe",{})
      ]);
      if(!["group","supergroup"].includes(chat?.type) ||
         String(chat?.title||"")!==group.chat_title)
        return res.status(409).json({error:"REPORT_GROUP_IDENTITY_CHANGED"});
      const bot=await tg("getChatMember",{chat_id:group.chat_id,user_id:me.id});
      if(!["creator","administrator"].includes(bot?.status) ||
         (bot.status==="administrator" && bot.can_invite_users!==true))
        return res.status(409).json({error:"REPORT_GROUP_BOT_ADMIN_REQUIRED"});
      const expiresAt=Math.floor(Date.now()/1000)+INVITE_TTL_SEC;
      const invite=await tg("createChatInviteLink",{chat_id:group.chat_id,
        name:("Pentagon "+tenant+" report").slice(0,32),
        expire_date:expiresAt,member_limit:1});
      if(!/^https:\/\/t\.me\/\+?[A-Za-z0-9_-]+$/.test(String(invite?.invite_link||"")) &&
         !/^https:\/\/t\.me\/joinchat\/[A-Za-z0-9_-]+$/.test(String(invite?.invite_link||"")))
        return res.status(502).json({error:"REPORT_GROUP_INVITE_UNAVAILABLE"});
      res.status(201).json({url:invite.invite_link,group_title:group.chat_title,
        expires_in_seconds:INVITE_TTL_SEC});
    }catch(e){
      console.warn("[Permanent Telegram Group] invite unavailable",safeError(e));
      res.status(503).json({error:"REPORT_GROUP_INVITE_UNAVAILABLE"});
    }
  });
  return router;
}
module.exports={
  expectedTitle,commandMatch,ensurePermanentGroupTables,groupForTenant,
  createPermanentGroupAdminRouter,createPermanentGroupMerchantRouter,handlePermanentGroupBind
};
