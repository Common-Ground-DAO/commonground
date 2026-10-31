# TODO — open one-off tasks

> Standalone open tasks that are too small for a workstream of their own. When an entry
> grows into real, multi-step work, it graduates into its own `ROADMAP_<topic>.md` and
> leaves this list. Working state, not documentation of record.

## Operational (time-critical)

- [ ] **Confirm the maintainer's selfhost/reference instances have run the SeaweedFS
  volume cutover** (2026-08-03, storage close-out) — the procedure and
  `docker/selfhost/migrate_seaweed_volumes.sh` are documented in `docker/SELFHOST.md`;
  what is untracked is whether the maintainer's own instances have executed it. Confirm
  once, then strike.
- [ ] **Manual browser pass for the 2026-08 dependency waves and the image filter is
  unconfirmed** (2026-10-31, carried over when `ROADMAP_dependency-updates.md` and
  `ROADMAP_IMAGE_FILTER.md` were dissolved). Everything below was verified headlessly
  (API smokes, puppeteer suites, pixel/byte diffs) but needs a real browser/device,
  and neither roadmap recorded it as done. Natural home: the browser passes of the
  major-version waves in `ROADMAP_cg-box.md` (P2) on the test VM. Confirm once, then
  strike:
  - auth: passkey login with a pre-migration passkey, passkey creation via the CG ID
    popup, a cross-device (hybrid) attempt; every wallet login (MetaMask,
    WalletConnect, Coinbase, Lukso UP), the deprecated mnemonic login, Farcaster;
    the ALTCHA v3 widget on an ALTCHA-configured instance (light/dark, phone solve
    time — overlaps the captcha manual-pass item under "Optional");
  - web3: PaySpark end to end on a real chain (network switch, "not enough funds"),
    staking approve → stake → unstake incl. the balance refresh, token-rule editor;
  - UI after React 19 / floating-ui / motion / dnd-kit / slate 0.126: general smoke,
    hover toolbar + popovers, Giphy picker layout, multi-image lightbox while
    resizing, bottom-sheet variants and swipe feel on a phone, drag & drop on touch
    and with a screen reader, editor marks/links/images/mentions/paste/edit on
    desktop **and** mobile (IME), composer paste-a-screenshot (exactly one
    attachment) and spacing;
  - PWA install/update cycle and push notifications;
  - calls after the mediasoup 3.14 → 3.23 jump (validated so far by code review and
    local builds only — the call subsystem has no automated tests): a real two-peer
    call covering join, produce, consume, broadcast mode, promote/demote, moderation
    mute, reconnect and leave, **plus** confirming that the ICE candidates carry the
    expected announced address after the `listenIps` → `listenInfos` migration —
    on the test VM and again on the cg.box server (new public IP);
  - image filter client side across upload types (incl. Slate paste/drop and chat
    attachments) and on a low-end device; a spot check of the server gate with
    real material.

## Superseded by ROADMAP_cg-box.md (hosted Swarm retired)

The hosted `app.cg` Docker Swarm stack gets no further rollouts; the hosted instance
moves to a single self-host server (`ROADMAP_cg-box.md`). These items only concerned
that stack — confirm and delete:

- Staging verification of the mediasoup 3.14 → 3.23 jump on the Swarm
  `mediasoup_staging` inventory (the two-peer call checklist itself, incl. the
  announced-address check, carries over to the test VM and cg.box — see the
  manual-pass item above).
- Cutting the Swarm stack over to the single `redis` service (or `REDIS_URL`).
- Pinning SeaweedFS in the Swarm stack files and collapsing its three seaweed services.

## Maintainer decisions needed

- [ ] **Move `contracts/` to its own repository / submodule?** (2026-08-04, raised by
  the maintainer during dependency-update planning) — contracts are not needed for
  selfhosting, no new on-chain work is planned, and extracting them would take the
  Hardhat/Truffle toolchain (and its audit surface) out of the main repo. Decide, and
  if yes, plan the extraction (keep `contracts/staking` Foundry setup intact; the
  backend only consumes ABIs).
