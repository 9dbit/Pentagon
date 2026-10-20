# Pentagon Phase 2 | Fleet-aware offline activation review

Checkpoint: 20 October 2026. This work is isolated from migration PR #26 and marketing PR #27. Neither is merged or activated.

## Verified blocker

Production TrustPositif worker scans zero admin-owned domains; three checker nodes are configured, but no pair of independent providers has recent healthy heartbeats. The local 18 October reconciliation report has eight target-domain mapping conflicts. Each domain has two same-tenant source candidates, **in different fleets**, with no fleet identity available on target. The six target node identities consist of three same-ID tenant conflicts and three source-absent nodes. Name-only or ID-only matches do not establish ownership.

The correct Pentagon Supabase project is odjsifsxhdesvkyzsnbw, but direct project-scoped access is currently denied. Other connected Supabase projects are not substitutes.

## Local execution (TRADEVICEPC only)

Save output to a new filename. No DB or network access is performed by this script.

```powershell
node "C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\pentagon-activation-review.cjs" --report "C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\reconciliation-reports\target-mapping-20261018-1792299635224.json" --out "C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\reconciliation-reports\activation-review-20261020.json"
```

The private JSON output contains each target ID, exact candidate source IDs and fleets, the input report's SHA-256 fingerprint, quarantine status and non-executable review options. Do not commit its real contents or credentials. Existing output cannot be overwritten.

## Independent administrator monitor-only preview (additional local check)

The original source-vs-target inventory shows **2 source admin domain rows, 16 demo domain rows, 8 target demo domain rows and 0 target admin domain rows**. Both source admin rows are active and describe **the same normalized hostname from two distinct source fleets**. They can be viewed as a single *hostname-level, monitor-only* candidate without importing or merging either fleet's historical data. This is NOT approval to insert that hostname into production.

The local-only script starts the previously restored local PostgreSQL cluster on 127.0.0.1:55432 under a verified archived source backup checksum, opens separate repeatable-read READ ONLY sessions on source and target, verifies DB identity and directory, computes canonical-host occupancy and fleet provenance, and stops the cluster. The private output includes the actual domain and project labels for the owner's manual review; never copy or upload that report to public repositories.

```powershell
node "C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\pentagon-admin-activation-preview.cjs" --out "C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\reconciliation-reports\admin-monitor-only-preview-20261020.json"
```

Observed local result: SOURCE_ADMIN=2, SOURCE_ADMIN_UNIQUE_HOSTS=1, TARGET_ADMIN=0, MONITOR_ONLY_CANDIDATE_HOSTS=1, HISTORICAL_MULTI_FLEET_ADMIN_HOSTS=1, ACTIVATION_ALLOWED=false.

A hostname is excluded if it is invalid, disabled in any source fleet, missing its fleet label, duplicated within the same source fleet, reused across source tenants, or already occupied by any target tenant. Preserving both source fleet IDs as *provenance* is not the same as merging their rows. Actual activation requires a current owner attestation, a fresh correct-target backup/inventory, explicit protection against concurrent name claims and an authorized separate release. Never import old tasks or histories as part of this monitor-only activation.

## Optional manual attestations

Use a private JSON file with the exact report_sha256 in the generated review, non-empty reviewed_by/review_ticket, and a genuine reviewed_at_utc. The following values are SYNTHETIC EXAMPLES ONLY:

```json
{
  "type": "pentagon_approved_mapping_review_v1",
  "version": 1,
  "report_sha256": "<exact 64-character digest>",
  "reviewed_by": "authorized-reviewer",
  "review_ticket": "SEC-2026-1020",
  "reviewed_at_utc": "2026-10-20T16:00:00Z",
  "domains": [
    {"target_id":12,"target_tenant":"admin","action":"select_source_fleet",
     "source_id":4,"source_tenant":"admin","source_fleet":"fleet-north"}
  ],
  "nodes": [
    {"target_id":25,"target_tenant":"admin","action":"quarantine_conflict"},
    {"target_id":26,"target_tenant":"admin","action":"preserve_target_only"}
  ]
}
```

Run again with `--decisions "C:\path\to\review-decisions.json"` and a **different** --out path. Only exact same-tenant source ID + fleet combinations recorded in the report can be chosen. Wrong tenant/fleet, duplicate targets or a stale report hash are rejected. Conflicted node IDs cannot be preserved as source-equivalent target nodes; target-only nodes may be preserved without historical source data.

A review decision is not an authorization to run a production import. The tool intentionally cannot import or emit executable SQL and always returns activation_allowed=false.

## Mandatory independent live-release gates

1. Confirm the chosen fleet of each domain with reliable ownership evidence; quarantine historical tasks associated with unresolved node identity.
2. Recover authorized access to the correct Pentagon Supabase project, take a fresh independently verifiable target backup and read-only inventory; do not rely on older October 13/18 snapshots as a live preflight.
3. Approve a target schema that correctly distinguishes tenant + fleet + canonical hostname. The historical global domain uniqueness is not fleet-safe. Preserve target-only tables and existing rows.
4. Perform an isolated rollback rehearsal including domain/node/check-result FK mapping, row counts, RLS security checks and no replay of queued historical tasks.
5. Run UAT for active/disabled/admin/demo domains, two healthy independent providers, official registry failures, persistent alert and Telegram deduplication.
6. Only then create a separate, explicitly approved migration release with a transaction, release lock, rollback point and post-import checks. Do not merge unfinished PR #26 or marketing PR #27 as shortcuts.

## Verification and rollback

Real local report execution produced MANUAL_RECONCILIATION_REQUIRED with all eight domains and six nodes awaiting review. Eleven synthetic safety tests passed on TRADEVICEPC. GitHub CI should rerun them with existing two-node PostgreSQL, Telegram outbox, React build and layout checks. This PR changes only offline scripts, tests, docs and CI; reverting it has no production DB rollback impact. No production credentials, Telegram messages, domain activation, scheduler changes or DNS writes are involved.
