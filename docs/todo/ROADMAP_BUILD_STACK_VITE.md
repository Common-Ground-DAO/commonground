# ROADMAP — Build-stack migration CRA/craco → Vite

> Status: Phase 0 (inventory + roadmap) done 2026-08-02, verified against commit
> db9f209bd; all maintainer decisions resolved 2026-08-02; Phase 1 merged into
> develop 2026-08-03. Evidence base:
> [INVENTORY_BUILD_STACK.md](INVENTORY_BUILD_STACK.md) (section references `§n`
> below point there).

## Goal

Replace the frontend build stack (react-scripts 5 + craco 7 + webpack) with Vite,
removing the CRA legacy (Node `--openssl-legacy-provider`, CRA env vars, dead webpack
plumbing) while keeping the shipped product identical.

**Acceptance bar (agreed 2026-08-02):** `./run.sh build_full` produces a functionally
identical stack — both entries (main app + `index_cgid.html`), PWA incl. push and
multi-tab coordination, instance-config injection (API path *and* selfhost nginx
path), sourcemaps per policy — **verified in the browser**, not only by build success.

## Decisions made

Scoping (2026-08-01/02):

- Ordering: runs **after** core slimming (slimming merged) — nothing removed during
  slimming has to be migrated.
- Runtime config stays `window.__CG_INSTANCE__` + `src/common/config.ts`; no build-time
  env baking (§7.2). No `REACT_APP_*` → no env migration beyond the single
  `PUBLIC_URL` token in the service worker.
- `src/common/` stays dual-runtime (backend consumes it via the `srv/common` symlink,
  §7.3): no blanket `define` of `process`/`process.env`, no Vite-only syntax there.
- Both HTML entries stay at the web root under their current names
  (`index.html`, `index_cgid.html`) — nginx vhosts, the selfhost inject script and
  `srv/util/instanceConfig.ts` depend on it (§10.3, §10.4).

Maintainer decisions (2026-08-02):

- **PWA build**: `workbox-build` `injectManifest` driven directly by a small build
  script/plugin — **no** `vite-plugin-pwa`. The hand-written SW and the hand-rolled
  registration manager (§8.1) stay untouched; the script reproduces the excludes and
  the fail-closed guard (§2.5).
- **Tests**: minimal **Vitest** setup with one smoke test, so a test culture has
  somewhere to start; the failing CRA boilerplate test is deleted (§9).
- **Sourcemaps**: **full sourcemaps on every build path**, including selfhost and CI
  (`build.sourcemap: true`). The no-sourcemap policy dated from the closed-source
  era and is obsolete — the app is AGPL, shipping maps is intentional. The Vite SW
  build **excludes `.map` from the precache** — note this fixes a pre-existing bug:
  today the craco patch short-circuits CRA's default excludes and sourcemaps *are*
  precached (§2.5).
- **SVG prune hack**: **dropped, not replaced** — under Vite+svgr, component-imported
  SVGs are bundled as JSX and not emitted as standalone files; Phase 2 verifies that
  in the build output before the prune loops are deleted in Phase 3 (§10.1).
  `build.assetsInlineLimit` stays at **5000** for raster images (preserves current
  behavior; CRA default was 10000, Vite's is 4096).
- **Asset layout**: pin `build.assetsDir = 'static'` — nginx configs stay untouched
  (§10.4).
- **Phase cut**: four implementation phases sized for 1–2 h autonomous agent runs,
  see "Working mode" and "Phases".
- **eslint successor**: minimal ESLint flat config — `typescript-eslint` recommended
  + `eslint-plugin-react` + `eslint-plugin-react-hooks`, mirroring the `react-app`
  ruleset. Least churn; tightening (type-checked presets) is a possible later
  follow-up outside this workstream.

## Working mode (per phase)

- Fresh branch from `develop` per phase; one phase = one PR.
- An Opus agent implements the whole phase autonomously — phases are scoped so this
  takes ~1–2 h without intermediate questions. The agent **commits freely on the
  phase branch** as it sees fit.
- Phase close-out: full Opus code review of the branch + bugfixing, then maintainer
  review / green light by Jan, push only after his explicit go, Jan merges, branch
  is deleted.
- `docker/.env` holds real local values — never stage it, never `git add -A`.

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
   `/(fonts|icons|images|static|audio|downloads)/` (§10.4). Decided:
   `build.assetsDir = 'static'`, nginx untouched.
6. **Node polyfills for transitive web3 deps only** (§2.2): buffer, stream, assert +
   global `Buffer` — scoped (e.g. `vite-plugin-node-polyfills` limited to these),
   never blanket.
7. **buildId sed stamp** (§8.4): keep `src/common/random_build_id.ts` mutation working
   (backend reads the same file) — do not convert to a frontend-only define.
8. **`postcss.config.js` divergence** (§2.1): reconcile before Vite starts reading it.
9. **Fonts via `../public/` URLs in `src/index.css`** (§5.4): must be reworked;
   `/fonts/*.ttf` must stay reachable — the SW precache pins those exact URLs.
10. **The webpack build is today's only type-check and lint** (ForkTsChecker +
    ESLintPlugin inside `craco build`; no `lint` script, no `.eslintrc*`, and the
    `react-app` eslint presets ship inside react-scripts, §3) — the Vite pipeline
    must add `tsc --noEmit` + a standalone eslint run, and Phase 3 needs a
    lint-config replacement.
