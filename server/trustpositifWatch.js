"use strict";
// Legacy quorum policy remains available for isolated regression tests.
 // Production can select two valid warning triggers followed by TRADEVICEPC's
 // signed official registry evidence, independent of node block classification.
const { pool } = require("./db");
const { normalizeDomain } = require("./checker");
const { isProductionTenant, TENANT_SQL, NON_PRODUCTION_SQL } = require("./customerWhitelistSync");

const MIN_NODES = 2;
const TTL_MS = Math.max(900000, Number(process.env.TRUSTPOSITIF_VERIFY_TTL_MS || 21600000));
const RETRY_MS = Math.max(300000, Number(process.env.TRUSTPOSITIF_VERIFY_RETRY_MS || 1800000));
let schemaReady = false;

function reliableNodeAnomalies(results = [], nodes = []) {
  const active = new Map(nodes.filter(n => n && n.is_active !== false).map(n => [String(n.id), n]));
  const distinct = new Map();
  const providerVotes = new Set();
  for (const r of results) {
    if (!r || !String(r.checker_type || "").startsWith("node:")) continue;
    const node = active.get(String(r.node_id ?? ""));
    if (!node || distinct.has(String(node.id))) continue;
    const status = String(r.status || "").toLowerCase();
    if (status !== "blocked" && status !== "warning") continue;
    const reason = String(r.reason || "").toLowerCase();
    if (/node error|polling node error|polling timeout|no response from device|agent.*(error|offline|timeout)|invalid_or_missing_subscription|subscription.*missing|unauthorized node|unsupported task/i.test(reason)) continue;
    // A site outage, DNS failure, HTTP 403/5xx or generic timeout is NOT
    // positive evidence of an ISP block even if two providers see it.
    // Require explicit filtering indicators or HTTP 451 from the checker.
    const explicitBlock=Number(r.http_status)===451 ||
      /internetpositif|trustpositif|nawala|block keyword detected|block page|government (?:block|filter)|unavailable for legal reasons/i.test(reason) ||
      /internetpositif|trustpositif|nawala/i.test(String(r.final_url||"").toLowerCase());
    if (!explicitBlock) continue;
    // Different node IDs on the same upstream provider are not independent ISP votes.
    const providerKey = String(node.provider_name || "").trim().toLowerCase();
    if (!providerKey || providerVotes.has(providerKey)) continue;
    providerVotes.add(providerKey);
    distinct.set(String(node.id), {
      id: node.id, name: String(node.name || "Node " + node.id),
      provider: String(node.provider_name || node.name || ""),
      status, reason: reason.slice(0, 160)
    });
  }
  return [...distinct.values()];
}

async function ensureMonitorTable(db = pool) {
  if (db === pool && schemaReady) return;
  await db.query([
    "CREATE TABLE IF NOT EXISTS trustpositif_domain_monitor (",
    "tenant TEXT NOT NULL DEFAULT 'admin',domain TEXT NOT NULL,listed BOOLEAN,",
    "verified_at TIMESTAMPTZ,detected_at TIMESTAMPTZ,last_anomaly_at TIMESTAMPTZ,",
    "anomaly_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,next_check_at TIMESTAMPTZ,",
    "last_error TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(tenant,domain))"
  ].join(" "));
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS first_anomaly_at TIMESTAMPTZ");
  // Separate exact official-registry membership from provider-quorum
  // confirmation. These fields NEVER by themselves update domains.global_status.
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_listed BOOLEAN");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_checked_at TIMESTAMPTZ");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_source TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_lookup_domain TEXT NOT NULL DEFAULT ''");
  // A remote trusted source bridge supplies full-snapshot provenance. Add
  // columns idempotently for existing and new Supabase deployments.
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_snapshot_sha256 TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_snapshot_bytes BIGINT");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_snapshot_entries BIGINT");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_collector TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_match_kind TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_last_error TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_retry_after TIMESTAMPTZ");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS registry_triggered_at TIMESTAMPTZ");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS recovery_streak INTEGER NOT NULL DEFAULT 0");
  await db.query("ALTER TABLE trustpositif_domain_monitor ADD COLUMN IF NOT EXISTS recovery_last_at TIMESTAMPTZ");
  // Created through backend SQL inside public schema: enable RLS even though
  // client-facing Data API grants are not needed for this private monitor log.
  await db.query("ALTER TABLE trustpositif_domain_monitor ENABLE ROW LEVEL SECURITY");
  await db.query("CREATE INDEX IF NOT EXISTS idx_tp_mon_tenant_status ON trustpositif_domain_monitor(tenant,listed,verified_at DESC)");
  if (db === pool) schemaReady = true;
}

