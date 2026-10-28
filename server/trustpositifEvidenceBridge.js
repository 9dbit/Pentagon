"use strict";

// Trusted source-relay for a PC that can download the official Komdigi
// registry when Railway has no egress. Import verifies and stores registry
// evidence first; after commit a separate reconciler may immediately commit
// BLOCKED only with fresh server-recorded two-provider WARNING evidence.
// Registry delisting alone never labels a broken network NORMAL.
const express=require("express");
const crypto=require("node:crypto");
const {pool}=require("./db");
const {ensureMonitorTable}=require("./trustpositifWatch");
const {canonicalRegistryDomain}=require("./trustpositifRegistrySync");
const {TENANT_SQL,NON_PRODUCTION_SQL,isProductionTenant}=require("./customerWhitelistSync");

const router=express.Router();
const SOURCE_URL="https://trustpositif.komdigi.go.id/assets/db/domains_isp";
const INVENTORY_LIMIT=5000;
const MIN_BYTES=100000000;
const MIN_ENTRIES=5000000;
const MAX_AGE_MS=2*60*60*1000;
const CLOCK_SKEW_MS=5*60*1000;

function validSecret(req){
  const key=String(process.env.TRUSTPOSITIF_SOURCE_BRIDGE_KEY||"");
  if(key.length<48)return null;
  const auth=String(req.get("authorization")||"");
  const candidate=auth.startsWith("Bearer ")?auth.slice(7):"";
  const compare=x=>crypto.createHash("sha256").update(x).digest();
  return candidate.length>=48 && crypto.timingSafeEqual(compare(candidate),compare(key));
}
function requireBridge(req,res,next){
  if(String(process.env.TRUSTPOSITIF_SOURCE_BRIDGE_KEY||"").length<48)
    return res.status(503).json({error:"SOURCE_BRIDGE_NOT_CONFIGURED"});
  if(!validSecret(req))return res.status(401).json({error:"SOURCE_BRIDGE_UNAUTHORIZED"});
  res.set("Cache-Control","no-store");
  next();
}
async function inventory(db=pool){
  const {rows}=await db.query([
    "SELECT d.tenant,LOWER(TRIM(d.domain)) AS domain FROM domains d",
    "WHERE d.is_active=TRUE AND d.tenant~$1 AND d.tenant!~*$2",
    "AND EXISTS (SELECT 1 FROM rank_keyword_domains k",
    "JOIN rank_keyword_groups g ON g.id=k.group_id",
    "WHERE g.tenant=d.tenant AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
    "AND LOWER(TRIM(k.domain))=LOWER(TRIM(d.domain)))",
    "ORDER BY d.tenant,d.domain LIMIT $3"
  ].join(" "),[TENANT_SQL,NON_PRODUCTION_SQL,INVENTORY_LIMIT+1]);
  if(rows.length>INVENTORY_LIMIT)throw Object.assign(Error("SOURCE_BRIDGE_INVENTORY_TOO_LARGE"),{code:"SOURCE_BRIDGE_INVENTORY_TOO_LARGE"});
  const unique=new Set();
  const valid=[];
  for(const row of rows){
    const domain=String(row.domain||"").toLowerCase(),tenant=String(row.tenant||"");
    const lookup_key=canonicalRegistryDomain(domain);
    if(!lookup_key || !isProductionTenant(tenant))continue;
    const id=tenant+"\u0000"+domain;
    if(unique.has(id))continue;
    unique.add(id);valid.push({tenant,domain,lookup_key});
  }
  return valid;
}
async function scanRequired(db=pool){
  // In the two-warning policy, TRADEVICEPC polls cheaply but downloads the
  // ~223 MB official registry only when an independent-node warning has
  // triggered a new lookup, or when a blocked domain needs a delisting audit.
  if(String(process.env.TRUSTPOSITIF_STATUS_POLICY||"").toLowerCase()!=="tradevicepc_triggered")
    return true;
  await ensureMonitorTable(db);
  const {rows}=await db.query([
    "SELECT EXISTS(SELECT 1 FROM domains d",
    "JOIN trustpositif_domain_monitor m",
    "ON m.tenant=d.tenant AND m.domain=LOWER(TRIM(d.domain))",
    "WHERE d.is_active=TRUE AND d.tenant~$1 AND d.tenant!~*$2",
    "AND EXISTS (SELECT 1 FROM rank_keyword_domains k",
    "JOIN rank_keyword_groups g ON g.id=k.group_id",
    "WHERE g.tenant=d.tenant AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
    "AND LOWER(TRIM(k.domain))=LOWER(TRIM(d.domain)))",
    "AND (",
    "(m.registry_triggered_at IS NOT NULL",
    "AND (m.registry_checked_at IS NULL OR m.registry_checked_at<m.registry_triggered_at",
    "OR m.registry_checked_at<NOW()-INTERVAL '6 hours'))",
    "OR (d.global_status='blocked'",
    "AND (m.registry_checked_at IS NULL OR m.registry_checked_at<NOW()-INTERVAL '6 hours'))",
    ") LIMIT 1) AS needed"
  ].join(" "),[TENANT_SQL,NON_PRODUCTION_SQL]);
  return rows[0]?.needed===true;
}