- [ ] **Premium purchases on self-hosted instances** — the Spark purchase flow (`PaySpark`)
  sends to Common Ground's own beneficiary addresses hardcoded in
  `src/common/premiumConfig.ts`, and purchases are only credited by the onchain listener.
  Every self-hosted instance therefore takes payments for CG wallets, regardless of the
  `CG_ENABLE_BLOCKCHAIN` toggle. Decide: hide the premium purchase flow on non-official
  instances entirely, make the beneficiaries configurable, or leave as is.
- [ ] **Publish the reference client (`@commonground/client`) to npm, and under which
  license?** (2026-08-06, reference-client workstream) — recommendation and
  pre-publish checklist in `sdk/PACKAGING.md`: publish under a Common Ground npm
  scope, consider a permissive license for the SDK package alone (needs the copyright
  holders' decision; do not publish before it is settled), keep
  `@commonground/conformance` private. Positioning it as the official bot SDK waits on
  finding F-11 (below).

## Cleanup candidates (small, self-contained)

- [ ] **`imageFilterThreshold` breaks the `r0-instance-config` conformance test**
  (2026-10-31, found during the Node 26 conformance run; 102 of 104 tests pass).
  `/api/v2/Instance/config` always sends `imageFilterThreshold`
  (`srv/util/instanceConfig.ts`), the nginx injection
  (`docker/nginx/inject-instance-config.sh`) only adds it when
  `CG_IMAGE_FILTER_THRESHOLD` is set, and the SDK's `InstanceConfig` mirror
  (`sdk/conformance/src/r0-instance-config.test.ts` allowlist, SDK type) does not
  list it. Add the field to the SDK mirror and make the two sources agree on when
  it is present.

- [ ] **Community creation copies a welcome article that only exists on app.cg**
  (2026-10-31, seen on the self-host test instance): every community creation
  logs `null value in column "articleId" of relation
  "communities_articles_roles_permissions"` — `config.COMMUNITY_CREATION_ARTICLE_PROD`
  is an app.cg article id. The error is caught and creation continues. Make the
  template article configurable per instance or skip the step when it is absent.

- [ ] **`onchain` uses 1–2 GB RSS on a small self-host instance** (2026-10-31,
  test VM) — the main reason a frontend build OOMs next to the running stack
  (see `docker/SELFHOST.md`, "Memory for builds"). Profile and cap it.

- [ ] **`contracts/contracts/TokenSale.sol` + its deploy script** — kept in Phase 2 as the
  record of the sale that ran; decide whether git history is record enough.
- [ ] **`role_gated_files` + `GET /gated-videos/:filename` / `GET /gated-files/:filename`**
  — their only content producers were the wizard data-room elements removed in Phase 2;
  the table has no create path in code. Removal candidate.
- [ ] **Passkey ceremony foot-guns in the CGID flow** (2026-08-04, found in the
  wave-1.5 dependency review; pre-existing, unchanged by the simplewebauthn 13
  migration): (a) `srv/validators/api/cgid.ts` requires `authenticatorAttachment`
  in both verify-response schemas although the WebAuthn spec makes it optional and
  `@simplewebauthn/browser` emits `undefined` for unknown values — an authenticator
  that omits it fails the whole ceremony at the Joi layer; make it `.optional()`.
  (b) `src/cgid/home.tsx` calls `startRegistration`/`startAuthentication` outside
  its `try`, so a user cancel becomes an unhandled rejection (login.tsx and
  createPasskey.tsx do it correctly inside). Relevant to `ROADMAP_cg-box.md` G4
  (passkey ceremonies move to the main origin).
- [ ] **The legacy MetaMask connect path lost its no-extension flow** (2026-08-04,
  dependency-update wave-3 review) — `signatureHelper.connectMetamask()` (reached
  from `WalletsEditor/WalletSelectModal`, i.e. "Add wallet → MetaMask") used to
  instantiate `@metamask/sdk`, which, when `window.ethereum` was **absent**,
  injected its own provider and ran the install-modal / mobile deep-link flow.
  That dependency was 0.1.0 (deprecated, superseded by MetaMask Connect) and is
  dropped; on a mobile browser without the extension the path now throws
  "Please install MetaMask!". **Decided 2026-08-04: route this button through
  RainbowKit's own `metaMaskWallet` connector** (which does mobile deep-linking) —
  do not revive `@metamask/sdk`. Own small PR, not part of a dependency wave.
- [ ] **`signatureHelper.metamaskSignData` and `recoverSigner` have no callers**
  (2026-08-04, dependency-update wave-3 review) — with them, the
  `@metamask/eth-sig-util` dependency is unreachable too. Verify and delete.
- [ ] **`TokenRuleEditor` silently rounds over-precise token amounts**
  (2026-08-04, dependency-update wave-3 review) — its guard regex allows
  unbounded decimals, and viem's `parseUnits` rounds half-up where ethers 5 threw
  `fractional component exceeds decimals` (which the `catch` turned into "no
  rule"). So `1.5555555` on a 6-decimal token now becomes `1.555556` instead of
  being rejected. Bound the decimals in the regex, or reject explicitly.
- [ ] **`@giphy/js-types` is a phantom dependency** (2026-08-04, dependency-update
  wave-2 review) — imported directly by `MessageAttachments.tsx`, `GiphyPicker.tsx`
  and `useAttachments.tsx`, declared in no `package.json`; it only resolves because
  two `@giphy` packages depend on it as `"*"`, and it silently moved 5.0.0 → 5.1.0
  during the wave. Declare it explicitly.
- [ ] **`srv/tsconfig.json`'s `include` does not cover `tests/`** (2026-08-04,
  dependency-update wave-2 review) — so `npx tsc --noEmit`, the backend's typecheck
  gate, never checks the spec files; only ts-jest does, at test time. Add `tests/*.ts`.
- [ ] **Drop the `@types/react-router-dom` devDep** (2026-08-04, dependency-update
  wave 0a) — it is the v5 types package, while the app runs react-router-dom v6, which
  ships its own types. Typecheck passes with it installed today, but it is vestigial
  and one `@types/history` drift away from conflicting. One-line cleanup.
- [ ] **Delete `public/images/tokensale_header.png`** (891 KB, 2026-08-03, Vite workstream)
  — nothing references it; `src/views/TokenSale/TokenSale.tsx:106` uses the `.webp`. It
  ships in every build. (`public/images/tokensale_social_preview.png` **is** used, by
  `srv/api/getRoutes.ts` — do not delete that one.) Belongs to the token-sale removal.
- [ ] **Prune what is left of the CG ID vhost's cross-origin allowances** (2026-08-03,
  Vite workstream) — `8f90fc2b4` removed the main-origin entries that the CRA
  `PUBLIC_URL` layout needed, but two allowances of the same vintage are still there:
  `https://analytics.{prod,staging}.app.cg` in the CG ID `script-src-elem`/`connect-src`
  (`docker/nginx/nginx.conf:100-101`), although Matomo is injected only by `src/index.tsx`
  — the *main* entry — and never by the CG ID mini-app; and the `$cg_allow_origin` ACAO
  rule on the main vhost (`nginx.conf:110`, `nginx_selfhost.conf:77`), which exists for
  asset loads from the CG ID origin that are same-origin since the cutover. Both are
  widenings, not breakage. Needs the same built-image check the CSP prune had.
  Natural point: the nginx → Caddy rewrite (`ROADMAP_cg-box.md` F5), which drops the
  CG ID vhost on cg.box but keeps it for the gateway's `id.app.cg`.
