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
3. `chore/deps-wave1a-backend` — stacked on 2. **Ready for review.**
4. `chore/deps-wave1b-frontend` — stacked on 3. **Ready for review.**
5. `chore/deps-wave15-webauthn` — stacked on 4. **Ready for review**
   (maintainer passkey pass wanted before merge, see the wave-1.5 note).
6. `chore/deps-wave2a-backend-infra` — stacked on 5. **Ready for review.**
7. `chore/deps-wave2b-small-majors` — stacked on 6. **Ready for review.**
8. `chore/deps-wave2c-frontend-sw` — stacked on 7. **Ready for review.**

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
    body. `./run.sh build_full` smoke run as well. **Post-hoc (found during 1a,
    fix commit moved into this branch): the AWS SDK 3.88→3.1102 bump broke image
    uploads** — `saveImage()` handed the Sharp instance (an unknown-length stream)
    to `PutObjectCommand`, which the new SDK rejects outright; fixed by passing
    the already-materialised buffer, verified end to end against the running
    stack. The upload path had no test — regression test wanted in 2a.
    Interactive login / message-send
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

- [x] **PR 1a (backend)** — branch `chore/deps-wave1a-backend`, stacked on
  `chore/deps-wave0-backend`. **Audit: 3 high / 3 moderate / 1 low (wave-0b end
  state) → 0 high / 2 moderate / 0 low.** (The branch base after the `ip` commit
  was already 2 high / 3 moderate / 1 low.) Everything gone: `ip` SSRF, sharp
  libwebp + libvips, multer 1.x EOL, cookie <0.7 out-of-bounds chars. The two
  residual moderates are deprecation notices owned by later waves: puppeteer 22
  (→ 2a) and `@simplewebauthn/types` (→ 1.5).
  - [x] sharp `^0.30.6` → `^0.35.3` (libvips/libwebp CVEs); **drop `@types/sharp`**
    (sharp ships its own types since 0.32); verify the call sites against the
    0.32/0.33 changelogs (resize/rotate defaults, `failOn` rename) and that the
    Docker image build still gets working binaries
    - Nothing in `repositories/files.ts` touches a removed API: no
      `failOnError`/`paletteBitDepth`/legacy `sharpen` props (removed in 0.35),
      no `trim` (object-only since 0.33), no GIF output (0.34 changed the
      default loop), no `removeAlpha`. `sharp.gravity.center`, `extend`,
      `extract`, `composite` (incl. `raw` + `tile`), `blur`, `rotate()`,
      `resize(fit: cover|fill, withoutEnlargement)` and `metadata().size` all
      behave as before — exercised against 0.35.3 with a script mirroring every
      call site. 0.35's new `limitInputChannels: 5` default is above anything we
      feed it.
    - **Node ≥ 20.9** is required by 0.35 (image is node 24.18). Installation is
      now prebuilt `@img/sharp-*` optional deps instead of `prebuild-install`,
      so the in-container `yarn` needs no build toolchain for it; verified inside
      the built image (`sharp 0.35.3 / libvips 8.18.3`, webp encode works in both
      `api` and `job-runner`).
    - **The wave-0 job-runner crash-loop is gone.** The two-sequential-
      `worker_threads` repro that reproduced `Module did not self-register` on
      0.30.x runs clean four times in a row, both on the host and inside the
      `job-runner` container. Over ~40 minutes of stack uptime the job runner
      spawned 33 workers (10× `emailNotifications`, 19× `onlineStatusCheck`,
      1× `activityScore`), all exited 0, the permanent `premiumRenewal` worker
      stayed alive and the container has 0 restarts.
  - [x] multer `1.4.5-lts.1` → `^2.2.0` + `@types/multer` `^2` — near drop-in; check
    the registration sites for removed 1.x-era options
    - One registration site (`srv/api/files.ts`) using only `memoryStorage()`,
      `limits.fileSize` and `.single('uploaded')` — none of it changed in 2.x
      (2.x only raises the Node floor to 10.16 and drops mkdirp/object-assign/
      xtend). Verified on an express 4.22 harness replicating the route shape
      *and* against the running stack: `req.file` is a Buffer, `req.body.options`
      is still the text field, a 9 MB file still fails `LIMIT_FILE_SIZE`.
    - Note for wave 2a: `@types/multer` 2 is another consumer of
      `@types/express@*`, so it joins the packages pinning the
      `@types/express: "4"` resolution.
  - [x] socket.io `4.7.1` → `4.8.3` (exact pin kept), `@socket.io/redis-adapter`
    `8.2.1` → `8.3.0`, check `@socket.io/redis-emitter` + `socket.io-adapter`
    compatibility matrix
    - Matrix, read off the installed manifests: redis-adapter 8.3.0 raises its
      peer range to `socket.io-adapter ^2.5.4` (was `^2.4.0`); our direct
      `socket.io-adapter ^2.4.0` resolves to 2.5.8, which also satisfies
      socket.io 4.8.3's `~2.5.2` → **one copy**. `socket.io-adapter` is imported
      nowhere; the direct dep exists only for that peer range. redis-emitter
      5.1.0 pairs with redis-adapter 8.x (both `notepack.io ~3.0.1`) and shares
      the same `socket.io-parser` 4.2.7 copy. socket.io 4.8.3 pulls engine.io
      6.6.9 (was 6.5.5), which **drops the `cookie ~0.4.1` / `@types/cookie`
      deps** — the last consumer of the old cookie line besides our own pin.
    - **4.8.3 server ↔ 4.7.1 client verified explicitly** (frontend stays on
      4.7.1 until 1b): polling→websocket upgrade, websocket-only, event + ack
      round-trips, reconnect after a forced transport close, and the handshake
      `cookie` header `wsapi.ts:decodeSessionId()` reads. Repeated through nginx
      against the running stack with a real session cookie: connect, upgrade,
      server `buildId` event, no server-side disconnect. 4.8's additions
      (WebTransport, connection state recovery, `cleanupEmptyChildNamespaces`)
      are opt-in and unused.
    - Still open (maintainer, needs a browser): a **voice-call smoke** — the
      manual-test flag from the execution conventions. Calls run over
      protoo/mediasoup, not socket.io, but the call *signalling UI* is driven by
      socket.io events.
  - [x] **replace `ip`**: rewrite the v4/v6 classification + IPv6 /56 prefix
    extraction in `srv/util/rateLimit.ts` on `node:net` (`isIPv4`/`isIPv6`) +
    manual prefix parse or `ipaddr.js`; delete the dependency and `@types/ip`;
    add unit tests (v4, v6 prefix grouping, mapped v4, invalid input)
    - Done 2026-08-04 (Fable directly): pure logic extracted to
      `srv/util/ipPrefix.ts` (no redis import → unit-testable), `ip`/`@types/ip`
      removed, 13 tests in `srv/tests/ipPrefix.spec.ts`. **Interim review verified
      correctness hard**: oracle-checked against the WHATWG URL parser over 243k
      generated isIPv6-valid inputs (0 mismatches; the old `ip.toBuffer` even had
      a truncation bug the rewrite doesn't), and 1.5M adversarial inputs prove
      the change is strictly fail-closed (no input gains a key that was rejected
      before). Three deliberate behavior changes, documented in the code:
      (1) v6 prefix keys zero-padded per byte (old unpadded hex collided across
      prefixes; old keys age out within the window); (2) `::ffff:a.b.c.d` gets a
      real per-client bucket — the review corrected my original claim here: the
      old code did NOT reject v4-mapped clients, it truncated them at the first
      dot and keyed them ALL into one shared all-zero bucket (global limit
      collision); (3) strict `node:net` validation rejects non-canonical shapes
      (`070.41.3.18`, `999.1.2.3`, `1.2.3`, `abcd`) that the old regexes keyed
      as-is — now INVALID_REQUEST, fail-closed. The commit message of the ip
      commit still carries the wrong pre-review v4-mapped rationale; the code
      comment, tests and this note are the corrected record.
    - Review-driven pull-forwards from 2a (small, kept 2a's jest-30 bump intact):
      `jest.config.js` now matches `.spec.(js|ts)` with ts+js moduleFileExtensions
      so `yarn tests` actually runs the suite (13/13); the never-compiling
      `tests/accounts.spec.ts` (imported entities that never existed) is deleted
      — 2a starts the backend suite fresh; `@types/jest` pinned `^29` to match
      jest 29 (the `^30` I first added dragged a jest-30 runtime subtree into the
      production image via the Dockerfile's bare `yarn`).
  - [x] cookie `0.4.2` → current + cookie-signature `1.0.6`: first **investigate why
    the exact pins exist** (likely express-session cookie-format compat — a
    cookie-signature bump may invalidate existing sessions). Bump what is safe,
    document what is deliberately kept.
    - **Why they exist: no reason that survives inspection.** Both pins date to
      the initial commit (`git log -S`), with no rationale anywhere. `cookie` has
      exactly one consumer, `cookie.parse()` on the Socket.IO handshake header in
      `wsapi.ts`; `cookie-signature` has **none** — its import in `wsapi.ts` is
      commented out and nothing else references it.
    - **cookie → `0.7.2`** (exact pin kept), the version cookie-parser 1.4.7
      itself depends on, so the tree collapses to a single copy and the low-
      severity GHSA-pxg6-pf52-xh8x (`<0.7.0`, and only reachable through
      `serialize`, which we never call) is gone. Differential-tested 0.4.2 vs
      0.7.2 on a realistic signed express-session header (quoted, empty,
      percent-encoded, `s:`-prefixed values): byte-identical `parse()` output and
      identical `cookieParser.signedCookies()` result.
    - **Deliberately not taken further**: cookie 1.x is named-exports-only (needs
      a wsapi import rewrite), re-duplicates the package next to cookie-parser's
      0.7.2 and carries no security delta; cookie 2.x is **ESM-only** with a
      renamed API (`parse` → `parseCookie`) and `engines.node >= 22` — not worth
      it for one `parse()` call in a CommonJS build. Revisit if the backend ever
      goes ESM.
    - **cookie-signature dropped** (with `@types/cookie-signature`) instead of
      bumped, and **no session can be invalidated by it**: express-session signs
      with its own `~1.0.7` copy and cookie-parser verifies with its own exact
      `1.0.6` — already a cross-version pair *before* this change. Proved 1.0.6
      and 1.0.7 emit byte-identical signatures and verify each other's. After
      removal each consumer still resolves the same version as before (only the
      hoisting flipped: 1.0.7 is now the hoisted copy, cookie-parser keeps a
      nested 1.0.6). The commented-out `import signature from 'cookie-signature'`
      in `wsapi.ts` was left in place as the record of the alternative unsign
      path; re-enabling it means re-adding the dependency.
  - [x] **drop `express-fileupload` + `@types/express-fileupload`** (interim review,
    2026-08-04): nothing in `srv/` imports it — uploads go through multer in
    `srv/api/files.ts` — so its audit finding was about unreachable code, and
    `@types/express-fileupload` is one of the three packages forcing the
    `@types/express: "4"` resolution.
    - Grep claim re-verified over every tracked file in `srv/`: the string
      "fileupload" appeared only in `package.json`. Removed.
    - **It does not dissolve the `@types/express: "4"` resolution** — seven other
      packages depend on `@types/express@*` (`express-session`, `express-ws`,
      `cookie-parser`, `connect-redis`, `passport`, `passport-twitter` and now
      `@types/multer` 2). The pin stays until Express 5 (out of scope).
  - [x] **Fallout fixed here, but not caused here**: image uploads were broken on
    the branch base. `saveImage()` handed the *Sharp instance* to S3
    `PutObjectCommand` as a stream body, and since the wave-0b `@aws-sdk`
    3.88 → 3.1102 bump the client rejects unknown-length stream bodies outright
    (`Invalid value "undefined" for header "x-amz-decoded-content-length"` →
    API answers `UNKNOWN`). Bisected in the running stack: Buffer body OK, fs
    stream OK (the SDK stats its `path`), plain `Readable.from(buffer)` fails
    identically to the Sharp stream, and SDK 3.88.0 still accepts an
    unknown-length stream with only a warning. Fix: pass `resizedBuffer`, which
    `saveImage()` already materialised for the sha256 file id — streaming the
    consumed Sharp instance only re-ran the whole pipeline a second time.
    **Worth mentioning in the wave-0b PR description**; wave 2a should add a
    regression test for the upload path.
  - Verification gate: `npx tsc --noEmit` in `srv/` clean after every step;
    `./run.sh update_backend` green (in-container `yarn` + `yarn tsc`, no native
    build step needed any more — sharp installs prebuilt); `./run.sh build_full`
    green with the whole stack healthy afterwards; `tests/ipPrefix.spec.ts`
    still 11/11 via the ts-jest CLI override (`jest.config.js` untouched, it is
    2a's job). Live smoke over nginx: `getCommunityList` returns real rows
    through nginx→api→pg, a session cookie is issued through connect-redis, joi
    rejects a bad body, `POST /api/v2/File/uploadImage` stores a 110×110 webp in
    seaweed with a matching `files` row, and a socket.io-client 4.7.1 client
    connects, upgrades to websocket and receives `buildId`.
  - Not verifiable headlessly (maintainer): interactive login, message send,
    a voice call, and a browser-side reconnect/presence pass.
- [x] **PR 1b (frontend)** — branch `chore/deps-wave1b-frontend`, stacked on
  `chore/deps-wave1a-backend`. **Audit: 0 high / 6 moderate → unchanged.** All six
  are deprecation notices owned by later waves (`@simplewebauthn/types` → 1.5,
  `@floating-ui/react-dom-interactions` → 2c, `@metamask/sdk` → 3,
  react-beautiful-dnd → 4a, recharts → 4d) plus `@truffle/hdwallet-provider`. The
  react-router-dom advisory stays absent — the wave-0a 6.30.1 `resolutions` hold
  is doing its job.
  - [x] socket.io-client `4.7.1` → `4.8.3` (exact pin kept)
    - **The bump deduplicates the package.** `@metamask/sdk` 0.1.0 already
      depended on `socket.io-client@^4.5.1`, which resolved to 4.8.3, so the tree
      carried two copies; the lockfile now collapses them and drops the second
      `engine.io-client` 6.5.4, `ws` 8.17.1 and `debug` 4.3.7. Confirmed in the
      build: only `connection.js` still contains socket.io/engine.io sources.
    - `src/data/appstate/webSocket.ts` is the only consumer and its surface is
      unchanged in 4.8: `io()` with `transports`/`reconnection`/
      `reconnectionDelayMax`/`path`, the `connect` / `connect_error` /
      `disconnect` listeners, emit-with-ack, `onAny`, `disconnect()` and
      `connected`/`disconnected`. 4.8's additions (WebTransport, connection state
      recovery) are opt-in and unused.
    - **Reconnect smoke run headlessly against the live 1a stack** through nginx,
      11/11 green: polling connect → websocket upgrade, `cgPing` ack round-trip
      (0 ms drift), `getSignableSecret` ack, server-pushed `buildId`, a genuine
      transport drop (closing the underlying websocket, not `engine.close()`) →
      `reason: 'transport close'` → automatic reconnect with a new socket id and
      a re-emitted `buildId`, `cgPing` ack after reconnect, a websocket-only
      client (the dev-mode transport list), and `reason: 'io client disconnect'`
      on an explicit `disconnect()`. Note for future smokes: `wsapi.ts`
      disconnects any non-bot socket without a session cookie, so the script
      first fetches a real `cg_dev.sid` from the API and passes it via
      `extraHeaders` **and** `transportOptions.websocket.extraHeaders`.
  - [x] dexie `4.0.8` → `4.4.4`, dexie-react-hooks `1.1.7` → `4.4.0` (exact pins
    kept; 4.4.0 is the current hooks release — the hooks package does not track
    dexie's patch level)
    - **The hooks major is a version-alignment release — confirmed, but from the
      published sources, not the release notes** (which say nothing about it).
      Diffing 1.1.7 against 4.4.0, the entire delta in the pre-existing API is:
      `useLiveQuery` calls `Dexie.liveQuery(querier)` instead of the bare
      `liveQuery(querier)` (same function via the namespace — it fixes a
      Vite/Vinxi named-export resolution bug in production builds, #2162), and
      `useObservable`'s inline `subscribe()` return type was extracted into an
      exported `AnySubscription` alias of identical shape. `usePermissions` is
      untouched. Everything else is additive (`useDocument` for Y.js,
      `useSuspendingLiveQuery`, `useSuspendingObservable`). What actually makes it
      a major: `peerDependencies` moved from `dexie: ^3.2 || ^4.0.1-alpha` to
      `dexie: >=4.2.0-alpha.1 <5.0.0` (dexie 3 support dropped) and the
      `@types/react` peer was removed. All 90 `useLiveQuery` call sites are
      unaffected — no code changes were needed anywhere.
    - **The `cache` option did not change.** There is no stable dexie 4.1: the
      4.1.x line was beta-only with experimental Y.js support, superseded by
      4.2.0, which extracted it into the separate `y-dexie` addon (we use
      neither). The defaulting logic is byte-equivalent between 4.0.8 and 4.4.4 —
      cache active unless `'disabled'`, results frozen only under
      `cache: 'immutable'`. `abstractDatabase.ts:37` and
      `chunkedDatabase.ts:142` set `'immutable'` explicitly; only `unique.ts`
      uses the default. 4.4.4 moved the cloned-mode isolation clone from write
      time to read time (`freezeResults ? result : deepClone(result)`), so the two
      immutable databases still clone nothing — no per-read cost on the message
      lists.
    - **One real behavior change, in our favour**: 4.4.3 changed
      `Collection.sortBy()` from `a.sort()` to `a.slice().sort()` so it no longer
      sorts a frozen cache array in place. Both our `sortBy` sites
      (`data/databases/messages.ts:135` and `:180`) sit outside any liveQuery
      querier — the two queriers that exist (`chunkedDatabase.ts:645` `.get()`,
      `itemList.ts:407` `.toArray()`) never sort — so results were never frozen
      there and the fix removes a latent hazard for the in-place
      `messages.reverse()` at `messages.ts:185` rather than fixing a live bug.
      The same commit swapped sortBy's comparator from raw `<`/`>` to dexie's
      `cmp()`; only mixed-type keys sort differently, and both sites sort `Date`
      fields (`ChunkType.end`, `DexieMessage.createdDate`), for which `cmp()`
      reduces to the identical comparison.
    - 4.2.1's external-DB-closure change does not reach us: the only
      `db.close()` calls (`data/util/device.ts`) are on a raw `IDBDatabase`, not
      a Dexie instance. `Observable` / `Subscription` / `liveQuery` / `Dexie` /
      `Dexie.Table` are exported unchanged (type shapes diff clean).
    - **Verified against both builds on `fake-indexeddb`**, replaying the real
      call shapes: `sortBy` + in-place `reverse()` under `cache: 'immutable'`,
      cache pollution after a `sortBy`, `Date` sort order, and liveQuery
      emissions in default *and* immutable cache mode. Every result is identical
      on 4.0.8 and 4.4.4.
  - [x] drop `@types/confusing-browser-globals` (absorbed from TODO.md)
    - Claim re-verified: the **runtime** `confusing-browser-globals` stays — it is
      imported at `eslint.config.mjs:37` and spread into `no-restricted-globals`
      at `:67`. The types package is unreachable three times over: no `.ts`/`.tsx`
      file imports it, `eslint.config.mjs` is in neither tsconfig's `include`
      (`tsconfig.json` covers `src`, `tsconfig.node.json` the vite configs +
      `tools/*.mjs`), and both tsconfigs set an explicit `compilerOptions.types`
      allowlist, so ambient `@types/` auto-inclusion is off entirely.
  - Gate: `yarn typecheck && yarn lint && yarn test && yarn build &&
    yarn check:html-rewrite` all green after every step — 0 lint errors, the
    unchanged 645 pre-existing warnings, 4/4 tests.
  - Bundle (raw JS, no sourcemaps), measured against the branch base rather than
    the 0a note: **10,819,170 → 10,822,058 bytes (+2.9 KB, +0.03%)** — flat.
    `community.js` +2.7 KB is dexie 4.4; `connection.js` 87.3 → 61.2 KB because
    the `vite-plugin-node-polyfills` buffer shim (27 KB) split out into its own
    shared chunk (53 → 54 chunks) once the socket.io dedup made it a shared
    dependency. `vendor-web3` and the CG ID entry are untouched.
  - **Not verifiable headlessly (maintainer)**: the multi-tab / offline behavior
    the data layer builds on dexie — the `BroadcastChannel` active/passive tab
    handoff in `webSocket.ts`, IndexedDB persistence across a reload, and the
    offline→online catch-up path. Plus the standing socket.io manual flag from
    wave 1a: a **voice-call smoke** (calls run over protoo/mediasoup, but the
    call signalling UI is driven by socket.io events) and a browser-side
    reconnect/presence pass.
  - Observation for a later wave (not acted on here): `MessageDatabase`
    (`src/data/databases/messages.ts`) is imported by `data/index.ts` and
    `appstate/login.ts`, but `getMessages()` / `getLatestMessages()` — the only
    `sortBy` users in the codebase — have **no callers**. Looks superseded by
    `chunkedDatabase`; worth a dead-code check.

## Wave 1.5 — WebAuthn (1 PR, auth-critical: Fable implements, interim review mandatory)

- [x] `@simplewebauthn/browser` + `@simplewebauthn/server` 10 → 13; **drop
  `@simplewebauthn/types`** (deprecated, merged into the main packages in v11).
  Breaking changes to check: v11 renamed the verify-response option shapes, v12/13
  tightened `AuthenticatorTransport` and dropped Node <20 (we're on 24). Passkey
  registration + login + CGID flows need a manual pass by the maintainer before
  merge — flag this explicitly when presenting the PR.
  - Done 2026-08-04 (Fable directly), branch `chore/deps-wave15-webauthn`.
    server 13.3.2 / browser 13.3.0. The actual breaking surface (verified against
    the release notes and the installed sources):
    - v11 restructured `verifyRegistrationResponse().registrationInfo` —
      `credentialID`/`credentialPublicKey`/`counter` moved into
      `registrationInfo.credential` as `id`/`publicKey`/`counter` — and renamed
      `verifyAuthenticationResponse`'s `authenticator` option to `credential`
      (WebAuthnCredential shape). **Our own `passkeys.data` JSONB field names are
      unchanged — stored passkeys are not affected**, only the mapping in
      `srv/api/cgid.ts`.
    - v11 changed the browser signatures to `startRegistration({ optionsJSON })` /
      `startAuthentication({ optionsJSON, useBrowserAutofill })` (4 call sites).
    - v13 retired the types package — imports moved to `@simplewebauthn/server`
      (4 srv files) and `@simplewebauthn/browser` (`src/common/types/api/cgid.d.ts`).
      **Review catch**: that fifth file is ALSO an srv file (`srv/common` is a
      symlink into `src/common`, and srv's tsconfig includes it) — inside the
      container build there is no parent node_modules, `skipLibCheck` swallowed
      the unresolved import, and the passkey API types silently became `any` on
      exactly the migrated surface. Fixed by declaring `@simplewebauthn/browser`
      (zero-dep) in srv devDependencies, as the old types package deliberately was.
    - Only wire-format delta of the whole migration (review-measured, v10 vs v13
      side by side): v13's `generateRegistrationOptions` appends `hints: []` to
      the options JSON. Benign — WebIDL ignores unknown dictionary members, and
      an empty hints list is a no-op — but it does reach the browser and the
      stored `debugData`.
    - v13's `attestationType` change ('indirect' removed) doesn't touch us ('none').
    - `requireUserVerification` defaults verified **identical** (true) in v10.0.1
      and v13.3.2 sources — no silent auth-policy change.
    - CJS interop verified: srv compiles to CJS; `require('@simplewebauthn/server')`
      works on Node 24 (require-esm).
  - **Headless E2E of the full ceremony ran green** against the rebuilt dev stack
    (update_backend + update_frontend, both in-container gates green): puppeteer +
    CDP virtual authenticator (ctap2/internal, resident key, UV) driving the real
    CG ID app at `index_cgid.html#/` — registration (attestation verify + row
    stored), authentication (assertion verify + counter update persisted, which
    throws on failure), and a second authentication after the counter bump. Script:
    scratchpad `passkey-e2e.mjs` (session-temporary, not committed).
  - Audit: the `@simplewebauthn/types` deprecation moderate is gone from **both**
    workspaces (srv now 1 finding: puppeteer → 2a; root 5, all owned by 2c/3/4a/4d
    + truffle).
  - **Maintainer manual pass still wanted before merge** (the virtual authenticator
    can't cover real devices): passkey login with an existing real passkey
    (pre-migration row!), passkey creation from the main app's CGID popup flow
    (`/create/:frontendRequestId` + `postEventToOpenerWindow`), and a cross-device
    (hybrid transport) attempt.

## Wave 2 — independent majors (3 PRs)

- [x] **PR 2a (backend infra)** — branch `chore/deps-wave2a-backend-infra`,
  stacked on `chore/deps-wave15-webauthn`. **Audit: 1 moderate → 0 findings**
  (the puppeteer `<24.15.0` EOL notice was the last one left in `srv`; both
  workspaces' remaining findings now live only in the frontend, owned by
  2c/3/4a/4d).
  - [x] redis `^4.0.0` → `^6.2.0` **together with** connect-redis `^6.0.0` →
    `^10.0.0` (single commit — connect-redis 10 peer-requires `redis >=5` and
    the promise API)
    - **`legacyMode` is gone and `REDIS_LEGACY_MODE` is now ignored.** node-redis
      5 removed the `createClient({ legacyMode: true })` option (replaced by
      `client.legacy()` on an existing client, which we do not need), and
      connect-redis 10 talks to the promise API directly. The session client is
      an ordinary client now and the three callback branches in
      `RedisManager.get/set/del` are deleted. **Maintainer decision pending**:
      `REDIS_LEGACY_MODE=true` is still set in `docker/docker-compose.yml`
      (**api** at :119 and **cg-builder** at :324 — not wsapi, which never set
      it) and `docker/docker-compose.selfhost.yml` (:186, api); it is inert and
      can be dropped whenever convenient. `docs/realtime` and
      `docs/infrastructure` were corrected in this PR.
    - **New `srv/redis/client.ts` is the single `createClient` call site and
      pins `RESP: 2`.** node-redis 6 flipped the default protocol to RESP3
      (`DEFAULT_RESP = 3`). `@socket.io/redis-adapter` 8.3 — the newest release
      — is written against RESP2: it drives pub/sub through the v4
      `pSubscribe(pattern, listener, bufferMode)` API and reads `PUBSUB NUMSUB`
      positionally (`parseInt(reply[1])`), which redis.io documents as a *map*
      reply under RESP3. Measured against redis 6.2.7 (this stack) and redis
      8.10: both still answer with a flat array even on a RESP3 connection, so
      that hazard is latent rather than live — the pin stays anyway, so the
      upgrade is a client-library change and not also a protocol change.
      Adopting RESP3 is its own change with its own verification.
    - **API changes made** (verified against the v4→v5 and v5→v6 migration
      guides and the installed `.d.ts`, then against live redis):
      `multi().exec()` now returns `Array<ReplyUnion>` instead of the
      per-command types, so the four chains that index into their results use
      `execTyped()` (`util/rateLimit.ts`, `util/botRateLimit.ts`,
      `redis/userdata.ts` ×2, `api/plugins.ts`) — no logic restructured, the
      casts just disappear. `getUserData` builds its multi in place instead of
      reassigning (`q = q.hGetAll(k)` no longer type-checks now that the builder
      carries the accumulated reply tuple). SET flags moved from
      `{ NX, EX, PX }` to `{ condition, expiration }` (`util/captcha.ts` ×2,
      `api/plugins.ts`; the flat form still works but is deprecated). `zAdd`,
      `zRem`, `zCount`, `zRemRangeByScore`, `expire`, `incr`, `sAdd`, `sRem`,
      `sCard`, `sInter`, `hSet`, `hGetAll`, `get`/`set`/`del`, `ping`, `eval`,
      `duplicate()` and `publish`/`pSubscribe` all kept their signatures.
      Nothing in `srv/` uses `scan`, `quit()`/`disconnect()` or the removed
      `isolationPoolOptions`/`client.commandOptions()`, so the rest of the v5
      breakage does not apply.
    - **Two v6 behaviour changes worth knowing** (not acted on): commands now
      have a **default 5 s timeout** (`DEFAULT_COMMAND_TIMEOUT`; there was none
      in v4/v5), so a wedged Redis fails fast instead of hanging a request —
      arguably better, but it is a change; and `socket.keepAliveInitialDelay`
      defaults to 30 s instead of 5 s.
    - `yarn` warns that typeorm wants `redis ^3 || ^4 || ^5`. That peer is for
      TypeORM's optional Redis **query cache**, which this codebase does not use
      (`util/datasource.ts` sets no `cache` option) — inert.
    - **Sessions survive the upgrade.** connect-redis's default prefix is still
      `sess:` and the serializer is still `JSON`, unchanged from v6. Proven
      live: a session written by connect-redis 6 + legacyMode *before* the
      rebuild was read back by connect-redis 10 (same sid re-issued, `createdAt`
      preserved) and `touch()` refreshed its TTL.
  - [x] **drop `@types/connect-redis` + `@types/redis`**
    - Done with the redis commit. `@types/redis` was only reachable through
      `@types/connect-redis`'s dependency, so removing the latter removed both
      (`grep @types/redis yarn.lock` → 0). connect-redis 10 ships its own
      types (`dist/connect-redis.d.ts` / `.d.cts`).
  - [x] puppeteer `^22` → `^25.5.0`
    - **One code change**: puppeteer 23 changed every screenshot API from
      `Buffer` to `Uint8Array`, and `htmlToImage()` (`srv/api/util.ts`) feeds
      its result to sharp through `api/getRoutes.ts` (4 call sites) — wrapped in
      `Buffer.from()`. Nothing else in 23/24/25 touches this code: the
      `headless: 'new'` default and `page.waitForTimeout` were already gone in
      **22** (not part of this delta), and the cache directory has been
      `~/.cache/puppeteer` since 19. 23's `.npmrc`-config removal, per-browser
      env vars and `product`→`browser` rename, 24's Firefox-over-CDP removal and
      retired `PuppeteerLaunchOptions` types, and 25's removal of
      `Browser.isConnected()` / `MouseOptions.clickCount` / `Puppeteer.product`
      are all unused here.
    - **puppeteer 25 is ESM-only** (`"type": "module"`; the `require` export
      condition points at the ESM build — 22/23/24 were true dual builds). This
      backend compiles to CommonJS, so it now depends on Node's `require(ESM)`.
      Verified working on node 24.18 both standalone and in the built image, and
      `tsc` under `module: nodenext` accepts it. Worth remembering if the Node
      floor ever moves *down*.
    - **Dockerfile: no change needed, but two notes for the maintainer.**
      (1) The Debian package list in `docker/backend/Dockerfile` and
      `Dockerfile_dev_stage_0` is sufficient for Chrome 151 — no new system
      libraries. Cosmetic: `libgcc1` and `libasound2` are pre-bookworm names
      that only resolve via transitional packages; a future image refresh should
      use `libgcc-s1` / `libasound2t64`.
      (2) puppeteer 25 downloads **Chrome for Testing 151** instead of 127, so
      the postinstall payload grows from ~563 MB to ~651 MB (chrome
      328→389 MB, chrome-headless-shell 235→262 MB) — the image gets roughly
      90 MB bigger. Nothing to fix; the bare `yarn` in the image already puts
      it in `/root/.cache/puppeteer`, which is where puppeteer looks.
    - Verified with the production launch args (`--no-sandbox --no-zygote
      --single-process`): launch, `setContent`, element screenshot, sharp
      round-trip — on the host and inside the rebuilt `api` container.
    - Pre-existing, **not** fixed here (would change rendered output):
      `api/util.ts` calls `page.setViewport(...)` without awaiting it, right
      before taking the screenshot.
  - [x] jest `^29.4.0` → `^30.4.2` + `@types/jest` `^29` → `^30.0.0` +
    ts-jest pinned to `^29.4.12`
    - There is no ts-jest 30; 29.4.0 added `jest: ^30` to its peer range and
      29.4.12 was already the resolved version, so only the floor moved.
    - `jest.config.js` needed no change (wave 1 already pointed it at
      `.spec.(js|ts)`). None of jest 30's breaking changes apply: no removed
      matcher aliases in the suite, no `--testPathPattern` in any script, no
      deep imports into jest internals, `testEnvironment: 'node'` unchanged.
      The pre-existing ts-jest `TS151002` warning (hybrid module kind without
      `isolatedModules`) is unchanged — ts-jest's version did not move.
    - **Node floors of this whole PR**: redis 6 ≥20, connect-redis 10 ≥22,
      puppeteer 25 ≥22.12, jest 30 `^18.14 || ^20 || ^22 || >=24`. The image is
      node 24.18 — all satisfied, and `@tsconfig/node24` already encodes that.
  - [x] **regression test for the image-upload path** — `tests/saveImage.spec.ts`
    (7 tests), the thing the wave-0b `@aws-sdk` bump broke unnoticed. Mocks the
    S3 client and the pg pool and drives the real multer→sharp→PutObject code.
    The load-bearing assertion is `Buffer.isBuffer(input.Body)` — a Sharp
    instance or any `Readable` passes a naive truthiness check and only fails
    deep inside the SDK. Around it: key = sha256 of exactly the uploaded bytes,
    a real webp at the requested dimensions (resized and un-resized), bucket
    auto-creation ordering, the `files` row matching what was stored, and an
    oversized image rejected before S3 is touched.
    - Two mocks were unavoidable and are documented in the file:
      `repositories/users`/`communities` (they drag in the native `bcrypt`
      binding, which is only built inside the image) and `util/postgres`.
    - `repositories/files.ts` now imports sharp's option types **by name**
      instead of through the `sharp.*` namespace. That namespace only exists in
      sharp's CommonJS `export =` typings, which the build reaches via
      `moduleResolution: Node16` but ts-jest — compiling the suite as plain
      CommonJS — does not. Type-only change.
  - Verification gate: `npx tsc --noEmit` clean after every step;
    `./run.sh update_backend` green twice (after the redis step and at the end),
    stack healthy afterwards; `yarn tests` **20/20** (13 ipPrefix + 7 new)
    under jest 30. Live smokes against the running stack, all green:
    `getCommunityList` over nginx→api→pg with a session cookie issued *and*
    re-read through connect-redis 10 (including a pre-upgrade session, see
    above); the `ipRateLimitHandler` multi/zAdd/expire/zRemRangeByScore/zCount
    chain allowing 3 and rejecting the 4th request per /64 while creating the
    /56 and /48 buckets, and rejecting an unparseable `X-Forwarded-For` with
    `INVALID_REQUEST`; the `userdata` set/hash chains and `enforceBotRateLimit`;
    `PING`; and an end-to-end `@socket.io/redis-emitter` (api) → redis →
    `@socket.io/redis-adapter` (wsapi) → socket.io client broadcast, with the
    client also receiving `buildId` over a websocket upgrade. For puppeteer,
    `GET /c/<url>/image.jpeg` over nginx renders a real community social
    preview (512×268 progressive JPEG) through Chrome 151 → sharp. For the
    upload path, `POST /api/v2/File/uploadImage` over nginx stores a 110×110
    webp readable back out of seaweed.
  - Docs trued up in this PR: `docs/realtime` (RedisManager section),
    `docs/infrastructure` (`REDIS_LEGACY_MODE`, the `createClient` call site),
    `docs/architecture` (the four-client table's "why separate" column),
    `docs/auth-identity` (session store row) — status lines bumped.
  - Not verifiable headlessly (maintainer): a browser pass on login/session
    behaviour after the session-store swap, and a social-preview image
    (`/preview/...` GET routes) rendered by the new Chromium in a real browser
    context.
- [x] **PR 2b (cross-workspace small majors)** — branch
  `chore/deps-wave2b-small-majors`, stacked on `chore/deps-wave2a-backend-infra`.
  **Audit unchanged: srv 0 findings, root 5** (all moderate deprecation notices
  owned by later waves: @floating-ui/react-dom-interactions → 2c, @metamask/sdk
  → 3, react-beautiful-dnd → 4a, recharts → 4d, plus @truffle/hdwallet-provider).
  - [x] **ua-parser-js 1 → 2 in both workspaces**; `@types/ua-parser-js` dropped
    from both (v2 ships its own types).
    - API: v2 exports the parser as a **named** export (`export = UAParser`
      namespace), so all six call sites move to
      `import { UAParser } from 'ua-parser-js'`. The result shape (`browser` /
      `os` / `device` / `engine` / `cpu`) is unchanged, as is calling the module
      as a function.
    - **One real behaviour change, and it was a live bug**: v2 renames the
      mobile builds of the desktop browsers — Android Chrome now reports
      `"Mobile Chrome"` (Android Firefox `"Mobile Firefox"`, Chrome on iOS
      `"Mobile Chrome"`). `NotificationProvider.getCurrentPwaStatus()` compared
      `browser.name === "Chrome"`, so every Android Chrome user would have been
      sent to `Android_OpenWithChrome` instead of the PWA install prompt. It now
      accepts both spellings. Differential-tested over 11 real UA strings: the
      other diffs are `os.name` `"Mac OS"` → `"macOS"` and Linux losing its
      bogus `os.version` (`"x86_64"`), both of which only reach the display-only
      `deviceOS` string stored on `devices`. iOS/iPadOS Safari, Samsung
      Internet, desktop Chrome/Edge/Firefox and every `device.type` are
      identical.
    - The `vendor-shared` chunk assignment still holds (package name unchanged)
      and `cg:assert-cgid-entry-chunks` passes. **The bundle now carries two
      copies** (2.0.10 direct + 1.0.41 nested under RainbowKit 1.3, which pins
      `^1.0.37`); `packageNameOf` uses `lastIndexOf`, so both land in
      `vendor-shared` (100.06 kB). **Wave 3's RainbowKit 2 bump should collapse
      it — re-check there.**
    - Note: `src/hooks/useUserAgent.ts` has **no callers**. Left in place, but
      it is a dead-code candidate (same class as the `MessageDatabase` finding
      in 1b).
  - [x] **short-uuid 4 → 6** in both workspaces — 17 call sites.
    - Two breaking changes: the **callable default export is gone**
      (`shortUUID()` → `createTranslator()`, all 17 files) and
      `translator.new()` was removed in favour of `.generate()` (2 sites,
      `MediaPickerDropdown` + `EmbedModal`).
    - **No URL breakage**: the default alphabet is still flickrBase58 and
      `maxLength` still 22. Differential-tested v4.2.2 vs v6.0.3 over 20 000
      random UUIDs — **0 `fromUUID` mismatches**, both directions of `toUUID`
      round-trip, and the malformed-input behaviour is byte-identical
      (same throw for non-alphabet characters, same all-zero UUID for `""`,
      same padded results for short strings). Every existing article/chat/call/
      user short link keeps resolving.
  - [x] **open-graph-scraper 5.2.3 → 6.12.0** (exact pin kept) — one call site,
    `getUrlPreview` in `srv/api/messages.ts`.
    - The option *renames* (the `got` → `fetch` switch, `headers`/`retry`/
      `followAllRedirects` folded into `fetchOptions`) don't apply — but
      **`downloadLimit`'s removal did, and this note originally got that wrong**
      (interim review, 2026-08-04). v5 defaulted to a 1 MB cap that we inherited
      by passing only `{ url }`; v6 has no equivalent and buffers the entire
      body — then runs cheerio over it — *before* checking the content type.
      The reviewer reproduced an OOM process kill through this route, which is
      unauthenticated and takes a caller-supplied URL. **Fixed**: the route now
      fetches the page itself through the shared axios instance with
      `maxContentLength` 1 MB, a content-type check, a 10 s timeout and
      `maxRedirects: 5`, then hands the HTML to `ogs({ html })`. Since ogs
      rejects `html` together with `url`, relative `og:image` URLs are resolved
      against the final (post-redirect) URL in the route.
      The wider SSRF surface of this endpoint is pre-existing and out of scope —
      tracked privately, not in `docs/`.
    - v6 normalises `ogImage` to `ImageObject[]`; the `string` and
      single-object branches are removed.
    - **Error semantics are unchanged and were already surprising**: v5 *and*
      v6 both **reject** with a plain `{error, result, response}` object rather
      than resolving with `error: true`, so the `if (metadataResult.error)`
      guard has always been unreachable for real failures. Left as-is
      (defensive, and fixing the error mapping is not a dependency change) —
      worth a look if the URL-preview error response ever needs to be
      `INVALID_REQUEST` rather than `UNKNOWN`.
  - [x] **node-cron 3 → 4** (not skipped — there is no churn to speak of) +
    **drop `@types/node-cron`** (v4 ships its own).
    - One call site, `cron.schedule(expression, fn)` in `srv/jobs.ts`, whose
      signature is unchanged; `schedule()` still starts the task immediately
      (v4's `createTask()` is the non-starting variant). All four cron
      expressions still validate, and a smoke run fired 3 times in 2.5 s on a
      per-second pattern. Node floor ≥20 (image is 24).
  - [x] **mime-types: dropped, not bumped.** `mime-types` + `@types/mime-types`
    were dependencies with **zero importers** — grepping every tracked file in
    `srv/` for `mime` finds only `mimeType` string literals (mediasoup codec
    config, sharp output metadata, message image records).
  - [x] **reflect-metadata `^0.1.13` → `^0.2.2`** (srv).
    - **Runtime dedupe achieved, lockfile dedupe not quite.** The hoisted copy
      is now 0.2.2 — the version typeorm 0.3.31 and @simplewebauthn/server 13
      (via @peculiar/x509 → tsyringe) were already nesting next to the old
      0.1.14 — so the backend loads exactly one copy where it used to load two.
      Verified in the built image: `find` shows 0.2.2 hoisted and 0.1.14 **only**
      under `typeorm-extension/node_modules`, `emitDecoratorMetadata` still
      resolves (`design:type` on `UserAccount.userId/type/displayName`), and
      typeorm's metadata storage registers all **37 tables / 325 columns**.
    - The last `^0.1.13` consumer is **`typeorm-extension` 2.8.1**, a
      devDependency imported only by `tests/testhelper.ts` — which has no
      importers of its own (it is the scaffolding of the `accounts.spec.ts`
      wave 1a deleted). Nothing loads it, but the Dockerfile's bare `yarn`
      installs devDependencies, so the copy is physically in the image. Two
      ways to collapse it, neither taken here: **(a)** drop `typeorm-extension`
      and delete `tests/testhelper.ts` + `tests/datasource.ts` (a closed,
      unreferenced island from the initial commit) — clean, but it removes
      DB-test scaffolding a future backend suite might want; **(b)** bump
      `typeorm-extension` to 3.9.0, which does depend on reflect-metadata
      ^0.2.2 — but 3.x adds a **required** `@faker-js/faker >=8.4.1` peer we do
      not have (no `peerDependenciesMeta`), which is a lot of tree for dead
      code. There is no 2.x on reflect-metadata 0.2, and even 3.0.0 still pins
      0.1.13. **Maintainer decision.**
    - No deep imports of `reflect-metadata/*` anywhere, so v0.2's new `exports`
      map (which blocks `require('reflect-metadata/package.json')`) is inert.
  - [x] **altcha 2.3.0 → 3.2.1 + altcha-lib 1.4.1 → 2.3.2 as a pair** — see the
    commit message for the full API delta. The headline: **altcha 3 speaks only
    ALTCHA's v2 proof of work** (a PBKDF2 key search instead of v1's
    "hash the salt with every number up to `maxNumber`"), confirmed by reading
    the widget bundle — there is no `maxnumber`/`challengeurl` left in it. The
    server therefore had to move to altcha-lib's v2 API in the same change.
    - **altcha-lib 2 ships a CommonJS build**, so the untyped
      `import("altcha-lib")` shim v1 forced on us is gone: `createChallenge`,
      `verifySolution`, `randomInt` and `deriveKey`
      (`altcha-lib/algorithms/pbkdf2`) are static, typed imports that compile
      and `require()` cleanly from the CJS backend.
    - v2 needs **two** HMAC secrets (challenge signature + derived-key
      signature). Both are derived from the single configured secret with
      `HMAC(master, "altcha:v2:<label>")`, so `ALTCHA_HMAC_KEY` / the
      `altcha_hmac_key` docker secret / the Redis-shared fallback all keep
      working unchanged, without reusing one key for two purposes.
    - Payload shape changed from a flat object with a `challenge` **string** to
      `{challenge: {parameters, signature}, solution: {counter, derivedKey,
      time}}`; it is decoded and shape-checked before verification.
      **Replay protection now keys on the challenge signature** (an HMAC over
      parameters carrying a random nonce and salt, verified before it is used
      as a key) instead of v1's challenge hash.
    - **`ALTCHA_MAX_NUMBER` is retired** — it has no v2 equivalent, and silently
      ignoring it would leave an operator believing the captcha is harder than
      it is, so it logs a warning when set. Difficulty is now `ALTCHA_COST`
      (PBKDF2 iterations per attempt, default 5000) × `ALTCHA_COUNTER_MAX`
      (default 4000; the answer is drawn per challenge from `[max/2, max]`).
      `docs/auth-identity` §6 trued up, status line bumped. **No compose
      change was needed** — neither compose file ever set `ALTCHA_MAX_NUMBER`
      (and neither sets the two new knobs either, which is now stated in both
      `docs/auth-identity` and the `docs/infrastructure` env table).
      Interim-review fix: the `randomInt` arguments were swapped —
      altcha-lib's signature is `randomInt(max, min = 1)`, so the call read
      `max=2000, min=4000`. It happened to produce nearly the intended interval
      (measured 2001–3999 instead of 2000–4000), but it was wrong API use.
    - **The defaults are measured.** Driving the real widget in headless Chrome
      (16 cores): ~0.44 ms per counter step at cost 5000. altcha-lib's own
      suggested range (counter 5000–10000) measured **2.7 s and 4.2 s** — a
      visible regression against the ~1 s v1 was tuned for, and multiples of
      that on a phone. `ALTCHA_COUNTER_MAX = 4000` measures **1.0 s**
      (programmatic) / **1.5 s** (checkbox path, which includes the widget's
      500 ms `minDuration` floor and the challenge fetch). Even so it is ~15M
      PBKDF2/SHA-256 iterations expected against v1's ~250k bare SHA-256 —
      **more** proof of work than before, at the old UX.
    - Frontend: `challengeurl` → `challenge` (v3 merged `challengeurl` and
      `challengejson`). The `statechange` event still dispatches
      `{state, payload}`, so `AltchaWidget`'s contract with `CaptchaModal` and
      `SetupProfile` is untouched, and no CSS overrides exist to break. The
      `altcha-widget-element` alias + stub `.d.ts` stay: v3 moved the
      `react/jsx-runtime` augmentation out of the default types entry into
      `altcha/types/react`, so the hazard is narrower, but the alias is what
      keeps it out for good.
    - **PoW flow tested end to end against the running stack**, not simulated:
      a challenge from the real compiled `createCaptchaChallenge()` inside the
      `api` container → served to a real altcha 3 widget in headless Chrome →
      solved (both the programmatic `verify()` and the real checkbox click) →
      the widget's payload handed back to the real `verifyCaptchaToken()` in
      the container, against the real Redis. **Accepted exactly once.** The
      rejection matrix is green too: replay, tampered `derivedKey`, tampered
      challenge signature, lowered `cost`, expired challenge, the widget's
      `test: true` payload, a v1-shaped payload (stale widget → fails closed)
      and garbage/empty tokens.
    - **Not covered headlessly (maintainer)**: the dev stack has a reCAPTCHA
      secret configured, so `CAPTCHA_PROVIDER` resolves to `recaptcha` there and
      `GET /Captcha/challenge` 404s — the HTTP route was exercised by shape
      (`api/captcha.ts` only JSON-serialises `createCaptchaChallenge()`), not
      over nginx. Wanted on an ALTCHA instance: the registration form
      (`SetupProfile`) and the trust-score `CaptchaModal` in a real browser,
      including the v3 widget's **refactored CSS** in light and dark mode and on
      a phone, and a low-end-mobile solve time sanity check.
  - [x] **@hapi/tlds 1 → 2: SKIPPED**, deliberately, in both workspaces.
    - 2.0.0 is **ESM-only** (`"type": "module"`, `exports: {".":
      "./dist/index.mjs"}` — the v1 dual CJS/ESM build is gone) and requires
      Node ≥22. It also **ships a broken `types` field**: it points at
      `./dist/index.d.ts`, and the tarball contains `index.d.mts`.
    - srv would actually survive it: TS 5.9 under `nodenext` allows
      `require(ESM)` and Node 24 executes it — verified, `tsc --noEmit` clean
      and `require('@hapi/tlds')` returns the set. **The root workspace does
      not**: `tsconfig.json` sets `moduleResolution: "node"` (node10), which
      reads `main`/`types` rather than `exports`, so
      `src/common/validators.ts` fails with TS2307. Fixing that means changing
      the frontend's module resolution wholesale — far outside a dependency
      bump — and splitting the two workspaces across majors is worse, since
      `srv/common` is a symlink into `src/common`.
    - **Zero payoff either way**: the data is identical. v1.1.7 and v2.0.0 both
      expose a 1437-entry lowercase `Set`, with the same first entries.
      Revisit when the frontend moves to `moduleResolution: bundler`.
  - Verification gate: root `yarn typecheck && yarn lint && yarn test &&
    yarn build && yarn check:html-rewrite` green after every step (0 errors,
    the unchanged 645 pre-existing warnings, 4/4 tests); srv `npx tsc --noEmit`
    clean after every step and `yarn tests` **20/20**;
    `./run.sh update_backend` green three times (after reflect-metadata, after
    the altcha rewrite, and with the tuned difficulty defaults), stack healthy
    each time. Live smokes: `getCommunityList` over nginx (joi still rejects a
    bad body), typeorm entity metadata inside the image, and the full ALTCHA
    PoW round trip above.
- [x] **PR 2c (frontend, service worker)** — branch `chore/deps-wave2c-frontend-sw`,
  stacked on `chore/deps-wave2b-small-majors`. **Audit: root 5 moderate → 4**
  (the `@floating-ui/react-dom-interactions` deprecation is gone; `@metamask/sdk`
  → 3, `@truffle/hdwallet-provider`, react-beautiful-dnd → 4a, recharts → 4d
  remain). `srv` untouched, still 0 findings. Nothing was skipped.
  - [x] **workbox `6.5.4` → `7.4.1`** (precaching + routing in `dependencies`,
    build in `devDependencies`, exact pins kept).
    - **workbox 7 is a dependency refresh, not an API change.** `workbox-precaching`
      and `workbox-routing` are byte-identical between 6.5.4 and 7.4.1 apart from
      their `_version.ts` marker (diffed the published `src/` trees), and
      `PrecacheController.d.ts` is identical, so `addToCacheList` / `install` /
      `activate` / `createHandlerBoundToURL` in `src/service-worker.ts` are
      untouched. The only real runtime delta in the whole subtree is
      `workbox-strategies`' `StrategyHandler.doneWaiting()`, which now drains its
      extend-lifetime promises with `Promise.allSettled` and rethrows the first
      rejection instead of awaiting them one by one — a bugfix.
    - **No `injectManifest` option was renamed.** The `workbox-build` option
      schema changes are exactly two: `globStrict` removed (unused) and `wasm`
      added to the *default* `globPatterns` (we pass our own). `swSrc`/`swDest`/
      `globDirectory`/`globPatterns`/`globIgnores`/`modifyURLPrefix`/
      `dontCacheBustURLsMatching`/`maximumFileSizeToCacheInBytes`/
      `manifestTransforms` all survive, and `lib/transform-manifest.js` still runs
      user transforms last — which is the assumption `vite/serviceWorker.ts`
      relies on to capture the manifest for `assertPrecacheCoversAllCode`.
      v7 raises the Node floor to 16 (image is 24) and switched workbox-build's
      own toolchain to rollup 4 / eta.
    - `workbox-google-analytics` is deprecated but still published at 7.4.1 and
      still arrives transitively via workbox-build's `generateSW` templates.
      Nothing imports it; we only call `injectManifest`.
    - **Precache manifest before/after the bump: identical** — 87 entries,
      11,914,178 bytes, same URLs, same sizes, same revisions.
      `service-worker.js` itself grew 91,636 → 91,751 bytes.
  - [x] **`@floating-ui/react-dom-interactions` 0.10.3 → `@floating-ui/react`
    0.27.20.** Landed on the current version rather than the 0.19 rename: the
    whole delta was 14 type errors in three files, and 0.19 would only have
    deferred the same work into wave 4 (0.27 is the React-19-ready line).
    Seven of the ten call sites only import `FloatingDelayGroup` or `Placement`.
    - `useFloating().reference`/`.floating` are gone → `refs.setReference` /
      `refs.setFloating`, moved out of `getReferenceProps({ref})` onto the
      element. `refs.setReference` still registers the DOM reference, so the
      `handleClose` predicates and Message's touch/reply gesture code keep
      reading `refs.reference.current`.
    - `useDelayGroup(context, {id})` is no longer an `useInteractions` entry; it
      returns the group context and replaces the deprecated
      `useDelayGroupContext`, and it publishes `currentId` itself (layout effect
      on `open`) where the old hook left that to the caller. The manual
      `setCurrentId` calls are therefore removed — and in `UserProfilePopover`
      the `withDelayGroup` gate had to move onto `enabled`, or a popover that
      never opted in would start claiming the group.
    - `handleClose` is typed `HandleClose` now: only the event type changes
      (`PointerEvent` → `MouseEvent`); `__options.blockPointerEvents` still fits
      (`SafePolygonOptions`) and `HandleCloseContext extends FloatingContext`.
    - **Two latent bugs fell out and are fixed, not papered over.** (1)
      `whileElementsMounted` must return autoUpdate's teardown — the old types
      allowed `void` and the code returned nothing, so the `animationFrame: true`
      autoUpdate loop was **never torn down**: one permanent rAF loop per
      tooltip/popover ever mounted, in both `Tooltip` and `UserProfilePopover`.
      (2) `x`/`y` no longer start as `null` (they start at 0; `isPositioned`
      carries that state), so `visibility: x === null ? 'hidden' : 'visible'`
      would have degenerated to a constant `'visible'` and flashed the floating
      element at the viewport origin. All three files key off `isPositioned` now.
    - Dead code found while migrating: `Message.onOpenChange`'s `currentId`
      branch — both arms only called `setMessageIsHovered(false)` and nothing
      ever assigned `delayedCloseTimeoutRef.current`. Collapsed; the ref deleted.
  - [x] **web-vitals 1.1.2 → 6.0.1** — v3 renamed the getters (`getCLS` →
    `onCLS`) and retired `ReportHandler` for `(metric: Metric) => void`; v5
    dropped FID, so `src/reportWebVitals.ts` reports INP instead. Note for later:
    `src/index.tsx` calls `module.default()` with **no handler and only in dev**,
    so the module has been inert all along — a dead-code candidate (same class as
    the `MessageDatabase` and `useUserAgent` findings in 1b/2b).
  - [x] **emojilib: dropped, not bumped** — zero importers (`git grep` over every
    tracked file hits only `package.json`/`yarn.lock`). The emoji data actually in
    use comes from `@emoji-mart/data` + `emoji-picker-react`. Same class as the
    `mime-types` removal in 2b.
  - [x] **boring-avatars 1.7 → 2.0.4** — the risk was silently regenerating every
    default avatar in the product, and it does not happen: diffing the two builds,
    the `marble` generator is the same function with the literals `8`/`4` replaced
    by `size/10` and `size/20` over the unchanged `size = 80`, the element count is
    still 3, and the emitted SVG (mask `rx` 160, both blurred paths, the
    `feGaussianBlur` filter) is character-identical. `export default Avatar`
    survives; the major is the react `>=18` peer bump.
  - [x] **yet-another-react-lightbox 2.6 → 3.32.2** — one call site. The only
    breaking change that reaches us is `carousel.padding`, narrowed from a CSS
    shorthand to a single `LengthOrPercentage`, so the desktop `'2% 5%'` collapses
    to **`'2%'`**: CSS percentage padding resolves against container *width*, so
    keeping `'5%'` would have turned a ~38px top/bottom gutter on a 1920px
    viewport into ~96px and shrunk the image; `'2%'` only widens it horizontally.
    **Worth a maintainer eyeball.** Everything else passes through unchanged, and
    all four `yarl__` hooks `FullscreenImageModal.css` overrides still exist in v3.
  - [x] **react-dropzone 14.2 → 20.0.0** — one call site (`EditField`).
    `rootRef`, `getRootProps`/`getInputProps`, `isDragActive`, `onDrop` and
    `noClick` survive all six majors; `useFsAccessApi` is irrelevant because
    nothing opens the picker. **The one real hazard is new: paste-to-upload is on
    by default** and hangs off `getRootProps`, so a screenshot pasted into the
    Slate `<Editable>` inside the dropzone root would have been attached twice —
    once by `handlePaste`, once by the bubbled dropzone handler. Fixed with
    `noPaste: true`. Node floor ≥22 (image is 24).
  - [x] **@giphy/react-components 9.2 → 10.1.2** (+ `@giphy/js-fetch-api` 5.3 →
    5.8) — a pure peer-range major. Every `.d.ts` under `dist/` is byte-identical
    between 9.8.0 and 10.1.2 apart from doc comments and import order; the peer
    range moves react `16.10.2 - 18` → `18 - 19`. `@giphy/js-types` stays 5.1.0.
  - Gate: `yarn typecheck && yarn lint && yarn test && yarn build &&
    yarn check:html-rewrite` green after every step — 0 lint errors, the unchanged
    645 pre-existing warnings, 4/4 tests.
  - **Precache manifest across the whole PR**: 87 entries / 11,914,178 bytes →
    87 / 11,890,320 bytes (−23,858 B, −0.2%); the URL set is identical once
    content hashes are normalised. Bundle (raw JS, no sourcemaps):
    **10,901,315 → 10,876,874 bytes (−24,441 B, −0.22%)** over the same 54 chunks;
    `App.chunk.js` −36 KB carries it (floating-ui 0.27 and boring-avatars 2 are
    both smaller than what they replace). `vendor-web3` is untouched.
  - **Headless smoke through nginx** (`./run.sh update_frontend` into the running
    stack, puppeteer over `https://localhost:8001`): the service worker registers
    and reaches `activated`, `navigator.serviceWorker.ready` resolves, and the
    `workbox-precache-v2` cache holds **97 entries** — exactly the 87 manifest
    entries plus the 10 hand-pushed URLs (4 fonts, 4 call sounds, 2
    cross-origin-isolation shells). The app shell renders with **zero
    `pageerror`s**; the console errors that remain are pre-existing dev-stack
    artefacts (CSP blocking an inline script and the `http://localhost:8000`
    signed image URLs on an `https://localhost:8001` page). A second pass drove
    the migrated `Popover`: hovering a trigger portals a `.tooltip.tooltip-simple`
    into `#tooltip-root`, positioned (top 483px / left 585px, not 0,0) and
    `visibility: visible` — i.e. `refs.setReference`, `refs.setFloating`,
    `useHover` and `isPositioned` all behave in the real bundle.
  - **Not verifiable headlessly (maintainer)** — the standing wave-2 flag plus
    what this PR added:
    - **push notifications end to end** and the **PWA update flow**
      (`SKIP_WAITING` → `activate` → the `reload` broadcast → new worker serving
      the new precache), on a real installed PWA. The precache manifest is proven
      identical, but the install/update ceremony is not something a fresh headless
      profile exercises.
    - **hover UX** after the floating-ui major, in a browser: message hover
      toolbar (incl. the delay group on a long message list), user popovers,
      dropdowns, the emoji-picker tooltip, and the `mouseleave*` close modes —
      the synthetic-hover smoke proves positioning, not feel.
    - **image lightbox framing on desktop** after the `'2% 5%'` → `'2%'` padding
      collapse.
    - **paste-a-screenshot into the composer** (that `noPaste: true` really does
      leave exactly one attachment) and drag & drop onto the message field.

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
