#!/usr/bin/env bash
set -euo pipefail
mkdir -p /data
chmod 700 /data
KEYSTORE=/data/pentagon-provider-node.jks
PASSFILE=/data/signing.pass
ALIAS=pentagon-provider-node
APK=/data/Pentagon-Provider-Node-v${VERSION_NAME}.apk
SHA=/data/Pentagon-Provider-Node-v${VERSION_NAME}.sha256
SIGNER=/data/signer.sha256

if [[ ! -f "$KEYSTORE" || ! -f "$PASSFILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$PASSFILE"
  PASS="$(cat "$PASSFILE")"
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass "$PASS" -keypass "$PASS" \
    -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=Pentagon Provider Node,O=Pentagon,C=ID"
fi

PASS="$(cat "$PASSFILE")"
if [[ ! -f "$APK" || "${FORCE_RESIGN:-0}" == "1" ]]; then
  rm -f /tmp/pentagon-aligned.apk
  zipalign -f -p 4 /opt/release/app-release-unsigned.apk /tmp/pentagon-aligned.apk
  apksigner sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
    --out "$APK" /tmp/pentagon-aligned.apk
fi

apksigner verify --verbose --print-certs "$APK"
sha256sum "$APK" | awk '{print $1}' > "$SHA"
apksigner verify --print-certs "$APK" | awk -F': ' '/Signer #1 certificate SHA-256 digest/{print $2; exit}' > "$SIGNER"
chmod 600 "$KEYSTORE" "$PASSFILE"
chmod 644 "$APK" "$SHA" "$SIGNER"
exec python3 /opt/release/release-server.py
