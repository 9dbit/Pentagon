# Pentagon TrustPositif notification delivery and operator runbook (20 October 2026)

## Change boundary

This patch builds on merged PR #31/#32/#33. Only the **scoped TrustPositif worker** uses the durable Telegram outbox. Full legacy scheduler remains disabled in Railway production. No PR #26 migration or #27 marketing changes are included.

## Event flow

1. Reconcile admin-owned Google Rank whitelist idempotently, plus existing active domain monitors.
2. A single credible checker observation is stored as **Suspected** and never invokes Komdigi by itself.
3. Two distinct active node IDs from two distinct provider names must report evidence in the same bounded scan.
4. A genuine indexed exact-match Komdigi result is required for **Blocked**. Source timeout, cache errors, HTTP HEAD or network failures cannot confirm a block.
5. The scoped worker writes the domain status, dashboard `alerts` row and `trustpositif_notification_outbox` record **in one PostgreSQL transaction** using a compare-and-set condition.
6. A separate bounded delivery ticker claims pending events using `FOR UPDATE SKIP LOCKED` and sends through configured Telegram bot. A successful delivery sets the outbox status to `sent` and `alerts.sent_to_telegram=true`. One alert row maps to one outbox row.
7. Definite negative delivery outcomes (such as Telegram 429 or DNS resolution failure before connecting) can retry with exponential backoff. Ambiguous timeouts, resets or crashed in-flight sends remain `uncertain` or `sending` for operator review and **must not be automatically resent**, because Telegram `sendMessage` does not expose a client idempotency key. Thus exactly-once external delivery cannot be proven; duplicate risk is reduced by withholding ambiguous retries.
8. Verified registry delisting creates `REGISTRY_DELISTED`, clears historical registry blocked status to **warning** while network evidence is still anomalous, and queues a recovery notice. The label is not a claim that all ISPs are healthy.

## Monitoring, audit and secrets

- On authenticated `/api/trustpositif/watchlist`, the UI displays whitelist coverage, scoped-worker health, recent healthy/active checker counts, network/registry evidence, WIB dates and tenant-scoped outbox metrics and attempts.
- `trustpositif_domain_monitor` stores both `first_anomaly_at` (earliest recent credible observation) and `verified_at` (source confirmation) with UTC timestamps; a new incident resets its detection episode after stale gaps and delisting.
- `trustpositif_notification_attempts` contains outcomes and sanitized error codes only. Telegram bot token, chat ID, passwords and raw HTTP error objects must never be included in log output or dashboard responses.
- Outbox tables are additive, private to the backend database connection and have RLS enabled with no public policies; do not expose them through the Data API.
- Retention of PostgreSQL history survives service restart. A destructive domain deletion follows the existing legacy FK cascade contract, so export/archive before customer deletion where audit retention is legally needed.

## Production gating

- CI: isolated PostgreSQL consensus, outbox, backoff, status-on-restart, synthetic delivery, React build and static CSS/layout checks. Reserved `.example` domains only; no live bot/registry traffic.
- Railway: both `pentagon-web` and `provider-node-release` must settle at SUCCESS. New log lines should show `[TrustPositif Scoped] cycle started` and `heartbeat status=...` every five minutes when enabled.
- `GET /api/health` should return HTTP 200 with connected DB; unauthenticated `GET /api/trustpositif/watchlist` must remain HTTP 401.
- Real monitoring requires two active independent admin-owned provider nodes, live data parity and official source access. Synthetic CI does not prove live Telegram delivery or a real Komdigi positive.
- Browser layout must be manually verified on 1440/768/390/320px if an authenticated session is not available to CI.

## Rollback

1. For immediate stop of new scoped checks and delivery, set `TRUSTPOSITIF_SCOPED_SCHEDULER=false` on `pentagon-web`; **never** enable full `SCHEDULER_ENABLED` as a substitute.
2. Revert only this feature merge commit (or roll back both Railway services to the previously known GOOD deployments) without changing credentials, DNS or database rows.
3. New outbox tables and additive monitor timestamp columns can remain in DB during rollback; deleting them would destroy alert audit history. Preserve a DB snapshot before schema removals.
4. Restore the scoped flag only after the two-node preflight and baseline health checks pass.

## Known limitation

The connected Supabase account inventory may not expose the actual Pentagon production Postgres project. Without authorized read access, monitored domain totals, independent node health and actual Telegram delivery cannot be attested by CI or Railway deployment status alone.
