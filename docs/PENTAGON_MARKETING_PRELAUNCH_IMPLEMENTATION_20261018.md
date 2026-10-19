# Pentagon public marketing preview (separate, non-production rollout)

Date: 18 October 2026
Scope: brand/product marketing only; no database schema, worker, billing, account or scheduler changes.

## Safe implementation
- Dedicated server-rendered HTML document at `/learn/`, served from `public/learn/index.html` by the Express `registerMarketingStaticRoutes` middleware. The existing operational dashboard stays at `/` and keeps its original React fallback.
- `/learn` redirects to canonical `/learn/`; `robots.txt` responds `text/plain`; `sitemap.xml` responds `application/xml`. Explicit routes return 503 if a public asset is missing, not misleading HTTP 200 SPA HTML.
- SEO title, description, canonical, Twitter and Open Graph metadata; existing brand SVG and OG image reused. Landing includes semantic headings, keyboard accessibility, reduced-motion preference, responsive CSS, and no external tracking script.
- The page is a product preview, not an offer for paid subscriptions; the only link to an app workflow is existing cockpit login at `/`. No email collection or unverified contact address is invented.
- `robots.txt` disallows API routes; sitemap lists only the standalone public marketing page.
- Dedicated public audit checks `/learn/` separately from the dashboard `/`. It only treats SEO/content/robots/sitemap as *technical* pass. Manual marketing readiness and customer launch remain FALSE until approved.

## Verified local tests
- `node scripts/test-pentagon-marketing-readiness.cjs`: 12 tests PASS.
- `node scripts/test-pentagon-marketing-static-local.cjs`: 16 tests PASS with real asset files in a temporary dist tree, explicit route handlers, MIME checks, missing-file fail-closed and preserved dashboard root.
- Existing 32 identity guard and 24 migration route tests continued to pass when tested against the audit sandbox.
- Production `https://pentagon.quest` is NOT yet updated. Public audit there should still fail until the marketing-only changes are separately deployed.

## Marketing business gates, not covered by static tests
1. Owner review and approval of launch copy, visual appearance and claims.
2. Mobile/desktop real-browser visual QA and link/asset verification after staging.
3. Verified opt-in waitlist or support contact channel, consent/privacy notices and request fulfillment policy if collecting leads.
4. A release separate from data migration, with smoke-test rollback of the exact deployment and verified `/learn/`, `/robots.txt`, `/sitemap.xml`, plus unchanged `/` and `/api/health`.
5. **Do not publish paid customer acquisition or acceptance of subscriptions** until Pentagon's production data mapping, provider-node checks, exact TrustPositif membership, auth/security and full UAT have signed off.

## Tentative schedule only
- Target technical pre-launch landing: 21–23 October 2026 if PR review and standalone deployment/smoke checks pass.
- Closed beta: 28 October–3 November 2026 if actual application UAT passes.
- Public/paid acquisition: 9–16 November 2026 only if production migration, single scheduler and owner GO are verified.

Marketing-only PR should branch from `migration/railway-independence`, not merge the migration audit PR #26. Keep #26 draft, never deploy its incomplete schema changes. Replit remains operational until its explicit shutdown gate is accepted.
