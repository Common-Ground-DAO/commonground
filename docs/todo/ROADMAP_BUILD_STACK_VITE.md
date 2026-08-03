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
  `PUBLIC_URL` token in the service worker — **corrected in Phase 2**, see
  "Findings that change Phase 3" #6: the two legacy Azure pipelines also pass
  `PUBLIC_URL` as the CRA homepage.
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

- [x] `vite.config.ts`: MPA `rollupOptions.input` = both HTML entries, **emitted at
      the dist root** under their current names; `build.assetsDir = 'static'`;
      `build.assetsInlineLimit = 5000`; `build.sourcemap = true`; `build.target`
      from the browserslist floors (§3). Output paths mirror CRA
      (`static/js|css|media`) with `hashCharacters: 'hex'` and `[hash:8]` — see
      "Hash format" below.
- [x] Move both HTML entry templates out of `public/` (constraint 11); update the
      Tailwind content globs and the templates' relative references; replace
      `%PUBLIC_URL%` with root-relative URLs; keep the emitted HTML
      rewrite-compatible (constraint 4).
- [x] `baseUrl` import resolution (constraint 1): resolver or `paths`-map codemod —
      implementer's choice, but it must cover the file-level specifiers.
      **Chosen: a resolver** (`vite/baseUrlResolve.ts`) — zero source churn, and it
      reproduces webpack's precedence (node_modules wins, `src/` is the fallback,
      because react-scripts passes baseUrl as the *last* `resolve.modules` entry).
- [x] `vite-plugin-svgr` + codemod of the 255 SVG import sites to `?react` default
      imports, mirroring CRA's svgr options (constraint 2); new ambient types
      replacing `react-app-env.d.ts`; add `vite/client` to the explicit `types`
      array (`tsconfig.json:24-26` — not additive-by-default). A TS bump beyond
      4.1 may be required — surface in review. **No TS bump was needed** (see
      "TypeScript" below); `react-app-env.d.ts` **stays** until Phase 3.
- [x] Scoped node polyfills (buffer/stream/assert, global `Buffer`) (§2.2); altcha
      alias (§2.3).
- [x] Fix `src/index.css` `../public/` font URLs (§5.4) — `/fonts/*.ttf` must stay
      reachable (constraint 9).
- [x] Service worker via **`workbox-build` `injectManifest`** (decided): emit
      `/service-worker.js` at the dist root; manual precache entries +
      `revision: buildId`; excludes = `index_cgid.html`, small SVGs (if any are
      still emitted), `.map`/`asset-manifest.json`/`LICENSE`,
      `dontCacheBustURLsMatching`, 5 MB cap (§2.5 — the `.map`/`LICENSE` excludes
      deliberately *fix* today's short-circuit bug, expect the precache to shrink);
      fail-closed non-dev guard; replace `process.env.PUBLIC_URL` in the SW.
- [x] **Verify the SVG-prune assumption** (decided): confirm the Vite build emits no
      standalone `static/`-media SVGs for component-imported icons; record the
      result in this file (gates deleting the prune loops in Phase 3).
      **Confirmed — see "SVG-prune verification" below.**
- [x] Dev server: host 0.0.0.0, **port 3000** (load-bearing for the SW registration
      guard, §8.1), HTTPS via the existing local certs.
- **Done when**: `vite build` output serves correctly when rsynced into the dev
  nginx (both entries, hashed assets under `static/`, SW precache manifest sane),
  and the Vite dev server works in `cg-builder` (HTTP + HTTPS). CRA build still
  intact. — *Build, dev server (HTTP + HTTPS) and CRA parity verified on the host
  (node 24); the in-container / rsynced-into-nginx run is Phase 3/4.*

#### Phase 2 results and arrangement notes

**How the two build stacks coexist.** Both HTML templates now live at the repo
root (`index.html`, `index_cgid.html`) and are shared, not duplicated:

- Vite consumes them directly as MPA entries.
- CRA reaches them through `craco.config.js`: a `paths` override repoints
  react-scripts' `paths.appHtml` (which hardcodes `public/index.html` and is
  also what `checkRequiredFiles` asserts), and the second HtmlWebpackPlugin
  template path follows.
- The templates carry **no** `<script src>`. A hardcoded `/src/index.tsx` would
  survive into CRA's output and 404, so Vite injects the entry script from a
  `transformIndexHtml` pre-hook (`vite/htmlEntryScripts.ts`) instead.