- [ ] **`docker/updateFrontend.sh` does not refresh `docker/backend/dist/index.html`**
  (2026-08-03) — after `./run.sh update_frontend` the API keeps serving the *previous*
  build's shell (pointing at hashed assets that no longer exist) on every deep-link/share
  route until `update_backend` runs. Pre-existing, not caused by the Vite cutover; either
  copy `build/index.html` there like `build.sh` does, or document the pairing.
- [ ] **Narrow the blanket ESLint exclusion of `srv/**`** (2026-08-03, Node 24 /
  mediasoup workstream) — `eslint.config.mjs:51` excludes the entire backend;
  `srv/mediasoup/**` was cleaned up in the mediasoup 3.23 package and could be covered
  now.
- [ ] **Re-enabling a disabled bot is not implemented** (bot-accounts close-out) —
  `srv/api/bots.ts` exposes `/disable` (`botHelper.disableBot`) with no enable/restore
  counterpart, so a disable is terminal for the bot identity. The workstream deferred
  re-enabling rather than deciding against it. Decide: either it is intended (then say
  so in [docs/bots](../bots/README.md)) or add the endpoint with the matching lifecycle
  bookkeeping (tokens, memberships, presence reconciliation).
- [ ] **Trim the failed-captcha error log in `srv/api/user.ts`** (2026-08-03, captcha
  close-out) — on failed verification the handler logs the raw request context wholesale;
  reduce it to a minimal, payload-free message.
