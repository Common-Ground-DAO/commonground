#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Verifies that emitted HTML shells stay rewritable by the two consumers that
 * patch them at serve time. Both work with plain string/regex surgery and fail
 * *silently* when the markup shape drifts — a duplicated or leftover meta tag,
 * or an instance config that never gets injected — so this check exists to make
 * that drift loud.
 *
 *   1. `srv/api/getRoutes.ts` — injects `window.__CG_INSTANCE__` after the
 *      literal `<head>`, strips the default social meta tags with two regexes
 *      and splices per-item og/twitter meta in before `</head>`. This is on the
 *      critical path for deep links: nginx proxies all `/c/…`, `/u/…` requests
 *      to the API.
 *   2. `docker/nginx/inject-instance-config.sh` — the selfhost nginx entrypoint
 *      hook, which seds the same script tag after the first `<head>` in both
 *      `/www/index.html` and `/www/index_cgid.html`.
 *
 * The logic below is copied verbatim from those two files; keep it in sync.
 *
 * Usage: node tools/checkHtmlRewriteCompat.mjs [distDir]   (default: build-vite)
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] ?? 'build-vite');

// --- srv/api/getRoutes.ts:52-54,62-64,65-85 -------------------------------
const STRIP_OG = /<meta +property="(og:title|og:description|og:type|og:image|og:url)" +content="[^"]+" *\/?>/g;
const STRIP_TWITTER = /<meta +name="(twitter:title|twitter:description|twitter:image|description)" +content="[^"]+" *\/?>/g;
// srv/util/instanceConfig.ts:61-65
const INSTANCE_SCRIPT = '<script>window.__CG_INSTANCE__ = {"deployment":"dev"};</script>';

// --- docker/nginx/inject-instance-config.sh:54 ----------------------------
// `sed -i "s|<head>|<head>$snippet|"` — sed substitutes the first match per
// *line*, so the marker has to be a literal, attribute-less, lowercase `<head>`.
function sedFirstPerLine(html, from, to) {
  return html
    .split('\n')
    .map((line) => (line.includes(from) ? line.replace(from, to) : line))
    .join('\n');
}

let failures = 0;
function check(label, ok, detail) {
  const status = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${status}] ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function checkFile(file, { expectSocialMeta }) {
  const full = path.join(distDir, file);
  console.log(`\n${file}`);
  if (!existsSync(full)) {
    check('file exists', false, full);
    return;
  }
  const html = readFileSync(full, 'utf8');

  // --- consumer 1: the API's index.html rewriting ------------------------
  const headCount = (html.match(/<head>/g) ?? []).length;
  check('literal `<head>` present exactly once', headCount === 1, `found ${headCount}`);
  check('no attributed/uppercase head tag', !/<head\s[^>]*>/i.test(html) && !/<HEAD>/.test(html));

  const injected = html.replace('<head>', `<head>${INSTANCE_SCRIPT}`);
  check('instance config injects after `<head>`', injected.includes(`<head>${INSTANCE_SCRIPT}`));
  check('injection is idempotent (guard sees the marker)', injected.includes('__CG_INSTANCE__'));

  const closeCount = (html.match(/<\/head>/g) ?? []).length;
  check('literal `</head>` present exactly once', closeCount === 1, `found ${closeCount}`);

  const stripped = injected.replace(STRIP_OG, '').replace(STRIP_TWITTER, '');
  const ogLeft = (stripped.match(/property="og:(title|description|type|image)"/g) ?? []).length;
  const twLeft = (stripped.match(/name="(twitter:title|twitter:description|twitter:image|description)"/g) ?? []).length;
  if (expectSocialMeta) {
    const ogBefore = (injected.match(/property="og:(title|description|type|image)"/g) ?? []).length;
    check('default og meta present to strip', ogBefore === 4, `found ${ogBefore}`);
    check('all strippable og meta removed', ogLeft === 0, `${ogLeft} left`);
    check('all strippable twitter/description meta removed', twLeft === 0, `${twLeft} left`);
    // Known, pre-existing: `og:url` ships with an empty `content=""` (it used
    // to be `%PUBLIC_URL%`), and the strip regex requires a non-empty value.
    check(
      'og:url is the documented empty-content exception',
      /property="og:url" content=""/.test(stripped),
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

  // --- consumer 2: the selfhost nginx entrypoint sed ---------------------
  const sedSnippet = '<script>window.__CG_INSTANCE__ = {"deployment":"prod"};</script>';
  const sedded = sedFirstPerLine(html, '<head>', `<head>${sedSnippet}`);
  check('nginx sed hook injects', sedded.includes(`<head>${sedSnippet}`));
  check('nginx sed hook injects exactly once', (sedded.match(/__CG_INSTANCE__/g) ?? []).length === 1);
  check('nginx sed hook is idempotent (grep guard hits)', /__CG_INSTANCE__/.test(sedded));
}

console.log(`HTML rewrite-compatibility check — ${distDir}`);
checkFile('index.html', { expectSocialMeta: true });
checkFile('index_cgid.html', { expectSocialMeta: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
