# Pentagon TrustPositif | production data readiness and safe reconciliation

Checkpoint: 20 October 2026. Builds on production PR #31-#34; independent of unfinished data-migration PR #26 and marketing PR #27.

## Production evidence before this fix

Railway scoped worker logs report `heartbeat status=no_active_domains scanned=0 active_nodes=3 whitelist_imported=0` on several five-minute cycles. This confirms the checker loop is alive but has no *active admin-owned domain* to scan. Three registered nodes do not prove that two distinct ISP identities have checked in recently. The production Supabase database is **not** among projects visible to the available Supabase connector, so no production DB edits are authorized from that connection.

A prior local data-reconciliation report on TRADEVICEPC shows `import_allowed=false`, eight ambiguous mapped target domains, and three mismatched node IDs. It is **not** a credential to bulk-promote data or an inventory of current live admin-owned domains. Existing PR #26 stays open.

## Implemented read-only preflight

New `server/trustpositifReadiness.js` performs parameterized SELECT-only counts:
- Existing admin-owned active/inactive domain rows.
- Active Google Rank groups, explicit whitelisted rows, canonical valid unique targets and invalid hostnames.
- Rank targets not represented in global `domains`, targets owned by another tenant, and explicitly disabled admin targets.
- Registered/online recent nodes and **distinct provider names** within a 20-minute window.
- Case-folded duplicates count once per canonical domain.

No hostnames, secrets or other-tenant rows are emitted to deployment logs. The authenticated admin dashboard receives aggregate counts; the `/api/trustpositif/readiness` GET endpoint refuses demo tenant sessions and never calls the Komdigi endpoint. The scoped worker prints aggregate diagnostic counts only when its active-domain count is zero.

Reason codes: `no_approved_admin_domain`, `review_cross_tenant_conflicts`, `eligible_rank_whitelist_pending_sync`, `admin_domains_disabled`, `review_invalid_whitelist_names`, `waiting_two_healthy_independent_providers`, and `ready_to_scan`. A ready-to-scan state only means eligible admin domain and healthy distinct provider registrations, **not** verified TrustPositif membership or completed node checks.

## Authorization and data safety

Do not:
- import the demo tenant or change its ownership;
- auto-reactivate disabled domains;
- replace existing `domains.domain` global uniqueness with a breaking migration;
- import unresolved local backup records;
- emit a BLOCKED status from an invalid/failed official lookup;
- send a test Telegram alert to production.

After the original data-migration PR #26 has a verified, approved source-to-target mapping, use a separate transactional migration with backup, explicit tenant ownership mapping, collision preflight, and post-import domain-parity counts. The existing whitelist sync is idempotent only for **unoccupied valid target domains**; it deliberately does not seize a domain claimed by another tenant.

## Verification and rollback

CI: isolated PostgreSQL 16 fixtures for empty admin, rank targets not imported, cross-tenant collision, invalid name, disabled admin row, two same-provider nodes, two independent online providers, and SELECT-only repeatability. Existing 2-node registry consensus, Telegram outbox, React build, and UI layout suites remain mandatory.

After deploy: verify `/api/health` HTTP 200 and unauthenticated watchlist HTTP 401; inspect `[TrustPositif Scoped] no active targets; reason=...` without actual domain names; visually review 1440/768/390/320px dashboards. Never claim successful operational monitoring while scanned=0.

Rollback: revert only this PR; no schema additions or database writes are introduced here. Do not merge PR #26 or #27 as part of this change. Keep `SCHEDULER_ENABLED=false` and retain existing scoped worker flag/Telegram settings.
