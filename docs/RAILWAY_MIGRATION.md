# Pentagon Railway Migration

Goal: make Pentagon independent from Replit while preserving the current UI, branding, routes, monitoring behavior, Telegram reporting, provider-node workflow, demo tenant, and PostgreSQL data.

## Target topology

- One Railway application service from `9dbit/Pentagon`
- One PostgreSQL database
- Express serves `/api/*` and the production Vite bundle from `dist/`
- Existing provider nodes continue to call/poll the Pentagon public endpoint
- Telegram webhook points to the Railway/custom-domain URL
- Replit remains online until parity verification and final cutover

## Deployment commands

Build: `npm ci && npm run build`

Start: `npm run start`

Healthcheck: `/api/health`

Database initialization for a new empty database: `npm run db:init`

## Required production variables

See `env.sample`. At minimum configure:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_PASSWORD`
- `ADMIN_EMAIL` / `ADMIN_EMAIL_WHITELIST` as applicable
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `CHECK_INTERVAL_SECONDS`
- `STATUS_KEYWORDS`
- `DOMAIN_RADAR_DASHBOARD_URL`

Optional features additionally require `OPENAI_API_KEY` and runtime tuning variables listed in `env.sample`.

## Data migration rule

Do not initialize an empty database and call the migration complete. Production parity requires a PostgreSQL dump/restore (or equivalent logical migration) from the current Pentagon database so these datasets survive cutover:

- domains, projects and labels
- check history and alerts
- proxies
- provider nodes and polling state
- settings
- rank/SEO groups and history
- Telegram project mappings and digest state
- demo tenant data
- user activity/session history when desired

After restore, run the current app once so the idempotent lazy migrations in `boot()` and feature modules can add any missing columns/tables.

## Cutover checklist

1. Deploy the migration branch to Railway.
2. Attach PostgreSQL and configure variables.
3. Restore a copy of production data.
4. Verify `/api/health` reports database connected.
5. Compare login, Dashboard, Projects, Google Rank, Analytics, Defense Center, Users and Settings against the current site.
6. Compare mobile layout and static CSS patches loaded from `public/`.
7. Verify scheduled checks, manual checks, TrustPositif flow, provider-node polling/direct mode and rank checks.
8. Send a Telegram test and verify the Telegram webhook callback.
9. Verify CSV/PDF/export flows and OpenAI SEO audit if enabled.
10. Run both systems in parallel briefly and compare domain statuses/alerts.
11. Point the production custom domain to Railway.
12. Update `DOMAIN_RADAR_DASHBOARD_URL` and Telegram webhook to the final production URL.
13. Only after parity and monitoring are confirmed, shut down Replit.

## Rollback

Keep Replit unchanged until the final cutover. If Railway verification fails, move DNS back to the existing deployment and investigate without touching the source production database.
