"use strict";

// Production policy: two genuine warning responses from DIFFERENT provider
// nodes are the trigger, never proof of ISP blocking. TRADEVICEPC's authenticated
// full Komdigi snapshot is the sole positive/negative registry authority.
// A negative registry match is not enough for NORMAL: two providers must
// each return HTTP-successful WORKING twice in consecutive scan cycles.
const {pool}=require("./db");
const {isProductionTenant}=require("./customerWhitelistSync");
const {canonicalRegistryDomain}=require("./trustpositifRegistrySync");

const POLICY="tradevicepc_triggered";
const MAX_SOURCE_AGE_MS=Math.max(15*60000,
  Math.min(24*3600000,Number(process.env.TRUSTPOSITIF_COLLECTOR_MAX_AGE_MS||21600000)));
const MAX_RECOVERY_GAP_MS=20*60000;
const MIN_RECOVERY_GAP_MS=30000;
const MIN_SNAPSHOT_BYTES=100000000;
const MIN_SNAPSHOT_ENTRIES=5000000;

function isAgentError(reason){
  return /node polling timeout|no response from device|polling node error|node error:|agent.*(?:error|offline|timeout)|invalid_or_missing_subscription|subscription.*missing|unauthorized node|unsupported task|task.*expired|node task.*timeout/i
    .test(String(reason||"").toLowerCase());
}
function distinctSignals(results=[],nodes=[],kind="warning"){
  const known=new Map(nodes.filter(x=>x?.is_active!==false).map(x=>[String(x.id),x]));
  const providers=new Set(),output=[];
  for(const r of results){
    if(!String(r?.checker_type||"").startsWith("node:"))continue;
    const node=known.get(String(r?.node_id ?? ""));
    if(!node || isAgentError(r.reason))continue;
    const provider=String(node.provider_name||"").trim();
    const key=provider.toLowerCase();
    if(!key || providers.has(key))continue;
    const status=String(r.status||"").toLowerCase();
    const http=Number(r.http_status);
    const isWarning=status==="warning" || status==="blocked";
    const isWorking=status==="working" && Number.isInteger(http) && http>=200 && http<400;
    if(kind==="warning" && !isWarning)continue;
    if(kind==="working" && !isWorking)continue;
    providers.add(key);
    output.push({id:node.id,name:String(node.name||"Node "+node.id),
      provider,status,reason:String(r.reason||"").slice(0,150)});
  }
  return output;
}
function verifiedCollectorEvidence(row,domain,now=new Date()){
  const t=row?.registry_checked_at?new Date(row.registry_checked_at).getTime():NaN;
  const age=now.getTime()-t;
  const digest=String(row?.registry_snapshot_sha256||"");
  const source=String(row?.registry_source||"");
  const canonical=canonicalRegistryDomain(domain);
  return Boolean(canonical &&
    row?.registry_collector==="TRADEVICEPC" &&
    row?.registry_lookup_domain===canonical &&
    (row?.registry_match_kind==="exact" || row?.registry_match_kind==="parent_apex" ||
      row?.registry_match_kind==="not_listed") &&
    /^([a-f0-9]{64})$/.test(digest) &&
    source.startsWith("komdigi-domains_isp-tradevicepc-sha256:"+digest.slice(0,32)) &&
    Number(row?.registry_snapshot_bytes)>=MIN_SNAPSHOT_BYTES &&
    Number(row?.registry_snapshot_entries)>=MIN_SNAPSHOT_ENTRIES &&
    typeof row.registry_listed==="boolean" &&
    Number.isFinite(age) && age>=-300000 && age<=MAX_SOURCE_AGE_MS);
}
function hasFreshTrigger(row,now=new Date()){
  const triggered=row?.registry_triggered_at?new Date(row.registry_triggered_at).getTime():NaN;
  const checked=row?.registry_checked_at?new Date(row.registry_checked_at).getTime():NaN;
  return Number.isFinite(triggered) &&
    triggered<=now.getTime()+300000 && Number.isFinite(checked) &&
    checked>=triggered-60000;
}

