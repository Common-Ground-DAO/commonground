// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from 'node:fs';
import path from 'node:path';
import type { InlineConfig, Plugin, ResolvedConfig } from 'vite';

/**
 * Builds `src/service-worker.ts` and injects the Workbox precache manifest.
 *
 * Replaces react-scripts' built-in `WorkboxWebpackPlugin.InjectManifest` plus
 * the `craco.config.js` patch on top of it. Deliberately *not*
 * `vite-plugin-pwa`: the hand-written service worker and the hand-rolled
 * registration manager (`src/data/appstate/serviceWorker.ts`) stay as they are;
 * all this needs to do is emit exactly `/service-worker.js` at the dist root
 * with `self.__WB_MANIFEST` filled in.
 *
 * Two-step, because `workbox-build`'s `injectManifest` is a string substitution
 * on an already-bundled worker:
 *   1. a nested Vite build bundles the worker (IIFE, unhashed) into a temp dir,
 *   2. `injectManifest` globs the finished dist and writes the result to
 *      `<outDir>/service-worker.js`.
 *
 * Fail-closed: any failure aborts the build unless `DEPLOYMENT=dev`, mirroring
 * the guard the old `craco.config.js` workbox patch had. Two checks are
 * stricter than that and abort regardless of `DEPLOYMENT`, because they guard silent
 * product regressions rather than tooling breakage:
 *
 *   - the nested worker build must emit exactly the worker (+ its sourcemap);
 *     a stray import that makes rollup split the worker would produce chunks
 *     that are never served and never precached (`assertWorkerBundleIsSingleFile`);
 *   - every emitted JS/CSS entry and chunk must end up in the precache manifest
 *     (`assertPrecacheCoversAllCode`). Falling out of the precache is what
 *     workbox reports with a *log line* — it costs offline cold start and makes
 *     the first load after an update refetch the missing chunk over the network.
 */

const SW_TMP_DIR = '.cg-sw-build';
const SW_FILENAME = 'service-worker.js';

/**
 * Precache size cap, back at CRA's default. It was temporarily 8 MiB, because
 * Vite's default chunking emitted a single ~5.6 MB app chunk where CRA's
 * `splitChunks: { chunks: 'all' }` had spread the same code over many; the
 * `manualChunks` vendor groups in vite.config.ts brought the largest emitted
 * chunk back to ~2.2 MiB. The 2026-08 dependency refresh grew `vendor-web3`
 * to ~3.6 MiB (partly a duplicated viem pulled in via `@safe-global`, expected
 * to collapse again with the wagmi-2 wave) — still under the cap, but the
 * headroom is now ~1.4 MiB, not "plenty"; re-measure before making anything
 * else in the web3 group eager.
 *
 * `assertPrecacheCoversAllCode` below turns any future overrun into a build
 * failure instead of a log line, so this number cannot silently rot.
 */
const MAX_PRECACHE_FILE_SIZE = 5 * 1024 * 1024;

/** Aborts the build regardless of `DEPLOYMENT` (see the plugin doc comment). */
class FatalServiceWorkerError extends Error {}

export type ServiceWorkerPluginOptions = {
  /** Worker entry, relative to the project root. */
  swSrc: string;
  /** Extra plugins the worker bundle needs (resolvers, polyfills, …). */
  plugins: Plugin[];
};

