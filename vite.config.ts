// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin, ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { absoluteSocialMeta } from './vite/absoluteSocialMeta';
import { baseUrlResolve } from './vite/baseUrlResolve';
import { htmlEntryScripts } from './vite/htmlEntryScripts';
import { serviceWorker } from './vite/serviceWorker';

// The `browserslist.production` floors from package.json, in esbuild's
// notation. Keep the two lists in sync.
const BUILD_TARGET = ['chrome67', 'edge79', 'firefox68', 'opera54', 'safari14'];

// react-scripts' @svgr/webpack options, verbatim
// (node_modules/react-scripts/config/webpack.config.js:392-401). `svgo: false`
// is load-bearing: svgr's default svgo pass strips `viewBox`.
const SVGR_OPTIONS = {
  svgo: false,
  titleProp: true,
  ref: true,
};

/**
 * Vendor groups pulled out of the app chunk (`build.rollupOptions.output.manualChunks`).
 *
 * Vite's default chunking put every statically reachable dependency of the app
 * into one ~5.6 MB `App` chunk; CRA's `splitChunks: { chunks: 'all' }` spread
 * the same code over many chunks that the browser could fetch in parallel.
 * These groups restore that parallelism.
 *
 * Rules this table follows — they are what keeps it safe, not style:
 *
 *  1. **node_modules only.** `src/` is never assigned by hand. Splitting
 *     first-party modules across chunks is what turns an innocuous import cycle
 *     into a TDZ crash (`Cannot access 'X' before initialization`) at runtime,
 *     and our own code has far more cycles than any of these libraries.
 *  2. **Whole packages, grouped by what they are.** A group is one coherent
 *     library island (web3 stack, icon packs, charting, …), so the cyclic
 *     imports these libraries do have stay *inside* one chunk. No micro-chunks:
 *     every group here is worth its own request.
 *  3. **Never group a package a lazy chunk depends on more than the app does.**
 *     A manual group is loaded as a whole, so pulling in a package that is
 *     currently only reached through a dynamic import would make that code
 *     eager. Two concrete exclusions:
 *     - `ua-parser-js` — a `mediasoup-client` dependency *and* a direct
 *       dependency of the CG ID mini-app; grouping it with mediasoup would drag
 *       the whole call stack into the `index_cgid` entry.
 *     - `@walletconnect/*` and `lodash` — mostly reached through dynamic
 *       imports today (WalletConnect connectors, lazily loaded views); grouping
 *       them would make several hundred KB eager.
 *
 * Rule 3 has one case that is enforced rather than trusted: the CG ID entry
 * must not reach a feature group at all — see `assertCgidEntryChunks` below,
 * which fails the build if it does.
 *
 * Changing this table needs a **browser pass**, not just a green build: chunk
 * boundaries change module initialisation order, and no build-time check
 * catches an initialisation-order bug. Check the wallet/login flows, a call, the
 * editor, charts and the emoji picker after touching it.
 */
