# Pentagon Provider Node 1.7.0

Canonical cloud-native Android provider node for Pentagon.

## Production identity

- applicationId: `com.pentagon.providernode`
- versionCode: `170`
- versionName: `1.7.0`
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