export function serviceWorker(options: ServiceWorkerPluginOptions): Plugin {
  let config: ResolvedConfig;
  let bundleFailed = false;

  return {
    name: 'cg:service-worker',
    apply: 'build',
    enforce: 'post',

    configResolved(resolved) {
      config = resolved;
    },

    // Rollup runs `closeBundle` even when the build already failed. This
    // plugin's failure path calls `process.exit(1)`, which then kills the
    // process before Vite prints the error that actually broke the build — a
    // syntax error in `src/` used to surface as a workbox stack trace. Stand
    // down instead. (Rollup's `renderError` would cover output-phase failures
    // too, but Vite 6 never forwarded it and the `buildEnd` route works
    // identically on Vite 7, so it stays; assertions that run in
    // `generateBundle` print their own message for that reason.)
    buildEnd(error) {
      if (error) bundleFailed = true;
    },

    async closeBundle() {
      if (bundleFailed) return;
      // Only the client build emits a service worker; guard against being run
      // for a worker/ssr sub-build.
      if (config.build.ssr) return;

      const outDir = path.resolve(config.root, config.build.outDir);
      const tmpDir = path.join(outDir, SW_TMP_DIR);

      try {
        await buildWorker(config, options, tmpDir);
        await injectPrecacheManifest(config, tmpDir, outDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.error('\x1b[31m%s\x1b[0m', '[cg:service-worker]');
        console.error('\x1b[31m%s\x1b[0m', (error as Error).stack ?? String(error));
        // The two integrity assertions are not tooling breakage — they mean the
        // build produced a broken worker or an incomplete precache. Those abort
        // on every deployment, including `dev`.
        if (error instanceof FatalServiceWorkerError || process.env.DEPLOYMENT !== 'dev') {
          process.exit(1);
        }
      }

      if (!fs.existsSync(path.join(outDir, SW_FILENAME)) && process.env.DEPLOYMENT !== 'dev') {
        console.error(
          '\x1b[31m%s\x1b[0m',
          '[cg:service-worker] no service-worker.js was emitted, but it is required for a non-dev build',
        );
        process.exit(1);
      }
    },
  };
}

async function buildWorker(
  config: ResolvedConfig,
  options: ServiceWorkerPluginOptions,
  tmpDir: string,
): Promise<void> {
  const { build } = await import('vite');

  const inlineConfig: InlineConfig = {
    root: config.root,
    base: config.base,
    mode: config.mode,
    configFile: false,
    envFile: false,
    logLevel: 'warn',
    publicDir: false,
    plugins: options.plugins,
    resolve: { alias: config.resolve.alias },
    define: {
      // The only build-time env token in shipped code: CRA substituted it
      // via DefinePlugin. Scoped to this exact member expression on purpose
      // — `src/common/` is dual-runtime and must never see a blanket
      // `process`/`process.env` define.
      'process.env.PUBLIC_URL': JSON.stringify(config.base.replace(/\/$/, '')),
    },
    build: {
      outDir: tmpDir,
      emptyOutDir: true,
      sourcemap: config.build.sourcemap,
      target: config.build.target,
      minify: config.build.minify,
      copyPublicDir: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: path.resolve(config.root, options.swSrc),
        output: {
          format: 'iife',
          entryFileNames: SW_FILENAME,
          // A service worker is a single file; anything the bundler wants to
          // split has to be inlined.
          inlineDynamicImports: true,
        },
      },
    },
  };

  await build(inlineConfig);
  assertWorkerBundleIsSingleFile(config, tmpDir);
}

/**
 * A service worker is registered as one file and nothing else from that build
 * is ever served. If rollup decides to split it — a static import of something
 * it deems shared, a dynamic import `inlineDynamicImports` cannot swallow, an
 * asset emitted from CSS or an `new URL(…, import.meta.url)` — the extra chunks
 * land in the temp dir, get thrown away, and the worker breaks at runtime with
 * a 404 on first fetch. Assert the bundle is exactly the worker + its
 * sourcemap.
 */
function assertWorkerBundleIsSingleFile(config: ResolvedConfig, tmpDir: string): void {
  const expected = new Set([SW_FILENAME]);
  if (config.build.sourcemap) expected.add(`${SW_FILENAME}.map`);

  const emitted = listFilesRecursive(tmpDir);
  const unexpected = emitted.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !emitted.includes(file));

  if (unexpected.length > 0 || missing.length > 0) {
    throw new FatalServiceWorkerError(
      'the service-worker bundle is not a single file.\n' +
        `  expected: ${[...expected].join(', ')}\n` +
        `  emitted:  ${emitted.join(', ') || '(nothing)'}\n` +
        (unexpected.length > 0
          ? '  A stray import made rollup split the worker; the extra chunks are ' +
            'never served. Inline it or move it out of the worker.\n'
          : ''),
    );
  }
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files.sort();
}

/**
 * Every emitted JS/CSS entry and chunk must be in the precache manifest.
 *
 * Workbox only *logs* when a file exceeds `maximumFileSizeToCacheInBytes`, and
 * a glob/ignore mistake does not even do that — either way the app shell would
 * still install, then hit the network for the missing chunk and fail offline.
 * Compare the shipped `static/js` + `static/css` set against the manifest and
 * fail the build on any difference.
 *
 * Deliberate excludes are scoped out by construction: `.map` and `LICENSE`
 * files, `index_cgid.html`, `asset-manifest.json` and small `static/media`
 * SVGs are none of them JS or CSS.
 */
function assertPrecacheCoversAllCode(outDir: string, base: string, manifestURLs: Set<string>): void {
  const code: string[] = [];
  for (const [dir, ext] of [
    ['static/js', '.js'],
    ['static/css', '.css'],
  ]) {
    for (const file of listFilesRecursive(path.join(outDir, dir))) {
      if (file.endsWith(ext)) code.push(`${dir}/${file}`);
    }
  }

  // `modifyURLPrefix` has already prefixed the manifest URLs with `base`.
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const missing = code.filter((file) => !manifestURLs.has(prefix + file));

  if (missing.length > 0) {
    const detail = missing
      .map((file) => `    ${file} (${(fs.statSync(path.join(outDir, file)).size / 1024 / 1024).toFixed(2)} MiB)`)
      .join('\n');
    throw new FatalServiceWorkerError(
      `${missing.length} emitted JS/CSS file(s) are not in the precache manifest:\n${detail}\n` +
        `  Precaching every entry and chunk is what makes an offline cold start work.\n` +
        `  If a chunk is over the ${(MAX_PRECACHE_FILE_SIZE / 1024 / 1024).toFixed(0)} MiB cap, either split it ` +
        `(build.rollupOptions.output.manualChunks) or raise MAX_PRECACHE_FILE_SIZE.`,
    );
  }
}

