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
