#!/bin/sh
# Downloads the prebuilt mediasoup-worker binary into the backend image and
# verifies it by sha256, so the build either gets exactly this binary or fails.
#
# Why not mediasoup's own postinstall: it fetches the same release asset from
# GitHub but never checks a hash, and when no asset matches the build host it
# silently falls back to a from-source build that pip-installs an unpinned
# `invoke` and pulls meson subprojects. The Dockerfiles set
# MEDIASOUP_WORKER_BIN to the binary installed here, which makes that
# postinstall a no-op (mediasoup/npm-scripts.mjs: "MEDIASOUP_WORKER_BIN
# environment variable given, skipping") and points the runtime at it
# (mediasoup/node/lib/Worker.js).
#
# The asset name carries the *build host's* kernel major version
# (`-kernel6` / `-kernel7`), as mediasoup's postinstall picks it — images are
# built on the server that runs them (roadmap decision 5). mediasoup publishes
# no asset for kernels older than 6 (e.g. Ubuntu 22.04's GA 5.15, older WSL2);
# where mediasoup's postinstall would then build from source, this script uses
# the kernel6 asset. The suffix only names the CI runner the asset was built on
# (kernel6: Ubuntu 22.04, kernel7: Ubuntu 26.04 — mediasoup's
# .github/workflows/mediasoup-worker-prebuild.yaml); the worker has had no
# io_uring code of its own since 3.20.7 (CHANGELOG, PR #1832). The self-test at
# the end still fails the build if the binary does not run, and the self-host
# stack defaults to MEDIASOUP_DISABLE_LIBURING=true (libuv's io_uring off). A
# kernel major newer than the pinned assets cover fails with instructions.
#
# tools/update-pins.sh prints the digests for a release.
# Updating mediasoup (srv/package.json): bump MEDIASOUP_VERSION and replace
# the hashes with the `digest` values GitHub lists for the release assets, e.g.
#   curl -s https://api.github.com/repos/versatica/mediasoup/releases/tags/<v> \
#     | jq -r '.assets[] | "\(.name) \(.digest)"'
# The Dockerfile fails the build when the installed mediasoup package and
# this version disagree, so a forgotten bump cannot ship a mismatched worker.
set -eu

MEDIASOUP_VERSION="3.23.2"
DEST="${1:-/opt/mediasoup}"

case "$(uname -m)" in
  x86_64)  arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo "fetch_mediasoup_worker: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
kernel="$(uname -r | cut -d. -f1)"
case "$kernel" in
  ''|*[!0-9]*) echo "fetch_mediasoup_worker: cannot parse kernel version $(uname -r)" >&2; exit 1 ;;
esac
asset_kernel="$kernel"
if [ "$kernel" -lt 6 ]; then
  echo "fetch_mediasoup_worker: kernel $(uname -r) is older than any published asset; using the kernel6 build (verified by the self-test below)"
  asset_kernel=6
fi
asset="mediasoup-worker-${MEDIASOUP_VERSION}-linux-${arch}-kernel${asset_kernel}.tgz"

case "$asset" in
  mediasoup-worker-3.23.2-linux-x64-kernel6.tgz)   sha=24b56bddee0c0956301cc6e3563ef3ade93c69aa6bc1637e60efa9f5be31ac6a ;;
  mediasoup-worker-3.23.2-linux-x64-kernel7.tgz)   sha=3c6aaf1022e23b6798bf77cca90829c9fdba15592aec46ea110e7dda22ee6543 ;;
  mediasoup-worker-3.23.2-linux-arm64-kernel6.tgz) sha=dc842aa30217f7c9dd89c8a1de47e0010468dcd4bbccece026337abdc711a948 ;;
  mediasoup-worker-3.23.2-linux-arm64-kernel7.tgz) sha=5aee57adaa791640c5737ccc2618ac27b5b574a2e628fc50ec60d22b98ff8499 ;;
  *)
    echo "fetch_mediasoup_worker: no pinned hash for $asset (build host kernel $(uname -r))." >&2
    echo "  This mediasoup release has no worker pinned for kernel ${asset_kernel}. Either bump mediasoup" >&2
    echo "  (srv/package.json) to a release that publishes linux-${arch}-kernel${asset_kernel} assets and add" >&2
    echo "  their hashes to docker/backend/fetch_mediasoup_worker.sh (tools/update-pins.sh mediasoup" >&2
    echo "  <version> prints them), or — as a stopgap — map kernel ${asset_kernel} to the newest pinned" >&2
    echo "  kernel asset in that script, next to the rule that maps kernels older than 6 to kernel6;" >&2
    echo "  the worker self-test still fails the build if that binary does not run." >&2
    exit 1 ;;
esac

url="https://github.com/versatica/mediasoup/releases/download/${MEDIASOUP_VERSION}/${asset}"
tmp="$(mktemp)"
echo "fetch_mediasoup_worker: fetching $asset"
curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$url" -o "$tmp"
echo "$sha  $tmp" | sha256sum -c - >/dev/null || {
  echo "fetch_mediasoup_worker: sha256 mismatch for $asset" >&2
  exit 1
}
mkdir -p "$DEST"
tar --no-same-owner -xzf "$tmp" -C "$DEST" mediasoup-worker
rm -f "$tmp"
chmod 755 "$DEST/mediasoup-worker"
echo "$MEDIASOUP_VERSION" > "$DEST/VERSION"

# Same self-test as mediasoup's postinstall: without MEDIASOUP_VERSION in the
# environment the worker exits with status 41 — anything else means the
# binary does not run on this system (libc mismatch, wrong arch, ...).
status=0
env -i "$DEST/mediasoup-worker" >/dev/null 2>&1 || status=$?
if [ "$status" -ne 41 ]; then
  echo "fetch_mediasoup_worker: worker self-test failed (exit $status, expected 41)" >&2
  exit 1
fi
echo "fetch_mediasoup_worker: verified $asset at $DEST"
