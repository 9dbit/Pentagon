"use strict";
const crypto = require("crypto");
const {pool} = require("./db");

const keyFor = id => crypto.createHash("sha256").update("rank-checker:"+id).digest("hex").slice(0,16);
function ageOf(value,now) {
  const at=value ? new Date(value).getTime() : NaN;
  return Number.isFinite(at)&&at<=now ? now-at : null;
}
function networkReading(row,now=Date.now()) {
  const age=ageOf(row?.checked_at,now);
  if(age===null)return {state:"unknown",text:"Belum diperiksa",checked_at:null};
  const status=["working","warning","blocked"].includes(row.status)?row.status:"unknown";
  const labels={working:"Terjangkau",warning:"Warning jaringan",blocked:"Indikasi blokir",unknown:"Hasil belum tersedia"};
  return {state:age>20*60000?"stale":status,
    text:(age>20*60000?"Lama · ":"")+labels[status],checked_at:row.checked_at,
    attribution:row.attribution||"node"};
}
function registryReading(row,now=Date.now()) {
  const age=ageOf(row?.registry_checked_at,now);
  if(age===null||typeof row.registry_listed!=="boolean")
    return {state:"unknown",text:"Belum terverifikasi",checked_at:null};
  const listed=row.registry_listed;
  return {state:age>12*3600000?"stale":listed?"listed":"not_listed",
    text:(age>12*3600000?"Lama · ":"")+(listed?"Tercatat registry":"Tidak tercatat registry"),
    checked_at:row.registry_checked_at};
}
// Shared by the dashboard and Telegram. Tenant comes only from the session or
// a verified report recipient. Never publish node secrets/IPs or foreign domains.
async function rankCheckerEvidence(tenant,db=pool,now=Date.now()) {
  const nodes=(await db.query("SELECT id,provider_name,is_active FROM provider_nodes "+
    "WHERE tenant IN ('admin',$1) ORDER BY id",[tenant])).rows;
  const domainRows=(await db.query(
    "SELECT d.id,d.domain,m.registry_listed,m.registry_checked_at FROM domains d "+
    "LEFT JOIN trustpositif_domain_monitor m ON m.tenant=d.tenant AND m.domain=LOWER(TRIM(d.domain)) "+
    "WHERE d.tenant=$1 AND EXISTS(SELECT 1 FROM rank_keyword_domains k "+
    "JOIN rank_keyword_groups g ON g.id=k.group_id WHERE g.tenant=d.tenant "+
    "AND k.is_whitelisted=TRUE AND LOWER(TRIM(k.domain))=LOWER(TRIM(d.domain))) ORDER BY d.id",
    [tenant])).rows;
  const observations=domainRows.length?(await db.query(
    "WITH fleet AS (SELECT id,provider_name,COUNT(*) OVER(PARTITION BY LOWER(TRIM(provider_name))) AS provider_count "+
    "FROM provider_nodes WHERE tenant IN ('admin',$1)) "+
    "SELECT d.domain,n.id AS node_id,r.status,r.checked_at, "+
    "CASE WHEN r.node_id IS NULL THEN 'provider_history' ELSE 'node' END AS attribution "+
    "FROM domains d CROSS JOIN fleet n LEFT JOIN LATERAL "+
    "(SELECT r.node_id,r.status,r.checked_at FROM check_results r WHERE r.domain_id=d.id "+
    "AND r.checker_type LIKE 'node:%' AND (r.node_id=n.id OR (r.node_id IS NULL "+
    "AND n.provider_count=1 AND LOWER(TRIM(r.provider_name))=LOWER(TRIM(n.provider_name)))) "+
    "ORDER BY r.checked_at DESC,r.id DESC LIMIT 1) r ON TRUE "+
    "WHERE d.tenant=$1 AND d.id=ANY($2::int[])",[tenant,domainRows.map(d=>d.id)])).rows:[];
  const counts=new Map(),seen=new Map();
  for(const n of nodes){const p=String(n.provider_name||"Provider").trim();counts.set(p,(counts.get(p)||0)+1);}
  const publicNodes=nodes.map(n=>{
    const provider=String(n.provider_name||"Provider").replace(/[^\p{L}\p{N} .+-]/gu,"").slice(0,48);
    const order=(seen.get(provider)||0)+1;seen.set(provider,order);
    return {key:keyFor(n.id),label:provider+(counts.get(provider)>1?" · Node "+order:""),is_active:n.is_active===true};
  });
  const byDomain=new Map(domainRows.map(d=>[d.domain,{domain:d.domain,node_results:{},ai:registryReading(d,now)}]));
  for(const r of observations)byDomain.get(r.domain).node_results[keyFor(r.node_id)]=networkReading(r,now);
  return {nodes:publicNodes,domains:[...byDomain.values()],as_of:new Date(now).toISOString(),
    notice:"Node = hasil akses jaringan; AI Checker = registry TrustPositif. Keduanya bukan ranking Google dari jaringan SIM."};
}
module.exports={rankCheckerEvidence,networkReading,registryReading,keyFor};
