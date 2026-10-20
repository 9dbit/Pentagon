"use strict";

// READ-ONLY production reconciliation preflight.
// Never migrates an old tenant, re-enables a deliberately disabled domain,
// copies demo records, sends checker tasks, or calls the official endpoint.
const { pool } = require("./db");
const VALID_HOST = "^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$";
const number = x => Number.isFinite(Number(x)) ? Number(x) : 0;

function classifyReadiness(domains, whitelist, nodes) {
  if (whitelist.cross_tenant_conflicts > 0) return "review_cross_tenant_conflicts";
  if (whitelist.invalid_names > 0 && whitelist.valid_distinct === 0 &&
      domains.active === 0) return "review_invalid_whitelist_names";
  if (whitelist.unimported > 0) return "eligible_rank_whitelist_pending_sync";
  if (domains.active === 0 && (domains.inactive > 0 || whitelist.admin_inactive > 0))
    return "admin_domains_disabled";
  if (domains.active === 0) return "no_approved_admin_domain";
  if (nodes.online_independent_providers < 2)
    return "waiting_two_healthy_independent_providers";
  return "ready_to_scan";
}

async function auditWhitelistReadiness(db = pool, tenant = "admin") {
  // Never accept client-provided SQL identifiers or tenant names here.
  if (tenant !== "admin") throw new Error("ADMIN_TENANT_REQUIRED");
  const domains = (await db.query(
    "SELECT COUNT(*)::int AS total, " +
    "COUNT(*) FILTER (WHERE is_active=TRUE)::int AS active, " +
    "COUNT(*) FILTER (WHERE is_active IS DISTINCT FROM TRUE)::int AS inactive " +
    "FROM domains WHERE tenant=$1", [tenant]
  )).rows[0];

  const whitelist = (await db.query(
    "WITH all_groups AS (" +
    " SELECT g.id,g.is_active FROM rank_keyword_groups g WHERE g.tenant=$1" +
    "), listed AS (" +
    " SELECT LOWER(TRIM(k.domain)) AS domain,g.is_active AS group_active" +
    " FROM rank_keyword_domains k JOIN all_groups g ON g.id=k.group_id" +
    " WHERE k.is_whitelisted=TRUE" +
    "), allowed AS (" +
    " SELECT DISTINCT domain FROM listed WHERE group_active=TRUE AND domain ~ $2" +
    "), ownership AS (" +
    " SELECT a.domain,d.id,d.tenant AS owner_tenant,d.is_active" +
    " FROM allowed a LEFT JOIN domains d ON LOWER(TRIM(d.domain))=a.domain" +
    ")" +
    " SELECT (SELECT COUNT(*)::int FROM all_groups) AS groups_total," +
    " (SELECT COUNT(*)::int FROM all_groups WHERE is_active=TRUE) AS groups_active," +
    " (SELECT COUNT(*)::int FROM listed) AS whitelisted_rows," +
    " (SELECT COUNT(*)::int FROM listed WHERE group_active=TRUE) AS active_group_whitelist_rows," +
    " (SELECT COUNT(*)::int FROM listed WHERE group_active=TRUE AND domain !~ $2) AS invalid_names," +
    " COUNT(*)::int AS valid_distinct," +
    " COUNT(*) FILTER (WHERE id IS NULL)::int AS unimported," +
    " COUNT(*) FILTER (WHERE id IS NOT NULL AND owner_tenant<>$1)::int AS cross_tenant_conflicts," +
    " COUNT(*) FILTER (WHERE owner_tenant=$1 AND is_active=TRUE)::int AS admin_active," +
    " COUNT(*) FILTER (WHERE owner_tenant=$1 AND is_active IS DISTINCT FROM TRUE)::int AS admin_inactive" +
    " FROM ownership", [tenant, VALID_HOST]
  )).rows[0];

  const nodes = (await db.query(
    "SELECT COUNT(*)::int AS total," +
    "COUNT(*) FILTER (WHERE is_active=TRUE)::int AS active," +
    "COUNT(DISTINCT NULLIF(LOWER(TRIM(provider_name)),''))" +
    " FILTER (WHERE is_active=TRUE)::int AS configured_independent_providers," +
    "COUNT(*) FILTER (WHERE is_active=TRUE AND last_health_status='online'" +
    " AND last_ping_at > NOW()-INTERVAL '20 minutes')::int AS online_recent," +
    "COUNT(DISTINCT NULLIF(LOWER(TRIM(provider_name)),''))" +
    " FILTER (WHERE is_active=TRUE AND last_health_status='online'" +
    " AND last_ping_at > NOW()-INTERVAL '20 minutes')::int AS online_independent_providers" +
    " FROM provider_nodes WHERE tenant=$1", [tenant]
  )).rows[0];

  const safe = fields => Object.fromEntries(
    Object.entries(fields || {}).map(([k,v])=>[k,number(v)])
  );
  const inventory = { domains:safe(domains), whitelist:safe(whitelist), nodes:safe(nodes) };
  return { ...inventory, reason:classifyReadiness(inventory.domains,inventory.whitelist,inventory.nodes),
    checked_at:new Date().toISOString(), read_only:true };
}

module.exports = { auditWhitelistReadiness, classifyReadiness };
