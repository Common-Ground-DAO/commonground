// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Injects the entry module script into each HTML entry.
 *
 * The two templates (`index.html`, `index_cgid.html`) deliberately contain no
 * `<script src>` of their own: CRA's HtmlWebpackPlugin injects the bundles
 * itself and would choke on a hardcoded `/src/index.tsx` (it would survive into
 * the production HTML and 404). Injecting from a `transformIndexHtml` pre-hook
 * keeps a single set of templates working for both build stacks — pre-hooks run
 * before Vite's `vite:build-html` scans the document for module scripts, so the
 * injected tag is picked up as a real entry.
 *
 * Dies with `craco.config.js` in Phase 3 (the templates can carry the script
 * tags directly once CRA is gone) — but there is no cost to keeping it.
 */
export function htmlEntryScripts(entries: Record<string, string>): Plugin {
  let isBuild = false;

  return {
    name: 'cg:html-entry-scripts',

    configResolved(config) {
      isBuild = config.command === 'build';
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = path.basename(ctx.filename);
        const entry = entries[file];
        if (!entry) {
          // At build time this hook only ever sees the configured rollup
          // inputs, so a miss is a config bug. The dev server runs it for every
          // served `.html` — `public/` also holds the Google site-verification
          // file — where the right answer is "leave it alone".
          if (isBuild) {
            throw new Error(`cg:html-entry-scripts: no entry module configured for ${file}`);
          }
          return html;
        }
        return {
          html,
          tags: [{ tag: 'script', attrs: { type: 'module', src: entry }, injectTo: 'body' }],
        };
      },
    },
  };
}
