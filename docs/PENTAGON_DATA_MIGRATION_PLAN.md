# Pentagon: staged, non-destructive PostgreSQL migration plan

**State: BLOCKED FOR TARGET PARITY.** This is a migration design and sign-off
checklist, not permission to mutate production. Keep Replit available and
`SCHEDULER_ENABLED=false` in Railway until final cutover conditions pass.

## 16 October 2026: offline target-shape rehearsal and access status

- Desktop Commander on TRADEVICEPC was online. Local Oct 12 Replit dump checksum
  `47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937`
  verified again.
- **Independent offsite source backup verification COMPLETE**: retrieved
  the original encrypted `.age` file from private Google Drive and
  recomputed SHA-256 = `d6feb7646cfbc10ae74760a22cc13c6a267905f79c6c4a441a345b994d77c2ff`;
  length = 5,213,714 bytes, matching the Windows encrypted original.
  Decryption and restore of the *downloaded encrypted file* have NOT been
  separately rehearsed; guard the SSH private key/passphrase.
- **Supabase connector access REGRESSED** after working on 13 October:
  direct `get_project`, project-scoped SQL and `list_branches` now deny
  Pentagon `odjsifsxhdesvkyzsnbw`. `list_projects` only shows the
  Markstudios organization. This is an authorization blocker, not evidence
  that Pentagon production is down; Railway services remain online.
  Never select an unrelated Supabase project or silently change connectors.
- Source-vs-target shape rehearsal performed against isolated localhost
  PostgreSQL 18.6 using the **13 October dated target schema snapshot**.
  Run `scripts/pentagon-target-shape-rehearsal.sql` only on the expected
  `127.0.0.1:55432/pentagon_restore_test` after validating the
  source archive and target snapshot SHA-256.
- The current target's global `UNIQUE(domain)` rule rejected a naive
  source insert (expected). Rehearsing a fleet/tenant-scoped UNIQUE index
  **only on a temporary local clone** allowed all 18 domains, then
  0 duplicate records on a second pass.
- An empty cloned `check_results` target shape, with local compatibility
  fields `tenant`, `fleet`, `reason_type` and timestamptz, accepted
  **84,872 source records** and 0 on the second pass. Full source-to-local
  clone field parity across all relevant columns PASSED.
- **61,483 historical task IDs** staged in a local quarantine-only table
  (second pass = 0), including 1,164 queued/claimed tasks, with
  `execution_allowed=false` for every row.
- The rehearsal transaction was **ROLLED BACK**, trial schema does not
  persist, and local test PostgreSQL was shut down.
- This is **NOT a full Supabase target restoration**: it lacks existing
  target rows, defaults, functions, triggers, extensions, auth and service
  integrations. It tests an explicit target-*like* subset from the
  prior catalog, not the present production database.
- **Unresolved prerequisites:** restore Pentagon organization authorization,
  independently back up the actual Supabase Pentagon target, take a fresh
  current target inventory, reconcile existing target IDs/secrets, and
  rehearse real target data and service UAT. No live import, cutover,
  Replit shutdown or merged migration PR is authorized.

## Verified target access and schema preflight (13 October 2026)

**At the time of this capture, Pentagon project access worked:** the Supabase connector successfully returned
project `odjsifsxhdesvkyzsnbw` ("Pentagon", ap-southeast-1, PostgreSQL 17.11)
using `get_project`, `list_tables`, and READ ONLY SQL. Tradevice's project
`scqzlcivherovlwqypeu` remains accessible. `list_projects` still omits
Pentagon, so always pass and independently verify its exact project reference.

A complete READ ONLY REPEATABLE READ SQL snapshot was collected into a private
file on TRADEVICEPC:

`Pentagon-Migration-Audit/reconciliation-reports/target-preflight-20261013.json`

It includes exact table counts, 205 target columns, 40 constraints, 17
sequences, and RLS flags, but **no raw customer rows or credentials**. The
source/target comparison was executed locally using the pinned source dump.
The resulting private comparison is
`source-reconciliation-1791910958961-edd421.json`.
The local PostgreSQL server was shut down after the audit.

