# Pentagon | Customer Viewer tenant-isolation rollout
Checkpoint: 22 October 2026

## Why this exists

The WISNU123 customer already has 1 project, 5 active domains (1 MS / 4 LP), 5 keyword groups and 25 whitelisted group↔domain relations in Supabase Pentagon `odjsifsxhdesvkyzsnbw`. The supplied login was previously an existing salted-hash test account, hardwired to the demo tenant. **Never move WISNU123 data into demo, and never grant the test account administrator privileges.**

## Authentication

The existing `PENTAGON_TEST_USERS_JSON` salted scrypt credential hash list remains unchanged. After successful verification of a hash, a second, separate server-side mapping chooses a customer tenant:

```json
[{"email":"customer@example.test","tenant":"example_customer","role":"customer_viewer"}]
```

This is a **format example using reserved test identifiers**, not live config. Production setting: `PENTAGON_CUSTOMER_VIEWERS_JSON` scoped to `pentagon-web` (Railway). Do not commit the actual account, password, salts, hashes or environment-variable values to GitHub or documentation.

Configuration validates email, forbids duplicate users, forbids demo/test/sandbox tenants, rejects plaintext credentials, and fails closed on malformed JSON. Any active viewer session is revalidated against the CURRENT mapping on every request, so deleting a binding immediately revokes access. After verification, customer sessions use a regenerated session ID, `isAdmin=false`, `isDemo=false`, `isCustomerViewer=true`, and tenant from server-side binding. Role is derived from session plus mapping, never a client-supplied field.

## Backend permission rules

`/api/customer/overview`, `/api/customer/domains`, `/api/customer/keywords`, and `/api/customer/alerts` are the **only** customer data APIs. All use GET and parameterized SQL `WHERE tenant=$1` derived from validated signed server session. Keyword whitelist joins also require the linked domain's tenant to match. No secrets, node management, Telegram settings, raw alert messages, or other-tenant records are returned.

An early `/api` firewall denies ALL other API paths for customer viewers, including node check, manual check, Telegram test, exports, activity writes, and current or future administrator routes. Cookie-backed customer requests with a foreign Origin are also denied. Logout and auth/me stay accessible. The rest of the existing administrator/demo login semantics remain unchanged.

Customer dashboard is a distinct React branch with no administrator data loader, and responsive 320px–1440px layout. It shows MS/LP labels, 5 brand keyword groups, whitelist coverage, and explicit UNKNOWN / not-yet-verified status until genuine network evidence exists.

## Validation and rollout

CI runs both existing salted-hash compatibility tests, customer auth firewall tests, isolated PostgreSQL16 tenant separation over HTTP, existing TrustPositif consensus/outbox and production UI build. Fixture uses reserved .example/.test names; no real customer authentication/password, Telegram messages or official lookup.

Release only after CI PASS:
1. Configure `PENTAGON_CUSTOMER_VIEWERS_JSON` on the *web* service, mapping the already-verified salted test account to `wisnu123`. Do not copy or expose the password.
2. Deploy production branch to pentagon-web. Verify deployed commit SHA, not only Railway source configuration; make sure Railway is not still serving older commit 7032417.
3. Verify /api/health HTTP 200; /api/customer/domains without auth HTTP 401; with viewer cookie HTTP 200 scoped to 5 WISNU123 domains and 5 brand keywords; /api/overview and POST /api/check/manual HTTP 403; login of unrelated demo user unchanged.
4. Verify dashboard at desktop 1440, tablet 768, mobile 390 and 320px. If the browser cannot authenticate automatically, distinguish the static UI synthetic test from a true end-to-end production test.
5. Monitoring requires two independently healthy provider node heartbeats; currently only Indosat is fresh, so UNKNOWN is accurate. No synthetic BLOCKED event or Telegram is sent to production.

## Emergency access revocation and rollback

Remove the email/tenant binding (set `PENTAGON_CUSTOMER_VIEWERS_JSON=[]`) to revoke already-authenticated customer viewers at the next API request. The new feature requires no database schema migration and changes no existing password hashes. Revert the feature PR or roll back `pentagon-web` to the last known-good deployment if errors occur. **Keep WISNU123 tenant data untouched**. Do not enable the legacy full scheduler to compensate for node quorum.

