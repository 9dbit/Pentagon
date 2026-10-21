# Pentagon TrustPositif: customer whitelist rollout (21 October 2026)

## Scope and production audit

Production Supabase project: `odjsifsxhdesvkyzsnbw` under `9dragons Org`. Railway production branch: `migration/railway-independence`. All changes in this PR are isolated from unmerged migration PR #26 and marketing PR #27.

Production inventory from direct read-only SQL on 21 October:
- `domains`: **0 admin**, **8 demo**; no distinct production customer tenants yet.
- Active `rank_keyword_domains`: **6 rows**, all under two groups in tenant `demo`. Neither group is approved as a real customer.
- Active checker registrations: 3 admin provider nodes; healthy independent provider heartbeats in the preceding 20 minutes: **0**.
- `trustpositif_notification_outbox`: 0 rows; notification attempts: 0; alerts: 0.
- Older source restore has two admin rows representing `google.com` in different historical fleets; neither row is authorization to monitor `google.com` as a Pentagon-owned website. `pentagon.quest` is an alternative custom domain, not a substitute for customer domains.

**No demo record is to be promoted to a production/customer tenant. No synthetic data or test Telegram may enter production.**

## What this PR enables

1. Automatically synchronize *non-demo production tenant* Google Rank whitelist sources into `domains`, preserving the original tenant and project name, with no duplicate inserts on restart. Any active domain already present through the regular domain-monitoring dashboard is already a valid monitoring target (provided it is not a demo/test tenant).
2. Skip disabled domains. If the normalized hostname is already occupied by a different tenant (including demo), or multiple active whitelist sources claim the same hostname, quarantine it for owner review rather than guessing.
3. The administrator TrustPositif report aggregates all production tenants, with tenant identity, project, provider evidence, and existing TrustPositif / Telegram audit state. Tenant-specific views remain isolated.
4. Scoped worker checks all active production customer domains using existing admin provider nodes. Node quorum is recognized **only when at least two distinct providers have ONLINE status and fresh heartbeats within 20 minutes**. Without this, no node task is created, no official lookup is triggered, and no false blocked alert is emitted.
5. Existing exact-indexed Komdigi verification, backoff/cache, two-node anomaly threshold, and durable Telegram outbox remain mandatory. Demo and test tenants may never produce scoped Telegram notifications.
6. No changes to credentials, domain DNS, marketing, historical fleet records or demo tenant rows. No destructive schema migration.

## Operational controls

- Worker remains under `TRUSTPOSITIF_SCOPED_SCHEDULER=true` while legacy `SCHEDULER_ENABLED=false`; the same existing Railway flags apply.
- Dashboard `/api/trustpositif/watchlist` includes `customer_coverage` totals: non-demo whitelist source rows, valid distinct tenant/hostname pairs, conflicts, excluded demo rows, queued inserts, active production monitoring domains. The endpoint is already protected by administrator authentication.
- `no_customer_domains` means zero eligible production domains. `waiting_two_healthy_independent_providers` means the customer targets exist but live checker quorum has not been restored.
- Do not enable demo whitelists just to make the aggregate number nonzero. Customer onboarding must occur in the intended customer/admin tenant with verified authorization. Reconciliation conflicts require explicit owner mapping.
- For a domain entered in more than one customer's Rank whitelist, the current `domains.domain` global uniqueness cannot represent independent ownership safely. Review the conflict; do not bypass constraints. A later explicitly approved tenant-aware schema change may be required for real shared-host monitoring.

## Quality gates

- Isolated Postgres CI: admin/customer whitelist sync, same-domain cross-tenant conflicts, demo collisions, inactive domains, invalid hosts, idempotency, tenant-qualified dashboard, two independent provider votes, mocked official result, Telegram outbox dedupe and restart.
- Existing PostgreSQL consensus, source breaker, outbox audit, React build and mobile layout checks remain mandatory.
- Production after merge: verify both Railway services settle at SUCCESS, `/api/health` returns 200, unauthenticated watchlist remains 401, worker logs show `no_customer_domains` with `demo_excluded=6` until the first approved customer domain exists.
- Domain activation count expected for current legitimate production customer sources: **0**. No real customer can be activated until a genuine whitelisted customer-domain source is available.
- Restore at least two independent checker heartbeats before allowing network scans.

## Rollback

Revert only this PR or roll Railway services back to the previous SUCCESS deployments. Schema unchanged and no demo rows touched. Existing outbox tables and historical alerts must remain; do not delete them. If production source onboarding occurred after this PR, disabling the scoped worker stops new checks without deleting customer data.

