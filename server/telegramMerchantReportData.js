"use strict";

// Every merchant-facing query is anchored to the authenticated tenant AND
// an active, registered domain. Never use admin/global rank reporting here.
const {pool}=require("./db");
const {ensureMonitorTable}=require("./trustpositifWatch");

async function trustRows(tenant,db=pool) {
  // Run one-time schema readiness on the pool, outside the report's
  // tenant-bound transaction, to avoid DDL table locks inside send-now.
  await ensureMonitorTable();
  const {rows}=await db.query([
    "SELECT DISTINCT ON (LOWER(TRIM(k.domain)))",
    "d.id AS domain_id,LOWER(TRIM(d.domain)) AS domain,d.project_name,",
    "d.global_status,d.last_checked_at,",
    "m.registry_listed,m.registry_checked_at,m.registry_source,m.registry_lookup_domain,",
    "ev.event_type AS latest_registry_event,",
    "ev.created_at AS latest_registry_event_at",
    "FROM rank_keyword_domains k",
    "JOIN rank_keyword_groups g ON g.id=k.group_id",
    "JOIN domains d ON d.tenant=g.tenant AND d.is_active=TRUE",
    "AND LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain))",
    "LEFT JOIN trustpositif_domain_monitor m ON m.tenant=d.tenant",
    "AND m.domain=LOWER(TRIM(d.domain))",
    "LEFT JOIN LATERAL (SELECT event_type,created_at FROM trustpositif_notification_outbox o",
    "WHERE o.domain_id=d.id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) ev ON TRUE",
    "WHERE g.tenant=$1 AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
    "ORDER BY LOWER(TRIM(k.domain)),d.last_checked_at DESC NULLS LAST"
  ].join(" "),[tenant]);
  return rows;
}
async function providerRows(db=pool) {
  const {rows}=await db.query(
    "SELECT id,provider_name,last_health_status,last_ping_at FROM provider_nodes "+
    "WHERE is_active=TRUE AND tenant='admin' AND provider_name IS NOT NULL ORDER BY id"
  );
  return rows;
}
async function networkObservations(domainRows,db=pool) {
  const ids=domainRows.map(r=>Number(r.domain_id)).filter(Number.isInteger);
  if(!ids.length)return [];
  const {rows}=await db.query([
    "SELECT DISTINCT ON (r.domain_id,LOWER(r.provider_name))",
    "r.domain_id,r.provider_name,r.status,r.checked_at",
    "FROM check_results r WHERE r.domain_id=ANY($1::int[])",
    "AND r.provider_name IS NOT NULL",
    "AND LOWER(COALESCE(r.checker_type,'')) NOT IN ('direct','proxy')",
    "AND r.checked_at>=NOW()-INTERVAL '20 minutes'",
    "ORDER BY r.domain_id,LOWER(r.provider_name),r.checked_at DESC"
  ].join(" "),[ids]);
  return rows;
}
async function rankRows(tenant,db=pool){
  const {rows}=await db.query([
    "WITH active_groups AS (",
    "SELECT id,keyword,project_name,tenant FROM rank_keyword_groups",
    "WHERE tenant=$1 AND is_active=TRUE ORDER BY id)",
    "SELECT g.id AS group_id,g.keyword,g.project_name,LOWER(TRIM(k.domain)) AS domain,",
    "k.last_position,k.last_page,k.last_status,k.last_checked_at,",
    "d.label AS domain_label,prev.position AS previous_position",
    "FROM active_groups g JOIN rank_keyword_domains k ON k.group_id=g.id",
    "AND k.is_whitelisted=TRUE",
    "JOIN LATERAL (SELECT d.label FROM domains d",
    "WHERE d.tenant=g.tenant AND d.is_active=TRUE",
    "AND LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain))",
    "ORDER BY d.id LIMIT 1) d ON TRUE",
    "LEFT JOIN LATERAL (",
    "SELECT rsr.position FROM rank_scan_results rsr",
    "WHERE rsr.group_id=g.id AND rsr.node_id IS NULL",
    "AND rsr.classification='whitelisted' AND rsr.position BETWEEN 1 AND 100",
    "AND rsr.checked_at < k.last_checked_at-INTERVAL '5 minutes'",
    "AND rsr.checked_at>=NOW()-INTERVAL '14 days'",
    "AND (LOWER(rsr.host)=LOWER(TRIM(k.domain))",
    "OR LOWER(rsr.host) LIKE '%.'||LOWER(TRIM(k.domain)))",
    "ORDER BY rsr.checked_at DESC,rsr.position ASC LIMIT 1",
    ") prev ON TRUE",
    "ORDER BY g.id,LOWER(TRIM(k.domain))"
  ].join(" "),[tenant]);
  return rows;
}
async function rankSnapshots(tenant,db=pool){
  const {rows}=await db.query([
    "SELECT DISTINCT ON (rsr.group_id,LOWER(TRIM(k.domain)),COALESCE(rsr.node_id,-1))",
    "rsr.group_id,LOWER(TRIM(k.domain)) AS domain,rsr.node_id,",
    "rsr.position,rsr.checked_at",
    "FROM rank_scan_results rsr",
    "JOIN rank_keyword_groups g ON g.id=rsr.group_id",
    "JOIN rank_keyword_domains k ON k.group_id=g.id AND k.is_whitelisted=TRUE",
    "WHERE g.tenant=$1 AND g.is_active=TRUE",
    "AND rsr.classification='whitelisted' AND rsr.position BETWEEN 1 AND 100",
    "AND rsr.checked_at>=NOW()-INTERVAL '30 minutes'",
    "AND (LOWER(rsr.host)=LOWER(TRIM(k.domain))",
    "OR LOWER(rsr.host) LIKE '%.'||LOWER(TRIM(k.domain)))",
    "AND EXISTS(SELECT 1 FROM domains d WHERE d.tenant=g.tenant",
    "AND d.is_active=TRUE AND LOWER(TRIM(d.domain))=LOWER(TRIM(k.domain)))",
    "ORDER BY rsr.group_id,LOWER(TRIM(k.domain)),COALESCE(rsr.node_id,-1),",
    "rsr.checked_at DESC,rsr.position ASC LIMIT 200"
  ].join(" "),[tenant]);
  return rows;
}
module.exports={trustRows,providerRows,networkObservations,rankRows,rankSnapshots};
