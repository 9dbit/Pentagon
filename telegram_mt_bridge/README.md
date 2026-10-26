# Pentagon Telegram MTProto Provisioner

**Purpose:** Auto-create one real private Telegram supergroup per tenant using a
dedicated Telegram **user** service account. Bot API cannot create groups.
This service MUST NOT be exposed publicly.

## Requirements
1. Telegram API ID and API hash from https://my.telegram.org for a dedicated
   operational Telegram account you control.
2. Authorized Telethon \`StringSession\` for that account. Generate it locally
   using Telethon's documented interactive login flow; **never paste phone,
   confirmation code, 2FA password or session in ChatGPT**.
3. A separate Railway service with no public domain, private networking only.
   Start command: \`uvicorn app:app --host 0.0.0.0 --port $PORT\`
   (set root directory to \`telegram_mt_bridge\`).
4. Add **service-only** environment secrets:
   \`TELEGRAM_API_ID\`, \`TELEGRAM_API_HASH\`,
   \`TELEGRAM_MT_USER_SESSION\`, \`PENTAGON_TELEGRAM_MT_BRIDGE_KEY\`,
   and \`PENTAGON_TELEGRAM_BOT_USERNAME=DomainRadarAi_Bot\`.
5. Configure Pentagon web service only after this bridge has a healthy,
   authorized dedicated user session:
   \`PENTAGON_TELEGRAM_MT_BRIDGE_URL=http://<private-service>.railway.internal:<PORT>/\`
   and same \`PENTAGON_TELEGRAM_MT_BRIDGE_KEY\`.
6. Do not enable a public ingress or reuse the merchant user's personal account.

## Safety rules
- Only tenant-derived exact titles are accepted.
- \`create\` searches groups owned by the account before creating a new one,
  to recover safely if an HTTP response is lost.
- \`secure\` requires the same owned private group before granting bot admin.
- No automatic user invitations without verified Telegram opt-in.
- Telegram may impose account restrictions or rate limits. Pentagon must
  show \`pending\` or \`retry\`, not fabricate a created group.
- The service session authorizes potentially powerful actions. Restrict
  access to the Railway private network and rotate secrets on compromise.