- [ ] **`AltchaWidget` re-registers its `statechange` listener on every render**
  (2026-08-03, captcha close-out) — the effect in
  `src/components/molecules/AltchaWidget/AltchaWidget.tsx:26-42` depends on
  `[onVerified, onReset]`, and both call sites pass inline arrows
  (`src/components/molecules/CaptchaModal/CaptchaModal.tsx:59`,
  `src/components/organisms/UserOnboarding/SetupProfile/SetupProfile.tsx:312`), so the
  add/remove pair runs on each render. Memoize the callbacks or hold them in refs.
- [ ] **`CaptchaModal` drops the verify promise** (2026-08-03, captcha close-out) —
  `src/components/molecules/CaptchaModal/CaptchaModal.tsx:59` fires
  `userApi.verifyCaptcha({ token })` without `await` or `.catch()`, so a rejection is
  silently swallowed; the reCAPTCHA path below it (`:68`) awaits it.
- [ ] **Reference-client CI triggers point at a merged branch** (2026-10-31) —
  `pipelines/reference-client-conformance.yml` still names `feat/reference-client` in
  its push trigger and nightly schedule. Point it at `develop`; and since
  `ROADMAP_cg-box.md` (P7) deletes the Azure pipelines, the OpenAPI drift check and
  the conformance suite need a new home (GitHub Actions) before that, or they stop
  running.
- [ ] **Triage the open conformance findings** (2026-08-06, reference-client
  workstream) — the "Recorded" section of `sdk/conformance/FINDINGS.md` lists
  contract mismatches and documented behaviours the maintainer may want changed.
  Most visible: **F-11**, a freshly created community bot gets no role and cannot
  post (pinned by `r6-bot`; the test flips once fixed).
- [ ] **Dead-code candidates found during the dependency waves** (2026-08-04):
  `MessageDatabase.getMessages()` / `getLatestMessages()` in
  `src/data/databases/messages.ts` (no callers — superseded by `chunkedDatabase`?),
  `src/hooks/useUserAgent.ts` (no callers), and `src/reportWebVitals.ts` (called only
  in dev, without a handler — inert). Verify and delete.
- [ ] **`htmlToImage()` does not await `page.setViewport()`** (`srv/api/util.ts`,
  2026-08-04, puppeteer 25 bump) — the screenshot can race the viewport change. Await
  it; this may change rendered social-preview output, so compare before/after.
- [ ] **`getUrlPreview`'s `if (metadataResult.error)` guard is unreachable**
  (`srv/api/messages.ts`, 2026-08-04) — open-graph-scraper (v5 and v6) *rejects* on
  failure instead of resolving with `error: true`, so failures surface as `UNKNOWN`.
  Map them explicitly if the route should answer `INVALID_REQUEST`.
- [ ] **`memberlist` overlaps queries on one `pg` client** (2026-08-04) — it logs
  `DeprecationWarning: Calling client.query() when the client is already executing a
  query … removed in pg@9.0`. Fix before any pg 9 bump.
