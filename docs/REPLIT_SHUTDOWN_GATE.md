# Pentagon: Replit → Railway + Supabase shutdown gate

**Status:** HOLD. Do not turn off Replit until source database proof, authorized login
and scheduler handover have passed. Production runs on the Railway project
`Pentagon`, service `pentagon-web`, branch `migration/railway-independence`.
The old PostgreSQL `heliumdb` archive has been created in Replit Shell, but offsite
retention, full extraction and test restoration are **not yet verified**.

## 1. Inventory and backup the OLD source

Open the **original Pentagon Replit workspace shell**, not the live
`pentagon.quest` URL. Do **not** change Replit database configuration yet.

1. Verify the current `DATABASE_URL` points to the intended old database without
   printing its value. If the old Replit database is exposed only through
   `DATABASE_URL_DEVELOPMENT`, audit that URL with `--development` and back
   up the same database. Avoid assuming the Replit `DATABASE_URL` points to
   `heliumdb`: identify the source before comparing. On 2026-10-09,
   Replit Shell confirmed `DATABASE_URL` host `helium` and database `heliumdb`.
2. Run `node scripts/migration-audit.js --out=source-audit.json` (or with
   `--development` for the legacy URL). This is a **read-only transaction** and
   outputs counts/schema fingerprints/content fingerprints for every public table.
   It does **not** print raw rows or database credentials.
3. Take an independent complete PostgreSQL archive using `pg_dump -Fc`,
   including all schemas, constraints, sequence state and historical rows.
   Keep the resulting backup **private and off Replit**; do not commit it to
   GitHub or attach it to a public issue. Verify its table-of-contents using
   `pg_restore --list`, test full archive extraction via `pg_restore --file=/dev/null`,
   and perform a separate isolated test restoration before approving shutdown.
   An audit JSON file is **not a substitute for a backup**.
4. Check Replit deployment logs and scheduled jobs for writes that would
   still reach the old PostgreSQL database. Keep Replit online until ready.

If `scripts/migration-audit.js` is absent in the original workspace, first
synchronize the file from the `9dbit/Pentagon` repository. Do not replace
the whole app, alter its secrets, or republish it just to run this audit.

## 2. Audit Supabase TARGET

Use the matching GitHub code and run `node scripts/migration-audit.js
--out=target-audit.json --compare=source-audit.json` in an authorized environment
where `DATABASE_URL` points to **Pentagon** Supabase project
`odjsifsxhdesvkyzsnbw`. Copy only the source audit JSON between environments.
Never transfer database passwords through issues, logs or chat.

Important: **provider-node tasks, provider-node task events, and node telemetry
are durable operational history and must match**. Only authentication sessions
and regenerable caches are excluded from the strict row-level parity gate.
Even these exceptions need a manual sign-off.
**Any business-table difference is a cutover blocker.**

Require exact counts and fingerprints for all business tables, particularly
`projects`, `domains`, `check_results`, `alerts`, `provider_nodes`,
`rank_keyword_groups`, `rank_scan_results`, `trustpositif_checks`,
`app_settings`, `proxies` and Telegram mappings. Verify foreign keys and
sequences, not just row counts. Legacy Replit data includes >76,000 historical
`check_results` and >55,000 `provider_node_tasks`. Source tables contain `tenant`
columns on historical rows that are absent from the previously checked target
schema. **Never directly restore the source custom archive into the active
Supabase database**: restore to an isolated staging database first, inspect
column/FK/sequence differences and plan idempotent, transactional merges.

## 3. Authenticate and test the dashboard

Use a valid existing admin account in the browser. Do not reveal credentials
in repository files or logs.

- Log in; verify `/api/auth/me` says authenticated; navigate Dashboard,
  Projects, Google Rank, Analytics, Defense, Nodes, Users and Settings.
- Verify sessions survive refresh and a controlled Railway restart, then
  confirm logout revokes the session.
- Test protected API endpoints, CSV exports, provider-node operations,
  Telegram alerts, and demo read-only isolation.
- Keep `ADMIN_PASSWORD`, `SESSION_SECRET` and the email whitelist configured.
  Do not reset production passwords merely to make tests pass.

## 4. TrustPositif distinction

A successful provider-node `trustpositif_fetch` task may have
`probe_only=true`: it proves the *source endpoint is reachable*, **not**
that the full ~219 MB registry was downloaded or domain membership checked.
A full exact-domain lookup requires a validated complete local index or
matching results from an Indonesian provider node. Treat `SOURCE_UNAVAILABLE`
as UNKNOWN, never `TIDAK ADA`.

## 5. Scheduler handover

`SCHEDULER_ENABLED=false` in Railway is deliberate while Replit may still
run scheduled jobs.

1. Confirm exactly where each existing periodic check and Telegram digest
   runs and which database it writes to.
2. Stop the OLD source scheduler first, while leaving Replit available for
   rollback.
3. Activate exactly one Railway scheduler, with logs and one replica.
4. Observe a complete domain-check cycle, provider-node polling, rank checks,
   notifications and dashboard history. Verify no duplicate rows/alerts.
5. Have a rollback plan to disable the new scheduler if errors appear.

## 6. Replit shutdown approval

Only approve retirement once:
- [ ] Source PostgreSQL archive stored privately off Replit and restore verified.
- [ ] Business row-count + fingerprint parity: PASS.
- [ ] Admin login, all pages, sessions, logout: PASS.
- [ ] TrustPositif exact list membership and source-failure states: PASS.
- [ ] Scheduled checks and notifications: PASS, no duplicate running system.
- [ ] All node/Telegram/API/export flows: PASS.
- [ ] DNS & TLS confirmed on Railway, monitoring/rollback prepared.
- [ ] Final source backup and final target parity rerun after source writes stop.

Linked operational tracker: https://github.com/9dbit/Pentagon/issues/24

Security: do not put `source-audit.json`, `target-audit.json`, database
backups, credentials, JWTs, cookies or secret URLs into public GitHub commits.
Even hashed fingerprints should generally remain internal.
