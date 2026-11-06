// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import svgr from 'vite-plugin-svgr';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { absoluteSocialMeta } from './vite/absoluteSocialMeta';
import { baseUrlResolve } from './vite/baseUrlResolve';
import { htmlEntryScripts } from './vite/htmlEntryScripts';
import { serviceWorker } from './vite/serviceWorker';
import { buildIdDefine, buildIdPlugin, resolveBuildId } from './vite/buildId';

// The browser floor, in esbuild's notation — Vite 8 still takes that for
// `build.target` and converts it for Oxc (JS lowering) and Lightning CSS
// (`build.cssTarget` defaults to it; CSS lowering and vendor prefixes). The
// only place the floor is defined (docs/frontend §9 "Toolchain"); raised with
// Tailwind 4 (wave M4) to what its CSS needs: cascade layers (Safari 15.4,
// Firefox 97, Chrome 99) and the `translate`/`rotate` properties (Chrome 104).
const BUILD_TARGET = ['chrome104', 'edge104', 'firefox97', 'opera90', 'safari15.4'];

// react-scripts' @svgr/webpack options, verbatim
// (node_modules/react-scripts/config/webpack.config.js:392-401). `svgo: false`
// is load-bearing: svgr's default svgo pass strips `viewBox`.
const SVGR_OPTIONS = {
  svgo: false,
  titleProp: true,
  ref: true,
};

/**
 * Vendor groups pulled out of the app chunk (`build.rolldownOptions.output.codeSplitting`).
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
 *     - `ua-parser-js` — a web3-stack dependency (via RainbowKit 1.3) *and* a
 *       direct dependency of the CG ID mini-app; grouping it with the web3
 *       group would drag that whole group into the `index_cgid` entry. It
 *       lives in `vendor-shared` instead, which both entries load anyway.
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
  // `ua-parser-js` is here because exactly that happened: it is a direct,
  // eager dependency of both entries (`src/cgid/login.tsx` and
  // `src/hooks/useUserAgent.ts`) *and*, since RainbowKit 1.3, of the web3
  // stack — so rollup folded the entire `vendor-web3` chunk into `index_cgid`.
  // Pinning it here is the fix `assertCgidEntryChunks` tells you to apply; it
  // costs nothing, since both entries load it up front anyway.
  'vendor-shared': [
    'tslib',
    '@babel/runtime',
    'react-is',
    'prop-types',
    'hoist-non-react-statics',
    'ua-parser-js',
  ],
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
    // recharts 3 replaced its 2.x helpers (recharts-scale, react-smooth)
    // with a Redux-based runtime; these are recharts-only in this app.
    '@reduxjs/toolkit',
    'react-redux',
    'redux',
    'redux-thunk',
    'immer',
    'reselect',
    'es-toolkit',
    'victory-vendor',
    'decimal.js-light',
    'internmap',
    'd3',
    'd3-',
  ],
  // The call stack. Deliberately excludes `events` (generic);
  // `npm-events-package` is mediasoup's own aliased copy.
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
  // Drag & drop. `@dnd-kit/core` + `sortable` + `utilities` + `accessibility`
  // are one interlocking island (sortable is built on core's context and both
  // re-export through utilities), and they are reached eagerly from the sidebar
  // and the community-settings views alike. Nothing else lives here any more:
  // react-beautiful-dnd's redux store — the reason `react-redux`, `redux` and
  // `css-box-model` used to be in this group — left the tree with it, and
  // dnd-kit has no runtime dependency beyond `tslib` (`vendor-shared`).
  'vendor-dnd': ['@dnd-kit/'],
};

/**
 * Virtual helper modules the bundler generates; see `vendorGroupOf`.
 *
 * - `vite/preload-helper` (`\0vite/preload-helper.js`) and
 *   `__vite-browser-external`: Vite's own.
 * - `@oxc-project+runtime@`: Oxc's transform helpers, which syntax lowering
 *   for `BUILD_TARGET` injects into any module that needs them (measured
 *   with the former `chrome67` floor: class fields → `defineProperty`, `toPropertyKey`, `toPrimitive`,
 *   `typeof`; private members: `classPrivateField*`, …). Ids look like
 *   `\0@oxc-project+runtime@0.155.0/helpers/esm/defineProperty.js` — no
 *   `node_modules/`, so without this entry they were unassigned and
 *   Rolldown pulled them into `vendor-charts` as a dependency of recharts,
 *   which made `web-vitals`, `AuthFlow`, `vendor-mediasoup` and others import
 *   that 340 KB chunk for four tiny helpers. Matched without the version, so
 *   an Oxc update does not silently undo the pin.
 *
 * - `vite-plugin-node-polyfills/shims/global`: the `global` shim (a one-line
 *   `globalThis` re-export, see `nodePolyfills` below) that the build injects
 *   into every dependency referencing `global` — lodash-style helpers in
 *   `vendor-editor`/`vendor-charts`, tfjs, giphy, WalletConnect, … Left
 *   unassigned it landed in `vendor-web3`, and all of those chunks then
 *   imported the 3.4 MiB web3 chunk for it. (Only this shim: the `Buffer`
 *   shim pulls in the whole `buffer` polyfill, which the CG ID entry must not
 *   load.)
 *
 * (The Rollup build also had `commonjsHelpers.js` here; Rolldown handles
 * CommonJS natively and keeps its interop helpers in its runtime, see
 * `CODE_SPLITTING_GROUPS`.)
 */
