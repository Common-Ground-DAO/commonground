// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Injects the entry module script into each HTML entry.
 *
 * The two templates (`index.html`, `index_cgid.html`) contain no `<script src>`
 * of their own. That started as a constraint of running CRA and Vite off one
 * set of templates (HtmlWebpackPlugin injects its own bundles and would have
 * shipped a dead `/src/index.tsx` tag), and it is kept now because it keeps the
 * entry wiring in one place — the config declares which module belongs to which
 * shell, and a typo fails the build instead of producing a blank page.
 *
 * Pre-hooks run before Vite's `vite:build-html` scans the document for module
 * scripts, so the injected tag is picked up as a real entry.
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
