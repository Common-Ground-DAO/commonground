#!/bin/bash
# Prints the hash values for a manual pin update (docs/infrastructure/UPDATE-POLICY.md,
# "Manual update procedures"). It changes no file — copy the printed values into
# the script/Dockerfiles named in the output. Needs curl, jq, openssl,
# sha256sum/sha512sum and base64.
#
#   tools/update-pins.sh mediasoup <version>   asset sha256s for fetch_mediasoup_worker.sh
#   tools/update-pins.sh chrome <version>      Chrome for Testing sha256 for fetch_chrome.sh
#   tools/update-pins.sh corepack <version>    COREPACK_SHA512 for the four Dockerfiles
#   tools/update-pins.sh yarn <version>        packageManager value (yarn@<v>+sha512.<hash>)
#
# Check the publication date it prints against the 7-day rule before pinning.
set -euo pipefail

usage() { sed -n '7,10p' "$0" | sed 's/^#   //' >&2; exit 2; }
[ $# -eq 2 ] || usage
what="$1"; version="$2"
case "$version" in *[!0-9A-Za-z.-]*|'') echo "invalid version: $version" >&2; exit 2 ;; esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# hex sha512 of an npm tarball, after checking it against the registry's integrity
npm_tarball() { # <package> <version> -> sets tarball path in $tmp/pkg.tgz, prints published date
  local meta integrity
  meta="$(curl -fsSL "https://registry.npmjs.org/$1")"
  echo "published: $(jq -r --arg v "$2" '.time[$v] // "unknown version"' <<<"$meta")"
  integrity="$(jq -r --arg v "$2" '.versions[$v].dist.integrity // empty' <<<"$meta")"
  [ -n "$integrity" ] || { echo "$1@$2 not found on the npm registry" >&2; exit 1; }
  curl -fsSL "$(jq -r --arg v "$2" '.versions[$v].dist.tarball' <<<"$meta")" -o "$tmp/pkg.tgz"
  [ "$(openssl dgst -sha512 -binary "$tmp/pkg.tgz" | base64 -w0)" = "${integrity#sha512-}" ] || {
    echo "$1@$2: tarball does not match the registry integrity" >&2; exit 1; }
}

case "$what" in
  mediasoup)
    rel="$(curl -fsSL "https://api.github.com/repos/versatica/mediasoup/releases/tags/$version")"
    echo "published: $(jq -r '.published_at' <<<"$rel")"
    echo "docker/backend/fetch_mediasoup_worker.sh: MEDIASOUP_VERSION=\"$version\", case entries:"
    jq -r '.assets[] | select(.name | test("-linux-(x64|arm64)-kernel[0-9]+\\.tgz$"))
           | "  \(.name))\tsha=\(.digest | sub("^sha256:"; "")) ;;"' <<<"$rel"
    ;;
  chrome)
    url="https://storage.googleapis.com/chrome-for-testing-public/$version/linux64/chrome-linux64.zip"
    headers="$(curl -fsSI "$url")"
    echo "last-modified: $(grep -i '^last-modified:' <<<"$headers" | cut -d' ' -f2- | tr -d '\r')"
    md5="$(grep -i '^x-goog-hash: md5=' <<<"$headers" | sed 's/^[^=]*=//' | tr -d '\r')"
    curl -fsSL "$url" -o "$tmp/chrome.zip"
    [ "$(openssl dgst -md5 -binary "$tmp/chrome.zip" | base64)" = "$md5" ] || {
      echo "download does not match the md5 Google Cloud Storage reports" >&2; exit 1; }
    echo "md5 matches x-goog-hash"
    echo "docker/backend/fetch_chrome.sh:"
    echo "  CHROME_VERSION=\"$version\""
    echo "  CHROME_SHA256=\"$(sha256sum "$tmp/chrome.zip" | cut -d' ' -f1)\""
    ;;
  corepack)
    npm_tarball corepack "$version"
    echo "docker/node/Dockerfile, docker/hardhat/Dockerfile, docker/backend/Dockerfile, docker/backend/Dockerfile_dev_stage_0:"
    echo "  ARG COREPACK_VERSION=$version"
    echo "  ARG COREPACK_SHA512=$(sha512sum "$tmp/pkg.tgz" | cut -d' ' -f1)"
    ;;
  yarn)
    npm_tarball @yarnpkg/cli-dist "$version"
    tar -xzf "$tmp/pkg.tgz" -C "$tmp" package/bin/yarn.js
    echo "packageManager (package.json, srv/, sdk/, docker/hardhat/node/) and corepack install -g in docker/node/Dockerfile:"
    echo "  yarn@$version+sha512.$(sha512sum "$tmp/package/bin/yarn.js" | cut -d' ' -f1)"
    ;;
  *) usage ;;
esac