const VENDOR_GROUPS: Readonly<Record<string, readonly string[]>> = {
  // The React runtime, and the reason it is listed at all: an unassigned module
  // whose set of dependent entry points happens to equal a manual chunk's gets
  // merged *into* that manual chunk. Without this group rollup folded `react`
  // into `vendor-icons` and `react/jsx-runtime` into `vendor-web3`, which made
  // both entries — including the CG ID mini-app, which needs neither — import
  // 3.3 MB of vendor code. Both entries need React, so one shared chunk is
  // exactly right.
  'vendor-react': ['react', 'react-dom', 'scheduler', 'use-sync-external-store', 'object-assign'],
  // Leaf helpers with no dependencies of their own that half the dependency
  // tree uses. Pinned for the same reason as `vendor-react`: left unassigned
  // they get absorbed into whichever feature group happens to share their
  // reachability signature, and then a single `tslib` import in the CG ID
  // mini-app drags the whole web3 chunk into the `index_cgid` entry.
  'vendor-shared': ['tslib', '@babel/runtime', 'react-is', 'prop-types', 'hoist-non-react-statics'],
  // The web3 stack. One group on purpose: ethers, viem, wagmi and rainbowkit
  // interlock (rainbowkit → wagmi → viem, both crypto stacks share @noble), and
  // splitting them further would only trade one request for cross-chunk
  // initialisation order. `apg-js`/`siwe`/`@spruceid` are the SIWE parser,
  // `@farcaster/*` and `@safe-global/*` are wallet connectors.
  'vendor-web3': [
    'ethers',
    'viem',
    'wagmi',
    '@wagmi/',
    '@rainbow-me/',
    '@vanilla-extract/',
    '@noble/',
    '@scure/',
    '@adraffy/',
    'abitype',
    'aes-js',
    'apg-js',
    'siwe',
    '@spruceid/',
    '@farcaster/',
    '@safe-global/',
    '@tanstack/',
  ],
  // ~0.9 MB of source: thousands of tiny leaf modules with no dependencies of
  // their own — the safest thing in this table. `@phosphor-icons/react` is
  // deliberately *not* here: `src/util/index.tsx` reaches it from the CG ID
  // entry, so grouping it would put a megabyte of icons in front of the
  // mini-app. Vite's default per-icon splitting handles it well.
  'vendor-icons': ['@heroicons/react'],
  // recharts and everything only recharts and the two d3 graphs use. `d3-` has
  // to be a prefix match: `import * as d3` resolves to the individual
  // `d3-<module>` packages.
  'vendor-charts': [
    'recharts',
    'recharts-scale',
    'react-smooth',
    'victory-vendor',
    'decimal.js-light',
    'internmap',
    'd3',
    'd3-',
  ],
  // The call stack. Deliberately excludes `ua-parser-js` (see rule 3) and
  // `events` (generic); `npm-events-package` is mediasoup's own aliased copy.
  'vendor-mediasoup': [
    'mediasoup-client',
    'sdp-transform',
    'awaitqueue',
    'h264-profile-level-id',
    'fake-mediastreamtrack',
    'npm-events-package',
  ],
  'vendor-emoji': ['emoji-picker-react', 'flairup'],
  // The Slate editor and the two leaf helpers only Slate pulls in.
  'vendor-editor': ['slate', 'slate-react', 'slate-history', 'slate-dom', 'is-hotkey', 'direction'],
  // react-beautiful-dnd ships its own redux store; nothing else in the app uses
  // redux, so the three move together.
  'vendor-dnd': ['react-beautiful-dnd', 'react-redux', 'redux', 'css-box-model'],
};

/** Virtual helper modules rollup and Vite generate; see `manualChunks`. */
const SHARED_HELPERS = ['vite/preload-helper', 'commonjsHelpers.js', '__vite-browser-external'];

/**
 * `…/node_modules/@scope/name/dist/x.js` → `@scope/name`.
 *
 * `lastIndexOf` on purpose: with a nested copy
 * (`…/node_modules/foo/node_modules/bar/x.js`, and the tree has plenty — ~50
 * `tslib` copies alone) the *innermost* package is the one that owns the
 * module. `@phosphor-icons/react` even ships a vendored `react` under its own
 * `dist/node_modules/`, and that copy belongs with `vendor-react`, not with the
 * icons.
 */
function packageNameOf(id: string): string | undefined {
  const marker = id.lastIndexOf('node_modules/');
  if (marker < 0) return undefined;
  const segments = id.slice(marker + 'node_modules/'.length).split('/');
  const name = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  return name || undefined;
}

/**
 * `manualChunks`: vendor groups from `VENDOR_GROUPS`, default behavior for
 * everything else (all of `src/`, and every dependency not listed).
 *
 * Entries ending in `/` or `-` match by prefix (`@wagmi/`, `d3-`), everything
 * else is an exact package name.
 */
function manualChunks(id: string): string | undefined {
  // Bundler-generated helpers: Vite's `__vitePreload` (emitted next to every
  // dynamic import — `src/data/api/baseConnector.ts` uses one), the commonjs
  // interop helpers, and the stub for externalized node builtins. They live
  // outside node_modules, so they would stay unassigned and get absorbed (see
  // `vendor-shared`) — and because *everything* imports them, whichever group
  // absorbs one drags that group into both entries. Pinning them is what keeps
  // the 2.2 MB `vendor-web3` chunk out of the CG ID mini-app.
  if (SHARED_HELPERS.some((helper) => id.includes(helper))) return 'vendor-shared';

  const pkg = packageNameOf(id);
  if (!pkg) return undefined;

  for (const [group, patterns] of Object.entries(VENDOR_GROUPS)) {
    for (const pattern of patterns) {
      const matches =
        pattern.endsWith('/') || pattern.endsWith('-') ? pkg.startsWith(pattern) : pkg === pattern;
      if (matches) return group;
    }
  }
  return undefined;
}

/**
 * The only vendor groups the CG ID mini-app is allowed to load up front. Both
 * entries need React, and `vendor-shared` holds the bundler's own helper
 * modules, so those two are unavoidable; every other group is main-app code the
 * mini-app has no use for.
 */
const CGID_ALLOWED_GROUPS: ReadonlySet<string> = new Set(['vendor-react', 'vendor-shared']);

