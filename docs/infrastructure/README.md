> Status: verified against commit 8613352a4, 2026-08-04; image-moderation
> additions against the fix/image-filter-review-53 branch, 2026-08-15; local
> TLS mode, call ports, root builds and startup ordering against commit
> a5633d5be (+ fix/selfhost-local-test), 2026-10-27; npx/lockfile-refresh
> notes, chunking figures, tests and the reference-client pipeline against
> commit 935232158, 2026-10-31; dev env template (`docker/.env.example`,
> `docker/ensureEnv.sh`, generated `s3.json`, existing-checkout steps) and
> `s3.selfhost.json` ownership against commit 69999fa20 (chore/env-template),
> 2026-10-31

# Common Ground Infrastructure Documentation

This document covers the full infrastructure stack for Common Ground, a Discord alternative built as a Docker Compose application with a React frontend, Node.js backend, PostgreSQL database, Redis caching, S3-compatible object storage, and WebRTC media server.

There are two deployment shapes, each with its own compose file:

- **Dev / internal stack** — `docker/docker-compose.yml`, driven by `run.sh`. Includes a local Hardhat dev chain and test-contract deployment; TLS is self-signed; `DEPLOYMENT` is configurable.
- **Self-hosted single-server production** — `docker/docker-compose.selfhost.yml`, driven by `docker/selfhost/selfhost.sh`. Caddy terminates real Let's Encrypt TLS (or, for LAN/test instances, TLS from its own local CA), `DEPLOYMENT=prod` on any domain, no dev chain, secrets are generated. See [section 7](#7-self-hosted-single-server-deployment).

---

## Table of Contents