Two more additive craco tweaks keep CRA green under the shared source tree, and
all three die with `craco.config.js` in Phase 3:

- an `@svgr/webpack`-only rule for `resourceQuery: /^\?react$/`, because
  react-scripts' own `.svg` rule chains svgr **+ file-loader**, which makes the
  *default* export the URL rather than the component;
- `css-loader`'s `url.filter` set to skip server-relative `url()`s, so the
  `/fonts/*.ttf` references resolve at the web server instead of through
  webpack's `resolve.roots`.

**CRA output delta from the shared-source changes** (all intended): the 98
standalone `static/media/*.svg` files and the 3 duplicated Inter TTFs are no
longer emitted; `build/` shrinks 64.4 MB → 62.5 MB and the precache manifest
242 → 229 entries. The emitted `index.html` is otherwise byte-identical apart
from content hashes.

**SVG-prune verification (gates the Phase-3 prune deletion): confirmed.** The
Vite dist contains exactly **one** `.svg` file — `logo.svg`, the copy-verbatim
`public/` asset the pre-React loading screen references — and **zero** files
under `static/`. Component-imported SVGs are compiled to JSX in both stacks now,
so `docker/build.sh:79-90` and `selfhost.sh:80-85` can be deleted. Until then
they had to be made no-match-safe in this phase: with nothing left to prune the
glob stays unexpanded, and in `selfhost.sh` (`set -euo pipefail`) the `wc -c`
on the literal pattern aborted the build right after the frontend rsync. Both
loops now start with `[ -e "$f" ] || continue`. The workbox
small-SVG filter is kept as a tripwire in `vite/serviceWorker.ts` (a precached
URL that the prune deletes makes `PrecacheController.install()` reject and the
worker never activates, §10.1).

**Precache manifest**: 229 entries (CRA, post-Phase-2 source) → **117** (Vite).
The drop is the intended §2.5 bugfix: 95 `.map` files, 16 `LICENSE` files and the
worker's own `service-worker.js`/`.map` are gone. Content: 1 × `index.html`
(with a revision hash), 85 js, 15 css, 12 webp, 4 png, all hashed entries with
`revision: null`, plus the 10 hand-added entries (4 fonts, 4 mp3s, 2
cross-origin-isolation shells) with `revision: buildId`. `index_cgid.html` is
excluded, as before.

**Hash format**: rollup's default hash alphabet is base64url, which would have
made `dontCacheBustURLsMatching: /\.[0-9a-f]{8}\./` dead. The build pins
`output.hashCharacters: 'hex'` with `[hash:8]`, so the CRA-era pattern keeps
working unchanged and the emitted names stay in the familiar
`static/js/name.deadbeef.js` shape.

**TypeScript**: no bump — everything works on the installed **4.5.2**. Vite 6.4,
`@vitejs/plugin-react` 4, `vite-plugin-svgr` 4 and `vite-plugin-node-polyfills`
0.23 do not type-check the project, and `vite/client` parses fine under 4.5.
Vite 6 (not 7) was chosen because the builder image is node 20.11 and Vite 7
requires ≥ 20.19.

`vite/client` **is** in the tsconfig `types` array now. It does *not* collide
with the react-scripts ambient types — verified: both declare `*.svg`/`*.png`/
`*.css` wildcards and TS 4.5.2 merges them without duplicate-identifier errors —
so `src/react-app-env.d.ts` stays until CRA is removed in Phase 3. The `?react`
form is typed by a hand-written `src/types/svg-react.d.ts` (neither `vite/client`
nor react-scripts covers it).

#### Findings that change Phase 3

1. **`tsc --noEmit` is currently a no-op for semantic errors.** `node_modules/viem`
   ships `.d.ts` files using TS-5 syntax that TS 4.5.2 cannot *parse*; tsc reports
   633 syntax errors and, because syntactic diagnostics are non-empty, **never runs
   semantic checking at all** (verified: a deliberately mistyped file in `src/`
   produces no error). Today's real type check is react-scripts'
   ForkTsCheckerWebpackPlugin, which filters issues down to `src/**` and therefore
   ignores the viem noise. Constraint 10 ("the Vite pipeline must add
   `tsc --noEmit`") is therefore **not** satisfiable as-is: Phase 3 has to either
   bump TypeScript (viem asks for ≥ 5.0.4) or reproduce ForkTsChecker's filtering.
2. **`@metamask/sdk` resolves differently under Vite.** It declares `browser` (a
   UMD bundle) *and* `module` (its **node** ESM build); Vite prefers the ESM
   `module` entry, which drags the node build — and externalized
   `fs`/`child_process`/`tls`/`zlib`/`http`/`net`/`os`/`path`/`crypto` — into the
   browser bundle. webpack's `mainFields` picks the browser UMD build (confirmed
   against the CRA sourcemaps). `vite.config.ts` pins the browser file explicitly;
   keep the alias when the dependency is upgraded.