async function syncAdminWhitelist(db = pool) {
  const result = await db.query([
    "INSERT INTO domains(domain,project_name,tenant,is_active)",
    "SELECT DISTINCT ON (LOWER(TRIM(rkd.domain))) LOWER(TRIM(rkd.domain)),",
    "COALESCE(rkg.project_name,''),'admin',TRUE",
    "FROM rank_keyword_domains rkd JOIN rank_keyword_groups rkg ON rkg.id=rkd.group_id",
    "WHERE rkd.is_whitelisted=TRUE AND rkg.is_active=TRUE AND rkg.tenant='admin'",
    "AND LOWER(TRIM(rkd.domain)) ~ '^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$'",
    "ORDER BY LOWER(TRIM(rkd.domain)),rkg.id ASC",
    "ON CONFLICT(domain) DO NOTHING"
  ].join(" "));
  return Number(result.rowCount || 0);
}

async function exactOfficialLookup(domain) {
  const { canonicalRegistryDomain, officialIndexLookup }=require("./trustpositifRegistrySync");
  // Registry index intentionally strips "www". Always query and read the
  // SAME canonical key; otherwise www.example.com causes an invalid result
  // even when the parent domain is listed in the official feed.
  const canonical=canonicalRegistryDomain(domain);
  if(!canonical)throw Error("REGISTRY_DOMAIN_INVALID");
  const result=await officialIndexLookup([canonical]);
  if(typeof result.matches?.[canonical]!=="boolean")throw Error("REGISTRY_RESULT_INVALID");
  return {listed:result.matches[canonical],verifiedAt:new Date(),source:result.source};
}

function makeOfficialEvidence(state, nodes, cached) {
  return {
    checker_type: "provider_registry", provider_name: "TrustPositif",
    status: "blocked", http_status: 451, final_url: "", dns_result: "",
    latency_ms: null, verified_at: state.verified_at,
    reason: "Exact registry match " + (cached ? "(cached)" : "(verified)") +
      "; nodes=" + nodes.length + "; verified_at=" + new Date(state.verified_at).toISOString()
  };
}

