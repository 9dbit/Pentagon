# Pentagon Marketing RC1: isolated demonstration sandbox

**Status:** Staging experiment only, *not* a public demo or verified product performance.

## Why this exists

The original Replit landing must remain pixel/content-locked. It links to
\`https://demo.pentagon.quest\`, which does not currently resolve from the
release audit Windows test machine. Changing that link, changing DNS, or
publishing an unsupported demo requires explicit approval.

To unblock the technical demo gate **without altering the landing**, this branch
adds an independent path:

\`https://pentagon-marketing-static-rc1-staging.up.railway.app/demo/\`

The preview is intentionally separated from the real cockpit's API and
authentication. It is a product-interaction sample only, not a remote monitoring
tool or a customer-account test environment.

## What works

- Keyboard-accessible tabs for overview, domains, providers, simulated search
  ranks and alerts.
- Three selectable fixed synthetic scenarios, with Replay Sample advancing
  deterministically through them.
- Domain search/filter, example provider table, ranking changes and local
  alert acknowledgements.
- Responsive desktop/mobile layout with Replit-inspired dark, orange-accent
  identity and original local icon/wordmark assets.
- No passwords, emails, accounts, database, Supabase, cookies, server API, node
  workers, logs of customer actions, or external network requests in client JS.
- Every example domain ends in the DNS-reserved \`.example\` suffix. Provider
  labels are fictional; rank data do not represent Google results.
- Global staging \`X-Robots-Tag: noindex\` and \`robots.txt: Disallow /\` remain.

## What does not work / must not be claimed

- No live network scans or provider/ISP connectivity checks.
- No real-domain uptime or 99.9% accuracy measurement.
- No measured less-than-30-second alert delivery.
- No Google Top 100 crawling.
- No functional penta.quest failover.
- No Telegram/SMS/email delivery or account activation.

The existing Replit landing keeps the original \`demo.pentagon.quest\` CTA
unchanged. After separate owner design/marketing approval, the team can decide
how and where to host a safe public demo, wire up the link and configure TLS/DNS
without merging unrelated production migration code.

## Engineering release gate

Run \`node scripts/test-pentagon-demo-safe.cjs\` for local route/data-isolation
unit checks and \`node scripts/audit-pentagon-marketing-release-gates.cjs --ci\`
for a factual release-blocker report. The GitHub Actions run builds the same
marketing-only Dockerfile and uploads a release-gate JSON artifact marked
\`NO_GO\`.

A green CI run is **not** permission to publish production. Final GO requires:
- approved visual+copy and actual demo product boundaries;
- real-domain/ISP/alert claims verified or specifically approved revisions;
- working requested custom demo domain or approved CTA change;
- pricing and privacy/legal approval;
- whitelist data backup/recovery and operational ownership;
- rollback test, product readiness and explicit owner authorization.

No PR merge, Pentagon production deploy, DNS change or Admin Whitelist change is
authorized by this sandbox.
