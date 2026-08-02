// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * `tsconfig.json` sets `baseUrl: "src"` and no `paths` map, so ~1900 import
 * lines across `src/` use bare specifiers that are really project-relative
 * (`components/atoms/Button/Button`, `common/util`, `data`, `App`,
 * `service-worker`, `…/icon.svg?react`). `vite-tsconfig-paths` only covers an
 * explicit `paths` map and per-root aliases miss the file-level specifiers, so
 * this plugin reimplements the resolution rule itself.
 *
 * Precedence matches the CRA/webpack setup it replaces: react-scripts passes
 * the tsconfig `baseUrl` as `resolve.modules: ['node_modules', …, appSrc]`, so
 * **node_modules wins** and `src/` is the fallback. That is why this plugin
 * carries no `enforce: 'pre'` — normal-order plugins run after Vite's own
 * `vite:resolve`, which is only ever reached for specifiers node resolution
 * could not satisfy.
 */

// webpack's `resolve.extensions` under react-scripts, minus the `.web.*`
// variants (unused here). Extension-less bare specifiers resolve through this
// list; specifiers that already carry an extension (`.svg`, `.css`, `.json`)
// hit the exact-file check first.
const EXTENSIONS = ['.mjs', '.js', '.ts', '.tsx', '.json', '.jsx'];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveInBaseUrl(baseDir: string, specifier: string): string | undefined {
  const candidate = path.join(baseDir, specifier);
  // Never let a `..`-heavy specifier escape the baseUrl directory.
  if (candidate !== baseDir && !candidate.startsWith(baseDir + path.sep)) return undefined;

  if (isFile(candidate)) return candidate;
  for (const ext of EXTENSIONS) {
    if (isFile(candidate + ext)) return candidate + ext;
  }
  if (isDirectory(candidate)) {
    for (const ext of EXTENSIONS) {
      const index = path.join(candidate, 'index' + ext);
      if (isFile(index)) return index;
    }
  }
  return undefined;
}

export function baseUrlResolve(baseUrl = 'src'): Plugin {
  let baseDir = '';
  const cache = new Map<string, string>();

  return {
    name: 'cg:base-url-resolve',

    configResolved(config) {
      baseDir = path.resolve(config.root, baseUrl);
    },

    async resolveId(source, importer, options) {
      // Bare specifiers only: relative, absolute, virtual, URL and
      // `node:`-prefixed requests are none of our business.
      if (
        !source ||
        source.startsWith('.') ||
        source.startsWith('/') ||
        source.startsWith('\0') ||
        source.startsWith('#') ||
        path.isAbsolute(source) ||
        /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(source)
      ) {
        return null;
      }
      // Only first-party code gets baseUrl treatment — a dependency asking for
      // `util` or `stream` must never be answered with `src/util`.
      if (importer && importer.includes('node_modules')) return null;

      const queryIndex = source.search(/[?#]/);
      const specifier = queryIndex === -1 ? source : source.slice(0, queryIndex);
      const suffix = queryIndex === -1 ? '' : source.slice(queryIndex);

      // Only hits are cached: a miss usually means "not a baseUrl specifier at
      // all", and caching it would hide a file created later in a dev session.
      const resolved = cache.get(specifier) ?? resolveInBaseUrl(baseDir, specifier);
      if (!resolved) return null;
      cache.set(specifier, resolved);

      // Hand the absolute path back through the container so `?react` &co keep
      // reaching the plugins that care about them.
      return this.resolve(resolved + suffix, importer, { ...options, skipSelf: true });
    },
  };
}
