# PENTAGON · NODE HEALTH V2
**Design specification + implementation prompt | 23 October 2026**

Status: **APPROVED DESIGN BRIEF / NOT YET IMPLEMENTED**. This document changes no production configuration.

## 1. Source of truth and gap

Reference:
- Historical admin dashboard: \`src/App.jsx\` components \`NodeCard\`, \`BatteryGauge\`, \`SignalGauge\`, \`HealthBadge\`; styles in \`src/style.css\` and \`src/dashboard-patches.css\`. Replit original app is named \`Pentagon\`.
- Current merchant UI: \`src/MerchantAdminPage.jsx\`, \`src/MerchantAdminPage.css\`.
- Current merchant endpoint: \`GET /api/merchant/nodes\` in \`server/merchantAdminRoutes.js\` returns **provider aggregates only** (\`total\`, \`active\`, \`fresh\`, \`waiting\`, \`last_seen_at\`).
- Original administrator \`/api/nodes\` enriches battery, network and signal, but includes privileged identifiers and secret-bearing fields: **never forward or expose the original response to merchant clients**.

Historical code calculates signal bars from \`signal_level\` 0..4, fallback \`signal_percent\`, then \`signal_dbm\`. Battery is presented graphically and original operational cards have online/waiting states and admin Ping/Enable/Disable actions.

## 2. Intended roles

- **Super Admin:** complete node detail, operational Ping and Enable/Disable actions from existing protected administrator interface.
- **Merchant Admin:** full-width merchant Node Health dashboard with individual **sanitized** node cards; read-only access to signal, battery, connectivity and heartbeat. May administer their own domain and keyword assets through existing merchant routes, **not** physical provider nodes.
- **Merchant Viewer:** existing customer summary/dashboard only, no node API access unless explicitly permitted in a future separate role change.

Don't expand the merchant route firewall to \`/api/nodes\`, \`/api/agent\`, \`/api/check\`, \`/api/settings\`, privileged reports or Telegram controls. Never use a body/query-provided tenant; derive from verified server session and the current role mapping.

## 3. Visual identity

- Background: \`#0B0D10\` near-black.
- Card: \`#212329\` solid graphite; inner status block: \`#15171C\`.
- **Primary brand: \`#FF7A00\`, solid orange.**
- Main text: \`#FFFFFF\`; secondary text: \`#A5ABB5\`.
- Status danger: distinct \`#EF5350\`; offline gray \`#777B84\`; meaning must also appear as text, not color alone.
- **No subtle lines, hairline separators, 1px borders, gradients, glassmorphism, animated outlines or decorative glows.** Separate items by spacing, corner radius and solid surface contrast.
- Buttons: pill shape; orange-filled for allowed main action, graphite-filled otherwise. All clickable buttons get visible pressed state \`transform:scale(.97)\`.
- Card padding desktop 20–24px, mobile 16–18px; radius 18–20px; card min-height driven by content; no fixed height that clips telemetry.
- Typography: node/provider heading 15–17px bold, telemetry value 15–18px bold, labels 11–12px secondary. Preserve clear accessibility/contrast.

## 4. Individual Node Card anatomy

A. **Header**: public safe provider name (Telkomsel/Indosat/XL etc.), neutral stable alias ("NODE 01"), network type (LTE/4G/5G), an explicit enable-state label \`ACTIVE\` or \`INACTIVE\` with a color dot. Don't display a raw device nickname if it can reveal a precise location or unique hardware identity.

B. **Signal row**: five ascending orange bars with inactive graphite bars. Adjacent text \`Strong\`, \`Good\`, \`Weak\`, \`No Signal\`, or \`Unknown\`; optional validated dBm reading in small type. Don't interpret missing measurement as "No Signal".

C. **Battery row**: horizontal battery graphic, percentage with clear \`Charging\` label if true, low-battery warning if below 20%, \`N/A\` for unavailable data. Use approximate 10% bucket as historic card does if privacy policy requires that; **don't fabricate 0%, 100%, or charging**.

D. **Status block**: show separate:
- \`ACTIVE / INACTIVE\` = management-enabled flag \`is_active\`.
- \`ONLINE / WAITING / OFFLINE / UNKNOWN\` = heartbeat + health state. \`is_active\` must never imply online.
- \`Last seen\` / \`Heartbeat\` localized to Asia/Jakarta, or "Belum pernah terhubung".
- Optional read-only cause code simplified from allowlisted public health categories; never show raw errors, private URLs or secrets.

E. **Controls**: Merchant Admin \`Refresh\` is read-only. \`Ping\`, \`Enable\`, \`Disable\`, \`Delete\`, subscriber-related controls and node provision are shown **only** in Super Admin's original component with existing protected APIs. No disabled fake controls in merchant view.

## 5. Data derivation and timing

Preferred sanitized API: \`GET /api/merchant/node-health\`, mounted under existing verified \`requireMerchantAdmin\` and early customer firewall. It may coexist with legacy \`/api/merchant/nodes\` for backward compatibility.

Return an explicit array with no spread of database records. Suggested response:
\`\`\`json
{
  "as_of": "ISO_8601_UTC_TIMESTAMP",
  "nodes": [{
    "public_alias": "TELKOMSEL NODE 01",
    "provider_name": "Telkomsel",
    "network_type": "5G",
    "is_active": true,
    "connectivity": "online",
    "signal_bars": 4,
    "signal_label": "Strong",
    "signal_dbm": null,
    "battery_percent": 80,
    "is_charging": true,
    "last_seen_at": "ISO_8601_UTC_TIMESTAMP"
  }]
}
\`\`\`
JSON is an example, not live node data.

Source tables: \`provider_nodes n\` joined to \`node_telemetry t\` via \`t.node_id=n.id\`; permission must expose only tenant-appropriate, expressly permitted shared provider nodes (e.g. \`n.tenant IN ('admin', req.merchantTenant)\`), with the platform contract reviewed for global sharing. Use parameterized SQL. **Explicitly select and serialize only allowlisted fields**.

**Do not emit:** raw node ID or private device name, \`endpoint_url\`, \`secret_key\`, bootstrap/install IDs, SIM identifiers, subscription ID, IP, user agent, raw telemetry payload, coordinates, administrative action URLs, or other tenant's private nodes.

Signal:
1. If \`signal_level\` is valid 0..4, bars = round(level / 4 * 5).
2. Otherwise if \`signal_percent\` is valid 0..100, bars = round(percent / 100 * 5).
3. Otherwise if \`signal_dbm\` is a finite reasonable value, use the historical -120..-40 dBm clamping and convert to five bars.
4. Else \`signal_bars=null\` and label \`Unknown\`.
5. Measured zero bars = \`No Signal\`; 1–2 \`Weak\`; 3 \`Good\`; 4–5 \`Strong\`. Don't treat a cached stale signal as current if heartbeat has expired.

Battery: accept validated 0..100 and optionally 10% bucket; null => N/A; charging only if source boolean. Use low-battery marker at <20% without confusing it with connectivity.

Connectivity: align fresh threshold with existing merchant aggregate: heartbeat present and age <=5 minutes = possible Online **if healthy**; stale heartbeat = Waiting/Offline; absent heartbeat = Unknown; disabled flag = Inactive regardless of historical heartbeat. Negative/future/skewed timestamps must never be counted as fresh. Server time is authoritative. Keep the original backend's finer status reasons if safely mapped and explicitly documented.

Refresh: periodic 30–60 seconds while page is visible; manual refresh button; abort stale fetches on navigation; do not write to node or trigger a physical ping. Display \`as_of\` and \`last_seen\` distinctly.

## 6. Responsive layout

**Desktop >=1200px**
- Clear page heading \`Provider Node Health\`, status summary and manual Refresh.
- Grid 3–4 columns if >=280px available per card.
- Each card: header, prominent 5 bars + label, battery + charging, status block + last seen.
- Show all provider cards; no overflow or horizontal scroll.

**Tablet 768–1199px**
- Grid 2 columns, cards minimum ~280px, typography maintained.

**Mobile <=767px, specifically iPhone 15 Pro**
- Single column, full-width cards, 16px horizontal safe-area-aware margins.
- Signal + battery can share a row only if readable. Don't hide labels or health details on mobile.
- Horizontal merchant nav may scroll; no layout clipped beneath browser/PWA bottom bar.
- Test widths 320, 375, 390, 430, 768, 1280, 1440px.
- Respect \`prefers-reduced-motion\`; online dot may pulse subtly unless reduced motion selected.

## 7. Functional acceptance criteria

1. Merchant admin sees **one sanitized card per permitted node**, not only one aggregated provider card. Provider summary can remain above as overview.
2. Clear 0–5 signal bars + semantic text, battery percentage and charging status, ACTIVE/INACTIVE dot, distinct ONLINE/WAITING/UNKNOWN, last heartbeat.
3. When signal/battery is missing, show \`Unknown\`/\`N/A\` and never fake values.
4. Read-only Merchant Admin: POST/PATCH/DELETE device APIs => 403; \`GET /api/nodes\` remains 403.
5. No secret or raw subscriber/IP/endpoint fields in \`GET /api/merchant/node-health\` JSON.
6. Cross-tenant test proves merchant A cannot see merchant B's private nodes, hidden identifiers, or mutate device settings.
7. User UI is responsive and no overflow at 320–1440px; status has icon/dot+text; contrast accessible.
8. All cards use solid background and solid brand orange. No border hairlines/dividers. No decorative gradient.
9. Synthetic fixture + isolated PostgreSQL tests pass, production UI build passes, existing viewer/super-admin tests pass.
10. Keep **Railway primary** and Render backup; no scheduler changes or DNS switch. Release first to Render, verify authenticated session and tenant isolation before Railway production promotion.

## 8. Ready-to-run implementation prompt

**Target repository:** \`9dbit/Pentagon\`, branch \`migration/railway-independence\`; stage on Render service \`pentagon-hot-standby\`.

> Implement the approved Pentagon Node Health V2 specification in this document. Reuse the historical \`NodeCard\`, \`BatteryGauge\`, and \`SignalGauge\` from \`src/App.jsx\` only as a **visual reference**, not as a merchant data source. Upgrade \`src/MerchantAdminPage.jsx\` and merchant styles using orange solid #FF7A00, white on graphite, no subtle lines or borders. Create a **strictly sanitized** tenant-guarded read-only node-health API in \`server/merchantAdminRoutes.js\` with explicit public fields, separate ENABLED versus CONNECTIVITY states, validated signal bars, battery and last seen. Preserve all existing node management controls only for Super Admin. Add synthetic, cross-tenant and mobile UI tests. Do not copy raw \`/api/nodes\` output into merchant scope, bypass the firewall or introduce production secrets into code. Run CI before merging. Deploy first to Render, keep scheduler disabled, verify health and authenticated merchant page, and do not switch Cloudflare DNS or change Railway production without a separate gated approval. Report the actual deployment/test status and any remaining blockers.

## 9. Non-goals

No new accounts/passwords; no role escalation; no schema migration unless independently reviewed; no SIM/IMEI disclosure; no new network-probing job; no automatic failover activation; no publishing of historic Replit credentials; no false indicator that domain checks are officially verified.
