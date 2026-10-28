"use strict";

// Finalize trusted TRADEVICEPC registry verdicts as soon as an authenticated
// full snapshot is imported. Only server-persisted recent two-provider warnings
// can cause BLOCKED; a registry absence removes BLOCKED but never invents NORMAL.
// All status/alert/outbox writes use the existing tenant-scoped atomic CAS.
const { pool } = require("./db");
const { isProductionTenant } = require("./customerWhitelistSync");
const {
  distinctSignals, verifiedCollectorEvidence, hasFreshTrigger, evaluateTriggeredPolicy
} = require("./trustpositifTriggerPolicy");
const { enqueueTransition, formatEventMessage } = require("./trustpositifAlertOutbox");

const MAX_WARNING_AGE_MS = 20 * 60 * 1000;
const VERIFIED_POLICY = "tradevicepc_triggered";

async function reconcileVerifiedSnapshot(applied = [], db = pool, options = {}) {
  if (String(process.env.TRUSTPOSITIF_STATUS_POLICY || "").toLowerCase() !== VERIFIED_POLICY)
    return { status: "policy_disabled", examined: 0, blocked: 0, delisted: 0, errors: 0 };

  const now = options.now instanceof Date ? options.now : new Date();
  const tally = { status: "complete", examined: 0, blocked: 0, delisted: 0, errors: 0 };

  // The importer already authenticated and inventory-qualified these keys.
  // Recheck active tenant ownership and whitelist at the moment of transition.
  for (const entry of applied) {
    if (!entry || !isProductionTenant(entry.tenant) || !entry.domain) continue;
    tally.examined++;
    try {
      const { rows } = await db.query([
        "SELECT d.id,d.tenant,d.domain,d.project_name,d.global_status,",
        "m.registry_listed,m.registry_checked_at,m.registry_collector,",
        "m.registry_source,m.registry_lookup_domain,m.registry_match_kind,",
        "m.registry_snapshot_sha256,m.registry_snapshot_bytes,m.registry_snapshot_entries,",
        "m.registry_triggered_at,m.last_anomaly_at,m.anomaly_nodes",
        "FROM domains d JOIN trustpositif_domain_monitor m",
        "ON m.tenant=d.tenant AND m.domain=LOWER(TRIM(d.domain))",
        "WHERE d.tenant=$1 AND LOWER(TRIM(d.domain))=$2 AND d.is_active=TRUE",
        "AND EXISTS (SELECT 1 FROM rank_keyword_domains k",
        "JOIN rank_keyword_groups g ON g.id=k.group_id",
        "WHERE g.tenant=d.tenant AND g.is_active=TRUE AND k.is_whitelisted=TRUE",
        "AND LOWER(TRIM(k.domain))=LOWER(TRIM(d.domain))) LIMIT 1"
      ].join(" "), [entry.tenant, entry.domain]);
      const row = rows[0];
      if (!row || !verifiedCollectorEvidence(row, row.domain, now) ||
          !hasFreshTrigger(row, now)) continue;

      const oldStatus = String(row.global_status || "unknown").toLowerCase();
      let eventType, newStatus, result;
      if (row.registry_listed === true && oldStatus !== "blocked") {
        const lastWarning = row.last_anomaly_at
          ? new Date(row.last_anomaly_at).getTime() : NaN;
        if (!Number.isFinite(lastWarning) || lastWarning > now.getTime() + 60000 ||
            now.getTime() - lastWarning > MAX_WARNING_AGE_MS) continue;
        const stored = Array.isArray(row.anomaly_nodes) ? row.anomaly_nodes : [];
        const ids = [...new Set(stored.map(n => Number(n && n.id))
          .filter(n => Number.isSafeInteger(n) && n > 0))];
        if (ids.length < 2) continue;
        const { rows: activeNodes } = await db.query(
          "SELECT id,name,provider_name,is_active FROM provider_nodes " +
          "WHERE id=ANY($1::integer[]) AND is_active=TRUE", [ids]
        );
        const warnings = stored.map(n => ({
          node_id: n.id, checker_type: "node:cellular",
          status: n.status, reason: n.reason || "",
          http_status: null
        }));
        if (distinctSignals(warnings, activeNodes, "warning").length < 2) continue;
        // The policy revalidates post-trigger full-snapshot provenance.
        result = await evaluateTriggeredPolicy(row, warnings, activeNodes, { db, now });
        if (!result.confirmedBlocked || result.holdBlocked) continue;
        eventType = "BLOCKED";
        newStatus = "blocked";
      } else if (row.registry_listed === false && oldStatus === "blocked") {
        // Registry delisting is definitive, but HTTP/network health is NOT.
        // Leave the domain WARNING until two fresh independent WORKING cycles.
        result = await evaluateTriggeredPolicy(row, [], [], { db, now });
        if (!result.confirmedRecovered || result.holdBlocked) continue;
        eventType = "REGISTRY_DELISTED";
        newStatus = "warning";
      } else {
        continue;
      }

      const message = formatEventMessage({
        domain: row.domain, tenant: row.tenant, project: row.project_name,
        eventType, newStatus, nodes: result.nodes || [],
        confirmedAt: result.verifiedAt, detectedAt: result.detectedAt,
        source: result.source
      });
      const queued = await enqueueTransition({
        domain: row, oldStatus, newStatus, eventType, message, db
      });
      if (queued.queued) {
        if (eventType === "BLOCKED") tally.blocked++;
        else tally.delisted++;
      }
    } catch (err) {
      tally.errors++;
      console.warn("[TrustPositif Immediate] reconciliation failed code=" +
        String(err.code || "RECONCILE_ERROR").replace(/[^A-Z0-9_]/gi, "").slice(0,50));
    }
  }
  if (tally.errors) tally.status = "partial";
  return tally;
}

module.exports = { MAX_WARNING_AGE_MS, reconcileVerifiedSnapshot };
