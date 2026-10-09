# Pentagon: staged, non-destructive PostgreSQL migration plan

**State: BLOCKED FOR TARGET PARITY.** This is a migration design and sign-off
checklist, not permission to mutate production. Keep Replit available and
`SCHEDULER_ENABLED=false` in Railway until final cutover conditions pass.

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
- [ ] Store encrypted archive **off Replit** privately; verify exact SHA-256.
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
