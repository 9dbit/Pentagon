# Pentagon: actual-target private archive rehearsal

## Decision

**Private archive rehearsal PASS. Production import, application UAT and Replit shutdown remain BLOCKED.**

On 18 October 2026, a complete two-pass data-preservation rehearsal ran on TRADEVICEPC against the already-restored, actual Supabase target snapshot. It did not use an empty target-like mock. All candidate objects and copies were rolled back. This is an offline preservation test, not completion of the migration into the application's public tables.

## Verified results

| Check | Result |
| --- | ---: |
| Source tables copied with their column types | 50 / 50 |
| Source columns covered | 444 |
| Source rows copied on first pass | 209,730 |
| Additional rows on repeated same-snapshot pass | 0 |
| Full-field SHA-256 and count parity, both passes | 50 / 50 tables |
| Legacy foreign keys validated in private archive | 20 |
| Additional application relationship checks | 7, all zero orphans |
| Historical tasks quarantined | 61,483 |
| Historical queued / claimed tasks inside quarantine | 1,164 |
| Tasks allowed to execute | 0 |
| Attempt to enable task execution | Rejected by CHECK constraint |
| Attempt to assign an unreviewed domain / node mapping | Both rejected by CHECK constraints |
| Private schema access without privileges | Denied |
| Rows visible to a temporary NOLOGIN / NOBYPASSRLS role after test SELECT grants | 0 across 54 tables |
| Precision fixture: bigint, decimal, microsecond timestamp, JSON lexical form, bytea | PASS |
| Existing target public contents, metadata and sequences | Unchanged before / during / after |
| Temporary archive schema and probe role after rollback | Both absent |
| PostgreSQL processes and port 55432 listeners after cleanup | 0 / 0 |
| New isolated unit tests | 32 PASS |

The 54 RLS-tested tables consist of 50 source tables, one synthetic precision fixture, two unresolved mapping tables and one quarantine table. The synthetic fixture is not included in the 209,730 source rows.

Selected source records included: check_results 84,872; provider_node_tasks 61,483; provider_node_task_events 37,989; rank_scan_results 23,828; rank_results 1,374; domains 18; provider_nodes 9; shield_links 1; shield_link_domains 3; pentagon_usage_logs 1; usage_logs 14. All remaining source tables, including empty tables and sensitive legacy tables, were included as well.

## Preservation and safety design

- Endpoints and database names are hard-coded to the two validated local databases at `127.0.0.1:55432`. Production URLs and alternative database names are not accepted. The helper verifies the cluster data directory and server identity before any write.
- Source reads use REPEATABLE READ READ ONLY. The target rehearsal is one transaction that ends in ROLLBACK, including on failure. No existing public table is written, no source sequence/default/trigger is replayed, and no application worker or scheduler is launched.
- Staged tables are named `pentagon_rehearsal_20261018.legacy_<source_table>`, deliberately outside public and distinct from the live task table name. They preserve typed columns, nullability and primary keys. Referential checks are added within this private namespace.
- Column values travel as text inside parameterized JSON, then are cast back to their reviewed PostgreSQL types. They are not parsed as JavaScript dates or numbers. This preserves microseconds, numbers above JavaScript's safe integer range, bytea, and original JSON text.
- The second pass uses primary-key DO NOTHING, never DO UPDATE. Full-field hashes verify that skipping a duplicate did not hide a content mismatch. This is idempotency for one pinned snapshot, not a tested final-delta importer.
- Legacy task payloads, results, timestamps, statuses and tenant/fleet provenance remain intact in the private typed archive. A separate quarantine table has `execution_allowed=false` enforced by a constraint. The live target retains its three existing done tasks unchanged.
- All candidate tables enable and force RLS. PUBLIC has no schema/table access. Test-role privileges exist only inside the rolled-back transaction. Sensitive legacy fields are processed locally and are never printed or uploaded to GitHub.
- Existing target nodes and their credential fields are covered by full-row fingerprints. No secret keys, pairing credentials, tenants or current node IDs are overwritten.

This archive rehearsal does not recreate the original source's operational defaults, triggers, grants or cascading action semantics. It is not a replacement for the original encrypted database backups.

## Unresolved identity decisions

Sixteen source-domain rows map to eight ambiguous target names: two fleets in the same tenant. Two other source domains have no matching target name/tenant. The rehearsal records `AMBIGUOUS_FLEET` or `NEW_REQUIRES_REVIEW` and leaves all target IDs NULL. A CHECK constraint prevents accidental assignment in this helper.

All nine source nodes remain pending device-identity review. Prior actual-target inspection established three same-ID/name tenant conflicts and three target-only nodes. Names or IDs alone are not sufficient to merge node identities. The 35,392 source task-to-node tenant mismatches are retained as legacy provenance, not silently rewritten.

The application's current global-domain ON CONFLICT paths and unscoped status updates must be fixed and tested before any public schema merge. Keeping the historical archive isolated avoids publishing conflicting domain/node identities prematurely.

## Reproducible evidence

Successful local report:

`C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\reconciliation-reports\actual-target-rehearsal-1792300441498.json`

Report SHA-256:

`91d62fca94c9bb97aa688ae301e0d8ce878d07e4d53f758b41976ec96478c3a2`

Target public fingerprint was identical before, during and after the transaction:

`7647b5025da17eb2ce239819b0cd6591905ec3de3220818d5c078f7de4e82989`

Source snapshot SHA-256:

`47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937`

Target raw archive SHA-256:

`03ae4c636bdf0f0555dbf62dd8a52540a6577db9828b5dd6781d0285cca9b51d`

Target encrypted archive SHA-256:

`0cec8fa6b75970bcc6a65903ad68295c6dc0244a498c8899ad2058c00327e85e`

The target snapshot is from 2026-10-18 04:50:27 UTC. The source snapshot is from 12 October, with its latest check_result at 2026-10-12 17:10:46.580491 UTC. Later Replit writes are not covered by this exercise.

The first rehearsal attempt stopped while decoding PostgreSQL `name[]` FK metadata. It rolled back and stopped the local server. Explicit text[] metadata decoding and native-key ordering were corrected, then the complete test above passed. Use the successful report, not the earlier failed report.

## Running the checks

Portable no-database unit tests:

```sh
node scripts/test-pentagon-actual-target-rehearsal.cjs
```

Full rehearsal requires the pinned local archives, existing restored source and target databases, PostgreSQL portable 18.6 and the existing pg dependency on authorized TRADEVICEPC. It refuses to reuse an already-running local cluster or a pre-existing trial schema.

```powershell
node .\scripts\pentagon-actual-target-rehearsal.cjs --run-local
```

Do not run the helper as a Railway start/pre-deploy command. Do not change its endpoint guards to point at Supabase. It is intentionally not a production importer.

## Remaining gates

1. Verified device / tenant / fleet identity decisions and fleet-safe application queries, followed by public-table projection rehearsal.
2. Final source delta capture and target freshness checks; current snapshots do not prove live parity.
3. Target encrypted offsite copy and a decryption round trip; Auth/Storage and application assets coverage.
4. Authenticated login, dashboard, monitoring, provider nodes, analytics, exports and exact TrustPositif membership tests.
5. A single verified scheduler owner, rollback/cutover acceptance and explicit owner approval before stopping Replit.

Railway pentagon-web and provider-node-release were both online when checked in this session, with no staged work. The Supabase connector still denied the Pentagon project-scoped metadata request. No deployment, production DDL/DML, password reset, scheduler switch or Tradevice modification was performed.

Related: PR #26, shutdown blocker #24, and PENTAGON_DATA_MIGRATION_PLAN.md.