async function checkAfterNodeConsensus(domainRow, results, activeNodes, options = {}) {
  if(String(process.env.TRUSTPOSITIF_STATUS_POLICY||"").toLowerCase()==="tradevicepc_triggered")
    return require("./trustpositifTriggerPolicy").evaluateTriggeredPolicy(
      domainRow,results,activeNodes,options);
  const nodes = reliableNodeAnomalies(results, activeNodes);
  const domain = normalizeDomain(domainRow?.domain);
  if (!domain || domain.length > 253 || !/^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$/.test(domain))
    return { triggered: false, confirmedBlocked: false, nodes };
  const tenant = domainRow.tenant || "admin";
  if (!isProductionTenant(tenant)) return { triggered: false, confirmedBlocked: false, nodes };
  const db = options.db || pool, lookup = options.lookup || exactOfficialLookup, now = options.now || new Date();
  if (nodes.length < MIN_NODES && domainRow.global_status !== "blocked") {
    // A single credible provider finding is Suspected, never Blocked.
    // Preserve it for dashboard evidence without contacting Komdigi.
    if (nodes.length) {
      await ensureMonitorTable(db);
      await db.query(
        "INSERT INTO trustpositif_domain_monitor(tenant,domain,first_anomaly_at,last_anomaly_at,anomaly_nodes,updated_at) " +
        "VALUES($1,$2,$3,$3,$4::jsonb,$3) ON CONFLICT(tenant,domain) DO UPDATE SET " +
        "first_anomaly_at=CASE WHEN trustpositif_domain_monitor.last_anomaly_at IS NULL OR " +
        "trustpositif_domain_monitor.last_anomaly_at < EXCLUDED.last_anomaly_at-INTERVAL '20 minutes' " +
        "THEN EXCLUDED.first_anomaly_at ELSE COALESCE(trustpositif_domain_monitor.first_anomaly_at,EXCLUDED.first_anomaly_at) END," +
        "last_anomaly_at=EXCLUDED.last_anomaly_at,anomaly_nodes=EXCLUDED.anomaly_nodes,updated_at=EXCLUDED.updated_at",
        [tenant,domain,now,JSON.stringify(nodes)]
      );
    }
    return { triggered: false, confirmedBlocked: false, nodes, suspected:Boolean(nodes.length) };
  }
  await ensureMonitorTable(db);
  const rows = await db.query("SELECT * FROM trustpositif_domain_monitor WHERE tenant=$1 AND domain=$2 LIMIT 1", [tenant, domain]);
  const previous = rows.rows[0] || null;
  if (nodes.length < MIN_NODES) {
    // Do not silently clear a previously VERIFIED block merely because the
    // network temporarily has fewer valid node votes. No official lookup here.
    return { triggered: false, confirmedBlocked: false,
      holdBlocked: Boolean(previous?.listed) && domainRow.global_status === "blocked",
      nodes, source: "previous_verified_listing" };
  }
  const verifiedAt = previous?.verified_at ? new Date(previous.verified_at).getTime() : 0;
  const retryAt = previous?.next_check_at ? new Date(previous.next_check_at).getTime() : 0;
  let state = previous;
  let cached = false;
  if (verifiedAt > 0 && now.getTime() >= verifiedAt && now.getTime() - verifiedAt < TTL_MS) {
    cached = true;
    // Refresh the node evidence even when the registry verdict is still cached.
    // Keeping an old quorum snapshot can mislead the dashboard timestamp.
    await db.query(
      "UPDATE trustpositif_domain_monitor SET last_anomaly_at=$3,anomaly_nodes=$4::jsonb,updated_at=$3 WHERE tenant=$1 AND domain=$2",
      [tenant,domain,now,JSON.stringify(nodes)]
    );
    state = { ...previous, last_anomaly_at: now, anomaly_nodes: nodes };
  } else if (retryAt > now.getTime()) {
    return { triggered: true, checked: false, confirmedBlocked: false,
      holdBlocked: Boolean(previous?.listed) && domainRow.global_status === "blocked",
      nodes, source: "retry_backoff" };
  } else {
    try {
      const registryAt=previous?.registry_checked_at?new Date(previous.registry_checked_at).getTime():0;
      const registryFresh=registryAt>0 && registryAt<=now.getTime()+300000 &&
        now.getTime()-registryAt<TTL_MS &&
        typeof previous?.registry_listed==="boolean";
      // Reuse freshly audited source evidence, but NEVER count it as a block
      // until this code has also received two independent credible node votes.
      const verified=registryFresh
        ? {listed:previous.registry_listed,verifiedAt:new Date(registryAt),
           source:previous.registry_source||"komdigi-domains_isp-exact-index"}
        : await lookup(domain);
      if (!verified || typeof verified.listed !== "boolean") throw Error("OFFICIAL_VERIFICATION_INDETERMINATE");
      const at = verified.verifiedAt || now;
      const result = await db.query([
        "INSERT INTO trustpositif_domain_monitor",
        "(tenant,domain,listed,verified_at,detected_at,first_anomaly_at,last_anomaly_at,anomaly_nodes,next_check_at,last_error,source,updated_at)",
        "VALUES($1,$2,$3::boolean,$4::timestamptz,CASE WHEN $3::boolean THEN $5::timestamptz ELSE NULL END,",
        "CASE WHEN $3::boolean THEN $5::timestamptz ELSE NULL END,$5::timestamptz,$6::jsonb,NULL,'',$7,$5::timestamptz)",
        "ON CONFLICT(tenant,domain) DO UPDATE SET",
        "listed=EXCLUDED.listed,verified_at=EXCLUDED.verified_at,",
        "detected_at=CASE WHEN EXCLUDED.listed THEN COALESCE(trustpositif_domain_monitor.detected_at,",
        "CASE WHEN trustpositif_domain_monitor.last_anomaly_at >= EXCLUDED.last_anomaly_at-INTERVAL '20 minutes'",
        "THEN COALESCE(trustpositif_domain_monitor.first_anomaly_at,EXCLUDED.detected_at)",
        "ELSE EXCLUDED.detected_at END) ELSE NULL END,",
        "first_anomaly_at=CASE WHEN EXCLUDED.listed THEN COALESCE(trustpositif_domain_monitor.detected_at,",
        "CASE WHEN trustpositif_domain_monitor.last_anomaly_at >= EXCLUDED.last_anomaly_at-INTERVAL '20 minutes'",
        "THEN COALESCE(trustpositif_domain_monitor.first_anomaly_at,EXCLUDED.first_anomaly_at)",
        "ELSE EXCLUDED.first_anomaly_at END) ELSE NULL END,",
        "recovered_at=CASE WHEN EXCLUDED.listed THEN NULL",
        "WHEN trustpositif_domain_monitor.listed IS TRUE THEN EXCLUDED.verified_at",
        "ELSE trustpositif_domain_monitor.recovered_at END,",
        "last_anomaly_at=EXCLUDED.last_anomaly_at,anomaly_nodes=EXCLUDED.anomaly_nodes,",
        "next_check_at=NULL,last_error='',source=EXCLUDED.source,updated_at=EXCLUDED.updated_at",
        "RETURNING *"
      ].join(" "),[tenant,domain,verified.listed,at,now,JSON.stringify(nodes),verified.source || "official-exact"]);
      state = result.rows[0];
    } catch (err) {
      const safeError = String(err?.code || err?.message || "OFFICIAL_SOURCE_UNAVAILABLE").slice(0,130);
      await db.query([
        "INSERT INTO trustpositif_domain_monitor",
        "(tenant,domain,last_anomaly_at,anomaly_nodes,next_check_at,last_error,updated_at)",
        "VALUES($1,$2,$3,$4::jsonb,$5,$6,$3)",
        "ON CONFLICT(tenant,domain) DO UPDATE SET",
        "last_anomaly_at=EXCLUDED.last_anomaly_at,anomaly_nodes=EXCLUDED.anomaly_nodes,",
        "next_check_at=EXCLUDED.next_check_at,last_error=EXCLUDED.last_error,updated_at=EXCLUDED.updated_at"
      ].join(" "),[tenant,domain,now,JSON.stringify(nodes),new Date(now.getTime()+RETRY_MS),safeError]);
      return { triggered: true, checked: false, confirmedBlocked: false,
        holdBlocked: Boolean(previous?.listed) && domainRow.global_status === "blocked",
        nodes, source: "official_unavailable", lastError: safeError };
    }
  }
  if (!state?.listed) return { triggered: true, checked: true, confirmedBlocked: false,
    confirmedRecovered: Boolean(previous?.listed) && domainRow.global_status === "blocked",
    nodes, cached, source: state?.source, verifiedAt: state?.verified_at,
    recoveredAt: state?.recovered_at };
  const evidence = makeOfficialEvidence(state, nodes, cached);
  results.push(evidence);
  return { triggered: true, checked: true, confirmedBlocked: true, nodes, cached,
    source: state.source, evidence, verifiedAt: state.verified_at,
    detectedAt: state.detected_at };
}

