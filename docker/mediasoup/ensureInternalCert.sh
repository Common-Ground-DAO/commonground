#!/bin/bash
# Creates the dev stack's self-signed certificate for the hop from caddy to
# mediasoup's signalling listener, if it is missing. mediasoup only serves
# HTTPS; caddy terminates the browser's wss on :4443 with its own certificate
# and does not verify this one, so no browser ever sees it and no CA is
# involved. Output: docker/mediasoup/certs/server.{crt,key} (gitignored),
# mounted read-only into the mediasoup container.
#
# Called by run.sh (up), docker/build.sh and docker/updateBackend.sh. The
# self-host profile makes its own in docker/selfhost/init.sh.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"

if [ -f "$dir/server.crt" ] && [ -f "$dir/server.key" ]; then
  exit 0
fi
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=mediasoup" \
  -keyout "$dir/server.key" \
  -out "$dir/server.crt" 2>/dev/null
chmod 644 "$dir/server.crt"
chmod 600 "$dir/server.key"
echo "Wrote docker/mediasoup/certs/ (internal cert for the caddy->mediasoup hop)"
