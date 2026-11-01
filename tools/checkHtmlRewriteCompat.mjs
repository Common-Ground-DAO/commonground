#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Verifies that the emitted HTML shells still fit the two consumers that
 * depend on their exact markup at serve time. Both fail *silently* when the
 * markup shape drifts — a duplicated or leftover meta tag, an instance config
 * that never loads, an inline script the CSP blocks — so this check exists to
 * make that drift loud.
 *
 *   1. `srv/api/getRoutes.ts` — strips the default social meta tags with two
 *      regexes and splices per-item og/twitter meta in before `</head>`; it
 *      injects `window.__CG_INSTANCE__` inline after the literal `<head>` only
 *      when the shell does not load `/instance-config.js`. This is on the
 *      critical path for deep links: Caddy proxies all `/c/…`, `/u/…`
 *      requests to the API.
 *   2. The Caddy edge (`docker/caddy/common.caddy`, `Caddyfile.selfhost`) —
 *      renders `/instance-config.js` per instance, which both shells must load
 *      as a deferred classic script ahead of the entry module, and allows
 *      inline scripts only by hash: every inline `<script>` of `index.html`
 *      must have its sha256 in the CSP of `common.caddy`, and `index_cgid.html`
 *      (served by the CG ID vhost, whose CSP allows no inline script) must
 *      have none.
 *
 * The rewrite logic below is copied verbatim from getRoutes.ts; keep it in
 * sync.
 *
 * Usage: node tools/checkHtmlRewriteCompat.mjs [distDir]   (default: build)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(process.argv[2] ?? 'build');
const caddyCommon = fileURLToPath(new URL('../docker/caddy/common.caddy', import.meta.url));

// --- srv/api/getRoutes.ts:56-57,66-68,76-87 -------------------------------
const STRIP_OG = /<meta +property="(og:title|og:description|og:type|og:image|og:url)" +content="[^"]+" *\/?>/g;
const STRIP_TWITTER = /<meta +name="(twitter:title|twitter:description|twitter:image|description)" +content="[^"]+" *\/?>/g;
const INSTANCE_CONFIG_TAG = 'src="/instance-config.js"';

// inline scripts: <script> elements without a src attribute
const INLINE_SCRIPT = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

let failures = 0;
/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail) {
  const status = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${status}] ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** @returns {Set<string>} the `'sha256-…'` sources in the edge's app CSP */
function cspScriptHashes() {
  if (!existsSync(caddyCommon)) {
    check('docker/caddy/common.caddy exists', false, caddyCommon);
    return new Set();
  }
  const caddy = readFileSync(caddyCommon, 'utf8');
  return new Set(caddy.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? []);
}

/**
 * @param {string} file
 * @param {{ expectSocialMeta: boolean, allowedInlineHashes: Set<string> }} options
 */
function checkFile(file, { expectSocialMeta, allowedInlineHashes }) {
  const full = path.join(distDir, file);
  console.log(`\n${file}`);
  if (!existsSync(full)) {
    check('file exists', false, full);
    return;
  }
  const html = readFileSync(full, 'utf8');

  // --- consumer 2: the Caddy edge -----------------------------------------
  const configTags = html.match(/<script\b[^>]*\bsrc="\/instance-config\.js"[^>]*>\s*<\/script>/g) ?? [];
  check('loads /instance-config.js exactly once', configTags.length === 1, `found ${configTags.length}`);
  if (configTags.length === 1) {
    const tag = configTags[0];
    check('/instance-config.js is a deferred classic script', /\sdefer[\s>]/.test(tag) && !/type="module"/.test(tag), tag);
    const firstModule = html.search(/<script\b[^>]*type="module"/);
    check(
      '/instance-config.js comes before the entry module',
      firstModule === -1 || html.indexOf(tag) < firstModule,
      'a module script precedes it',
    );
  }

  const inline = [...html.matchAll(INLINE_SCRIPT)];
  for (const [, body] of inline) {
    const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    check(
      `inline script ${hash} is allowed by the edge CSP`,
      allowedInlineHashes.has(hash),
      `add it to script-src-elem in docker/caddy/common.caddy (and drop the stale hash)`,
    );
  }
  check('no inline script declares __CG_INSTANCE__', !inline.some(([, body]) => body.includes('__CG_INSTANCE__')));

  // --- consumer 1: the API's index.html rewriting ------------------------
  const headCount = (html.match(/<head>/g) ?? []).length;
  check('literal `<head>` present exactly once', headCount === 1, `found ${headCount}`);
  check('no attributed/uppercase head tag', !/<head\s[^>]*>/i.test(html) && !/<HEAD>/.test(html));
  check('API leaves the instance config to /instance-config.js', html.includes(INSTANCE_CONFIG_TAG));

  const closeCount = (html.match(/<\/head>/g) ?? []).length;
  check('literal `</head>` present exactly once', closeCount === 1, `found ${closeCount}`);

  const stripped = html.replace(STRIP_OG, '').replace(STRIP_TWITTER, '');
  const ogLeft = (stripped.match(/property="og:(title|description|type|image)"/g) ?? []).length;
  const twLeft = (stripped.match(/name="(twitter:title|twitter:description|twitter:image|description)"/g) ?? []).length;
  if (expectSocialMeta) {
    const ogBefore = (html.match(/property="og:(title|description|type|image)"/g) ?? []).length;
    check('default og meta present to strip', ogBefore === 4, `found ${ogBefore}`);
    check('all strippable og meta removed', ogLeft === 0, `${ogLeft} left`);
    check('all strippable twitter/description meta removed', twLeft === 0, `${twLeft} left`);
    // Known, pre-existing: without `PUBLIC_URL`, `og:url` ships with an empty
    // `content=""` (it used to be `%PUBLIC_URL%`) and the strip regex requires
    // a non-empty value, so it survives. With `PUBLIC_URL` set (the two legacy
    // Azure pipelines) `vite/absoluteSocialMeta.ts` fills it in and it *is*
    // stripped — exactly as under CRA. Both shapes are correct; a *third* one
    // would mean the plugin or the template drifted.
    check(
      'og:url is either the empty-content exception or stripped as absolute',
      /property="og:url" content=""/.test(stripped) || !/property="og:url"/.test(stripped),
      'unexpected og:url shape',
    );
  }

  const insertPos = stripped.indexOf('</head>');
  check('`</head>` splice point found', insertPos !== -1);
  const rewritten =
    stripped.substring(0, insertPos) +
    '<meta name="description" content="x" />' +
    stripped.substring(insertPos);
  check('spliced meta lands inside head', rewritten.indexOf('<meta name="description" content="x" />') < rewritten.indexOf('</head>'));
}

console.log(`HTML rewrite-compatibility check — ${distDir}`);
checkFile('index.html', { expectSocialMeta: true, allowedInlineHashes: cspScriptHashes() });
// the CG ID vhost's CSP (Caddyfile.selfhost) allows no inline script at all
checkFile('index_cgid.html', { expectSocialMeta: true, allowedInlineHashes: new Set() });

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
