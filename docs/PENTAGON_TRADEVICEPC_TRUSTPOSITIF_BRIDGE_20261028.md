# Pentagon TrustPositif | TRADEVICEPC Verified Source Bridge

Updated: 2026-10-28 (Asia/Jakarta)

## Purpose
Provide official Komdigi `domains_isp` exact membership evidence when the Railway
worker times out downloading the approximately 223 MB file. The source bridge authenticates and imports full-snapshot evidence first.
A separate post-import reconciler can change `global_status` directly to
`blocked` only when there are two recent genuine WARNING observations from
different ISP nodes, a verified TRADEVICEPC exact registry match, and a
post-trigger snapshot. It atomically queues a tenant-qualified alert.
A verified registry negative changes a previously confirmed `blocked`
domain to `warning`; only two further independent healthy WORKING cycles
can restore `normal`. Bridge authentication alone never proves a block.

## Production verified
- TRADEVICEPC remote access: online.
- Source: `https://trustpositif.komdigi.go.id/assets/db/domains_isp`.
- Full source: 222,980,547 bytes; 9,952,119 lines.
- SHA-256: `b2bdb7ae4884159028550b2c7bb2b28edb4e58fda71d10d6848ed4738ce4c477`.
- WISNU123: 5 eligible whitelist domains, 5 membership matches.
- Three direct exact host matches; `www.wisnu123.net` and `www.wisnu123.vip` are parent-apex matches, **not** separate confirmed WWW entries.
- Database audit rows at 2026-10-28 00:34 and 00:44 WIB both record accepted=5 / listed=5.
- TRADEVICEPC scheduled task manual execution returned Windows LastTaskResult=0.

## Runtime source
- Windows task: `PENTAGON-TrustPositif-Registry-Sync`
- Script: `C:\Users\MARKSTUDIOS\AppData\Local\Pentagon\TrustPositifBridge\run-trustpositif-source-bridge.ps1`
- Python worker: `trustpositif-source-bridge.py` in the same directory.
- Schedule: every 5 minutes (adjusted and verified on TRADEVICEPC 28 Oct 2026).
  Each poll checks the small `scan_required` flag; the full ~223 MB
  registry is fetched only following a two-node trigger or a blocked-domain
  recovery recheck.
- Windows principal: `MARKSTUDIOS`, Interactive; task execution requires this
  user's logon session. Do **not** claim it runs before login unless the
  task principal has been explicitly reconfigured and tested.
- HTTPS authenticated bridge: `/api/internal/trustpositif/bridge/inventory`
  and `/api/internal/trustpositif/bridge/evidence`.
- Local bridge token: DPAPI-protected for the Windows user. Do not export to
  the repository, GitHub logs, prompts, chats, or audit output.

## Import safeguards
1. The bridge requests only production rank-whitelisted, active, tenant-bound
   inventory. Demo/test tenants are excluded.
2. The PC streams the full official HTTPS response and hashes every byte.
3. A complete snapshot must meet minimum 100,000,000 bytes and 5,000,000 lines,
   and must match HTTP Content-Length when provided.
4. The backend revalidates membership inventory, exact canonical lookup keys,
   bearer authorization, timestamp freshness, and row count.
5. The initial import transaction updates only
   `trustpositif_domain_monitor.registry_*` fields. After commit,
   reconciliation separately rechecks source provenance, active tenant
   whitelist and 2-provider node quorum before making atomic status/alert
   transitions. This does not bypass the original quorum gate.
6. Source failure, truncated response or incomplete inventory leaves existing
   evidence unchanged. Older verified snapshots cannot overwrite newer ones.
7. Direct Railway snapshots must clear previously stored PC provenance so
   their hash is never misattributed to a different fetched file.
8. Alerts and Telegram are only possible on the independent two-provider
   confirmation path, never from source membership import alone.

## Read-only verification SQL
```sql
SELECT d.tenant,d.domain,d.global_status,
  m.registry_listed,m.registry_checked_at,m.registry_collector,
  m.registry_lookup_domain,m.registry_match_kind,
  m.registry_snapshot_sha256
FROM domains d
LEFT JOIN trustpositif_domain_monitor m ON m.tenant=d.tenant
  AND m.domain=LOWER(TRIM(d.domain))
WHERE d.tenant='wisnu123'
ORDER BY d.domain;

SELECT source_sha256,source_bytes,source_entries,source_checked_at,
  accepted_count,listed_count,imported_at
FROM trustpositif_registry_bridge_audit
ORDER BY id DESC LIMIT 5;
```

## Fail-closed operational notes
- If PC is offline, sleeping or the Windows user is logged out, the Interactive
  scheduled task may not execute. Verify Windows LastTaskResult and last
  accepted audit timestamp, not only the task's enabled setting.
- The Railway direct collector may show `ETIMEDOUT` while the trusted PC
  bridge has successfully verified source membership. The dashboard distinguishes
  these two independent transports.
- Missing or unhealthy provider nodes mean the domain may be listed in the
  official registry, but network blockage remains **unconfirmed**.
