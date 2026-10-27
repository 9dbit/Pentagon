# Pentagon merchant signup gate (27 October 2026)

## Source audit
- The marketing RC1 **Join Whitelist** posts to `/api/whitelist` and records an early-access request. It does **not** create accounts.
- Existing merchant login uses `PENTAGON_TEST_USERS_JSON` password hashes and `PENTAGON_CUSTOMER_VIEWERS_JSON` tenant grants. Existing authorized tenants must not be overwritten.
- This branch adds a **separate, feature-flagged merchant application intake**, not a finished live signup system.

## Safety
- `POST /api/merchant-signup` may accept a company name, email and explicit consent after the table migration and explicit feature flag.
- Requests are pending only. No password is accepted or stored. No role is granted. The same response is returned for duplicate emails.
- Public signups cannot select a tenant, approve themselves, or become Super Admin.
- Do not activate the feature flag until staging tests, spam controls and privacy review pass.

## Remaining work before calling signup complete
1. Integrate a verified email/invite delivery provider; verify ownership with expiring, single-use tokens.
2. Implement a persistent credential store with modern password hashing and login integration (rather than changing the legacy test user environment variable).
3. Transactionally allocate a distinct merchant tenant; ensure server-derived tenant-scoped authorization.
4. Require independent explicit approval or approved policy before activating access; audit the decision.
5. Add the final signup form to the production landing page after review; show accurate pending/verified/active states.
6. Write negative security tests for tenant escape, user enumeration, duplicate signups, CSRF/origin, rate limits and Super Admin elevation.
7. Run staging end-to-end signup -> verify -> approve -> login -> merchant dashboard; preserve WISNU123 data, existing account passwords and provider nodes.

## Deployment
No production migrations, feature flag changes or credential changes are authorized by this branch.
