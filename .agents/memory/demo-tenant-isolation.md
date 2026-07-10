---
name: Demo tenant isolation pattern
description: How the demo account and tenant isolation are implemented in Domain Radar
---

## The rule
Every data table has a `tenant TEXT NOT NULL DEFAULT 'admin'` column. The demo user session carries `tenant='demo'` and all read routes filter by that value. All write routes block demo sessions outright.

**Why:** A read-only demo account (`demo@domain-radar.org`) must never touch or reveal admin data, config secrets, or global system state.

**How to apply:**
- New tables storing per-user data must add `tenant TEXT NOT NULL DEFAULT 'admin'` and filter by `getTenant(req)` in GET routes.
- New write routes must include `requireNotDemo` middleware.
- New router mounts with writes need `requireNotDemoWrite` + `attachTenant`.
- `getTenant`, `requireNotDemo`, `requireNotDemoWrite`, `attachTenant` are all defined inline in `server/index.js`.

## Sensitivity tiers for demo access

| Route group | Demo access | Why |
|---|---|---|
| `/api/settings` GET | Allowed, but tokens redacted in route handler | Dashboard needs settings to load; token is secret |
| `/api/project-telegram` GET | Returns `[]` (handler checks `req.session.isDemo`) | Dashboard needs it; real chat IDs are internal |
| `/api/analytics` | Fully blocked (`requireNotDemo`) | Global untenanted queries |
| `/api/activity/*` | Fully blocked (`requireNotDemo`) | Global user session data |
| `/api/auth/users` GET | Blocked (`requireNotDemo`) | Exposes admin email whitelist |
| `PATCH /api/auth/users/nickname` | Blocked (`requireNotDemo`) | Persistent write to `app_settings` |

## Critical: rank_keyword_groups tenant column
`ensureRankTables()` (server/rankRoutes.js) adds the tenant column lazily. `demoSeed.js` must call `ensureRankTables()` at the start before any rank inserts. The skip-if-present guard checks `rank_keyword_groups WHERE tenant='demo'` (not `domains`) so a partial seed is detected and retried.

## Demo password
Defaults to `"Domainradar123"` but can be overridden with `DEMO_PASSWORD` env var.

## No proxy seeding
Demo sandbox intentionally has 0 proxies. Do not add proxy rows to `demoSeed.js`.