| Audit | Verified |
| --- | ---: |
| Replit source public tables | 50 |
| Supabase target public tables | 23 |
| Shared tables | 21 |
| Source-only tables | 29 |
| Target-only tables | 2 (`suggestion_completions`, `trustpositif_checks`) |
| Source columns missing on target | 267 |
| Target-only columns | 28 |
| Shared column type mismatches | 5 |
| Nullability differences needing review | 6 |
| Target public tables missing RLS | 0 |
| Target `check_results` | 0 (source 84,872) |
| Target `provider_node_tasks` | 3 `done` (source 61,483) |
| Target `domains` | 8 (source 18) |
| Target `provider_nodes` | 6 (source 9) |

Immediate incompatibilities (not instructions to mutate production):

1. Target `domains` has `UNIQUE(domain)` and no `fleet`; source contains
   nine domain-name collisions across fleets in the same tenant. Do not
   merge these records or replace the unique constraint without reviewing
   every application query; use scoped legacy-to-target mapping.
2. Target `provider_nodes` has global `UNIQUE(name)` and lacks source
   `fleet`, `device_id`, `sim_slot`, `pairing_fingerprint`,
   `display_name`. Never overwrite deployed target node secrets.
3. Target `provider_node_tasks` lacks `tenant` and `fleet`, and target
   `provider_node_task_events` does not exist. Source task quarantine
   audit already identified 35,392 cross-tenant node references and 1,164
   queued/claimed historical tasks. All imported task history must remain
   **non-executable** until explicitly mapped and approved.
4. Target `check_results` lacks `tenant`, `fleet`, `reason_type`,
   and uses timestamp without timezone for `checked_at`, unlike the source
   `timestamp with time zone`. Target `alerts.created_at` differs similarly.
   No target field should silently discard historical timezone or reason data.
5. Target lacks `shield_links`, `pentagon_usage_logs`, `usage_logs`,
   and 26 other source-only tables. Historical rows, billing, credential,
   sessions, usage, redirects, and provider events require table-by-table
   policy review; do not import sensitive tables into an exposed schema by default.
6. Target `projects` uses global `UNIQUE(name)`, and several rank tables
   lack source `fleet`. A tenant-aware, fleet-aware policy is required for
   domain/project/rank matching.
7. Supabase security advisor currently reports RLS enabled but **no policies**
   on 23 public tables. This is default-deny for ordinary client access,
   not proof of public exposure. Do not add permissive blanket policies.
   Decide Data API exposure and per-tenant authorization only after reviewing
   actual application access paths.

Source check for required `check_results` fields: all 84,872 restored
records have non-NULL `checker_type`, `provider_name`, and `status`.
All source domain/task rows have non-NULL tenant and fleet.

**Next gates still BLOCKED:** independent verified backup of *existing target*,
approved SQL migration design, rehearsal in disposable non-production
database with target-compatible constraints, legacy-to-target ID maps,
historical task quarantine, authenticated app UAT, scheduler cutover and
rollback proof. **Do not merge PR #26 or shut down Replit.**

## Current recovery and local rehearsal evidence (12-13 October 2026)

- Source snapshot: `pentagon-heliumdb-20261012.dump`, SHA-256
  `47f0c597e7dbd1836379c8244ef06ece46b81eeaeb42b5584888cffc36db0937`.
  Local custom archive verified, decoded, and completely restored on isolated
  PostgreSQL 18.6 on TRADEVICEPC. The test server is not a production database.
- Restored: **50 public tables**, 84,872 `check_results` (33,585 admin /
  51,287 demo), 61,483 `provider_node_tasks` (60,136 admin / 1,347 demo),
  37,989 task events, 18 domains, and 9 provider nodes.
- Restore FK validation and index validation: zero invalid. Seven application
  relationship checks had zero missing parents.
- Encrypted offsite `.age` archive is in the private Google Drive backup folder.
  An independent re-download on 16 October 2026 verified **the complete cloud
  encrypted-file SHA-256**, matching the local encrypted file:
  `d6feb7646cfbc10ae74760a22cc13c6a267905f79c6c4a441a345b994d77c2ff`
  (5,213,714 bytes). Preserve the SSH private key and passphrase separately;
  successful decryption from the cloud copy is a separate recovery exercise.
