# ROADMAP — Build-stack migration CRA/craco → Vite

> Status: Phase 0 (inventory + roadmap) done 2026-08-02, verified against commit
> db9f209bd. Evidence base: [INVENTORY_BUILD_STACK.md](INVENTORY_BUILD_STACK.md)
> (section references `§n` below point there). **No implementation before the
> maintainer decisions at the end are made.**

## Goal

Replace the frontend build stack (react-scripts 5 + craco 7 + webpack) with Vite,
removing the CRA legacy (Node `--openssl-legacy-provider`, CRA env vars, dead webpack
plumbing) while keeping the shipped product identical.

**Acceptance bar (agreed 2026-08-02):** `./run.sh build_full` produces a functionally
identical stack — both entries (main app + `index_cgid.html`), PWA incl. push and
multi-tab coordination, instance-config injection (API path *and* selfhost nginx
path), sourcemaps per policy — **verified in the browser**, not only by build success.

## Decisions already made

- Ordering: runs **after** core slimming (decided 2026-08-01; slimming merged) —
  nothing removed during slimming has to be migrated.
- Runtime config stays `window.__CG_INSTANCE__` + `src/common/config.ts`; no build-time
  env baking (§7.2). No `REACT_APP_*` → no env migration beyond the single
  `PUBLIC_URL` token in the service worker.
- `src/common/` stays dual-runtime (backend consumes it via the `srv/common` symlink,
  §7.3): no blanket `define` of `process`/`process.env`, no Vite-only syntax there.
- Both HTML entries stay at the web root under their current names
  (`index.html`, `index_cgid.html`) — nginx vhosts, the selfhost inject script and
  `srv/util/instanceConfig.ts` depend on it (§10.3, §10.4).

## Known hard constraints (from the inventory)

1. **~1945 `baseUrl: "src"` bare-import lines** (§4) — including bare specifiers to
   top-level files/indexes (`'App'`, `'service-worker'`, `'data'`), which per-root
   aliases miss; a `baseUrl`-equivalent resolver or a codemod to an explicit `paths`
   map is the safer route. Largest mechanical item.
2. **255 `ReactComponent` SVG imports in 134 files** (§7.1) — current
   `vite-plugin-svgr` only transforms behind a `?react` query and exports a
   **default** component, so plan for a codemod of all import sites (not a plugin
   flag); mirror CRA's svgr options (`svgo: false`, `titleProp`, `ref` — svgr's
   default svgo pass would strip `viewBox`); replace the `react-app-env.d.ts`
   ambient type.
3. **Service worker** (§8): must be emitted as exactly `/service-worker.js` at the
   root with `self.__WB_MANIFEST` injection; reproduce the craco excludes
   (`index_cgid.html`, SVGs < 5000 B) and the fail-closed "no SW in a non-dev build"
   guard; keep the dev behavior "no SW" (today doubly enforced: production-only build
   + port-3000 registration guard).
4. **Emitted `index.html` must stay rewrite-compatible**: literal `<head>`/`</head>`,
   and meta tags keeping `property=`/`name=` first with double-quoted values, for
   `srv/api/getRoutes.ts` (critical path: deep-link proxying) and
   `docker/nginx/inject-instance-config.sh` (§10.2, §10.3). Today's output is
   minified and matches; the risk is any HTML transform that reorders attributes or
   strips quotes — verify against real Vite output, or adapt both consumers in the
   same PR.
5. **Asset path layout**: nginx cache/serve rules key on
   `/(fonts|icons|images|static|audio|downloads)/` (§10.4). Default plan: pin
   `build.assetsDir = 'static'`; alternative below as a decision.
6. **Node polyfills for transitive web3 deps only** (§2.2): buffer, stream, assert +
   global `Buffer` — scoped (e.g. `vite-plugin-node-polyfills` limited to these),
   never blanket.
7. **buildId sed stamp** (§8.4): keep `src/common/random_build_id.ts` mutation working
   (backend reads the same file) — do not convert to a frontend-only define.
8. **`postcss.config.js` divergence** (§2.1): reconcile before Vite starts reading it.
9. **Fonts via `../public/` URLs in `src/index.css`** (§5.4): must be reworked
   (reference `/fonts/…` from public root, or move fonts into `src/`).
10. **The webpack build is today's only type-check and lint** (ForkTsChecker +
    ESLintPlugin inside `craco build`; no `lint` script, no `.eslintrc*`, and the
    `react-app` eslint presets ship inside react-scripts, §3) — the Vite pipeline
    must add `tsc --noEmit` + a standalone eslint run, and Phase 5 needs a
    lint-config replacement.