const SHARED_HELPERS = [
  'vite/preload-helper',
  '__vite-browser-external',
  '@oxc-project+runtime@',
  'vite-plugin-node-polyfills/shims/global/',
];

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
 * The vendor group a module belongs to, from `VENDOR_GROUPS`; `undefined` for
 * everything else (all of `src/`, and every dependency not listed), which
 * Rolldown's automatic chunking handles.
 *
 * Entries ending in `/` or `-` match by prefix (`@wagmi/`, `d3-`), everything
 * else is an exact package name.
 */
function vendorGroupOf(id: string): string | undefined {
  // Bundler-generated helpers: Vite's `__vitePreload` (emitted next to every
  // dynamic import — `src/data/api/baseConnector.ts` uses one), the stub for
  // externalized node builtins and Oxc's lowering helpers (`SHARED_HELPERS`).
  // They live outside node_modules, so they
  // would stay unassigned and get absorbed (see `vendor-shared`) — and because
  // *everything* imports them, whichever group absorbs one drags that group
  // into both entries. Pinning them is what keeps the `vendor-web3` chunk out
  // of the CG ID mini-app.
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
 * `VENDOR_GROUPS` as Rolldown `codeSplitting` groups
 * (`build.rolldownOptions.output.codeSplitting`).
 *
 * Not the function-form `manualChunks` the Rollup build used: Vite 8
 * deprecates it, and Rolldown emulates it as *one* group with a dynamic name,
 * which changes what happens to shared dependencies. Rolldown (like Rollup)
 * pulls the static dependencies of a group member into the group as well, but
 * where Rollup let an explicit assignment win, Rolldown gives a module that
 * several groups claim to whichever group it emits first — for the emulated
 * single group that is alphabetical order, so `vendor-charts` takes shared
 * dependencies of recharts before `vendor-react`/`vendor-shared` get them.
 * Measured with Vite 8.3.5: `manualChunks: vendorGroupOf` drags
 * `vendor-charts` into the CG ID entry and `assertCgidEntryChunks` fails the
 * build.
 *
 * One group per vendor group with an explicit `priority` (higher is emitted
 * first) restores "explicit assignment wins" where it matters: `vendor-react`
 * and `vendor-shared` hold what the other groups depend on, so they are
 * emitted before every feature group. The feature groups share no listed
 * package, so their order among each other (array order at equal priority)
 * decides nothing.
 *
 * Rolldown's runtime (its module and CommonJS interop helpers, which the
 * Rollup build had in `commonjsHelpers.js`) is no module a group can match;
 * Rolldown puts it into a chunk both entries load anyway — in practice the
 * `modulepreload-polyfill` chunk (the one emitted JS file without a `.map`
 * since Vite 8).
 */
const CODE_SPLITTING_GROUPS = Object.keys(VENDOR_GROUPS).map((name) => ({
  name,
  test: (id: string) => vendorGroupOf(id) === name,
  priority: name === 'vendor-react' ? 30 : name === 'vendor-shared' ? 20 : 10,
}));

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
 * table, and it breaks *silently*: the bundler puts an unassigned module (or,
 * under Rolldown, a dependency of a group member) into whichever vendor chunk
 * reaches it first, so one new bundler helper (Vite's `__vitePreload` is
 * pinned in `SHARED_HELPERS`, a future one would not be), one new shared leaf
 * dependency or a change to the group priorities is enough to fold the
 * ~3.4 MiB `vendor-web3` chunk into the mini-app's critical path. Nothing
 * about the build would look wrong: it stays
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
      // Not "nothing to check": the entry is a configured bundler input, so a
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

// One ID per build, shared by the app bundle, the service worker and (via
// build/build-id.txt and the build scripts) the backend image — see
// vite/buildId.ts and src/common/buildId.ts. (The dev server uses the dev
// stack's ID instead, see buildIdPlugin.)
const BUILD_ID = resolveBuildId();

