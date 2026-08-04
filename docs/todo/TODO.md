# TODO — open one-off tasks

> Standalone open tasks that are too small for a workstream of their own. When an entry
> grows into real, multi-step work, it graduates into its own `ROADMAP_<topic>.md` and
> leaves this list. Working state, not documentation of record.

## Operational (time-critical)

- [ ] **Staging verification of the mediasoup 3.14 → 3.23 jump is still outstanding**
  (2026-08-03, confirmed by the maintainer). The call subsystem has no automated tests,
  so the bump was validated by code review and local builds only. Needed: a real
  two-peer call on staging — join, produce, consume, broadcast mode, promote/demote,
  moderation mute, reconnect, leave — plus confirming that the ICE candidates carry the
  expected announced address after the `listenIps` → `listenInfos` migration. Target is
  the `mediasoup_staging` inventory driven by `pipelines/build-and-deploy-beta.yml`
  (~:181-190, "Deploy mediasoup staging"). **Must happen before the next staging/prod
  rollout of the new images.**
- [ ] **Confirm the maintainer's selfhost/reference instances have run the SeaweedFS
  volume cutover** (2026-08-03, storage close-out) — the procedure and
  `docker/selfhost/migrate_seaweed_volumes.sh` are documented in `docker/SELFHOST.md`;
  what is untracked is whether the maintainer's own instances have executed it. Confirm
  once, then strike.
- [ ] **Cut the hosted Swarm stack over to the single `redis` service** — the stack files
  in the separate infrastructure repository still publish
  `redis-sessions`/`redis-socketio`/`redis-data`, which images built after the core-slimming
  Phase-5 merge (2026-08-02) no longer look for. Either merge the three services into one
  named `redis` or set `REDIS_URL` on `api`, `wsapi`, `job-runner` and `onchain`,
  **before or together with** the next staging/prod image rollout. Details:
  [docs/deployment](../deployment/README.md) §6. Nothing in this repo can perform or verify
  the change.
- [ ] **Pin the SeaweedFS image in the hosted Swarm stack, and collapse its three seaweed
  services into one** — the compose files in this repo pin `chrislusf/seaweedfs:4.40`
  (2026-08-02; security floor 4.34), but the Swarm stack files in the separate
  infrastructure repository pin independently and may still ride `:latest`. Same
  coordination as the Redis item above.
  - The **pin** is the urgent half and stands on its own.
  - The **topology** half is not urgent: as of 2026-08-02 both compose files here run a
    single `seaweed` service (`weed server`, one `seaweedfs-data` volume). The application
    is agnostic — it only ever talks to `s3.local:8333` — so the Swarm stack can keep the
    three-service topology indefinitely as long as it pins the same image. Mirroring the
    collapse there is a footprint/backup win (one volume ⇒ atomic snapshots), not a
    correctness requirement.
  - When it is mirrored, the data merge is the same one selfhost does:
    `docker/selfhost/migrate_seaweed_volumes.sh` documents the required layout (blobs at
    the `/data` root, filer leveldb in `filerldb2/`), though a Swarm stack will need its
    own equivalent of the volume copy.

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

## Cleanup candidates (small, self-contained)

- [ ] **`srv/healthcheck.ts`: wire up or delete the dead real healthcheck.**
  `startHealthcheck` (sole consumer of `checkRedis`) has zero callers — every process uses
  `fakeHealthcheck()`. Either wire the real one up or delete the dead path; in the same
  move, split `fakeHealthcheck` into its own module (precedent:
  `srv/mediasoup/mediasoupHealthcheck.ts`) so `memberlist` stops opening Redis connections
  it never uses.
- [ ] **Drop the `docker-compose` v1 fallback in `docker/selfhost/selfhost.sh`** — v1 is
  EOL and ignores `COMPOSE_PROFILES`, so on v1 the `calls`/`blockchain` profiles would
  silently start neither service.
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
  createPasskey.tsx do it correctly inside).
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
- [ ] **`og:site_name` in `index.html` is hardcoded to `app.cg`** (2026-08-03) — every
  self-hosted instance ships it in its social previews. Pre-existing, unrelated to the
  Vite migration, but it sits two lines from the meta tags that migration touched.
  (`index_cgid.html` says `CG ID`, which is domain-neutral and fine.) Either drop the
  tag or have the two injection paths rewrite it like the other social meta.
- [ ] **Prune what is left of the CG ID vhost's cross-origin allowances** (2026-08-03,
  Vite workstream) — `8f90fc2b4` removed the main-origin entries that the CRA
  `PUBLIC_URL` layout needed, but two allowances of the same vintage are still there:
  `https://analytics.{prod,staging}.app.cg` in the CG ID `script-src-elem`/`connect-src`
  (`docker/nginx/nginx.conf:100-101`), although Matomo is injected only by `src/index.tsx`
  — the *main* entry — and never by the CG ID mini-app; and the `$cg_allow_origin` ACAO
  rule on the main vhost (`nginx.conf:110`, `nginx_selfhost.conf:77`), which exists for
  asset loads from the CG ID origin that are same-origin since the cutover. Both are
  widenings, not breakage. Needs the same built-image check the CSP prune had.
- [ ] **`docker/updateFrontend.sh` does not refresh `docker/backend/dist/index.html`**
  (2026-08-03) — after `./run.sh update_frontend` the API keeps serving the *previous*
  build's shell (pointing at hashed assets that no longer exist) on every deep-link/share
  route until `update_backend` runs. Pre-existing, not caused by the Vite cutover; either
  copy `build/index.html` there like `build.sh` does, or document the pairing.