function validateEvidence(body,monitored,now=Date.now()){
  if(!body || body.source_url!==SOURCE_URL || body.source_http!==200 ||
     !/^[a-f0-9]{64}$/.test(String(body.source_sha256||"")) ||
     !Number.isSafeInteger(body.source_bytes) || body.source_bytes<MIN_BYTES ||
     !Number.isSafeInteger(body.source_entries) || body.source_entries<MIN_ENTRIES)
    return {ok:false,error:"SOURCE_EVIDENCE_INVALID"};
  const at=new Date(body.verified_at_utc).getTime();
  if(!Number.isFinite(at)||at>now+CLOCK_SKEW_MS||at<now-MAX_AGE_MS)
    return {ok:false,error:"SOURCE_SNAPSHOT_EXPIRED"};
  if(!Array.isArray(body.matches)||body.matches.length!==monitored.length)
    return {ok:false,error:"SOURCE_INVENTORY_MISMATCH"};
  const expected=new Map(monitored.map(r=>[r.tenant+"\u0000"+r.domain,r.lookup_key]));
  const seen=new Set();
  const accepted=[];
  for(const entry of body.matches){
    if(!entry || typeof entry.listed!=="boolean")return {ok:false,error:"SOURCE_ENTRY_INVALID"};
    const tenant=String(entry.tenant||""),domain=String(entry.domain||"").trim().toLowerCase();
    const id=tenant+"\u0000"+domain;
    if(seen.has(id)||expected.get(id)!==entry.lookup_key)
      return {ok:false,error:"SOURCE_ENTRY_OUTSIDE_INVENTORY"};
    seen.add(id);accepted.push({tenant,domain,lookup_key:entry.lookup_key,listed:entry.listed});
  }
  return {ok:true,at:new Date(at),accepted};
}