- Domain scope: **nine normalized domain-name duplicates are within the SAME
  tenant across different fleets**, not across different tenants. The
  proposed key must include **tenant + fleet + normalized domain**. The
  source has zero collisions on that scoped key. Existing target uniqueness
  on `domain` alone (from older, not-current inventory) is a schema blocker.
- Source task hazard: **35,392 admin tasks reference 3 nodes currently labelled
  demo** (34,618 `error`, 774 `queued`). There are 1,164 `queued` or
  `claimed` historical tasks overall. This could be legacy reclassification;
  **do not silently rewrite source task tenant, node references, or history**.
  Preserve original provenance and explicitly review mapping.
- Local task audit `scripts/pentagon-task-quarantine-audit.cjs`: 11 unit
  tests PASS and real read-only audit passed; blocks import by design.
- `scripts/pentagon-offline-mapping-rehearsal.sql`: executed against the
  local restored database in a transaction using TEMP tables, then ROLLBACK.
  Source domain mapping pass inserted 18 then 0 records; historical task
  quarantine pass inserted 61,483 then 0; all 1,164 pending tasks were
  non-executable and all 35,392 cross-tenant task-node references flagged.
  **This is source-only idempotency rehearsal, NOT a Supabase target import.**
- The connected Supabase MCP lists only two unrelated projects, not Pentagon
  target `odjsifsxhdesvkyzsnbw`; access to the correct target remains blocked.
  Therefore target schema parity, target backup, real legacy-to-target ID mapping,
  UAT and Replit shutdown are NOT authorized.

## Verified Replit source evidence (9 October 2026)

The Replit Shell connected to private Postgres `helium/heliumdb`. A custom
archive was created at
`/home/runner/pentagon-private-backups/pentagon-20261009T122713Z.dump`,
SHA-256
`5ebfa1c6a7bd508292bde482f734d17c2d3c262f6d749dfed2dba6dcad809a8a`.
Its entire contents decoded successfully and an **isolated local test restore
passed**. The source database was not changed by this test. A verified private
off-Replit copy is still REQUIRED.

| Source table | Admin rows | Demo rows | Extra notes |
| --- | ---: | ---: | --- |
| `projects` | 0 | 2 | Not evidence of missing admin projects |
| `domains` | 2 | 16 | 18 total, preserve labels/fleet/times |
| `check_results` | 25,569 | 51,287 | 76,856 results |
| `alerts` | 0 | 5 | Notifications are historical |
| `provider_nodes` | 6 | 3 | 9 total, secrets need special handling |
| `provider_node_tasks` | 54,109 | 1,347 | 55,456 tasks, includes JSONB |
| `provider_node_task_events` | 25,950 | 0 | Preserve idempotency keys/JSONB |
| `rank_keyword_groups` | 0 | 4 | Dependent rank results need group map |
| `shield_links` | 0 | 1 | Preserve link and redirect history |
| `pentagon_usage_logs` | 1 | 0 | Preserve usage counts |
| `usage_logs` | 14 | 0 | Preserve usage counts |

Other source tables, non-tenant tables, and newer writes must also be
inventoried. The numbers above reflect a particular source snapshot, **not a
live database total or final parity assertion**.

## Last observed target baseline (before access was denied)

Pentagon Supabase project `odjsifsxhdesvkyzsnbw` had 23 public tables, with
`projects` 2 demo / 0 admin, `domains` 8 demo / 0 admin,
`provider_nodes` 6 admin, `rank_keyword_groups` 2 demo,
`rank_scan_results` 11 demo, `check_results` 0,
`alerts` 0, `provider_node_tasks` 3.
Those counts came from a previous read-only audit; **they are not current**
until rechecked. The connected Supabase account currently visible to the
assistant does **not** expose the Pentagon project. Never run data repair on a
similarly named project in a different account.

The earlier destination column inventory did not show `tenant` for
`check_results`, `alerts` or `provider_node_tasks`. Source has these
columns and also `fleet`; source has several tables not present in the
previous target table inventory.

## Migration process

### Gate A: independent recovery point

