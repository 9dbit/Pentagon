"use strict";

// Bounded, VPS-only merchant scan companion to the Telegram report engine.
// No fake carrier-specific rank positions: those are used only when backed
// by genuine node-tagged snapshots. Never enable the legacy full scheduler.
const {pool}=require("./db");
const {checkGroup}=require("./rankRoutes");
const LOCK_ID=80723161;
const MAX_GROUPS=3;
const SCAN_PAGES=2;
const MIN_SCAN_MINUTES=60;
const RETRY_COOLDOWN_MS=30*60000;
const lastFailure=new Map();
let running=false;

function available(){
  return Boolean(process.env.SERPER_API_KEY ||
    (process.env.GOOGLE_SEARCH_API_KEY&&process.env.GOOGLE_SEARCH_CX));
}
async function runMerchantRankScans(db=pool,options={}) {
  if(running)return {status:"already_running",scanned:0};
  if(String(process.env.MERCHANT_RANK_AUTO_SCAN_ENABLED||"true").toLowerCase()==="false")
    return {status:"disabled",scanned:0};
  if(!options.checkGroup&&!available())return {status:"search_provider_missing",scanned:0};
  running=true;
  let client=null,locked=false;
  try{
    client=await db.connect();
    const {rows:lock}=await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",[LOCK_ID]);
    if(lock[0]?.acquired!==true)return {status:"already_running_elsewhere",scanned:0};
    locked=true;
    const {rows:groups}=await client.query([
      "SELECT g.id,g.keyword,g.project_name,g.tenant,g.last_checked_at",
      "FROM rank_keyword_groups g",
      "JOIN telegram_hub_connections c ON c.tenant=g.tenant",
      "JOIN telegram_merchant_groups m ON m.tenant=c.tenant AND m.chat_id=c.chat_id",
      "WHERE g.is_active=TRUE AND c.enabled=TRUE AND c.status='connected'",
      "AND c.rank_report=TRUE",
      "AND (g.last_checked_at IS NULL OR",
      "g.last_checked_at<=NOW()-(GREATEST($1::int,",
      "LEAST(1440,c.interval_minutes))*INTERVAL '1 minute'))",
      "AND EXISTS(SELECT 1 FROM rank_keyword_domains k",
      "JOIN domains d ON d.tenant=g.tenant AND d.is_active=TRUE",
      "AND LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain))",
      "WHERE k.group_id=g.id AND k.is_whitelisted=TRUE)",
      "ORDER BY g.last_checked_at NULLS FIRST,g.id LIMIT $2"
    ].join(" "),[MIN_SCAN_MINUTES,MAX_GROUPS]);
    let scanned=0,failed=0,skipped=0;
    for(const group of groups) {
      const last=lastFailure.get(group.id)||0;
      if(Date.now()-last<RETRY_COOLDOWN_MS){skipped++;continue;}
      try{
        // Save only real VPS SERP snapshots, maximum 20 positions per keyword.
        // checkGroup already writes rank_scan_results and latest VPS position.
        await (options.checkGroup||checkGroup)(group,null,null,{maxPages:SCAN_PAGES});
        lastFailure.delete(group.id);
        scanned++;
      }catch(e){
        failed++;lastFailure.set(group.id,Date.now());
        console.warn("[Merchant Rank Auto] scan failed, group_id="+group.id+
          " code="+String(e.code||"SCAN_UNAVAILABLE").slice(0,36));
      }
    }
    if(scanned||failed)console.log("[Merchant Rank Auto] VPS groups="+scanned+
      " failed="+failed+" skipped="+skipped);
    return {status:failed?"partial":"complete",scanned,failed,skipped};
  }finally{
    if(client){
      if(locked)await client.query("SELECT pg_advisory_unlock($1::bigint)",[LOCK_ID]).catch(()=>{});
      client.release();
    }
    running=false;
  }
}
module.exports={runMerchantRankScans,available};