11. Both HTML entry templates live **inside `public/`** and must move out — Vite's
    `publicDir` cannot contain HTML entries and has no CRA-style overwrite semantics
    (§5.3); the Tailwind content globs follow (`tailwind.config.js:6-7`).

## Phases

Each phase = one PR per the usual cycle (branch from `develop`, Opus implements,
Opus reviews, push after explicit go, Jan merges, branch deleted).

### Phase 0 — Inventory + roadmap ✅ 2026-08-02
- [x] Inventory (INVENTORY_BUILD_STACK.md), this roadmap, TODO.md entry graduated.

### Phase 1 — Pre-migration cleanup (no Vite yet, independently shippable)
- [ ] Delete dead `src/util/CG_PrecacheController.ts` (removes the workbox deep-import
      risk and 4 of 9 `process.env` sites, §11).
- [ ] Drop unused deps: the **10** `workbox-*` packages left unused once
      `CG_PrecacheController.ts` is gone (`workbox-precaching` + `workbox-routing`
      stay), `create-react-app`, `ts-loader`, `postcss-import`, `postcss-nested`
      (§11). Regenerate lockfile offline (`yarn install --mode=update-lockfile`).
- [ ] Reconcile `postcss.config.js` with the craco chain (single source of truth,
      §2.1).
- [ ] Tailwind cruft: remove v2 `variants` key; drop `@tailwindcss/line-clamp` plugin
      usage (in core since 3.3) (§6).
- [ ] Remove `src/App.test.tsx` boilerplate + dead `test`/`eject` scripts **or** keep
      per test-runner decision below.
- [ ] Fix `tsconfig.json` trailing comma (§4).

### Phase 2 — Vite scaffolding (builds, not yet wired into the pipeline)
- [ ] `vite.config.ts`: MPA `rollupOptions.input` = `index.html` + `index_cgid.html`
      (both emitted at the dist root); `build.assetsDir` per decision (default
      `static`); `build.assetsInlineLimit = 5000` (or per SVG decision);
      `build.target` from the browserslist floors (§3); sourcemaps per decision.
- [ ] Aliases: 8 src-root aliases for the `baseUrl` imports (or codemod decision);
      `altcha-widget-element` → `altcha` (§2.3).
- [ ] `vite-plugin-svgr` + codemod of the 255 SVG import sites to `?react` default
      imports, mirroring CRA's svgr options (constraint 2); new ambient types
      replacing `react-app-env.d.ts`.
- [ ] Scoped node polyfills (buffer/stream/assert, global `Buffer`) (§2.2).
- [ ] Move both HTML entry templates out of `public/` (constraint 11); update the
      Tailwind content globs and the templates' relative references.
- [ ] Move CRA `%PUBLIC_URL%` template vars in both HTML files to Vite-compatible
      root-relative URLs; port HtmlWebpackPlugin behavior for `index_cgid.html`
      (minification, if any, compatible with constraint 4).
- [ ] Fix `src/index.css` `../public/` font URLs (§5.4) — `/fonts/*.ttf` must stay
      reachable, the SW precache pins those exact URLs; separately decide on the
      remote Google-Fonts `@import` (not precached, no local copy).
- [ ] Dev server: host 0.0.0.0, **port 3000** (load-bearing for the SW guard, §8.1),
      HTTPS via the existing local certs.
- [ ] TypeScript: add `vite/client` to the explicit `types` array
      (`tsconfig.json:24-26` — not additive-by-default); check TS 4.1 vs. what
      Vite/plugins need (a TS bump may be required — surface in review).

### Phase 3 — Service worker / PWA (decision-dependent)
- [ ] Build `src/service-worker.ts` per the PWA decision below, emitting
      `/service-worker.js` with `__WB_MANIFEST` injection.
- [ ] Reproduce: manual precache entries + `revision: buildId`; exclusions
      (`index_cgid.html`, small SVGs per SVG decision) **plus CRA's default
      InjectManifest settings** (`.map`/`asset-manifest.json`/`LICENSE` excludes,
      `dontCacheBustURLsMatching`, 5 MB cap — dropping the `.map` exclude would
      precache sourcemaps, §2.5); fail-closed non-dev guard;
      `process.env.PUBLIC_URL` replacement in the SW (§8, §2.5).
- [ ] Browser-verify: install/update flow ("Update is ready" toast), push
      notifications, multi-tab websocket arbitration, navigation fallback deny-list,
      cross-origin-security shells.

