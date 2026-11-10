# Pentagon Provider Node 1.7.8

Canonical cloud-native Android provider node for Pentagon.

## Production identity

- applicationId: `com.pentagon.providernode`
- versionCode: `178`
- versionName: `1.7.8`
- central API: Railway Pentagon
- update channel: `/api/provider-node/releases/cloud/latest`

## Runtime behavior

- Provider checks can be forced through Android `TRANSPORT_CELLULAR`.
- Subscription ID is diagnostic, not a hard requirement.
- Supports `trustpositif_fetch` using HEAD / 64 KB Range probe.
- Reports cellular availability, subscription diagnostics, operator, network type and device telemetry.
- Starts as a foreground service and can resume after boot.
- Includes in-app self-update with package-name and SHA-256 validation.

## Cloud release architecture

GitHub is the source of truth. Railway builds and signs the release APK. The signing key is generated once and persisted on a Railway volume, never committed to this public repository. The release service exposes `/latest.json`, `/latest.apk`, and `/health`.

The legacy Replit build is not required for this release channel.

## Connection recovery (1.7.8)

- Start / Retry requests a fresh control connection at the next poll boundary,
  reusing the running service, cellular check, pending result and provisioned identity.
- Two consecutive transport failures queue a switch between the exact production
  HTTPS origins `pentagon-web-production.up.railway.app` and `pentagon.quest`.
  A POST is never replayed inside the same attempt. Custom central endpoints do
  not participate in production fallback; auth, HTTP, invalid ACK and certificate
  failures remain visible. A working alternate remains selected for the session.
- A default-network replacement refreshes idle API connections. Provider domain
  checks retain their cellular network binding and provider validation.
- Diagnostics report only endpoint aliases and connection-phase enums; only an
  actual server ACK advances heartbeat freshness.
- The updater can use `pentagon.quest` for metadata and the bounded fixed-source
  `/api/provider-node/releases/cloud/apk` binary proxy. Package and SHA-256 checks
  still apply, and Android verifies the signing identity at installation.
- Install over the existing APK. Do not uninstall, clear application data, or
  reprovision a disconnected node. A phone that cannot reach its old update
  hostname needs the signed update opened from an accessible browser link.

## Android 15+ heartbeat hardening (1.7.6)

- Continuous independently authorized ISP monitoring uses a declared `specialUse` foreground service, with subtype explanation. Android 15 restricts `dataSync` services to six hours per 24 hours and disallows launching them from `BOOT_COMPLETED`. This dedicated, user-enabled device monitoring mode requires OEM validation and any applicable Play Console declarations before Play distribution.
- The node shows **Online** only after Railway acknowledges a recent poll *and* validates the configured SIM provider. An app's foreground UI state does not prove connectivity.
- Existing node credentials, installation identity, and bootstrap tokens are not rotated. Legacy Replit endpoints are normalized to canonical Railway.
- If the node reports Waiting or Polling Error, inspect in-app Recent Logs and use Start/Retry; report only nonsecret log lines during troubleshooting.
