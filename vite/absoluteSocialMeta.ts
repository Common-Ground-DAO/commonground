// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Plugin } from 'vite';

/**
 * Makes the default social-preview meta tags absolute when `PUBLIC_URL` is set.
 *
 * Background: the HTML templates used to carry CRA's `%PUBLIC_URL%` token, and
 * the two legacy Azure pipelines build with `PUBLIC_URL=https://app.cg` /
 * `https://staging.app.cg` (`pipelines/build-*.yml`). Everything else — run.sh,
 * docker/build.sh, updateFrontend.sh, selfhost.sh — leaves it empty. When the
 * templates were rewritten to root-relative URLs in Phase 2, that was byte
 * parity everywhere except those two pipelines, where `og:image`,
 * `twitter:image` and `og:url` silently went from absolute to relative.
 *
 * For assets that is harmless (same origin either way), but Open Graph and
 * Twitter card scrapers do not resolve relative image URLs — the default
 * preview of the bare `https://app.cg` link would break. So the rewrite is
 * scoped to exactly the tags where absoluteness is load-bearing; asset,
 * manifest and icon URLs stay root-relative on every build path.
 *
 * `PUBLIC_URL` deliberately keeps its CRA name so the legacy pipelines need no
 * change. Unset (every docker/selfhost path) is a no-op: those instances ship
 * relative social meta, which is what they already do today.
 *
 * Brittle by construction, so keep it in mind when editing the templates: the
 * replacement only matches a `content` value that is empty or starts with `/`.
 * Rewriting one of these three tags to a document-relative path
 * (`icons/preview.png`) turns this plugin into a silent no-op, and
 * `yarn check:html-rewrite` cannot catch it — the legacy pipelines scope
 * `PUBLIC_URL` to the `yarn build` command, so the checker never sees a
 * `PUBLIC_URL` build.
 */

const ABSOLUTE_META = [
  { attr: 'property', name: 'og:image' },
  { attr: 'property', name: 'og:url' },
  { attr: 'name', name: 'twitter:image' },
];

export function absoluteSocialMeta(publicUrl: string | undefined): Plugin {
  const origin = (publicUrl ?? '').trim().replace(/\/+$/, '');

  return {
    name: 'cg:absolute-social-meta',

    transformIndexHtml: {
      // After vite:build-html, so the tag shape is the one that ships — and the
      // one `srv/api/getRoutes.ts` and the selfhost nginx sed have to match.
      order: 'post',
      handler(html) {
        if (!origin) return html;

        let out = html;
        for (const { attr, name } of ABSOLUTE_META) {
          // `og:url` ships with an empty `content=""` and becomes the bare
          // origin; the image tags carry a root-relative path.
          const pattern = new RegExp(`(<meta\\s+${attr}="${name}"\\s+content=")(/[^"]*|)(")`, 'g');
          out = out.replace(pattern, (_match, head, value, tail) => `${head}${origin}${value}${tail}`);
        }
        return out;
      },
    },
  };
}