11. Both HTML entry templates live **inside `public/`** and must move out — Vite's
    `publicDir` cannot contain HTML entries and has no CRA-style overwrite semantics
    (§5.3); the Tailwind content globs follow (`tailwind.config.js:6-7`).

## Phases

### Phase 0 — Inventory + roadmap ✅ 2026-08-02

- [x] Inventory (INVENTORY_BUILD_STACK.md), this roadmap, TODO.md entry graduated,
      maintainer decisions collected.

### Phase 1 — Pre-migration cleanup (CRA stays; independently shippable) ✅ merged 2026-08-03

Everything here shrinks migration surface without touching the build stack.

- [x] Delete dead `src/util/CG_PrecacheController.ts` (removes the workbox
      deep-import risk and 4 of 10 `process.env` sites, §11).
- [x] Drop unused deps: the **10** `workbox-*` packages left unused once
      `CG_PrecacheController.ts` is gone (`workbox-precaching` + `workbox-routing`
      stay), `create-react-app`, `ts-loader`, `postcss-import`, `postcss-nested`
      (§11). Lockfile regenerated (`yarn install --mode=update-lockfile`); diff was
      pure removals, `yarn install --immutable` green.
- [x] Delete `src/App.test.tsx` + `src/setupTests.ts`, drop the dead `test`/`eject`
      scripts and the React-17-era `@testing-library/*`/`@types/jest` deps (the
      Vitest successor arrives in Phase 3 with a fresh setup).
- [x] Reconcile `postcss.config.js` with the craco chain (single source of truth,
      §2.1).
- [x] Tailwind cruft: v2 `variants` key removed; `@tailwindcss/line-clamp` dropped —
      note the reasoning shifted: installed tailwind is 3.1.6 (< 3.3), but the
      plugin's utilities had **zero** usages (all `line-clamp` hits are hand-written
      `-webkit-line-clamp` CSS), verified by byte-identical tailwind output (§6).
- [x] Fix `tsconfig.json` trailing comma (§4).
- **Done**: production craco build green (node 24, zero src/ errors/warnings; both
  entries + SW correct in output), full Opus review verdict "ship", maintainer
  green light 2026-08-03. Phase-1 side find: the precache-exclude short-circuit
  bug, folded into §2.5.

### Phase 2 — Vite build core (both entries + SW; pipeline still on CRA)

Ends with a Vite build that is a drop-in replacement for the CRA `build/` output —
CRA keeps working in parallel until Phase 3 cuts over.

- [ ] `vite.config.ts`: MPA `rollupOptions.input` = both HTML entries, **emitted at
      the dist root** under their current names; `build.assetsDir = 'static'`;
      `build.assetsInlineLimit = 5000`; `build.sourcemap = true`; `build.target`
      from the browserslist floors (§3).
- [ ] Move both HTML entry templates out of `public/` (constraint 11); update the
      Tailwind content globs and the templates' relative references; replace
      `%PUBLIC_URL%` with root-relative URLs; keep the emitted HTML
      rewrite-compatible (constraint 4).
- [ ] `baseUrl` import resolution (constraint 1): resolver or `paths`-map codemod —
      implementer's choice, but it must cover the file-level specifiers.
- [ ] `vite-plugin-svgr` + codemod of the 255 SVG import sites to `?react` default
      imports, mirroring CRA's svgr options (constraint 2); new ambient types
      replacing `react-app-env.d.ts`; add `vite/client` to the explicit `types`
      array (`tsconfig.json:24-26` — not additive-by-default). A TS bump beyond
      4.1 may be required — surface in review.