/**
 * Fails the build when the `index_cgid` entry statically reaches a vendor group
 * it does not need.
 *
 * This is the one invariant in `VENDOR_GROUPS` that cannot be read off the
 * table, and it breaks *silently*: rollup merges an unassigned module into
 * whichever manual chunk shares its set of dependent entry points, so one new
 * bundler helper (Vite's `__vitePreload` and the commonjs interop helpers are
 * pinned in `SHARED_HELPERS`, a future one would not be) or one new shared leaf
 * dependency is enough to fold the 2.2 MB `vendor-web3` chunk into the
 * mini-app's critical path. Nothing about the build would look wrong: it stays
 * green, the precache assertions still pass, and the only symptom is that the
 * login page got megabytes heavier.
 *
 * Read-only assertion over the emitted chunk graph, so it costs nothing and
 * cannot itself change the output.
 */
function assertCgidEntryChunks(): Plugin {
  return {
    name: 'cg:assert-cgid-entry-chunks',
    apply: 'build',

    generateBundle(_options, bundle) {
      const chunks = new Map<string, { name: string; imports: readonly string[] }>();
      let entry: string | undefined;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks.set(output.fileName, { name: output.name, imports: output.imports });
        if (output.isEntry && output.name === 'index_cgid') entry = output.fileName;
      }
      // Not "nothing to check": the entry is a configured rollup input, so a
      // miss means the input names changed and this guard stopped guarding.
      if (!entry) this.error('cg:assert-cgid-entry-chunks: no entry chunk named `index_cgid`');

      const reached = new Set<string>();
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.pop() as string;
        if (reached.has(file)) continue;
        reached.add(file);
        queue.push(...(chunks.get(file)?.imports ?? []));
      }

      const leaked = [...reached]
        .map((file) => chunks.get(file)?.name ?? '')
        .filter((name) => Object.hasOwn(VENDOR_GROUPS, name) && !CGID_ALLOWED_GROUPS.has(name))
        .sort();

      if (leaked.length === 0) return;

      const message =
        `cg:assert-cgid-entry-chunks: the CG ID mini-app statically imports ${leaked.join(', ')}.\n` +
        `  Only ${[...CGID_ALLOWED_GROUPS].join(' and ')} may be in that entry — ` +
        'see VENDOR_GROUPS in vite.config.ts.\n' +
        '  Usually an unassigned module (a new bundler helper, a new shared leaf dependency) got\n' +
        '  absorbed into a vendor group; pinning it in `vendor-shared` is the fix.';
      // Printed as well as thrown: an error raised in `generateBundle` can be
      // outrun by the service-worker plugin's `closeBundle` (see the comment on
      // its `buildEnd` hook), and a guard nobody can read is no guard.
      console.error('\x1b[31m%s\x1b[0m', message);
      this.error(message);
    },
  };
}

/**
 * HTTPS for the dev server, from the same env vars the CRA dev server used
 * (`run.sh start_https` exports them; the certs are generated by
 * `docker/build.sh`).
 *
 * Fails hard when HTTPS was asked for and the certs are not usable. Silently
 * falling back to HTTP would be worse than not starting: `run.sh start_https`
 * exists because voice/video calls need a secure context, and an HTTP dev
 * server on the same port looks identical until getUserMedia refuses.
 */
function devServerHttps(): ServerOptions['https'] {
  const { HTTPS, SSL_CRT_FILE, SSL_KEY_FILE } = process.env;
  if (HTTPS !== 'true' && !SSL_CRT_FILE && !SSL_KEY_FILE) return undefined;

  if (!SSL_CRT_FILE || !SSL_KEY_FILE) {
    throw new Error(
      'HTTPS was requested but SSL_CRT_FILE/SSL_KEY_FILE are not both set. ' +
        'Use `./run.sh start_https`, which points them at docker/nginx/certs/.',
    );
  }
  for (const file of [SSL_CRT_FILE, SSL_KEY_FILE]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `HTTPS was requested but the certificate file ${file} does not exist. ` +
          'Generate the local certs with `./run.sh build_full` (docker/build.sh runs ' +
          'docker/nginx/certs/recreate_root_cert.sh + recreate_server_certs.sh).',
      );
    }
  }
  return { cert: fs.readFileSync(SSL_CRT_FILE), key: fs.readFileSync(SSL_KEY_FILE) };
}