- [ ] **Replace the deprecated `React.ElementRef` / `MutableRefObject` aliases**
  (2026-08-04, React 19 wave) — still working under `@types/react` 19, ~18 uses in
  `src/`.

## Optional / nice-to-have

- [ ] **Dev-stack service toggles** — the `calls`/`blockchain` compose profiles exist only
  in the selfhost profile; the dev stack starts `mediasoup` and `onchain` unconditionally.
  If wanted, `run.sh` needs the same `COMPOSE_PROFILES` derivation `selfhost.sh` has.
- [ ] **The CG ID mini-app drags ~540 KB of main-app UI into its entry** (2026-08-03,
  found while implementing `manualChunks`). `src/cgid/home.tsx` imports `randomString`
  from `src/util/index.tsx`, and that barrel pulls `ExternalIcon` (→
  `@phosphor-icons/react`), `Tooltip` (→ `framer-motion`) and `react-icons/md` in behind
  it. Measured on a prod build: the entry's static closure is 9 chunks / ~790 KiB, of
  which a single 529 KiB chunk is `framer-motion` (148 modules) + `popmotion` +
  `react-icons` + `@phosphor-icons/react` and nothing else. Pre-existing, unrelated to
  the chunking work, and the reason `@phosphor-icons/react` is excluded from the
  `vendor-icons` group. Fix is on the `src/` side: move the two or three helpers CG ID
  actually uses out of the barrel (the mini-app is meant to become its own repository
  anyway — see the comment in `src/index_cgid.tsx`).
  **Re-measured after the framer-motion → motion 12 swap (2026-08-04, deps wave 4b):
  it got slightly worse, and the library was never the fixable part.** The entry's
  static closure is now 9 chunks / 835,990 B (was 801,571 B), of which the one big
  chunk is 582,931 B (was 548,512 B) — `motion-dom` + `framer-motion` 12 +
  `motion-utils` in place of framer-motion 7 + `popmotion`, next to the same
  `react-icons` / `@phosphor-icons/react` / `short-uuid` / `@floating-ui` modules.
  The barrel import is still the whole story; a library swap cannot fix it.
- [ ] **The dependency tree ships 11 distinct copies of `tslib`** (2026-08-03, found while
  reviewing `manualChunks`). They are physically separate nested installs on three
  incompatible pins (`@walletconnect/*` and `rxjs` on 1.14.1; `popmotion`,
  `file-selector`, `@farcaster/auth-kit` on 2.4.0; `styled-components` on 2.5.0; the root
  copy on 2.3.1), so the bundler cannot merge them: `vendor-shared` is 62 KiB
  for ~135 KiB of source that is 11× the same file. Both entries load that chunk, so the
  CG ID mini-app pays for all 11 — it is most of the +63 KB the vendor grouping cost that
  entry. `resolve.dedupe: ['tslib']` is **not** a safe fix as it stands (tslib 1 and 2 are
  not interchangeable); the fix is dependency hygiene — a yarn resolution once the
  `@walletconnect` v1 packages are gone (the 2026-08 wagmi 2 migration removes them;
  re-check then).
  **Re-checked after wave 3 (2026-08-04): 11 copies → 4** (1.14.1, 2.4.0, 2.7.0,
  2.8.1). But the premise above does not hold: the WalletConnect **v1 SDK** is
  indeed gone, while the tslib-1.14.1 pin comes from WalletConnect's own
  1.x-versioned *helper* packages (`@walletconnect/environment`, `events`,
  `jsonrpc-*`, `safe-json`, `time`) — which WalletConnect **v2** core still
  depends on. So a blanket tslib resolution is still unsafe; what is left is
  merging the three tslib-2 copies (2.4.0 / 2.7.0 / 2.8.1), which *is* safe and
  worth a resolution on its own.
- [ ] **Hardhat → 2.29.0** (2026-08-03, Node 24 audit) — the installed 2.2x line
  hard-codes `SUPPORTED_NODE_VERSIONS = ["^18.0.0","^20.0.0"]` and prints a warning on
  Node 24 (it continues; the warning shows in every `build_full` contract deploy).
  2.29.0 silences it. Two files to keep in sync: `contracts/package.json` and
  `docker/hardhat/node/package.json`. Do **not** jump to Hardhat 3 as a side effect.
  Folded into the in-major refresh of `ROADMAP_cg-box.md` (F6).
