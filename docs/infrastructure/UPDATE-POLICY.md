> Status: verified against commit 5f73578, 2026-10-31; example image line updated for Valkey, "Open advisories",
> "Held back on purpose", the security-fix rule (3 days) and its log against
> commit ff0da06, 2026-10-31; the wave M1 changes (joi 18.3.1 in the security-fix
> log, `typescript` held back, the Renovate majors list) against commit d604544,
> 2026-10-31

# Update policy: 7-day minimum release age (3 days for security fixes)

This is the supply-chain policy for every third-party artifact Common Ground
builds from or runs (roadmap decision 3, `docs/todo/ROADMAP_cg-box.md`). It
applies to all deployment shapes (dev stack, self-host, the hosted move to
cg.box) and to every agent or human who changes dependencies.

## The rule

**Nothing gets installed, pulled or pinned unless the exact artifact was
published at least 7 days ago.** "Exact artifact" means:

| Ecosystem | What must be ≥ 7 days old | Where the date comes from |
|---|---|---|
| npm (Yarn) | the package version | npm registry `time[<version>]` (what Yarn's age gate reads) |
| Docker images | the image **digest** that is pinned, not just the tag | Docker Hub tag `last_updated`, or `docker buildx imagetools inspect` + the registry's push date. A floating tag (`26-trixie`) is re-pushed often; pin a tag that no longer moves (the previous patch release) when the current push is too young. |
| apt (Debian) | the `snapshot.debian.org` timestamp the image builds from | the timestamp itself (see [apt](#apt-debian)) |
| Binary downloads (release assets, model weights) | the release / revision | GitHub release `published_at` / asset `created_at`, HuggingFace commit date, object `last-modified` |
| pip / Ansible Galaxy | the package / collection version | PyPI upload time / Galaxy publish date. Nothing in the repository installs from either today (no `pip install`, no `requirements.txt`, no Galaxy file); the Ansible suite planned after the move (roadmap decision 5) must follow this rule from day one. |
| CI (actions, runner images) | the action release / image digest | as for Docker / GitHub releases. The repository has no GitHub Actions workflows yet; the legacy Azure pipelines (`pipelines/`) are frozen and not managed by Renovate. |

The exact pins (image tags + digests, tool versions + hashes) live only in the
Dockerfiles, compose files and fetch scripts; the docs name the line
(`node:26-trixie`, `valkey/valkey:9.1-alpine`, …) so a Renovate bump does not make them
stale.

Why a week: supply-chain worms of the 2025–2026 kind (e.g. the 2026-08
keyv/cacheable wave, see [README §2](README.md#package-manager-hardening)) are
detected and purged within hours to days. Package age filters them out;
advisory databases do not — during that attack no advisory existed for the
highest-traffic poisoned packages while it ran.

### Security fixes: 3 days

**A security fix may be taken once it is at least 3 days old** (maintainer
decision, 2026-10-31). A security fix is an update that resolves a published
advisory (GHSA/CVE) affecting a version one of our lockfiles, images or pins
actually resolves — the advisory's patched version, or the lowest release
containing it. Everything else, including routine updates that happen to come
with a fix nobody has published an advisory for, keeps the 7-day rule.

Three days still filter out the typical worm wave (hours to days) while not
leaving a published vulnerability open for a full week. Every use is logged in
the [security-fix log](#security-fix-log) in the same change (npm: see
[the Yarn mechanism](#npm-yarn)); Renovate opens vulnerability PRs after 3 days
on its own (see [Renovate](#renovate)).

## Exceptions

Anything younger than the applicable minimum — **below 3 days for a security
fix, below 7 days for everything else** — is an exception. It is allowed
**only with the maintainer's explicit approval** and is recorded here **in the
same change** that uses it (date, exact package/version, reason, who approved).
One row per artifact; an exception covers that version only, never later ones.

| Date | Package / version (ecosystem) | Reason | Approved by |
|---|---|---|---|
| — | — | — | — |

### Security-fix log

Security fixes taken under the 3-day rule (no approval needed beyond the rule;
one row per artifact).

| Date | Package / version (ecosystem) | Advisory | Published | Where | Reason / mechanism |
|---|---|---|---|---|---|
| 2026-10-31 | `joi` 17.13.9 (npm) | GHSA-4528-x5fx-h6hg (high) | 2026-10-28T10:04Z | root, `srv/` (floor `^17.13.9`) | quadratic split in `string().email({ multiple: true })`; not reachable today (no validator uses `multiple: true`), taken anyway as the rule's first application. `npmPreapprovedPackages` entry in the root `.yarnrc.yml` until 2026-11-04; replaced by the 18.3.1 row below the same day |
| 2026-10-31 | `joi` 18.3.1 (npm) | GHSA-4528-x5fx-h6hg (high) | 2026-10-28T09:59Z | root, `srv/` (`^18.3.1`) | the joi 18 upgrade (wave M1 of `docs/todo/ROADMAP_cg-box.md`): the advisory also covers `>= 18.0.0, < 18.3.1`, so the newest release older than 7 days (18.3.0) would have been vulnerable. Same reachability as above. The `npmPreapprovedPackages` entry `"joi@18.3.1"` replaced `"joi@17.13.9"` in the root `.yarnrc.yml` (no lockfile resolves joi 17 any more); remove it on 2026-11-04 |
| 2026-10-31 | `follow-redirects` 1.16.2 (npm) | GHSA-mrwp-f3q8-3g9p (high) | 2026-10-25T21:32Z | root, `srv/`, `contracts/`, `docker/hardhat/node/` (lockfiles, via `yarn up -R`) | cross-realm `sensitiveHeaders` arrays; not reachable today (the code never sets `sensitiveHeaders`). `npmPreapprovedPackages` entry in the root `.yarnrc.yml` until 2026-11-01 |

## Open advisories

What `yarn npm audit --all --recursive` still reports after the in-major
refresh of 2026-10-31 (F6 of `docs/todo/ROADMAP_cg-box.md`), and why each entry
is still there. Yarn's audit also lists **deprecated** packages (no advisory
id); those are counted but only named per chain below. Re-run the audit in
every workspace when updating this list and replace it as a whole.

| Workspace | Before → after the refresh |
|---|---|
| root | 171 → 27 (critical 3 → 0, high 54 → 4; the unused Truffle devDependencies were removed) |
| `srv/` | 139 → 44 (critical 5 → 2, high 65 → 20) |
| `sdk/` | 28 → **0** |
| `contracts/` | 234 → 92 (critical 12 → 2, high 91 → 28) |
| `docker/hardhat/node/` | 43 → 42 (high 15 → 14; its lockfile was already resolved fresh on 2026-10-31) |

The two fixes that were still younger than 7 days (`joi` 17.13.9,
`follow-redirects` 1.16.2) were taken under the 3-day rule — see the
[security-fix log](#security-fix-log).

**Not fixable within the current majors:**

- **Truffle chain** (`contracts/` only, pulled in by `solidity-bytes-utils` →
  `@truffle/hdwallet-provider@latest`): `web3` 1.10 /
  `web3-provider-engine` / `ethereumjs-*` / `level*` / `request` / `swarm-js`
  bring `form-data` 2.3.3 (critical GHSA-fjxv-7rqg-78g4, high
  GHSA-hmw2-7cc7-3qxx), `tar` 4.4.19 (critical GHSA-23hp-3jrh-7fpw + 12 more),
  `secp256k1` 4.0.3 (high GHSA-584q-6j8j-r5pm), `semver` 5.4.1 (high
  GHSA-c2qf-rxjj-qqgw), `ws` 3.3.3 (high GHSA-3h5v-q93c-6h6q,
  GHSA-96hv-2xvq-fx4p), `request` (GHSA-p8p7-x288-28g6), `qs` 6.5.5,
  `tough-cookie` 2.5.0, `bn.js` 4.11.6 (GHSA-378v-28hj-76wf), `web3-core-*`
  (low) and ~20 deprecations. Truffle is discontinued; there is no fixed
  release. The root workspace had the same chain through the unused
  devDependencies `@truffle/hdwallet-provider` and `truffle-flattener`; both
  were removed on 2026-10-31 (maintainer decision), together with
  `tools/generateFlattenedSourceCode.sh`, the only caller of
  `truffle-flattener`, which pointed at a `contracts/src/` directory that has
  never existed. In `contracts/` the chain goes with the open `contracts/`
  extraction decision ("Maintainer decisions needed" in `docs/todo/TODO.md`).
- **Wallet stack** (wagmi 2 / RainbowKit 2 / WalletConnect + Reown AppKit 1.7 /
  Coinbase SDKs, root): `zod` 3.22.4/3.25.76 (high GHSA-mrhx-c7xc-m3w5, fixed
  only in zod 4; `@reown/appkit-wallet` pins 3.22.4 exactly), `ws` 8.18.0
  (high GHSA-96hv-2xvq-fx4p, moderate GHSA-58qx-3vcg-4xpx — through the
  `viem` 2.23.2 copy `@walletconnect/utils` pins exactly; Node-only, the
  browser build uses the native WebSocket), `decode-uri-component` 0.2.2 (high
  GHSA-qr28-fpjm-wq7f, via `query-string` 7.1.3 pinned by
  `@walletconnect/utils`), `deepmerge` 4.3.1 (low GHSA-gcqx-w48m-w2h4, via
  `@vanilla-extract/css`; no fixed release exists), `uuid` < 11.1.1
  (GHSA-w5hq-g745-h8pq, only `v3`/`v5`/`v6` with a caller-supplied buffer),
  and the deprecated `@metamask/sdk*`, `@walletconnect/*` 2.21,
  `@safe-global/safe-gateway-typescript-sdk`, `@paulmillr/qr`. Fix path: the
  wagmi 3 / RainbowKit majors (Renovate dashboard).
- **react-router 6.30.6** (root): GHSA-wrjc-x8rr-h8h6 (moderate, backslash
  open redirect) and GHSA-337j-9hxr-rhxg (moderate, SSR hydration
  `deserializeErrors()`, not used by this SPA) are fixed only in 7.18.0 —
  wave M3.
- **`js-cookie` 2.2.1** (root, high GHSA-qjx8-664m-686j): via `react-use`
  17.6.0, which `@giphy/react-components` pins exactly; only `react-use`'s
  `useCookie` hook uses it, and the Giphy bundle does not.
- **Build and test tooling** (root, `srv/`): `minimatch` < 11.0.1
  (GHSA-g3hv-75wg-m249) and `glob` 9–14.0.1 (GHSA-3g3m-2fjr-6pw4) under
  typescript-eslint, eslint-plugin-react, workbox-build 7.4.1, jest and
  typeorm 0.3 (glob patterns come from our own config, no AbortSignal);
  `postcss-selector-parser` 6.0.10 (GHSA-rj75-hqrm-r3gf, pinned exactly by
  `@tailwindcss/typography`; parses our own CSS at build time); `deepmerge`
  via jest-config; deprecated `eslint` 9 (ESLint 10 is a major) and
  `intersection-observer` (`@giphy/react-components`).
- **bcrypt 5 install chain** (`srv/`): `tar` 6.2.1 (critical
  GHSA-23hp-3jrh-7fpw + 11 high/moderate) and the deprecated `npmlog`,
  `gauge`, `are-we-there-yet`, `rimraf` 3, `glob` 7, `inflight` under
  `@mapbox/node-pre-gyp` 1.0.11. Install-time only: the images build bcrypt
  from source (`npm_config_build_from_source=bcrypt`), so node-pre-gyp never
  unpacks a downloaded archive. bcrypt 6 (a major, Renovate dashboard) drops
  node-pre-gyp.
- **`xmldom` 0.1.31** (`srv/`, critical GHSA-crh6-fp67-6883 + 15 more): via
  `xtraverse` 0.1.0 ← `passport-twitter` 1.0.4 (the last release), which
  parses error responses from Twitter's API with it — input only from
  `api.twitter.com` over TLS, during the Twitter login flow. No fixed release
  of the chain exists.
- **`zod` 3.25.76** (`srv/`, high GHSA-mrhx-c7xc-m3w5): via `chromium-bidi`
  under puppeteer 25.5.0; it validates the local puppeteer ↔ Chrome protocol,
  not external input. puppeteer ≥ 25.16 moves to zod 4 — that bump waits for
  the Renovate `puppeteer` PR with its Chrome pin update.
- **`elliptic` 6.6.1** (root, `srv/`, low GHSA-848j-6mx2-7j84): no fixed
  release; via `@metamask/eth-sig-util` 4 → `ethereumjs-util` 6 (eth-sig-util
  5+ is a major).
- Deprecations without an advisory: `ethereumjs-abi` (root and `srv/`, via
  `@metamask/eth-sig-util` 4), `yaeti` (root and `srv/`, via `websocket` ←
  protoo-client / protoo-server), and in `srv/` `@smithy/core` 3.36.2
  (`@aws-sdk/client-s3`; the replacement 3.38.1 is younger than 7 days),
  `node-domexception` (`formdata-polyfill`), `whatwg-encoding` (cheerio ←
  open-graph-scraper).
- **Hardhat 2 toolchain** (`contracts/`, `docker/hardhat/node/`; dev and
  deploy tooling, never part of a deployed artifact): `undici` 5.29.0 via
  `@nomicfoundation/hardhat-verify` 2 (16 advisories, high incl.
  GHSA-2m5v-pch6-74hx), `adm-zip` 0.4.16 via hardhat (7, high), `tmp` 0.0.33
  (high GHSA-ph9p-34f9-6g65) via `solc`,
  `serialize-javascript` 6.0.2 (high GHSA-5c6j-r48x-rmvq), `diff` 7 and `glob`
  10 via mocha 11, `ws` 8.18.0 via `@ethersproject/providers` 5, `cookie`
  0.4.2 via `@sentry/node` 5, `uuid` 8, `@fastify/busboy` 2.1.1, plus the
  Truffle chain above in `contracts/`. Fix path: Hardhat 3 (a major) or the
  `contracts/` extraction decision in `docs/todo/TODO.md`.

### Held back on purpose (2026-10-31)

In-major updates the F6 refresh deliberately did not take:

| Package (workspace) | Held at | Available | Why |
|---|---|---|---|
| `mediasoup` (`srv/`), `mediasoup-client` (root) | 3.23.2 / 3.21.0 | 3.31.0 / 3.25.3 | the worker binary pin in `docker/backend/fetch_mediasoup_worker.sh` has to move in the same change, and the call subsystem has no automated tests (manual two-peer pass needed) — Renovate's `mediasoup` group |
| `puppeteer` (`srv/`) | 25.5.0 | 25.16.0 | the Chrome for Testing pin in `docker/backend/fetch_chrome.sh` has to move in the same change — Renovate's `puppeteer` group (also clears the `zod` advisory above) |
| `@openzeppelin/contracts` (`contracts/`) | 5.0.2 | 5.7.0 | it is compiled into the repository's contracts: a bump changes their bytecode against what was deployed and verified on-chain, so redeploys / explorer re-verification would no longer reproduce. The maintainer decides (see `docs/todo/TODO.md`) |
| `typescript` (`contracts/`, `docker/hardhat/node/`) | `~6.0.3` (was `>=4.5.0`, then `~5.4.5`) | 7.x | a tilde range, not an open one: a lockfile refresh must not jump majors, and with Hardhat's ts-node an incompatible pair crash-loops (same fix the dev-chain image got in 0b6e48e). Moved to 6.0 with wave M1 (2026-10-31; Hardhat 2.29.1 + ts-node 10.9.2 verified: compile, `hardhat node`, `hardhat run` with and without `--typecheck`). TypeScript 7 ships no compiler API, which ts-node needs |
| `@types/node` (`contracts/`) | `^20.19.43` (was `>=16.0.0`) | 26.x | same reason — no major jump through an open range. `docker/hardhat/node/` still declares `>=16.0.0` and locks 26.6.5 (resolved fresh on 2026-10-31); harmless for a types-only package that Hardhat's transpile-only ts-node ignores at runtime, but the two files differ here |

Also not taken: next minor lines of 0.x packages (semver-major, e.g. slate
0.147) and anything the age gate still blocked.

## Mechanisms

### npm (Yarn)

- **Age gate** — `npmMinimalAgeGate: 1w` in every `.yarnrc.yml`: root,
  `srv/`, `sdk/`, `docker/hardhat/node/`; `contracts/` inherits the root file
  (Yarn reads every `.yarnrc.yml` from the working directory up). The gate
  applies to new resolutions; it never downgrades what a lockfile already pins.
  Yarn's own default would be `1d`.
- **Security fixes (3–7 days old)** — an **exact-version** entry in
  `npmPreapprovedPackages` in the root `.yarnrc.yml` (e.g. `"joi@18.3.1"`;
  Yarn 4.18.1 matches it as a descriptor, so only that version skips the age
  check), with a comment naming the advisory id and the publish date; then
  `yarn up <pkg>@<range>` / `yarn up -R <pkg>` in each affected workspace.
  `srv/`, `sdk/`, `contracts/` and `docker/hardhat/node/` inherit the root
  list when Yarn runs inside the checkout (none of their own files sets the
  key); the image builds install with `--immutable` and resolve nothing, so
  they need no entry. Add a row to the security-fix log in the same change,
  and remove the entry once the version is 7 days old (at the latest with the
  next lock file maintenance). Never a name glob, never a range.
- **Exceptions in Yarn** (below 3 days for a security fix, below 7 for
  anything else; maintainer approval required) — per command,
  `yarn add|up --no-time-gate <pkg>` (the flag exists on both commands in Yarn
  4.18.1), or the same exact-version `npmPreapprovedPackages` entry. Either
  way the exception gets a row in the exception log; remove the entry again
  once the version has aged past the gate.
- **Lockfiles everywhere, installed immutably** — every install path runs
  `yarn install --immutable`, so an install never resolves anything the
  reviewed lockfile does not already pin: the backend image builds
  (`docker/backend/Dockerfile*`), the Hardhat dev-chain image
  (`docker/hardhat/Dockerfile`, own `docker/hardhat/node/yarn.lock` since
  2026-10-31), the build scripts (`docker/build.sh`, `docker/updateBackend.sh`,
  `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh`, root + `srv/` +
  `contracts/`) and the migration tools (`tools/makeMigration.sh`,
  `tools/revertLastMigration.sh`, `tools/testEntities.sh`). Changing
  dependencies therefore means running a plain `yarn install` / `yarn add`
  (in `./run.sh shell`) and committing the updated lockfile; the build
  scripts then fail loudly if a lockfile is stale. The exception are the
  frozen legacy Azure pipelines (`pipelines/*.yml`), which still run a bare
  `yarn` (age gate and `enableScripts: false` are re-appended there, but the
  install is not immutable).
- **Install scripts off** — `enableScripts: false` plus a per-package
  `dependenciesMeta.<pkg>.built: true` allowlist; see
  [README §2](README.md#package-manager-hardening).
- **Git dependencies** — `approvedGitRepositories` in the root `.yarnrc.yml`
  lists the one git dependency any lockfile contains
  (`https://github.com/ethereumjs/ethereumjs-abi.git`, commit-pinned in
  `contracts/yarn.lock` via `solidity-bytes-utils` →
  `@truffle/hdwallet-provider`; the root `yarn.lock` lost it when the unused
  Truffle devDependencies were removed on 2026-10-31). Yarn 4.18.1's default
  is "none"; once `contracts/` no longer needs it, the allowlist can go.
  Note the limit, verified in the Yarn 4.18.1 bundle: for `github.com`
  repositories Yarn first downloads the commit's archive over HTTPS and only
  falls back to `git clone` if that fails — the allowlist guards the clone
  path. The lockfile checksum covers the result either way.
- **Yarn itself** — `packageManager` in each `package.json` pins the version
  **and** a `+sha512.` hash; Corepack refuses a Yarn binary that does not
  match. The hash is the sha512 of the release's `bin/yarn.js` (not of the npm
  tarball).

### Docker images

Every image that is pulled rather than built here is pinned as
`name:version@sha256:<index digest>` — in Dockerfile `FROM` lines and in
compose `image:` lines. The digest is the **multi-arch index** digest (what
`docker buildx imagetools inspect` prints as `Digest:` with an
`application/vnd.oci.image.index.v1+json` media type), never a per-platform
manifest digest. With both tag and digest present, Docker pulls by digest;
the tag is documentation (and what Renovate uses to find newer versions).

Updating a pin by hand:

1. Pick the version. `curl -s "https://hub.docker.com/v2/namespaces/library/repositories/<repo>/tags?name=<prefix>&page_size=100"`
   lists tags with `last_updated`; choose the newest tag whose last push is
   ≥ 7 days old and that no longer moves (a full `x.y.z` patch tag once the
   next patch exists).
2. `docker buildx imagetools inspect <repo>:<tag>` → copy the `Digest:` line.
3. Write `<repo>:<tag>@sha256:<digest>` everywhere the image is used (the Node
   image appears in `docker/node/Dockerfile`, `docker/hardhat/Dockerfile`,
   `docker/backend/Dockerfile` and `docker/backend/Dockerfile_dev_stage_0`;
   the alpine helper image is `HELPER_IMAGE` in
   `docker/selfhost/migrate_seaweed_volumes.sh`).
4. Rebuild and run the affected checks (see the image's section in
   [README](README.md)).

`cryptogram/*` and `commonground/*` images are built locally from these
Dockerfiles and carry no digest (Renovate skips them).

### apt (Debian)

The Debian-based images that install packages (`docker/backend/Dockerfile`,
`docker/backend/Dockerfile_dev_stage_0`) switch apt to a dated
`snapshot.debian.org` archive: the timestamp **of the Debian rootfs underneath
the pinned node image**. debuerreotype records it as a comment in
`/etc/apt/sources.list.d/debian.sources` when it builds the official
`debian:trixie` image; the node image is built on top of that rootfs later,
and its own layers may contain slightly newer packages from the live mirror
(apt never downgrades them). The Dockerfile reads the timestamp, points
`debian` and `debian-security` at `http://snapshot.debian.org/archive/<archive>/<timestamp>`,
fails the build with an explanatory message if the comment is missing or any
`deb.debian.org` source is left, sets `Acquire::Retries "3"` (the snapshot
service is rate-limited) and disables only apt's `Valid-Until` check
(snapshot Release files are past it by design — signatures are still verified
against the image's Debian keyring).

Chosen over pinning exact package versions because the regular Debian mirrors
keep only the newest version of each package: an exact-version pin breaks the
build as soon as a security update supersedes it, and it fixes only the
packages named, not their dependencies. A snapshot fixes the whole package
universe, and deriving it from the base image keeps it consistent with what
the image already contains, keeps the 7-day rule automatically (the snapshot
predates the image push), and needs no second value to maintain: bumping the
Node image digest moves the apt snapshot with it. A Debian security fix
therefore arrives with the next base-image digest bump — or, if it cannot
wait, as a logged exception.

`docker/node/Dockerfile` installs no apt packages at all.

### Binary downloads

Every binary a build fetches outside a package manager is verified against a
hash pinned in the repository:

| Artifact | Where | Verification |
|---|---|---|
| NSFW model (`onnx-community/nsfw_image_detection-ONNX`) | `docker/backend/download_model.sh` | pinned HuggingFace commit + sha256 per file |
| mediasoup worker (prebuilt, per arch × build-host kernel major) | `docker/backend/fetch_mediasoup_worker.sh` | sha256 per asset, taken from the `digest` GitHub lists for the release assets; mediasoup's own postinstall download (no hash check, silent from-source fallback) is switched off via `MEDIASOUP_WORKER_BIN`. Kernels older than 6 get the kernel6 asset (mediasoup publishes none older; the suffix only names the CI runner — kernel6 = Ubuntu 22.04, kernel7 = Ubuntu 26.04 — and the worker has had no io_uring code since 3.20.7); a newer kernel major than the pinned assets fails the build with instructions. A self-test (`mediasoup-worker` must exit 41 without its environment) fails the build if the binary does not run. |
| Chrome for Testing (puppeteer's browser) | `docker/backend/fetch_chrome.sh` | sha256 recorded on first download (2026-10-31), cross-checked against the md5 Google Cloud Storage reports for the object (`x-goog-hash`). Google publishes no checksums, so this proves "same bytes as then", not provenance. puppeteer's own download (no hash check) is switched off via `PUPPETEER_SKIP_DOWNLOAD`. Runtime libraries come from the archive's `deb.deps` via apt (snapshot above). **x86_64 only**: Chrome for Testing has no linux-arm64 build, so on other architectures the script installs nothing and writes `/opt/chrome/UNAVAILABLE`; the image still builds, and only the social preview images (`htmlToImage`) fail. |
| Corepack (not bundled with Node ≥ 25) | `docker/node/Dockerfile`, `docker/hardhat/Dockerfile`, `docker/backend/Dockerfile*` | npm tarball, sha512 pinned (the registry's `integrity`, hex) |
| Yarn | via Corepack | `packageManager` `+sha512.` hash |
| bcrypt native addon | backend images, builder | **no binary download any more**: `npm_config_build_from_source=bcrypt` makes node-pre-gyp compile it from the lockfile-checksummed npm sources instead of fetching an unverified GitHub prebuild, and `npm_config_nodedir=/usr/local` makes node-gyp use the image's own Node headers instead of downloading them |
| sharp, onnxruntime-node, esbuild, unrs-resolver | — | binaries ship inside npm packages, covered by the lockfile checksums |

`docker/backend/check_pinned_binaries.sh` runs after `yarn install` in the
backend images and **fails the build** when the installed `mediasoup` or
`puppeteer` expects a different worker / Chrome than the pinned one — so a
dependency bump cannot silently ship a mismatched binary (the Chrome
comparison is skipped where `/opt/chrome/UNAVAILABLE` exists).

In the builder image (`docker/node/Dockerfile`) the mediasoup worker and the
browser are not needed at all: `PUPPETEER_SKIP_DOWNLOAD=true` and a
`MEDIASOUP_WORKER_BIN` pointing at a non-existent path stop both postinstall
downloads, and the bcrypt variables above apply there too (npm prints an
"Unknown env config" warning for the two `npm_config_*` variables on every
`npm`/`npx` call in the builder — expected, harmless).

## Renovate

Renovate runs as the **Mend Renovate GitHub app** (roadmap decision 14; the
maintainer installs it on the GitHub repository) with `renovate.json` at the
repository root:

- `minimumReleaseAge: "7 days"` with `internalChecksFilter: "strict"` — no
  branch or PR is created for a release until it is a week old.
- `vulnerabilityAlerts.minimumReleaseAge: "3 days"` — vulnerability-alert PRs
  (the security-fix rule) wait 3 days instead. Precedence, checked in the
  renovate 44.181.0 sources: each alert becomes a package rule whose `force`
  carries the whole `vulnerabilityAlerts` object, and `mergeChildConfig`
  re-applies `force` after every merge, so it wins over the global
  `minimumReleaseAge` and over every `packageRules` entry; the object is
  `mergeable`, so Renovate's own defaults for it (no schedule, immediate PR
  creation, `rangeStrategy: update-lockfile`, `[SECURITY]` suffix) stay in
  effect. **Caveat:** Renovate updates `yarn.lock` with the repository's Yarn
  and `.yarnrc.yml`, so between day 3 and day 7 Yarn's own `1w` gate refuses
  the fixed version and the PR shows a lockfile/artifact error — add the
  exact `npmPreapprovedPackages` entry (and the log row) on the PR branch and
  let Renovate retry. TODO(verify) on the first real vulnerability PR.
- Docker images in Dockerfiles and compose files are kept digest-pinned
  (`docker:pinDigests`); digest refreshes and minor/patch versions arrive as
  one grouped weekly PR.
- **Nothing auto-merges** (`automerge: false`, `platformAutomerge: false`).
- **Lock file maintenance** monthly (1st of the month, 00:00–06:59
  Europe/Berlin): one PR that re-resolves every `yarn.lock` within the
  existing ranges, so indirect dependencies do not stay on old versions for
  good. Renovate's `minimumReleaseAge` does not apply to it — Yarn's own
  `npmMinimalAgeGate: 1w` from the repository's `.yarnrc.yml` does, because
  Renovate runs the pinned Yarn for the re-resolution. TODO(verify): on the
  first lock-file-maintenance PR, spot-check that no resolved version is
  younger than 7 days.
- PRs target `develop`, on Monday mornings (Europe/Berlin), grouped per
  workspace for minor/patch updates; at most 8 open / 4 per hour.
- **Majors** are only opened after approval on the Dependency Dashboard. The
  deferred majors (Express 5, react-router 7, Tailwind 4, Vite 8,
  TypeORM 1.x; decision 7) are disabled outright — they are done by hand in
  waves M2–M4; drop each from the list once its wave is merged. joi 18 and
  TypeScript 6 (wave M1) left the list with that wave: a joi 19 major is
  proposed normally (dashboard approval required). TypeScript majors stay
  disabled through a rule of their own — TypeScript 7 ships no compiler API
  yet, so ts-node (Hardhat in `contracts/` and `docker/hardhat/node/`),
  ts-jest (`srv/`) and typescript-eslint (supports < 6.1.0) cannot use it;
  re-enable it once they do.
- `mediasoup` and `puppeteer` get their own PRs with a note to update the
  pinned binaries (see above).
- Two regex managers cover pins outside Dockerfiles/compose files and
  `package.json`: `HELPER_IMAGE` in `docker/selfhost/migrate_seaweed_volumes.sh`
  (tag + digest, grouped with the docker images) and `COREPACK_VERSION` in the
  four Node Dockerfiles (one `corepack` PR whose note asks for the matching
  `COREPACK_SHA512` — the builds fail until it is updated).
- Locally built images (`cryptogram/*`, `commonground/*`, including
  `FROM commonground/backend_stage_0`) are disabled — there is nothing to look
  up.
- **Yarn** (`packageManager`) is not updated by Renovate: the Corepack hash
  and the Yarn pre-fetch in `docker/node/Dockerfile` must move together (see
  below). The Chrome for Testing and mediasoup-worker pins follow the
  puppeteer / mediasoup npm updates (see their PR notes). Legacy `pipelines/`
  and the vendored `contracts/staking/lib/` are ignored.

**Two files, one config.** The Mend app reads its config from the
repository's **default branch** on GitHub, which stays `main` (`develop` is the
development branch; deployments are later made from `main`). `main` therefore
carries only a stub `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "description": "Stub: the real Renovate config lives in renovate.json on the develop branch.",
  "baseBranchPatterns": ["develop"],
  "useBaseBranchConfig": "merge"
}
```

With `useBaseBranchConfig: "merge"` Renovate lays the `renovate.json` of each
base branch over the default branch's file, so the rules in this repository's
`develop` copy are the ones that apply, and every PR targets `develop`. The
stub is not meant to change; all edits go to the `develop` copy. When `develop`
is merged into `main`, the full file replaces the stub — equivalent, since it
targets `develop` as well (resolve a conflict in this file in favour of
`develop`).

Dependabot **alerts** are enabled for the repository: Renovate's
`vulnerabilityAlerts` only sees advisories GitHub has raised as Dependabot
alerts. Dependabot *security updates* (its own PRs) stay off — they would
bypass the 3-day security-fix minimum.

Renovate 44 defaults to `minimumReleaseAgeBehaviour: timestamp-required`: a
release without a publish timestamp counts as *not yet aged* and is held back,
never let through. TODO(verify): how that plays out for Docker
**digest-only** updates (a re-pushed tag) — until seen on the first real PRs,
reviewers check the publication date of every digest bump by hand (step 1
above).

Checked on 2026-10-31 with renovate 44.181.0 (published 2026-10-23, run with
`npm exec --before=2026-10-24`): `renovate-config-validator --strict` passes,
and a local dry run (`--platform=local --dry-run=lookup`, docker and regex
managers) extracted every pinned image plus `HELPER_IMAGE` and the four
`COREPACK_VERSION` lines, skipped all locally built images, and held every
available tag update back as pending under the 7-day rule (all of them were
younger than a week). After `vulnerabilityAlerts.minimumReleaseAge` moved to
`"3 days"` the validator (`--strict`, same pinned version) still passes.

## Manual update procedures

`tools/update-pins.sh` prints the values for each of these (it changes no
file, verifies every download against the registry's `integrity` or the
provider's checksum, and prints the publication date to check against the
7-day rule).

**Yarn.** Pick a `@yarnpkg/cli-dist` 4.x version ≥ 7 days old
(`npm view @yarnpkg/cli-dist time`); `tools/update-pins.sh yarn <v>` prints the
`yarn@<v>+sha512.<hash>` value (the hash is the sha512 of `bin/yarn.js`). Put
it into `packageManager` in `package.json`, `srv/package.json`,
`sdk/package.json` and `docker/hardhat/node/package.json`, and into the
`corepack install -g` line in `docker/node/Dockerfile`. Run `yarn install` in
each workspace and commit any lockfile metadata change.

**Corepack.** Renovate opens the version bump; `tools/update-pins.sh corepack
<v>` prints the `COREPACK_SHA512` to add to the same PR, in all four
Dockerfiles that carry it.

**mediasoup / puppeteer.** Renovate opens the npm bump;
`tools/update-pins.sh mediasoup <v>` prints the asset hashes for
`docker/backend/fetch_mediasoup_worker.sh`, and `tools/update-pins.sh chrome
<PUPPETEER_REVISIONS.chrome>` the sha256 for `docker/backend/fetch_chrome.sh`
(see the script headers).