export default defineConfig(() => ({
  // Both HTML entries live at the repo root; `public/` stays copy-verbatim.
  root: __dirname,
  base: '/',
  publicDir: 'public',

  plugins: [
    react(),
    // Tailwind CSS 4. The setup and its configuration live in
    // src/tailwind.css (no tailwind.config.js, no PostCSS config); component
    // stylesheets `@reference` it. Vendor prefixes and lowering for
    // `build.cssTarget` come from Lightning CSS when Vite minifies.
    tailwindcss(),
    baseUrlResolve('src'),
    svgr({ include: '**/*.svg?react', svgrOptions: SVGR_OPTIONS }),
    // Scoped on purpose: first-party code uses none of this, it exists for
    // transitive web3 dependencies. `process` stays unpolyfilled —
    // `src/common/` is dual-runtime (backend via the `srv/common` symlink) and
    // reads `process.env` through a `globalThis` indirection that must keep
    // resolving to nothing in the browser.
    //
    // `global` *is* provided (the shim is `globalThis`): Rollup's commonjs
    // plugin used to rewrite a bare `global` in CommonJS dependencies to its
    // `commonjsGlobal` helper, Rolldown leaves it alone, so with Vite 8 e.g.
    // `randombytes/browser.js` (`global.crypto || global.msCrypto`, via
    // `@metamask/eth-sig-util`) and `@walletconnect/environment`
    // (`global?.crypto`) would throw `ReferenceError: global is not defined`.
    // In the build the plugin injects the shim only into modules that
    // reference `global` (Rolldown `transform.inject`); in dev it sets
    // `globalThis.global` from the pre-bundled dependencies. Nothing in `src/`
    // references `global`.
    nodePolyfills({
      include: ['buffer', 'stream', 'assert'],
      globals: { Buffer: true, global: true, process: false },
      protocolImports: false,
    }),
    htmlEntryScripts({
      'index.html': '/src/index.tsx',
      'index_cgid.html': '/src/index_cgid.tsx',
    }),
    // Only the legacy Azure pipelines set PUBLIC_URL; everywhere else this is
    // a no-op. See vite/absoluteSocialMeta.ts.
    absoluteSocialMeta(process.env.PUBLIC_URL),
    buildIdPlugin(BUILD_ID, __dirname),
    serviceWorker({
      swSrc: 'src/service-worker.ts',
      plugins: [baseUrlResolve('src')],
      define: buildIdDefine(BUILD_ID),
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
      // `nsfwjs/core` imports the `@tensorflow/tfjs` meta package, which is the
      // entire TensorFlow.js runtime (layers, every backend, the data
      // pipeline). We run one graph model and nothing else, so that package is
      // not installed at all and this alias hands nsfwjs a re-export of just
      // `tfjs-core` + `tfjs-converter` instead. See src/moderation/tfjs.ts.
      //
      // Reachable only through the dynamic `import()` in
      // `src/moderation/checkImageBeforeUpload.ts`, so tfjs stays a lazy chunk
      // — which is also why it must never be added to VENDOR_GROUPS (rule 3).
      {
        find: /^@tensorflow\/tfjs$/,
        replacement: path.resolve(__dirname, 'src/moderation/tfjs.ts'),
      },
      // There used to be a `@metamask/sdk` → browser-UMD alias here. It is gone
      // with the wagmi 2 migration: the SDK is no longer a direct dependency
      // (wagmi's `metaMask` connector dynamically imports it), and 0.33's
      // `browser`/`module` fields both point at the browser ESM build, so Vite
      // resolves it correctly unaided. Measured: without the alias the precache
      // is 60 KB *smaller*. The original reason — 0.1.0's `module` entry being
      // the node build, dragging fs/child_process/tls into the browser bundle —
      // no longer applies. Do not re-add it without re-measuring.
    ],
  },

  build: {
    // The path every consumer already expects: docker/build.sh and
    // selfhost.sh rsync `../build/*` into caddy/dist and copy
    // `../build/index.html` into the backend image.
    outDir: 'build',
    emptyOutDir: true,
    target: BUILD_TARGET,
    // Caddy's cache/serve rules key on
    // `^/(fonts|icons|images|static|audio|downloads)/` (docker/caddy/common.caddy),
    // and only `static/` gets the year-long immutable caching, which relies on
    // the content hash in every file name below — Vite's default `assets/`
    // would match none of them.
    assetsDir: 'static',
    // Preserves the CRA behavior (`IMAGE_INLINE_SIZE_LIMIT=5000`); CRA's
    // default was 10000, Vite's is 4096.
    assetsInlineLimit: 5000,
    // Always on, on every build path — the app is AGPL, shipping maps is
    // intentional. The precache excludes them (see vite/serviceWorker.ts).
    sourcemap: true,
    reportCompressedSize: false,
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        index_cgid: path.resolve(__dirname, 'index_cgid.html'),
      },
      output: {
        // Hex hashes keep the service worker's `dontCacheBustURLsMatching`
        // pattern (`/\.[0-9a-f]{8}\./`) meaningful; Rolldown's default base64
        // alphabet would never match it.
        hashCharacters: 'hex',
        // Vendor groups (see VENDOR_GROUPS and CODE_SPLITTING_GROUPS above);
        // named chunks run through `chunkFileNames` like every other chunk.
        codeSplitting: { groups: CODE_SPLITTING_GROUPS },
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
    // Always plain HTTP: `run.sh start_https` puts a TLS-terminating Caddy
    // (docker/caddy/Caddyfile.vite) in front of this server.
  },

  // The entry scripts are injected into the HTML at transform time (see
  // vite/htmlEntryScripts.ts), which the dependency scanner does not see — name
  // them explicitly so dev-server cold starts pre-bundle properly. Vite runs
  // every entry through tinyglobby (since 7; a bare path that stops matching
  // fails silently), so keep this an explicit glob for exactly the two entry
  // files. Since Vite 8 the pre-bundling is done by Rolldown, not esbuild.
  optimizeDeps: {
    entries: ['src/{index,index_cgid}.tsx'],
  },
}));
