# Pentagon TrustPositif automatic whitelist monitor

## User-facing behavior

- The Trust Positif page now lists monitored active dashboard domains and every domain explicitly whitelisted in active Google Rank keyword groups, including domains that have not yet had a source lookup. The record is shown even if an existing domain has been manually disabled. Disabled domains are not silently reactivated.
- A scheduler cycle first syncs newly whitelisted rank domains to the admin domain monitor using ON CONFLICT DO NOTHING, then performs normal direct/proxy/provider-node checks.
- Automatic official-source verification is permitted only when **two different active provider node IDs** return domain-specific warning/block evidence. A node timeout, disabled node, agent failure, error or direct-only warning does NOT satisfy quorum.
- Only an exact, successfully downloaded and indexed Komdigi `domains_isp` listing can confirm TrustPositif BLOCKED. A HEAD availability probe is not domain membership evidence.
- Official listing result is cached by domain in PostgreSQL for at least **6 hours** (config `TRUSTPOSITIF_VERIFY_TTL_MS`); official source failure is saved as pending and retried no sooner than **30 minutes** (`TRUSTPOSITIF_VERIFY_RETRY_MS`). The large official registry is **not prewarmed automatically on each boot**. The browser's 30-second watchlist refresh reads only local DB, never Komdigi.
- When two independent node reports and the official exact match confirm a block, the domain global status becomes `blocked`, its `last_checked_at` updates, and a `trustpositif_domain_monitor.detected_at` timestamp is persisted. Status changes are inserted into existing `alerts`, surfaced in the dashboard's Alert Center + new notification banner, and sent to configured Telegram bot with node names, reason and WIB timestamp. The existing recurring emergency alert follows its 'Noticed' acknowledgment workflow.
- When one checker subsequently disappears, a previously verified block is preserved rather than incorrectly turned green. Official unavailable or inconclusive results must never be treated as proof of a clean domain.

## Components

| Layer | Change |
| --- | --- |
| Watchlist | GET `/api/trustpositif/watchlist` with tenant-scoped, non-secret status and node evidence |
| Monitor database | `trustpositif_domain_monitor`, with per-domain listing, verification and detection times, anomaly nodes, next retry, last error and source |
| Scheduler | Rank-whitelist sync, two-active-node quorum, fail-closed exact registry check, cached result and existing alert/Telegram path |
| Manual check | The existing single-domain manual check now follows the same quorum path |
| UI | Trust Positif watchlist, search, last check, node votes, blocked timestamp; dashboard notification banner |

## Operations and remaining live dependency

- A deployment can prove **code readiness** through isolated PostgreSQL CI with synthetic `.example` domains, but cannot prove a real domain is listed without a reachable official Komdigi source. Earlier Railway startup logs recorded TrustPositif cache timeouts. If that network path is still unavailable, the monitor must show **verifikasi tertunda** with retry metadata and must not send false block alerts.
- If fewer than two healthy checker nodes return meaningful independent evidence, automatic source lookup is intentionally skipped. The watchlist still displays the domain.
- The Google Rank whitelist is a business whitelist for monitoring, not a claim that a domain appears on the Komdigi blocked list.
- Do not trigger fake Telegram alerts or change live customer status in acceptance tests. Test actual Telegram delivery only during a real confirmed incident or through the existing deliberately requested Telegram test action.
- Global Telegram bot config and project routing settings remain unchanged.

## Release test requirements

1. Isolated PostgreSQL: rank whitelist sync (admin, no demo), disabled domain preservation, one-node and duplicate-node rejection, two-node listed confirmation, cached positive, negative exact result, endpoint failure, retry backoff, previously confirmed blocked preservation.
2. `node --check` backend, Vite build, current shell QA and responsive report checks.
3. Railway deployment `SUCCESS` for pentagon-web, and check provider-node-release rebuild if auto-triggered by the shared branch.
4. Public unauthenticated `/api/trustpositif/watchlist` must remain protected by session auth. Public `/api/health` must stay healthy. In-app status verification requires an authorized reviewer.

**Note:** This release changes the web service's SQL schema additively, only the new monitor table/index; no destructive table migration, no DNS or credential changes.