- [ ] **A minimal two-peer mediasoup integration test** (2026-08-03, mediasoup 3.23
  workstream) — the call subsystem has zero tests, so the 3.14→3.23 jump was validated
  by hand. A join/produce/consume smoke test would let the next mediasoup bump not rely
  on manual staging passes.
- [ ] **The captcha flow's manual browser pass was never formally ticked** (2026-08-03,
  captcha close-out) — solve → verify → replay-reject against a real build, plus the PoW
  duration on a weak device. (Updated 2026-08-04: the v1 500k-hash default is gone —
  the ALTCHA v2 rework in the dependency-update wave 2b made this `ALTCHA_COST` ×
  `ALTCHA_COUNTER_MAX` PBKDF2 work, measured ~1.0–1.5 s headless.) Do it once on
  staging, or strike the item.
- [ ] **Network segmentation for SeaweedFS's internal ports** (2026-08-03, storage
  close-out) — the single `seaweed` container serves master 9333, volume 8080 and filer
  8888 (plus their gRPC siblings at port + 10000) on the shared `cryptogram` network, so
  every container can reach them; only 8333 is actually consumed. weed's own flags cannot
  confine them: `-ip.bind=127.0.0.1` with `-s3.ip.bind=0.0.0.0` does bind the internal
  planes to loopback, but writes then fail because the components dial each other at the
  advertised `-ip`. Confining them would have to come from compose-level network
  segmentation — e.g. a second network joined only by `nginx`, `api` and `job-runner`.
  Hardening nice-to-have, unchanged from the pre-consolidation topology.
- [ ] **Wire `yarn test` into the build scripts once there is a suite worth gating on**
  (2026-08-03). Vitest is set up (`vitest.config.ts`); the suite is still a handful of
  unit tests (mostly the image-filter client modules), so gating the build on it
  would be theatre. The hook-in point is the
  `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite` chain that
  `docker/build.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh` and both
  legacy pipelines run.

## Deferred (decided against for now)

- **`wsapi`-in-`api` collapse** — explicitly deferred during core slimming (2026-08-01):
  real refactor, low payoff.
- **DMs with bots** — explicitly deferred in the bot-accounts workstream (2026-07,
  "deferred, do not start"): DMs need their own authorization, consent, event,
  abuse-prevention and UI design. Nothing in the bearer allowlist or the bot socket
  contract may accidentally enable them.

## Notes for the major-version waves (ROADMAP_cg-box.md)

