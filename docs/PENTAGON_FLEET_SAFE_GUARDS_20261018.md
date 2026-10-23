# Pentagon fleet-safe application guards (audit branch only)
Date: 2026-10-18

## Decision: DO NOT MERGE OR DEPLOY
This is an incremental fail-closed code change on PR #26, not a production cutover.
The current Supabase target is missing scope columns and required migration tables.
Until schema mapping, staged writes, UAT and explicit owner acceptance pass, keep this
branch unmerged, Replit operational, Railway scheduler unchanged, and Tradevice untouched.

## Changes
- Added server/migrationSafety.js with server-verified tenant/fleet scope and prepared,
  parameterized SQL. A request body or URL query cannot select another tenant or fleet.
- All listed domain list/create/bulk/update/delete, overview, alerts, results and CSV
  routes are gated. Domain mutation uses tenant+fleet and (tenant,fleet,lower(btrim(domain)))
  uniqueness, not global domain name. Wrong-scope records return 404.
- Domain status from provider result now uses verified task domain_id + tenant + fleet,
  never just a shared domain name.
- Queued historical provider_node_tasks have execution_allowed=false by default.
  Only a new enqueue with authenticated node scope and new UUID dispatch_token sets true.
  Poll selects only approved tasks; result requires status=claimed and authorized token,
  and rejects duplicate completion.
- Node management is session-tenant/server-fleet scoped. Duplicate node names are
  rejected/skipped, not used to overwrite existing provider secret keys.
- Unsafe manual scan endpoints intentionally return 503 in this audit revision until
  checker, scheduler and provider cross-fleet logic are fully migrated.

## Activation prerequisites
- Design/review mapping of 18 source domains, 8 existing target domains, nine source
  nodes and six target nodes; validate credentials and owner identity without disclosure.
- Apply reviewed target DDL separately with verified backup/rollback rehearsal:
  domains fleet and composite expression unique index, check_results and alerts tenant/fleet,
  provider_node_tasks tenant/fleet/domain_id/dispatch_token/execution_allowed, provider_nodes
  fleet, rank_keyword_groups fleet and matching dependent scoped indices.
- Review all other domain/project/rank and alert call paths, including
  scheduler.js, nodeChecker.js, rankRoutes.js, analyticsRoutes.js, projectRoutes.js,
  and the node bootstrap/poll/result end-to-end tests. None is declared fully fleet-safe here.
- Only after all routes and local projections are checked, configure server-side
  PENTAGON_ACTIVE_FLEET=domain-radar OR pentagon (approved fleet only) and
  PENTAGON_FLEET_SAFE_SCHEMA_READY=true. This is NOT currently configured.
- The current branch intentionally fails closed if the readiness gate or a signed-in
  session is absent. App UAT is expected to be blocked until activation prerequisites pass.
- Preserve source tenant/fleet and unaltered source records in private historical archive;
  never restore 61,483 old tasks into a live queue and never auto-enable them.
- Perform source delta reconciliation, full encrypted recovery test and authenticated UAT
  before discussing any scheduler handoff or retiring Replit.

## Verified local evidence (TRADEVICEPC only)
node scripts/test-pentagon-migration-safety.js => 32 PASS
node scripts/test-pentagon-route-safety.js => 24 PASS
node scripts/test-pentagon-migration-postgres-local.cjs --run-local => 20 PASS
All seven JS files parsed via node --check.
The SQL smoke test targeted only 127.0.0.1:55432 on the restored Supabase target
snapshot. It exercised composite uniqueness, wrong-tenant/fleet updates/deletes,
rejection of legacy queued tasks and duplicate completion, and ROLLBACK.
No production database SQL, scheduler changes, node secret changes, deploys or PR merges.

The tests prove only the stated isolated properties, not complete app functionality.