- [ ] **`srv/jest.config.js` only runs compiled `.js` tests** (2026-08-03, Node 24 audit)
  — the `ts-jest` preset is configured, but `testRegex`/`moduleFileExtensions` match `.js`
  only, so the backend test run finds nothing until a `tsc` pass has produced output.
  Point it at the `.ts` sources.
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
- [ ] **The dependency tree ships 11 distinct copies of `tslib`** (2026-08-03, found while
  reviewing `manualChunks`). They are physically separate nested installs on three
  incompatible pins (`@walletconnect/*` and `rxjs` on 1.14.1; `popmotion`,
  `file-selector`, `@farcaster/auth-kit` on 2.4.0; `styled-components` on 2.5.0; the root
  copy on 2.3.1), so the bundler cannot merge them: `vendor-shared` is 62 KiB
  for ~135 KiB of source that is 11× the same file. Both entries load that chunk, so the
  CG ID mini-app pays for all 11 — it is most of the +63 KB the vendor grouping cost that
  entry. `resolve.dedupe: ['tslib']` is **not** a safe fix as it stands (tslib 1 and 2 are
  not interchangeable); the fix is dependency hygiene — a yarn resolution once the
  `@walletconnect` v1 packages are gone (the wagmi 2 migration in
  `ROADMAP_dependency-updates.md` wave 3 removes them; re-check then).
  **Re-checked after wave 3 (2026-08-04): 11 copies → 4** (1.14.1, 2.4.0, 2.7.0,
  2.8.1). But the premise above does not hold: the WalletConnect **v1 SDK** is
  indeed gone, while the tslib-1.14.1 pin comes from WalletConnect's own
  1.x-versioned *helper* packages (`@walletconnect/environment`, `events`,
  `jsonrpc-*`, `safe-json`, `time`) — which WalletConnect **v2** core still
  depends on. So a blanket tslib resolution is still unsafe; what is left is
  merging the three tslib-2 copies (2.4.0 / 2.7.0 / 2.8.1), which *is* safe and
  worth a resolution on its own.
- [ ] **Immutable caching for hashed frontend assets in nginx — own PR** (2026-08-03).
  `^/(fonts|icons|images|static|audio|downloads)/` is capped at
  `max-age=86400, must-revalidate` in all three nginx configs, although everything under
  `static/` carries a content hash in its name. Long-lived `immutable` caching for the
  hashed subset would remove a daily revalidation round trip per asset.
- [ ] **Hardhat → 2.29.0** (2026-08-03, Node 24 audit) — the installed 2.2x line
  hard-codes `SUPPORTED_NODE_VERSIONS = ["^18.0.0","^20.0.0"]` and prints a warning on
  Node 24 (it continues; the warning shows in every `build_full` contract deploy).
  2.29.0 silences it. Two files to keep in sync: `contracts/package.json` and
  `docker/hardhat/node/package.json`. Do **not** jump to Hardhat 3 as a side effect.
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
  (2026-08-03). Vitest is set up (`vitest.config.ts`) with a single smoke test; gating the
  build on that would be theatre. The hook-in point is the
  `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite` chain that
  `docker/build.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh` and both
  legacy pipelines run.

## Deferred (decided against for now)

- **`wsapi`-in-`api` collapse** — explicitly deferred during core slimming (2026-08-01):
  real refactor, low payoff.
- **Bundled mail server in the stack** — decided against (2026-08-02): extra maintenance,
  and operators who want one can run their own. The email direction is
  bring-your-own-SMTP; see the planned email workstream below.
- **DMs with bots** — explicitly deferred in the bot-accounts workstream (2026-07,
  "deferred, do not start"): DMs need their own authorization, consent, event,
  abuse-prevention and UI design. Nothing in the bearer allowlist or the bot socket
  contract may accidentally enable them.

## Upcoming workstreams (roadmap to be written)

- **Email: provider-agnostic SMTP** — replace the hard-wired SendGrid client with a
  generic SMTP transport (swap surface is `EmailUtils.sendEmail` in `srv/api/emails.ts`
  plus init in `srv/serverconfig.ts`, see [docs/email-notifications](../email-notifications/README.md));
  drop the Mailchimp audience sync (local subscription flag already exists). No bundled
  MTA (see above).
- **Express 5** — out of scope for the 2026-08 dependency updates. Forward note:
  `srv/package.json` pins `resolutions: { "@types/express": "4",
  "@types/express-serve-static-core": "4" }` because `@types/express-{session,ws,fileupload}`
  depend on `@types/express@*` → 5.x, which hoists an incompatible `Request` type next
  to the v4 one. Whoever picks up Express 5 drops both pins.
- **react-router 7** — out of scope for the 2026-08 dependency updates. Forward note:
  the root `package.json` carries a **security hold** `resolutions: { "react-router-dom":
  "6.30.1" }` — 6.30.2–6.30.4 are vulnerable to GHSA-jjmj-jmhj-qwj2 (open redirect →
  XSS) and the only fix is v7. Whoever picks up react-router 7 must drop that pin (and
  the then-vestigial `history` direct dependency SuspenseRouter still imports).
- **Vite 8 (Rolldown / Oxc)** — deliberately deferred at the Vite 7 bump (2026-08-03):
  it swaps Rollup for Rolldown and esbuild for Oxc, a bundler swap that needs its own
  baseline measurements against a chunking setup tuned under Rollup 4. Forward notes:
  the last `@vitejs/plugin-react` supporting Vite 7 is **5.2.0** (6.x is Vite-8-only),
  and the two chunking findings above (CG ID entry closure, 11 copies of `tslib`) are
  worth revisiting under Rolldown, which changes the calculus for both.