### Phase 4 — Pipeline cutover
- [ ] `run.sh start`/`start_https` → Vite dev server in `cg-builder`.
- [ ] `docker/build.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh`:
      drop `--openssl-legacy-provider`, `GENERATE_SOURCEMAP`,
      `IMAGE_INLINE_SIZE_LIMIT`; revisit `--max-old-space-size` (expected to shrink
      under Vite — verify); SVG prune per decision; keep buildId stamp +
      `build/index.html → backend/dist` copy working; add the standalone
      type-check/lint step (constraint 10). Touch `pipelines/` (legacy Azure) only
      if trivial — the GitHub Actions replacement is a separate workstream.
- [ ] Verify `srv/api/getRoutes.ts` rewriting against the real Vite `index.html`
      (head markers, meta regexes) and `inject-instance-config.sh` against **both**
      emitted HTML files (§10.2, §10.3).
- [ ] nginx: confirm asset-path rules match the chosen layout; confirm
      `no-cache`/deny rules still hit (§10.4). Optional follow-up: immutable caching
      for hashed frontend assets (lazy chunks are content-hashed already today, only
      the entry bundles re-bust per build; nginx `immutable` currently exists only
      on the `/files/` proxy — separate PR, §2.4/§10.4).
- [ ] Rebuild-verify selfhost profile (`selfhost.sh`, injection via nginx hook).

### Phase 5 — CRA removal + lint/test successor
- [ ] Remove `react-scripts`, `@craco/craco`, `webpack-cli`, `craco.config.js` and
      the CRA scripts from `package.json` — in **one commit**: `craco.config.js`
      requires `webpack`/`html-webpack-plugin` only transitively via react-scripts
      (§2.6).
- [ ] Replace `eslintConfig` (`react-app` presets die with react-scripts, §3).
- [ ] Test runner per decision (Vitest setup or removal of the dead test path).
- [ ] Update docs: `docs/infrastructure/` (build pipeline, env vars),
      `docs/frontend/` (tooling), `docs/deployment/` — same-PR status-line bumps.

### Phase 6 — Final verification & wrap-up
- [ ] Full acceptance-bar run: `./run.sh build_full`, browser verification of both
      entries, PWA/push, instance injection (dev-nginx *and* selfhost), share-link
      deep links through the API, sourcemaps per policy.
- [ ] Fold lasting insights into `docs/`; delete both TODO files per the docs/todo
      lifecycle; leftover one-offs → `TODO.md`.

## Maintainer decisions needed before implementation

1. **PWA build approach**: `vite-plugin-pwa` (`strategies: 'injectManifest'`) vs.
   using `workbox-build`/`injectManifest` directly in a small custom plugin/script.
   The SW itself is hand-written and stays either way; vite-plugin-pwa brings
   dev-mode conveniences we don't use (no SW in dev today) and its own registration
   helper we must **not** use (hand-rolled manager, §8.1). Recommendation: direct
   `workbox-build` injectManifest — fewer moving parts, exact control over the
   excludes and the fail-closed guard.
2. **Test runner**: adopt Vitest (fresh setup, drop React-17-era testing-library
   pins) vs. delete the dead test path entirely for now (one failing boilerplate
   test, zero call sites, §9). Recommendation: minimal Vitest setup with one smoke
   test, so a test culture has somewhere to start; delete the CRA boilerplate.
3. **Sourcemap policy**: today inconsistent — `build_full`/`update_frontend` ship
   sourcemaps, selfhost/CI don't (§1). Pick one policy for the Vite config
   (`build.sourcemap`) and whether selfhost stays different.
4. **SVG prune hack** (post-build deletion of ≤5 KB SVGs + workbox `< 5000`
   precache exclude, §10.1 — *not* coupled to `IMAGE_INLINE_SIZE_LIMIT`, which only
   affects raster images): replace 1:1, or drop? Under Vite+svgr, component-imported
   SVGs are bundled as JSX and not emitted as standalone files, so the prune is
   probably moot — verify in the Phase 2 build output. Separately: keep the raster
   inline limit at 5000 (`build.assetsInlineLimit`; CRA default was 10000, Vite's
   is 4096), or drop to Vite's default?
5. **Asset layout**: keep `assetsDir: 'static'` to match nginx as-is (recommended,
   zero nginx risk) vs. adopt Vite's default `assets/` and extend the three nginx
   configs (+ selfhost fall-through fix, §10.4).
6. **Phase cut / PR slicing**: as proposed above (6 PRs) — or merge Phases 2+3
   (scaffolding is only browser-verifiable with the SW in place) / split Phase 4
   (dev-stack vs. selfhost cutover). Preference?
7. **eslint successor** (Phase 5): plain `eslint` + `typescript-eslint` +
   `react`/`react-hooks` plugins mirroring the `react-app` ruleset, or adopt a
   stricter shared config now?