- [x] Produce Replit `pg_dump -Fc` with its checksum.
- [x] Decode complete archive and restore to an isolated local PostgreSQL.
- [x] Upload encrypted source archive off Replit (private Google Drive).
- [x] Independently re-download encrypted file and verify full SHA-256/length (16 Oct 2026).
- [ ] Take a **separate verified snapshot of target Supabase** immediately
      before any write. The source backup cannot restore target-side edits.
- [ ] Establish source writer/scheduler status and record capture timestamps.

### Gate B: complete target schema and data inventory

Run `scripts/migration-db-inventory.sql` **read-only** in the Replit Shell
and in the SQL Editor for the *correct* Pentagon Supabase project. Save the
private outputs separately. Check every source table, every target table,
all PK/FKs, `tenant`/`fleet`, RLS, triggers, and owned sequences.

Run `scripts/migration-audit.js` in each respective authorized environment.
Version 2 includes a non-secret database identity and rejects an accidental
source-versus-same-database comparison. It hashes full rows and prints only
aggregates. Re-run both sides from fresh snapshots after data write freeze.
A parity result can never, by itself, mean shutdown approval.

### Gate C: isolated stage and explicit row mapping

Use a separate, private staging PostgreSQL (or non-exposed staging database).
**Do NOT restore the old `.dump` into the live Supabase database**, even with
`--clean`, `--if-exists`, `--data-only`, or `--disable-triggers`.
Reconcile schema differences first. Export only reviewed data from staging.

Required mappings and conflict policies:

1. **Domains**: use an explicit `legacy_domain_id -> target_domain_id` map,
   retaining `tenant`, `fleet`, `created_at`, `last_checked_at`,
   `project_name`, `label`. Natural keys are safe only after uniqueness
   is confirmed. Never overwrite current live statuses blindly.
2. **Check results and alerts**: translate `domain_id` through the approved
   domain map. Preserve original IDs or use deterministic mapping; keep
   timestamps, reason fields, provider names, `tenant`, and `fleet`.
3. **Provider nodes**: reconcile source/target by verified `device_id`,
   fingerprint and operator, not count alone. Build
   `legacy_node_id -> target_node_id` mappings, and migrate extra demo
   nodes only if intentional. **Never overwrite working target node secrets
   or pairing credentials** without key-rotation and node testing.
4. **Tasks and task events**: retain task `id`, `task_type`, `payload`,
   `result`, timestamps and provenance; translate `node_id`, map event
   `task_id`, preserve event `idempotency_key` and JSONB metadata.
   No duplicate task replay, re-execution or notifications.
5. **Rank groups and results**: reconcile project/group identity before
   moving dependent `rank_keyword_domains` and `rank_scan_results`.
6. **Usage and shield history**: create private, RLS-protected destination
   tables where absent. Treat usage counts, redirects, slug uniqueness
   and historical events as durable records.
7. **ID sequences**: after any explicit-ID insert, set each owned sequence
   above the maximum inserted ID using a documented transaction. Check
   primary keys, FK validity, duplicate natural keys and row checksum parity.
8. **Supabase permissions**: new tables under `public` require RLS
   before they are exposed. Never grant `anon` unrestricted access.
   Review application compatibility before deploying schema changes.

All import stages should be **restartable** using a migration-run identifier,
a reversible ID mapping table and conflict reports. Dry-run SQL must show
would-insert, would-update, conflict and missing-parent counts without
mutating target. No automated bulk `ON CONFLICT DO UPDATE` against existing
production data unless each conflict class has been reviewed.

### Gate D: final sync and acceptance

After rehearsing a staging migration:
- [ ] Freeze **old source writes**, including source scheduler and worker.
- [ ] Take a final source snapshot; compute changes since first archive.
- [ ] Apply reviewed idempotent delta migration to Supabase target.
- [ ] Require full historical checks/counts/hashes per tenant and no orphan
      domain, task or ranking relations.
- [ ] Verify production admin login, sessions, logout, dashboard and exports.
- [ ] Verify TrustPositif exact membership (a 219 MB HTTP HEAD probe alone is
      **not** a domain lookup).
- [ ] Enable one Railway scheduler; check a full cycle and Telegram alerts.
- [ ] Confirm DNS/TLS routing and successful rollback rehearsal.
- [ ] Shut down Replit only after independent owner sign-off and all checks.

Related tracking: https://github.com/9dbit/Pentagon/issues/24
