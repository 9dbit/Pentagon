# Pentagon Marketing RC1: visual/UX review (19 October 2026)

Branch: feature/pentagon-marketing-prelaunch-20261018, draft PR #27.
Staging: https://pentagon-marketing-static-rc1-staging.up.railway.app/learn/
Production pentagon.quest: NOT modified.

## Baseline evidence
Real Chrome/Puppeteer screenshots captured from isolated staging at 1440x900 desktop, 390x844 mobile, 320x740 small screen.
Before this update, all 3 measured viewports reported document.scrollWidth equal to viewport width (1440/390/320), with successfully loaded Pentagon SVGs and expected CTA destinations.
Earlier clipped CLI screenshot was misleading; true Puppeteer mobile emulation had no horizontal overflow.

## RC1 UX improvements
1. Primary CTA: Explore capabilities, an on-page anchor serving first-time visitors. Secondary CTA: Existing user login, external to https://pentagon.quest/. Header Sign in has accessible label. No fictitious signup/payment flow.
2. Mobile: at widths <=600px, stack hero actions, full-width main button with 52px touch height, centered 44px secondary link, adjust hero/radar spacing and keep wordmark legible at 320/390px.
3. Typography: feature copy 15px, hero lead 18px desktop / 16px phone, notes/footer 12.5px, higher supporting text contrast, less compressed mobile headline.
4. Branding: retain existing Pentagon SVG and OG asset, enlarge icon to 34px desktop and 28px mobile; preserve black/white and restrained orange, avoid duplicated marks.
5. Responsible messaging: feature claims described as intended/design goals while provider coverage is validated. Clearly state no public registration or paid subscriptions.

## Release review requirements
- Unit and Docker CI pass, plus real Chrome viewport review at 320, 375, 390, 430, 768, 1440.
- No horizontal overflow in any tested viewport.
- Both CTA destinations correct and primary anchor scrolls to capabilities.
- Mobile touch target primary >=48px and secondary >=44px.
- Logo and social preview loaded, no broken assets.
- Staging remains noindex, no DB, no scheduler.
- Owner visual/copy approval before merging/deploying any production service.

## Deployment guard
Only separate Railway marketing RC1 preview project and staging service may receive marketing-only commits.
Do NOT merge PR #27, deploy Pentagon production, change DNS, connect databases or activate billing/ad campaigns without separate release approval.

## Final RC1 staging QA evidence (19 October 2026)

- Marketing-only GitHub workflow run 39148028793: completed SUCCESS, including Docker build, real HTTP routing, static preview checks and 22 new design contract assertions.
- Railway project Pentagon Marketing RC1 Preview, environment staging: deployment SUCCESS on marketing commit 506724087c33106fe3bf86a4e2b44696a238257c.
- Real Chrome/Puppeteer tests on staging: **6/6 viewports PASS** (320, 375, 390, 430, 768 and 1440 CSS pixels). No document/body horizontal overflow; all text and controls inside viewport.
- Primary CTA is Explore capabilities (#capabilities) and was clicked successfully on all viewport tests; secondary and header login direct to existing https://pentagon.quest/.
- Brand SVGs loaded, Open Graph preview metadata present; browser returned no page errors.
- On phones <=600px: primary CTA full-width and 52px high (286px at 320 viewport, 356px at 390); secondary CTA >=44px high; lead >=16px and feature copy >=15px.
- Staging responses remain X-Robots-Tag: noindex. No database, scheduler or authenticated production API are wired to this isolated static service.

### Real Chrome screenshots

- [Phone 320px](marketing-rc1-visual/rc1-review-phone320.png)
- [Phone 390px](marketing-rc1-visual/rc1-review-phone390.png)
- [Desktop 1440px](marketing-rc1-visual/rc1-review-desktop1440.png)

These screenshots are directly captured from live isolated staging after RC1 design commit, not generated mockups. Review visual presentation and copy before any publication.

### Release decision

Engineering preview quality gate: PASS. User/owner visual and copy approval: PENDING. Marketing production merge/deploy: BLOCKED pending explicit approval. Paid subscriptions / customer onboarding: blocked until backend migration and product UAT.