export default defineConfig(({ command }) => ({
  // Both HTML entries live at the repo root; `public/` stays copy-verbatim.
  root: __dirname,
  base: '/',
  publicDir: 'public',

  plugins: [
    react(),
    baseUrlResolve('src'),
    svgr({ include: '**/*.svg?react', svgrOptions: SVGR_OPTIONS }),
    // Scoped on purpose: first-party code uses none of this, it exists for
    // transitive web3 dependencies. `process` and `global`
    // stay unpolyfilled — `src/common/` is dual-runtime (backend via the
    // `srv/common` symlink) and reads `process.env` through a `globalThis`
    // indirection that must keep resolving to nothing in the browser.
    nodePolyfills({
      include: ['buffer', 'stream', 'assert'],
      globals: { Buffer: true, global: false, process: false },
      protocolImports: false,
    }),
    htmlEntryScripts({
      'index.html': '/src/index.tsx',
      'index_cgid.html': '/src/index_cgid.tsx',
    }),
    // Only the legacy Azure pipelines set PUBLIC_URL; everywhere else this is
    // a no-op. See vite/absoluteSocialMeta.ts.
    absoluteSocialMeta(process.env.PUBLIC_URL),
    serviceWorker({
      swSrc: 'src/service-worker.ts',
      plugins: [baseUrlResolve('src')],
    }),
    assertCgidEntryChunks(),
  ],

  resolve: {
    alias: [
      // Exact-match alias (webpack's `altcha-widget-element$`): loads the
      // altcha bundle under a stub module name so its `.d.ts` — which augments
      // react/jsx-runtime and breaks JSX inference with @types/react 18 — never
      // enters the TS program. The stub lives in
      // src/types/altcha-widget-element.d.ts.
      { find: /^altcha-widget-element$/, replacement: 'altcha' },
      // @metamask/sdk declares `browser` (a UMD bundle) *and* `module` (its
      // **node** ESM build). Vite's resolver prefers an ESM `module` entry over
      // a non-ESM `browser` entry, so it pulls the node build into the browser
      // bundle — fs/child_process/tls/zlib get externalized and throw at
      // runtime. webpack's `mainFields: ['browser', 'module', 'main']` picks the
      // browser UMD build (verified against the CRA sourcemaps); pin the same
      // file here.
      {
        find: /^@metamask\/sdk$/,
        replacement: '@metamask/sdk/dist/browser/umd/metamask-sdk.js',
      },
    ],
  },

  build: {
    // The path every consumer already expects: docker/build.sh and
    // selfhost.sh rsync `../build/*` into nginx/dist and copy
    // `../build/index.html` into the backend image.
    outDir: 'build',
    emptyOutDir: true,
    target: BUILD_TARGET,
    // nginx's cache/serve rules key on
    // `^/(fonts|icons|images|static|audio|downloads)/` — Vite's default
    // `assets/` would match none of them.
    assetsDir: 'static',
    // Preserves the CRA behavior (`IMAGE_INLINE_SIZE_LIMIT=5000`); CRA's
    // default was 10000, Vite's is 4096.
    assetsInlineLimit: 5000,
    // Always on, on every build path — the app is AGPL, shipping maps is
    // intentional. The precache excludes them (see vite/serviceWorker.ts).
    sourcemap: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        index_cgid: path.resolve(__dirname, 'index_cgid.html'),
      },
      output: {
        // Hex hashes keep the service worker's `dontCacheBustURLsMatching`
        // pattern (`/\.[0-9a-f]{8}\./`) meaningful; rollup's default base64
        // alphabet would never match it.
        hashCharacters: 'hex',
        // Vendor groups (see VENDOR_GROUPS above); named chunks run through
        // `chunkFileNames` like every other chunk.
        manualChunks,
        entryFileNames: 'static/js/[name].[hash:8].js',
        chunkFileNames: 'static/js/[name].[hash:8].chunk.js',
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith('.css'))
            ? 'static/css/[name].[hash:8].css'
            : 'static/media/[name].[hash:8][extname]',
      },
    },
  },

  server: {
    host: '0.0.0.0',
    // Load-bearing, not a preference: the service-worker registration manager
    // disables itself when the origin port is 3000
    // (src/data/appstate/serviceWorker.ts:26-28). Another port would enable the
    // SW against the dev server.
    port: 3000,
    strictPort: true,
    // Only for `vite serve`: the certs are irrelevant to a build, and a stray
    // SSL_CRT_FILE in someone's environment must not be able to abort one.
    https: command === 'serve' ? devServerHttps() : undefined,
  },

  // The entry scripts are injected into the HTML at transform time (see
  // vite/htmlEntryScripts.ts), which the dependency scanner does not see — name
  // them explicitly so dev-server cold starts pre-bundle properly. Vite 7 runs
  // every entry through tinyglobby (a bare path that stops matching fails
  // silently), so keep this an explicit glob for exactly the two entry files.
  optimizeDeps: {
    entries: ['src/{index,index_cgid}.tsx'],
  },
}));
