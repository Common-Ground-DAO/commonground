#!/bin/sh
# Run after `yarn install` in the backend image: fails the build when the
# installed mediasoup / puppeteer packages expect a different binary than the
# sha256-pinned one fetch_mediasoup_worker.sh / fetch_chrome.sh installed —
# i.e. when a dependency bump forgot to update those scripts. Where
# fetch_chrome.sh skipped Chrome (no Chrome for Testing build for the
# architecture, marker /opt/chrome/UNAVAILABLE), only mediasoup is compared.
set -eu
cd /dist
# shellcheck disable=SC2016 # the ${...} below are JavaScript template literals
node --input-type=module -e '
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire("/dist/package.json");
let failed = false;

const worker = readFileSync("/opt/mediasoup/VERSION", "utf8").trim();
// mediasoup does not export ./package.json; it is a direct dependency, so hoisted
const mediasoup = JSON.parse(readFileSync("/dist/node_modules/mediasoup/package.json", "utf8")).version;
if (worker !== mediasoup) {
  console.error(`mediasoup ${mediasoup} is installed, but the pinned worker is ${worker}: update docker/backend/fetch_mediasoup_worker.sh`);
  failed = true;
}

let chrome = "skipped (no Chrome for Testing build for this architecture)";
if (!existsSync("/opt/chrome/UNAVAILABLE")) {
  chrome = readFileSync("/opt/chrome/VERSION", "utf8").trim();
  const puppeteerCore = require.resolve("puppeteer-core/internal/revisions.js", { paths: [require.resolve("puppeteer")] });
  const { PUPPETEER_REVISIONS } = await import(puppeteerCore);
  if (chrome !== PUPPETEER_REVISIONS.chrome) {
    console.error(`puppeteer expects Chrome ${PUPPETEER_REVISIONS.chrome}, but the pinned Chrome for Testing is ${chrome}: update docker/backend/fetch_chrome.sh`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`check_pinned_binaries: mediasoup ${mediasoup} / worker ${worker}, puppeteer Chrome ${chrome}`);
'
