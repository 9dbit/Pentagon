"use strict";
// The existing domains table has a globally unique hostname. Customer sources
// must preserve tenant identity, never claim another tenant's host, and never
// silently turn demo, disabled, or conflicting records into live monitoring.
const { pool } = require("./db");

const TENANT_SQL = "^[a-z][a-z0-9_-]{0,63}$";
const NON_PRODUCTION_SQL = "^(demo|test|staging|sandbox|sample)([-_]|$)";
const DOMAIN_SQL = "^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$";
const NO_DEMO_ROWS = "(tenant ~ $1 AND tenant !~* $2)";
const CTE = [
  "WITH source_rows AS (",
  " SELECT LOWER(TRIM(k.domain)) AS hostname,TRIM(g.tenant) AS tenant,",
  " NULLIF(TRIM(g.project_name),'') AS project_name",
  " FROM rank_keyword_domains k JOIN rank_keyword_groups g ON g.id=k.group_id",
  " WHERE k.is_whitelisted=TRUE AND g.is_active=TRUE",
  " AND g.tenant ~ $1 AND g.tenant !~* $2",
  "), candidates AS (",
  " SELECT hostname,tenant,MIN(project_name) AS project_name",
  " FROM source_rows GROUP BY hostname,tenant",
  "), valid AS (",
  " SELECT * FROM candidates WHERE hostname ~ $3 AND LENGTH(hostname) BETWEEN 4 AND 253",
  " AND hostname NOT LIKE '%..%' AND hostname NOT LIKE '%.-%' AND hostname NOT LIKE '%-.%'",
  " ), exclusive AS (",
  " SELECT v.* FROM valid v WHERE NOT EXISTS (",
  " SELECT 1 FROM rank_keyword_domains other_k JOIN rank_keyword_groups other_g",
  " ON other_g.id=other_k.group_id WHERE other_k.is_whitelisted=TRUE",
  " AND other_g.is_active=TRUE AND LOWER(TRIM(other_k.domain))=v.hostname",
  " AND TRIM(other_g.tenant)<>v.tenant",
  " )",
  " ), importable AS (",
  " SELECT v.* FROM exclusive v WHERE NOT EXISTS (",
  " SELECT 1 FROM domains d WHERE LOWER(TRIM(d.domain))=v.hostname",
  " )",
  " )"
].join(" ");

const ARGS = [TENANT_SQL,NON_PRODUCTION_SQL,DOMAIN_SQL];
function isProductionTenant(value) {
  const tenant=String(value||"").trim();
  return new RegExp(TENANT_SQL).test(tenant) &&
    !new RegExp(NON_PRODUCTION_SQL,"i").test(tenant);
}

async function customerWhitelistCoverage(db=pool) {
  const result=await db.query(CTE + [
    " SELECT",
    " (SELECT COUNT(*)::int FROM source_rows) AS whitelisted_source_rows,",
    " (SELECT COUNT(*)::int FROM candidates) AS distinct_tenant_domains,",
    " (SELECT COUNT(*)::int FROM valid) AS valid_tenant_domains,",
    " (SELECT COUNT(*)::int FROM exclusive) AS exclusive_tenant_domains,",
    " (SELECT COUNT(*)::int FROM importable) AS awaiting_import,",
    " (SELECT COUNT(*)::int FROM candidates WHERE hostname !~ $3",
    " OR LENGTH(hostname) NOT BETWEEN 4 AND 253 OR hostname LIKE '%..%'",
    " OR hostname LIKE '%.-%' OR hostname LIKE '%-.%') AS invalid_hostnames,",
    " (SELECT COUNT(*)::int FROM valid v WHERE NOT EXISTS (",
    " SELECT 1 FROM exclusive ex WHERE ex.hostname=v.hostname AND ex.tenant=v.tenant",
    " )) AS quarantined_cross_tenant_sources,",
    " (SELECT COUNT(*)::int FROM exclusive e WHERE EXISTS (",
    " SELECT 1 FROM domains d WHERE LOWER(TRIM(d.domain))=e.hostname",
    " AND d.tenant<>e.tenant)) AS occupied_by_other_tenant,",
    " (SELECT COUNT(*)::int FROM exclusive e WHERE EXISTS (",
    " SELECT 1 FROM domains d WHERE LOWER(TRIM(d.domain))=e.hostname",
    " AND d.tenant=e.tenant AND d.is_active IS DISTINCT FROM TRUE",
    " )) AS deliberately_disabled,",
    " (SELECT COUNT(*)::int FROM domains d WHERE d.is_active=TRUE",
    " AND d.tenant ~ $1 AND d.tenant !~* $2) AS active_production_domains,",
    " (SELECT COUNT(*)::int FROM rank_keyword_domains k",
    " JOIN rank_keyword_groups g ON g.id=k.group_id WHERE k.is_whitelisted=TRUE",
    " AND g.is_active=TRUE AND (g.tenant !~ $1 OR g.tenant ~* $2)) AS excluded_nonproduction_rows"
  ].join(" "),ARGS);
  return result.rows[0];
}

async function syncEligibleCustomerWhitelist(db=pool) {
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(20261021,36)");
    const r=await client.query(CTE + [
      " , inserted AS (INSERT INTO domains(domain,project_name,tenant,is_active)",
      " SELECT hostname,COALESCE(project_name,''),tenant,TRUE FROM importable",
      " ORDER BY hostname,tenant ON CONFLICT(domain) DO NOTHING RETURNING id)",
      " SELECT COUNT(*)::int AS imported FROM inserted"
    ].join(" "),ARGS);
    await client.query("COMMIT");
    return Number(r.rows[0]?.imported||0);
  } catch(err) {
    await client.query("ROLLBACK").catch(()=>{});
    throw err;
  } finally {client.release();}
}

module.exports={
  TENANT_SQL,NON_PRODUCTION_SQL,DOMAIN_SQL,isProductionTenant,
  customerWhitelistCoverage,syncEligibleCustomerWhitelist
};