- [ ] Scoped node polyfills (buffer/stream/assert, global `Buffer`) (§2.2); altcha
      alias (§2.3).
- [ ] Fix `src/index.css` `../public/` font URLs (§5.4) — `/fonts/*.ttf` must stay
      reachable (constraint 9).
- [ ] Service worker via **`workbox-build` `injectManifest`** (decided): emit
      `/service-worker.js` at the dist root; manual precache entries +
      `revision: buildId`; excludes = `index_cgid.html`, small SVGs (if any are
      still emitted), `.map`/`asset-manifest.json`/`LICENSE`,
      `dontCacheBustURLsMatching`, 5 MB cap (§2.5 — the `.map`/`LICENSE` excludes
      deliberately *fix* today's short-circuit bug, expect the precache to shrink);
      fail-closed non-dev guard; replace `process.env.PUBLIC_URL` in the SW.
- [ ] **Verify the SVG-prune assumption** (decided): confirm the Vite build emits no
      standalone `static/`-media SVGs for component-imported icons; record the
      result in this file (gates deleting the prune loops in Phase 3).
- [ ] Dev server: host 0.0.0.0, **port 3000** (load-bearing for the SW registration
      guard, §8.1), HTTPS via the existing local certs.
- **Done when**: `vite build` output serves correctly when rsynced into the dev
  nginx (both entries, hashed assets under `static/`, SW precache manifest sane),
  and the Vite dev server works in `cg-builder` (HTTP + HTTPS). CRA build still
  intact.

### Phase 3 — Pipeline cutover + CRA removal + lint/test successor

- [ ] `run.sh start`/`start_https` → Vite dev server in `cg-builder`.
- [ ] `docker/build.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh`:
      switch to `vite build`; drop `--openssl-legacy-provider`,
      `GENERATE_SOURCEMAP` (sourcemaps now always on — decided),
      `IMAGE_INLINE_SIZE_LIMIT`; delete the SVG prune loops (gated on the Phase-2
      verification); revisit `--max-old-space-size` (expected to shrink — verify);
      keep buildId stamp + `build/index.html → backend/dist` copy working; add the
      standalone `tsc --noEmit` + eslint step (constraint 10). Touch `pipelines/`
      (legacy Azure) only if trivial — the GitHub Actions replacement is a separate
      workstream.
- [ ] Verify `srv/api/getRoutes.ts` rewriting against the real Vite `index.html`
      (head markers, meta regexes) and `inject-instance-config.sh` against **both**
      emitted HTML files (§10.2, §10.3).
- [ ] nginx: confirm the `static/` rules hit and `no-cache`/deny rules still apply
      (§10.4). Optional follow-up (separate PR): immutable caching for hashed
      frontend assets (§2.4/§10.4).
- [ ] Remove `react-scripts`, `@craco/craco`, `webpack-cli`, `craco.config.js` and
      the CRA scripts from `package.json` — in **one commit**: `craco.config.js`
      requires `webpack`/`html-webpack-plugin` only transitively via react-scripts
      (§2.6).
- [ ] eslint flat config per decision (typescript-eslint + react + react-hooks,
      react-app parity); wire it plus `tsc --noEmit` into the build scripts.
- [ ] Minimal **Vitest** setup (decided): config, one smoke test, `test` script.
- [ ] Update docs in the same PR: `docs/infrastructure/` (build pipeline, env
      vars), `docs/frontend/` (tooling), `docs/deployment/` — status-line bumps.
- **Done when**: `./run.sh build_full` runs fully on Vite and the acceptance-bar
  checks pass in the dev stack; `selfhost.sh` builds; CRA is gone from the repo.

### Phase 4 — Verification & wrap-up

- [ ] Full acceptance-bar run: `./run.sh build_full`, browser verification of both
      entries, PWA install/update/push, multi-tab arbitration, instance injection
      (dev-nginx *and* selfhost), share-link deep links through the API, sourcemaps
      present on all paths.
- [ ] Selfhost profile end-to-end (`selfhost.sh` + nginx entrypoint injection).
- [ ] Fold lasting insights into `docs/`; delete INVENTORY_BUILD_STACK.md and this
      file per the docs/todo lifecycle; leftover one-offs → `TODO.md`.
- **Done when**: Jan has signed off the browser verification and both TODO files
  are gone.
