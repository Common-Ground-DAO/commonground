// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The build ID (src/common/buildId.ts) as a build-time value.
 *
 * It used to be written into the tracked `src/common/random_build_id.ts` by
 * every build script (`sed`), which left every build with a modified checkout.
 * Now each Vite build takes `CG_BUILD_ID` from its environment or draws a fresh
 * random one, replaces `__CG_BUILD_ID__` in the app bundle and the service
 * worker with it (`define`), and writes it to `build/build-id.txt`. The build
 * scripts hand that file's content to the backend image as its `CG_BUILD_ID`
 * (`--build-arg`), so frontend and backend of one build carry the same ID.
 *
 * The dev server (`vite`, `./run.sh start`) draws none: it uses the ID of the
 * frontend deployed in the dev stack (`docker/caddy/dist/build-id.txt`), which
 * is the one the dev backend was built with (`docker/build.sh`,
 * `updateBackend.sh`, `updateFrontend.sh` keep the two equal), or `dev` — the
 * backend's own fallback — when there is none. So a page served by the dev
 * server is not told about a "new version" by the dev backend. It reads the
 * file at start: restart the dev server after rebuilding the dev stack.
 *
 * `build-id.txt` is not precached by the service worker (its glob covers only
 * `*.html` and `static/`) and is harmless to serve: the websocket sends the
 * same ID to every client.
 */

export const BUILD_ID_FILE = 'build-id.txt';

/** The deployed dev-stack frontend's ID file, relative to the repository root. */
const DEV_STACK_BUILD_ID = path.join('docker', 'caddy', 'dist', BUILD_ID_FILE);

/** The backend's fallback when it was built without an ID (src/common/buildId.ts). */
const FALLBACK_BUILD_ID = 'dev';

/** What `--build-arg` and a URL-safe file content can carry without quoting. */
const BUILD_ID_PATTERN = /^[A-Za-z0-9+/=_-]{1,64}$/;

/** `CG_BUILD_ID` if set (validated), else 10 random bytes, base64url. */
export function resolveBuildId(fromEnv: string | undefined = process.env.CG_BUILD_ID): string {
  const given = fromEnv?.trim();
  if (given) {
    if (!BUILD_ID_PATTERN.test(given)) {
      throw new Error(`CG_BUILD_ID must match ${BUILD_ID_PATTERN} (got ${JSON.stringify(given)})`);
    }
    return given;
  }
  return randomBytes(10).toString('base64url');
}

/** The dev server's ID: the deployed dev-stack frontend's, else `dev`. */
export function devServerBuildId(root: string): string {
  try {
    const deployed = fs.readFileSync(path.join(root, DEV_STACK_BUILD_ID), 'utf8').trim();
    if (BUILD_ID_PATTERN.test(deployed)) return deployed;
  } catch {
    // no dev stack built yet
  }
  return FALLBACK_BUILD_ID;
}

/** The `define` entry for a Vite build (the app and the nested worker build). */
export function buildIdDefine(buildId: string): Record<string, string> {
  return { __CG_BUILD_ID__: JSON.stringify(buildId) };
}

/**
 * Defines `__CG_BUILD_ID__` — `buildId` for a build, the dev stack's ID for
 * the dev server — and emits `build-id.txt` (build only).
 */
export function buildIdPlugin(buildId: string, root: string): Plugin {
  return {
    name: 'cg:build-id',
    config: (_config, { command }) => ({
      define: buildIdDefine(command === 'serve' ? devServerBuildId(root) : buildId),
    }),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: BUILD_ID_FILE, source: `${buildId}\n` });
    },
  };
}
