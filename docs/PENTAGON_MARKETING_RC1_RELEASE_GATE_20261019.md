# Pentagon Marketing RC1 release gate | 19 October 2026

## Decision: STAGING PREVIEW READY; PUBLIC MARKETING RELEASE NOT YET APPROVED

Scope: Replit-parity landing page in GitHub draft PR #27 (`feature/pentagon-marketing-prelaunch-20261018`), isolated Railway project `Pentagon Marketing RC1 Preview`, staging service `pentagon-marketing-static-rc1`. Never merge PR #27, modify Pentagon production, change DNS or enable paid/public account registration without a separate owner GO.

## Completed and verified
| Gate | Result | Evidence |
| --- | --- | --- |
| Original Replit design and content | PASS | Original public DOM, original compiled CSS, original logo PNG, dashboard mockup, 7 feature cards, ShieldLink, pricing/footer; screenshot parity at 320/390/768/1440 px |
| Join Whitelist | PASS ON STAGING | Consent required, same-origin POST, HTTP 202 pending, requests saved only in private staging Railway volume |
| Review dashboard | PASS ON STAGING | `/review/` has passphrase-only login, Secure HttpOnly SameSite=Strict session cookie, CSRF, 4h session, throttled auth |
| Reviewer operations | PASS ON STAGING | Pending -> Approved for outreach -> Rejected / Reopen, CSV export, explicit delete, retention cleanup; no admin-access grant |
| Browser E2E | PASS | Chrome desktop and 390px phone for review login; live synthetic submit/approve/export/delete/logout, earlier synthetic QA entries removed |
| CI and Docker | PASS | GitHub Actions run 39194866721 (all 11 stages successful), isolated Dockerfile with no database, scheduler, or production API |
| SEO preview isolation | PASS | X-Robots-Tag noindex + robots Disallow /; stage-only canonical/OG review |
| Pentagon production unchanged | PASS | pentagon-web and provider-node-release online, PR #26 and #27 remain Draft and unmerged |

## Open blockers to PUBLIC marketing release
| Risk | Current evidence | Required gate |
| --- | --- | --- |
| Demo CTA broken | Windows DNS resolver cannot resolve `demo.pentagon.quest` on Oct 19, 2026. Original Replit marketing CTA links to this hostname. | Provision and verify a genuine working demo in a controlled environment, or get owner approval to revise/remove demo CTA. Do not silently redirect to admin login. |
| 99.9% uptime accuracy | Marketing source claim copied verbatim; no independent 30-day measured uptime/accuracy report. | Prove with reproducible monitored checks and scope; otherwise replace the numerical guarantee with qualified copy after owner approval. |
| Alert latency <30 seconds | `server/checker.js` uses up to 15 seconds timeout; `server/nodeChecker.js` uses 25 seconds, but total scan + classification + Telegram delivery SLA is not established. | Timestamped end-to-end P95/P99 alert test across providers, or remove numerical claim with approved copy. |
| 6+ ISP networks covered | Marketing source assertion, not confirmed by recent live provider-node success and distinct network enumeration. Number of nodes is not number of ISPs. | Active network coverage and successful tests from each named provider, or qualify copy. |
| Google Top 100 | `server/rankRoutes.js` supports result collection up to 100; operational API quotas and supported coverage were not independently verified. | Demonstrate actual Top 100 result set and quota behavior before claiming universal coverage. |
| ShieldLink always online | `penta.quest` resolves and serves HTTP 200, but real failover/redirect sequence from blocked primary to fallback has not been exercised. | Test full failover and rollback on isolated domains, or qualify. |
| Pricing | The original Replit rendered `.lp-pricing-grid` has zero plan cards despite heading 'Simple, transparent plans'. | Publish verified plans/prices, or obtain approval to replace with contact-sales language. |
| Privacy & leads | Privacy Notice drafted in staging. Data volume is private and opt-in is required. | Owner/legal approve consent, retention, deletion policy and email contact. Add backups/access policy before public lead acquisition. |
| Production serving | Staging `/api/whitelist` is not wired to `pentagon.quest`, production has no new marketing handler. | Design independent public marketing hosting and API routing, release/rollback runbook and owner final approval. |

## Whitelist reviewer access
- URL: https://pentagon-marketing-static-rc1-staging.up.railway.app/review/
- The **random reviewer passphrase** is stored only as a Windows DPAPI-protected private file on the authorized TRADEVICEPC. Railway stores a *salted scrypt verifier*, not the plaintext passphrase.
- On TRADEVICEPC, to reveal it privately in the local PowerShell window, run:
- `& 'C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Show-Pentagon-Marketing-Review-Password.ps1'`
- Do **not** send that passphrase to a chat, GitHub, logs, screenshots or marketing files. Do not confuse it with existing Pentagon admin login.
- Only one 4-hour staging reviewer session at a time is needed; the pilot has no per-person SSO/RBAC. Harden before production.
- Changing a request status to 'approved' means a marketing decision for outreach, never user activation.

