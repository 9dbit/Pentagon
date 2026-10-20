"use strict";
// Automatic watch: two independent healthy provider-node findings are needed
// before an EXACT local indexed Komdigi registry lookup can confirm a block.
const { pool } = require("./db");
const { normalizeDomain } = require("./checker");

const MIN_NODES = 2;
const TTL_MS = Math.max(900000, Number(process.env.TRUSTPOSITIF_VERIFY_TTL_MS || 21600000));
const RETRY_MS = Math.max(300000, Number(process.env.TRUSTPOSITIF_VERIFY_RETRY_MS || 1800000));
let schemaReady = false;

function reliableNodeAnomalies(results = [], nodes = []) {
  const active = new Map(nodes.filter(n => n && n.is_active !== false).map(n => [String(n.id), n]));
  const distinct = new Map();
  for (const r of results) {
    if (!r || !String(r.checker_type || "").startsWith("node:")) continue;
    const node = active.get(String(r.node_id ?? ""));
    if (!node || distinct.has(String(node.id))) continue;
    const status = String(r.status || "").toLowerCase();
    if (status !== "blocked" && status !== "warning") continue;
    const reason = String(r.reason || "").toLowerCase();
    if (/node error|polling node error|polling timeout|no response from device|agent.*(error|offline|timeout)|invalid_or_missing_subscription|subscription.*missing|unauthorized node|unsupported task/i.test(reason)) continue;
    const evidence = status === "blocked" || Number(r.http_status) === 451 ||
      /trustpositif|internetpositif|nawala|access denied|blocked|block keyword|dns not found|dns error|connection refused|http (403|451|5[0-9][0-9])|http timeout|redirect/i.test(reason);
    if (!evidence) continue;
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
  const { ensureIndexedCache, lookupIndexedDomains } = require("./trustpositifRoutes");
  const cache = await ensureIndexedCache();
  if (!cache?.index?.ready || Number(cache.index.entry_count) <= 0) throw Error("OFFICIAL_INDEX_NOT_READY");
  const result = await lookupIndexedDomains([domain]);
  if (result.entryCount <= 0 || typeof result.matches?.[domain] !== "boolean") throw Error("REGISTRY_RESULT_INVALID");
  return { listed: result.matches[domain], verifiedAt: new Date(), source: "komdigi-domains_isp-exact" };
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
  const nodes = reliableNodeAnomalies(results, activeNodes);
  if (nodes.length < MIN_NODES) return { triggered: false, confirmedBlocked: false, nodes };
  const domain = normalizeDomain(domainRow?.domain);
  if (!domain || domain.length > 253 || !/^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$/.test(domain))
    return { triggered: false, confirmedBlocked: false, nodes };
  const tenant = domainRow.tenant || "admin";
  if (tenant !== "admin") return { triggered: false, confirmedBlocked: false, nodes };
  const db = options.db || pool, lookup = options.lookup || exactOfficialLookup, now = options.now || new Date();
  await ensureMonitorTable(db);
  const rows = await db.query("SELECT * FROM trustpositif_domain_monitor WHERE tenant=$1 AND domain=$2 LIMIT 1", [tenant, domain]);
  const previous = rows.rows[0] || null;
  const verifiedAt = previous?.verified_at ? new Date(previous.verified_at).getTime() : 0;
  const retryAt = previous?.next_check_at ? new Date(previous.next_check_at).getTime() : 0;
  let state = previous;
  let cached = false;
  if (verifiedAt > 0 && now.getTime() >= verifiedAt && now.getTime() - verifiedAt < TTL_MS) {
    cached = true;
  } else if (retryAt > now.getTime()) {
    return { triggered: true, checked: false, confirmedBlocked: false,
      holdBlocked: Boolean(previous?.listed) && domainRow.global_status === "blocked",
      nodes, source: "retry_backoff" };
  } else {
    try {
      const verified = await lookup(domain);
      if (!verified || typeof verified.listed !== "boolean") throw Error("OFFICIAL_VERIFICATION_INDETERMINATE");
      const at = verified.verifiedAt || now;
      const result = await db.query([
        "INSERT INTO trustpositif_domain_monitor",
        "(tenant,domain,listed,verified_at,detected_at,last_anomaly_at,anomaly_nodes,next_check_at,last_error,source,updated_at)",
        "VALUES($1,$2,$3::boolean,$4::timestamptz,CASE WHEN $3::boolean THEN $4::timestamptz ELSE NULL END,$5::timestamptz,$6::jsonb,NULL,'',$7,$5::timestamptz)",
        "ON CONFLICT(tenant,domain) DO UPDATE SET",
        "listed=EXCLUDED.listed,verified_at=EXCLUDED.verified_at,",
        "detected_at=CASE WHEN EXCLUDED.listed THEN COALESCE(trustpositif_domain_monitor.detected_at,EXCLUDED.detected_at)",
        "ELSE trustpositif_domain_monitor.detected_at END,",
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
  if (!state?.listed) return { triggered: true, checked: true, confirmedBlocked: false, nodes, cached, source: state?.source };
  const evidence = makeOfficialEvidence(state, nodes, cached);
  results.push(evidence);
  return { triggered: true, checked: true, confirmedBlocked: true, nodes, cached, source: state.source, evidence };
}

async function listWatchlist(tenant = "admin", db = pool) {
  await ensureMonitorTable(db);
  const response = await db.query([
    "WITH members AS (",
    "SELECT LOWER(TRIM(d.domain)) AS domain,d.project_name,false AS rank_whitelisted",
    "FROM domains d WHERE d.tenant=$1 AND d.is_active=TRUE",
    "UNION ALL SELECT LOWER(TRIM(rkd.domain)),rkg.project_name,true",
    "FROM rank_keyword_domains rkd JOIN rank_keyword_groups rkg ON rkg.id=rkd.group_id",
    "WHERE rkg.tenant=$1 AND rkg.is_active=TRUE AND rkd.is_whitelisted=TRUE),",
    "registry AS (SELECT domain,STRING_AGG(DISTINCT NULLIF(TRIM(project_name),''),', ') AS projects,",
    "BOOL_OR(rank_whitelisted) AS rank_whitelisted FROM members WHERE domain <> '' GROUP BY domain)",
    "SELECT r.domain,COALESCE(r.projects,'') AS project_name,r.rank_whitelisted,",
    "COALESCE(d.is_active,FALSE) AS monitored,COALESCE(d.global_status,'unknown') AS global_status,",
    "d.last_checked_at AS last_node_check_at,s.listed,s.verified_at,s.detected_at,",
    "s.last_anomaly_at,s.anomaly_nodes,s.last_error,s.next_check_at,s.source",
    "FROM registry r LEFT JOIN domains d ON LOWER(d.domain)=r.domain AND d.tenant=$1",
    "LEFT JOIN trustpositif_domain_monitor s ON s.domain=r.domain AND s.tenant=$1",
    "ORDER BY CASE WHEN s.listed=TRUE AND d.global_status='blocked' THEN 0",
    "WHEN s.last_anomaly_at IS NOT NULL AND s.listed IS NULL THEN 1 ELSE 2 END,r.domain",
    "LIMIT 5000"
  ].join(" "),[tenant]);
  return response.rows;
}

module.exports = {
  MIN_NODES, TTL_MS, RETRY_MS, reliableNodeAnomalies,
  ensureMonitorTable, syncAdminWhitelist, checkAfterNodeConsensus, listWatchlist, exactOfficialLookup
};
