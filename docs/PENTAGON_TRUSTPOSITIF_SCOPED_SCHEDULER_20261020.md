# Pentagon TrustPositif scoped scheduler hardening (20 October 2026)

## What this fixes

The two-node TrustPositif whitelist watcher from PR #31 is present in production, but the Railway web service has \`SCHEDULER_ENABLED=false\`. Enabling the full legacy scheduler is unsafe before the larger migration's schema and worker controls are signed off.

This patch adds a **separately opt-in scoped worker**, independent of the legacy scheduler:

- \`TRUSTPOSITIF_SCOPED_SCHEDULER=true\` enables only TrustPositif provider-node checks, not the full scheduler or rank crawler.
- Default interval: 5 minutes (\`TRUSTPOSITIF_SCOPED_INTERVAL_MS\`, min 2 minutes).
- Default batch: 4 admin domains per tick (\`TRUSTPOSITIF_SCOPED_BATCH_SIZE\`, capped at 20).
- Round-robin cursor gives broad coverage over successive ticks; no single cycle attempts every domain.
- Up to 4 provider nodes per domain, capped at 6; only **two separate active node IDs** with meaningful anomaly evidence may trigger an official check.
- Admin-only domains and admin-owned nodes; demo data and test tenants are excluded.
- Existing rank whitelist is reconciled before node-readiness check; manually disabled domains remain disabled, not secretly reactivated.
- Only a **confirmed positive exact Komdigi indexed lookup** (or an existing confirmed block being held) may cause scoped worker status updates. A single failing node, general HTTP error, missing migration schema, or a failed official request leaves status unchanged.
- Existing status-transition records, dashboard alert banner, Telegram report and acknowledgment workflows are reused.
- Official source cache remains 6 hours; a persisted shared-download circuit breaker stops repeated large download attempts for at least 30 minutes after endpoint failure (default one hour).
- Cached registry votes still update node evidence; a delisted domain clears its old first-detected timestamp so a future confirmed episode gets its own timestamp.
- The Trust Positif watchlist displays worker enabled/paused/waiting state and latest cycle time.

## Deployment / safety

The default is disabled. Only enable this scoped worker while \`SCHEDULER_ENABLED=false\`. If the main scheduler is enabled, the scoped worker refuses to start.

Production preflight: required Postgres tables, at least 2 active admin-owned provider checker nodes, and availability of the trustpositif domain watch monitor. All unverified or unavailable results fail closed.

**Do not perform a fake production block to test notifications.** The automated CI tests use synthetic .example domains and do not contact Komdigi or Telegram.

The actual Supabase admin connector was unable to access the database at the time of development (permission denied). Runtime preflight protects the service, but **real-node health, actual monitored-domain totals, and live Telegram delivery must be verified from approved dashboard access or Railway logs** after enabling.

## Release checks

- Synthetic Postgres integration: whitelist reconciliation, disabled-domain preservation, two distinct node quorum, source fail closed, per-domain TTL/backoff, cached node evidence refresh, and a fresh detected timestamp when a domain is delisted then later confirmed again.
- Circuit breaker unit: no official HTTP call while cooldown is active, including after module restart.
- JavaScript source checks, full Vite build, and existing report UI contract.
- Confirm both Railway services healthy, \`/api/health\` still responds, and anonymous \`/api/trustpositif/watchlist\` remains protected.
- Verify \`TrustPositif Scoped\` startup log and either completed scan or explicit waiting reason. Real blocked alerts occur **only after actual two-node anomalies and exact official match**.

No domain/DNS change, credentials rotation, arbitrary admin grants, production DB reset, Telegram test messages, or blanket legacy scheduler activation.