async function injectPrecacheManifest(
  config: ResolvedConfig,
  tmpDir: string,
  outDir: string,
): Promise<void> {
  const { injectManifest } = await import('workbox-build');

  // `injectManifest` reports only count/size, so capture the manifest itself
  // from the last transform in the chain (workbox runs user `manifestTransforms`
  // after the size cap, `modifyURLPrefix` and `dontCacheBustURLsMatching` —
  // see node_modules/workbox-build/build/lib/transform-manifest.js).
  const manifestURLs = new Set<string>();

  const { count, size, warnings } = await injectManifest({
    swSrc: path.join(tmpDir, SW_FILENAME),
    swDest: path.join(outDir, SW_FILENAME),
    globDirectory: outDir,
    // Exactly the asset set webpack used to hand to InjectManifest: the build
    // output, not the verbatim `public/` copy. The four fonts, four mp3s and
    // two cross-origin-isolation shells are added by hand in
    // `src/service-worker.ts` and must not be duplicated here.
    globPatterns: ['*.html', 'static/**/*'],
    globIgnores: [
      // Never precache the second entry's shell — the navigation fallback is
      // `/index.html` and `/index_cgid.html` is denied on the main vhost.
      'index_cgid.html',
      // These three were CRA's defaults, but the craco patch short-circuited
      // them, so sourcemaps and LICENSE files *were* precached under CRA.
      // Applying them here is a deliberate bugfix; expect the manifest to
      // shrink noticeably against the CRA baseline.
      '**/*.map',
      '**/*LICENSE*',
      '**/asset-manifest.json',
      // The worker precaching itself is another artefact of the same bug.
      SW_FILENAME,
      `${SW_TMP_DIR}/**`,
      // `public/` is copied verbatim and was never a webpack asset, so CRA
      // never precached it either — the entries that matter (fonts, call
      // sounds, the cross-origin-isolation shells) are pushed by hand in
      // src/service-worker.ts. `*.html` above would otherwise pick up the
      // Google site-verification file.
      'google*.html',
    ],
    // webpack emitted absolute URLs (`/static/js/…`) because of `publicPath`;
    // workbox's glob mode emits them relative to globDirectory. Both resolve
    // identically against the worker's scope, but keep the shipped form
    // identical to the CRA output.
    modifyURLPrefix: { '': config.base },
    // Vite is configured for hex content hashes (see vite.config.ts), so the
    // CRA-era pattern still applies: a hashed URL needs no separate revision.
    dontCacheBustURLsMatching: /\.[0-9a-f]{8}\./,
    maximumFileSizeToCacheInBytes: MAX_PRECACHE_FILE_SIZE,
    // Under Vite + svgr, component-imported SVGs are compiled to JSX and never
    // emitted as standalone files, so CRA's "skip small static/media SVGs" rule
    // has nothing left to skip. Keep the filter as a tripwire: if a small SVG
    // ever *is* emitted, it stays out of the precache — the CRA-era build
    // scripts deleted small SVGs after the build, and a precached URL that 404s
    // makes `PrecacheController.install()` reject, so the worker never
    // activates and PWA updates stop silently.
    // Runs *after* `modifyURLPrefix`, so the URLs are already `base`-prefixed;
    // strip the leading slash to get back to a path under globDirectory.
    manifestTransforms: [
      (entries) => ({
        manifest: entries.filter((entry) => {
          const url = entry.url.replace(/^\//, '');
          if (!/^static\/media\/.+\.svg$/.test(url)) return true;
          return fs.statSync(path.join(outDir, url)).size >= 5000;
        }),
        warnings: [],
      }),
      (entries) => {
        for (const entry of entries) manifestURLs.add(entry.url);
        return { manifest: entries, warnings: [] };
      },
    ],
  });

  assertPrecacheCoversAllCode(outDir, config.base, manifestURLs);

  for (const warning of warnings) {
    console.warn('[cg:service-worker]', warning);
  }
  console.log(
    `[cg:service-worker] ${SW_FILENAME} — ${count} precache entries, ${(size / 1024 / 1024).toFixed(2)} MiB`,
  );
}