async function evaluateTriggeredPolicy(domainRow,results,activeNodes,options={}){
  const tenant=String(domainRow?.tenant||"admin");
  const domain=String(domainRow?.domain||"").trim().toLowerCase();
  const now=options.now||new Date();
  if(!isProductionTenant(tenant) || !canonicalRegistryDomain(domain) || domain.length>253)
    return {triggered:false,confirmedBlocked:false,nodes:[],source:"invalid_domain_or_tenant"};
  const db=options.db||pool;
  const {ensureMonitorTable}=require("./trustpositifWatch");
  await ensureMonitorTable(db);
  const warnings=distinctSignals(results,activeNodes,"warning");
  const healthy=distinctSignals(results,activeNodes,"working");
  await db.query("INSERT INTO trustpositif_domain_monitor(tenant,domain) "+
    "VALUES($1,$2) ON CONFLICT(tenant,domain) DO NOTHING",[tenant,domain]);
  const prior=(await db.query(
    "SELECT * FROM trustpositif_domain_monitor WHERE tenant=$1 AND domain=$2",[tenant,domain])).rows[0];
  let updated;
  if(warnings.length>=2){
    // Persist a durable trigger. A snapshot from BEFORE the trigger is not
    // accepted as a fresh confirmation, even if its source URL was HTTP 200.
    const sourceAt=prior.registry_checked_at?new Date(prior.registry_checked_at).getTime():0;
    const triggerAt=prior.registry_triggered_at?new Date(prior.registry_triggered_at).getTime():0;
    const shouldRetrigger=!triggerAt ||
      (sourceAt>=triggerAt && now.getTime()-sourceAt>MAX_SOURCE_AGE_MS);
    updated=(await db.query(
      "UPDATE trustpositif_domain_monitor SET "+
      "first_anomaly_at=CASE WHEN last_anomaly_at IS NULL OR last_anomaly_at<$3::timestamptz-INTERVAL '20 minutes' "+
      "THEN $3 ELSE COALESCE(first_anomaly_at,$3) END,"+
      "last_anomaly_at=$3,anomaly_nodes=$4::jsonb,"+
      "registry_triggered_at=CASE WHEN $5::boolean THEN $3 ELSE registry_triggered_at END,"+
      "recovery_streak=0,recovery_last_at=NULL,updated_at=$3 "+
      "WHERE tenant=$1 AND domain=$2 RETURNING *",
      [tenant,domain,now,JSON.stringify(warnings),shouldRetrigger])).rows[0];
  }else if(healthy.length>=2){
    const last=prior.recovery_last_at?new Date(prior.recovery_last_at).getTime():0;
    const gap=now.getTime()-last;
    const streak=gap>=MIN_RECOVERY_GAP_MS && gap<=MAX_RECOVERY_GAP_MS
      ? Math.min(2,Number(prior.recovery_streak||0)+1) : 1;
    updated=(await db.query(
      "UPDATE trustpositif_domain_monitor SET recovery_streak=$3,"+
      "recovery_last_at=$4,updated_at=$4 WHERE tenant=$1 AND domain=$2 RETURNING *",
      [tenant,domain,streak,now])).rows[0];
  }else{
    updated=(await db.query(
      "UPDATE trustpositif_domain_monitor SET recovery_streak=0,"+
      "recovery_last_at=NULL,updated_at=$3 WHERE tenant=$1 AND domain=$2 RETURNING *",
      [tenant,domain,now])).rows[0];
  }
  const sourceValid=verifiedCollectorEvidence(updated,domain,now);
  const triggerComplete=hasFreshTrigger(updated,now);
  const listed=sourceValid && updated.registry_listed===true;
  const delisted=sourceValid && updated.registry_listed===false;
  const recoveredNetwork=delisted && Number(updated.recovery_streak)>=2 &&
    healthy.length>=2 && warnings.length===0;
  const old=String(domainRow.global_status||"unknown").toLowerCase();
  const evidenceNodes=warnings.length>=2?warnings:
    Array.isArray(updated.anomaly_nodes)?updated.anomaly_nodes:[];
  const result={
    triggered:warnings.length>=2 || Boolean(updated.registry_triggered_at),
    checked:sourceValid,
    nodes:evidenceNodes,
    healthyNodes:healthy,
    confirmedBlocked:false,confirmedRecovered:false,confirmedNormalized:false,
    suspectedWarning:warnings.length>=2 && old!=="blocked",
    holdBlocked:old==="blocked" && !(delisted && triggerComplete),
    awaitingCollector:warnings.length>=2 && !triggerComplete,
    source:sourceValid?updated.registry_source:"tradevicepc_pending",
    verifiedAt:sourceValid?updated.registry_checked_at:null,
    detectedAt:updated.detected_at||updated.registry_triggered_at||null,
    recoveryStreak:Number(updated.recovery_streak||0)
  };
  // Only a post-trigger, full-snapshot TRADEVICEPC exact match is BLOCKED.
  if(listed && triggerComplete){
    await db.query(
      "UPDATE trustpositif_domain_monitor SET listed=TRUE,verified_at=$3,"+
      "detected_at=COALESCE(detected_at,registry_triggered_at,$4),"+
      "source=$5,recovered_at=NULL,last_error='',updated_at=$4 "+
      "WHERE tenant=$1 AND domain=$2",
      [tenant,domain,updated.registry_checked_at,now,updated.registry_source]);
    result.confirmedBlocked=true;
    result.holdBlocked=false;
    result.suspectedWarning=false;
    result.detectedAt=updated.detected_at||updated.registry_triggered_at||now;
    return result;
  }
  if(delisted && (old==="blocked" || updated.listed===true)){
    // A verified registry delisting removes BLOCKED immediately, but does
    // NOT fabricate a NORMAL/WORKING verdict while the network still fails.
    await db.query(
      "UPDATE trustpositif_domain_monitor SET listed=FALSE,verified_at=$3,"+
      "detected_at=NULL,recovered_at=COALESCE(recovered_at,$3),source=$4,"+
      "last_error='',updated_at=$5 WHERE tenant=$1 AND domain=$2",
      [tenant,domain,updated.registry_checked_at,updated.registry_source,now]);
    result.confirmedRecovered=true;
    result.holdBlocked=false;
    result.suspectedWarning=false;
  }
  if(recoveredNetwork){
    result.confirmedNormalized=true;
    result.holdBlocked=false;
    result.suspectedWarning=false;
  }
  return result;
}
module.exports={POLICY,MAX_SOURCE_AGE_MS,distinctSignals,verifiedCollectorEvidence,
  hasFreshTrigger,evaluateTriggeredPolicy};