async function importEvidence(body,db=pool){
  // Schema is created by the existing boot path; keep all later writes in
  // a single transaction, with no direct domain status or alert mutation.
  await ensureMonitorTable(db);
  const monitored=await inventory(db);
  const validation=validateEvidence(body,monitored);
  if(!validation.ok)return {ok:false,error:validation.error,statusCode:422};
  if(!monitored.length)return {ok:false,error:"SOURCE_INVENTORY_EMPTY",statusCode:409};
  const client=await db.connect();
  let accepted=0,listed=0;
  const applied=[];
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pentagon_trustpositif_source_bridge'))");
    for(const row of validation.accepted){
      const source="komdigi-domains_isp-tradevicepc-sha256:"+body.source_sha256.slice(0,32);
      const matchKind=!row.listed?"not_listed":
        row.lookup_key===row.domain?"exact":"parent_apex";
      const result=await client.query([
        "INSERT INTO trustpositif_domain_monitor",
        "(tenant,domain,registry_listed,registry_checked_at,registry_source,registry_lookup_domain,",
        "registry_last_error,registry_retry_after,registry_snapshot_sha256,registry_snapshot_bytes,",
        "registry_snapshot_entries,registry_collector,registry_match_kind,updated_at)",
        "VALUES($1,$2,$3,$4,$5,$6,'',NULL,$7,$8,$9,'TRADEVICEPC',$10,NOW())",
        "ON CONFLICT(tenant,domain) DO UPDATE SET",
        "registry_listed=EXCLUDED.registry_listed,",
        "registry_checked_at=EXCLUDED.registry_checked_at,",
        "registry_source=EXCLUDED.registry_source,",
        "registry_lookup_domain=EXCLUDED.registry_lookup_domain,",
        "registry_last_error='',registry_retry_after=NULL,",
        "registry_snapshot_sha256=EXCLUDED.registry_snapshot_sha256,",
        "registry_snapshot_bytes=EXCLUDED.registry_snapshot_bytes,",
        "registry_snapshot_entries=EXCLUDED.registry_snapshot_entries,",
        "registry_collector=EXCLUDED.registry_collector,",
        "registry_match_kind=EXCLUDED.registry_match_kind,updated_at=NOW()",
        "WHERE trustpositif_domain_monitor.registry_checked_at IS NULL",
        "OR trustpositif_domain_monitor.registry_checked_at<=EXCLUDED.registry_checked_at"
      ].join(" "),[row.tenant,row.domain,row.listed,validation.at,source,row.lookup_key,
        body.source_sha256,body.source_bytes,body.source_entries,matchKind]);
      accepted+=result.rowCount||0;
      if(result.rowCount){
        applied.push(row);
        if(row.listed)listed++;
      }
    }
    await client.query([
      "INSERT INTO trustpositif_registry_bridge_audit",
      "(source_sha256,source_url,source_bytes,source_entries,source_checked_at,",
      "inventory_count,accepted_count,listed_count)",
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8)"
    ].join(" "),[body.source_sha256,SOURCE_URL,body.source_bytes,body.source_entries,
      validation.at,monitored.length,accepted,listed]);
    await client.query("COMMIT");
  }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    throw e;
  }finally{client.release();}
  // The source import is already committed. Reconciliation revalidates source
  // provenance, tenant, fresh node quorum and performs atomic CAS transitions.
  // Errors cannot roll back the valid snapshot or cause duplicate downloads.
  let reconciliation={status:"policy_disabled",examined:0,blocked:0,delisted:0,errors:0};
  if(String(process.env.TRUSTPOSITIF_STATUS_POLICY||"").toLowerCase()==="tradevicepc_triggered"){
    try{
      reconciliation=await require("./trustpositifEvidenceReconciler")
        .reconcileVerifiedSnapshot(applied,db);
    }catch(err){
      reconciliation={status:"error",examined:applied.length,blocked:0,delisted:0,errors:1};
      console.warn("[TrustPositif Immediate] reconcile unavailable code="+
        String(err.code||"RECONCILE_ERROR").replace(/[^A-Z0-9_]/gi,"").slice(0,50));
    }
  }
  return {ok:true,status:"verified_evidence_imported",inventory:monitored.length,
    accepted,listed,source_checked_at:validation.at.toISOString(),reconciliation};
}
router.use(requireBridge);
router.get("/inventory",async(req,res)=>{
  try{
    const domains=await inventory();
    const scan_required=await scanRequired();
    res.json({ok:true,source_url:SOURCE_URL,scan_required,domains});
  }catch(e){
    console.warn("[TrustPositif Bridge] inventory unavailable",String(e.code||"DATABASE_UNAVAILABLE").slice(0,45));
    res.status(503).json({error:"SOURCE_INVENTORY_UNAVAILABLE"});
  }
});
router.post("/evidence",async(req,res)=>{
  try{
    const result=await importEvidence(req.body);
    if(!result.ok)return res.status(result.statusCode||422).json(result);
    console.log("[TrustPositif Bridge] verified official source snapshot accepted="+result.accepted+
      " registry_listed="+result.listed+" immediate_blocked="+
      (result.reconciliation?.blocked||0)+" delisted="+(result.reconciliation?.delisted||0));
    res.status(200).json(result);
  }catch(e){
    console.warn("[TrustPositif Bridge] ingestion paused",String(e.code||"DATABASE_UNAVAILABLE").slice(0,45));
    res.status(503).json({error:"SOURCE_BRIDGE_INGEST_UNAVAILABLE"});
  }
});
module.exports={router,inventory,scanRequired,validateEvidence,importEvidence,SOURCE_URL};
