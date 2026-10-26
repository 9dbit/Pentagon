"use strict";

// Durable per-tenant whitelist digests. Never send a report without a
// dashboard-confirmed Telegram connection. No cross-tenant joins are allowed.
const { pool } = require("./db");
const { ensureTables, hubEnabled, tg } = require("./telegramHub");
let ticking = false;

function esc(x) {
  return String(x == null ? "" : x).replace(/&/g,"&amp;")
    .replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function wib(ts) {
  if(!ts) return "Never";
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime()))return "Unknown";
  return d.toLocaleString("id-ID",{timeZone:"Asia/Jakarta",day:"2-digit",
    month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})+" WIB";
}
function domainStatus(r, nowMs = Date.now()) {
  const at = r.last_checked_at ? new Date(r.last_checked_at).getTime() : NaN;
  if(!Number.isFinite(at))return "UNKNOWN (not checked)";
  if(nowMs - at > 24*3600000 || at > nowMs+300000)return "STALE";
  switch(String(r.global_status||"").toLowerCase()){
    case "working":return "Working";
    case "warning":return "Warning";
    case "blocked":return "Blocked / review";
    default:return "Unknown";
  }
}
function buildReportPages(tenant, rows, now = new Date()) {
  const counts={working:0,warning:0,blocked:0,stale:0,unknown:0};
  const normalized=rows.map(row=>{
    const status=domainStatus(row,now.getTime());
    if(status==="Working")counts.working++;
    else if(status==="Warning")counts.warning++;
    else if(status==="Blocked / review")counts.blocked++;
    else if(status==="STALE")counts.stale++;
    else counts.unknown++;
    return {...row,status};
  });
  const header=[
    "<b>PENTAGON MERCHANT REPORT</b>",
    "<b>Merchant:</b> "+esc(tenant),
    "<b>Time:</b> "+esc(wib(now)),
    "<b>Whitelist:</b> "+normalized.length,
    "<b>Working:</b> "+counts.working+
      " | <b>Warning:</b> "+counts.warning+
      " | <b>Blocked/review:</b> "+counts.blocked,
    "<b>Stale:</b> "+counts.stale+" | <b>Unknown:</b> "+counts.unknown,
    "",
    "<b>WHITELISTED DOMAINS</b>"
  ].join("\n");
  const footer="\n\n<i>Unknown/stale does not mean safe. Official BLOCKED requires independent providers and an exact TrustPositif match. Direct HTTP is not registry evidence.</i>";
  const pages=[];
  let body="";
  for(const row of normalized){
    const line=esc(row.domain)+" — "+esc(row.status)+
      " · "+esc(wib(row.last_checked_at))+"\n";
    if((header.length+body.length+line.length+footer.length)>3400&&body){
      pages.push(header+"\n"+body+footer);
      body="";
    }
    body+=line;
  }
  if(!normalized.length)body="\nNo active whitelisted domains are registered for this merchant.";
  pages.push(header+"\n"+body+footer);
  return pages.map((message,i)=>pages.length>1
    ?"<b>Part "+(i+1)+" / "+pages.length+"</b>\n"+message
    :message);
}
async function whitelistForTenant(tenant, db=pool) {
  const q = [
    "SELECT DISTINCT ON (LOWER(TRIM(k.domain))) LOWER(TRIM(k.domain)) AS domain,",
    "d.global_status,d.last_checked_at FROM rank_keyword_domains k",
    "JOIN rank_keyword_groups g ON g.id=k.group_id",
    "JOIN domains d ON LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)) AND d.tenant=g.tenant",
    "WHERE g.tenant=$1 AND g.is_active=TRUE AND k.is_whitelisted=TRUE AND d.is_active=TRUE",
    "ORDER BY LOWER(TRIM(k.domain)),d.last_checked_at DESC NULLS LAST"
  ].join(" ");
  return (await db.query(q,[tenant])).rows;
}
async function queueMerchantReport(tenant, db=pool, options={}) {
  if(!hubEnabled())return 0;
  await ensureTables(db);
  const tx=await db.connect();
  try {
    await tx.query("BEGIN");
    const {rows}=await tx.query(
      "SELECT tenant,chat_id,interval_minutes,next_report_at "+
      "FROM telegram_hub_connections c "+
      "JOIN telegram_merchant_groups g ON g.tenant=c.tenant AND g.chat_id=c.chat_id "+
      "WHERE c.tenant=$1 AND c.enabled=TRUE "+
      "AND c.status='connected' AND c.digest_enabled=TRUE AND c.chat_id IS NOT NULL FOR UPDATE OF c",
      [tenant]
    );
    const conn=rows[0];
    if(!conn){
      await tx.query("ROLLBACK");return 0;
    }
    if(!options.force&&new Date(conn.next_report_at).getTime()>Date.now()){
      await tx.query("ROLLBACK");return 0;
    }
    // Explicit Send Now is rate limited, including failed/pending sends.
    if(options.force){
      const recent=await tx.query("SELECT id FROM telegram_hub_report_outbox "+
        "WHERE tenant=$1 AND kind='digest' AND created_at>NOW()-INTERVAL '60 seconds' LIMIT 1",[tenant]);
      if(recent.rows.length){
        await tx.query("ROLLBACK");return 0;
      }
    }
    const reportRows=await whitelistForTenant(tenant,tx);
    const pages=buildReportPages(tenant,reportRows,new Date());
    for(const message of pages){
      await tx.query(
        "INSERT INTO telegram_hub_report_outbox(tenant,chat_id,kind,message) "+
        "VALUES($1,$2,'digest',$3)",
        [tenant,conn.chat_id,message]
      );
    }
    await tx.query("UPDATE telegram_hub_connections SET next_report_at=NOW()+($2::int*INTERVAL '1 minute'),"+
      "updated_at=NOW() WHERE tenant=$1",[tenant,conn.interval_minutes]);
    await tx.query("COMMIT");
    return pages.length;
  }catch(err){await tx.query("ROLLBACK").catch(()=>{});throw err;}
  finally{tx.release();}
}
function classifyTelegramError(err,attempts) {
  const code=String(err?.code||"UNKNOWN").replace(/[^a-zA-Z0-9_]/g,"").slice(0,36);
  if(code==="TELEGRAM_HTTP_429"||["ENOTFOUND","EAI_AGAIN","ENETUNREACH","ECONNREFUSED"].includes(code))
    return {status:attempts>=6?"failed":"retry",code};
  if(/^TELEGRAM_HTTP_5/.test(code))return {status:"uncertain",code:"HTTP_5XX_AMBIGUOUS"};
  if(/^TELEGRAM_HTTP_4/.test(code))return {status:"failed",code};
  return {status:"uncertain",code:"NETWORK_AMBIGUOUS"};
}
async function drainReportOutbox(db=pool,limit=3) {
  await ensureTables(db);
  const {rows}=await db.query(
    "WITH chosen AS (SELECT id FROM telegram_hub_report_outbox "+
    "WHERE status IN ('pending','retry') AND next_attempt_at<=NOW() "+
    "ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1) "+
    "UPDATE telegram_hub_report_outbox o SET status='sending',attempts=attempts+1,"+
    "claimed_at=NOW(),updated_at=NOW() FROM chosen WHERE o.id=chosen.id RETURNING o.*",
    [Math.max(1,Math.min(10,Number(limit)||3))]
  );
  for(const row of rows) {
    let result={status:"cancelled",code:"DESTINATION_NOT_CONNECTED"};
    const {rows:connections}=await db.query(
      "SELECT c.chat_id FROM telegram_hub_connections c "+
      "JOIN telegram_merchant_groups g ON g.tenant=c.tenant AND g.chat_id=c.chat_id "+
      "WHERE c.tenant=$1 AND c.enabled=TRUE AND c.status='connected' "+
      "AND c.chat_id=$2 LIMIT 1",
      [row.tenant,row.chat_id]
    );
    if(connections.length){
      try{
        await tg("sendMessage",{
          chat_id:row.chat_id,text:row.message,
          parse_mode:"HTML",disable_web_page_preview:true
        },12000);
        result={status:"sent",code:""};
      }catch(e){result=classifyTelegramError(e,row.attempts);}
    }
    const delay=Math.min(3600,60*Math.pow(2,Math.min(6,row.attempts)));
    await db.query("UPDATE telegram_hub_report_outbox "+
      "SET status=$2,last_error_code=$3,updated_at=NOW(),"+
      "next_attempt_at=CASE WHEN $2='retry' THEN NOW()+($4::int*INTERVAL '1 second') ELSE next_attempt_at END,"+
      "sent_at=CASE WHEN $2='sent' THEN NOW() ELSE sent_at END "+
      "WHERE id=$1 AND status='sending'",
      [row.id,result.status,result.code,delay]
    );
    await db.query("UPDATE telegram_hub_connections "+
      "SET last_report_at=CASE WHEN $3='sent' THEN NOW() ELSE last_report_at END,"+
      "last_delivery_at=NOW(),last_delivery_status=$3,updated_at=NOW() "+
      "WHERE tenant=$1 AND chat_id=$2",
      [row.tenant,row.chat_id,result.status]
    );
    // Internal forum copies only after successful merchant delivery; topics
    // are staff-only and must never be used as the merchant destination.
    if(result.status==="sent"){
      const ops=await db.query("SELECT chat_id,message_thread_id FROM telegram_hub_ops_topics "+
        "WHERE tenant=$1 AND status='ready' AND message_thread_id IS NOT NULL LIMIT 1",[row.tenant]);
      if(ops.rows[0]){
        await tg("sendMessage",{chat_id:ops.rows[0].chat_id,
          message_thread_id:Number(ops.rows[0].message_thread_id),
          text:row.message,parse_mode:"HTML",disable_web_page_preview:true}).catch(()=>{});
      }
    }
  }
  return {claimed:rows.length};
}
async function tickTelegramHub(db=pool) {
  if(ticking||!hubEnabled())return {skipped:true};
  ticking=true;
  try{
    await ensureTables(db);
    const {rows}=await db.query(
      "SELECT c.tenant FROM telegram_hub_connections c "+
      "JOIN telegram_merchant_groups g ON g.tenant=c.tenant AND g.chat_id=c.chat_id "+
      "WHERE c.enabled=TRUE AND c.status='connected' AND c.digest_enabled=TRUE "+
      "AND c.next_report_at<=NOW() ORDER BY c.next_report_at LIMIT 5"
    );
    let queued=0;
    for(const row of rows){
      queued+=await queueMerchantReport(row.tenant,db);
    }
    const sent=await drainReportOutbox(db,4);
    if(queued||sent.claimed)console.log("[Telegram Hub] digest queued="+queued+" processed="+sent.claimed);
    return {queued,processed:sent.claimed};
  }finally{ticking=false;}
}
module.exports={
  buildReportPages,domainStatus,whitelistForTenant,
  queueMerchantReport,drainReportOutbox,tickTelegramHub
};
