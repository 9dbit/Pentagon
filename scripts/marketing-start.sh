#!/bin/sh
set -eu
# Only isolated staging volume stores pending early-access requests.
# Initialize mount permissions as root, then drop privileges before Node starts.
if [ "${WHITELIST_ENABLED:-false}" = "true" ]; then
  mkdir -p /data/whitelist
  chown -R node:node /data/whitelist
  chmod 0700 /data/whitelist
fi
exec su -s /bin/sh node -c "node /app/server/marketingPreviewServer.js"
