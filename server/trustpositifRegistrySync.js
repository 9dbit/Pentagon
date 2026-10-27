"use strict";

// Observational registry state is NOT a confirmed ISP block. Refresh the exact
// official Komdigi index independently of node availability. Confirmed BLOCKED
// still requires a quorum from at least two independent cellular providers.
const {pool}=require("./db");
const {isProductionTenant,TENANT_SQL,NON_PRODUCTION_SQL}=require("./customerWhitelistSync");
const {ensureMonitorTable}=require("./trustpositifWatch");

const REGISTRY_REFRESH_MS=Math.max(3600000,Number(process.env.TRUSTPOSITIF_REGISTRY_REFRESH_MS||21600000));
const REGISTRY_RETRY_MS=Math.max(1800000,Number(process.env.TRUSTPOSITIF_REGISTRY_RETRY_MS||1800000));
const MAX_BATCH=20;
const SOURCE="komdigi-domains_isp-exact-index";

function canonicalRegistryDomain(value){
  const raw=String(value||"").trim().toLowerCase()
    .replace(/^https?:\/\//,"").split(/[/?#]/)[0].replace(/:\d+$/,"")
    .replace(/\.$/,"").replace(/^www\./,"");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(raw) && raw.length<=253 ? raw : "";
}

async function officialIndexLookup(domains){
  // Use the same indexed file and 30-minute failure breaker as Admin Registry Check.
  const {ensureIndexedCache,lookupIndexedDomains}=require("./trustpositifRoutes");
  const cache=await ensureIndexedCache();
  if(!cache?.index?.ready || Number(cache.index.entry_count)<=0)
    throw Object.assign(new Error("OFFICIAL_INDEX_NOT_READY"),{code:"OFFICIAL_INDEX_NOT_READY"});
  const scan=await lookupIndexedDomains(domains);
  if(Number(scan.entryCount)<=0)throw Object.assign(new Error("OFFICIAL_EMPTY_REGISTRY"),{code:"OFFICIAL_EMPTY_REGISTRY"});
  return {matches:scan.matches,entryCount:scan.entryCount,source:SOURCE};
}

async function syncOfficialRegistryBatch(db=pool,options={}){
  const now=options.now instanceof Date?options.now:new Date();
  const limit=Math.min(MAX_BATCH,Math.max(1,Number(options.limit)||10));
  const lookup=options.lookup||officialIndexLookup;
  // This creates only private monitor metadata. No status/alert/Telegram write.
  await ensureMonitorTable(db);
  const {rows:due}=await db.query([
    "SELECT d.tenant,d.domain FROM domains d",
    "LEFT JOIN trustpositif_domain_monitor m",
    "ON m.tenant=d.tenant AND m.domain=LOWER(TRIM(d.domain))",
    "WHERE d.is_active=TRUE AND d.tenant~$1 AND d.tenant!~*$2",
    "AND (m.registry_checked_at IS NULL OR m.registry_checked_at<$3::timestamptz)",
    "AND (m.registry_retry_after IS NULL OR m.registry_retry_after<=$4::timestamptz)",
    "AND EXISTS (SELECT 1 FROM rank_keyword_domains k",
    "JOIN rank_keyword_groups g ON g.id=k.group_id",
    "WHERE g.tenant=d.tenant AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
    "AND LOWER(TRIM(k.domain))=LOWER(TRIM(d.domain)))",
    "ORDER BY m.registry_checked_at NULLS FIRST,d.id ASC LIMIT $5"
  ].join(" "),[
    TENANT_SQL,NON_PRODUCTION_SQL,new Date(now.getTime()-REGISTRY_REFRESH_MS),now,limit
  ]);
  const candidates=due.filter(row=>isProductionTenant(row.tenant) &&
    canonicalRegistryDomain(row.domain));
  if(!candidates.length)return {status:"not_due",checked:0,listed:0};
  const targets=[...new Set(candidates.map(r=>canonicalRegistryDomain(r.domain)))];
  let scan;
  try{
    scan=await lookup(targets);
    if(!scan || Number(scan.entryCount)<=0 || !scan.matches)
      throw Object.assign(new Error("OFFICIAL_INDEX_NOT_READY"),{code:"OFFICIAL_INDEX_NOT_READY"});
    if(targets.some(d=>typeof scan.matches[d]!=="boolean"))
      throw Object.assign(new Error("OFFICIAL_LOOKUP_INCOMPLETE"),{code:"OFFICIAL_LOOKUP_INCOMPLETE"});
  }catch(e){
    const errorCode=String(e.code||"OFFICIAL_SOURCE_UNAVAILABLE").replace(/[^A-Z0-9_]/gi,"").slice(0,55);
    // Never turn a previous confirmed listing into "not listed" after a
    // timeout or a partial/empty source download.
    for(const row of candidates){
      await db.query(
        "INSERT INTO trustpositif_domain_monitor(tenant,domain,registry_last_error,registry_retry_after,updated_at) "+
        "VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant,domain) DO UPDATE SET "+
        "registry_last_error=EXCLUDED.registry_last_error,"+
        "registry_retry_after=EXCLUDED.registry_retry_after,updated_at=EXCLUDED.updated_at",
        [row.tenant,String(row.domain).trim().toLowerCase(),errorCode,
          new Date(now.getTime()+REGISTRY_RETRY_MS),now]
      );
    }
    return {status:"source_unavailable",checked:0,error_code:errorCode,affected:candidates.length};
  }
  let listed=0;
  for(const row of candidates){
    const key=canonicalRegistryDomain(row.domain);
    const present=scan.matches[key]===true;
    if(present)listed++;
    await db.query(
      "INSERT INTO trustpositif_domain_monitor "+
      "(tenant,domain,registry_listed,registry_checked_at,registry_source,registry_lookup_domain,"+
      "registry_last_error,registry_retry_after,updated_at) "+
      "VALUES($1,$2,$3,$4,$5,$6,'',NULL,$4) ON CONFLICT(tenant,domain) DO UPDATE SET "+
      "registry_listed=EXCLUDED.registry_listed,registry_checked_at=EXCLUDED.registry_checked_at,"+
      "registry_source=EXCLUDED.registry_source,registry_lookup_domain=EXCLUDED.registry_lookup_domain,"+
      "registry_last_error='',registry_retry_after=NULL,updated_at=EXCLUDED.updated_at",
      [row.tenant,String(row.domain).trim().toLowerCase(),
       present,now,String(scan.source||SOURCE).slice(0,100),key]
    );
  }
  return {status:"complete",checked:candidates.length,listed};
}

module.exports={
  canonicalRegistryDomain,officialIndexLookup,syncOfficialRegistryBatch,
  REGISTRY_REFRESH_MS,REGISTRY_RETRY_MS
};
