# Pentagon Node APK 1.6.0

Android provider-node app for Pentagon.

## What changed in 1.6.0

- Central URL defaults to Railway Pentagon.
- Legacy domain-radar.org, pentagon.quest, and demo.pentagon.quest settings are redirected to Railway during this migration build.
- Mobile checks use Android TRANSPORT_CELLULAR directly.
- A valid subscription ID is diagnostic only, not a requirement to perform checks.
- DNS resolution and HTTPS checks run through the selected cellular Network.
- Supports trustpositif_fetch tasks.
- TrustPositif availability uses HEAD / 64 KB Range probe, so nodes do not download the full ~208 MB domains_isp file just to prove availability.
- Telemetry reports cellular_available, subscription_id, and subscription_reason.

## Mobile node behavior

For Network Type = mobile, Pentagon requires a cellular network with Internet capability. If Android has a usable cellular transport even when subscription metadata is missing, checks continue.

If no cellular transport is available, the node reports NO_CELLULAR_TRANSPORT. It does not report the domain as safe or blocked.

## Configuration

Example Telkomsel:

Central URL: https://pentagon-web-production.up.railway.app
Node Name: TELKOMSEL-JKT-01
Provider: Telkomsel
Network Type: mobile
Agent Secret: telkomsel-jkt-01-secret-001
Poll Interval: 3000

Use the matching node name and secret configured in Pentagon.

## Required permissions

Internet, location, phone state, and notifications. Set battery usage to unrestricted on provider phones.

## Build

GitHub Actions workflow: Build Pentagon Node APK

Artifact: PentagonNode-v1.6.0-debug-apk
