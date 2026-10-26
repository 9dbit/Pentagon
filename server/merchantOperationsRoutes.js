"use strict";

const express = require("express");
const axios = require("axios");
const { pool } = require("./db");
const { getTelegramConfig } = require("./telegram");
const { requireMerchantAdmin } = require("./customerViewerAuth");
const { checkDirectOwnedDomain } = require("./merchantDirectChecker");

// Mounted exclusively inside the tenant-guarded merchant router.
// No global platform secrets, device IDs or other tenant's domain results.
function createMerchantOperationsRouter(db = pool) {
  const router = express.Router();
  router.use(requireMerchantAdmin);
  router.use((_req,res,next)=>{res.set("Cache-Control","private, no-store");next();});
  const safe = fn=>async(req,res)=>{
    try { await fn(req,res); }
    catch(e) {
      console.warn("[Merchant Ops] failed",String(e.code||"UNAVAILABLE").slice(0,24));
      res.status(503).json({error:"MERCHANT_OPERATIONS_UNAVAILABLE"});
    }
  };
  const own = req=>req.merchantTenant;
  const settingsKey = req=>"merchant_telegram_"+own(req);
  async function getTelegram(req) {
    const {rows} = await db.query("SELECT value FROM app_settings WHERE key=$1 LIMIT 1",[settingsKey(req)]);
    if (!rows[0]?.value) return {enabled:false,chat_id:""};
    try {
      const v=JSON.parse(rows[0].value);
      return {enabled:v.enabled===true,chat_id:/^-?[0-9]{5,20}$/.test(String(v.chat_id||""))?String(v.chat_id):""};
    } catch(_) {return {enabled:false,chat_id:""};}
  }
  router.get("/telegram",safe(async(req,res)=>{
    const x=await getTelegram(req);
    res.json({enabled:x.enabled,chat_id:x.chat_id,bot_configured:Boolean(getTelegramConfig().token)});
  }));
  router.patch("/telegram",safe(async(req,res)=>{
    // Reject arbitrary Chat IDs in the verified Hub. A Telegram /start claim
    // plus dashboard confirmation is required to select a recipient.
    if(process.env.TELEGRAM_HUB_ENABLED === "true")
      return res.status(410).json({error:"USE_VERIFIED_TELEGRAM_HUB"});
    const enabled=req.body?.enabled;
    const chat_id=String(req.body?.chat_id||"").trim();
    if(typeof enabled!=="boolean" || (chat_id && !/^-?[0-9]{5,20}$/.test(chat_id)) ||
       (enabled&&!chat_id)) return res.status(400).json({error:"INVALID_TELEGRAM_SETTINGS"});
    const config=JSON.stringify({enabled,chat_id});
    await db.query(
      "INSERT INTO app_settings(key,value,updated_at) VALUES ($1,$2,NOW()) "+
      "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
      [settingsKey(req),config]
    );
    return res.json({ok:true,enabled,chat_id});
  }));
  router.post("/telegram/test",safe(async(req,res)=>{
    if(process.env.TELEGRAM_HUB_ENABLED === "true")
      return res.status(410).json({error:"USE_VERIFIED_TELEGRAM_HUB"});
    const cfg=await getTelegram(req), {token}=getTelegramConfig();
    if(!cfg.enabled||!cfg.chat_id) return res.status(409).json({error:"MERCHANT_TELEGRAM_DISABLED"});
    if(!token) return res.status(503).json({error:"TELEGRAM_BOT_NOT_CONFIGURED"});
    try {
      await axios.post("https://api.telegram.org/bot"+token+"/sendMessage",{
        chat_id:cfg.chat_id,
        text:"Pentagon Merchant Monitoring: koneksi notifikasi untuk "+own(req)+" berhasil diuji.",
        disable_web_page_preview:true
      },{timeout:10000});
      return res.json({ok:true,sent:true});
    }catch(e){
      return res.status(502).json({error:"TELEGRAM_DELIVERY_FAILED",telegram_status:e.response?.status||null});
    }
  }));
  router.get("/trust-positif",safe(async(req,res)=>{
    const [domains,checks,coverage]=await Promise.all([
      db.query(
        "SELECT d.id,d.domain,d.global_status,d.is_active,d.last_checked_at, "+
        "COUNT(DISTINCT r.provider_name) FILTER (WHERE r.checked_at>=NOW()-INTERVAL '24 hours' "+
        "AND r.checker_type ILIKE '%node%')::int AS recent_node_providers, "+
        "MAX(r.checked_at) AS latest_evidence_at "+
        "FROM domains d LEFT JOIN check_results r ON r.domain_id=d.id "+
        "WHERE d.tenant=$1 GROUP BY d.id ORDER BY d.id DESC LIMIT 200",[own(req)]
      ),
      db.query(
        "SELECT provider_name,mode,ok,reason,created_at FROM trustpositif_checks "+
        "WHERE tenant IN ('admin',$1) ORDER BY created_at DESC LIMIT 15",[own(req)]
      ),
      db.query(
        "SELECT COUNT(*)::int AS total, "+
        "COUNT(*) FILTER(WHERE d.is_active)::int AS active "+
        "FROM domains d WHERE d.tenant=$1",[own(req)]
      )
    ]);
    res.json({
      official_source_checks:checks.rows.map(r=>({
        provider_name:String(r.provider_name||"Provider").slice(0,60),
        mode:String(r.mode||"unknown").slice(0,32),
        ok:r.ok===true,created_at:r.created_at,
        status:r.ok===true?"verified_source_reachable":"not_verified"
      })),
      domain_summary:coverage.rows[0]||{total:0,active:0},
      domains:domains.rows.map(d=>({
        domain:d.domain,global_status:d.global_status||"unknown",is_active:d.is_active,
        last_checked_at:d.last_checked_at,latest_evidence_at:d.latest_evidence_at,
        recent_node_providers:Number(d.recent_node_providers)||0,
        // Never assert blocked based solely on a stale single node.
        sufficient_independent_nodes:Number(d.recent_node_providers)>=2
      })),
      verification_notice:"Unknown is not safe; official source lookup and two independent checker providers required for confirmation."
    });
  }));
  const activeChecks=new Set();
  router.post("/direct-checker/run",safe(async(req,res)=>{
    const domain=String(req.body?.domain||"").trim().toLowerCase();
    if(!domain||domain.length>253) return res.status(400).json({error:"INVALID_DOMAIN"});
    const {rows}=await db.query(
      "SELECT id,domain FROM domains WHERE tenant=$1 AND domain=$2 AND is_active=TRUE LIMIT 1",
      [own(req),domain]
    );
    if(!rows.length) return res.status(404).json({error:"OWN_ACTIVE_DOMAIN_NOT_FOUND"});
    const id=rows[0].id;
    const lock=own(req)+":"+id;
    if(activeChecks.has(lock)) return res.status(429).json({error:"CHECK_ALREADY_RUNNING"});
    const latest=await db.query(
      "SELECT checked_at FROM check_results WHERE domain_id=$1 AND checker_type='direct' "+
      "ORDER BY checked_at DESC LIMIT 1",[id]
    );
    const age=latest.rows[0]?.checked_at ? Date.now()-new Date(latest.rows[0].checked_at).getTime():Infinity;
    if(age>=0&&age<60000) return res.status(429).json({error:"CHECK_RATE_LIMIT",retry_after_seconds:Math.ceil((60000-age)/1000)});
    activeChecks.add(lock);
    try {
      const data=await checkDirectOwnedDomain(domain);
      await db.query(
        "INSERT INTO check_results(domain_id,checker_type,provider_name,status,http_status,latency_ms,reason) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id,data.checker_type,data.provider_name,data.status,data.http_status,data.latency_ms,data.reason]
      );
      return res.json({ok:true,domain,status:data.status,http_status:data.http_status,
        latency_ms:data.latency_ms,checked_at:new Date().toISOString(),
        notice:"Direct HTTP availability only. Not an official Trust Positif result."});
    }catch(e){
      if(e.status) return res.status(e.status).json({error:String(e.message).slice(0,90)});
      throw e;
    }finally{activeChecks.delete(lock);}
  }));

  router.get("/direct-checker",safe(async(req,res)=>{
    const {rows}=await db.query(
      "SELECT d.domain,d.is_active,d.global_status, "+
      "r.checker_type,r.provider_name,r.status,r.http_status,r.latency_ms,r.checked_at "+
      "FROM domains d LEFT JOIN LATERAL "+
      "(SELECT checker_type,provider_name,status,http_status,latency_ms,checked_at "+
      "FROM check_results r WHERE r.domain_id=d.id "+
      "AND r.checker_type IN ('direct','http_direct','direct_check') "+
      "ORDER BY r.checked_at DESC LIMIT 1) r ON TRUE "+
      "WHERE d.tenant=$1 ORDER BY d.id DESC LIMIT 200",[own(req)]
    );
    res.json({
      source:"historic_direct_checker_results",
      last_checked_only:true,
      domains:rows.map(x=>({
        domain:x.domain,is_active:x.is_active,global_status:x.global_status,
        status:x.status||"not_checked",http_status:x.http_status,
        latency_ms:x.latency_ms,checked_at:x.checked_at
      }))
    });
  }));
  router.all("/telegram",(_req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  router.all("/telegram/test",(_req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  router.all("/trust-positif",(_req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  router.all("/direct-checker",(_req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  router.all("/direct-checker/run",(_req,res)=>res.status(405).json({error:"METHOD_NOT_ALLOWED"}));
  return router;
}

module.exports={createMerchantOperationsRouter};
