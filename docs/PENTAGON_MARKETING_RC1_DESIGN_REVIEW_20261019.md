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
