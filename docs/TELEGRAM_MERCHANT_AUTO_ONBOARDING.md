# Telegram Merchant Auto-Onboarding (PENTAGON)

## Functional contract

- One production merchant tenant → one immutable, private Telegram supergroup
  \`PENTAGON | {TENANT} | REPORTS\`.
- Pentagon creates the supergroup using its own dedicated, authorized **user**
  account over MTProto. The Telegram reporting bot alone cannot create it.
- No group picker, no manual group creation by merchants, and no reuse of a
  merchant group for a different tenant.
- On verified merchant creation/signup, call
  \`prepareMerchantTenant(tenant, merchantEmail)\` from
  \`server/telegramMerchantActivation.js\` after the transaction commits.
- As of October 27, 2026, Pentagon does **not** expose a public merchant signup
  endpoint. The code seeds jobs on first verified merchant login and when
  \`/api/merchant/telegram-onboarding/status\` is visited. Integrate the exported
  hook when a merchant registration service is added.
- UI: Merchant Admin → Telegram Settings → **Activate Telegram Report**.
  Merchant may use QR/bot link, Telegram username or numeric ID, or profile QR
  from a camera. The ID/profile QR only supplies an identity hint; verified
  Telegram \`/start pma_{token}\` within 10 minutes confirms possession.
- Upon provisioning, the service account adds the bot and grants admin invite
  rights; Pentagon verifies the exact private group and bot rights through Bot
  API, stores its permanent chat_id, then sends a direct one-time invitation
  to the verified merchant account. No forced membership or unsolicited
  messages.
- Merchant Telegram Reports is read-only, scoped to tenant's sent/queued/error
  events from the Telegram report and TrustPositif alert outboxes. Message
  bodies and other tenants' data remain server-side.

## Runtime requirements

Requires the dedicated internal Railway MTProto bridge described in
\`telegram_mt_bridge/README.md\`.

Web service-only variables:
- \`PENTAGON_TELEGRAM_MT_BRIDGE_URL\`: private service endpoint
- \`PENTAGON_TELEGRAM_MT_BRIDGE_KEY\`: shared secret, same as bridge

Bridge service-only variables:
- \`TELEGRAM_API_ID\`, \`TELEGRAM_API_HASH\`,
  \`TELEGRAM_MT_USER_SESSION\`,
  \`PENTAGON_TELEGRAM_MT_BRIDGE_KEY\`,
  \`PENTAGON_TELEGRAM_BOT_USERNAME\`

**Do not send the Telegram user account password, 2FA, or StringSession
through chat or store them in code.** Use Railway environment secrets.

If the MTProto account is unconfigured or Telegram rate-limits creation:
- Group status is queued/retry; report sending is not activated.
- The UI says provisioning is pending.
- Existing verified tenant groups and report preferences are not replaced.
- The user can complete Telegram identity verification in advance.

## Tests and deploy policy
- GitHub CI uses only a local PostgreSQL fixture and a mocked Telegram API.
- Never infer a physical group is created from CI alone.
- Deploy with the bridge disabled if not configured, then provision the bridge
  separately and complete a controlled hardware Telegram acceptance test.
- Watch for Telegram account limits/anti-spam restrictions; enforce consent
  and do not run bulk provisioning for unverified or fake signups.
