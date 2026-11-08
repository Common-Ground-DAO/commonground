// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// The build ID ties a frontend build to the backend built with it: the
// websocket greets every client with the backend's ID (srv/wsapi.ts), a client
// whose own ID differs knows that a new version is deployed
// (src/data/appstate/webSocket.ts), and the service worker uses it as the
// precache revision of the unhashed files it adds by hand.
//
// It is set at build time, never in a tracked file (docs/infrastructure/README.md,
// "Build ID"):
//   - browser bundles: Vite replaces __CG_BUILD_ID__ (vite/buildId.ts) with
//     CG_BUILD_ID from the build environment or a fresh random ID per build,
//     and writes it to build/build-id.txt; the dev server uses the ID of the
//     deployed dev frontend, the one the dev backend carries;
//   - backend: the CG_BUILD_ID environment variable of the backend image,
//     which the build scripts take from build-id.txt.
// Anything else (unit tests, a backend image built without it) gets "dev".
//
// (src/common/random_build_id.ts is the former, tracked home of the ID and no
// longer read; it is left unchanged until it is deleted, see docs/todo/TODO.md.)
declare const __CG_BUILD_ID__: string | undefined;

const buildId: string =
  (typeof __CG_BUILD_ID__ === 'string' && __CG_BUILD_ID__) ||
  // dual-runtime module (srv/common is a symlink to src/common): `process`
  // only exists in the backend, and the browser bundle must not reference it
  // directly (vite.config.ts, nodePolyfills)
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CG_BUILD_ID ||
  'dev';

export default buildId;
