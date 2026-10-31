#!/bin/sh
# Installs the Chrome for Testing build puppeteer is pinned to (srv/api/util.ts
# htmlToImage), verified by sha256, plus the Debian packages it needs.
#
# Why not puppeteer's own postinstall: it downloads the same archive but checks
# no hash (Chrome for Testing publishes none). The Dockerfiles set
# PUPPETEER_SKIP_DOWNLOAD so that postinstall does nothing, and
# PUPPETEER_EXECUTABLE_PATH to the binary installed here.
#
# The sha256 was recorded on first download (2026-10-31) and cross-checked
# against the md5 Google Cloud Storage reports for the object (x-goog-hash
# header) — so it proves every later build gets the bytes Google served then.
#
# Why not Debian's chromium package (apt-verified, security-maintained): it was
# tried on 2026-10-31 — chromium 155 from trixie-security crashes on launch
# with the `--single-process` flag htmlToImage passes, while the pinned Chrome
# for Testing build runs with it. Switching needs that flag dropped in
# srv/api/util.ts first.
#
# Updating puppeteer (srv/package.json): set CHROME_VERSION to the new
# PUPPETEER_REVISIONS.chrome (puppeteer-core/lib/puppeteer/revisions.js),
# download the linux64 zip from the URL below, and record its sha256 (after
# comparing its md5 with `curl -sI <url> | grep x-goog-hash`). The Dockerfile
# fails the build when puppeteer expects a different Chrome than this one.
#
# Architectures: Chrome for Testing is published for linux x64 only. On any
# other architecture this script installs nothing, writes $DEST/UNAVAILABLE
# instead of $DEST/VERSION and succeeds, so the backend image still builds;
# check_pinned_binaries.sh then skips the Chrome comparison. Only the social
# preview images (htmlToImage) fail at runtime there — they need an x86_64
# server. tools/update-pins.sh prints the sha256 for a new version.
set -eu

CHROME_VERSION="151.0.7922.71"
CHROME_SHA256="6bd04aab53fba1544ce6027d9daddb24137295033124a61ecdf9840d785792e9"
DEST="${1:-/opt/chrome}"

machine="$(uname -m)"
if [ "$machine" != "x86_64" ]; then
  # Chrome for Testing has no linux-arm64 build
  mkdir -p "$DEST"
  echo "$machine" > "$DEST/UNAVAILABLE"
  echo "fetch_chrome: WARNING: Chrome for Testing is only published for linux x64, not $machine." >&2
  echo "fetch_chrome: WARNING: skipped — social preview images (htmlToImage) will not work on this server." >&2
  exit 0
fi

url="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"
tmp="$(mktemp)"
echo "fetch_chrome: fetching Chrome for Testing $CHROME_VERSION"
curl -fsSL --retry 3 --connect-timeout 15 --max-time 900 "$url" -o "$tmp"
echo "$CHROME_SHA256  $tmp" | sha256sum -c - >/dev/null || {
  echo "fetch_chrome: sha256 mismatch for $url" >&2
  exit 1
}
mkdir -p "$DEST"
unzip -q "$tmp" -d "$DEST"
rm -f "$tmp"
echo "$CHROME_VERSION" > "$DEST/VERSION"

# Runtime libraries: the archive ships its own Debian dependency list. apt
# resolves it from the dated snapshot the Dockerfile configured (versioned
# Provides cover trixie's t64 package renames, e.g. libasound2t64).
apt-get update
apt-get satisfy -y --no-install-recommends "$(paste -sd, "$DEST/chrome-linux64/deb.deps")"
rm -rf /var/lib/apt/lists/*

"$DEST/chrome-linux64/chrome" --version
echo "fetch_chrome: verified Chrome for Testing $CHROME_VERSION at $DEST"
