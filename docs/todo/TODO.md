# TODO — open one-off tasks

> Standalone open tasks that are too small for a workstream of their own. When an entry
> grows into real, multi-step work, it graduates into its own `ROADMAP_<topic>.md` and
> leaves this list. Working state, not documentation of record.

## Operational (time-critical)

- [ ] **Remove the two `npmPreapprovedPackages` entries from the root `.yarnrc.yml`**
  once they have aged past the 7-day gate (2026-10-31, first use of the 3-day
  security-fix rule): `follow-redirects@1.16.2` from 2026-11-01, `joi@18.3.1`
  (replaced `joi@17.13.9` with the joi 18 upgrade, wave M1) from 2026-11-04. No
  lockfile change needed; see the security-fix log in
  `docs/infrastructure/UPDATE-POLICY.md`.
- [ ] **Confirm the maintainer's selfhost/reference instances have run the SeaweedFS
  volume cutover** (2026-08-03, storage close-out) — the procedure and
  `docker/selfhost/migrate_seaweed_volumes.sh` are documented in `docker/SELFHOST.md`;
  what is untracked is whether the maintainer's own instances have executed it. Confirm
  once, then strike.
- [ ] **Manual browser pass for the 2026-08 dependency waves and the image filter is
  unconfirmed** (2026-10-31, carried over when `ROADMAP_dependency-updates.md` and
  `ROADMAP_IMAGE_FILTER.md` were dissolved). Everything below was verified headlessly
  (API smokes, puppeteer suites, pixel/byte diffs) but needs a real browser/device,
  and neither roadmap recorded it as done. The migration was accepted on 2026-11-08, but this broader matrix is not
  individually attested by that acceptance. Confirm the remaining cases, then strike:
  - auth: passkeys on the main origin (sign-up, login, step-up; once the G4 UI
    lands), a pre-migration passkey on a legacy CG ID gateway, a cross-device
    (hybrid) attempt; every wallet login (MetaMask,
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

## cg.box follow-up after acceptance (2026-11-08)

The move is accepted; the operational record lives in [deployment docs](../deployment/README.md#official-cgbox-instance--accepted-2026-11-08).
These tasks were deferred and do not reopen the migration:

- [ ] Confirm the old production stack is stopped; disable the temporary `cg-import`
  login and close its remaining sessions. Keep the imported source files and dump
  until their retention period is agreed; do not delete them as part of acceptance.
- [ ] Schedule daily local backups on cg.box and test restoration. Jan will arrange
  a separate server which pulls completed backups daily over SSH/SCP; set retention
  and access when that server is ready.
- [ ] Add monitoring and choose the notification channel; Telegram is undecided.
- [ ] Decide whether to configure X/Twitter, WalletConnect and Giphy. Add their
  keys and required callback/origin settings only if retained.
- [ ] Review the imported legal texts and any required legal notice. Consider
  configurable legal/help links for self-hosted instances and audit remaining
  official-site links (Home banner, feedback/support, premium, roles, newsletters,
  plugin editor/appstore and identity help). The three Home footer links are migrated.
- [ ] Set the end of the app.cg/id.app.cg gateway phase and the subsequent redirects;
  decide registration retention before changing gateway/CGID compatibility code.
- [ ] Revisit a local mail relay and newsletter delivery later; system mail currently
  uses SendGrid and newsletters remain paused.
- [ ] Retire obsolete Azure/Swarm/nginx deployment files after moving the reference-client
  OpenAPI drift check and conformance suite to GitHub Actions (see existing CI task).
  Swarm Redis/SeaweedFS rollout tasks are obsolete; no further Swarm deployment is planned.
- [ ] Maintainer follow-up on issue #87 about call reliability, mentioning the
  2026-10-28 ICE-TCP/startup fixes; draft and send separately when requested.
- [ ] Evaluate removal of the legacy `/e/*` redirect separately from the migration.
- [ ] If desired, scope separate workstreams for Ansible operations tooling, GHCR
  images and contributor VM setup; these were not required for the accepted move.

## Maintainer decisions needed

- [ ] **Move `contracts/` to its own repository / submodule?** (2026-08-04, raised by
  the maintainer during dependency-update planning) — contracts are not needed for
  selfhosting, no new on-chain work is planned, and extracting them would take the
  Hardhat/Truffle toolchain (and its audit surface) out of the main repo. Decide, and
  if yes, plan the extraction (keep `contracts/staking` Foundry setup intact; the
  backend only consumes ABIs).
- [ ] **`@openzeppelin/contracts` in `contracts/`: stay on 5.0.2 or move to 5.7.x?**
  (2026-10-31, F6 refresh) — held because it is compiled into the repository's
  contracts: a bump changes their bytecode, so redeploying or re-verifying the
  deployed contracts on an explorer would no longer reproduce. Moot if `contracts/`
  is extracted (item above). See "Held back on purpose" in
  `docs/infrastructure/UPDATE-POLICY.md`.
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
- [ ] **Native IPv6 for the self-host stack?** (2026-11-02, F7) — the stack is
  IPv4-only; Docker's proxy hands IPv6 connections to Caddy from the bridge gateway's
  address, so behind an AAAA record every IPv6 visitor shares one address for the
  backend's per-address limits (measured, `docs/deployment/README.md` §3.10). Today
  `init.sh` advises an A record only. Doing it properly: IPv6 on the `cryptogram`
  network (Docker ≥ 27 allocates a ULA prefix and NATs published ports with the client
  address kept), an IPv6 listen/announce address for mediasoup, `mail-dns` with
  `ip6:` if the relay sends over IPv6, and a test on a host with public IPv6. cg.box launched with IPv4; decide whether to add IPv6 later.

## Cleanup candidates (small, self-contained)

- [ ] **Delete `src/common/random_build_id.ts`** (2026-11-02, F7) — the build ID
  moved to `src/common/buildId.ts` (a build-time value, docs/infrastructure §2
  "Build ID"); the old file is kept byte-identical and unread so that checkouts
  whose earlier builds modified it still pull cleanly. Delete it once the known
  checkouts (the maintainer's, cg.box, the test VM) have run
  `git checkout -- src/common/random_build_id.ts` (docker/SELFHOST.md, upgrade
  note) — a modified copy would stop the `git pull` of the deleting release.

- [ ] **Settings → email page sends `User/setPassword` several times on close**
  (2026-10-31, G4 test-VM pass) — `EmailPage`'s save-on-close effect re-runs while the
  page unmounts, so one password change fires the request about five times. Run the
  save once (ref guard or an explicit save action).
- [ ] **About 6 s of spinner after `createUser`** (2026-10-31, G4 test-VM pass,
  cause unconfirmed) — the sign-up resolves late; suspects are `setupAfterLogin`
  (Dexie setup) and the notification database lock. Measure, then fix.
- [ ] **A logout interrupted by navigation leaves `CG_CURRENT_USER` set** (2026-10-31,
  G4 test-VM pass) — `loginManager.logout()` clears the stored current user only
  after the server call and the local cleanup; navigating away in between leaves it
  in `localStorage` (what the next page load does with it is not analysed yet).
  Check the order and clear it reliably.
- [ ] **jest leaves a worker running** (2026-10-31, seen on the combined F3+F4+F6
  test-VM run): `yarn tests` in `srv/` passes but prints "A worker process has
  failed to exit gracefully and has been force exited…" since the F6 dependency
  set. Not reproducible on `develop` before F6 (`ff0da06`: 23 suites, no warning),
  so a dependency update leaves a timer or socket open in some spec. Find it with
  `yarn jest --detectOpenHandles` (or `--runInBand` per suite) on the F6 lockfile,
  then close the handle in that spec (or `.unref()` it in the module).

- [ ] **Passkey sign-up conformance tests answer `INVALID_REQUEST`** (2026-11-01,
  found during the M2 conformance run; 106 of 110 pass on develop `56e7c34`
  with and without Express 5). Three passkey sign-up tests get
  `User/createUser failed: INVALID_REQUEST`. The sign-up flow changed in G4
  (email verified before the account exists) and G10 (8-digit codes, kind of
  limit); the conformance suite probably still drives the old sequence.
  Update the suite to the current flow, or fix the server if the flow it
  drives is meant to work.

- [ ] **`imageFilterThreshold` breaks the `r0-instance-config` conformance test**
  (2026-10-31, found during the Node 26 conformance run; 102 of 104 tests pass).
  `/api/v2/Instance/config` always sends `imageFilterThreshold`
  (`srv/util/instanceConfig.ts`), the Caddy-rendered `/instance-config.js`
  (`docker/caddy/instance-config.js`) only adds it when
  `CG_IMAGE_FILTER_THRESHOLD` is set. The SDK mirror lists the field by now;
  what remains is the "matches the config the web app gets" case, which
  compares `/instance-config.js` with the endpoint and fails on exactly this
  field. Make the two sources agree on when it is present (e.g. the template
  emits the backend's default too).

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
- [ ] **Conformance sign-up on instances that send mail** (2026-10-31, G4) — with
  mail configured, `createUser` (and a sign-up passkey) needs the address verified
  by `User/requestSignupEmailCode` / `verifySignupEmailCode` first; the conformance
  fixtures cannot read the code, so `registerUser` fails there (only relevant with
  `CG_LIVE_MUTATIONS=1`; the disposable instance runs without mail). Needs a mail
  sink the suite can read, or a test hook for the sign-up code.
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
  Note (2026-11-01, wave M3): the built eth-sig-util chunk does not even
  evaluate in the browser — `readable-stream` 2 in its tree reads
  `process.browser` at load time and `process` is deliberately not polyfilled
  (`ReferenceError: process is not defined`; the same code is in the Vite 7
  build, so this predates Vite 8). Also `validators.ts:311` imports it.
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
- [ ] **Move `SuspenseRouter` off the `history` package** (2026-11-01, left over from
  wave M3) — react-router 7 runs fine with `history` 5's `BrowserHistory` as the
  `<Router navigator>` (verified with the e2e suite and a navigation smoke), but
  `history`'s last release is 5.3.0 from 2022-02 and only this file uses it. The catch is the
  `isDirty` "unsaved changes" confirm and the Matomo page-view hook, which listen to
  the history object: react-router's own `BrowserRouter` (it wraps updates in
  `startTransition` since v7) exposes no listener, and `useBlocker` needs a data
  router. Options: a small in-repo history, or moving to `createBrowserRouter`. Needs
  a browser pass of the "unsaved changes" prompt.
- [ ] **Delete `public/images/tokensale_header.png`** (891 KB, 2026-08-03, Vite workstream)
  — nothing references it; `src/views/TokenSale/TokenSale.tsx:106` uses the `.webp`. It
  ships in every build. (`public/images/tokensale_social_preview.png` **is** used, by
  `srv/api/getRoutes.ts` — do not delete that one.) Belongs to the token-sale removal.
- [ ] **`docker/updateFrontend.sh` does not refresh `docker/backend/dist/index.html`**
  (2026-08-03) — after `./run.sh update_frontend` the API keeps serving the *previous*
  build's shell (pointing at hashed assets that no longer exist) on every deep-link/share
  route until `update_backend` runs. Pre-existing, not caused by the Vite cutover; either
  copy `build/index.html` there like `build.sh` does, or document the pairing.
- [ ] **e2e `images` flow: Enter sometimes does not send the message with the
  attachment** (2026-11-01, wave M3) — in 3 of 4 full-suite runs on Vite 8 builds
  (also with the service-worker fix in place, docs/frontend §9 "Service worker and
  module scripts"), never in 30 standalone runs of the flow
  nor in 20 image sends in one long session. The composer keeps "a picture" and the
  preview; once the message went out without the picture. Not yet seen on a Vite 7 full
  run (1 clean run). Next step: log the composer's send state when Enter is pressed.
- [ ] **e2e: allowlist or block the WalletConnect `pulse.walletconnect.org` CORS error**
  (2026-11-01) — since the evening of 2026-11-01 every flow records "Access to fetch at
  'https://pulse.walletconnect.org/e?…' … blocked by CORS policy" (also on the a1460cb
  build): third-party telemetry, not ours; it makes every flow fail its guards.
- [ ] **The first "Publish" of a session in the article editor sometimes does nothing**
  (2026-11-01, wave M3 scratch scripts) — a second click publishes. Seen on the Vite 8
  builds with and without the service-worker fix; no request is aborted and no
  import fails when it happens, so it is not the start-up bug. The e2e article flow
  (which waits longer before publishing) always passes. Not yet checked on a Vite 7
  build; look at what the first click does (toolbar re-render, the newsletter check's
  `NOT_ALLOWED`).
- [ ] **Vite's `configLoader: 'native'` notice on every build** (2026-11-01, wave M3) —
  Vite 8 warns that `vite.config.ts` and `vite/*.ts` use ESM syntax in a package without
  `"type": "module"`, which the native config loader (planned as a future default) will
  not support. Harmless with today's bundling loader. Fix: `.mts` files (or `"type":
  "module"`, which would also need `import.meta.dirname` instead of `__dirname`; the
  CommonJS `postcss.config.js`/`tailwind.config.js` are gone since wave M4), then drop
  the notice from the docs.
- [ ] **`start_https` blocks `app.cg.local` / `bs-local.com`** (2026-11-01, found in
  wave M3, not caused by it) — `Caddyfile.vite` serves both names, but Vite's host
  check rejects them ("Blocked request") because the dev server behind Caddy is plain
  HTTP; only `localhost` and IP literals pass. Add them to `server.allowedHosts` or
  drop them from `Caddyfile.vite` (docs/infrastructure §6).
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
  `src/components/molecules/SignupCaptcha/SignupCaptcha.tsx`), so the
  add/remove pair runs on each render. Memoize the callbacks or hold them in refs.
- [ ] **`CaptchaModal` drops the verify promise** (2026-08-03, captcha close-out) —
  `src/components/molecules/CaptchaModal/CaptchaModal.tsx:59` fires
  `userApi.verifyCaptcha({ token })` without `await` or `.catch()`, so a rejection is
  silently swallowed; the reCAPTCHA path below it (`:68`) awaits it.
- [ ] **Reference-client CI triggers point at a merged branch** (2026-10-31) —
  `pipelines/reference-client-conformance.yml` still names `feat/reference-client` in
  its push trigger and nightly schedule. Point it at `develop`; and since
  the post-migration cleanup will retire the Azure pipelines, the OpenAPI drift check and
  the conformance suite need a new home (GitHub Actions) before that, or they stop
  running.
- [ ] **Triage the open conformance findings** (2026-08-06, reference-client
  workstream) — the "Recorded" section of `sdk/conformance/FINDINGS.md` lists
  contract mismatches and documented behaviours the maintainer may want changed.
  Most visible: **F-11**, a freshly created community bot gets no role and cannot
  post (pinned by `r6-bot`; the test flips once fixed).
- [ ] **Dead-code candidates found during the dependency waves** (2026-08-04):
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

- [ ] **App errors the e2e suite reports** (2026-11-01, `e2e/` guards; each fails
  its flow until fixed or allowlisted with a reason):
  - an empty Giphy key still calls Giphy (401, unhandled `@giphy/js-fetch-api: Unauthorized`);
  - article editor: `IndexSizeError: getRangeAt` (uncaught); `getLatestArticleSentAsNewsletterDate`
    answers `NOT_ALLOWED` for the community owner;
  - the call chat sometimes sends `loadMessages` with `{callId, channelId, communityId}`, which
    fails the access validator (`VALIDATION`);
  - `/files/` serves images as `application/octet-stream`;
  - `createCommunity` logs "Creating initial article failed … articleId null" when the template
    article does not exist;
  - found by the M3 navigation smoke (2026-11-01, same on a1460cb): a deep link to `/store/`
    throws unhandled `NOT_FOUND` (`getCommunityDetailView`) and `VALIDATION`
    (`getArticleList`); a deep link to a non-existent profile article
    (`/u/<id>/article/<bad>/`) logs "Article uri invalid" and never leaves the loading screen.
- [ ] **A sole broadcaster's dropped or replaced connection ends the broadcast** (2026-11-02,
  G13 review) — the peer `close` handler in `srv/mediasoup/room.ts` closes the room as soon
  as no broadcaster is left, and `handleProtooConnection` closes a peer's previous
  connection when it reconnects. A broadcast with one broadcaster therefore ends for every
  viewer (`softEndCall`) when that broadcaster's connection drops or is replaced, even if
  the broadcaster is back a second later. The "last peer left" check has the same race on
  a reconnect. Needs a grace period before the room closes.
- [ ] **Starting a running event call again moves it to another call server** (2026-11-02,
  G13 review) — `callHelper.startScheduledCall` assigns the least-loaded live call server
  every time and does not check whether the call is already running. A second start while
  the first room is live points the call (and new joiners) at another server while the old
  room keeps its peers. Only start a call that is ended or has no live room, or keep the
  assigned server while it is live.
- [ ] **`callUpdateEmitter` keeps stale per-server state** (2026-11-02, G13 review) — the
  jobs process tracks calls per call server in memory (`srv/jobs/callUpdateEmitter.ts`).
  At startup it only loads servers whose heartbeat is younger than 10 s; a server that
  drops out (10 s timeout) or was not live at startup leaves its calls untracked or its
  entries in `callServerIdsByCallIds`, and its open calls are not reloaded when it comes
  back. Member joins/leaves of those calls then emit no `cliCallEvent update` (member
  counts stay stale until the community is refreshed); ended calls are not affected
  (their `delete` does not depend on this state). Reload a server's open calls from the
  database when it (re)appears and drop its entries when it goes.
- [ ] **Remove the chat-sync compat paths one release after chat-sync** (2026-11-03,
  chat-sync close-out) — kept for pages of the previous build that stay open across
  the update: the service worker's `WorkerToTab` `active` answer to old pages
  (`src/serviceWorkerLegacyTabs.ts`, the two COMPAT blocks in `src/service-worker.ts`,
  the `Legacy*` types in `src/data/appstate/transport.ts`) and the `'anonymous'` post
  on `CG_LOGIN_STATE` at logout (`src/data/appstate/authBroadcast.ts`). All are marked
  `COMPAT — remove one release after chat-sync`; update docs/realtime "Tab
  Coordination" and docs/frontend §8 with them. The client's 404 fallbacks for
  `getChanges`/`getSyncState` (docs/frontend "Chat stores", "Old server") only matter
  during a deploy against an older backend and may go at the same time.
- [ ] **Message attachments request Giphy for every attachment list** (2026-11-03, seen
  by the e2e flow `images`) — `MessageAttachments.tsx` calls `gf.gifs(giphyIds)` also
  when the list has no Giphy attachment and when no `GIPHY_API_KEY` is configured
  (`src/util/giphy.ts` then uses the key `'disabled'`). Giphy answers 401 and the
  rejected promise shows up as uncaught `@giphy/js-fetch-api: Unauthorized` page errors. Only fetch when
  there are Giphy ids and Giphy is enabled.
- [ ] **The article editor logs errors for communities without newsletters**
  (2026-11-03, seen by the e2e flow `article-plugin`) — `GenericArticleManagement.tsx`
  calls `Community/getLatestArticleSentAsNewsletterDate` for every community it edits an
  article in; the server answers `NOT_ALLOWED` for a community that is not on the
  newsletter whitelist (`srv/api/community.ts`), so every such editor load produces a
  failed API request (the client swallows the error). Ask only when the community can
  send newsletters (e.g. a flag in the community data), or answer "not available"
  without an error. Same flow: `EditField.tsx` calls `getRangeAt(0)` in the media-button
  positioning timeout without checking `rangeCount`, which throws `IndexSizeError` when
  the selection is empty.
- [ ] **e2e: a hidden tab's socket close after 5 minutes and its catch-up** (2026-11-03,
  final chat-sync review) — covered by unit tests only (`src/data/appstate/webSocket.test.ts`,
  `HIDDEN_DISCONNECT_AFTER_MS` in `transport.ts`). The `cs-*` flows freeze tabs
  (E8) but never keep one hidden for 5 minutes. A flow needs either an opt-in run that
  waits it out (posts and an edit while the tab's socket is closed, then the tab brought
  to the front catches up, like E8's frozen part) or a way for the disposable instance's
  build to shorten the timeout.

## Optional / nice-to-have

- [ ] **Chat-sync P4: persist the latest messages per channel** (2026-11-03, left
  open when the chat-sync package closed) — messages and notifications are memory
  only (docs/frontend "Chat stores"), so after a reload a channel's history needs a
  round trip and nothing is shown offline. Decide on the numbers of the e2e flow
  `cs-login-time` (time to the first and to all messages after a reload) and on
  whether offline display is wanted. If built: a pure add-on to `ChannelStore` — a
  latest-N snapshot per channel in IndexedDB, one writer per transaction, LRU of K
  channels, whole-store wipe on logout, a cache-schema constant; the server stays the
  source of truth. The e2e scenario E6 (offline display) belongs to it.

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
  segmentation — e.g. a second network joined only by `caddy`, `api` and `job-runner`.
  Hardening nice-to-have, unchanged from the pre-consolidation topology.
- [ ] **Wire `yarn test` into the build scripts once there is a suite worth gating on**
  (2026-08-03). Vitest is set up (`vitest.config.ts`); the suite is still a handful of
  unit tests (mostly the image-filter client modules), so gating the build on it
  would be theatre. The hook-in point is the
  `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite` chain that
  `docker/build.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh` and both
  legacy pipelines run.
- [ ] **Give chat-composer image attachments a local id** (2026-11-07). Until the
  upload returns, an attachment's `imageId` is its file name, and the tiles are keyed
  by list index (`EditField.tsx`, `image_${index}_…`). Two pasted screenshots share
  one name (`image.png`), so `updateAttachmentImageId` and `removeAttachment`
  (`EditField.helpers.ts`) can hit the wrong tile or both. Removing an earlier tile
  remounts the later ones, which start their upload a second time. Fix: a local
  id per attachment from `addFiles`, used as the key and for update, flag and
  remove (the failed-upload flag already matches the `File` itself).

## Deferred (decided against for now)

- **`wsapi`-in-`api` collapse** — explicitly deferred during core slimming (2026-08-01):
  real refactor, low payoff.
- **DMs with bots** — explicitly deferred in the bot-accounts workstream (2026-07,
  "deferred, do not start"): DMs need their own authorization, consent, event,
  abuse-prevention and UI design. Nothing in the bearer allowlist or the bot socket
  contract may accidentally enable them.

## Remaining notes from the major-version waves

Forward notes from the 2026-08 dependency updates and the completed cg.box
migration (historical roadmap in git at `5d0df48`). The current pins and their reasons are documented in
[docs/frontend](../frontend/README.md#dependency-pins-and-constraints) and
[docs/backend](../backend/README.md#8-dependency-notes); this list is what each
wave has to *change*.

- **`@hapi/tlds` 2 (left over from M1)** — the root `tsconfig.json` is on
  `moduleResolution: "bundler"` since TypeScript 6 (wave M1), which unblocks the
  ESM-only `@hapi/tlds` 2 on the frontend side. It has to move in both workspaces
  at once because of the `srv/common` symlink (`srv/` is CommonJS on `Node16`
  resolution and would load it through `require(ESM)`, as it does puppeteer 25);
  re-check whether its `types` field (2.0.2: `./dist/index.d.ts`, `exports` has
  no `types` condition) resolves. joi 18 itself still depends on `^1.1.1`.
- **react-router 7 (M3, step B)** — done 2026-11-01 (react-router 7.18.4, imports
  switched from `react-router-dom`, which is gone, as is `@types/react-router-dom`;
  closes GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg; docs/frontend "Routing on
  react-router 7"). Left over: `SuspenseRouter` still uses the `history` package
  (cleanup entry above). Delete this bullet once the wave is merged.
- **Vite 8 (M3, step A)** — done 2026-11-01 (Vite 8.3.5, `@vitejs/plugin-react`
  6, `vite-plugin-svgr` 5, `vite-plugin-node-polyfills` 0.28; docs/frontend §9 and
  docs/infrastructure "Frontend build steps" have the measurements). The two
  chunking items above are unchanged by it: the CG ID entry closure is 9 chunks /
  ~900 KiB on both Vite 7 and Vite 8 (the barrel chunk is now named `util`), and
  `vendor-shared` is 58 KiB (56 KiB on Vite 7; it now also holds Oxc's lowering
  helpers and the `global` shim). Delete this bullet once the wave is merged.
- **Tailwind 4 (M4)** — done 2026-11-02 (tailwindcss 4.3.3 through
  `@tailwindcss/vite`; `postcss.config.js`, `tailwind.config.js`, `autoprefixer`,
  `postcss`, `@tailwindcss/aspect-ratio` and the unused `@tailwindcss/typography`
  are gone; configuration in `src/tailwind.css`; docs/frontend §9 "Styling:
  Tailwind CSS 4"). The browser floor was raised with it (decided 2026-11-02:
  Safari 15.4, Chrome/Edge 104, Firefox 97; `browserslist` dropped; docs/frontend
  §9 "Toolchain"). Delete this bullet once the wave is merged.

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
