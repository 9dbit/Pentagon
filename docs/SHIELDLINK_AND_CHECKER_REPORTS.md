# Shieldlink and checker report sources

The archived Replit client `public/assets/index-DZ63_sfG.js`, imported at
`8e9a0e3`, contains the previous ShieldLink interface: stable slug, primary URL,
ordered fallback stock, labels, QR and redirect count. The corresponding server
implementation and legacy Shieldlink tables are absent from the current GitHub
source and production database. This restoration implements that workflow in
the current tenant-scoped backend; it does not claim migration of old slugs.

## Results in Google Rank and Telegram

Every whitelist relationship is shown, including not-found/unscanned rows.
Google rank/page comes from saved central SERP scans. Each checker column has
its own observation and timestamp. Node columns describe HTTP/network results;
AI Checker describes official registry membership. Neither is a Google ranking
measured through the SIM network. The legacy node-labelled rank endpoint calls
the central search API and must not be represented as a real SIM SERP sample.

New network rows retain `check_results.node_id`. Older rows without an ID are
attributed only when the provider name identifies exactly one visible node,
and marked as provider history. Duplicate-provider ambiguity is unknown.
Network evidence older than 20 minutes and registry evidence older than 12 hours
is labelled old. Missing/future observations never become a successful result.
Merchant/viewer endpoints project only own whitelist domains and public checker
aliases; no secrets, IPs or other tenants' domains are returned.

Telegram native tables and text fallback use the same tenant-bound snapshot.
Every domain is retained, with at most eight rows and four checker columns per
page, further split to respect Telegram length limits. Existing verified
recipient routing and schedule are unchanged. No manual test delivery is needed.

## Shieldlink

Management: `/api/merchant/shield-link` (Merchant Admin) and `/api/shield-link`
(platform admin). Public shortlinks: `https://pentagon.quest/s/<slug>`.
Do not assume the old `penta.quest` hostname is configured for this service.

Primary and fallback URLs must be registered active domains of the same tenant
and project. Allowed protocols are HTTP/HTTPS; credentials, explicit nondefault
ports, internal names, IPs and Pentagon redirect loops are rejected. Destinations
are never fetched by the resolver. Query parameters on the shortlink are not
forwarded; use the configured destination URL for campaign parameters.

The resolver selects the primary first, then fallback priority. A destination
must be active, `working`, checked within 24 hours, and not registry-listed.
No eligible destination or a paused link returns 503; missing/deleted slug returns
404. Recovery selects the primary again without deleting fallback stock.
Redirects are 302 with `no-store` and `no-referrer`. GET increments one aggregate
counter; HEAD does not. The feature stores no per-visitor IP/identity, although
infrastructure access logs remain separate and this is not an anonymity service.

The merchant sees a reason and network/registry timestamps for every configured
destination, plus readiness beside available project domains. An active create
or activation without an eligible destination returns 422 `NO_READY_DESTINATION`
and does not write changes. Explicit `is_active: false` creates a draft so the
merchant can configure fallback stock before activation. Existing active links
that lose all eligible destinations remain unavailable until evidence recovers
or the merchant configures an eligible destination; monitoring is never bypassed.
Paused, missing, unavailable and service-error public responses use separate
responsive status pages with no destination/tenant/registry details. Retry links
contain only the validated slug, no visitor query parameters, scripts or trackers.

Schema: `server/shieldLinkSchema.sql`. Additive and idempotent; RLS enabled on
both new tables, with no anon/authenticated/Public grants. All operations flow
through the guarded backend. Apply before deploying new writers. Rollback code
can leave the added column/tables in place without destructive cleanup.

Validation: pure behavior tests in `test-pentagon-shield-rank.cjs`; isolated
PostgreSQL/HTTP tests in `test-pentagon-shield-rank-pg.cjs`; existing report,
auth, tenant, and Telegram outbox tests. Never run fixtures against production.
