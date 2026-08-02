> Status: verified against commit 3c42f772a, 2026-08-02

# Common Ground Infrastructure Documentation

This document covers the full infrastructure stack for Common Ground, a Discord alternative built as a Docker Compose application with a React frontend, Node.js backend, PostgreSQL database, Redis caching, S3-compatible object storage, and WebRTC media server.

There are two deployment shapes, each with its own compose file:

- **Dev / internal stack** — `docker/docker-compose.yml`, driven by `run.sh`. Includes a local Hardhat dev chain and test-contract deployment; TLS is self-signed; `DEPLOYMENT` is configurable.
- **Self-hosted single-server production** — `docker/docker-compose.selfhost.yml`, driven by `docker/selfhost/selfhost.sh`. Caddy terminates real Let's Encrypt TLS, `DEPLOYMENT=prod` on any domain, no dev chain, secrets are generated. See [section 7](#7-self-hosted-single-server-deployment).

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
- **Environment:** `POSTGRES_DB=postgres`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD` (from `PG_SU_PASSWORD`), `PG_WRITER_PASSWORD`, `PG_READER_PASSWORD`
- **Health check:** `pg_isready -U postgres`, interval 1m, timeout 5s, 5 retries
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
- **Backend connection:** `srv/redis/index.ts` (the only file that creates clients) resolves `process.env.REDIS_URL || 'redis://redis:6379'`, password from the Docker secret `redis_password` or `REDIS_PASSWORD`. Neither compose file sets `REDIS_URL`; it exists for deployments that run Redis somewhere else.

> The former `redis-blockscout` service is now fully commented out in the compose file (it only existed for the optional Blockscout explorer).

#### `api`
- **Image:** `cryptogram/backend` (built from `docker/backend/Dockerfile_dev_stage_1`)
- **Purpose:** Main HTTP REST API server. Handles all `/api/v2/*` requests plus the Bot API v1 (`/BotV1/*`): authentication, community management, file uploads, messaging, contracts, notifications, Twitter/Lukso integrations, search, reporting, bots, and staking.
- **Command:** `node /dist/api.js`
- **Port:** Internal only (reached by nginx on port 4000 over the Docker network)
- **Depends on:** `db`, `redis`, `seaweedmaster`, `s3`, `memberlist`
- **Volumes:**
  - `./vapid_keys.json:/run/secrets/vapid_keys_json:ro` — VAPID keys for web push notifications
  - `./api_data:/api_data:ro` — static API data
- **Key environment variables:** `DB_TYPE=writer`, `PG_PASSWORD` (writer), `REDIS_PASSWORD`, `REDIS_SECRET`, `REDIS_LEGACY_MODE=true`, `DEPLOYMENT`, `BASE_URL`, `CGID_URL`, `S3_SECRET`, `SENDGRID_API_KEY`, `GOOGLE_RECAPTCHA_SECRET_KEY`, Twitter OAuth credentials, the `STAKING_*` set, and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`).

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
- **Depends on:** `db`, `redis`, `seaweedmaster`, `s3`
- **Key environment variables:** the writer DB/Redis set, `S3_SECRET`, `SENDGRID_API_KEY`, and the `STAKING_*` set.

#### `mediasoup`
- **Image:** `cryptogram/backend`
- **Purpose:** WebRTC media server for voice/video calls. Uses the mediasoup library for SFU (Selective Forwarding Unit) functionality. Spawns one media worker per CPU core.
- **Command:** `node /dist/mediasoup.js`
- **Ports:**
  - `${EXTERNAL_LISTEN_IP}:4443:4443/tcp` — HTTPS signaling
  - `${EXTERNAL_LISTEN_IP}:40000-40099:40000-40099/udp` — RTP media transport (100 UDP ports)
- **Volumes:** `./nginx/certs:/dist/mediasoup/certs` — SSL certificates for DTLS (uses `nginx_certs/server-complete.pem` + `key.pem`)
- **Key environment variables:** `DB_TYPE=mediasoup`, `PG_PASSWORD` (from `PG_MEDIASOUP_PASSWORD`), `MEDIASOUP_ANNOUNCED_IP`, `DOMAIN`, `DEBUG=mediasoup*`, `INTERACTIVE=false`, `MEDIASOUP_DISABLE_LIBURING`, `LOCAL_CERTIFICATE_IP`
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
- **Depends on:** `db`
- **Restart policy:** on failure, max 2 attempts, 2-second delay, 60-second window. Does not run persistently.
- **Key environment variables:** `PG_SU_PASSWORD`, `PG_SU_NAME=postgres`, `PG_MEDIASOUP_PASSWORD`, `REDIS_PASSWORD`, `S3_SECRET`, `DEPLOYMENT`, `BASE_URL`

#### `seaweedmaster` / `seaweedvolume` / `s3` (SeaweedFS)
- **Image:** `chrislusf/seaweedfs:4.40` (all three; pinned — do not run an untagged/`latest` image, and keep any deployment at ≥ 4.34 for the 2026 security fixes)
- **`seaweedmaster`** — master server; manages volume topology and file-ID allocation. Command: `master -ip=seaweedmaster -volumeSizeLimitMB=16`. Single-copy replication via `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` / `..._OTHER=1`.
- **`seaweedvolume`** — volume server; stores file blobs. Command: `volume -mserver=seaweedmaster:9333 -port=8080 -ip=seaweedvolume -preStopSeconds=1`. Volume: `seaweedfs-volume:/data`.
- **`s3`** — filer with S3-compatible API on port 8333. Command: `filer -master="seaweedmaster:9333" -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333`. Network alias `s3.local` (used by nginx to proxy file requests). Volumes: `./s3_config/s3.json:/etc/seaweedfs/s3.json:ro` and `seaweedfs-buckets:/data`.

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
- **Image:** `commonground/node20` (built from `docker/node20/`)
- **Purpose:** Build container. Not a running service — invoked via `docker compose run` to execute build commands (yarn install, craco build, tsc compile, contract deployment). Mounts the entire project directory.
- **User:** `${BUILDER_UID}:${BUILDER_GID}` (matches host user to avoid permission issues)
- **Volumes:** `../:/cg`, `builder-cache:/builder-cache` (persistent yarn cache)
- **Default command:** `echo "Not running interactive, exiting..."` (always invoked with explicit commands)

### Commented-Out Services (Not Active)

| Service | Purpose |
|---------|---------|
| `pgadmin` | PostgreSQL admin web UI (dpage/pgadmin4:5.5). Port `127.0.0.1:8080:80`. |
| `redis-blockscout` | Redis cache for the Blockscout explorer. |
| `blockscout` | Blockchain explorer for the local Hardhat chain. Port `127.0.0.1:4000:4000`. |
| `blockscout-db` | Separate PostgreSQL instance for Blockscout. |
| `smart-contract-verifier` | Blockscout smart-contract verification service. |
| `visualizer` | Blockscout visualizer service. |

### Named Volumes

| Volume | Used By | Purpose |
|--------|---------|---------|
| `pgdata` | `db` | PostgreSQL data persistence |
| `pgadmin-data` | `pgadmin` (commented out) | pgAdmin data |
| `seaweedfs-volume` | `seaweedvolume` | File blob storage |
| `seaweedfs-buckets` | `s3` | S3 bucket metadata/data |
| `builder-cache` | `cg-builder` | Yarn package cache across builds |

### S3 Configuration

**File:** `docker/s3_config/s3.json` (dev) / `docker/s3_config/s3.selfhost.json` (self-host, generated by `init.sh`)

The SeaweedFS S3-compatible API is configured with two identities:
- **`anonymous`** — read-only access to the `cg-media` bucket, so uploaded media can be fetched without authentication.
- **an admin identity** (`some_admin_user` in dev, `cg_admin_user` in self-host) — full access (Admin, Read, List, Tagging, Write) using access key `cgadmin` and a secret key matching the `S3_SECRET` environment variable. Presigned `/files/...` URLs generated by the backend are verified against this key by nginx's rewrite.

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

### Full Build: `docker/build.sh` (`./run.sh build_full`)

The complete build pipeline, for first-time setup or full rebuilds.

**Steps (in order):**

1. **Stop and clean:** `docker compose down --remove-orphans`, then `docker compose build cg-builder`.
2. **Ensure Yarn 4.1.0:** if `.yarn` / `srv/.yarn` are missing, run `yarn set version 4.1.0` inside the builder.
3. **Generate SSL certificates:** compare `LOCAL_CERTIFICATE_IP` with the stored `certificate_ip`; if changed, regenerate root CA and server certs.
4. **Clear `backend/dist/` and `nginx/dist/`**, then install frontend dependencies (`docker compose run --rm cg-builder yarn`).
5. **Generate random build ID:** a random base64 string is written into `src/common/random_build_id.ts` for cache-busting / new-build detection.
6. **Build the React frontend:** `yarn craco --openssl-legacy-provider build` with `DEPLOYMENT=prod`, `GENERATE_SOURCEMAP=true`, `IMAGE_INLINE_SIZE_LIMIT=5000`, `NODE_OPTIONS=--max-old-space-size=8192`. Output goes to `../build/`, then `rsync`ed into `nginx/dist/`.
7. **Delete small SVG files:** removes SVGs ≤ 5000 bytes from `nginx/dist/static/media/` (these should be inlined by the bundler, not served as files).
8. **Build nginx image:** `docker compose build --no-cache nginx`.
9. **Generate VAPID keys:** if `vapid_keys.json` doesn't exist, generate Web Push VAPID keys via `npx web-push generate-vapid-keys`.
10. **Build the backend:** clear `backend/dist/`, `rsync` `srv/` (excluding `node_modules` and `.yarn`), copy `build/index.html` into `backend/dist/` (used for server-rendered meta tags), build `commonground/backend_stage_0`, then build the `api` image (stage 1 runs `yarn tsc`).
11. **Build and start the database:** `docker compose build --no-cache db && docker compose up -d db`.
12. **Start the full stack:** `docker compose up -d`.
13. **Deploy smart contracts:** runs `contracts/scripts/deploy.ts` against the local Hardhat node (`--network cgstack`).
14. **Show logs:** `./logs.sh`.

### Backend-Only Update: `docker/updateBackend.sh` (`./run.sh update_backend`)

Faster rebuild that only recompiles the backend: stops backend services, rebuilds `cg-builder` and nginx, regenerates certs/VAPID keys if needed, re-copies `srv/` sources and `build/index.html` into `backend/dist/`, builds the stage-0 and stage-1 backend images, then starts the stack and redeploys contracts.

### Frontend-Only Update: `docker/updateFrontend.sh` (`./run.sh update_frontend`)

Rebuilds only the frontend and nginx:
1. Clear `nginx/dist/`, rebuild `cg-builder`.
2. Install dependencies, generate a new random build ID.
3. Run `yarn craco --openssl-legacy-provider build` with `DEPLOYMENT=prod`, `GENERATE_SOURCEMAP=true`, `IMAGE_INLINE_SIZE_LIMIT=5000`, and **`NODE_OPTIONS=--max-old-space-size=4096`** (added to stop the frontend build running out of memory on small machines).
4. `rsync` the build output into `nginx/dist/`, then `docker compose up -d --no-deps --build nginx` and restart nginx.

### Backend Docker Image Build (Two-Stage for Dev)

- **Stage 0 (`Dockerfile_dev_stage_0`):** `FROM node:20.11-bookworm`. Installs system deps, copies `package.json` / `yarn.lock` / `.yarnrc.yml`, runs `yarn`. Cached; rebuilt only when dependencies change.
- **Stage 1 (`Dockerfile_dev_stage_1`):** `FROM commonground/backend_stage_0`. Copies the full `dist/` source and runs `yarn tsc`. Rebuilt on every code change.

**Production backend (`Dockerfile`):** single-stage build, `FROM node:20.11-bookworm`, installs system dependencies (build-essential, python3, Chromium libs for Puppeteer), runs `yarn && yarn tsc`, then cleans up build tools. Used by the CI/CD pipelines.

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

Per `AGENTS.md`, `docker/.env` is tracked in the repo **as a placeholder template** (values such as `your-key` / `your-listid`); real values are kept local and never staged. The table describes purpose, not the committed literals.

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
| `BUILDER_UID` / `BUILDER_GID` | Host UID/GID for the builder container (avoids mounted-volume permission issues). |
| `RECALCULATE_BALANCES_AND_ROLES` | If `true`, recomputes all token balances/roles on `onchain` startup. |
| `MEDIASOUP_DISABLE_LIBURING` | Disables io_uring in mediasoup (workaround for some kernels/containers). |
| `LOCAL_CERTIFICATE_IP` | IP baked into self-signed certs. Empty = no certs generated; set a LAN IP for multi-device testing. |
| `MEDIASOUP_ANNOUNCED_IP` | IP mediasoup advertises for WebRTC ICE candidates; must be client-reachable. |
| `EXTERNAL_LISTEN_IP` | Host port-binding interface. `127.0.0.1` = localhost only, `0.0.0.0` = all interfaces. |
| `MAILCHIMP_LIST_ID` / `MAILCHIMP_API_KEY` | Newsletter list sync. |
| `QUIKNODE_*` | Per-chain RPC endpoint URLs used by `onchain` (name is historical — any JSON-RPC URL works). Now includes `QUIKNODE_LUKSO`. |
| `INFURA_LINEA` | RPC endpoint for Linea. |
| `GOOGLE_RECAPTCHA_SECRET_KEY` | Server-side reCAPTCHA v2 secret. |
| `TWITTER_CALLBACK_URL` / `TWITTER_OAUTH2_CLIENT_ID` / `TWITTER_OAUTH2_CLIENT_SECRET` / `TWITTER_API_KEY` / `TWITTER_API_SECRET` | Twitter/X login. |
| `SENDGRID_API_KEY` | SendGrid transactional email. |

Additional variables consumed by the compose file when present (with defaults): the `STAKING_*` set (`STAKING_CHAIN`, `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, `STAKING_BASE_RATE`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`) and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`). See [`docs/BOT-API.md`](../BOT-API.md) and [`docs/ROADMAP-staking.md`](../ROADMAP-staking.md).

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

The project uses **Azure DevOps Pipelines** (YAML). These pipelines target the CG-operated `app.cg` / `staging.app.cg` deployment (self-hosting does not use them).

### Staging: `pipelines/build-and-deploy-beta.yml`

**Trigger:** push to `staging`. **Pool:** `ubuntu-20` (self-hosted agent).

Steps: install Docker/Node/Yarn toolchain → fetch the secure `.yarnrc` (private registry creds) → `yarn` install → copy `srv/` to `docker/backend/dist/` → generate a build ID (written to both `src/common/random_build_id.ts` and `docker/backend/dist/common/random_build_id.ts`) → frontend build with `DEPLOYMENT=prod GENERATE_SOURCEMAP=false IMAGE_INLINE_SIZE_LIMIT=5000 PUBLIC_URL="https://staging.app.cg"` → copy `index.html`/build output into backend and nginx dirs → build and push **backend** and **nginx** images (nginx build args `SERVER_NAME=staging.app.cg`, `CGID_SERVER_NAME=id.staging.app.cg`) with tags `beta` + `$(Build.BuildNumber)` → deploy via **Ansible** over SSH (`docker_swarm_deploy_beta.yml` for the main stack, `deploy_docker_mediasoup.yml` for mediasoup) → clean up.

### Production: `pipelines/build-production.yml`

**Trigger:** push to `production`. Nearly identical, but: `PUBLIC_URL="https://app.cg"`; images tagged `0.1`, `latest`, `$(Build.BuildNumber)`; nginx build args `SERVER_NAME=app.cg`, `CGID_SERVER_NAME=id.app.cg`; **no Ansible deploy step** (build-only — production deploy is manual).

### Clean-Up Template: `pipelines/sub-templates/clean-up.yml`

Shared template that deletes the build work directory, `condition: always()`.

### Deployment Architecture (CG-operated prod/staging)

- Images built in CI, pushed to container registries.
- Production infra uses **Docker Swarm** (per the Ansible playbook names).
- Mediasoup nodes deploy separately (dedicated media hosts).
- TLS is terminated at the edge (Cloudflare), not in the nginx container.

---

## 6. Developer Workflow

### Entry Point: `run.sh`

`run.sh` (project root) is the primary dev interface. It sources `docker/.env`, changes to `docker/`, and dispatches to sub-commands via a `docker_compose` wrapper around `docker-compose.yml`.

### Available Commands

| Command | Effect |
|---|---|
| `./run.sh start` | React dev server (hot reload) on `http://localhost:3000`, run via `craco start` in `cg-builder`. Backend stack must already be up. |
| `./run.sh start_https` | Same, but HTTPS with self-signed certs — required for WebRTC calls and LAN multi-device testing. |
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

1. **First-time setup:** `./run.sh build_full`.
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
- **Caddy** (`caddy:2-alpine`) fronts everything and obtains/renews **Let's Encrypt** certificates automatically for the app domain, the CG ID domain, and mediasoup call signalling (port 4443).
- **nginx** is built from `Dockerfile_selfhost` (real domains, parameterized CSP, instance-config injection) instead of the dev image.
- **`DEPLOYMENT=prod`** on any domain — full production behaviour without hardcoding `app.cg`.
- **No `hardhat` dev chain, no `redis-blockscout`, no test-contract deployment.**
- **Postgres loads the tuned `postgresql.conf`** (same `config_file` command as dev).
- **Redis `maxmemory` is tuned small** (`${REDIS_MAXMEMORY:-1536mb}` total) instead of the dev 6 GB.
- **`mediasoup` and `onchain` are optional**: they carry the Compose profiles `calls` and `blockchain`, which `selfhost.sh` enables from `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` in `.env.selfhost` (both default to `true`). See [docs/deployment §3.8](../deployment/README.md#38-optional-services-calls-and-blockchain) and `docker/SELFHOST.md`.
- **SeaweedFS master** uses `-volumeSizeLimitMB=${SEAWEED_VOLUME_LIMIT_MB:-1024}`.

### Operation scripts

- **`docker/selfhost/init.sh <domain> <acme-email> [id-domain] [public-ip]`** — one-time bootstrap. Idempotent (never overwrites existing files). It:
  - Auto-detects the public IP (via ipify) if not supplied.
  - Generates `docker/.env.selfhost` with fresh random secrets (`openssl rand`) — all DB/Redis/S3 credentials, resource-tuning defaults sized for 16 GB, bot limits, and a fully-commented set of optional-integration keys. Written `chmod 600`.
  - Generates `docker/s3_config/s3.selfhost.json` with an S3 secret matching the generated `S3_SECRET` (`chmod 600`).
  - Generates a self-signed cert in `docker/selfhost/certs/` for the internal caddy→mediasoup hop only (clients only ever see the Let's Encrypt cert).
  - The generated `.env.selfhost` prefills the RPC endpoints with **free public JSON-RPC URLs** and `CG_ACTIVE_CHAINS=eth,arbitrum,xdai,base,matic,lukso`, so token-gating works out of the box.
- **`docker/selfhost/selfhost.sh <cmd>`** — build/operate wrapper. Requires `.env.selfhost`; runs Compose with `--env-file .env.selfhost -f docker-compose.selfhost.yml`. Commands: `build`, `up`, `down`, `logs [service]`, `ps`, `stats`, `compose <args>`, `update` (git pull + rebuild + restart). It sets `COMPOSE_PROFILES` from the `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` switches and runs `up`/`down`/`update` with `--remove-orphans`, so a service whose switch was flipped off is actually removed. The `build` command mirrors `build.sh` but uses `NODE_OPTIONS=--max-old-space-size=4096` and `GENERATE_SOURCEMAP=false`, and builds the nginx image from `Dockerfile_selfhost`.

### Caddy (`docker/selfhost/Caddyfile`)

Env-driven (`CG_DOMAIN`, `CG_ID_DOMAIN`, `CG_ACME_EMAIL`):
- `{$CG_DOMAIN}` and `{$CG_ID_DOMAIN}` → `reverse_proxy nginx:80` (zstd/gzip).
- `{$CG_DOMAIN}:4443` → `reverse_proxy https://mediasoup:4443` with `tls_insecure_skip_verify` (the internal hop trusts mediasoup's self-signed cert).
- Ports published: `80`, `443` (tcp+udp, HTTP/3), `4443` (tcp). WebRTC media UDP `40000–40099` is published directly by the mediasoup container.

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

Off by default. To enable, deploy your own non-custodial `CgStaking` contract (`contracts/staking/`) and set `STAKING_CHAIN` (must be in `CG_ACTIVE_CHAINS`), `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, and optionally `STAKING_BASE_RATE` / `STAKING_MIN_LOCK_DAYS` / `STAKING_MAX_LOCK_DAYS` in `.env.selfhost`, then `./selfhost/selfhost.sh up` to recreate the `api`, `job-runner` and `onchain` services. See `docs/ROADMAP-staking.md`.

### Backups & firewall

State lives in three named volumes: `pgdata` (database) and `seaweedfs-volume` + `seaweedfs-buckets` (uploaded media). Redis is intentionally unpersisted (sessions/ephemeral only). Ports to open: `80/tcp` (ACME + HTTPS redirect), `443/tcp+udp` (app + CG ID, HTTP/3), `4443/tcp` (call signalling), `40000–40099/udp` (WebRTC media).