1. [Docker Compose Stack (dev)](#1-docker-compose-stack-dev)
2. [Build Process](#2-build-process)
3. [nginx Configuration](#3-nginx-configuration)
4. [Environment Variables](#4-environment-variables)
5. [CI/CD Pipelines](#5-cicd-pipelines)
6. [Developer Workflow](#6-developer-workflow)
7. [Self-Hosted Single-Server Deployment](#7-self-hosted-single-server-deployment)

---

## 1. Docker Compose Stack (dev)

**File:** `docker/docker-compose.yml`

All services run on an internal Docker network called `cryptogram` (legacy name; `attachable`, bridge mode). The compose file no longer declares a top-level `version:` key (Compose v2 ignores it).

### Active Services

#### `db` (PostgreSQL)
- **Image:** `cryptogram/db` (custom build from `docker/db/`)
- **Base image:** `postgres:14-alpine`
- **Purpose:** Primary relational database. Stores all application data: users, communities, messages, channels, contracts, etc.
- **Port:** `127.0.0.1:5432:5432` (localhost only)
- **Command:** `postgres -c config_file=/etc/postgresql/postgresql.conf`. This explicit `config_file` flag is required — without it Postgres ignores the mounted `postgresql.conf` and runs on image defaults (this was a real bug: the config was mounted but never loaded).
- **Init script:** `docker/db/init.sh` runs on first startup via `docker-entrypoint-initdb.d`. Creates the `cryptogram` database plus the `writer` and `reader` login roles with passwords from `PG_WRITER_PASSWORD` / `PG_READER_PASSWORD`. Skips creation if the `cryptogram` database already exists. (The mediasoup DB role is provisioned separately by the migration runner, which receives `PG_MEDIASOUP_PASSWORD`.)
- **Volumes:**
  - `pgdata:/var/lib/postgresql/data` — persistent database storage
  - `./db/postgresql.conf:/etc/postgresql/postgresql.conf` — the tuned config. It is a full Postgres 14 default file with only three settings changed: `listen_addresses='*'`, `max_connections=200`, `maintenance_work_mem=64MB`.
- **Health check:** `pg_isready -U postgres -h 127.0.0.1`, interval 1m, timeout 5s, 5 retries; probed every 2s during a 2m `start_period` so `migrate-db` (which waits for `service_healthy`) isn't held for a full minute on first boot. It probes over TCP on purpose: on first boot the image's init runs a temporary server that answers on the unix socket only, and a socket probe would report healthy before the real server listens. Same in both compose files.
- **Environment:** `POSTGRES_DB=postgres`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD` (from `PG_SU_PASSWORD`), `PG_WRITER_PASSWORD`, `PG_READER_PASSWORD`
- **Shared memory:** 256 MB (`shm_size`)
- **Stop behavior:** SIGINT with 1-minute grace period
- **Restart:** `unless-stopped`

#### `redis`
- **Image:** `redis:6.2.7-alpine`
- **Command:** `redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 6GB --save ""`
- **No persistence** (`--save ""`) and **no eviction policy** (the default `noeviction`): sessions and the captcha HMAC key are not cache entries and must never be evicted. Nothing survives a restart — a restart logs everyone out.
- **Purpose:** one instance serves all three historical roles, with pairwise disjoint key prefixes:
  - user session store (`express-session` / `connect-redis`, `sess:`)
  - pub/sub adapter for Socket.IO (`v2:`), distributing real-time events across backend instances
  - general-purpose cache (rate limiting, bot presence, captcha, user data)
- Until 2026-08-01 this was three identically configured instances (`redis-sessions`, `redis-socketio`, `redis-data`); the split was mechanical, never load-bearing. `maxmemory` is now the shared budget for all of it.
- **Backend connection:** `srv/redis/index.ts` resolves `process.env.REDIS_URL || 'redis://redis:6379'`, password from the Docker secret `redis_password` or `REDIS_PASSWORD`, and hands both to `srv/redis/client.ts` — the only file that calls `createClient`, and where `RESP: 2` is pinned. Neither compose file sets `REDIS_URL`; it exists for deployments that run Redis somewhere else.

> The former `redis-blockscout` service (a cache for the deleted optional Blockscout explorer stack) was removed from the compose file on 2026-08-02.

#### `api`
- **Image:** `cryptogram/backend` (built from `docker/backend/Dockerfile_dev_stage_1`)
- **Purpose:** Main HTTP REST API server. Handles all `/api/v2/*` requests plus the Bot API v1 (`/BotV1/*`): authentication, community management, file uploads, messaging, contracts, notifications, Twitter/Lukso integrations, search, reporting, bots, and staking.
- **Command:** `node /dist/api.js`
- **Port:** Internal only (reached by nginx on port 4000 over the Docker network)
- **Depends on:** `db`, `redis`, `seaweed`, `memberlist`
- **Volumes:**
  - `./vapid_keys.json:/run/secrets/vapid_keys_json:ro` — VAPID keys for web push notifications
  - `./api_data:/api_data:ro` — static API data
- **Key environment variables:** `DB_TYPE=writer`, `PG_PASSWORD` (writer), `REDIS_PASSWORD`, `REDIS_SECRET`, `DEPLOYMENT`, `BASE_URL`, `CGID_URL`, `S3_SECRET`, `SENDGRID_API_KEY`, `GOOGLE_RECAPTCHA_SECRET_KEY`, Twitter OAuth credentials, the `STAKING_*` set, and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`).

#### `wsapi`
- **Image:** `cryptogram/backend`
- **Purpose:** WebSocket API server. Handles real-time communication at `/api/ws/` — message delivery, presence updates, typing indicators, etc.
- **Command:** `node /dist/wsapi.js`
- **Depends on:** `db`, `redis`
- **Key environment variables:** `DB_TYPE=writer`, `PG_PASSWORD`, `REDIS_PASSWORD`, `REDIS_SECRET`, `DEPLOYMENT`, `BASE_URL`, `CGID_URL`

#### `memberlist`
- **Image:** `cryptogram/backend`
- **Purpose:** Dedicated service for member-list queries. Offloads heavy member-list operations from the main API to avoid blocking other requests.
- **Command:** `node /dist/memberlist.js`
- **Depends on:** `db`

#### `job-runner`
- **Image:** `cryptogram/backend`
- **Purpose:** Background job processor. Runs scheduled and queued tasks: activity-score calculation, email sending, cleanup jobs, and the Spark staking-accrual job.
- **Command:** `node /dist/jobs.js`
- **Depends on:** `db`, `redis`, `seaweed`
- **Key environment variables:** the writer DB/Redis set, `S3_SECRET`, `SENDGRID_API_KEY`, and the `STAKING_*` set.

#### `mediasoup`
- **Image:** `cryptogram/backend`
- **Purpose:** WebRTC media server for voice/video calls. Uses the mediasoup library for SFU (Selective Forwarding Unit) functionality. Spawns one media worker per CPU core.
- **Command:** `node /dist/mediasoup.js`
- **Ports:**
  - `${EXTERNAL_LISTEN_IP}:4443:4443/tcp` — HTTPS signaling
  - `${EXTERNAL_LISTEN_IP}:40000-40099:40000-40099/udp` — RTP media transport (100 UDP ports). mediasoup also listens on TCP `40000+n` (ICE-TCP fallback, see [docs/realtime](../realtime/README.md#mediasoup-configuration)); the dev stack does not publish that, the self-host stack does.
- **Volumes:** `./nginx/certs:/dist/mediasoup/certs` — SSL certificates for DTLS (uses `nginx_certs/server-complete.pem` + `key.pem`)
- **Key environment variables:** `DB_TYPE=mediasoup`, `PG_PASSWORD` (from `PG_MEDIASOUP_PASSWORD`), `MEDIASOUP_ANNOUNCED_IP`, `DOMAIN`, `DEBUG=mediasoup*`, `INTERACTIVE=false`, `MEDIASOUP_DISABLE_LIBURING`, `LOCAL_CERTIFICATE_IP`
- **Depends on:** `migrate-db` with `condition: service_completed_successfully` — the `mediasoup` DB role is created by a migration (`1689160339881-addMediasoupRole`), so on a fresh database an earlier start fails with `password authentication failed for user "mediasoup"`. Same in the self-host stack.
- **Restart:** `"no"` — does not auto-restart in the dev stack.

#### `onchain`
- **Image:** `cryptogram/backend`
- **Purpose:** Blockchain event listener and token-gating engine. Monitors ERC-20/721/1155 balances across multiple chains, assigns roles based on token holdings, indexes staking events, and syncs on-chain data.
- **Command:** `node /dist/onchain.js`
- **Depends on:** `db`, `redis`
- **Key environment variables:** all `QUIKNODE_*` and `INFURA_LINEA` RPC endpoint URLs (ETH, BSC, Polygon/Matic, Gnosis/xDai, Fantom, Avalanche, Arbitrum, Optimism, Base, Linea, Arbitrum Nova, Celo, Polygon zkEVM, Scroll, zkSync, **and LUKSO — `QUIKNODE_LUKSO`, now a configurable endpoint like the others**), the `STAKING_*` set, and `RECALCULATE_BALANCES_AND_ROLES`.

#### `migrate-db`
- **Image:** `cryptogram/backend`
- **Purpose:** Database migration runner. Executes on startup to apply pending schema migrations (and provisions the mediasoup DB role).
- **Command:** `node /dist/migrateDb.js`
- **Depends on:** `db` with `condition: service_healthy` — `migrateDb.js` does not retry its connection, and on a fresh volume postgres initializes for several seconds.
- **Restart policy:** `deploy.restart_policy` on failure, max 2 attempts (Compose v2 maps it to the container's `on-failure:2`; the 2-second delay and 60-second window are Swarm-only). Does not run persistently. `mediasoup` waits for it to complete successfully.
- **Key environment variables:** `PG_SU_PASSWORD`, `PG_SU_NAME=postgres`, `PG_MEDIASOUP_PASSWORD`, `REDIS_PASSWORD`, `S3_SECRET`, `DEPLOYMENT`, `BASE_URL`

#### `seaweed` (SeaweedFS)
- **Image:** `chrislusf/seaweedfs:4.40` (pinned — do not run an untagged/`latest` image, and keep any deployment at ≥ 4.34 for the 2026 security fixes)
- **Purpose:** S3-compatible object storage for uploaded files and images. One all-in-one `weed server` process replaces the former `seaweedmaster` / `seaweedvolume` / `s3` trio (consolidated 2026-08-02).
- **Command:** `server -dir=/data -ip=seaweed -master.volumeSizeLimitMB=16 -volume.max=0 -volume.preStopSeconds=1 -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333 -s3.port.iceberg=0`
  - `-s3` implies `-filer`, so the single process runs master, volume server, filer and the S3 gateway.
  - `-volume.max=0` auto-sizes the volume count from free disk space instead of the default cap of 8 (which at a 16 MB volume-size limit would cap the store at 128 MB).
  - `-s3.port.iceberg=0` disables the Iceberg REST catalog that 4.40 otherwise starts on 8181 — nothing in this stack speaks Iceberg.
  - `weed server`, not `weed mini` (upstream's default CMD), on purpose: `mini` bundles WebDAV, an Admin UI and the Iceberg catalog, enables an embedded IAM API on the S3 port by default, and upstream reserves the right to evolve its defaults — `server` keeps a stable flag surface and no extra listeners.
  - Single-copy replication via `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` / `..._OTHER=1`.
- **Ports (all internal to the `cryptogram` network):** S3 8333, master 9333, volume 8080, filer 8888, plus their gRPC siblings (port + 10000). **Only 8333 is consumed by anything else in the stack** — nginx proxies file requests to it and `srv/repositories/files.ts` uses it as its endpoint, both via the network alias `s3.local`.
- **Network alias:** `s3.local`
- **Volumes:** `./s3_config/s3.json:/etc/seaweedfs/s3.json:ro` (dev, generated by `docker/ensureEnv.sh`; `s3.selfhost.json` for self-host) and `seaweedfs-data:/data`
- **Data layout under `/data`:** volume blobs (`.dat`/`.idx`/`.vif`) at the root, filer leveldb in `filerldb2/`, master raft/sequence state in `m9333/`. Because blobs and filer metadata now share one volume, a filesystem snapshot of `/data` is atomic across both — which the former two-volume split could never be. See [docs/deployment](../deployment/) for the backup baseline.

**Storage engine of record (decision 2026-08-02).** SeaweedFS stays. A comparison against the alternatives (MinIO's community repo was archived read-only in April 2026) landed as follows:

- **RustFS — rejected.** Still pre-GA (`1.0.0-beta.12`), ~28 security advisories between Dec 2025 and Jul 2026 with no downward trend, documented unreviewed/LLM-reviewed merges of auth-relevant code, and an opaque MinIO-style `xl.meta` on-disk format. Not to be revisited before it has a year of boring GA history.
- **Garage (v2.3.0) and versitygw (v1.7.0) — credible, but not worth the move.** Garage is the community default for this profile and versitygw stores objects as plain POSIX files (the best possible backup story), but either swap means an S3-level data migration across every existing deployment — hosted and every self-host install — for no user-visible gain.
- The application's coupling is thin (`srv/repositories/files.ts` speaks plain S3 against one `cg-media` bucket), so a swap stays *possible*; re-evaluate only when a concrete need appears.

#### `nginx`
- **Image:** `cryptogram/nginx` (built from `docker/nginx/Dockerfile_dev`)
- **Purpose:** Reverse proxy and static file server. Routes traffic to backend services and serves the React frontend.
- **Ports:**
  - `${EXTERNAL_LISTEN_IP}:8000:80` — HTTP
  - `${EXTERNAL_LISTEN_IP}:8001:443` — HTTPS (self-signed certs for local dev)
- **Build args:** `NGINX_EXPOSED_ON=${LOCAL_CERTIFICATE_IP}` (injected into `nginx_dev.conf` at build time)
- **Depends on:** `api`

#### `hardhat`
- **Image:** `cryptogram/hardhat` (built from `docker/hardhat/`)
- **Purpose:** Local Ethereum development blockchain. Used for deploying/testing smart contracts locally. **Dev stack only** — not present in the self-host stack.
- **Command:** `npx hardhat node`
- **Port:** `${EXTERNAL_LISTEN_IP}:8545:8545` (JSON-RPC)
- **User:** `hardhat`

#### `cg-builder`
- **Image:** `commonground/node` (built from `docker/node/`)
- **Purpose:** Build container. Not a running service — invoked via `docker compose run` to execute build commands (yarn install, type-check/lint/`vite build`, backend `tsc` compile, contract deployment). Mounts the entire project directory.
- **User:** `${BUILDER_UID}:${BUILDER_GID}` (matches host user to avoid permission issues). The image (`docker/node/Dockerfile`) creates a `cg_env` group/user only for ids the `node:24.18-bookworm` base doesn't already have, so `1000` (the base's `node` user), `0` (root — e.g. a self-host operator building as root) and ids that collide with Debian system groups all build.
- **Volumes:** `../:/cg`, `builder-cache:/builder-cache` (persistent yarn cache)
- **Default command:** `echo "Not running interactive, exiting..."` (always invoked with explicit commands)

### Commented-Out Services (Not Active)

| Service | Purpose |
|---------|---------|
| `pgadmin` | PostgreSQL admin web UI (dpage/pgadmin4:5.5). Port `127.0.0.1:8080:80`. |

The formerly commented-out Blockscout explorer stack (`blockscout`, `blockscout-db`, `redis-blockscout`, `smart-contract-verifier`, `visualizer`) and its `docker/envs/` env files were deleted on 2026-08-02.

### Named Volumes

| Volume | Used By | Purpose |
|--------|---------|---------|
| `pgdata` | `db` | PostgreSQL data persistence |
| `pgadmin-data` | `pgadmin` (commented out) | pgAdmin data |
| `seaweedfs-data` | `seaweed` | File blobs, filer metadata and master state (one `/data` tree) |
| `builder-cache` | `cg-builder` | Yarn package cache across builds |

### S3 Configuration

**File:** `docker/s3_config/s3.json` (dev, gitignored, generated by `docker/ensureEnv.sh` from the `S3_SECRET` in `docker/.env` — see [section 4](#4-environment-variables)) / `docker/s3_config/s3.selfhost.json` (self-host, generated by `init.sh`)

The SeaweedFS S3-compatible API is configured with two identities:
- **`anonymous`** — read-only access to the `cg-media` bucket, so uploaded media can be fetched without authentication.
- **an admin identity** (`cg_admin_user`; the dev `s3.json` that was tracked until 2026-10-31 calls it `some_admin_user` — the name is only a label, nothing references it) — full access (Admin, Read, List, Tagging, Write) using access key `cgadmin` and a secret key matching the `S3_SECRET` environment variable. Presigned `/files/...` URLs generated by the backend are verified against this key by nginx's rewrite.

### SSL Certificate Generation (dev)

**Files:** `docker/nginx/certs/`

Self-signed certificates for local development are generated by the build scripts when `LOCAL_CERTIFICATE_IP` changes:
1. `recreate_root_cert.sh` generates a root CA.
2. `recreate_server_certs.sh` generates a server certificate signed by that CA, with SANs for `localhost`, `app.cg.local`, `127.0.0.1`, and the `LOCAL_CERTIFICATE_IP` value.
3. Certificates are mounted into the nginx and mediasoup containers.

The generated IP is stored in `nginx/certs/nginx_certs/certificate_ip` so builds can skip regeneration when it is unchanged.

### Network

Single network: `cryptogram` (attachable, bridge). All services communicate over it using Docker DNS (service names as hostnames).

---

## 2. Build Process

The dev build scripts live in `docker/` and are invoked through `run.sh`.

### Package-manager hardening

Both workspaces pin **Yarn 4.17.1** and configure two supply-chain controls in
`.yarnrc.yml` (root and `srv/`). They were added on 2026-08-04, the day the
"Shai-Hulud: Here We Go Again" npm worm poisoned ~440 packages (keyv, cacheable,
flat-cache, file-entry-cache and others) by publishing versions whose
`preinstall` hook ran on install alone. This repository was never in range of an
affected version, but both controls would have made it structurally impossible:

- **`enableScripts: false`** — no dependency may run install/build scripts.
  Packages that genuinely need to build opt in explicitly via
  `dependenciesMeta.<pkg>.built: true` in `package.json`. Current allowlist —
  root: `esbuild`; `srv/`: `bcrypt`, `mediasoup`, `puppeteer`,
  `unrs-resolver`. The four `node-gyp-build` natives (`bufferutil`,
  `utf-8-validate`, `keccak`, `secp256k1`) and `sharp` (≥0.33 installs the
  prebuilt `@img/*` packages) are deliberately NOT allowlisted: they load
  their shipped prebuilds without ever running an install script (verified in
  both workspaces). `contracts/` and `docker/hardhat/node/` have **no** allowlist
  on purpose — their Hardhat toolchains install and deploy fine with every build
  script disabled (the native crypto modules load their shipped prebuilds;
  no install script needed), which is verified, not assumed. Everything else that ships an install script here does
  nothing but print a message (`es5-ext`, `web3`, `web3-bzz`, `web3-shh`) or has
  a pure-JS fallback (`bigint-buffer`) and is
  deliberately left disabled — Yarn logs a `YN0004` warning for each, which is
  expected output, not a problem. Yarn ≥4.2 defaults this to `false`; the
  setting is written out anyway so the intent survives a version change.
- **`npmMinimalAgeGate: 1w`** — a version published less than a week ago is not
  considered for installation. Supply-chain waves of this kind are detected and
  purged within hours, so package age filters them out; `yarn npm audit` does
  **not** — during this attack no GHSA advisory existed for the highest-traffic
  poisoned packages. The gate applies to new resolutions only; it never
  downgrades what the lockfile already pins. Its cost is that an urgent security
  fix is delayed too — the escape hatch is `yarn up --no-time-gate <pkg>`, to be
  used deliberately and justified in the PR.

Yarn 4.1.0 had neither (its `enableScripts` default was `true`, contrary to what
the current yarnpkg.com docs say — the pinned binary is the authority), which is
why the version moved as part of the same change. The upgrade changed the
lockfile metadata format (8 → 10) but **no resolved version**. Note that 4.1.0
*hard-errors* on the unknown `npmMinimalAgeGate` key, so every place that
bootstraps a Yarn version has to stay at 4.17.1 or newer: `docker/build.sh`,
`docker/updateBackend.sh`, `docker/updateFrontend.sh`,
`docker/selfhost/selfhost.sh` and both Azure pipelines.

**Every install path in the repository is covered**, which took more than the two
main workspaces:

| Path | How it is covered |
|---|---|
| root, `srv/` | own `.yarnrc.yml` + `dependenciesMeta` allowlist |
| `contracts/` | inherits the root `.yarnrc.yml` (Yarn walks up); no allowlist needed |
| `docker/hardhat/node/` | **was the one unprotected path** — `docker/hardhat/Dockerfile` ran a bare `yarn`, i.e. the base image's Yarn 1.22, with no lockfile and scripts on. It now enables corepack, pins `packageManager: yarn@4.17.1`, and ships its own `.yarnrc.yml`. |
| backend image build | the copied `.yarnrc.yml` carries both controls (no `yarnPath` exists any more — corepack provisions the `packageManager`-pinned 4.17.1); verified by the `YN0004` warnings in the build output |
| Azure pipelines | the secure-file `.yarnrc.yml` **replaces** the repo's, so the pipelines re-append both settings after copying it — see the comment there |
| `npx` call sites | every call (`web-push` and `hardhat` in the build scripts, `truffle-flattener` in `tools/generateFlattenedSourceCode.sh`) resolves to a declared local dependency and passes `--no`, which turns a missing package into a loud failure instead of a silent registry download-and-run |

**Refreshing a lockfile within the existing ranges** needs both patterns:
`yarn up -R '*' '@*/*'`. Yarn's micromatch `*` does not cross `/`, so
`yarn up -R '*'` alone leaves every scoped package at its old resolution.
Before adding or bumping a package, also look at its publish date — the age
gate enforces a week, but a package that is a week old is not automatically a
trustworthy one.

### Full Build: `docker/build.sh` (`./run.sh build_full`)

The complete build pipeline, for first-time setup or full rebuilds.

**Steps (in order):**

1. **Stop and clean:** `docker compose down --remove-orphans`, then `docker compose build cg-builder`.
2. **Yarn 4.17.1 comes from corepack**: the `commonground/node` base image
   enables corepack and pre-fetches the `packageManager`-pinned release into a
   world-readable `COREPACK_HOME`, so builder runs need no bootstrap step and
   no network fetch. (The former "Missing .yarn directory" repair blocks and
   `yarn set version` calls are gone; on a dev host, run `corepack enable`
   once to get the same resolution outside the containers.)
3. **Generate SSL certificates:** compare `LOCAL_CERTIFICATE_IP` with the stored `certificate_ip`; if changed, regenerate root CA and server certs.
4. **Clear `backend/dist/` and `nginx/dist/`**, then install frontend dependencies (`docker compose run --rm cg-builder yarn`).
5. **Generate random build ID:** a random base64 string is written into `src/common/random_build_id.ts` for cache-busting / new-build detection.
6. **Type-check, lint and build the frontend:** one builder run of `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite`, with `DEPLOYMENT=prod` and `NODE_OPTIONS=--max-old-space-size=4096`. Output goes to `../build/`, then `rsync`ed into `nginx/dist/`. See [Frontend build steps](#frontend-build-steps) for what each step does and why it is a separate step now.
7. **Build nginx image:** `docker compose build --no-cache nginx`.
8. **Generate VAPID keys:** if `vapid_keys.json` doesn't exist, generate Web Push VAPID keys via `npx web-push generate-vapid-keys`.
9. **Build the backend:** clear `backend/dist/`, `rsync` `srv/` (excluding `node_modules` and `.yarn`), copy `build/index.html` into `backend/dist/` (used for server-rendered meta tags), build `commonground/backend_stage_0`, then build the `api` image (stage 1 runs `yarn tsc`).
10. **Build and start the database:** `docker compose build --no-cache db && docker compose up -d db`.
11. **Start the full stack:** `docker compose up -d`.
12. **Deploy smart contracts:** runs `contracts/scripts/deploy.ts` against the local Hardhat node (`--network cgstack`).
13. **Show logs:** `./logs.sh`.

### Backend-Only Update: `docker/updateBackend.sh` (`./run.sh update_backend`)

Faster rebuild that only recompiles the backend: stops backend services, rebuilds `cg-builder` and nginx, regenerates certs/VAPID keys if needed, re-copies `srv/` sources and `build/index.html` into `backend/dist/`, builds the stage-0 and stage-1 backend images, then starts the stack and redeploys contracts.

### Frontend-Only Update: `docker/updateFrontend.sh` (`./run.sh update_frontend`)

Rebuilds only the frontend and nginx:
1. Clear `nginx/dist/`, rebuild `cg-builder`.
2. Install dependencies, generate a new random build ID.
3. Run `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite` with `DEPLOYMENT=prod` and **`NODE_OPTIONS=--max-old-space-size=4096`** (see [Frontend build steps](#frontend-build-steps)).
4. `rsync` the build output into `nginx/dist/`, then `docker compose up -d --no-deps --build nginx` and restart nginx.

### Frontend build steps

The frontend is built by **Vite** (`vite.config.ts` + the plugins under `vite/`).
Every build path — `build.sh`, `updateFrontend.sh`, `selfhost.sh` and the two
legacy Azure pipelines — runs the same four steps in this order:

| Step | Command | Why it is a step |
|---|---|---|
| type-check | `yarn typecheck` | `tsc --noEmit` for `src/**` plus `tsconfig.node.json` for the Vite-side files. The old webpack build ran ForkTsChecker inline; a Vite build type-checks nothing, so without this a type error ships silently. |
| lint | `yarn lint` | `eslint .` against `eslint.config.mjs`. Same reason: react-scripts ran ESLintPlugin inline. Errors fail the build, warnings do not — the same contract CRA had. |
| build | `yarn build` | `vite build` → `build/`. |
| HTML rewrite check | `yarn check:html-rewrite` | Runs the real rewrite logic of `srv/api/getRoutes.ts` and `docker/nginx/inject-instance-config.sh` against both emitted shells. Both patch the HTML with string/regex surgery at serve time and fail *silently* when the markup shape drifts. |

**Environment.** `DEPLOYMENT=prod` and `NODE_OPTIONS=--max-old-space-size=4096`
are the only variables the build reads. `NODE_OPTIONS` is not optional: a plain
`vite build` OOMs at 2048 MB and peaks at ~4 GB container RSS, and node sizes
its default heap from machine RAM, so a small selfhost VPS would fail without
it. The figure was re-measured under Node 24 + Vite 7 by a dedicated measured
`yarn build` in the builder container (`node:24.18-bookworm`): ~3.9 GiB peak by
`docker stats`, ~4.1 GiB cgroup `memory.peak` (which also counts page cache).
The flag caps only the V8 heap, so the build still fits — but the headroom is
thin; treat further dependency growth as a trigger to re-measure, with 5120 as
the fallback if a build ever OOMs.
The legacy Azure pipelines additionally set `PUBLIC_URL` (see below).

Three CRA-era variables are **gone** and must not be reintroduced:

| Removed | Replacement |
|---|---|
| `GENERATE_SOURCEMAP` | `build.sourcemap: true`, unconditional on every path. The app is AGPL; the old no-sourcemap policy dated from the closed-source era. Note the scope: `build.sourcemap` covers **JS only** — the production build emits a `.js.map` next to every chunk and **no** `.css.map` at all (a known Vite/Rollup limitation). CRA emitted CSS maps too, so this is a small regression in CSS debuggability, not a policy change. |
| `IMAGE_INLINE_SIZE_LIMIT` | `build.assetsInlineLimit: 5000` in `vite.config.ts`. |
| `--openssl-legacy-provider` | Not needed. It was a node flag the craco launcher forwarded because react-scripts 5's webpack hashing hit OpenSSL 3 restrictions. |

`PUBLIC_URL` survives with a much narrower job. It no longer sets a public path —
asset, manifest and icon URLs are root-relative on every path. When set, it only
makes the default `og:image` / `twitter:image` / `og:url` meta absolute
(`vite/absoluteSocialMeta.ts`), because Open Graph scrapers do not resolve
relative image URLs. Only the two legacy pipelines set it.

That change is *not* purely cosmetic on the **CG ID vhost**. Under CRA,
`PUBLIC_URL=https://app.cg` was baked into `index_cgid.html` too, so the CG ID
mini-app served at `id.app.cg` loaded its JS, CSS and PWA manifest
**cross-origin** from `app.cg` — which is what the `https://app.cg` entries in
`$cg_wallet_csp` (`docker/nginx/nginx.conf:98-101`) and the
`Access-Control-Allow-Origin` rule on the main vhost's
`^/(fonts|icons|images|static|audio|downloads)/` location exist for. The shell's
own assets are same-origin now, so the main-origin entries were pruned from
`script-src-elem`, `style-src` and `manifest-src` on both the prod/staging and
the self-host CG ID vhosts. Two directives keep the main origin, because the
mini-app genuinely still reaches it: `img-src` (it renders
`${APP_URL}/icons/128.png`, e.g. `src/cgid/login.tsx`) and `connect-src` (its
API calls go to `APP_URL/api/v2/CgId/`). `manifest-src 'self'` is load-bearing:
`/manifest_wallet.json` is now served from the CG ID origin, and on the
prod/staging vhosts the directive did not carry `'self'` before the cutover
(`nginx_selfhost.conf` always had it — self-hosted instances never set
`PUBLIC_URL`).

**Output layout** (`build/`), pinned to keep the nginx rules untouched:

- `build/index.html`, `build/index_cgid.html` — both entry shells at the web
  root under exactly these names. `srv/api/getRoutes.ts`,
  `docker/nginx/inject-instance-config.sh` and the `{CGID_SERVER_NAME}` vhost
  all depend on that. The shells are **not minified** any more (CRA ran
  HtmlWebpackPlugin minification; Vite ships the templates verbatim apart from
  the injected module script and, with `PUBLIC_URL`, three absolutised meta
  tags). That is intended, not a regression: both rewrite consumers match on
  literal markup, and an HTML minifier would put their regexes back at risk to
  save ~7 KB of comments and whitespace.
- `build/static/js|css|media/` — `assetsDir: 'static'`, hex `[hash:8]` content
  hashes. nginx's cache rule keys on
  `^/(fonts|icons|images|static|audio|downloads)/`, and the service worker's
  `dontCacheBustURLsMatching: /\.[0-9a-f]{8}\./` needs hex, not rollup's
  default base64url alphabet.
- `build/service-worker.js` at the root, built by `vite/serviceWorker.ts`
  (`workbox-build` 7 `injectManifest`, not `vite-plugin-pwa`; the 6 → 7 bump
  changed nothing here — `workbox-precaching`/`-routing` are the same sources
  under a new version string and no `injectManifest` option was renamed). The
  build **fails**
  if the nested worker bundle is not exactly that one file, or if any emitted
  JS/CSS chunk is missing from the precache manifest. The precache size cap is
  workbox's CRA-era **5 MiB** — it was raised to 8 MiB while Vite's default
  chunking still emitted one ~5.6 MB app chunk, and went back down once the
  `manualChunks` vendor groups (below) capped the largest chunk at ~2.2 MiB
  (since the 2026-08 dependency refresh the largest is `vendor-web3` at
  ~3.4 MiB — see the chunking note below — still under the cap). A
  chunk over the cap silently drops out of the precache (which costs offline
  cold start), which is what the assertion turns into a build failure. A prod
  build precached 158 entries / ~11.21 MiB after the 2026-08 wagmi-2
  migration (RainbowKit 2 code-splits its wallet connectors, so the build went
  from 54 to 126 JS chunks). Treat that as a lower bound: the explicit wallet
  list added in the same migration's review came afterwards (~5 lazy chunks /
  ~0.5 MiB of precache), and the later React-19 waves were not re-measured as a
  whole — the motion 12 swap alone added ~0.5 % raw JS. The Vite 7 baseline
  was 90 / ~10.4 MiB and CRA's content baseline 118 / ~10.6 MiB. Excluded from the manifest:
  `index_cgid.html`, sourcemaps, `LICENSE` files, `asset-manifest.json`, the
  worker itself and the verbatim `public/` copy (the fonts, call sounds and
  cross-origin-isolation shells that must be precached are added by hand in
  `src/service-worker.ts`).
- everything in `public/` copied verbatim (`fonts/`, `icons/`, `audio/`,
  `images/`, `video/`, both manifests, `robots.txt`, `logo.svg`). `src/index.css`
  references the Inter faces as server-relative `/fonts/*.ttf` on purpose, i.e.
  *not* through the bundler: `src/service-worker.ts` hand-precaches exactly those
  URLs, so they have to keep resolving to the `public/` copy. Routing them
  through Vite would hash them into `static/media/` and ship every face twice
  (which is what CRA did); removing them from `public/` would make a precached
  URL 404, and a 404 in the precache makes `PrecacheController.install()` reject
  — the worker never activates and PWA updates stop silently.
- no `asset-manifest.json` — it had no consumers.

**Chunking.** `build.rollupOptions.output.manualChunks` in `vite.config.ts`
pulls nine vendor groups out of the app chunk (`vendor-web3`, `vendor-icons`,
`vendor-charts`, `vendor-mediasoup`, `vendor-emoji`, `vendor-editor`,
`vendor-dnd`, `vendor-react`, `vendor-shared`). Vite's default chunking put
everything statically reachable into one ~5.4 MiB `App` chunk — one large
blocking request where CRA's `splitChunks: { chunks: 'all' }` had parallelised
the same code. After the split the largest chunk was `vendor-web3` at ~2.2 MiB
and `App` ~1.9 MiB, with the total JS unchanged (~9.4 MiB over
57 files instead of 86); what changed was the shape — the app's statically
reachable closure grows by ~0.3 MiB (previously lazy-only ethers/rainbowkit
modules land inside `vendor-web3`) and then arrives as ~24 parallel requests
instead of one 5.4 MiB blocking one. The 2026-08 dependency refresh first
grew `vendor-web3` to ~3.6 MiB (a duplicated viem pulled in by a wagmi-1
connector); the wagmi-2 migration then brought it back to ~3.4 MiB (3.56 MB)
with ethers 5 gone, at ~10.3 MiB total JS over 126 chunks. A second viem copy
remains — WalletConnect core exact-pins its own, loaded only with the lazily
split WalletConnect connector. The groups were tuned under Vite 6 /
Rollup 4 and carried over unchanged through the Vite 7 bump (esbuild 0.25 →
0.28): same chunk set, every chunk same-size or marginally smaller. Three rules
keep the table safe, all three documented at the definition:

- only `node_modules` packages are assigned; `src/` keeps the default behavior
  (splitting first-party modules across chunks is how import cycles turn into
  `Cannot access 'X' before initialization` at runtime),
- one group per coherent library island, so the cyclic imports these libraries
  do have stay inside one chunk,
- nothing that a lazily loaded chunk needs more than the app does — and nothing
  the CG ID mini-app reaches. `index_cgid` must not pull vendor chunks it has no
  use for; `assertCgidEntryChunks` in `vite.config.ts` **fails the build** if its
  entry statically reaches any group other than `vendor-react` and
  `vendor-shared` (the `<link rel="modulepreload">` chain in
  `build/index_cgid.html` is the same set, readable by eye). The same rule is
  why the bundler's own helper modules (`vite/preload-helper`,
  `commonjsHelpers.js`, `__vite-browser-external`) are pinned: an *unassigned*
  module gets absorbed into whichever group shares its reachability signature,
  and everything imports those three — which is exactly the silent regression
  the assertion exists to catch. The same applies to third-party packages that
  the CG ID mini-app *and* a vendor group both import: `ua-parser-js` (direct
  import in the mini-app, and a RainbowKit dependency) is pinned into
  `vendor-shared` because, left unassigned, it made rollup fold the whole
  `vendor-web3` chunk into the `index_cgid` entry.

Changing the groups needs a **browser** pass — chunk boundaries change module
initialisation order and no build-time check catches an initialisation-order
bug.

**Tests.** `yarn test` (Vitest, `vitest.config.ts`) is not part of the build
scripts yet; the suite is a small set of unit tests (`src/**/*.test.ts`).

### Backend Docker Image Build (Two-Stage for Dev)

- **Stage 0 (`Dockerfile_dev_stage_0`):** `FROM node:24.18-bookworm`. Installs system deps, then (before the dependency layers, so it only rebuilds when the pin changes) runs `download_model.sh`, which fetches the NSFW classification model (~87 MB) from a **pinned HuggingFace revision** into `/models/nsfw` and verifies every file's sha256 — the build needs network access to `huggingface.co`, the runtime never does. It then copies `package.json` / `yarn.lock` / `.yarnrc.yml`, enables Corepack, runs `yarn` and prunes the darwin/win32 `onnxruntime-node` binaries plus the browser-only `onnxruntime-web` (~290 MB that can never run in the linux node image). Cached; rebuilt only when dependencies (or the model pin) change.
- **Stage 1 (`Dockerfile_dev_stage_1`):** `FROM commonground/backend_stage_0`. Copies the full `dist/` source and runs `yarn tsc`. Rebuilt on every code change.

**Production backend (`Dockerfile`):** single-stage build, `FROM node:24.18-bookworm`. Its first layers bake the NSFW model into `/models/nsfw` (`download_model.sh`, pinned revision + sha256 — placed before the `COPY ./dist` layer on purpose, so source changes don't re-download 87 MB from huggingface.co); it then installs system dependencies (build-essential, python3, Chromium libs for Puppeteer), enables Corepack, runs `yarn && yarn tsc`, prunes the darwin/win32 `onnxruntime-node` binaries plus the browser-only `onnxruntime-web` and cleans up build tools. Building requires network access to `huggingface.co`; the runtime never does. Used by the CI/CD pipelines.

All images stay on **Debian bookworm** deliberately: the Node 24 audit
(2026-08) found that moving to trixie breaks the Puppeteer dependency install
in `docker/backend/Dockerfile` — trixie ships no `libgcc1` (renamed
`libgcc-s1`) and renames `libasound2`/`libcups2` to their `…t64` variants under
the 64-bit `time_t` transition. Forward note for the next Node bump: the
Node 24 images still bundle Corepack, which the `corepack install -g
yarn@4.17.1` step in `docker/node/Dockerfile` relies on; the Node 26 images
drop Corepack, so that step will need corepack installed explicitly first.

---

## 3. nginx Configuration

There are three nginx configs, one per build target:

| Config | Dockerfile | Used by |
|---|---|---|
| `nginx_dev.conf` | `Dockerfile_dev` | dev stack (`docker-compose.yml`) |
| `nginx.conf` | `Dockerfile` | CI/CD (staging/prod, `app.cg`) |
| `nginx_selfhost.conf` | `Dockerfile_selfhost` | self-host stack ([section 7](#7-self-hosted-single-server-deployment)) |

### Development: `docker/nginx/nginx_dev.conf`

The `{NGINX_EXPOSED_ON}` placeholder is replaced at Docker build time with `LOCAL_CERTIFICATE_IP`.

**Listeners:** port 80 (HTTP) and port 443 (HTTPS, self-signed).
**Server names:** `localhost`, `bs-local.com`, `app.cg.local`, `{NGINX_EXPOSED_ON}`.

**Routing rules:**

| Location Pattern | Upstream | Purpose |
|---|---|---|
| `/files/<id>/<sig>/<date>/<expires>` | `http://s3.local:8333` | File/media downloads. Rewrites to an S3 presigned request (AWS4-HMAC-SHA256). Cached 7 days, immutable. |
| `/api/bot/v1/...` | `http://api:4000` | **Bot API v1.** Rewrites to `/BotV1/...`. Stable, bearer-token-only namespace kept separate from the web-app API. |
| `/api/v2/(Captcha\|Chat\|Community\|File\|Message\|User\|Contract\|Notification\|Twitter\|Lukso\|CgId\|Accounts\|Plugins\|Search\|Report\|Bot\|Staking)/` | `http://api:4000` | REST API. Strips `/api/v2/`. No caching. (`Captcha`, `Report`, `Bot`, `Staking` are the newer groups.) |
| `/api/ws/` | `http://wsapi:4000` | WebSocket upgrade (HTTP/1.1, `Upgrade: websocket`). |
| `/(c\|u\|gated-videos\|gated-files)/` | `http://api:4000` | Community pages, profiles, gated content. Cached 24h. |
| `/(sitemap.xml\|twitter-callback\|twitter-login\|verify-email\|push-icon\|token-sale\|token\|store)` | `http://api:4000` | Misc server-rendered endpoints. Cached 24h. |
| `/(fonts\|icons\|images\|static\|audio\|downloads)/` | Static `/www` | Built frontend assets. Cached 24h. |
| `/(index.html\|service-worker.js\|e/...)` | Static `/www` | SPA entry point; falls back to `index.html`. No caching. |
| `/community/<10-char-id>*` | Redirect | Legacy redirect from `/community/X` to `/c/X/`. |
| `/index_cgid.html` | Static `/www` | CG ID (wallet) page. |
| `/enable-cross-origin-security` | Static `/www/index.html` | Serves index.html with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (required for SharedArrayBuffer). |
| `/disable-cross-origin-security` | Static `/www/index.html` | Serves index.html without cross-origin isolation headers. |

**Security headers (applied to responses):** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a per-server-name `Content-Security-Policy`, and `server_tokens off`.

**Other settings:** `client_max_body_size 16M`; gzip level 6 for text/CSS/JS/JSON/XML/SVG; real-IP extraction from Cloudflare and private ranges via `X-Forwarded-For`; Docker DNS resolver at `127.0.0.11` for S3 proxy resolution.

### Production (CI/CD): `docker/nginx/nginx.conf`

Placeholders `{SERVER_NAME}` and `{CGID_SERVER_NAME}` are substituted at Docker build time.

**Key differences from dev:**
- Listens only on port 80 (TLS terminated upstream by Cloudflare/edge).
- A **second server block** for the CG ID subdomain (`id.app.cg` / `id.staging.app.cg`) serves the wallet app (`index_cgid.html`); `index_cgid.html` is denied on the main domain and `index.html` is denied on the ID domain.
- CSP includes production analytics/RPC domains; static-asset CORS `Access-Control-Allow-Origin` is set to the corresponding `id.*` subdomain.

**Production domains:** main app `app.cg` (prod) / `staging.app.cg` (staging); CG ID wallet `id.app.cg` / `id.staging.app.cg`.

The self-host config (`nginx_selfhost.conf`) is described in [section 7](#7-self-hosted-single-server-deployment).

---

## 4. Environment Variables

### `docker/.env` — Dev Compose Environment

`docker/.env` is the dev stack's configuration: `run.sh`, `docker/build.sh`, `docker/updateBackend.sh`, `docker/updateFrontend.sh` (compose only), the `tools/` migration/test scripts and `docker/nginx/certs/recreate_server_certs.sh` source it, and docker compose reads it for the `${VAR}` references in `docker-compose.yml`. It is **gitignored and local to each checkout**; the tracked template is **`docker/.env.example`**, which lists every variable with grouped comments and holds no real secret.

**Generation — `docker/ensureEnv.sh`.** Every script above calls it before using `docker/.env`; `run.sh`, `build.sh`, `updateBackend.sh` and `updateFrontend.sh` then export `CG_ENV_ENSURED=1`, so the scripts they invoke skip the repeat. It:

- creates a missing `docker/.env` — but never with fresh passwords for an existing database (below) — from `.env.example` (mode `600`), replacing every `generated-on-first-run` placeholder with `openssl rand -hex` output — 24 bytes for `PG_SU_PASSWORD`, `PG_WRITER_PASSWORD`, `PG_READER_PASSWORD`, `PG_MEDIASOUP_PASSWORD`, `REDIS_PASSWORD`, `REDIS_SECRET`, `PGADMIN_SECRET`; 48 for `S3_SECRET`; 32 for `ALTCHA_HMAC_KEY` (same lengths as `docker/selfhost/init.sh`) — and setting `BUILDER_UID`/`BUILDER_GID` to `id -u`/`id -g`. Hex keeps the values safe in the unescaped SQL literals of `docker/db/init.sh`, on redis' command line and in JSON. The file is written to a temp file and renamed (`docker/.env.*` is gitignored, so an interrupted run leaves no stray secrets file to commit);
- **in a linked git worktree**, copies `docker/.env` (and a missing `s3.json`) from the main worktree instead, when that has one;
- **stops with an error** instead of generating when a `<project>_pgdata` volume already exists. The compose project is named after the `docker/` directory, so **every checkout on a machine shares `docker_pgdata`**, and postgres only accepts the passwords the volume was initialized with. The error lists the ways out: copy `docker/.env` from another checkout, restore the formerly tracked version from history, or delete the volume (the dev data of every checkout);
- creates a missing `docker/s3_config/s3.json` (gitignored, written atomically) with the `S3_SECRET` from `docker/.env` as the `cgadmin` secret key. Mode `644` on purpose: seaweed reads the bind-mounted file as its in-container user (uid 1000), which need not own it (another host user, rootless Docker, Podman), and the dev S3 port is not published. It stops with a `sudo rmdir` hint when `s3.json` is a *directory* — what Docker creates when a container bind-mounts the path while the file is missing;
- **warns, never fails,** when `docker/.env` lacks variables that `.env.example` assigns (listing them), still contains placeholders, has a `GOOGLE_RECAPTCHA_SECRET_KEY` while `CAPTCHA_PROVIDER` is empty (implicit reCAPTCHA — with the `your-key` placeholder every signup fails), or when `s3.json` has no `secretKey` or one that differs from `S3_SECRET`.

It never modifies an existing `docker/.env` or `s3.json`. New variables therefore reach existing checkouts only by hand — the warning says which ones to copy.

**Existing checkouts (from before 2026-11).** Until 2026-10-31 `docker/.env` and `docker/s3_config/s3.json` were tracked. A pull across that change deletes both (git removes files the incoming commit stops tracking), and it refuses to run at all while `docker/.env` has local modifications. Your dev database only accepts the passwords in your old `docker/.env`, so keep it:

```bash
cp docker/.env ~/cg-env.bak
git checkout -- docker/.env docker/s3_config/s3.json   # drop local edits so the pull can proceed
git pull
cp ~/cg-env.bak docker/.env
./run.sh            # regenerates s3.json from it; lists variables your file lacks
```

If the pull already deleted it and you never changed the committed values, restore that version from history (then delete `docker/s3_config/s3.json` if it was generated from a different `docker/.env` in the meantime):

```bash
git show "$(git log -1 --format=%H --diff-filter=D -- docker/.env)^:docker/.env" > docker/.env
```

`git stash` works too, but `git stash pop` after the pull ends in a modify/delete conflict on `docker/.env` (the file is back with your values, marked unmerged) and keeps the stash entry: run `git reset -q -- docker/.env && git stash drop` afterwards. A restored old `docker/.env` keeps the dev passwords that were public on GitHub — acceptable on localhost (`EXTERNAL_LISTEN_IP=127.0.0.1`); before switching to LAN mode, rotate them, which needs a fresh `pgdata` volume (`./run.sh down && docker volume rm docker_pgdata`, then delete `docker/.env` and `s3.json` and rerun).

Password consumers on a fresh stack: `PG_SU_PASSWORD` initializes the postgres superuser (`POSTGRES_PASSWORD`, applied only when the `pgdata` volume is first created) and is the login of `migrate-db` and `cg-builder`; `PG_WRITER_PASSWORD`/`PG_READER_PASSWORD` become the `writer`/`reader` roles in `docker/db/init.sh` (same first-init caveat; no dev service connects as `reader`), `writer` is used by `api`, `wsapi`, `memberlist`, `job-runner` and `onchain`; `PG_MEDIASOUP_PASSWORD` is set on the `mediasoup` role by migration `1689160339881-addMediasoupRole` (run by `migrate-db`) and used by `mediasoup`; `REDIS_PASSWORD` is redis' `--requirepass` and every backend client's password; `S3_SECRET` must equal the `s3.json` secret key.

The table describes purpose; `.env.example` has the defaults.

| Variable | Purpose |
|---|---|
| `PG_WRITER_PASSWORD` / `PG_READER_PASSWORD` | Passwords for the `writer` / `reader` DB roles |
| `PG_SU_PASSWORD` | PostgreSQL superuser password |
| `PG_MEDIASOUP_PASSWORD` | Password for mediasoup's dedicated DB role |
| `REDIS_PASSWORD` | Password for the Redis instance |
| `REDIS_SECRET` | Secret for Redis-backed session signing |
| `PGADMIN_SECRET` / `PGADMIN_EMAIL` | pgAdmin login (only if pgAdmin is enabled) |
| `DEPLOYMENT` | `dev` \| `staging` \| `prod`. Controls feature flags, chain config, CSP, session cookie names. |
| `BASE_URL` | Base URL of the application (absolute URLs in emails/redirects). |
| `S3_SECRET` | Secret key for the SeaweedFS S3 API / presigned-URL signing. |
| `BUILDER_UID` / `BUILDER_GID` | Host UID/GID for the builder container (avoids mounted-volume permission issues). `0` (root) is accepted. |
| `RECALCULATE_BALANCES_AND_ROLES` | If `true`, recomputes all token balances/roles on `onchain` startup. |
| `MEDIASOUP_DISABLE_LIBURING` | Disables io_uring in mediasoup (workaround for some kernels/containers). |
| `LOCAL_CERTIFICATE_IP` | IP baked into self-signed certs. Empty = no certs generated; set a LAN IP for multi-device testing. |
| `MEDIASOUP_ANNOUNCED_IP` | IP mediasoup advertises for WebRTC ICE candidates; must be client-reachable. |
| `EXTERNAL_LISTEN_IP` | Host port-binding interface. `127.0.0.1` = localhost only, `0.0.0.0` = all interfaces. |
| `MAILCHIMP_LIST_ID` / `MAILCHIMP_API_KEY` | Newsletter list sync. Not passed to any service by `docker-compose.yml` (only the self-host file does), so no effect in the dev stack. |
| `QUIKNODE_*` | Per-chain RPC endpoint URLs used by `onchain` (name is historical — any JSON-RPC URL works). Includes `QUIKNODE_LUKSO`, which falls back to the public LUKSO RPC when empty. |
| `INFURA_LINEA` | RPC endpoint for Linea. |
| `GOOGLE_RECAPTCHA_SECRET_KEY` | Server-side reCAPTCHA v2 secret. |
| `CAPTCHA_PROVIDER` / `ALTCHA_HMAC_KEY` | Captcha provider (`altcha` \| `recaptcha` \| `off`; empty = `recaptcha` when `GOOGLE_RECAPTCHA_SECRET_KEY` is non-empty — any value, placeholders included — else `altcha`) and the ALTCHA HMAC key (empty = generated once and shared via Redis). Both are passed to `api`. The proof-of-work tuning knobs `ALTCHA_COST` / `ALTCHA_COUNTER_MAX` are passed by neither compose file — add them to the `api` service to tune (see [docs/auth-identity](../auth-identity/README.md)). |
| `TWITTER_CALLBACK_URL` / `TWITTER_OAUTH2_CLIENT_ID` / `TWITTER_OAUTH2_CLIENT_SECRET` / `TWITTER_API_KEY` / `TWITTER_API_SECRET` | Twitter/X login. The v1 keys `TWITTER_API_KEY` / `TWITTER_API_SECRET` are not passed to any service by `docker-compose.yml`. |
| `SENDGRID_API_KEY` | SendGrid transactional email. |
| `IMAGE_MODERATION_ENABLED` | Server-side NSFW image filter (`srv/moderation/imageFilter.ts`); consumed by the `api` and `onchain` services (with defaults when absent from `.env`). Default `true`; only the literal `false` disables it. The `api` service probes the model at boot — look for `imageFilter: ready` (or a `MODEL UNAVAILABLE` error) in *its* startup log to tell a working setup from one where every upload will fail; `onchain` loads the model lazily and logs nothing at boot by design. Note: on the dev stack the *client* pre-check stays active regardless for pages served by the vite dev server (no instance-config injection there); api-served pages and the selfhost profile do propagate the switch to the browser. |
| `IMAGE_MODERATION_THRESHOLD` | NSFW probability above which an image is rejected. Default `0.8`; invalid values fall back to the default (non-empty invalid values log a warning; an empty value — the compose default — falls back silently). |
| `IMAGE_MODERATION_MODEL_PATH` | Model directory in the container (default `/models/nsfw`, baked into the backend image). Point at a mounted Transformers.js-layout classifier to swap models. |

Also consumed by the compose file (with compose-side defaults when absent from `.env`): the `STAKING_*` set (`STAKING_CHAIN`, `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, `STAKING_BASE_RATE`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`) and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`). See [`docs/BOT-API.md`](../BOT-API.md) and [`docs/staking`](../staking/README.md). The compose default of every `STAKING_*` variable is an empty string; `srv/util/stakingConfig.ts` treats empty like unset, so the backend defaults (`0.012` / `7` / `730`, which `.env.example` spells out) apply.

### `srv/serverconfig.ts` — Backend Server Configuration

Loaded at runtime. Reads from Docker secrets first, then environment variables, then falls back to placeholders.

| Config Key | Source | Purpose |
|---|---|---|
| `MAILCHIMP_API_KEY` | Docker secret `mailchimp_api` or env | Mailchimp API access |
| `MAILCHIMP_SERVER` | hardcoded `us9` | Mailchimp data center |
| `MAILCHIMP_DEFAULT_LIST_ID` | Docker secret `mailchimp_list_id` or env | Default mailing list |
| `SENDGRID_API_KEY` | Docker secret `sendgrid_api` or env | Email sending |
| `SESSION_COOKIE_NAME` | derived from `DEPLOYMENT` | `connect.sid` in prod, `cg_<deployment>.sid` otherwise |

### `srv/common/config.ts` — Shared Application Configuration

Isomorphic (shared frontend/backend). Must **never contain secrets**.

- **`DEPLOYMENT` detection:** in the browser, from `window.location.href`; in Node.js, from `process.env.DEPLOYMENT`; falls back to `prod`.
- **Active chains, community contract addresses, feature flags** vary by deployment.

Self-hosted instances additionally declare their identity at serve time via `window.__CG_INSTANCE__` (see `src/common/instance.ts` and [section 7](#7-self-hosted-single-server-deployment)), which overrides the domain-based `DEPLOYMENT` guess.

---

## 5. CI/CD Pipelines

The project uses **Azure DevOps Pipelines** (YAML). The build/deploy pipelines target the CG-operated `app.cg` / `staging.app.cg` deployment (self-hosting does not use them); the reference-client pipeline is a test pipeline.

### Staging: `pipelines/build-and-deploy-beta.yml`

**Trigger:** push to `staging`. **Pool:** `ubuntu-20` (self-hosted agent).

Steps: install Docker/Node/Yarn toolchain → fetch the secure `.yarnrc` (private registry creds) → `yarn` install → copy `srv/` to `docker/backend/dist/` → generate a build ID (written to both `src/common/random_build_id.ts` and `docker/backend/dist/common/random_build_id.ts`) → frontend build with `yarn typecheck && yarn lint && DEPLOYMENT=prod PUBLIC_URL="https://staging.app.cg" yarn build && node tools/checkHtmlRewriteCompat.mjs` → copy `index.html`/build output into backend and nginx dirs → build and push **backend** and **nginx** images (nginx build args `SERVER_NAME=staging.app.cg`, `CGID_SERVER_NAME=id.staging.app.cg`) with tags `beta` + `$(Build.BuildNumber)` → deploy via **Ansible** over SSH (`docker_swarm_deploy_beta.yml` for the main stack, `deploy_docker_mediasoup.yml` for mediasoup) → clean up.

### Production: `pipelines/build-production.yml`

**Trigger:** push to `production`. Nearly identical, but: `PUBLIC_URL="https://app.cg"`; images tagged `0.1`, `latest`, `$(Build.BuildNumber)`; nginx build args `SERVER_NAME=app.cg`, `CGID_SERVER_NAME=id.app.cg`; **no Ansible deploy step** (build-only — production deploy is manual).

### Clean-Up Template: `pipelines/sub-templates/clean-up.yml`

Shared template that deletes the build work directory, `condition: always()`.

### Reference client: `pipelines/reference-client-conformance.yml`

OpenAPI drift check plus the `sdk/` conformance suite (see `sdk/README.md`).
It builds the selfhost images, runs `sdk/tools/generate-openapi.sh --check`,
starts a disposable API-only instance (`sdk/conformance/tools/disposable-instance.sh`,
which layers `docker/docker-compose.conformance.yml` over the selfhost compose
file under its own project name, env file and volumes, with nginx published
on `127.0.0.1:18080` and no TLS edge), then runs the suite against it: the R0 +
R1 subset on PRs into `develop` that touch `srv/` or `sdk/`, the full suite
nightly (on `develop`). Its push trigger and one of its nightly branches
still name the merged `feat/reference-client` branch — see
`docs/todo/TODO.md`.

### Deployment Architecture (CG-operated prod/staging)

- Images built in CI, pushed to container registries.
- Production infra uses **Docker Swarm** (per the Ansible playbook names).
- Mediasoup nodes deploy separately (dedicated media hosts).
- TLS is terminated at the edge (Cloudflare), not in the nginx container.

---

## 6. Developer Workflow

### Entry Point: `run.sh`

`run.sh` (project root) is the primary dev interface. It runs `docker/ensureEnv.sh` (creating `docker/.env` on first use, see [section 4](#4-environment-variables)), sources `docker/.env`, changes to `docker/`, and dispatches to sub-commands via a `docker_compose` wrapper around `docker-compose.yml`.

### Available Commands

| Command | Effect |
|---|---|
| `./run.sh start` | Vite dev server (HMR) on `http://localhost:3000`, run via `yarn dev` in `cg-builder`. Backend stack must already be up. Port 3000 is load-bearing: the service-worker registration manager disables itself on that origin, which is what keeps the dev server SW-free. Vite checks the `Host` header on **plain-HTTP** dev servers and accepts only `localhost`, `*.localhost` and IP literals — reaching this dev server through a custom hostname (e.g. `app.cg.local`) needs that host in `server.allowedHosts`. CRA had no such check; `start_https` is exempt (the check is skipped for HTTPS servers). |
| `./run.sh start_https` | Same, but HTTPS with the self-signed certs under `docker/nginx/certs/` — required for WebRTC calls and LAN multi-device testing. **Aborts** if the certs are missing; there is no HTTP fallback. |
| `./run.sh build_full` | Runs the full `docker/build.sh` pipeline. |
| `./run.sh update_backend` | Recompiles backend TypeScript, rebuilds backend images. |
| `./run.sh update_frontend` | Rebuilds only the frontend + nginx (production build). |
| `./run.sh up` | `docker compose up -d` then tails logs. |
| `./run.sh down` | Stops all services. |
| `./run.sh compose <args…>` | Passthrough to `docker compose` with the right file(s). |
| `./run.sh shell` | Interactive bash in `cg-builder` (project mounted at `/cg`). |
| `./run.sh make_migration <name>` | New TypeORM migration via `tools/makeMigration.sh`. |
| `./run.sh make_empty_migration <name>` | Empty migration via `tools/makeEmptyMigration.sh`. |

### Typical Development Flow

1. **First-time setup:** `./run.sh build_full` (the first `./run.sh` call generates `docker/.env` from `docker/.env.example`; fill in third-party keys there as needed).
2. **Daily frontend work:** `./run.sh up`, then `./run.sh start`.
3. **After backend changes:** `./run.sh update_backend`.
4. **After frontend changes (production build test):** `./run.sh update_frontend`.
5. **Schema changes:** `./run.sh make_migration <name>`, edit the file, then `./run.sh update_backend` (migrations run automatically on startup via `migrate-db`).

---

## 7. Self-Hosted Single-Server Deployment

**Files:** `docker/docker-compose.selfhost.yml`, `docker/SELFHOST.md`, `docker/selfhost/` (`init.sh`, `selfhost.sh`, `Caddyfile`), `docker/nginx/Dockerfile_selfhost`, `docker/nginx/nginx_selfhost.conf`, `docker/nginx/inject-instance-config.sh`.

This profile runs the **entire stack on one server** with real production semantics on your own domain. A 4–8 core / 16 GB machine is enough (idle < 2 GB; RAM is mostly consumed under call/upload load). Full walkthrough in `docker/SELFHOST.md`.

### How it differs from the dev stack

- **Distinct Compose project name** (`name: cg-selfhost`), so its containers and volumes never collide with the dev stack even in the same directory.
- **Caddy** (`caddy:2-alpine`) fronts everything and obtains/renews **Let's Encrypt** certificates automatically for the app domain, the CG ID domain, and mediasoup call signalling (port 4443) — or, with `CG_TLS_MODE=internal`, issues all three from its own local CA (LAN/test instances without public DNS).
- **nginx** is built from `Dockerfile_selfhost` (real domains, parameterized CSP, instance-config injection) instead of the dev image.
- **`DEPLOYMENT=prod`** on any domain — full production behaviour without hardcoding `app.cg`.
- **No `hardhat` dev chain, no test-contract deployment.**
- **Postgres loads the tuned `postgresql.conf`** (same `config_file` command as dev).
- **Redis `maxmemory` is tuned small** (`${REDIS_MAXMEMORY:-1536mb}` total) instead of the dev 6 GB.
- **`mediasoup` and `onchain` are optional**: they carry the Compose profiles `calls` and `blockchain`, which `selfhost.sh` enables from `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` in `.env.selfhost` (both default to `true`). See [docs/deployment §3.8](../deployment/README.md#38-optional-services-calls-and-blockchain) and `docker/SELFHOST.md`.
- **`CG_ENABLE_IMAGE_FILTER`** (default `true`) is a plain switch, not a profile: it feeds `IMAGE_MODERATION_ENABLED` into the `api`/`onchain` services and the instance-config injection (`features.imageFilter`), which also turns off the client-side pre-upload warning. `CG_IMAGE_FILTER_THRESHOLD` / `CG_IMAGE_FILTER_MODEL_PATH` pass through to `IMAGE_MODERATION_THRESHOLD` / `IMAGE_MODERATION_MODEL_PATH`.
- **SeaweedFS master** uses `-volumeSizeLimitMB=${SEAWEED_VOLUME_LIMIT_MB:-1024}`.

### Operation scripts

- **`docker/selfhost/init.sh [--tls-internal] <domain> <acme-email> [id-domain] [public-ip]`** — one-time bootstrap. Idempotent (never overwrites existing files). It:
  - Auto-detects the public IP (via ipify) if not supplied; a supplied IP (e.g. a LAN address) is used as-is.
  - `--tls-internal` writes `CG_TLS_MODE=internal` instead of `acme`, accepts `-` for the then-unused ACME email, and requires the IP argument.
  - Generates `docker/.env.selfhost` with fresh random secrets (`openssl rand`) — all DB/Redis/S3 credentials, resource-tuning defaults sized for 16 GB, bot limits, and a fully-commented set of optional-integration keys. Written `chmod 600`.
  - Generates `docker/s3_config/s3.selfhost.json` with an S3 secret matching the generated `S3_SECRET`. Seaweed reads it as its in-container uid 1000, so it is made owned by `1000:1000` with mode `600` (run as uid 1000 or root); any other user can't `chown`, gets mode `644` and a printed note on how to tighten it as root.
  - Generates a self-signed cert in `docker/selfhost/certs/` for the internal caddy→mediasoup hop only (clients only ever see Caddy's cert).
  - The generated `.env.selfhost` prefills the RPC endpoints with **free public JSON-RPC URLs** and `CG_ACTIVE_CHAINS=eth,arbitrum,xdai,base,matic,lukso`, so token-gating works out of the box.
- **`docker/selfhost/selfhost.sh <cmd>`** — build/operate wrapper. Requires `.env.selfhost`; runs Compose with `--env-file .env.selfhost -f docker-compose.selfhost.yml`. Commands: `build`, `up`, `down`, `logs [service]`, `ps`, `stats`, `compose <args>`, `update` (git pull + rebuild + restart). It sets `COMPOSE_PROFILES` from the `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` switches and runs `up`/`down`/`update` with `--remove-orphans`, so a service whose switch was flipped off is actually removed. The `build` command mirrors `build.sh` (same type-check/lint/build/check chain, same `NODE_OPTIONS=--max-old-space-size=4096`) and builds the nginx image from `Dockerfile_selfhost`. Sourcemaps ship here too — see [Frontend build steps](#frontend-build-steps).

### Caddy (`docker/selfhost/Caddyfile`)

Env-driven (`CG_DOMAIN`, `CG_ID_DOMAIN`, `CG_ACME_EMAIL`, `CG_TLS_MODE`):
- The global options block does `import tls_mode_{$CG_TLS_MODE:acme}`: snippet `tls_mode_acme` sets `email {$CG_ACME_EMAIL}` (Let's Encrypt — the adapted JSON is identical to the pre-switch Caddyfile), `tls_mode_internal` sets `local_certs` + `skip_install_trust` (every site from Caddy's local CA; root in the `caddy-data` volume under `/data/caddy/pki/authorities/local/`). Any other value fails at startup. Compose passes `CG_TLS_MODE=${CG_TLS_MODE:-acme}`, so an `.env.selfhost` without the key stays on ACME.
- `{$CG_DOMAIN}` and `{$CG_ID_DOMAIN}` → `reverse_proxy nginx:80` (zstd/gzip).
- `{$CG_DOMAIN}:4443` → `reverse_proxy https://mediasoup:4443` with `tls_insecure_skip_verify` (the internal hop trusts mediasoup's self-signed cert).
- Ports published: `80`, `443` (tcp+udp, HTTP/3), `4443` (tcp). WebRTC media `40000–40099` (UDP and TCP) is published directly by the mediasoup container.

### Instance identity injection

The same build artifacts serve any domain: identity is configuration, not code. At container start, `inject-instance-config.sh` (an nginx `/docker-entrypoint.d/` hook, activated only when `CG_APP_URL` is set) injects

```html
<script>window.__CG_INSTANCE__ = {"deployment":"prod","appUrl":"https://chat.example.org", ...}</script>
```

into `/www/index.html` and `/www/index_cgid.html` (skipping files already configured). The object carries `deployment`, `appUrl`, `cgidUrl`, `activeChains`, a `features` map (`email`, `twitterAuth`, `calls`), `giphyApiKey`, `walletConnectProjectId`, and `recaptchaSiteKey`. Compose derives the boolean feature flags from whether the corresponding key is set (e.g. `CG_FEATURE_EMAIL=${SENDGRID_API_KEY:+true}`), so the frontend hides or honestly labels features that aren't configured. The backend performs the equivalent injection for share links. See `src/common/instance.ts`.

### `nginx_selfhost.conf` specifics

- **Two server blocks** (main domain + CG ID domain), like the CI prod config, with `{SERVER_NAME}` / `{CGID_SERVER_NAME}` substituted at build time.
- **Upstreams resolved dynamically** via `resolver 127.0.0.11` + `set $upstream ...` variables, so nginx starts even if a backend container isn't up yet (rather than failing at config-load time on an unresolved host).
- **Parameterized CSP** built from `map $server_name` blocks; the self-host `connect-src` allowlist includes the instance's own origin plus the public RPC/wallet/service hosts the app talks to (including `*.drpc.org`, added so the default drpc.org RPC endpoints are reachable).
- Serves `/api/bot/v1/` → `/BotV1/`, the same `/api/v2/(…|Report|Bot|Staking)/` group as dev, `/api/ws/`, the community/SSR routes, static assets, and the cross-origin-isolation toggles; `index_cgid.html` is denied on the main domain and `index.html` on the ID domain.

### Optional integrations & graceful degradation

Every third-party integration is optional; leaving its key empty in `.env.selfhost` disables just that feature (email/OTP login, captcha, Twitter/X auth, Mailchimp, Giphy, WalletConnect). The rest of the app keeps working — password/passkey/wallet login, RSVPs, injected wallets, etc. `docker/SELFHOST.md` has the full capability matrix.

### Blockchain endpoints

`init.sh` prefills `QUIKNODE_*` / `INFURA_LINEA` with free public endpoints and `CG_ACTIVE_CHAINS` selects which chains the instance offers (drives both backend workers and the UI chain lists — keep them in sync). The on-chain event listener issues ranged `eth_getLogs` calls; some free endpoints restrict that method, which is why the defaults favour drpc.org and official chain RPCs. Frontend wallet interactions use each chain's default public RPC when an instance config is present.

### Token staking (Spark)

Off by default. To enable, deploy your own non-custodial `CgStaking` contract (`contracts/staking/`) and set `STAKING_CHAIN` (must be in `CG_ACTIVE_CHAINS`), `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, and optionally `STAKING_BASE_RATE` / `STAKING_MIN_LOCK_DAYS` / `STAKING_MAX_LOCK_DAYS` in `.env.selfhost`, then `./selfhost/selfhost.sh up` to recreate the `api`, `job-runner` and `onchain` services. See [`docs/staking`](../staking/README.md).

### Backups & firewall

State lives in two named volumes: `pgdata` (database) and `seaweedfs-data` (uploaded media). Redis is intentionally unpersisted (sessions/ephemeral only). Ports to open: `80/tcp` (ACME + HTTPS redirect), `443/tcp+udp` (app + CG ID, HTTP/3), `4443/tcp` (call signalling), `40000–40099/udp+tcp` (WebRTC media; TCP is the fallback for UDP-blocking client networks).
