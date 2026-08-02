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
 * the guard at `craco.config.js` (the old §2.5 patch).
 */

const SW_TMP_DIR = '.cg-sw-build';
const SW_FILENAME = 'service-worker.js';

export type ServiceWorkerPluginOptions = {
  /** Worker entry, relative to the project root. */
  swSrc: string;
  /** Extra plugins the worker bundle needs (resolvers, polyfills, …). */
  plugins: Plugin[];
};

export function serviceWorker(options: ServiceWorkerPluginOptions): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'cg:service-worker',
    apply: 'build',
    enforce: 'post',

    configResolved(resolved) {
      config = resolved;
    },

    async closeBundle() {
      // Only the client build emits a service worker; guard against being run
      // for a worker/ssr sub-build.
      if (config.build.ssr) return;

      const outDir = path.resolve(config.root, config.build.outDir);
      const tmpDir = path.join(outDir, SW_TMP_DIR);

      try {
        await buildWorker(config, options, tmpDir);
        await injectPrecacheManifest(config, tmpDir, outDir);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('\x1b[31m%s\x1b[0m', '[cg:service-worker]');
        // eslint-disable-next-line no-console
        console.error('\x1b[31m%s\x1b[0m', (error as Error).stack ?? String(error));
        if (process.env.DEPLOYMENT !== 'dev') {
          process.exit(1);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      if (!fs.existsSync(path.join(outDir, SW_FILENAME)) && process.env.DEPLOYMENT !== 'dev') {
        // eslint-disable-next-line no-console
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
      // The only build-time env token in shipped code (§7.2): CRA substituted
      // it via DefinePlugin. Scoped to this exact member expression on purpose
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
}

async function injectPrecacheManifest(
  config: ResolvedConfig,
  tmpDir: string,
  outDir: string,
): Promise<void> {
  const { injectManifest } = await import('workbox-build');

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
      // them, so sourcemaps and LICENSE files *are* precached today (§2.5).
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
    // CRA's default, kept per the roadmap decision. Note that Vite's default
    // chunking produces one very large `App` chunk where CRA's
    // `splitChunks: { chunks: 'all' }` spread the same code over many — see the
    // "chunking" note in docs/todo/ROADMAP_BUILD_STACK_VITE.md; anything above
    // this limit is logged by workbox and simply stays out of the precache.
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    // Under Vite + svgr, component-imported SVGs are compiled to JSX and never
    // emitted as standalone files, so CRA's "skip small static/media SVGs" rule
    // has nothing left to skip. Keep the filter as a tripwire: if a small SVG
    // ever *is* emitted, it stays out of the precache (the shipped SVG-prune
    // loops in docker/build.sh would otherwise delete a precached URL and stop
    // the worker from ever activating, §10.1).
    manifestTransforms: [
      (entries) => ({
        manifest: entries.filter((entry) => {
          if (!/^static\/media\/.+\.svg$/.test(entry.url)) return true;
          const size = fs.statSync(path.join(outDir, entry.url)).size;
          return size >= 5000;
        }),
        warnings: [],
      }),
    ],
  });

  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn('[cg:service-worker]', warning);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[cg:service-worker] ${SW_FILENAME} — ${count} precache entries, ${(size / 1024 / 1024).toFixed(2)} MiB`,
  );
}