3. **Chunking regression, open decision.** Vite's default chunking emits one
   `App` chunk of **5.63 MB**, where CRA's `splitChunks: { chunks: 'all' }` spread
   the same code over many (CRA's largest chunk: 4.09 MB). Consequences: a single
   large blocking request instead of parallel ones, and — because it exceeds the
   roadmap-mandated 5 MB `maximumFileSizeToCacheInBytes` — the app bundle stays
   **out of the precache** (workbox logs it on every build). Measured against the
   CRA baseline: CRA precaches 229 entries / 31.15 MiB, of which 10.59 MiB is the
   non-`.map`/non-`LICENSE` content (118 entries, largest chunk 3.9 MiB); Vite
   precaches 117 entries / 5.06 MiB — i.e. the *only* content difference is the
   one missing 5.63 MB `App` chunk. Two consequences, both real and both about
   caching rather than correctness:
   - **offline cold start regresses.** The SW has no runtime caching, so the app
     shell loads from the precache, then `import('./App')` hits the network and
     fails offline — `src/index.tsx`'s `preloadApp()` catch shows the "Error :'("
     screen. Under CRA the app started offline.
   - **the first load after an update pulls 5.63 MB over the network.** Precache
     install warms the new build's assets while the old version still runs; the
     excluded chunk is only fetched when the reloaded page asks for it.
   Options for Phase 3, maintainer's call: (a) raise the cap (one line, zero
   runtime risk, restores parity — the precache would go to ~10.7 MiB, still a
   third of today's CRA precache; recommended); (b) add `manualChunks` — closer
   to CRA and better for load performance, but chunk splitting can introduce
   circular-import initialisation bugs that only show up in a browser, so it needs
   the Phase-4 verification pass behind it. Deliberately *not* done in Phase 2.
   Whichever is chosen, the build should **fail loudly** when an entry/chunk falls
   out of the precache instead of leaving it to a workbox log line.
4. **`asset-manifest.json` is gone** under Vite (it has no consumers, §10.4) — the
   `Done when` checks for Phase 3 should not look for it.
5. **`tools/checkHtmlRewriteCompat.mjs`** (new) runs the real rewrite logic from
   `srv/api/getRoutes.ts` and `docker/nginx/inject-instance-config.sh` against both
   emitted shells. It passes on the Vite *and* the CRA output; wire it into the
   Phase-3 build scripts. It also pins a pre-existing quirk: `og:url` ships with an
   empty `content=""` (it used to be `%PUBLIC_URL%`), which the strip regex's
   `content="[^"]+"` never matches — so the default `og:url` is *not* stripped on
   deep-link responses. Unchanged by this phase; fix separately if it matters.
6. **`PUBLIC_URL` is not only a service-worker token** — the claim in "Decisions
   made" is wrong for the two legacy Azure pipelines, which build with
   `PUBLIC_URL="https://app.cg"` / `"https://staging.app.cg"`
   (`pipelines/build-production.yml:90`, `pipelines/build-and-deploy-beta.yml:90`).
   Everything else (`run.sh`, `docker/build.sh`, `updateFrontend.sh`,
   `selfhost.sh`) leaves it empty, which is why the `%PUBLIC_URL%` → root-relative
   rewrite is byte-parity there. On the two pipeline paths it is *not*: the shells
   used to ship absolute `og:image`/`twitter:image`/`og:url` values and now ship
   `/icons/preview.png` and `content=""`. Asset/manifest/icon URLs are unaffected
   (same origin), and deep-link responses are unaffected (`getRoutes.ts` injects
   absolute image URLs) — the delta is the default social preview of the bare
   `https://app.cg` URL, where a relative `og:image` is not resolvable by most
   scrapers. Note this is exactly the behavior every selfhost instance has today.
   Phase 3 has to touch these pipelines anyway (`GENERATE_SOURCEMAP`,
   `--openssl-legacy-provider`); decide there between dropping `PUBLIC_URL`
   and accepting relative social images, or having the backend/nginx inject
   absolute ones.

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
