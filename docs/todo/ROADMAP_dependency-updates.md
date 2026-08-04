# Roadmap: Dependency Updates (frontend + backend)

> Bring both `package.json` workspaces (`/` and `/srv`) from their multi-year-old
> resolutions to current, secure versions — in reviewable, PR-sized waves, without
> touching the majors that are deliberately out of scope.

**Owner**: autonomous agent (Fable context), maintainer decisions below are settled.
**Created**: 2026-08-04. Living document — update checkboxes and notes as work
progresses; delete the file when the workstream is done (lifecycle per AGENTS.md).

---

## Evidence base (audited 2026-08-04)

- Both `yarn.lock` files were frozen at (or near) the **floor of every `^` range**:
  installed were axios 1.6.7, express 4.17.3, typeorm 0.3.17, ws 8.16, pg 8.7.3,
  sharp 0.30.6, redis 4.0.4, puppeteer 22.2.0, wagmi 1.3.9, viem 1.2.5.
- `yarn npm audit --all` findings (high severity):
  - **srv**: typeorm (SQL injection in `save`/`update`, fixed in 0.3.x line), axios
    (~30 advisories: SSRF, credential leak, prototype pollution — fixed ≤1.19),
    ws (DoS), express-fileupload (arbitrary file overwrite), express (open redirect),
    sharp 0.30 (libwebp CVE-2023-4863 + 2026 libvips CVEs), multer 1.x (EOL,
    fixed in 2.x), `ip` (SSRF `isPublic`, **no fixed version exists**).
  - **root**: axios, lodash (`_.template` code injection), sanitize-html (ReDoS),
    postcss (path traversal via sourceMappingURL), joi (fixed in 17.13.4).
- Scoping greps (2026-08-04):
  - `ip` is used in exactly one file: `srv/util/rateLimit.ts` (`isV4Format`,
    `isV6Format`, `toBuffer` for a /56 IPv6 prefix key).
  - ethers 5 in the frontend: 8 files. Five use only `formatUnits`/`parseUnits`/
    `BigNumber` (replaceable with viem, already a dependency). Three have real
    provider logic (`ethers.providers.Web3Provider`): `src/util/signatureHelper.ts`,
    `src/context/UserOnchainProvider.tsx` (contains a viem→ethers adapter hook),
    `src/context/UniversalProfileProvider.tsx` (Lukso UP).
  - wagmi v1 API surface: 11 files (`configureChains`, `createConfig`,
    alchemy/public/jsonRpc providers, `WagmiConfig`, `useAccount`, `useChainId`,
    `useContractRead(s)`, `useContractWrite`, `useNetwork`, `useSignMessage`,
    `useSwitchNetwork`, `useWaitForTransaction`). RainbowKit referenced in 10 files.
  - React-19 blockers: `react-beautiful-dnd` (deprecated, no React 19 support) in
    6 files; `framer-motion` direct in 3 files; `react-modal-sheet` v2 (framer-based)
    in `BottomSliderModal` + CSS in 7 more; `slate-react` 0.106 predates React-19
    support (needs ≥ the first React-19-supporting release, ~0.112).
  - OpenZeppelin: contracts use only `Ownable`, `ReentrancyGuard`, `ECDSA`, `ERC20`
    (+ Foundry-side `IERC20`/`SafeERC20` in `contracts/staking` with its own OZ copy).
    No Governor, no SignatureChecker. The audit-flagged modules are not in use, or
    only in the retired `TokenSale.sol`.

## Maintainer decisions (2026-08-04)

1. Wave 0 lands as **two PRs** (frontend / backend).
2. `ip` gets **replaced**, not updated (no fix exists).
3. **Contracts stay untouched** — no OZ bump, no redeploys planned. (Separately, the
   maintainer is considering moving `contracts/` to its own repo/submodule — tracked
   in `TODO.md`, out of scope here.)
4. **React 19: yes**, as its own wave (est. ~4 PRs, comparable to the Vite migration).
5. **wagmi/viem/RainbowKit: update.** Frontend **ethers 5 gets removed** as part of
   the web3 wave (not a separate workstream — usage is shallow, see evidence). The
   maintainer's old ethers-6 blockers are years stale; assume resolved, verify.