## Version and references
- Source design commit: `a10322ad5388092510cd7bebc9fca0438b5aa578`.
- Staging review dashboard code commit: `eace9f6a80e66f72a8ffb1fddc21aa38560800c2`.
- CI run: https://github.com/9dbit/Pentagon/actions/runs/39194866721 .
- Replit source screenshot: [original desktop](marketing-rc1-visual/replit-original-desktop.png), [original mobile](marketing-rc1-visual/replit-original-mobile.png).
- Preview screenshot: [RC1 desktop](marketing-rc1-visual/replit-parity-desktop.png), [RC1 mobile](marketing-rc1-visual/replit-parity-phone390.png).
- Protected login visual: [review desktop](marketing-rc1-visual/review-login-desktop.png), [review mobile](marketing-rc1-visual/review-login-mobile.png).
- Isolated staging URL: https://pentagon-marketing-static-rc1-staging.up.railway.app/learn/ .

## Approval sequence
1. Owner confirms visual/content parity in staging and agrees on demo CTA resolution.
2. Engineering validates actual capability/uptime/latency/ISP claims or proposes revised language with owner approval.
3. Marketing/legal signs off privacy, public waitlist data handling and outreach messaging.
4. Build an approved production-facing independent marketing API (do not reuse admin credentials or the Replit app runtime); test failure rollback and domain behavior.
5. Re-run CI, visual QA, E2E and release checklist, and obtain an explicit **FINAL GO** before merging or publishing production.


## RC1 demo sandbox progress, 19 October 2026

- GitHub CI run [39199373320](https://github.com/9dbit/Pentagon/actions/runs/39199373320): **SUCCESS**, including Docker marketing image and code isolation tests.
- New isolated interactive demo preview: https://pentagon-marketing-static-rc1-staging.up.railway.app/demo/ . **Synthetic data only**; no production APIs, DB, scheduler, provider nodes, Google rank requests or customer accounts.
- Chrome visual/functional QA PASS at 1440px desktop, 390px phone and 320px phone: no horizontal overflow, 5 tabs, 3 scenario replays, domain filter, local alert acknowledgement; no external/API requests. Landing and reviewer routes remained operational after deployment.
- Staging HTTP confirms `/demo/` 200 HTML, `/demo/demo.css` 200 CSS, `/demo/demo.js` 200 JS, `/learn/` and `/review/` 200, reviewer list unauthenticated 401, production API `/api/health` absent (404), and `X-Robots-Tag:noindex` remains.
- Original Replit landing content/CTA is **unchanged**, `public/learn/index.html` blob SHA `6a037a88ef3a8deab3113513dc234495c7ccad00`. In particular, `demo.pentagon.quest` is **still unresolved**; the new sandbox does not silently intercept or replace the original Try Demo link.
- Screenshot evidence: [Demo desktop](marketing-rc1-visual/demo-lab-desktop1440.png), [Demo mobile 390](marketing-rc1-visual/demo-lab-phone390.png), [Demo mobile 320](marketing-rc1-visual/demo-lab-phone320.png).
- Every green CI and QA check is **engineering readiness only**, not proof of the live marketing claims, pricing, legal approval, consent policy, backend cutover or final public-domain GO. All original public release blockers remain OPEN.
- PR #27 and #26 remain Draft; Railway Pentagon production services online, no merge or DNS changes.

## Whitelist backup release milestone, 19 October 2026

- New staging-only reviewer-authenticated encrypted backup endpoint passed CI and live HTTP security checks. Client-held recipient RSA private key is never sent to Railway.
- CI [run 39236532995](https://github.com/9dbit/Pentagon/actions/runs/39236532995) **PASS** for synthetic archive tamper detection, origin+CSRF, offline restore parity and Docker.
- One actual staging encrypted snapshot stored and verified on TRADEVICEPC: **0 requests, 8 audit events**, ciphertext SHA-256 `12c9094fa414b75cb449c5b4309abfa723749cd55ce4c0160ef0a528476b162b`. No email data was logged or added to PR.
- Independent Windows-local ciphertext copy: **PASS**. Offsite geographic copy, portable decryption if the Windows PC is lost, backup retention and deletion-request handling: **OPEN**.
- Refer to [encrypted backup and recovery SOP](PENTAGON_MARKETING_RC1_WHITELIST_BACKUP_20261019.md). The original Replit design blob `6a037a88ef3a8deab3113513dc234495c7ccad00` and reviewer passphrase are unchanged.
- Public release remains **NO-GO** due to demo DNS, unverified numerical claims, pricing, legal/privacy, public API ownership and offsite recovery.
