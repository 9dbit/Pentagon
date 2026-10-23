# Pentagon marketing launch gate, 18 October 2026

## Decision
**Current status: NOT READY for customer-facing paid marketing.**
The public site and database health respond normally, but public web reachability
does not prove a customer-ready product. No marketing publication, customer
waitlist activation, billing, production deployment or DNS changes were
performed in this audit.

## Tentative dates, conditional on gates
- 21–23 October 2026: pre-launch teaser / SEO landing page / waitlist
  **only after** a public marketing page, correct robots.txt and sitemap.xml,
  consent-based waitlist/contact flow, privacy notice and brand/copy sign-off
  have been built and tested. This phase may communicate the product concept,
  not promise full provider coverage or invite paying customers.
- 28 October–3 November 2026: invitation-only closed beta after staged
  schema migration, fleet-safe projects/rank/analytics/scheduler, valid
  domain/node identity mapping, isolated restore/delta checks and
  authenticated monitoring tests. Use verified beta accounts only.
- 9–16 November 2026: tentative full public onboarding and paid campaign.
  This date is NOT a commitment. GO requires end-to-end provider and
  TrustPositif membership verification, source/target historical parity,
  backup and rollback proof, single scheduler, data access policies,
  authentication/login/logout, support/runbook and owner's explicit sign-off.
  If any gate fails, shift launch rather than lower safeguards.

## Live production website audit
Checked from TRADEVICEPC against https://pentagon.quest at 2026-10-18 09:04 UTC.
The following checks were confirmed without account credentials:
- / returned HTTP 200; /api/health returned HTTP 200, ok=true and
  database=connected; auth and email-whitelist flags were enabled.
- HTML title, meta description, Open Graph title/image, canonical and
  viewport markup present.
- The HTML response is a JavaScript app shell with empty <div id="root"></div>.
  No server-delivered static marketing <main> content.
- /robots.txt HTTP 200 incorrectly returns text/html containing SPA shell,
  not valid robots.txt.
- /sitemap.xml HTTP 200 incorrectly returns text/html containing SPA shell,
  not a valid XML sitemap.
- Public technical automation: 8 PASS / 3 FAIL. Waitlist/consent, customer
  signup, payments, advertising analytics and partner claim validation are
  NOT included in the passing checks and remain unverified.
- Latest audit gate: marketing_prelaunch_ready=false, customer_launch_ready=false.

Reproduce:
  node scripts/test-pentagon-marketing-readiness.cjs
  node scripts/audit-pentagon-marketing-readiness.cjs
The public checker exits 2 if technical pre-launch gates fail. It never
performs authentication, database writes or production changes.

## Engineering launch blockers
- Supabase connector still denies direct project management access for
  Pentagon project odjsifsxhdesvkyzsnbw. Never target a different project.
- Target snapshot: 23 public tables versus 50 source; 29 source-only tables,
  267 missing source columns, 5 type changes, 6 nullability differences.
- Historical provider tasks 61,483 (1,164 queued or claimed) must remain
  in non-executable private quarantine; not a second live scheduler.
- Domain mappings: 16 legacy rows ambiguous across 8 target names and two
  source domains need reviewed creation, not automatic merge.
- Node secrets and actual device IDs must be independently reviewed; do not
  equate node identity with a name or a database primary key.
- Both Railway services online is not evidence that provider checks,
  TrustPositif exact membership or user workflows are functional.
- Project operations: source and target project schema disagree about fleet,
  and rename/delete fan out into unscoped history tables. Audit-branch code
  now refuses those unsafe operations. This intentionally blocks features
  until scoped history and UAT tests are implemented.
- Rank and analytics queries, scheduler, alerts and downstream tables need
  a complete fleet-safe audit. Public Supabase RLS rules need a role-based
  permissions design; existing enabled RLS without policies is not a
  finished customer permissions model.

## Marketing content boundaries
- Permitted pre-launch concept statement: "Pentagon is a command center for
  monitoring domain availability, provider-node health and search visibility."
- Do not claim verified 24/7 coverage, comprehensive all-operator reach,
  guaranteed unblock results, exact TrustPositif detection accuracy, audited
  real-time status, or fully supported customer payments before live proof.
- Do not publish contact-email, app-account signup, subscription pricing or
  an advertising conversion promise without a working and verified pathway.
- Pre-launch channels may be brand social posts, SEO page and invite-only
  outreach after privacy review; broad paid acquisition remains gated.

## Reviewed acceptance order
1. Create a separate indexable marketing landing page, keeping authenticated
   operational dashboard pages out of the marketing sitemap. Include valid
   robots.txt, sitemap.xml, canonical/OG tags, server-rendered core copy.
2. Verify CTA, contact/waitlist destination, consent, privacy/terms, support
   ownership and click-through on desktop/mobile.
3. Complete tenant+fleet schema and application security; preserve source
   history in private tables; verify nodes and checkers end to end.
4. Reconcile Replit delta and final Supabase target backup/recovery proof;
   demonstrate rollback. Authenticate and exercise real UAT flows.
5. Obtain explicit owner go/no-go approval for production cutover and
   public marketing. Replit stays on until that decision.

## Current code and test progress
- Previous application fleet safety 32 unit tests, 24 route tests and
  20 PostgreSQL isolated smoke checks PASS.
- ProjectRoutes audit update in this checkpoint adds 12 structural tests
  and 10 PostgreSQL local scope/rollback tests, both PASS.
- Public marketing readiness script has 10 unit tests PASS.
- No production deployment, schema write, scheduler switch or Tradevice changes.