Forward notes from the 2026-08 dependency updates, for the P2 waves of
`ROADMAP_cg-box.md`. The current pins and their reasons are documented in
[docs/frontend](../frontend/README.md#dependency-pins-and-constraints) and
[docs/backend](../backend/README.md#8-dependency-notes); this list is what each
wave has to *change*.

- **TypeScript 6 (M1)** — the root `tsconfig.json` still uses
  `moduleResolution: "node"` (node10) and `baseUrl: "src"` (backing ~1945 bare
  imports through `vite/baseUrlResolve.ts`); TS 6 deprecates both
  (TODO(verify) against the TS 6 release notes). Moving to `"bundler"` also
  unblocks `@hapi/tlds` 2 (ESM-only), which has to move in both workspaces at once
  because of the `srv/common` symlink — re-check whether its broken `types` field
  (points at `index.d.ts`, ships `index.d.mts`) has been fixed upstream. The target
  floor is es2020 (viem 2 BigInt literals). `srv/` is on `Node16` resolution and
  relies on `require(ESM)` for puppeteer 25.
- **joi 18 (M1)** — joi runs in both workspaces (`src/common/validators.ts` is
  shared), and `docs/api/openapi.json` is generated from the validators'
  `describe()` output: regenerate with `sdk/tools/generate-openapi.sh` and review
  the diff — any change there is a contract change for SDK and native clients.
- **Express 5 (M2)** — drop the `@types/express` and
  `@types/express-serve-static-core` `"4"` resolutions in `srv/package.json`.
- **TypeORM 1.x (M2)** — re-check its `redis` peer (today it warns against
  node-redis 6; inert, it is only for the unused query cache) and that a single
  `reflect-metadata` copy (0.2.2) survives; `emitDecoratorMetadata` was verified
  by entity-metadata registration (37 tables / 325 columns at the time).
- **react-router 7 (M3)** — drop the `react-router-dom: "6.30.1"` security-hold
  resolution (GHSA-jjmj-jmhj-qwj2), rewrite `SuspenseRouter` off the `history`
  package and drop that direct dependency, and drop `@types/react-router-dom` (v5
  types, see above).
- **Vite 8 (M3)** — swaps Rollup for Rolldown and esbuild for Oxc: take a fresh
  baseline of the `manualChunks` vendor groups, the `assertCgidEntryChunks` guard
  and the pinned shared modules (`tslib`, `ua-parser-js`, Vite helpers), and
  re-check the two chunking items above (CG ID entry closure, `tslib` copies).
  `@vitejs/plugin-react` 5.2.0 is the last release for Vite 7; 6.x is Vite-8-only
  (the root is still on `^4`). Both `resolve.alias` entries
  (`altcha-widget-element`, `@tensorflow/tfjs`) and the service-worker nested
  build/precache assertion must survive.
- **Tailwind 4 (M4)** — `postcss.config.js` runs the v3 chain
  (`tailwindcss/nesting` → `tailwindcss` → `autoprefixer`); v4 ships its own PostCSS
  plugin and handles nesting/prefixing itself (TODO(verify) at pickup).

## Image filter: evaluate a hentai-capable server model

Manual testing (2026-08-05) confirmed the accepted-in-roadmap gap concretely:
Falconsai (`onnx-community/nsfw_image_detection-ONNX`, the baked-in default)
correctly rejects photographic porn but passed a manga/hentai porn image —
drawn explicit content is its known weak spot. Candidate with an explicit
`hentai` class: `onnx-community/nsfw-image-detector-ONNX` (ViT,
drawings/hentai/neutral/porn/sexy, Transformers.js layout incl.
`model_quantized.onnx` — drop-in via `IMAGE_MODERATION_MODEL_PATH`; the
filter's label set already sums porn+hentai). **Blocker for a default swap:**
in a quick probe it scored `hentai: 1.000` on harmless flat skin-tone shapes —
far away from the near-zero-false-positive bar. Next steps: broader FP
evaluation on real photos/artwork, check further candidates, then decide
default swap vs. documented limitation. Local eval copy staged at
`docker/api_data/nsfw-5class/` (untracked; test with
`IMAGE_MODERATION_MODEL_PATH=/api_data/nsfw-5class ./run.sh compose up -d api`).

## Image filter: threshold monitoring

- [ ] **Watch the `imageFilter: rejected image` logs before touching the thresholds**
  (2026-08-05, image-filter workstream, post-merge operations) — the server
  threshold (`IMAGE_MODERATION_THRESHOLD`, default 0.8) and the browser warning
  (which follows it via `imageFilterThreshold`) were set without production data.
  Review rejection rates and false positives once real traffic exists (on cg.box)
  before changing either. Same evidence decides whether classifying the source
  instead of the stored crop needs revisiting (accepted as-is in the issue-#53
  review; see [docs/backend](../backend/README.md#srvmoderationimagefilterts--nsfw-image-gate)).

## Email: own newsletter

- [ ] **Own newsletter sending over SMTP** (2026-10-31, G8 mail workstream) —
  the `users.newsletter` flag (the "CG Updates Newsletter" toggle) is kept for
  it; since Mailchimp was removed nothing sends based on it. Needs a compose/
  send path for operators and one-click unsubscribe (a new token kind in
  `srv/util/unsubscribeToken.ts`; see
  [docs/email-notifications](../email-notifications/README.md)).
