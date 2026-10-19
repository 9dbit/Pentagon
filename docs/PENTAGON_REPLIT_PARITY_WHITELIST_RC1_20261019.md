# Pentagon Marketing RC1: Replit exact-source parity and Join Whitelist

## Scope and source of truth
- The publicly published Replit app is Pentagon, verified at `https://pentagon.quest/` (Replit published deployment, read-only).
- Captured live rendered DOM, original CSS asset `public/assets/index-HN8rRKwo.css`, original public `logo-icon.png`/`logo-text.png`, and authentic desktop/mobile decorative canvas snapshots.
- Archived exact Replit screenshot references: [desktop](marketing-rc1-visual/replit-original-desktop.png) and [mobile](marketing-rc1-visual/replit-original-mobile.png).
- Marketing RC1 static snapshot at `/learn/` retains the Replit hero, SVG dashboard mockup, feature grid (7 cards), ShieldLink, original pricing section, final CTA and footer.
- Only user-requested addition is Join Whitelist and supporting modal/privacy route. Original public `pentagon.quest` and its login are NOT changed.

## Original design elements retained
- Background: nearly black, subtle warm orange radial glow, animated-dot canvas replaced with a captured original image as a decorative static asset.
- Logo: original orange icon PNG and angular Pentagon text PNG, not the earlier generic/modern wordmark.
- Headline: 'Your domain defense command center.' (with orange gradient emphasized phrase).
- Original copy, seven feature descriptions, ShieldLink flow, stats and pricing marketing copy preserved word-for-word.
- Original navigation patterns, hero mockup, buttons, mobile layout, and original Vite CSS artifact are used instead of reimagined equivalents.

## Join Whitelist
- Visible Join Whitelist button in nav and hero; original Get Started and ShieldLink CTAs open the same early-access request dialog.
- The form collects only email with required explicit consent. Privacy Notice is available at `/privacy/`.
- New requests are stored only in a private `/data/whitelist/requests.jsonl` file on an isolated Railway STAGING volume, when enabled. No public GET/list endpoint and no plaintext email addresses in logs.
- Admin login uses `ADMIN_EMAIL_WHITELIST` on Pentagon app; early-access requests NEVER alter it, never grant access and never store a password.
- Honeypot, origin check, body cap, request throttling and deduplication mitigate casual spam.
- Data file is atomically rewritten and restricts file permission to 0600; entries over 365 days are pruned on future writes. Proper lead export/deletion runbook remains an operational follow-up.
- Successful request returns `202 pending`, without promising approval or automated confirmation.
- When `WHITELIST_ENABLED` is not true or private volume is inaccessible, POST fails clearly (503); no false success.

## Critical release gates
- The recreated page preserves original Replit marketing claims such as '99.9% Uptime accuracy', '<30s Alert latency', '6+ ISP networks' and feature assertions. These are **original marketing claims only** and are NOT independently verified. Owner/legal/engineering must validate or edit them before public paid promotion.
- Marketing-only Docker preview has no Supabase, app DB, node service or scheduler connection. Only an isolated marketing storage volume may be attached.
- Public production has NO `/api/whitelist` route from this marketing-only change; a production marketing release needs an approved, separate whitelist handler/domain/proxy. Do not merge PR #27 and claim production signup works.
- Staging returns global noindex and robots Disallow `/`, and must remain isolated from pentagon-web production, provider nodes, DNS and Replit shutdown.
- Before any release: full CI, staging HTTP form persistence test, mobile/desktop screenshot diff against Replit references, CTA/login/demo link validation, privacy owner sign-off, recovery/rollback, then explicit owner GO.

## Verification commands
- `node scripts/test-pentagon-marketing-design-rc1.cjs`
- `node scripts/test-pentagon-whitelist-smoke.cjs`
- `node scripts/test-pentagon-marketing-preview.cjs`
- `docker build -f Dockerfile.marketing -t pentagon-rc1-static .` (marketing-only image)
- CI must show all isolated Docker/web checks successful before staging pin update.

## Live staging verification completed
- Marketing-only CI GitHub run https://github.com/9dbit/Pentagon/actions/runs/39188343683: **SUCCESS**, including original source parity assertions, local whitelist persistence / consent / dedup tests, Docker images and HTTP smoke.
- Preview image pinned to `a10322ad5388092510cd7bebc9fca0438b5aa578`, Railway isolated project `Pentagon Marketing RC1 Preview`, environment staging, service `pentagon-marketing-static-rc1`.
- Staging has **dedicated 512 MB volume** `/data` (`pentagon-rc1-whitelist-private`) and explicitly enabled only `WHITELIST_ENABLED=true` and `WHITELIST_DATA_DIR=/data/whitelist`; no production database or scheduler is connected.
- Staging checks: `/learn/` 200 HTML, `/privacy/` 200 HTML, original CSS 200, PNG logo 200, `/robots.txt` 200 text/plain, `/health` 200, `/api/auth/me` 404; every served page has `X-Robots-Tag: noindex`.
- Live `POST /api/whitelist` using synthetic `@example.test` only: first request `202 pending`, repeat `202 pending`, and actual mobile Chrome modal submission `202 pending`, consent mandatory. All request data remains in isolated staging volume; no actual user leads tested.
- Browser image QA: 4/4 desktop 1440, phone 390, phone 320 and tablet 768 PASS. No horizontal overflow; exact original seven feature headings retained, logo/images loaded; modal opens and closes; privacy link present.
- Real source-of-truth screenshots can be compared below with the staging implementation. Animated Replit background was represented by unchanged source canvas PNG frames; no original React application or private API is executed in staging.

### Replit original versus RC1 staging screenshots
| View | Original published Replit | Marketing RC1 staging |
|---|---|---|
| Desktop | [Original 1440](marketing-rc1-visual/replit-original-desktop.png) | [RC1 1440](marketing-rc1-visual/replit-parity-desktop.png) |
| Mobile | [Original 390](marketing-rc1-visual/replit-original-mobile.png) | [RC1 390](marketing-rc1-visual/replit-parity-phone390.png) |
| Small mobile | Original live source | [RC1 320](marketing-rc1-visual/replit-parity-phone320.png) |
| Whitelist modal | New feature | [Mobile modal](marketing-rc1-visual/replit-whitelist-modal-phone390.png) |

### Remaining sign-off requirements
1. The original marketing copy is cloned faithfully, including strong numeric and capability claims. Validate them with provider/test evidence before public advertising. This preview is **not** evidence of true 99.9% uptime or nationwide 6+ ISP coverage.
2. Decide moderation/operations for pending whitelist requests, including approved staff review/export/deletion and eventual membership/access activation. **No whitelist approval dashboard exists yet**; no automatic admin access.
3. Validate contact and demo destinations, legal/privacy sign-off, owner visual sign-off, exact production serving architecture for `/api/whitelist`, rollback and single-source scheduling. This staging-only service does not implement the production API.
4. PR #27 stays Draft/unmerged. PR #26 migration stays Draft. Pentagon production and Replit are unchanged.
