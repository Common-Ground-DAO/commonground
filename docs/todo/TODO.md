# TODO — open one-off tasks

> Standalone open tasks that are too small for a workstream of their own. When an entry
> grows into real, multi-step work, it graduates into its own `ROADMAP_<topic>.md` and
> leaves this list. Working state, not documentation of record.

## Operational (time-critical)

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
- [ ] **Drop the `@types/confusing-browser-globals` devDep** (2026-08-03, Vite workstream)
  — its only would-be consumer is `eslint.config.mjs`, which no tsconfig project covers
  (`tsconfig.json` includes `src/` only, `tsconfig.node.json` lists `vite.config.ts`,
  `vitest.config.ts`, `vite/*.ts`, `tools/*.mjs`). The runtime package
  `confusing-browser-globals` stays — the flat config imports it. One-line cleanup.
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
  `@walletconnect` v1 packages are gone.
- [ ] **Immutable caching for hashed frontend assets in nginx — own PR** (2026-08-03).
  `^/(fonts|icons|images|static|audio|downloads)/` is capped at
  `max-age=86400, must-revalidate` in all three nginx configs, although everything under
  `static/` carries a content hash in its name. Long-lived `immutable` caching for the
  hashed subset would remove a daily revalidation round trip per asset.
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

## Upcoming workstreams (roadmap to be written)

- **Email: provider-agnostic SMTP** — replace the hard-wired SendGrid client with a
  generic SMTP transport (swap surface is `EmailUtils.sendEmail` in `srv/api/emails.ts`
  plus init in `srv/serverconfig.ts`, see [docs/email-notifications](../email-notifications/README.md));
  drop the Mailchimp audience sync (local subscription flag already exists). No bundled
  MTA (see above).