6. `@sendgrid/mail` / `@mailchimp/mailchimp_marketing`: **do not touch** — they are
   deleted wholesale by the upcoming email workstream (see TODO.md).
7. Out of scope (deliberate): Express 5, Tailwind 4, TypeScript 6/7, Vite 8 (own
   deferred workstream, see TODO.md), joi 18, TypeORM 1.x, react-router 7, slate
   beyond the React-19 minimum, mediasoup/protoo (fresh 3.23 migration, staging
   verification still outstanding — see TODO.md), passport-twitter (auth
   consolidation planned), Truffle/Hardhat tooling (Hardhat 2.29 bump stays a
   TODO.md item).

## Execution conventions (all waves)

- One branch per PR, branched off `develop` (or stacked on the previous unmerged
  branch when proceeding autonomously — record the stacking order in this file).
- **Verification gates per PR** — all must pass before the PR is presented:
  - frontend: `yarn typecheck && yarn lint && yarn test && yarn build && yarn check:html-rewrite`
  - backend: `tsc` build via `./run.sh update_backend` (or builder-container build),
    jest suite (note: `srv/jest.config.js` currently only matches compiled `.js` —
    see TODO.md; don't let a green-because-empty run count as verification)
  - after backend-affecting waves: `./run.sh build_full` smoke (stack comes up, login
    works, a message sends)
- Re-run `yarn npm audit --all` in the affected workspace after each wave; record the
  before/after high-severity count in the PR description.
- Exact-pinned packages stay exact-pinned; ranged packages keep their range style.
  When a bump is security-motivated, raise the range floor to the fixed version.
- Never push without the maintainer's go. Local commits per logical step are wanted.
- Manual-test flags for the maintainer (cannot be verified headlessly): passkey
  login (wave 1.5), wallet logins incl. Lukso UP (wave 3), voice calls (untouched
  here, but any socket.io bump warrants a quick call smoke), push notifications
  (wave 2 workbox PR), drag & drop UX (wave 4).

---

## Branch / stacking order (update as branches are cut)

1. `chore/deps-wave0-frontend` — off `develop`; carries the roadmap-creation docs
   commit. **Ready for review.**
2. `chore/deps-wave0-backend` — stacked on 1 (roadmap lives there). Merge after 1.
   **Ready for review.**

## Wave 0 — lockfile refresh within existing ranges (2 PRs)

No `package.json` changes; `yarn up -R '*'` re-resolves every dependency to the
newest version its existing range allows. `^0.x` semantics keep slate, sharp,
reflect-metadata, typeorm-in-0.3 etc. from jumping lines. Verify manifests are
untouched via `git diff`.

- [x] **PR 0a (frontend)**: `yarn up -R '*'` in `/`. Expected security payoff: axios
  1.19, lodash 4.18, sanitize-html 2.17, joi 17.13.4, postcss 8.5.25, plus dozens of
  minors (react-router 6.30, styled-components 6.4, dayjs, emoji-picker…). Full
  verification gate + bundle-size sanity check against the Vite-7 baseline.
  - Branch `chore/deps-wave0-frontend`. Audit: **22 high → 0 high**, 33 moderate → 7,
    1 low → 0. Six of the seven residual moderates are deprecation notices already
    scheduled in later waves (@floating-ui rename 2c, @metamask/sdk 3,
    @simplewebauthn/types 1.5, react-beautiful-dnd 4a, recharts 4d) plus
    `@truffle/hdwallet-provider`. **The seventh is net-new and needs a decision**:
    react-router-dom 6.30.4 is in the range of GHSA-jjmj-jmhj-qwj2 (open redirect →
    XSS, moderate, >=6.30.2 <=6.30.4). There is **no fixed 6.x release** — the fix is
    react-router 7.13, and v7 is out of scope (decision 7). **Resolved conservatively
    (2026-08-04, agent decision, maintainer may override)**: `resolutions` holds
    react-router-dom at 6.30.1, which predates the vulnerable range — security
    posture stays no worse than before the refresh. The pin dissolves whenever the
    deferred react-router-7 workstream lands; drop it from `package.json` then.
    Gate re-run green after the hold (typecheck, test 4/4, build, check:html-rewrite).
  - `yarn up -R '*'` alone is **not** the full refresh the wave assumed: micromatch's
    `*` does not cross `/`, so every scoped package stayed at its range floor. The
    lockfile was produced with `yarn up -R '*' '@*/*'`. **Use both patterns in PR 0b.**
  - Resolved: axios 1.6.7→1.19.0, lodash 4.17.21→4.18.1, sanitize-html 2.6.1→2.17.6,
    joi 17.7.0→17.13.4, postcss 8.4.31→8.5.25, react-router-dom 6.0.2→6.30.4,
    styled-components 6.1.8→6.4.4, tailwindcss 3.1.6→3.4.19, react/react-dom
    18.2.0→18.3.1, viem 1.2.5→1.21.4, wagmi 1.3.9→1.4.13, rainbowkit 1.0.8→1.3.7,
    recharts 2.12.7→2.15.4, emoji-picker-react 4.9.2→4.19.1, dayjs 1.10.7→1.11.21,
    react-select 5.2.2→5.10.2, ethers 5.7.2→5.8.0. Deliberately unmoved (`^0.x` /
    exact pins / out-of-scope majors): slate 0.103, slate-react 0.106, socket.io-client
    4.7.1, dexie 4.0.8, workbox 6.5.4, @simplewebauthn 10, @metamask/sdk 0.1.0,
    @farcaster/auth-kit 0.3.1 — all owned by later waves.
  - Four fixes were needed; none were optional:
    1. **`history` became an explicit dependency** (`^5.3.0`). react-router-dom 6.30
       dropped its `history` dep in favour of `@remix-run/router`, and
       `src/components/SuspenseRouter/SuspenseRouter.tsx` imports `createBrowserHistory`
       from it — a phantom dependency that broke module resolution, not just types.
    2. **`resolutions: { "@types/react": "18" }`.** Five `@types/*` packages depend on
       `@types/react@*`, which now resolves to 19.x; the second copy made every
       react-beautiful-dnd / react-google-recaptcha component fail `TS2786`. The pin
       goes away again in wave 4d.
    3. **`ua-parser-js` pinned into `vendor-shared`** (vite.config.ts). RainbowKit 1.3
       added a `ua-parser-js` dependency; because the CG ID mini-app imports it
       directly too, rollup folded the whole `vendor-web3` chunk into the `index_cgid`
       entry and `cg:assert-cgid-entry-chunks` failed the build — precisely the failure
       mode that guard exists for. (The workbox `Invalid mapping` error that follows a
       failed build is a knock-on effect of the empty `outDir`, not a separate bug.)
    4. `AreaItem`'s `draggableHandlerProps` widened to `| null`, matching
       `@types/react-beautiful-dnd` ≥13.1.3.
  - Bundle (raw JS, no sourcemaps): 9.88 MB → 10.82 MB (+9.5%) over 53 chunks.
    **`vendor-web3` is the whole regression: 2.26 MB → 3.82 MB (+1.56 MB)**. About
    half of that is a **duplicated viem**: `@wagmi/connectors` 3.1 pulls
    `@safe-global/safe-apps-provider` → safe-apps-sdk 9 → **viem 2.55** (826 KB raw)
    next to our viem 1.21 (978 KB); the rest is viem 1.2→1.21 growth + wagmi 1.4 +
    rainbowkit 1.3 (which also adds `@tanstack/react-query`). Verified benign at
    runtime (disjoint code paths). Deliberately NOT deduped via a
    `@safe-global/safe-apps-sdk: 8` resolution — forcing a major down for a wallet
    connector is riskier than 826 KB for the interim; **wave 3's viem-2 migration
    collapses the duplicate — re-measure there** (interim review finding A, 2026-08-04). Offsetting it,
    `vendor-icons` fell 690 KB → 60 KB (heroicons 2.2 tree-shakes properly). The CG ID
    entry is unaffected: `index_cgid` 8.5 KB + `vendor-shared` 72.5 KB + `vendor-react`.
  - Gate: typecheck / lint (0 errors, 645 pre-existing warnings) / test (4) / build /
    check:html-rewrite all green.
  - **Manual browser pass wanted** before merge: client-side navigation (the `history`
    package is now a separate copy from react-router's vendored one) and a general
    smoke of the wallet/login flows, a call, the editor, charts and the emoji picker —
    the `VENDOR_GROUPS` change moves chunk boundaries, which no build-time check covers.
- [x] **PR 0b (backend)**: same in `/srv`. Expected: axios 1.19, typeorm 0.3.x-latest
  (SQL-injection fixes), express 4.21, ws 8.21, pg 8.22, express-fileupload 1.5.2,
  AWS SDK current. While here: re-check whether `srv/util/axios.ts` still needs its
  `keepAlive: false` workaround on Node 24 + axios 1.19 (absorbed from TODO.md —
  either drop the workaround or update its comment).
  - Branch `chore/deps-wave0-backend`, stacked on `chore/deps-wave0-frontend`.
    Lockfile produced with `yarn up -R '*' '@*/*'` (both patterns, per the 0a note).
    Audit: **20 high → 3, 23 moderate → 3, 4 low → 1.** Everything that survives is
    already owned by a later wave: `ip` SSRF (no fix exists → replaced in 1a),
    sharp 0.30.7 ×2 (libwebp CVE-2023-4863 + the 2026 libvips CVEs → 1a),
    multer 1.4.5-lts.2 EOL notice (→ 1a), puppeteer 22 EOL notice (→ 2a),
    `@simplewebauthn/types` deprecation (→ 1.5), cookie 0.4.2 out-of-bounds chars
    (exact pin, investigated in 1a).
  - Resolved: axios 1.6.7→1.19.0, typeorm 0.3.17→0.3.31, express 4.17.3→4.22.2,
    ws 8.5.0→8.21.2, pg 8.7.3→8.22.0, express-fileupload 1.3.1→1.5.2,
    `@aws-sdk/*` 3.1x→3.1102.0, joi 17.7→17.13.4, redis 4.0.4→4.7.1,
    puppeteer 22.2→22.15, express-session 1.17→1.19, multer …lts.1→lts.2,
    ip 1.1.8→1.1.9, sharp 0.30.6→0.30.7 (in-line). Unmoved by design (exact pins /
    `^0.x`): socket.io 4.7.1, `@socket.io/redis-adapter` 8.2.1, ethers 6.7.1,
    cookie 0.4.2, cookie-signature 1.0.6, connect-redis 6.1.3, mediasoup 3.23.2.
    Interim-review corrections (2026-08-04): `@sendgrid/mail` 8.1.3→8.1.6 and
    `@mailchimp/mailchimp_marketing` 3.0.78→3.0.80 **did** move — in-range patch
    bumps only; decision 6 ("do not touch") means no manual work / no majors, and
    both get deleted by the email workstream, so this is fine. The `ws 8.5.0→8.21.2`
    line is the direct dep; a nested ws 8.5.0 survives inside the exact-pinned
    ethers 6.7.1 (not audit-flagged).
  - Four fallout fixes were needed; none optional (`package.json` had to change —
    the `yarn up` itself left it untouched, `git diff` confirmed, the edits below
    are the follow-up):
    1. **AWS SDK phantom dependencies.** `repositories/files.ts` imported
       `@aws-sdk/{url-parser,hash-node,protocol-http,util-format-url}`, none of them
       declared and all four gone from the 3.1102 dependency tree. The first three
       moved to `@smithy/*` (added as explicit deps: `@smithy/url-parser` ^4,
       `@smithy/hash-node` ^4, `@smithy/protocol-http` ^5); `formatUrl` is still an
       AWS package (`@aws-sdk/util-format-url` ^3.972.42, added explicitly). The
       high-level `getSignedUrl` helper is *not* a substitute — `getSignedUrls()`
       mutates the `HttpRequest` (port, query, path) before formatting.
    2. **`resolutions: { "@types/express": "4", "@types/express-serve-static-core": "4" }`.**
       `@types/express-session`, `-ws` and `-fileupload` all depend on
       `@types/express@*`, which now resolves to 5.x and hoisted
       `@types/express-serve-static-core@5` over the v4 copy — two incompatible
       `Request` types, exactly the `@types/react` failure mode from 0a. Drop the
       pin when Express 5 is picked up (out of scope, decision 7).
    3. **`rowCount` is `number | null`** in `@types/pg` ≥8.11 (7 call sites in
       `jobs/callUpdateEmitter`, `repositories/{articles,communities×2,communityEvents,emails,newsletter}`)
       — guarded with `?? 0`.
    4. **express-session 1.19 types** widened `SessionOptions['cookie']` to
       `CookieOptions | ((req) => CookieOptions)`, so `sessionOptions.cookie!.domain`
       no longer type-checks; `util/express.ts` now keeps the cookie options in
       their own `session.CookieOptions` binding.
  - **`keepAlive: false` in `srv/util/axios.ts` stays.** Evidence (2026-08-04):
    nodejs/node#47130 was closed **as not planned** (2024-07-22, "known limitation");
    nodejs/node#55170 (Node 20.18.0) only narrowed the race window; axios/axios#6113
    still collects reproductions on Node 22.12 with axios 1.9, and the axios
    maintainer's own advice there (2025-08-27) is this exact agent pair. The axios
    1.7→1.19 changelog fixes keep-alive *listener leaks* (#10788, #10576), not the
    pooling bug. The comment now records this; the real exit is axios' fetch/undici
    adapter, not a version bump.
  - Verification: `./run.sh update_backend` green (docker available; the in-container
    `yarn tsc` is the gate — it caught all four fallout classes above), full stack
    healthy, `POST /api/v2/Community/getCommunityList` returns real rows over
    nginx→api→pg, session cookie issued through connect-redis, joi rejects a bad
    body. `./run.sh build_full` smoke run as well. Interactive login / message-send
    remain the maintainer's part.
  - **The jest gate could not be met, and not because of the config.**
    `srv/tests/accounts.spec.ts` (unchanged since the initial commit) imports
    `../entities/accounts` and an `Account` active-record class that do not exist in
    this repo — the entity is `entities/user-accounts.ts` / `UserAccount`, with no
    `save()`/`getAccount()`. So the backend has **zero runnable tests**; pointing
    `jest.config.js` at `.ts` (wave 2a) will surface a failing suite, not a green one.
    `@types/jest` is also missing. Wave 2a should either rewrite the spec against
    `UserAccount` or delete it and start the backend suite from scratch.
  - Two non-blocking observations for later waves:
    - `memberlist` now logs `DeprecationWarning: Calling client.query() when the
      client is already executing a query … removed in pg@9.0` — real overlapping-query
      code, worth fixing before any pg 9 bump.
    - `job-runner` can crash-loop `premiumRenewal` with sharp's
      `Module did not self-register`. **Pre-existing, not caused by this wave** —
      reproduced identically on the unchanged lockfile (sharp 0.30.6) with a
      two-sequential-`worker_threads` repro: sharp <0.33 is not reload-safe, so a
      short-lived worker that loads sharp (e.g. `emailNotifications`) poisons the
      next worker that does. Order-dependent, which is why it does not fire on every
      boot. **sharp ≥0.33 fixes it — fold this into the wave-1a sharp bump.**

## Wave 1 — targeted security bumps the ranges can't reach (2 PRs)

- [ ] **PR 1a (backend)**:
  - [ ] sharp `^0.30.6` → `^0.35.3` (libvips/libwebp CVEs); **drop `@types/sharp`**
    (sharp ships its own types since 0.32); verify the call sites against the
    0.32/0.33 changelogs (resize/rotate defaults, `failOn` rename) and that the
    Docker image build still gets working binaries
  - [ ] multer `1.4.5-lts.1` → `^2.2.0` + `@types/multer` `^2` — near drop-in; check
    the registration sites for removed 1.x-era options
  - [ ] socket.io `4.7.1` → `4.8.3` (exact pin kept), `@socket.io/redis-adapter`
    `8.2.1` → `8.3.0`, check `@socket.io/redis-emitter` + `socket.io-adapter`
    compatibility matrix
  - [ ] **replace `ip`**: rewrite the v4/v6 classification + IPv6 /56 prefix
    extraction in `srv/util/rateLimit.ts` on `node:net` (`isIPv4`/`isIPv6`) +
    manual prefix parse or `ipaddr.js`; delete the dependency and `@types/ip`;
    add unit tests (v4, v6 prefix grouping, mapped v4, invalid input)
  - [ ] cookie `0.4.2` → current + cookie-signature `1.0.6`: first **investigate why
    the exact pins exist** (likely express-session cookie-format compat — a
    cookie-signature bump may invalidate existing sessions). Bump what is safe,
    document what is deliberately kept.
  - [ ] **drop `express-fileupload` + `@types/express-fileupload`** (interim review,
    2026-08-04): nothing in `srv/` imports it — uploads go through multer in
    `srv/api/files.ts` — so its audit finding was about unreachable code, and
    `@types/express-fileupload` is one of the three packages forcing the
    `@types/express: "4"` resolution.
- [ ] **PR 1b (frontend)**:
  - [ ] socket.io-client `4.7.1` → `4.8.3` (stay in sync with server; reconnect smoke)
  - [ ] dexie `4.0.8` → `4.4.x`, dexie-react-hooks `1.1.7` → `4.4.x` (verify the
    changelog first — the hooks major looks like version alignment with dexie 4,
    confirm no API break)
  - [ ] drop `@types/confusing-browser-globals` (absorbed from TODO.md — no tsconfig
    project covers its only would-be consumer)

## Wave 1.5 — WebAuthn (1 PR, auth-critical: Fable implements, interim review mandatory)

- [ ] `@simplewebauthn/browser` + `@simplewebauthn/server` 10 → 13; **drop
  `@simplewebauthn/types`** (deprecated, merged into the main packages in v11).
  Breaking changes to check: v11 renamed the verify-response option shapes, v12/13
  tightened `AuthenticatorTransport` and dropped Node <20 (we're on 24). Passkey
  registration + login + CGID flows need a manual pass by the maintainer before
  merge — flag this explicitly when presenting the PR.

## Wave 2 — independent majors (3 PRs)

- [ ] **PR 2a (backend infra)**:
  - [ ] redis `^4.0.0` → `^6` **together with** connect-redis `^6` → `^10` (single
    PR — connect-redis 8+ requires the v4+ client API changes; verify session store
    init in `srv/serverconfig.ts` and every `createClient` call site)
  - [ ] puppeteer `^22` → `^25` (headless "new" default, `page.waitForTimeout`
    removal, cache dir move — check Docker image for bundled-Chromium path
    assumptions)
  - [ ] jest `^29` → `^30` + ts-jest current (absorbed from TODO.md; point
    `srv/jest.config.js` at the `.ts` sources while touching it — the config
    currently only finds compiled `.js`). **Plus** (wave-0 finding): add
    `@types/jest`, and rewrite-or-delete `srv/tests/accounts.spec.ts` — it imports
    an `entities/accounts` / `Account` active-record API that has never existed in
    this repo, so the suite fails as soon as jest actually finds it.
  - [ ] **drop `@types/connect-redis` + `@types/redis`** (interim review, 2026-08-04):
    `@types/redis` is a stub whose dependency drags a full *runtime* `redis@6.2.0`
    copy into the image next to the real client (verified unused via
    `require.resolve`); connect-redis ≥7 ships its own types anyway.
- [ ] **PR 2b (cross-workspace small majors)**: ua-parser-js 1 → 2 in **both**
  workspaces (AGPL dual-license is fine for us; `getResult()` API shape changed),
  @hapi/tlds 1 → 2 (data-only), short-uuid 4 → 6, open-graph-scraper 5 → 6
  (options renamed), node-cron 3 → 4 (optional — skip if API churn outweighs value),
  mime-types 2 → 3, reflect-metadata 0.1 → 0.2 (verify TypeORM compat note; since
  wave 0, typeorm 0.3.31 already loads a nested reflect-metadata 0.2.2 next to the
  hoisted 0.1.14 — verified interoperable, but the bump should dedupe to one copy),
  altcha 2 → 3 + altcha-lib 1 → 2 **as a pair** (widget and server lib must agree
  on the challenge format — test the PoW flow end to end).
- [ ] **PR 2c (frontend, service worker)**: workbox `6.5.4` → `^7.4` (precaching +
  routing + build in lockstep). Own PR because the SW drives PWA install, push and
  multi-tab coordination; needs a manual push-notification + update-flow test.
  Also here: `@floating-ui/react-dom-interactions` → `@floating-ui/react` (renamed
  package, mechanical import fix), web-vitals 1 → 6 (tiny surface), emojilib 3 → 4,
  boring-avatars 1 → 2, yet-another-react-lightbox 2 → 3, react-dropzone 14 → 20
  (check the few dropzone call sites), @giphy/react-components 9 → 10.
  Verify each against its actual usage surface before bumping — anything that turns
  out non-trivial gets split out rather than forced.

## Wave 3 — web3 stack (1–2 PRs)

- [ ] wagmi `^1.3.9` → `^2` + viem `^1` → `^2` + @rainbow-me/rainbowkit `^1` → `^2`
  (+ new peer dep `@tanstack/react-query`). Mechanical hook renames
  (`useContractRead` → `useReadContract`, `useNetwork` → `useAccount().chain`,
  `useWaitForTransaction` → `useWaitForTransactionReceipt`, `configureChains` gone —
  transports move into `createConfig`, `WagmiConfig` → `WagmiProvider`).
- [ ] **Remove ethers 5 from the frontend** in the same wave: swap the five
  utils-only files to viem's `formatUnits`/`parseUnits`/`parseEther`; rewrite the
  three provider files (`signatureHelper`, `UserOnchainProvider` incl. its
  viem→ethers adapter, `UniversalProfileProvider`) on viem wallet/public clients —
  or, only where a genuine ethers dependency remains, ethers 6 `BrowserProvider`.
  Goal: `ethers` disappears from root `package.json` entirely (backend keeps
  ethers 6).
- [ ] `@metamask/sdk` 0.1.0 is deprecated (superseded by MetaMask Connect): check
  whether the RainbowKit-2 connector set covers our need and the direct dependency
  can simply be dropped.
- [ ] @farcaster/auth-kit `0.3` → `0.8` (login flow retest).
- [ ] `typechain` (root dep): scoping grep found **no usage** in `src/` — verify and
  drop if truly dead (contracts/ has its own typechain-types).
- [ ] After wagmi 2: the `@walletconnect` v1 packages disappear — revisit the
  "11 copies of tslib" item in TODO.md (a yarn resolution becomes safe then).
- [ ] Afterwards, evaluate wagmi 3 (+ RainbowKit compat) — separate decision, don't
  chain it blindly onto this PR.
- Manual test surface: every wallet login (MetaMask, WalletConnect, Lukso UP, SIWE),
  token-gating rule editor, PaySpark purchase flow.

## Wave 4 — React 19 (est. 4 PRs, sequential)

- [ ] **PR 4a**: replace `react-beautiful-dnd` (dead, no React 19) in its 6 usage
  sites (`ChannelManagement` tree ×3, `GroupsMenu`, `MultiEntryField`,
  `OwnCommunitiesBrowser`). Target library: agent evaluates `@dnd-kit` vs Atlassian
  `pragmatic-drag-and-drop` against the actual DnD patterns used, then commits to
  one. Drop `@types/react-beautiful-dnd`.
- [ ] **PR 4b**: framer-motion 7 → `motion` v12 (3 direct usage files) and
  react-modal-sheet 2 → 5 (peer-depends on motion v12) in one PR. Also unblocks the
  CG-ID-entry bundle-bloat item in TODO.md (framer-motion is its biggest chunk —
  re-measure after).
- [ ] **PR 4c**: slate + slate-history + slate-react to the current 0.x line (≥ first
  React-19-compatible slate-react). Editor is core functionality — Fable implements
  this itself, thorough manual matrix (marks, links, mentions, paste, mobile).
- [ ] **PR 4d**: react/react-dom/@types 18 → 19 flip + recharts 2 → 3 (React-19
  support) + fallout fixes (types churn: `JSX.Element` namespace, ref callbacks,
  `useRef` argument requirement). Check react-google-recaptcha and remaining
  React-18-peer packages; `react-native-get-random-values` looks vestigial — verify
  and drop if unused.
- react-router stays on the v6 line (v7 out of scope).

## Final gate

- [ ] Full code review of the cumulative diff (fresh reviewer context, not the
  implementing agent), findings fixed or explicitly waived by the maintainer.
- [ ] `yarn npm audit --all` clean of high severity in both workspaces (document
  any accepted residual findings here).
- [ ] Docs trued up in the same PRs that changed behavior (AGENTS.md tech-stack
  bullets, docs/frontend, docs/realtime for socket.io, docs/infrastructure for
  sharp/puppeteer image notes) — status lines updated.
- [ ] TODO.md: the absorbed items (axios keepAlive re-check, jest 30,
  @types/confusing-browser-globals) were struck when this roadmap was created; add
  any leftovers discovered during the waves.
- [ ] Delete this file (lifecycle), folding lasting insights into docs/.
