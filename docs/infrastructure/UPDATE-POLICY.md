> Status: verified against commit 5f73578, 2026-10-31; example image line updated for Valkey against commit ff0da06 (+ chore/f4-valkey), 2026-10-31

# Update policy: 7-day minimum release age

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

The cost is that an urgent security fix waits a week too. That is what the
exception log is for.

## Exceptions

An exception is allowed **only with the maintainer's explicit approval** and is
recorded here **in the same change** that uses it (date, exact package/version,
reason, who approved). One row per artifact; an exception covers that version
only, never later ones.

| Date | Package / version (ecosystem) | Reason | Approved by |
|---|---|---|---|
| — | — | — | — |

## Mechanisms

### npm (Yarn)

- **Age gate** — `npmMinimalAgeGate: 1w` in every `.yarnrc.yml`: root,
  `srv/`, `sdk/`, `docker/hardhat/node/`; `contracts/` inherits the root file
  (Yarn reads every `.yarnrc.yml` from the working directory up). The gate
  applies to new resolutions; it never downgrades what a lockfile already pins.
  Yarn's own default would be `1d`.
- **Exceptions in Yarn** — either per command, `yarn add|up --no-time-gate
  <pkg>` (the flag exists on both commands in Yarn 4.18.1), or persistently via
  `npmPreapprovedPackages` in the relevant `.yarnrc.yml` (an array of package
  name globs or descriptors that skip the age check). Either way the exception
  gets a row in the log above; remove a `npmPreapprovedPackages` entry again
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
  `yarn.lock` and `contracts/yarn.lock`); Yarn 4.18.1's default is "none".
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
  branch or PR is created for a release until it is a week old (also for
  vulnerability-alert PRs).
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
  seven deferred majors (Express 5, react-router 7, Tailwind 4, Vite 8,
  TypeORM 1.x, joi 18, TypeScript 6; decision 7) are disabled outright — they
  are done by hand in waves M1–M4; drop each from the list once its wave is
  merged.
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
bypass the 7-day rule.

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
younger than a week).

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