async function listWatchlist(tenant = "admin", db = pool) {
  await ensureMonitorTable(db);
  // The administrator's report spans every production tenant while retaining
  // tenant-qualified evidence. Customer/demo sessions see only their tenant.
  const visibility = "(($1='admin' AND tenant ~ $2 AND tenant !~* $3) OR ($1<>'admin' AND tenant=$1))";
  const response = await db.query([
    "WITH members AS (",
    "SELECT LOWER(TRIM(d.domain)) AS domain,d.project_name,false AS rank_whitelisted,d.tenant",
    "FROM domains d WHERE d.is_active=TRUE AND " + visibility.replace(/\btenant\b/g,"d.tenant"),
    "UNION ALL SELECT LOWER(TRIM(rkd.domain)),rkg.project_name,true,rkg.tenant",
    "FROM rank_keyword_domains rkd JOIN rank_keyword_groups rkg ON rkg.id=rkd.group_id",
    "WHERE rkg.is_active=TRUE AND rkd.is_whitelisted=TRUE",
    "AND " + visibility.replace(/\btenant\b/g,"rkg.tenant"),"),",
    "registry AS (SELECT tenant,domain,STRING_AGG(DISTINCT NULLIF(TRIM(project_name),''),', ') AS projects,",
    "BOOL_OR(rank_whitelisted) AS rank_whitelisted FROM members WHERE domain <> '' GROUP BY tenant,domain)",
    "SELECT r.tenant,r.domain,COALESCE(r.projects,'') AS project_name,r.rank_whitelisted,",
    "COALESCE(d.is_active,FALSE) AS monitored,COALESCE(d.global_status,'unknown') AS global_status,",
    "d.last_checked_at AS last_node_check_at,s.listed,s.verified_at,s.detected_at,s.recovered_at,s.first_anomaly_at,",
    "s.last_anomaly_at,s.anomaly_nodes,s.last_error,s.next_check_at,s.source,",
    "s.registry_listed,s.registry_checked_at,s.registry_source,s.registry_lookup_domain,",
    "s.registry_last_error,s.registry_retry_after,",
    "s.registry_snapshot_sha256,s.registry_snapshot_bytes,s.registry_snapshot_entries,",
    "s.registry_collector,s.registry_match_kind,s.registry_triggered_at,",
    "s.recovery_streak,s.recovery_last_at",
    "FROM registry r LEFT JOIN domains d ON LOWER(TRIM(d.domain))=r.domain AND d.tenant=r.tenant",
    "LEFT JOIN trustpositif_domain_monitor s ON s.domain=r.domain AND s.tenant=r.tenant",
    "ORDER BY CASE WHEN s.listed=TRUE AND d.global_status='blocked' THEN 0",
    "WHEN s.last_anomaly_at IS NOT NULL AND s.listed IS NULL THEN 1 ELSE 2 END,r.tenant,r.domain",
    "LIMIT 5000"
  ].join(" "),[tenant,TENANT_SQL,NON_PRODUCTION_SQL]);
  return response.rows;
}

module.exports = {
  MIN_NODES, TTL_MS, RETRY_MS, reliableNodeAnomalies,
  ensureMonitorTable, syncAdminWhitelist, checkAfterNodeConsensus, listWatchlist, exactOfficialLookup
};
