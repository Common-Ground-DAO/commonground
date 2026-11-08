> Status: optional www redirect verified against commit 4095d86,
> 2026-11-08; other sections verified against commit 8613352a4, 2026-08-04; image-moderation
> additions against the fix/image-filter-review-53 branch, 2026-08-15; local
> TLS mode, call ports, root builds and startup ordering against commit
> a5633d5be (+ fix/selfhost-local-test), 2026-10-27; npx/lockfile-refresh
> notes, chunking figures, tests and the reference-client pipeline against
> commit 935232158, 2026-10-31; dev env template (`docker/.env.example`,
> `docker/ensureEnv.sh`, generated `s3.json`, existing-checkout steps) and
> `s3.selfhost.json` ownership against commit 69999fa20 (chore/env-template),
> 2026-10-31; image pins, Node 26 / trixie, Yarn 4.18.1, immutable installs and
> verified binary downloads against commit 5f73578, 2026-10-31; email (SMTP
> variables, `mailpit` dev service, selfhost `mail` relay and bounce receiver),
> and `MEDIASOUP_TRUST_PROXY` against commit e44dac1, 2026-10-31; PostgreSQL 18
> (`db` image, volume layout, `postgresql.conf`, init roles, major upgrades)
> against commit ff0da06, 2026-10-31; the Valkey instances (`redis`,
> `redis-cache`), their roles, persistence and the backend's Redis client
> behaviour against commit ff0da06, 2026-10-31; git-dependency and `npx` rows
> of §2 and the age-gate bullet against commit ff0da06, 2026-10-31; `Passkey`
> in the API allowlist, the passkey fields of the injected instance config and
> the passkey/legacy CG ID variables against commit 54e2d73, 2026-10-31; the
> Caddy edge that replaced nginx in the dev and self-host stacks (§1 `caddy`,
> `vite-tls`, `mediasoup`, TLS certificates; §2 build steps and the HTML check;
> §3; §6 commands; §7) against commit fe3937f, 2026-10-31;
> `TRANSFER_TARGET_URL` against commit 9fc05a9, 2026-11-01; the end-to-end
> browser suite (§6 `e2e`/`e2e_instance` commands and "End-to-end browser
> suite") against commit 01db4cc, 2026-11-01; backup and
> restore (§7 files, operation scripts, "Backups & firewall") against commit
> 818d4c6, 2026-11-01; the "state instance is full" runbook (sessions only for
> requests that store something) against commit eab2a27, 2026-11-01; the
> state instance's session keys (`sess-revoked:`, `sess-user:`, `sess-gen:`, `sess-keep:`) and the
> one-hour pre-login sessions in that runbook against commit 23a4c1e, 2026-11-01;
> Vite 8 / Rolldown (§2 package-manager allowlist, "Frontend build steps",
> output layout incl. the worker's buffered scripts, chunking; §6 dev-server commands)
> against commit 3e8b08e, 2026-11-01; Tailwind CSS 4 in "Frontend build steps" (the
> build row, the memory figure) against commit 440c779, 2026-11-02; the build ID (§2),
> the backend health checks (§1), `migrate-db`'s disabled health check, and in §7 log
> rotation, memory limits, IPv6 detection, the Compose-plugin requirement and
> `harden.sh` against commit 170a73b, 2026-11-03;
> the gateway of a moved instance (§1 `api`/`wsapi`, §3 `cg_gateway_app`/`cg_cgid_site` and the instance-config prefix,
> §7), the session secret and `PG_POOL_MAX` at startup, `max_connections` and the e2e gateway
> option against commit 696102b, 2026-11-06; the gateway's replacement service worker (Caddy
> image, "Gateway of a moved instance") against commit 050245d, 2026-11-07;
> the self-host builder's own network, the storage container's config copy, the secret files'
> modes and the outgoing port-25 rule against commit 04c72b2, 2026-11-07

# Common Ground Infrastructure Documentation

This document covers the full infrastructure stack for Common Ground, a Discord alternative built as a Docker Compose application with a React frontend, Node.js backend, PostgreSQL database, Valkey (Redis-compatible) for sessions, pub/sub and caching, S3-compatible object storage, and WebRTC media server.

There are two deployment shapes, each with its own compose file:

- **Dev / internal stack** — `docker/docker-compose.yml`, driven by `run.sh`. Includes a local Hardhat dev chain and test-contract deployment; TLS comes from Caddy's local CA (`tls internal`); `DEPLOYMENT` is configurable.
- **Self-hosted single-server production** — `docker/docker-compose.selfhost.yml`, driven by `docker/selfhost/selfhost.sh`. Caddy terminates real Let's Encrypt TLS (or, for LAN/test instances, TLS from its own local CA), `DEPLOYMENT=prod` on any domain, no dev chain, secrets are generated. See [section 7](#7-self-hosted-single-server-deployment).

---

## Table of Contents

1. [Docker Compose Stack (dev)](#1-docker-compose-stack-dev)
2. [Build Process](#2-build-process)
3. [Caddy (the edge)](#3-caddy-the-edge)
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
- **Image:** `cryptogram/db:18` (custom build from `docker/db/`; the tag names the Postgres major, so a leftover 14 image — `cryptogram/db:latest` — is never started on the 18 mount path, where it would initialize an empty cluster in an anonymous volume)
- **Base image:** `postgres:18-alpine` line, exact tag + digest pinned in `docker/db/Dockerfile`
- **Purpose:** Primary relational database. Stores all application data: users, communities, messages, channels, contracts, etc.
- **Port:** `127.0.0.1:5432:5432` (localhost only)
- **Command:** `postgres -c config_file=/etc/postgresql/postgresql.conf`. This explicit `config_file` flag is required — without it Postgres ignores the mounted `postgresql.conf` and runs on image defaults (this was a real bug: the config was mounted but never loaded).
- **Init script:** `docker/db/init.sh` runs on first startup via `docker-entrypoint-initdb.d` (only when the data directory is empty). Creates the `cryptogram` database plus the `writer`, `reader` and `mediasoup` login roles with passwords from `PG_WRITER_PASSWORD` / `PG_READER_PASSWORD` / `PG_MEDIASOUP_PASSWORD` (the `mediasoup` role only when that variable is set). It grants nothing — table privileges come from the migrations. Skips creation if the `cryptogram` database already exists. Since all application roles exist right after initialization, a fresh cluster can take a `pg_restore` of an existing database as well as the migration chain ([docs/database](../database/README.md#restoring-a-postgresql-14-database-into-18)); migration `1689160339881-addMediasoupRole` creates the `mediasoup` role only where it is still missing (`PG_MEDIASOUP_PASSWORD` empty at initialization). A SQL error in `init.sh` fails the first start (`ON_ERROR_STOP`); the cluster is then incomplete, so remove the volume before retrying.
- **Volumes:**
  - `pgdata:/var/lib/postgresql` — persistent database storage. Postgres 18 images keep the cluster in a major-version subdirectory: `PGDATA=/var/lib/postgresql/18/docker` (the image default, not overridden).
  - `./db/postgresql.conf:/etc/postgresql/postgresql.conf` — the tuned config, a short file that lists only the settings that differ from the PostgreSQL 18 defaults (each with its reason): `listen_addresses='*'`, `max_connections=200`, `shared_buffers=1GB`, `effective_cache_size=4GB`, `work_mem=8MB`, `maintenance_work_mem=256MB`, `random_page_cost=1.1`, `jit=off`, `max_wal_size=2GB`, `log_lock_waits=on`. Sized for the 16 GB self-host reference machine. Because the file replaces the one `initdb` writes into the data directory, nothing from that one applies — until F3 this meant the PostgreSQL 14 setup ran with the compiled-in `shared_buffers` of **8 MB**. `TimeZone` (`GMT`) and `default_text_search_config` (`pg_catalog.simple`) stay at the compiled-in defaults, exactly as before. `listen_addresses='*'` covers only the container's own interfaces (loopback + the compose network); the dev stack publishes the port on the host's `127.0.0.1`, the self-host stack not at all, and the image's `pg_hba.conf` requires a SCRAM password for every login from outside the container (socket and loopback inside the container are `trust`).
- **Health check:** `pg_isready -U postgres -h 127.0.0.1`, interval 1m, timeout 5s, 5 retries; probed every 2s during a 2m `start_period` so `migrate-db` (which waits for `service_healthy`) isn't held for a full minute on first boot. It probes over TCP on purpose: on first boot the image's init runs a temporary server that answers on the unix socket only, and a socket probe would report healthy before the real server listens. Same in both compose files.
- **Environment:** `POSTGRES_DB=postgres`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD` (from `PG_SU_PASSWORD`), `PG_WRITER_PASSWORD`, `PG_READER_PASSWORD`, `PG_MEDIASOUP_PASSWORD`
- **Shared memory:** 256 MB (`shm_size`)
- **Stop behavior:** SIGINT with 1-minute grace period
- **Restart:** `unless-stopped`
- **Postgres major upgrades:** a data volume written by another major version does not start. Until 2026-10-31 both stacks ran PostgreSQL 14 with the volume mounted at `/var/lib/postgresql/data`, so an existing `pgdata` volume holds a 14 cluster at its root. The 18 entrypoint finds it and exits without touching the old cluster (it only adds an empty `18/docker` directory), printing `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster" … there appears to be PostgreSQL data in: /var/lib/postgresql`. The container restarts in a loop (`unless-stopped`), `migrate-db` and everything behind it never start, and `docker compose up` (`./run.sh up`, `./run.sh build_full`, `./selfhost/selfhost.sh up`) stops with `dependency failed to start: container <project>-db-1 is unhealthy`; `compose logs db` shows the error above. There is no automatic upgrade path:
  - **Dev stack:** dev data is disposable — drop the volume and rebuild. Every checkout on a machine shares the volume `docker_pgdata` (compose project `docker`, see `docker/ensureEnv.sh`), so this resets the dev database of all of them: `./run.sh down && docker volume rm docker_pgdata && ./run.sh build_full`. `docker/.env` stays as it is; its passwords are applied to the new cluster. The old image can go afterwards: `docker rmi cryptogram/db:latest`.
  - **Data you want to keep** (e.g. a self-host instance created before 2026-10-31): dump with the old version **before** updating, then restore into the fresh 18 cluster — the steps are in [docs/database](../database/README.md#restoring-a-postgresql-14-database-into-18) (`pg_dump -Fc` / `pg_restore`), and [SELFHOST.md](../../docker/SELFHOST.md#postgresql-18) has the self-host sequence.
  - The next major upgrade (19+) will find this cluster under `18/docker` and refuse the same way; the layout leaves room for a `pg_upgrade --link` into a sibling directory then.

#### `redis` and `redis-cache` (Valkey)
- **Image:** `valkey/valkey:9.1-alpine` line, exact tag + digest pinned in the compose files (both services use the same image). Valkey is the BSD-licensed fork of Redis and speaks the same protocol; it replaced `redis:6.2` on 2026-10-31 (roadmap item F4). The service names, the `redis://` URLs and the `REDIS_*` variables keep their old names — they name the protocol, not the server.
- **Two instances, split by what may be lost** (`srv/redis/index.ts`, `INSTANCE_OF`):

  | Service | Holds | Policy |
  |---|---|---|
  | `redis` (state) | sessions (`sess:`, with `sess-revoked:`, the per-user index `sess-user:` and the copies of the session generations `sess-gen:`, `sess-keep:`), the Socket.IO pub/sub (`v2:`), and every key whose loss changes behaviour: rate-limit windows (`ratelimit:`, `bot-ratelimit:`), replay guards (`captcha:altcha:used:`, `pluginRequest:`), the shared ALTCHA HMAC key (`captcha:altcha:hmackey`), bot presence leases (`bot-presence:`), user status (`ud:`), `online-user-addresses`, `tmp:` | `--maxmemory-policy noeviction`; RDB snapshots in the `valkey-data` volume (`--save "900 1 300 100"`, final snapshot on shutdown, `stop_grace_period: 1m`); `--stop-writes-on-bgsave-error no` |
  | `redis-cache` | data that can be rebuilt at any time — today only the URL-preview cache (`urlpreview:`) | `--maxmemory-policy allkeys-lru`; no persistence (`--save ""`) |

- **Why two:** with one `noeviction` instance (the layout until 2026-10-31) a cache that fills the shared `maxmemory` makes every *write* fail with `OOM command not allowed` — and a session is a write. Measured with cache keys filling a `noeviction` instance: `createUser` still answered `OK` and set a cookie, but the session was never stored, so the new user was logged out on the next request, and every rate-limited route failed (`ZADD` refused); sessions that already existed kept working, because reading and refreshing them (`GET`, `EXPIRE`) is not refused. With the cache on its own `allkeys-lru` instance it evicts its own entries and cannot reach the state instance's budget. The state instance keeps `noeviction` on purpose: under memory pressure, refusing writes is visible, while evicting would silently drop sessions, rate-limit windows or replay guards. Every cache writer still caps its own entries (URL previews: ≤ 8 KB, 1 h TTL, rate-limited per user) — the separate instance is what makes a cache unable to break logins even if a future writer forgets.
- **Commands:** dev `valkey-server --requirepass ${REDIS_PASSWORD} --maxmemory 1gb --maxmemory-policy noeviction --save "900 1 300 100" --stop-writes-on-bgsave-error no --appendonly no` and, for `redis-cache`, `--maxmemory 256mb --maxmemory-policy allkeys-lru --save "" --appendonly no`. Self-host: the same with `${REDIS_MAXMEMORY:-1024mb}` / `${REDIS_CACHE_MAXMEMORY:-256mb}`.
- **Healthcheck:** both services run `valkey-cli ping` (authenticated through `REDISCLI_AUTH=${REDIS_PASSWORD}` in the container environment, so the password is not on the command line) every 30 s, probing every 2 s during a 1-minute start period; healthy once the answer is `PONG`. Nothing depends on it yet (`depends_on` stays plain) — it shows in `docker ps` / `selfhost.sh ps`.
- **Memory:** `maxmemory` limits the dataset, not the container. Allocator fragmentation and, above all, the copy-on-write pages of the forked background save come on top — up to about twice the dataset while a snapshot is written under heavy writes. Budget the host for that; below 8 GB RAM, the defaults (1 GB + 256 MB) next to the rest of the stack are tight.
- **Persistence (state instance):** a clean stop or restart writes a final snapshot and the next start loads it, so updates and reboots no longer log everyone out. A crash (`SIGKILL`, OOM kill, power loss) loses what changed since the last snapshot — at most 15 minutes, at most 5 minutes when 100 or more writes have accumulated; affected users log in again. There is deliberately no 1-minute save point: during a flood of new sessions (see the runbook below) it would fork a snapshot every minute. `--stop-writes-on-bgsave-error no` keeps logins working if a background save fails (e.g. a full disk); the failure is logged by Valkey. Background saves fork: set `vm.overcommit_memory = 1` on the host (`sysctl`; Valkey logs a warning at startup otherwise — it is a kernel setting and cannot be set from Compose). AOF is off: the data needs no per-second durability, and RDB snapshots are cheap at this size. The snapshot holds session contents — treat the volume like the database volume; it does not need to be backed up (losing it logs everyone out once).
- **Auth / exposure:** both instances use `REDIS_PASSWORD` (`--requirepass`) and publish no host port; they are reachable only on the `cryptogram` network. The server process runs as the image's `valkey` user (uid 999).
- **Backend connection:** `srv/redis/index.ts` resolves `process.env.REDIS_URL || 'redis://redis:6379'` for the state instance and `process.env.REDIS_CACHE_URL || 'redis://redis-cache:6379'` for the cache, password from the Docker secret `redis_password` or `REDIS_PASSWORD` for both, and hands them to `srv/redis/client.ts` — the only file that calls `createClient`, where `RESP: 2` is pinned and every client gets its `error` listener. Neither compose file sets the URLs; they exist for deployments that run Valkey/Redis elsewhere. Pointing both at one server works (the key prefixes are disjoint) but gives up the isolation. Clients connect lazily on first use, so `memberlist`, `migrate-db` and the job-runner main thread hold no connection; see [docs/realtime](../realtime/README.md#redis-pubsub--data) for which process opens what and how outages are handled.
- **Runbook: the state instance is full.** Symptom: logins "succeed" but the user is logged out on the next request, rate-limited routes fail, and the backend logs `OOM command not allowed when used memory > 'maxmemory'`. A likely cause is a flood of sessions. Requests that store nothing create none (`saveUninitialized: false`, `srv/util/sessionSetup.ts`); a request that does — `User/getSignableSecret`, the WebAuthn and sign-up endpoints — stores a new session when it comes without a session cookie, which the store keeps for an hour until someone logs in with it (12 hours from login on), and each of these endpoints is limited per client network ([auth-identity §4 "Limits"](../auth-identity/README.md#limits)). Check and recover — run each command inside the container, prefixed with `./selfhost/selfhost.sh compose exec redis` (self-host) or `./run.sh compose exec redis` (dev); `REDISCLI_AUTH` is already set there:
  1. `valkey-cli INFO memory` (compare `used_memory_human` with `maxmemory_human`), `valkey-cli DBSIZE`, and `sh -c "valkey-cli --scan --pattern 'sess:*' | wc -l"` for the number of sessions.
  2. Remove the sessions: `sh -c "valkey-cli --scan --pattern 'sess:*' | xargs -r -n 500 valkey-cli UNLINK"` — logs everyone out, keeps rate-limit windows and replay guards. Or `valkey-cli FLUSHDB` to clear everything (global logout, rate-limit windows and replay guards reset).
  3. Then raise `REDIS_MAXMEMORY` if the instance is simply too small, or find and block the source of the cookieless requests.

  Restarting the container does **not** help any more: the snapshot brings the sessions back.
- Until 2026-08-01 there were three identically configured instances (`redis-sessions`, `redis-socketio`, `redis-data`); that split was mechanical. From 2026-08-01 to 2026-10-31 one unpersisted `redis:6.2` instance served everything.

> The former `redis-blockscout` service (a cache for the deleted optional Blockscout explorer stack) was removed from the compose file on 2026-08-02.

#### `api`
- **Image:** `cryptogram/backend` (built from `docker/backend/Dockerfile_dev_stage_1`)
- **Purpose:** Main HTTP REST API server. Handles all `/api/v2/*` requests plus the Bot API v1 (`/BotV1/*`): authentication, community management, file uploads, messaging, contracts, notifications, Twitter/Lukso integrations, search, reporting, bots, and staking.
- **Command:** `node /dist/api.js`
- **Port:** Internal only (reached by Caddy on port 4000 over the Docker network)
- **Depends on:** `migrate-db` (`condition: service_completed_successfully`, see [migrate-db](#migrate-db)), `db`, `redis`, `redis-cache`, `seaweed`, `memberlist`
- **Volumes:**
  - `./vapid_keys.json:/run/secrets/vapid_keys_json:ro` — VAPID keys for web push notifications
  - `./api_data:/api_data:ro` — static API data
- **Key environment variables:** `DB_TYPE=writer`, `PG_PASSWORD` (writer), `REDIS_PASSWORD`, `REDIS_SECRET`, `DEPLOYMENT`, `BASE_URL`, `CGID_URL` (read only in legacy CG ID mode), `S3_SECRET`, the `SMTP_*`/`EMAIL_FROM*` set (see [Email](#email-smtp)), `GOOGLE_RECAPTCHA_SECRET_KEY`, Twitter OAuth credentials, the `STAKING_*` set, and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`).
- **Passkey variables (every backend process — api, wsapi, migrate-db, job-runner, onchain, memberlist, mediasoup — with the same values; both compose files pass `PASSKEY_RP_ID=${PASSKEY_RP_ID:-}` and `CG_LEGACY_CGID=${CG_LEGACY_CGID:-false}` to each, from `docker/.env` / `.env.selfhost`, and `BASE_URL` too — `mediasoup` included, which derives the RP ID from it for the account-security check at its login):** `PASSKEY_RP_ID` (empty = the `BASE_URL` host — on selfhost the `CG_DOMAIN` host; otherwise that host or a parent domain; must never change once passkeys exist — the selfhost caddy gets the same value as `CG_PASSKEY_RP_ID` for the instance config) and `CG_LEGACY_CGID=true` (legacy CG ID / gateway mode only). `CGID_URL` is passed to `api` only and read only in legacy mode (the CG ID app's RP and CORS origin). Shared code reads the RP ID in whichever process it runs, see [docs/auth-identity §7](../auth-identity/README.md#7-passkeys).
- **`TRANSFER_TARGET_URL`** (`api` only, optional): the `https` origin transfer links lead to (`User/createTransferLink`, [docs/auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)); unset = this instance mints no links (the default — only the move gateway sets it, e.g. `https://cg.box`). A malformed value stops the api at startup. Only the self-host profile's `gateway-api` service passes it (`https://${CG_DOMAIN}`); `docker/.env.example` lists it, commented out.
- **`REDIS_SECRET`** (api, wsapi, job-runner): read at startup; missing, the template placeholder or shorter than 16 characters stops the process (`srv/util/sessionSecret.ts`).
- **`PG_POOL_MAX`** (every backend process, optional): connections of the process's PostgreSQL pool (`srv/util/postgres.ts`; each job-runner worker thread has its own pool), default 10 (node-postgres' own); anything but a positive integer stops the process. The self-host compose file sets it per service (`PG_POOL_MAX_API` … in `.env.selfhost` override the defaults: api 20, wsapi 10, memberlist 6, job-runner 3 per thread, onchain 10, mediasoup 4, gateway-api 5, gateway-wsapi 3); the dev stack keeps the default. The sum stays below `max_connections` (`docker/db/postgresql.conf` has the arithmetic).
- **`CG_GATEWAY`** (`true` only on a gateway's api and wsapi, [docs/auth-identity §12](../auth-identity/README.md#12-gateway-mode)): serves only the gateway's routes and socket events, keeps its sessions and Socket.IO channels under the key prefix `gateway:`, and needs `CG_LEGACY_CGID=true` (and on the api `TRANSFER_TARGET_URL`). job-runner, onchain, memberlist, mediasoup and migrate-db exit when it is set.

#### `wsapi`
- **Image:** `cryptogram/backend`
- **Purpose:** WebSocket API server. Handles real-time communication at `/api/ws/` — message delivery, presence updates, typing indicators, etc.
- **Command:** `node /dist/wsapi.js`
- **Depends on:** `migrate-db` (`condition: service_completed_successfully`, see [migrate-db](#migrate-db)), `db`, `redis`
- **Key environment variables:** `DB_TYPE=writer`, `PG_PASSWORD`, `REDIS_PASSWORD`, `REDIS_SECRET`, `DEPLOYMENT`, `BASE_URL`, the passkey variables (see `api`)

#### `memberlist`
- **Image:** `cryptogram/backend`
- **Purpose:** Dedicated service for member-list queries. Offloads heavy member-list operations from the main API to avoid blocking other requests.
- **Command:** `node /dist/memberlist.js`
- **Depends on:** `migrate-db` (`condition: service_completed_successfully`, see [migrate-db](#migrate-db)), `db`

#### `job-runner`
- **Image:** `cryptogram/backend`
- **Purpose:** Background job processor. Runs scheduled and queued tasks: activity-score calculation, email sending, cleanup jobs, and the Spark staking-accrual job.
- **Command:** `node /dist/jobs.js`
- **Depends on:** `migrate-db` (`condition: service_completed_successfully`, see [migrate-db](#migrate-db)), `db`, `redis`, `seaweed`
- **Key environment variables:** the writer DB/Redis set, `S3_SECRET`, the `SMTP_*`/`EMAIL_FROM*` set, and the `STAKING_*` set.

#### `mediasoup`
- **Image:** `cryptogram/backend`
- **Purpose:** WebRTC media server for voice/video calls. Uses the mediasoup library for SFU (Selective Forwarding Unit) functionality. Spawns one media worker per CPU core.
- **Command:** `node /dist/mediasoup.js`
- **Ports:**
  - `${EXTERNAL_LISTEN_IP}:40000-40099:40000-40099/udp` — RTP media transport (100 UDP ports). mediasoup also listens on TCP `40000+n` (ICE-TCP fallback, see [docs/realtime](../realtime/README.md#mediasoup-configuration)); the dev stack does not publish that, the self-host stack does.
  - Signalling (wss, container port 4443) is not published by mediasoup: the `caddy` service terminates TLS on `${EXTERNAL_LISTEN_IP}:4443` and proxies to it.
- **Volumes:** `./mediasoup/certs:/run/mediasoup-certs:ro` — only `server.crt` + `server.key`, a self-signed certificate for the caddy→mediasoup hop (mediasoup serves HTTPS only; caddy does not verify it, no browser sees it). `docker/mediasoup/ensureInternalCert.sh` creates it when missing (`run.sh up`, `build.sh`, `updateBackend.sh`); the directory is gitignored.
- **Key environment variables:** `DB_TYPE=mediasoup`, `PG_PASSWORD` (from `PG_MEDIASOUP_PASSWORD`), `HTTPS_CERT_FULLCHAIN`/`HTTPS_CERT_PRIVKEY` (the internal certificate), `MEDIASOUP_ANNOUNCED_IP`, `DOMAIN`, `INTERACTIVE=false`, `MEDIASOUP_DISABLE_LIBURING`, `LOCAL_CERTIFICATE_IP`, `MEDIASOUP_TRUST_PROXY=true` (signalling arrives only through caddy, which sets `X-Forwarded-For`)
- **Depends on:** `migrate-db` with `condition: service_completed_successfully` — the tables and the `mediasoup` role's table privileges come from the migrations, and the role itself where `docker/db/init.sh` did not create it (`1689160339881-addMediasoupRole`), so an earlier start fails. Same in the self-host stack.
- **Restart:** `"no"` — does not auto-restart in the dev stack.

#### `onchain`
- **Image:** `cryptogram/backend`
- **Purpose:** Blockchain event listener and token-gating engine. Monitors ERC-20/721/1155 balances across multiple chains, assigns roles based on token holdings, indexes staking events, and syncs on-chain data.
- **Command:** `node /dist/onchain.js`
- **Depends on:** `migrate-db` (`condition: service_completed_successfully`, see [migrate-db](#migrate-db)), `db`, `redis`
- **Key environment variables:** all `QUIKNODE_*` and `INFURA_LINEA` RPC endpoint URLs (ETH, BSC, Polygon/Matic, Gnosis/xDai, Fantom, Avalanche, Arbitrum, Optimism, Base, Linea, Arbitrum Nova, Celo, Polygon zkEVM, Scroll, zkSync, **and LUKSO — `QUIKNODE_LUKSO`, now a configurable endpoint like the others**), the `STAKING_*` set, and `RECALCULATE_BALANCES_AND_ROLES`.

#### `migrate-db`
- **Image:** `cryptogram/backend`
- **Purpose:** Database migration runner. Executes on startup to apply pending schema migrations (and creates the mediasoup DB role if `docker/db/init.sh` has not).
- **Command:** `node /dist/migrateDb.js`
- **Depends on:** `db` with `condition: service_healthy` — `migrateDb.js` does not retry its connection, and on a fresh volume postgres initializes for several seconds.
- **Gate for every backend service** (since 2026-11-02, both compose files): `api`, `wsapi`, `memberlist`, `job-runner`, `onchain` and `mediasoup` depend on it with `condition: service_completed_successfully`, so none of them queries a schema that is not yet migrated (before, `memberlist` restarted a few times on a fresh install until the tables existed). Compose runs it again on every `up` — also `up -d <service>` for a single service, unless `--no-deps` — which is a no-op without pending migrations. All pending migrations run in one transaction (TypeORM's default), so a failing one leaves the schema as it was.
- **Restart policy:** `deploy.restart_policy` on failure, max 2 attempts (Compose v2 maps it to the container's `on-failure:2`; the 2-second delay and 60-second window are Swarm-only). Does not run persistently. `mediasoup` waits for it to complete successfully.
- **Health check:** disabled (`healthcheck: disable: true`, both compose files) — the image's check reads the report of a long-running process, which a one-shot run never writes; an exited `migrate-db` would otherwise stay listed as `unhealthy`.
- **Key environment variables:** `PG_SU_PASSWORD`, `PG_SU_NAME=postgres`, `PG_MEDIASOUP_PASSWORD`, `REDIS_PASSWORD`, `S3_SECRET`, `DEPLOYMENT`, `BASE_URL`

#### Backend health checks

Every long-running backend process reports its own health
(`srv/healthcheck.ts`, since 2026-11-02 — before, every process wrote an
unconditional "healthy" through `fakeHealthcheck()`): every 10 s it runs the
probes it depends on, each with a 5 s timeout, and writes `ok` or `fail` plus
one line per failed probe to `/dist/healthcheck.txt`. A probe whose last
attempt has not settled is not started again (a hung database connection does
not take one more pool client every round) and counts as failed. The image's
`HEALTHCHECK` (`srv/healthcheck/healthcheck.sh`; stage 1: every 15 s, timeout
5 s, 3 retries, start period 1 min probed every 5 s; the legacy single-stage
`Dockerfile`: every 20 s, timeout 5 s, start period 1 min, no start interval
— older engines' builders reject that flag) is healthy while that
report says `ok` **and** is at most 30 s old — so a process whose event loop
hangs turns unhealthy too. Each process deletes a report left from a
previous run at start (a container restart keeps its filesystem), so only its
own reports count. The script prints the report, so
`docker inspect -f '{{json .State.Health}}' <container>` shows which probe
failed.

| process | healthy means |
|---|---|
| `api` | PostgreSQL answers `SELECT 1` (its pool), the Valkey state instance answers `PING`, the HTTP listener on :4000 accepts connections |
| `wsapi` | the same three (Socket.IO listener on :4000; `srv/healthcheck/wsapi.ts`) |
| `gateway-api`, `gateway-wsapi` | the same code as `api` and `wsapi` (self-host profile `gateway`): the same three each |
| `onchain` | the same three |
| `memberlist` | PostgreSQL and its listener on :4000 — no Valkey (it uses none, and loads no Redis code for the check) |
| `job-runner` | PostgreSQL and Valkey (the workers publish their events through it); no listener |
| `mediasoup` | PostgreSQL (the call-server heartbeat; the process exits on its own when that fails), the signalling listener on :4443, every mediasoup worker running |

The cache instance (`redis-cache`) is not probed: the app works without it.
The Valkey probe uses the `data` client, so the job-runner's main thread
holds one Valkey connection more than before; its pool, used only by the
probe, has an `error` listener, so a database restart does not end the
job-runner. Measured on the disposable e2e instance (2026-11-02):

- `redis` stopped: `api`, `wsapi` and `job-runner` `unhealthy` after about
  45 s (`valkey: not connected`), `memberlist` and `mediasoup` stayed
  `healthy`; all `healthy` again within 15–20 s of the restart.
- `db` paused (connections hang instead of failing): every backend
  container `unhealthy` within 45–80 s (`postgres: no answer for 45 s`), no
  restarts; `healthy` again within 10–25 s of `docker unpause`.
- `db` stopped — the behaviour at the time of measurement (develop
  4731fc1 plus F7), not a property of the health check: `api` and `wsapi`
  exited once when the database closed their idle pool connections (the
  pool's `error` event had no listener in those processes), `mediasoup`
  exits when its heartbeat fails, and Docker restarted them; `memberlist` and
  `mediasoup` kept failing at startup until the database was back. The
  job-runner stayed up (restart count 0) and turned `unhealthy` after about
  45 s; the restarted ones reported `unhealthy`
  (`postgres: getaddrinfo EAI_AGAIN db`) once their start period had passed.
  All `healthy` again within 20–60 s of the restart.

Nothing in the stack depends on these states (`depends_on` stays plain);
they are for the operator and for monitoring (roadmap S4). Docker does not
restart an unhealthy container on its own.

#### `seaweed` (SeaweedFS)
- **Image:** `chrislusf/seaweedfs` 4.x, exact tag + digest pinned in the compose files (do not run an untagged/`latest` image, and keep any deployment at ≥ 4.34 for the 2026 security fixes). Moved 4.40 → 4.48 on 2026-10-31: 4.48 starts with exactly this command line and serves S3 (smoke-tested), and the SDK conformance suite passed against it.
- **Purpose:** S3-compatible object storage for uploaded files and images. One all-in-one `weed server` process replaces the former `seaweedmaster` / `seaweedvolume` / `s3` trio (consolidated 2026-08-02).
- **Command:** `server -dir=/data -ip=seaweed -master.volumeSizeLimitMB=16 -volume.max=0 -volume.preStopSeconds=1 -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333 -s3.port.iceberg=0`
  - `-s3` implies `-filer`, so the single process runs master, volume server, filer and the S3 gateway.
  - `-volume.max=0` auto-sizes the volume count from free disk space instead of the default cap of 8 (which at a 16 MB volume-size limit would cap the store at 128 MB).
  - `-s3.port.iceberg=0` disables the Iceberg REST catalog that SeaweedFS (since 4.40) otherwise starts on 8181 — nothing in this stack speaks Iceberg.
  - `weed server`, not `weed mini` (upstream's default CMD), on purpose: `mini` bundles WebDAV, an Admin UI and the Iceberg catalog, enables an embedded IAM API on the S3 port by default, and upstream reserves the right to evolve its defaults — `server` keeps a stable flag surface and no extra listeners.
  - Single-copy replication via `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` / `..._OTHER=1`.
- **Ports (all internal to the `cryptogram` network):** S3 8333, master 9333, volume 8080, filer 8888, plus their gRPC siblings (port + 10000). **Only 8333 is consumed by anything else in the stack** — Caddy proxies file requests to it and `srv/repositories/files.ts` uses it as its endpoint, both via the network alias `s3.local`.
- **Network alias:** `s3.local`
- **Volumes:** `./s3_config/s3.json:/etc/seaweedfs/s3.json:ro` (dev, generated by `docker/ensureEnv.sh`) and `seaweedfs-data:/data`. Self-host (and the e2e and conformance stacks layered on it) mounts `s3.selfhost.json` at `/run/cg/s3.json` instead: a small entrypoint copies it, as root, to `/etc/seaweedfs/s3.json` owned by the image's `seaweed` user (mode 600) and then runs the image's entrypoint, so the host file can stay mode 600 whoever owns it.
- **Data layout under `/data`:** volume blobs (`.dat`/`.idx`/`.vif`) at the root, filer leveldb in `filerldb2/`, master raft/sequence state in `m9333/`. Because blobs and filer metadata now share one volume, a filesystem snapshot of `/data` is atomic across both — which the former two-volume split could never be. See [docs/deployment](../deployment/) for the backup baseline.

**Storage engine of record (decision 2026-08-02).** SeaweedFS stays. A comparison against the alternatives (MinIO's community repo was archived read-only in April 2026) landed as follows:

- **RustFS — rejected.** Still pre-GA (`1.0.0-beta.12`), ~28 security advisories between Dec 2025 and Jul 2026 with no downward trend, documented unreviewed/LLM-reviewed merges of auth-relevant code, and an opaque MinIO-style `xl.meta` on-disk format. Not to be revisited before it has a year of boring GA history.
- **Garage (v2.3.0) and versitygw (v1.7.0) — credible, but not worth the move.** Garage is the community default for this profile and versitygw stores objects as plain POSIX files (the best possible backup story), but either swap means an S3-level data migration across every existing deployment — hosted and every self-host install — for no user-visible gain.
- The application's coupling is thin (`srv/repositories/files.ts` speaks plain S3 against one `cg-media` bucket), so a swap stays *possible*; re-evaluate only when a concrete need appears.

#### `caddy`
- **Image:** `cryptogram/caddy` (built from `docker/caddy/`, config `Caddyfile.dev`) — see [section 3](#3-caddy-the-edge)
- **Purpose:** The edge: serves the built frontend, routes to `api`, `wsapi`, `seaweed` and `mediasoup`, sets the security headers and serves the instance config.
- **Ports** (the container uses the same numbers):
  - `${EXTERNAL_LISTEN_IP}:8000` — HTTP
  - `${EXTERNAL_LISTEN_IP}:8001` — HTTPS
  - `${EXTERNAL_LISTEN_IP}:4443` — call signalling (wss) in front of mediasoup
- **Certificates:** Caddy's local CA (`tls internal`) in the `caddy-data` volume, for `localhost`, `127.0.0.1`, `app.cg.local`, `bs-local.com` and, when set, `LOCAL_CERTIFICATE_IP` (see [Dev stack](#dev-stack-caddyfiledev) for connections to an IP address). `./run.sh export_ca` writes the root certificate to `docker/caddy-local-root.crt` for importing into a browser.
- **Health check:** healthy once the local CA exists and `http://127.0.0.1:8000/robots.txt` answers; `vite-tls` waits for it, so the two never create a CA each on a fresh volume.
- **Depends on:** `api`

#### `vite-tls`
- **Image:** the stock pinned `caddy` image with `docker/caddy/Caddyfile.vite` bind-mounted; compose profile `vite-tls`.
- **Purpose:** TLS in front of the Vite dev server for `./run.sh start_https`, which starts it and removes it again when the dev server exits. Shares `caddy-data` with `caddy`, so the certificate comes from the same local CA; it starts only once `caddy` is healthy (CA created), which also brings the stack up if it is not.
- **Port:** `${EXTERNAL_LISTEN_IP}:3000`; upstream `cg-builder:3000` (the dev-server container, run with `--use-aliases`).

#### `mailpit`
- **Image:** `axllent/mailpit:v1.32.0` (pinned by digest)
- **Purpose:** Mail catcher. The dev defaults point `api` and `job-runner` at it (`SMTP_HOST=mailpit`, port 1025, `SMTP_SECURITY=none`), so every mail the dev stack sends ends up here and nothing leaves the machine. Not part of a self-host deployment, which has the `mail` relay instead; the end-to-end suite's disposable instance (`e2e/docker-compose.e2e.yml`) adds the same pinned image as its catcher (see [End-to-end browser suite](#end-to-end-browser-suite)).
- **Ports:** `${EXTERNAL_LISTEN_IP}:8025:8025` — web UI (and its REST API); SMTP 1025 stays inside the `cryptogram` network. Messages are kept in memory (lost on restart). The UI has no login and shows every caught mail, login codes included — keep `EXTERNAL_LISTEN_IP` on `127.0.0.1` unless the network is trusted.

#### `hardhat`
- **Image:** `cryptogram/hardhat` (built from `docker/hardhat/`)
- **Purpose:** Local Ethereum development blockchain. Used for deploying/testing smart contracts locally. **Dev stack only** — not present in the self-host stack.
- **Command:** `npx hardhat node`
- **Port:** `${EXTERNAL_LISTEN_IP}:8545:8545` (JSON-RPC)
- **User:** `hardhat`

#### `cg-builder`
- **Image:** `commonground/node` (built from `docker/node/`)
- **Purpose:** Build container. Not a running service — invoked via `docker compose run` to execute build commands (yarn install, type-check/lint/`vite build`, backend `tsc` compile, contract deployment). Mounts the entire project directory.
- **User:** `${BUILDER_UID}:${BUILDER_GID}` (matches host user to avoid permission issues). The image (`docker/node/Dockerfile`) creates a `cg_env` group/user only for ids the `node:26-trixie` base doesn't already have, so `1000` (the base's `node` user), `0` (root — e.g. a self-host operator building as root) and ids that collide with Debian system groups all build.
- **Volumes:** `../:/cg`, `builder-cache:/builder-cache` (persistent yarn cache)
- **Network:** dev: `cryptogram` (the Vite dev server behind `vite-tls` and the migration tooling need the stack); self-host: its own `builder` network only — the build needs the package registry, never the stack's services.
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
| `caddy-data` | `caddy`, `vite-tls` | Caddy's local CA (root + key) and the certificates it issued |
| `caddy-config` | `caddy` | Caddy's autosaved config |

### S3 Configuration

**File:** `docker/s3_config/s3.json` (dev, gitignored, generated by `docker/ensureEnv.sh` from the `S3_SECRET` in `docker/.env` — see [section 4](#4-environment-variables)) / `docker/s3_config/s3.selfhost.json` (self-host, generated by `init.sh`)

The SeaweedFS S3-compatible API is configured with two identities:
- **`anonymous`** — read-only access to the `cg-media` bucket, so uploaded media can be fetched without authentication.
- **an admin identity** (`cg_admin_user`; the dev `s3.json` that was tracked until 2026-10-31 calls it `some_admin_user` — the name is only a label, nothing references it) — full access (Admin, Read, List, Tagging, Write) using access key `cgadmin` and a secret key matching the `S3_SECRET` environment variable. Presigned `/files/...` URLs generated by the backend are turned back into presigned S3 requests by Caddy and verified by SeaweedFS against this key.

### TLS certificates (dev)

There are no certificate scripts any more. Every certificate a browser sees
(`:8001`, `:4443`, and `:3000` under `start_https`) is issued by Caddy's local
CA, which Caddy creates on its first start in the `caddy-data` volume; its key
never leaves the volume. Trust the root once per machine (`./run.sh export_ca`
→ `docker/caddy-local-root.crt`). The only other certificate is the
self-signed one for the internal caddy→mediasoup hop (see `mediasoup` above).
Checkouts from before the switch still have the old generated certificates in
`docker/nginx/certs/` (gitignored, unused) — delete them.

### Network

Single network: `cryptogram` (attachable, bridge). All services communicate over it using Docker DNS (service names as hostnames).

---

## 2. Build Process

The dev build scripts live in `docker/` and are invoked through `run.sh`.

### Package-manager hardening

The update policy as a whole — the 7-day minimum release age for every
ecosystem (3 days for security fixes), the exception and security-fix logs, digest pinning, the apt snapshot, verified binary
downloads and Renovate — is in **[UPDATE-POLICY.md](UPDATE-POLICY.md)**. This
section covers the Yarn side.

Both workspaces pin **Yarn 4** (exact version + Corepack's `+sha512.` hash in
`packageManager`) and configure two supply-chain controls in
`.yarnrc.yml` (root and `srv/`). They were added on 2026-08-04, the day the
"Shai-Hulud: Here We Go Again" npm worm poisoned ~440 packages (keyv, cacheable,
flat-cache, file-entry-cache and others) by publishing versions whose
`preinstall` hook ran on install alone. This repository was never in range of an
affected version, but both controls would have made it structurally impossible:

- **`enableScripts: false`** — no dependency may run install/build scripts.
  Packages that genuinely need to build opt in explicitly via
  `dependenciesMeta.<pkg>.built: true` in `package.json`. Current allowlist —
  root: none (it held `esbuild` until Vite 8, wave M3, removed esbuild from
  the root tree; Rolldown and Lightning CSS ship their binaries as
  per-platform npm packages and run no install script); `srv/`: `bcrypt`,
  `mediasoup`, `puppeteer`, `unrs-resolver`. The four `node-gyp-build` natives (`bufferutil`,
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
  downgrades what the lockfile already pins. A security fix may come in after
  3 days through an exact-version `npmPreapprovedPackages` entry in the root
  `.yarnrc.yml`; anything younger needs the maintainer's approval
  (`yarn up --no-time-gate <pkg>` or the same entry) — both logged in
  [UPDATE-POLICY.md](UPDATE-POLICY.md#security-fixes-3-days).

Yarn 4.1.0 had neither (its `enableScripts` default was `true`, contrary to what
the current yarnpkg.com docs say — the pinned binary is the authority), which is
why the version moved as part of the same change. The upgrade changed the
lockfile metadata format (8 → 10) but **no resolved version**. Note that 4.1.0
*hard-errors* on the unknown `npmMinimalAgeGate` key, so every place that
bootstraps a Yarn version has to stay at 4.17.1 or newer (4.18.1 since
2026-10-31; that bump changed no lockfile): `docker/build.sh`,
`docker/updateBackend.sh`, `docker/updateFrontend.sh`,
`docker/selfhost/selfhost.sh` and both Azure pipelines.

**Every install path in the repository is covered**, which took more than the two
main workspaces:

| Path | How it is covered |
|---|---|
| root, `srv/` | own `.yarnrc.yml` + `dependenciesMeta` allowlist |
| `contracts/` | inherits the root `.yarnrc.yml` (Yarn walks up); no allowlist needed |
| `docker/hardhat/node/` | **was the one unprotected path** — `docker/hardhat/Dockerfile` ran a bare `yarn`, i.e. the base image's Yarn 1.22, with no lockfile and scripts on. It now installs corepack (verified tarball), pins `packageManager` (Yarn 4.18.1 + hash), ships its own `.yarnrc.yml`, and since 2026-10-31 its own `yarn.lock`, installed with `--immutable` (resolved fresh under the age gate — the same versions the image had been resolving, e.g. hardhat 2.29.1). |
| backend image build | the copied `.yarnrc.yml` carries both controls (no `yarnPath` exists any more — corepack provisions the `packageManager`-pinned Yarn); verified by the `YN0004` warnings in the build output |
| Azure pipelines | the secure-file `.yarnrc.yml` **replaces** the repo's, so the pipelines re-append both settings after copying it — see the comment there |
| lockfile drift | every scripted install is `yarn install --immutable` (backend images, hardhat image, `docker/build.sh`, `docker/updateBackend.sh`, `docker/updateFrontend.sh`, `docker/selfhost/selfhost.sh`, `tools/*Migration.sh`, `tools/testEntities.sh`): a stale lockfile fails the build instead of resolving something unreviewed. Change dependencies with a plain `yarn install`/`yarn add` in `./run.sh shell` and commit the lockfile. |
| git dependencies | `approvedGitRepositories` (root `.yarnrc.yml`) lists only `https://github.com/ethereumjs/ethereumjs-abi.git`, the one git dependency in any lockfile (`contracts/yarn.lock`, via `solidity-bytes-utils` → `@truffle/hdwallet-provider`); it was `"**"` until 2026-10-31. For `github.com` repositories Yarn fetches the commit archive over HTTPS first and only falls back to `git clone`, which is the path the allowlist guards — see [UPDATE-POLICY.md](UPDATE-POLICY.md#npm-yarn). |
| `npx` call sites | every call (`web-push` and `hardhat` in the build scripts) resolves to a declared local dependency and passes `--no`, which turns a missing package into a loud failure instead of a silent registry download-and-run |

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
2. **Yarn comes from corepack**: the `commonground/node` base image
   installs corepack (no longer bundled with Node ≥ 25; npm tarball checked
   against a pinned sha512), enables it and pre-fetches the
   `packageManager`-pinned release (hash-verified) into a
   world-readable `COREPACK_HOME`, so builder runs need no bootstrap step and
   no network fetch. (The former "Missing .yarn directory" repair blocks and
   `yarn set version` calls are gone; on a dev host, run `corepack enable`
   once to get the same resolution outside the containers.)
3. **Internal mediasoup certificate:** `mediasoup/ensureInternalCert.sh` creates the self-signed caddy→mediasoup certificate if it is missing (browser-facing certificates come from Caddy's local CA, see [section 1](#tls-certificates-dev)).
4. **Clear `backend/dist/` and `caddy/dist/`**, then install frontend dependencies (`docker compose run --rm cg-builder yarn install --immutable`).
5. *(No build-ID step any more: the Vite build draws the build ID itself, see [Build ID](#build-id).)*
6. **Type-check, lint and build the frontend:** one builder run of `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite`, with `DEPLOYMENT=prod` and `NODE_OPTIONS=--max-old-space-size=4096`. Output goes to `../build/`, then `rsync`ed into `caddy/dist/`. See [Frontend build steps](#frontend-build-steps) for what each step does and why it is a separate step now.
7. **Build the caddy image:** `docker compose build --no-cache caddy`.
8. **Generate VAPID keys:** if `vapid_keys.json` doesn't exist, generate Web Push VAPID keys via `npx web-push generate-vapid-keys`.
9. **Build the backend:** clear `backend/dist/`, `rsync` `srv/` (excluding `node_modules` and `.yarn`), copy `build/index.html` into `backend/dist/` (used for server-rendered meta tags), build `commonground/backend_stage_0`, then build the `api` image (stage 1 runs `yarn tsc`) with `--build-arg CG_BUILD_ID=<build/build-id.txt>`.
10. **Build and start the database:** `docker compose build --no-cache db && docker compose up -d db`.
11. **Start the full stack:** `docker compose up -d`.
12. **Deploy smart contracts:** runs `contracts/scripts/deploy.ts` against the local Hardhat node (`--network cgstack`).
13. **Show logs:** `./logs.sh`.

### Backend-Only Update: `docker/updateBackend.sh` (`./run.sh update_backend`)

Faster rebuild that only recompiles the backend: stops the backend services (caddy keeps running — it resolves the containers per request), rebuilds `cg-builder`, creates the internal mediasoup certificate and the VAPID keys if missing, re-copies `srv/` sources and `build/index.html` into `backend/dist/`, builds the stage-0 and stage-1 backend images (the latter with the build ID of the frontend Caddy serves, `caddy/dist/build-id.txt`, or `dev` without one), then starts the stack and redeploys contracts.

### Frontend-Only Update: `docker/updateFrontend.sh` (`./run.sh update_frontend`)

Rebuilds only the frontend and the caddy image:
1. Clear `caddy/dist/`, rebuild `cg-builder`.
2. Install dependencies. The build below keeps the build ID of the deployed frontend (`caddy/dist/build-id.txt`, read before `caddy/dist/` is cleared), which is the one the running backend carries, so frontend and backend stay equal; without a deployed ID it draws a new one. Open clients therefore get no `version-update`; they pick the new frontend up through the service worker's own update check. (Until 2026-11-02 the script wrote a new ID that the running backend did not have — every client then saw a mismatch until the next `update_backend`.)
3. Run `yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite` with `DEPLOYMENT=prod` and **`NODE_OPTIONS=--max-old-space-size=4096`** (see [Frontend build steps](#frontend-build-steps)).
4. `rsync` the build output into `caddy/dist/`, then `docker compose up -d --no-deps --build caddy`.

### Build ID

The build ID ties a frontend build to the backend built with it: wsapi greets
every websocket client with the backend's ID, a client whose own ID differs
switches to `version-update` and lets the service worker update
(src/data/appstate/webSocket.ts, [docs/realtime](../realtime/README.md)), and
the service worker uses it as the precache revision of the unhashed files it
adds by hand (fonts, call sounds, the cross-origin-isolation shells). It is
a build-time value since 2026-11-02, read from `src/common/buildId.ts` — the
build scripts used to `sed` a fresh value into the tracked
`src/common/random_build_id.ts`, so every build left a modified checkout. That
file is kept byte-identical to its last committed state and is no longer read
(an existing checkout with a modified copy runs `git checkout --
src/common/random_build_id.ts` once, `docker/SELFHOST.md`); it is deleted
later (`docs/todo/TODO.md`).

- **Frontend:** every `vite build` takes `CG_BUILD_ID` from its environment
  (validated: up to 64 characters of `A-Za-z0-9+/=_-`) or draws 10 random
  bytes (base64url), replaces `__CG_BUILD_ID__` in the app bundle and in the
  service worker with it (`define`, `vite/buildId.ts`) and writes it to
  `build/build-id.txt`. That file is not precached (the worker's glob covers
  `*.html` and `static/` only); Caddy serves it as `/build-id.txt`, which is
  harmless — the websocket hands the same ID to every client — and shows
  which build is deployed (`curl https://<domain>/build-id.txt`; Caddy sends
  it with `Cache-Control: no-cache`).
- **Dev server:** `vite` (`./run.sh start`) draws no ID: it uses the deployed
  dev-stack frontend's (`docker/caddy/dist/build-id.txt`, read at start), the
  one the dev backend carries, or `dev` without one — the backend's fallback.
- **Backend:** `Dockerfile_dev_stage_1` (and the legacy single-stage
  `Dockerfile`) turn the build argument `CG_BUILD_ID` into the image's
  environment variable of the same name; `src/common/buildId.ts`
  (shared with the backend through the `srv/common` symlink) reads it there.
  `selfhost.sh build`, `docker/build.sh` and `e2e/instance.sh build` pass the
  content of `build/build-id.txt` (`--build-arg`), `updateBackend.sh` that of
  `caddy/dist/build-id.txt` (the frontend Caddy serves); the legacy pipelines generate one ID, export it as the
  pipeline variable `CG_BUILD_ID` for the frontend build and pass it to the
  backend image build.
- **Fallback:** `dev` — unit tests, and a backend image built without the
  argument (e.g. `update_backend` before any frontend build).

### Frontend build steps

The frontend is built by **Vite 8** (`vite.config.ts` + the plugins under `vite/`;
Rolldown bundles, Oxc and Lightning CSS minify — see
[docs/frontend §9](../frontend/README.md#toolchain)).
Every build path — `build.sh`, `updateFrontend.sh`, `selfhost.sh` and the two
legacy Azure pipelines — runs the same four steps in this order:

| Step | Command | Why it is a step |
|---|---|---|
| type-check | `yarn typecheck` | `tsc --noEmit` for `src/**` plus `tsconfig.node.json` for the Vite-side files. The old webpack build ran ForkTsChecker inline; a Vite build type-checks nothing, so without this a type error ships silently. |
| lint | `yarn lint` | `eslint .` against `eslint.config.mjs`. Same reason: react-scripts ran ESLintPlugin inline. Errors fail the build, warnings do not — the same contract CRA had. |
| build | `yarn build` | `vite build` → `build/`. The CSS goes through Tailwind CSS 4 as a Vite plugin (`@tailwindcss/vite`, configured in `src/tailwind.css`) and Lightning CSS; there is no PostCSS step and no `postcss.config.js`/`tailwind.config.js` any more (wave M4, [docs/frontend §9 "Styling: Tailwind CSS 4"](../frontend/README.md#styling-tailwind-css-4)). |
| HTML rewrite check | `yarn check:html-rewrite` | `tools/checkHtmlRewriteCompat.mjs` checks both emitted shells against their two serve-time consumers, which fail *silently* when the markup shape drifts: the real meta-rewrite logic of `srv/api/getRoutes.ts`, and the Caddy edge — each shell loads `/instance-config.js` once as a deferred classic script before the entry module, every inline script of `index.html` has its sha256 in the CSP of `docker/caddy/common.caddy`, and `index_cgid.html` has no inline script; `index.html` carries no `og:site_name` (the backend adds the instance's host on the pages it renders). |

**Environment.** `DEPLOYMENT=prod` and `NODE_OPTIONS=--max-old-space-size=4096`
are the only variables the build reads. `NODE_OPTIONS` stays set on every
path: node sizes its default heap from machine RAM, and under Vite 7 a plain
`vite build` OOMed at 2048 MB and peaked at ~4 GB container RSS (measured under
Node 24 + Vite 7 in `node:24.18-bookworm`: ~3.9 GiB by `docker stats`, ~4.1 GiB
cgroup `memory.peak`, which also counts page cache), so a small selfhost VPS
failed without it. Vite 8 (Rolldown, wave M3) changed the picture: on Node 26
(`node:26-trixie`) the whole `yarn build` peaks at ~2.65 GiB cgroup
`memory.peak` and also passes with `--max-old-space-size=2048` (measured
2026-11-01; most of the bundling now runs in Rolldown's native code, outside
the V8 heap). The flag stays at 4096 anyway — it costs nothing and keeps the
margin; re-measure when dependencies grow, with 5120 as the fallback if a build
ever OOMs. Tailwind CSS 4 (wave M4) raised the peak again, outside the heap:
measured side by side on 2026-11-02 (fresh builder container, cgroup
`memory.peak`, page cache included), ~3.7 GiB against ~2.8 GiB for the
e857ee5 build; it still passes with `--max-old-space-size=2048`.
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
the self-host CG ID vhosts; the Caddy edge that replaced the self-host nginx
(2026-10-31) has no `Access-Control-Allow-Origin` allowance for the CG ID
origin at all, and its CG ID site allows no inline script (see
[section 3](#legacy-cg-id-mini-app)). The hosted `nginx.conf` keeps both
widenings until the hosted stack is shut down. Two directives keep the main origin, because the
mini-app genuinely still reaches it: `img-src` (it renders
`${APP_URL}/icons/128.png`, e.g. `src/cgid/login.tsx`) and `connect-src` (its
API calls go to `APP_URL/api/v2/CgId/`). `manifest-src 'self'` is load-bearing:
`/manifest_wallet.json` is now served from the CG ID origin, and on the
prod/staging vhosts the directive did not carry `'self'` before the cutover
(the self-host config always had it — self-hosted instances never set
`PUBLIC_URL`).

**Output layout** (`build/`), pinned to keep the edge's rules (Caddy, and the hosted `nginx.conf`) untouched:

- `build/index.html`, `build/index_cgid.html` — both entry shells at the web
  root under exactly these names. `srv/api/getRoutes.ts` and the Caddy
  routes (`/index.html`, the CG ID site's `/index_cgid.html`) depend on that. The shells are **not minified** any more (CRA ran
  HtmlWebpackPlugin minification; Vite ships the templates verbatim apart from
  the injected module script and, with `PUBLIC_URL`, three absolutised meta
  tags). That is intended, not a regression: both rewrite consumers match on
  literal markup, and an HTML minifier would put their regexes back at risk to
  save ~7 KB of comments and whitespace. One exception since Vite 8: the
  inline `<style>` blocks of both shells are minified by Lightning CSS. Inline
  `<script>` blocks are still emitted verbatim, so the sha256 of the dark-mode
  script in the Caddy CSP is unchanged (`yarn check:html-rewrite` verifies it
  on every build), and `style-src` allows inline styles anyway.
- `build/static/js|css|media/` — `assetsDir: 'static'`, hex `[hash:8]` content
  hashes. Caddy's cache rules key on
  `^/(fonts|icons|images|static|audio|downloads)/` and give the hashed files
  under `static/` a year-long `immutable` lifetime, and the service worker's
  `dontCacheBustURLsMatching: /\.[0-9a-f]{8}\./` needs hex, not the bundler's
  default base64url alphabet (`hashCharacters: 'hex'`, which Rolldown supports
  like Rollup did). Chunk *names* come from the first module of a chunk and
  changed with Rolldown (`util`, `MobileLayout`, `sha.js`, …); every emitted
  file still matches Caddy's `name.<8 hex>[.chunk].ext` rule. JS output is
  deterministic, but Rolldown's `.map` files are not quite: `sourcesContent` of
  an asset import carries a per-build reference id, so two builds of the same
  code can ship different maps under the same hashed name (harmless — the
  mappings are the same).
- `build/service-worker.js` at the root, built by `vite/serviceWorker.ts`
  (`workbox-build` 7 `injectManifest`, not `vite-plugin-pwa`; the 6 → 7 bump
  changed nothing here — `workbox-precaching`/`-routing` are the same sources
  under a new version string and no `injectManifest` option was renamed). The
  build **fails**
  if the nested worker bundle is not exactly that one file, or if any emitted
  JS/CSS chunk is missing from the precache manifest. The worker serves
  precached scripts with the body read first, not streamed from Cache Storage
  (Vite 8 start-up failures, wave M3 — [docs/frontend §9](../frontend/README.md#service-worker-and-module-scripts)). The precache size cap is
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
  whole — the motion 12 swap alone added ~0.5 % raw JS. Measured again for
  wave M3 (2026-11-01): 169 entries / 12.71 MiB on Vite 7 (a1460cb), 214 /
  12.63 MiB on Vite 8 — more, smaller chunks (see "Chunking"), the same code.
  The earlier Vite 7 baseline
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

**Chunking.** `build.rolldownOptions.output.codeSplitting` in `vite.config.ts`
(`manualChunks` under Rollup, up to Vite 7) pulls nine vendor groups out of the app chunk (`vendor-web3`, `vendor-icons`,
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
0.28): same chunk set, every chunk same-size or marginally smaller.

**Under Rolldown (Vite 8, wave M3)** the table is unchanged, but it is fed to
Rolldown as one `codeSplitting` group per vendor group, `vendor-react` and
`vendor-shared` at a higher `priority` than the feature groups. Rolldown puts
the static dependencies of a group's members into that group too, and a module
two groups reach goes to the group emitted first — by priority, then array
order. The function-form `manualChunks` still works but is deprecated, and
Rolldown emulates it as a *single* group whose chunks are emitted in
alphabetical order: `vendor-charts` then claims recharts' shared dependencies
before `vendor-react`/`vendor-shared` do, and `assertCgidEntryChunks` fails the
build (measured). Result on a1460cb + Vite 8.3.5: the same nine vendor chunks
with the same packages (`vendor-web3` 3.38 MiB instead of 3.53 MiB, because
`lodash`, `idb-keyval` and `fast-safe-stringify` are no longer pulled into it;
`vendor-charts` now also holds `d3-brush`/`victory-vendor`), 164 JS files /
11.65 MiB instead of 135 / 11.75 MiB. The difference is first-party code:
Rolldown's automatic chunking splits `src/` along its dynamic imports where
Rollup kept one ~2 MiB `App` chunk, so loading the app now pulls 48 static
chunks instead of 21, for the same ~7.9 MiB. Both entries' critical paths are
unchanged in size (main shell 285 KiB, CG ID mini-app 901 KiB), and the CG ID
entry's whole lazy graph is 7503 KiB (Vite 7: 7619 KiB). Rolldown's own
runtime helpers (CommonJS interop, lazy module init) land in the
`modulepreload-polyfill` chunk both entries already load. Three rules
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
  `__vite-browser-external`, Oxc's lowering helpers `\0@oxc-project+runtime@…`
  and the injected `global` shim; under Rollup also `commonjsHelpers.js`) are
  pinned: an *unassigned* module gets absorbed into whichever group reaches it
  first, and everything imports them — which is exactly the silent regression
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

- **Stage 0 (`Dockerfile_dev_stage_0`):** `FROM node:26-trixie` line, exact tag + digest pinned. Switches apt to the `snapshot.debian.org` timestamp of the Debian rootfs underneath the pinned node image ([UPDATE-POLICY.md](UPDATE-POLICY.md#apt-debian)), then — before the dependency layers, so they only rebuild when a pin changes — runs three verified downloads: `fetch_chrome.sh` (Chrome for Testing for puppeteer, sha256-pinned, plus its runtime libraries from the archive's `deb.deps` via apt; x86_64 only — on other architectures it is skipped and social preview images do not work), `download_model.sh` (the NSFW classification model, ~87 MB, from a **pinned HuggingFace revision** into `/models/nsfw`, sha256 per file) and `fetch_mediasoup_worker.sh` (the prebuilt mediasoup worker for the build host's arch and kernel major — kernels older than 6 get the kernel6 asset — sha256-pinned). The build needs network access to `storage.googleapis.com`, `huggingface.co`, `github.com`, `registry.npmjs.org` and `snapshot.debian.org`; the runtime needs none of them. It then installs corepack (pinned sha512), copies `package.json` / `yarn.lock` / `.yarnrc.yml`, runs `yarn install --immutable` (bcrypt compiled from source against the image's Node headers; the mediasoup and puppeteer postinstall downloads skipped via `MEDIASOUP_WORKER_BIN` / `PUPPETEER_SKIP_DOWNLOAD`), runs `check_pinned_binaries.sh` (fails if the installed mediasoup/puppeteer expect a different worker/Chrome than the pinned ones) and prunes the darwin/win32 `onnxruntime-node` binaries plus the browser-only `onnxruntime-web` (~290 MB that can never run in the linux node image). Details: [UPDATE-POLICY.md](UPDATE-POLICY.md#binary-downloads).
- **Stage 1 (`Dockerfile_dev_stage_1`):** `FROM commonground/backend_stage_0`. Copies the full `dist/` source and runs `yarn tsc`; declares the `HEALTHCHECK` (see [Backend health checks](#backend-health-checks)) and, last, the build ID (`ARG`/`ENV CG_BUILD_ID`, see [Build ID](#build-id)). Rebuilt on every code change.

**Production backend (`Dockerfile`):** single-stage build used by the legacy CI/CD pipelines, same base and the same steps as stage 0 + stage 1 in one image (verified downloads before `COPY ./dist`, then `yarn install --immutable`, `check_pinned_binaries.sh`, `yarn tsc`). The compilers and python3 that node-gyp needs come with the `node:*-trixie` base, so no build packages are installed or removed any more.

All Node images run **Node 26 on Debian trixie** since 2026-10-31 (roadmap
decision 13). The obstacle the Node 24 audit (2026-08) found — the hand-written
Chrome library list named bookworm packages (`libgcc1`, `libasound2`,
`libcups2`) that trixie renamed under the 64-bit `time_t` transition — is gone:
the libraries now come from the Chrome archive's own `deb.deps` through
`apt-get satisfy`, whose versioned `Provides` resolve to the `…t64` packages.
Node 26 images ship without Corepack; every Dockerfile installs it from the
npm tarball against a pinned sha512. Verified on Node 26: bcrypt (built from
source), sharp, onnxruntime-node + transformers (NSFW model classification),
mediasoup (`createWorker()` + router), puppeteer (launch with the
`htmlToImage` flags + screenshot), `hardhat node`, the frontend
typecheck/lint/build, and the SDK conformance suite against a disposable
self-host stack (two `r0-instance-config` failures unrelated to the runtime
are tracked in `docs/todo/TODO.md`).

---

## 3. Caddy (the edge)

Caddy is the edge of both the dev stack and the self-host profile: TLS, the
built frontend, the routing to the backend services, security headers and the
instance config. It replaced nginx there on 2026-10-31 (the Caddy config for
both lives in one place); the hosted Swarm deployment (`app.cg`, CI/CD) still
uses `docker/nginx/nginx.conf` + `docker/nginx/Dockerfile` until it is shut
down after the move.

**Image** — `docker/caddy/Dockerfile`: stock `caddy` (`2.11.x-alpine`, exact
tag + digest pinned; no plugins — a custom build would pull third-party Go
modules outside the [update policy](UPDATE-POLICY.md)), plus the frontend build
in `/srv`, the Caddyfiles in `/etc/caddy/`, the instance-config template in
`/etc/caddy/templates/` and a gateway's replacement service worker in `/etc/caddy/gateway/`. `Caddyfile.vite` and `Caddyfile.conformance` are not in the image (bind-mounted by their compose files). Nothing instance-specific is baked in, so one image
serves any domain; the compose file picks the config with `command` and passes
everything else as environment. Tags: `cryptogram/caddy` (dev) and
`cryptogram/caddy-selfhost` (self-host), kept apart so the two stacks on one
host never share a frontend build.

| File | Used by |
|---|---|
| `common.caddy` | imported by the three configs below: the app's routing (`cg_app`), the gateway's (`cg_gateway_app`), the CG ID site (`cg_cgid_site`), CSP, common headers, HSTS, access log, instance config, CG ID variants, call-signalling proxy |
| `Caddyfile.dev` | dev stack, service `caddy` |
| `Caddyfile.selfhost` | self-host stack ([section 7](#7-self-hosted-single-server-deployment)) |
| `Caddyfile.conformance` | the disposable conformance stack (`docker-compose.conformance.yml`, which bind-mounts it — it is not in the image): the self-host routing as plain HTTP for any host. Test-only: it trusts `X-Forwarded-For` from private addresses, because the suite isolates its fixture clients by address (`sdk/conformance/src/fixtures.ts`) |
| `Caddyfile.vite` | dev stack, service `vite-tls` (TLS for `./run.sh start_https`; runs the stock image with this file bind-mounted) |
| `instance-config.js` | Go template behind `/instance-config.js` |

### Routing (`common.caddy`, snippet `cg_app`)

Routes are tried in this order; the first match wins.

| Path | Goes to | Notes |
|---|---|---|
| any path with a `.` or `..` segment (also percent-encoded) | 400 | Caddy's path matchers see the cleaned path, the upstream would get the path as sent — so no prefix rule can be walked out of |
| `/files/<id>/<sig>/<YYYYMMDD>T<HHMMSS>Z/<expires>` | `s3.local:8333` | rewritten to the S3 presigned GET the backend signed (`getSignedUrls` in `srv/repositories/files.ts`): bucket `cg-media`, `Host: <host>:8333` (the signature covers it). CSP `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox`, `nosniff`, `Access-Control-Allow-Origin` = own origin; successful responses get `Cache-Control: private,max-age=604800,immutable` (errors are not cacheable). Cookies and `Authorization` are stripped towards S3 and `Set-Cookie` back, as are `X-Forwarded-Host` (SeaweedFS would check the signature against it) and SeaweedFS' own CORS/owner headers; S3 error bodies are replaced by an empty body with the same status. Other `/files/` paths: 404. |
| `/api/bot/v1/…` | `api:4000` as `/BotV1/…` | Bot API v1 ([docs/BOT-API.md](../BOT-API.md)) |
| `/api/v2/CgId/…` | `api:4000` (prefix stripped) | only when the legacy CG ID mini-app is on (see below) |
| `/api/v2/(Captcha\|Instance\|Chat\|Community\|File\|Message\|User\|Contract\|Notification\|Twitter\|Lukso\|Passkey\|Accounts\|Plugins\|Search\|Report\|Bot\|Staking\|Feed)/…` | `api:4000` (prefix stripped) | the web API allowlist |
| `/api/ws/…` | `wsapi:4000` | Socket.IO, websocket upgrade included |
| any other `/api/…` | 404 | |
| `/(c\|u\|gated-videos\|gated-files)/…`, `/sitemap.xml`, `/twitter-callback`, `/twitter-login`, `/verify-email`, `/push-icon`, `/token`, `/store` | `api:4000` | share links (the SPA shell with per-item social meta), images, gated media, callbacks. HTML responses get `Cache-Control: no-cache`; anything else `private,max-age=86400,must-revalidate` unless the backend set its own. |
| `/instance-config.js` | template | see [Instance config](#instance-config) |
| `/robots.txt` | `/srv` | the build's robots.txt plus a `Sitemap:` line for the requesting host (template) |
| `/(fonts\|icons\|images\|static\|audio\|downloads)/…` | `/srv` | no SPA fallback (missing file = uncached 404). Content-hashed files under `static/` — `name.<8 hex>.ext` and `name.<8 hex>.chunk.js`, plus the `.map` of each (everything Vite emits, see `vite.config.ts`) — get `public,max-age=31536000,immutable`; every other existing file `private,max-age=86400,must-revalidate` |
| `/`, `/index.html`, `/service-worker.js`, `/e/<x>` | `/srv` | `Cache-Control: no-cache`; falls back to the shell |
| `/index_cgid.html` | 403 | the CG ID shell is served only by the CG ID vhost (dev: served here, see below) |
| `/enable-cross-origin-security…`, `/disable-cross-origin-security…` | `/srv/index.html` | `no-store`; the "enable" page adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the service worker precaches both) |
| anything else | `/srv` | an existing file (manifest, logo, models, …) with `private,max-age=86400,must-revalidate`; any other path is a client-side route and gets the shell with `no-cache`, so deep links work before the service worker takes over |

The `Cache-Control` of the API routes is `no-cache` unless the backend set one
itself (e.g. `no-store` on `GET /Instance/config`).

**On every response** (deferred, so an upstream value never wins):
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self), geolocation=(), payment=()`
(passkey ceremonies only in the origin's own documents, never in a frame;
camera, microphone and display capture keep the browser default because the
plugin host delegates them to plugin frames through their `allow` attribute),
and no `Server` / `Via` / `X-Powered-By`. Errors raised inside Caddy (e.g. a missing static file) get the same headers, `Cache-Control: no-store` and an empty body (`handle_errors`). The self-host sites add
`Strict-Transport-Security: max-age=31536000` on HTTPS responses, error
responses included (no `includeSubDomains`, no preload; fifth argument of
`cg_app`); the dev and conformance sites do not (HSTS on `localhost` would
break the plain-HTTP dev ports).

**Content-Security-Policy** (snippet `cg_csp`, on the shell, the static files
and the API routes): `default-src 'self'`, `base-uri 'self'`,
`object-src 'none'`, `frame-ancestors 'none'`, `worker-src 'self' blob: data:`,
the style/font/img allowlists, `connect-src 'self'` + the instance's own host
on any port (`wss://<host>:4443` call signalling) + the wallet/RPC/Giphy hosts
the app talks to — for WalletConnect/Reown exactly the hosts the installed
`@walletconnect/*` 2.21 and `@reown/appkit*` 1.7 packages contact:
`wss://relay.walletconnect.org`, `https://rpc.walletconnect.org`,
`https://verify.walletconnect.org` / `.com`, `https://pulse.walletconnect.org`
and `https://api.web3modal.org` (the latter also in `img-src`; its iframes,
e.g. `secure.walletconnect.org`, fall under `frame-src`); `script-src 'self' 'wasm-unsafe-eval'` and
`script-src-elem 'self' 'sha256-…' https://www.google.com https://www.gstatic.com`.
There is no `'unsafe-inline'` for scripts: the instance config is a
same-origin script, and the one inline script of `index.html` (the initial
dark-mode switch) is allowed by its hash. `tools/checkHtmlRewriteCompat.mjs`
(`yarn check:html-rewrite`, part of every build) fails when an inline script of
the built shell has no matching hash in `common.caddy`, and when
`index_cgid.html` has any inline script at all. `frame-src` is `https:` on
self-host instances (plugins and embeds come from arbitrary origins) and `*` in
dev (dev plugins on other localhost ports).

**Body size:** `request_body max_size 16MiB` (the old
`client_max_body_size 16M`); larger requests get a 413.

**Forwarded headers.** Caddy sets `X-Forwarded-For` (the client address),
`X-Forwarded-Host` and `X-Forwarded-Proto` on every proxied request and
replaces whatever the client sent: no `trusted_proxies` are configured. Keep
it that way unless a CDN or another proxy is put in front — then trust only its
address ranges. The backend runs with `trust proxy` and its rate limits key on
`X-Forwarded-For`. On self-host sites `X-Forwarded-Proto` is always `https`
(Caddy serves plain HTTP only to redirect, and in the loopback-only
conformance stack); the backend sets its secure session cookie only for HTTPS
requests. In dev it is the request's real scheme.

**Edge rate limits:** none — stock Caddy has no rate-limit handler, and a
plugin build is ruled out above. Rate limiting is the backend's job.

**Access log:** to stdout (`docker compose logs caddy`). The `token` and
`email` query values (verification, login and unsubscribe links) and the
signature segment of `/files/` URLs are redacted, and the `Referer` header —
which repeats such URLs — is not logged; Caddy itself redacts `Cookie` and
`Authorization`.

### Instance config

`/instance-config.js` declares the instance to the frontend
(`window.__CG_INSTANCE__ = {...};`, validated by `src/common/instance.ts`).
Caddy renders it per request from `/etc/caddy/templates/instance-config.js`, a
Go template that reads the `CG_*` variables of the container; the object is
produced by Go's JSON encoder (`toJson`), so no value is ever pasted into
script text. Without `CG_APP_URL` (the dev stack) the file declares nothing
and the frontend falls back to its built-in detection, as on the Vite dev
server (which serves the placeholder `public/instance-config.js`). The rules
match `srv/util/instanceConfig.ts`, which builds the same object for
`GET /api/v2/Instance/config` — keep them in sync. Served with
`Cache-Control: no-cache`; the service worker fetches it network-first and
keeps the last good copy for starts without network or with an error
response.

A site can render it from another set of variables: `vars cg_env_prefix GATEWAY_` makes the
template read `GATEWAY_CG_*` instead of `CG_*` (the gateway's sites, [Gateway of a moved
instance](#gateway-of-a-moved-instance)), so one Caddy serves the configs of both instances. Gateway
sites also emit `gatewayTargetUrl` (from `GATEWAY_CG_GATEWAY_TARGET_URL`, an http(s) origin).

Both shells load it as `<script defer src="/instance-config.js">` ahead of the
entry module (deferred scripts run in document order, so the config is set
before any module code). The share-link pages the backend renders
(`srv/api/getRoutes.ts`) carry the same tag and therefore the same config;
the backend injects an inline copy only into a shell without that tag.

### Legacy CG ID mini-app

The fourth argument of `cg_app` decides what happens to the CG ID mini-app
(passkeys on a separate `id.` origin, only needed by the legacy CG ID gateway
— docs/auth-identity):

- `off` (self-host default): `/api/v2/CgId/` is not routed, `/index_cgid.html`
  is refused, there is no CG ID site.
- `on` (self-host with `CG_CGID_VHOST=on`, which `selfhost.sh` sets only when
  `CG_LEGACY_CGID=true` **and** `CG_ID_DOMAIN` is set): the CgId API is routed
  on the main site, and Caddy serves a second site for `CG_ID_DOMAIN` — the
  mini-app's shell at `/` (`no-store`), its own assets, `/instance-config.js`,
  and `index.html` refused. Its CSP allows its own origin plus the main origin
  for images and API calls, and no inline script. There is no cross-origin
  (`Access-Control-Allow-Origin`) allowance for the CG ID origin on the main
  site: the mini-app's assets are same-origin, and its API calls are covered
  by the backend's own CORS (`CGID_URL`).
- `samehost` (dev): the CgId API is routed and the shell is served on the main
  origin at `/index_cgid.html` (the dev stack's `CGID_URL`).

The CG ID site itself is the snippet `cg_cgid_site` (argument: the app's domain, for its CSP), used
by the legacy CG ID site above and by the gateway's CG ID site.

### Gateway of a moved instance

With `CG_GATEWAY_EDGE=on` (`selfhost.sh` sets it from `CG_ENABLE_GATEWAY=true`;
[docs/auth-identity §12](../auth-identity/README.md#12-gateway-mode), `docker/SELFHOST.md`) the
self-host Caddy serves two more sites for the gateway's backend (`gateway-api`, `gateway-wsapi`):

- `{$CG_GATEWAY_DOMAIN}` (the old domain, e.g. `app.cg`): snippet `cg_gateway_app` — narrower than
  `cg_app`. `/api/v2/(User|Instance|Twitter|Lukso|Accounts|CgId)/` → `gateway-api:4000` (prefix
  stripped; the gateway api's allowlist is the authority, this only keeps the rest from reaching it),
  `/api/ws/` → `gateway-wsapi:4000`, the X sign-in pages `/twitter-callback` and `/twitter-login` →
  `gateway-api`; every other `/api/` path, `/files/` (no media) and `/index_cgid.html` → 404/403; no
  Bot API, no page routes; the built assets like `cg_app`; `/service-worker.js` is the replacement
  worker `/etc/caddy/gateway/service-worker.js` from the image (`docker/caddy/gateway-service-worker.js`,
  `no-cache`; [docs/frontend](../frontend/README.md#service-worker-on-a-gateway)), not the build's;
  every other path gets the web app's shell
  (`no-cache`), so an old deep link opens the gateway page, which takes the path along to the new
  instance. `robots.txt` disallows everything, request bodies are capped at 1 MiB, HSTS as on the
  main site. The site sets `vars cg_env_prefix GATEWAY_`: its `/instance-config.js` comes from the
  `GATEWAY_CG_*` variables of the Caddy container (legacy CG ID, no calls, `gatewayTargetUrl` = the
  main instance).
- `{$CG_GATEWAY_ID_DOMAIN}` (e.g. `id.app.cg`): the CG ID site (`cg_cgid_site`) for the gateway's
  domain, its instance config from the `GATEWAY_CG_*` variables as well.

Both get certificates like the main site (Let's Encrypt or the local CA), so their DNS records must
point at the server before `up`.

### Dev stack: `Caddyfile.dev`

The container listens on the host's port numbers, so the URLs the frontend
derives from its own location (`src/data/util/urls.ts`) match what Caddy sees:

| Port | Site | |
|---|---|---|
| 8000 | `http://:8000` | plain HTTP, any host name |
| 8001 | `https://` `localhost`, `127.0.0.1`, `app.cg.local`, `bs-local.com`, and `LOCAL_CERTIFICATE_IP` when set | `tls internal` |
| 4443 | the same names | call signalling, proxied to `https://mediasoup:4443` |

Every certificate comes from Caddy's local CA, kept in the `caddy-data`
volume (the CA key never leaves it). Caddy issues one certificate per name,
and browsers send no SNI for an IP address, so a connection to an IP gets the
one default certificate (`default_sni`): the `LOCAL_CERTIFICATE_IP` one when
it is set (other devices reach the machine only by it), else `127.0.0.1`'s.
With `LOCAL_CERTIFICATE_IP` set, use `https://localhost:…` (or the LAN
address) on the machine itself — `https://127.0.0.1:…` then gets the LAN
address's certificate. (The former nginx certificate carried all names in
one certificate.) Set `LOCAL_CERTIFICATE_IP` to the LAN address, never to
`127.0.0.1`: Caddy refuses two sites with the same name. `./run.sh export_ca` writes the root
certificate to `docker/caddy-local-root.crt` for importing into a browser or
OS trust store (once per machine; the root lives as long as the volume). The
dev CSP allows the own host on every port and scheme plus the hardhat chain
(`http://127.0.0.1:8545`), and `frame-src *`.

`./run.sh start_https` starts the `vite-tls` service (stock Caddy image,
`Caddyfile.vite`, same `caddy-data` volume and so the same CA) on port 3000
and runs the Vite dev server as a `cg-builder` container with the service's
network alias (`--use-aliases`), on plain HTTP inside the stack network. The
browser still talks to port 3000 (the service-worker manager depends on it),
Vite's HMR websocket goes through the same proxy, and `vite-tls` is removed
when the dev server exits.

---

## 4. Environment Variables

### `docker/.env` — Dev Compose Environment

`docker/.env` is the dev stack's configuration: `run.sh`, `docker/build.sh`, `docker/updateBackend.sh`, `docker/updateFrontend.sh` (compose only), and the `tools/` migration/test scripts source it, and docker compose reads it for the `${VAR}` references in `docker-compose.yml`. It is **gitignored and local to each checkout**; the tracked template is **`docker/.env.example`**, which lists every variable with grouped comments and holds no real secret.

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

The same applies to **checking out any commit from before the change** (an old branch, a bisect, a merge started from an older `develop`): git overwrites the then-ignored local files with the tracked versions without asking, and deletes them again when you switch back. Back up both files first (`cp docker/.env docker/s3_config/s3.json ~/`), or use a separate worktree for old commits.

`git stash` works too, but `git stash pop` after the pull ends in a modify/delete conflict on `docker/.env` (the file is back with your values, marked unmerged) and keeps the stash entry: run `git reset -q -- docker/.env && git stash drop` afterwards. A restored old `docker/.env` keeps the dev passwords that were public on GitHub — acceptable on localhost (`EXTERNAL_LISTEN_IP=127.0.0.1`); before switching to LAN mode, rotate them, which needs a fresh `pgdata` volume (`./run.sh down && docker volume rm docker_pgdata`, then delete `docker/.env` and `s3.json` and rerun).

Password consumers on a fresh stack: `PG_SU_PASSWORD` initializes the postgres superuser (`POSTGRES_PASSWORD`, applied only when the `pgdata` volume is first created) and is the login of `migrate-db` and `cg-builder`; `PG_WRITER_PASSWORD`/`PG_READER_PASSWORD` become the `writer`/`reader` roles in `docker/db/init.sh` (same first-init caveat; no dev service connects as `reader`), `writer` is used by `api`, `wsapi`, `memberlist`, `job-runner` and `onchain`; `PG_MEDIASOUP_PASSWORD` becomes the `mediasoup` role in `docker/db/init.sh` (same first-init caveat; migration `1689160339881-addMediasoupRole`, run by `migrate-db`, creates it only if missing) and is used by `mediasoup`; `REDIS_PASSWORD` is the `--requirepass` of both Valkey instances and every backend client's password; `S3_SECRET` must equal the `s3.json` secret key.

The table describes purpose; `.env.example` has the defaults.

| Variable | Purpose |
|---|---|
| `PG_WRITER_PASSWORD` / `PG_READER_PASSWORD` | Passwords for the `writer` / `reader` DB roles |
| `PG_SU_PASSWORD` | PostgreSQL superuser password |
| `PG_MEDIASOUP_PASSWORD` | Password for mediasoup's dedicated DB role |
| `REDIS_PASSWORD` | Password of both Valkey instances (`redis`, `redis-cache`) |
| `REDIS_SECRET` | Secret for Redis-backed session signing |
| `PGADMIN_SECRET` / `PGADMIN_EMAIL` | pgAdmin login (only if pgAdmin is enabled) |
| `DEPLOYMENT` | `dev` \| `staging` \| `prod`. Controls feature flags, chain config, CSP, session cookie names. |
| `BASE_URL` | Base URL of the application (absolute URLs in emails/redirects). |
| `S3_SECRET` | Secret key for the SeaweedFS S3 API / presigned-URL signing. |
| `BUILDER_UID` / `BUILDER_GID` | Host UID/GID for the builder container (avoids mounted-volume permission issues). `0` (root) is accepted. |
| `RECALCULATE_BALANCES_AND_ROLES` | If `true`, recomputes all token balances/roles on `onchain` startup. |
| `MEDIASOUP_DISABLE_LIBURING` | Disables io_uring in mediasoup (workaround for some kernels/containers). |
| `MEDIASOUP_TRUST_PROXY` | `true` = the call server takes the client address for its pre-login connection limits from `X-Forwarded-For`. Only for a call server reachable solely through a reverse proxy; the self-host and dev stacks set it (Caddy in front of 4443), the conformance stack, which publishes 4443 directly, sets `false`. |
| `LOCAL_CERTIFICATE_IP` | The LAN address for multi-device testing: an extra certificate name of the dev Caddy (`:8001`, `:4443`, and `:3000` under `start_https`) and its certificate for connections without SNI. Empty = no LAN name, and `127.0.0.1` is the SNI-less default. Also added to the backend's CORS origins. |
| `MEDIASOUP_ANNOUNCED_IP` | IP mediasoup advertises for WebRTC ICE candidates; must be client-reachable. |
| `EXTERNAL_LISTEN_IP` | Host port-binding interface. `127.0.0.1` = localhost only, `0.0.0.0` = all interfaces. |
| `QUIKNODE_*` | Per-chain RPC endpoint URLs used by `onchain` (name is historical — any JSON-RPC URL works). Includes `QUIKNODE_LUKSO`, which falls back to the public LUKSO RPC when empty. |
| `INFURA_LINEA` | RPC endpoint for Linea. |
| `GOOGLE_RECAPTCHA_SECRET_KEY` | Server-side reCAPTCHA v2 secret. |
| `CAPTCHA_PROVIDER` / `ALTCHA_HMAC_KEY` | Captcha provider (`altcha` \| `recaptcha` \| `off`; empty = `recaptcha` when `GOOGLE_RECAPTCHA_SECRET_KEY` is non-empty — any value, placeholders included — else `altcha`) and the ALTCHA HMAC key (empty = generated once and shared via Redis). Both are passed to `api`. The proof-of-work tuning knobs `ALTCHA_COST` / `ALTCHA_COUNTER_MAX` are passed by neither compose file — add them to the `api` service to tune (see [docs/auth-identity](../auth-identity/README.md)). |
| `TWITTER_CALLBACK_URL` / `TWITTER_OAUTH2_CLIENT_ID` / `TWITTER_OAUTH2_CLIENT_SECRET` / `TWITTER_API_KEY` / `TWITTER_API_SECRET` | Twitter/X login. The v1 keys `TWITTER_API_KEY` / `TWITTER_API_SECRET` are not passed to any service by `docker-compose.yml`. |
| <a id="email-smtp"></a>`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURITY` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` / `EMAIL_FROM_NAME` | Outgoing mail over SMTP, passed to `api` and `job-runner`. `.env.example` points them at the `mailpit` catcher; the compose file falls back to it when `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURITY` are **unset** (older `docker/.env`), while an empty `SMTP_HOST` disables email. Meaning and defaults: [docs/email-notifications](../email-notifications/README.md#transport--configuration). |
| `IMAGE_MODERATION_ENABLED` | Server-side NSFW image filter (`srv/moderation/imageFilter.ts`); consumed by the `api` and `onchain` services (with defaults when absent from `.env`). Default `true`; only the literal `false` disables it. The `api` service probes the model at boot — look for `imageFilter: ready` (or a `MODEL UNAVAILABLE` error) in *its* startup log to tell a working setup from one where every upload will fail; `onchain` loads the model lazily and logs nothing at boot by design. Note: on the dev stack the *client* pre-check stays active regardless for pages served by the vite dev server (no instance-config injection there); api-served pages and the selfhost profile do propagate the switch to the browser. |
| `IMAGE_MODERATION_THRESHOLD` | NSFW probability above which an image is rejected. Default `0.8`; invalid values fall back to the default (non-empty invalid values log a warning; an empty value — the compose default — falls back silently). |
| `IMAGE_MODERATION_MODEL_PATH` | Model directory in the container (default `/models/nsfw`, baked into the backend image). Point at a mounted Transformers.js-layout classifier to swap models. |

Also consumed by the compose file (with compose-side defaults when absent from `.env`): the `STAKING_*` set (`STAKING_CHAIN`, `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, `STAKING_BASE_RATE`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`) and the bot limits (`PLATFORM_OPERATOR_USER_IDS`, `BOT_USER_OWNER_LIMIT`, `BOT_COMMUNITY_OWNER_LIMIT`, `BOT_PLATFORM_OWNER_LIMIT`, `BOT_ACTIVE_TOKEN_LIMIT`, `BOT_API_RATE_LIMIT_PER_MINUTE`, `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`). See [`docs/BOT-API.md`](../BOT-API.md) and [`docs/staking`](../staking/README.md). The compose default of every `STAKING_*` variable is an empty string; `srv/util/stakingConfig.ts` treats empty like unset, so the backend defaults (`0.012` / `7` / `730`, which `.env.example` spells out) apply.

### `srv/serverconfig.ts` — Backend Server Configuration

Loaded at runtime from environment variables. (The SMTP settings are parsed separately, by `srv/util/mailConfig.ts`.)

| Config Key | Source | Purpose |
|---|---|---|
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

Steps: install Docker/Node/Yarn toolchain → fetch the secure `.yarnrc` (private registry creds) → `yarn` install → copy `srv/` to `docker/backend/dist/` → generate a build ID (pipeline variable `CG_BUILD_ID`: the frontend build embeds it, the backend image build gets it as `--build-arg`) → frontend build with `yarn typecheck && yarn lint && DEPLOYMENT=prod PUBLIC_URL="https://staging.app.cg" yarn build && node tools/checkHtmlRewriteCompat.mjs` → copy `index.html`/build output into backend and nginx dirs → build and push **backend** and **nginx** images (nginx build args `SERVER_NAME=staging.app.cg`, `CGID_SERVER_NAME=id.staging.app.cg`) with tags `beta` + `$(Build.BuildNumber)` → deploy via **Ansible** over SSH (`docker_swarm_deploy_beta.yml` for the main stack, `deploy_docker_mediasoup.yml` for mediasoup) → clean up.

### Production: `pipelines/build-production.yml`

**Trigger:** push to `production`. Nearly identical, but: `PUBLIC_URL="https://app.cg"`; images tagged `0.1`, `latest`, `$(Build.BuildNumber)`; nginx build args `SERVER_NAME=app.cg`, `CGID_SERVER_NAME=id.app.cg`; **no Ansible deploy step** (build-only — production deploy is manual).

### Clean-Up Template: `pipelines/sub-templates/clean-up.yml`

Shared template that deletes the build work directory, `condition: always()`.

### Reference client: `pipelines/reference-client-conformance.yml`

OpenAPI drift check plus the `sdk/` conformance suite (see `sdk/README.md`).
It builds the selfhost images, runs `sdk/tools/generate-openapi.sh --check`,
starts a disposable API-only instance (`sdk/conformance/tools/disposable-instance.sh`,
which layers `docker/docker-compose.conformance.yml` over the selfhost compose
file under its own project name, env file and volumes, with Caddy serving
plain HTTP on `127.0.0.1:18080` and no TLS), then runs the suite against it: the R0 +
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
| `./run.sh start` | Vite dev server (HMR) on `http://localhost:3000`, run via `yarn dev` in `cg-builder`. Backend stack must already be up. Port 3000 is load-bearing: the service-worker registration manager disables itself on that origin, which is what keeps the dev server SW-free. Vite checks the `Host` header on **plain-HTTP** dev servers and accepts only `localhost`, `*.localhost` and IP literals — reaching this dev server through a custom hostname (e.g. `app.cg.local`) needs that host in `server.allowedHosts`. CRA had no such check. `start_https` is **not** exempt: Vite itself still serves plain HTTP behind the `vite-tls` Caddy, which passes the `Host` header through, so `https://localhost:3000` and the LAN IP work while `https://app.cg.local:3000` and `https://bs-local.com:3000` (both site names in `Caddyfile.vite`) get Vite's "Blocked request" page unless they are added to `server.allowedHosts` (verified with Vite 8.3.5, 2026-11-01). |
| `./run.sh start_https` | Same, but on `https://localhost:3000` — required for WebRTC calls and LAN multi-device testing. Vite itself stays plain HTTP inside the stack network; the `vite-tls` service (Caddy, `Caddyfile.vite`) terminates TLS on port 3000 with a certificate from the stack's local CA and is removed when the dev server exits (see [section 3](#dev-stack-caddyfiledev)). Works before `build_full` ever ran. |
| `./run.sh export_ca` | Writes the root certificate of the stack's local CA to `docker/caddy-local-root.crt`, for importing into a browser / OS trust store (needs one earlier start of `caddy` or `vite-tls`). |
| `./run.sh build_full` | Runs the full `docker/build.sh` pipeline. |
| `./run.sh update_backend` | Recompiles backend TypeScript, rebuilds backend images. |
| `./run.sh update_frontend` | Rebuilds only the frontend + the caddy image (production build). |
| `./run.sh up` | Creates the internal mediasoup certificate if missing, `docker compose up -d`, then tails logs. |
| `./run.sh down` | Stops all services. |
| `./run.sh compose <args…>` | Passthrough to `docker compose` with the right file(s). |
| `./run.sh shell` | Interactive bash in `cg-builder` (project mounted at `/cg`). |
| `./run.sh e2e <options…>` | End-to-end browser suite (`e2e/run.sh`) in a container, see [End-to-end browser suite](#end-to-end-browser-suite). |
| `./run.sh e2e_instance build\|up\|down\|status\|logs` | The suite's disposable instance (`e2e/instance.sh`). |
| `./run.sh make_migration <name>` | New TypeORM migration via `tools/makeMigration.sh`. |
| `./run.sh make_empty_migration <name>` | Empty migration via `tools/makeEmptyMigration.sh`. |

### Typical Development Flow

1. **First-time setup:** `./run.sh build_full` (the first `./run.sh` call generates `docker/.env` from `docker/.env.example`; fill in third-party keys there as needed).
2. **Daily frontend work:** `./run.sh up`, then `./run.sh start`.
3. **After backend changes:** `./run.sh update_backend`.
4. **After frontend changes (production build test):** `./run.sh update_frontend`.
5. **Schema changes:** `./run.sh make_migration <name>`, edit the file, then `./run.sh update_backend` (migrations run automatically on startup via `migrate-db`).

### End-to-end browser suite

`e2e/` drives real Chrome (puppeteer) through the main user flows — sign-up
and login (password, passkey), reload robustness, communities and real-time
chat, image uploads, settings and the wallet modal, two-user calls with fake
media, articles and plugins — and fails a flow on any uncaught page error,
error-boundary screen, console error, CSP violation or unexpected
`status: 'ERROR'` API response (`e2e/src/allowlist.ts` holds the documented
exceptions). It runs inside the backend image, which already ships the
pinned Chrome for Testing and `puppeteer`; `e2e/` has no dependencies of its
own. Details, options and how to add a flow: [`e2e/README.md`](../../e2e/README.md).

- `./run.sh e2e_instance build` / `up` / `down` — a disposable self-host
  instance from the checkout: compose project `cg-e2e`, image tags
  `cg-e2e/*`, generated secrets in `e2e/.instance/` (gitignored), domain
  `cg-e2e.test` with Caddy's local CA, a Mailpit catcher, no host ports (the
  runner container joins the stack's network). `e2e/docker-compose.e2e.yml`
  layers it on `docker-compose.selfhost.yml` + `docker-compose.selfhost.calls.yml`;
  its edge config `e2e/Caddyfile.e2e` is the self-host site plus one test-only
  rule (a per-browser cookie becomes the client address, so the per-address
  sign-up limit does not cap the suite). `E2E_GATEWAY=1 … up` also starts the
  gateway of a moved instance on `app.cg-e2e.test` / `id.app.cg-e2e.test`;
  `e2e/run.sh --instance` then passes `--gateway-url` and the `gateway` flow
  runs, and `e2e/checks/gateway.sh` checks it server-side (complete route
  list, socket events, origins, wallet and CG ID passkey sign-in, transfer
  link, Valkey keys, startup refusals).
- `./run.sh e2e --instance` runs the suite against it; `e2e/run.sh --url
  https://<host> --ca <root.crt>` against any other instance (a private CA is
  verified by the suite, which then pins only the instance's leaf
  certificate keys in Chrome).
- Output: per-flow summary, `e2e/results/<timestamp>/report.json` with every
  guard finding, screenshots of failed steps; non-zero exit on failure.

---

## 7. Self-Hosted Single-Server Deployment

**Files:** `docker/docker-compose.selfhost.yml`, `docker/docker-compose.selfhost.calls.yml`, `docker/SELFHOST.md`, `docker/selfhost/` (`init.sh`, `selfhost.sh`, `backup.sh`, `harden.sh`), `docker/caddy/` (image, `Caddyfile.selfhost`, `common.caddy`, `instance-config.js`).

This profile runs the **entire stack on one server** with real production semantics on your own domain. A 4–8 core / 16 GB machine is enough (idle < 2 GB; RAM is mostly consumed under call/upload load). Full walkthrough in `docker/SELFHOST.md`.

### How it differs from the dev stack

- **Distinct Compose project name** (`name: cg-selfhost`), so its containers and volumes never collide with the dev stack even in the same directory.
- **Caddy** (image `cryptogram/caddy-selfhost`, built from `docker/caddy/` on the pinned `caddy:2.11.x-alpine` base, config `Caddyfile.selfhost` — see [section 3](#3-caddy-the-edge)) is the whole edge: it serves the frontend and the instance config, routes to the backend, and obtains/renews **Let's Encrypt** certificates automatically for the app domain and mediasoup call signalling (port 4443) — or, with `CG_TLS_MODE=internal`, issues them from its own local CA (LAN/test instances without public DNS). There is no nginx in this profile any more.
- **`DEPLOYMENT=prod`** on any domain — full production behaviour without hardcoding `app.cg`.
- **No `hardhat` dev chain, no test-contract deployment.**
- **Postgres loads the tuned `postgresql.conf`** (same `config_file` command as dev).
- **Valkey memory is set from `.env.selfhost`**: `${REDIS_MAXMEMORY:-1024mb}` for the state instance (`redis`) and `${REDIS_CACHE_MAXMEMORY:-256mb}` for the cache (`redis-cache`), instead of the dev 1 GB / 256 MB. `.env.selfhost` files from before 2026-10-31 still carry `REDIS_MAXMEMORY=1536mb` (then the budget of the single instance); it now applies to the state instance alone, and the cache instance adds its default 256 MB.
- **`mediasoup` and `onchain` are optional**: they carry the Compose profiles `calls` and `blockchain`, which `selfhost.sh` enables from `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` in `.env.selfhost` (both default to `true`). See [docs/deployment §3.8](../deployment/README.md#38-optional-services-calls-and-blockchain) and `docker/SELFHOST.md`.
- **The gateway of a moved instance** (`gateway-api`, `gateway-wsapi`) carries the Compose profile `gateway`, enabled by `CG_ENABLE_GATEWAY=true` (default off), with its own domains (`CG_GATEWAY_DOMAIN`, `CG_GATEWAY_ID_DOMAIN`) and session secret (`CG_GATEWAY_SESSION_SECRET`); `up` refuses to start it without them, with the instance's own secret or domains, or with `CG_LEGACY_CGID=true` on the instance itself. Like `api` and `wsapi` they start only after `migrate-db` exited 0, report the same health and have a memory limit (`1g` and `512m`) and rotating logs. See [Gateway of a moved instance](#gateway-of-a-moved-instance) and [docs/deployment §3.3](../deployment/README.md#33-services-docker-composeselfhostyml).
- **Every backend process caps its PostgreSQL pool** (`PG_POOL_MAX`, defaults per service); the sum, the gateway included, stays below `max_connections`.
- **`CG_ENABLE_IMAGE_FILTER`** (default `true`) is a plain switch, not a profile: it feeds `IMAGE_MODERATION_ENABLED` into the `api`/`onchain` services and the instance-config injection (`features.imageFilter`), which also turns off the client-side pre-upload warning. `CG_IMAGE_FILTER_THRESHOLD` / `CG_IMAGE_FILTER_MODEL_PATH` pass through to `IMAGE_MODERATION_THRESHOLD` / `IMAGE_MODERATION_MODEL_PATH`.
- **SeaweedFS master** uses `-volumeSizeLimitMB=${SEAWEED_VOLUME_LIMIT_MB:-1024}`.
- **Log rotation:** every service logs through the `json-file` driver with `max-size ${CG_LOG_MAX_SIZE:-20m}`, `max-file ${CG_LOG_MAX_FILE:-5}` and `compress` (the `x-logging` anchor), so a container keeps at most about 100 MB of logs; `docker inspect -f '{{json .HostConfig.LogConfig}}' <container>` shows it. The dev stack keeps Docker's defaults.
- **Memory limits:** every service has a `mem_limit`, overridable per service with `CG_MEM_LIMIT_<SERVICE>` (e.g. `CG_MEM_LIMIT_API`, `CG_MEM_LIMIT_JOB_RUNNER`) in `.env.selfhost`. The Go services (`caddy`, `seaweed`) get `GOMEMLIMIT` at about 85% of their limit, the job-runner's worker threads a heap cap each (`JOB_WORKER_MAX_OLD_SPACE_MB`, default 384); `up` warns when `CG_MEM_LIMIT_REDIS` is below twice `REDIS_MAXMEMORY`. Defaults, the measurements behind them and Node's heap sizing: [docs/deployment §5](../deployment/README.md#memory-limits). The dev stack has none.
- **Health checks:** the backend services report real health ([Backend health checks](#backend-health-checks)); `migrate-db` has the image's check disabled.
- **Mail:** no `mailpit`; instead an optional send-only relay, service `mail` (`foxcpp/maddy:0.9.6`, pinned by digest, config in `docker/mail/`), behind the Compose profile `mail`, which `selfhost.sh` enables only for `CG_ENABLE_MAIL=true` (written by `init.sh`; unset = off). It sits on its own networks — `mail-relay` (`internal: true`, shared with `api` and `job-runner`) and `mail-egress` — and keeps its DKIM key and queue in the `mail-data` volume. Bounce reports go back over `mail-relay` to the job-runner's receiver on port 2525 (`MAIL_BOUNCE_RECEIVER=${CG_ENABLE_MAIL:-false}` on the `job-runner` service), which only accepts connections from the relay's own address. The relay is the only component meant to send to port 25; the app containers still have ordinary egress, so enforcing that takes a host firewall rule, which `harden.sh` sets up (part `mail25`: refuses 25/tcp from every Docker bridge but `mail-egress`'s, whose bridge is named `cg-mail-out`). See [docs/deployment §3.9](../deployment/README.md#39-email-smtp-and-the-mail-relay).

### Operation scripts

- **`docker/selfhost/init.sh [--tls-internal] <domain> <acme-email> [id-domain] [public-ip] [public-ipv6]`** — one-time bootstrap. Idempotent (never overwrites existing files). It:
  - Auto-detects the public IPv4 address (via ipify, `curl -4`) if not supplied; a supplied IP (e.g. a LAN address) is used as-is, and must be IPv4 (mediasoup listens on IPv4 only).
  - Auto-detects the public IPv6 address (`curl -6`, `api6.ipify.org`) unless one — or `-` for none — is supplied or `--tls-internal` is given, and records it as `CG_PUBLIC_IPV6`. Nothing in the stack uses it yet: the stack's Docker networks are IPv4-only, so the next steps say to publish an A record and no AAAA record (`docker/SELFHOST.md`, "IPv6").
  - `--tls-internal` writes `CG_TLS_MODE=internal` instead of `acme`, accepts `-` for the then-unused ACME email, and requires the IP argument.
  - Generates `docker/.env.selfhost` with fresh random secrets (`openssl rand`) — all DB/Redis/S3 credentials, the relay login `SMTP_PASSWORD` (with `CG_ENABLE_MAIL=true`, `SMTP_HOST=mail` and the `MAIL_*` settings), the backup password `CG_BACKUP_PASSWORD` with the other `CG_BACKUP_*` settings, resource-tuning defaults sized for 16 GB, bot limits, and a fully-commented set of optional-integration keys. The script runs with `umask 077`, so the file is mode 600 from the moment it exists.
  - Generates `docker/s3_config/s3.selfhost.json` (creating `s3_config/`, which holds no tracked file and so is missing in a fresh clone) with an S3 secret matching the generated `S3_SECRET`, mode `600`, owned by whoever runs the script: the `seaweed` container reads it as root and copies it for its own user (see `seaweed` above).
  - Generates a self-signed cert in `docker/selfhost/certs/` for the internal caddy→mediasoup hop only (clients only ever see Caddy's cert).
  - The third argument (`id-domain`, or `-`) is only for the legacy CG ID gateway; by default `CG_ID_DOMAIN` is written empty.
  - The generated `.env.selfhost` prefills the RPC endpoints with **free public JSON-RPC URLs** and `CG_ACTIVE_CHAINS=eth,arbitrum,xdai,base,matic,lukso`, so token-gating works out of the box.
- **`docker/selfhost/selfhost.sh <cmd>`** — build/operate wrapper. Requires `.env.selfhost` (except `backup`/`restore`, see below); runs Compose with `--env-file .env.selfhost -f docker-compose.selfhost.yml`, plus `-f docker-compose.selfhost.calls.yml` when calls are enabled (publishes `4443` and switches on Caddy's call-signalling site), and exports `CG_CGID_VHOST=on` only when `CG_LEGACY_CGID=true` and `CG_ID_DOMAIN` is set (the legacy CG ID site; `up`/`update` note a `CG_ID_DOMAIN` that is ignored). Commands: `build`, `up`, `down`, `logs [service]`, `ps`, `stats`, `compose <args>`, `update` (git pull + rebuild + restart), `mail-dns` (SPF/DKIM/DMARC/PTR records for the mail relay), `backup <init|run|list|check|verify|install-timer|uninstall-timer>` and `restore …` (both handed to `backup.sh`). It needs the Compose plugin (`docker compose`, v2 or later) and stops with a message otherwise — the standalone `docker-compose` v1 is no fallback any more, since it ignores `COMPOSE_PROFILES` and would silently start neither mediasoup, onchain nor the mail relay. `up` and `update` first warn about contradictory mail settings and about a `CG_PUBLIC_IP` that is empty or not an IPv4 address. It sets `COMPOSE_PROFILES` from the `CG_ENABLE_CALLS` / `CG_ENABLE_BLOCKCHAIN` / `CG_ENABLE_MAIL` switches and runs `up`/`down`/`update` with `--remove-orphans`; `up` and `update` also stop and remove the container of a service whose switch was flipped off (`compose rm -sf` — `--remove-orphans` does not touch profile-disabled services), so e.g. the media ports are no longer published once calls are off. `update` runs `git pull` and continues in the pulled script. The `build` command mirrors `build.sh` (same type-check/lint/build/check chain, same `NODE_OPTIONS=--max-old-space-size=4096`, the build ID handed from `build/build-id.txt` to the backend image — [Build ID](#build-id)) and builds the caddy image from `docker/caddy/` with the frontend in it. Sourcemaps ship here too — see [Frontend build steps](#frontend-build-steps).
- **`docker/selfhost/harden.sh [--dry-run] [--ssh-user <name>] [--skip <part>]`** — base hardening of a dedicated Ubuntu/Debian server (roadmap S3): key-only SSH (refused unless the operator has an authorized key), ufw with only the stack's ports, unattended security upgrades, a bounded journal, the two sysctls the stack needs (`net.ipv4.ip_local_reserved_ports = 40000-40099`, `vm.overcommit_memory = 1`), and outgoing 25/tcp from containers only through the mail relay's bridge `cg-mail-out` (a `DOCKER-USER` rule, re-applied by `cg-mail-egress.service` whenever Docker starts; iptables firewall backend only). Idempotent; `--dry-run` prints every change. Details: [docs/deployment §3.11](../deployment/README.md#311-server-hardening).
- **`docker/selfhost/backup.sh`** — backup and restore with restic (official image, pinned by digest as `RESTIC_IMAGE`; also the helper for file operations in volumes): a local repository in `CG_BACKUP_DIR` plus an off-server copy in `CG_BACKUP_REPOSITORY`, systemd timers via `backup install-timer` (running as the checkout owner), drill mode (`restore --drill`) and `restore --undo`. `selfhost.sh up`/`update` resume a `seaweed` that a killed backup left paused. Called through `selfhost.sh`, which runs Compose operations for it (`selfhost.sh compose …`). Design and verification: [docs/deployment §3.7](../deployment/README.md#37-backup-and-restore); operator guide: `docker/SELFHOST.md` ("Backup and restore").

### Caddy (`docker/caddy/Caddyfile.selfhost`)

The routing, headers and instance config are described in
[section 3](#3-caddy-the-edge); specific to the self-host config:

- Env-driven: `CG_DOMAIN`, `CG_ACME_EMAIL`, `CG_TLS_MODE`, `CG_WWW_REDIRECT`,
  `CG_CALLS_EDGE`, `CG_CGID_VHOST`, `CG_ID_DOMAIN`, `CG_GATEWAY_EDGE`,
  `CG_GATEWAY_DOMAIN`, `CG_GATEWAY_ID_DOMAIN`, plus the instance-config
  variables (`CG_*`, and `GATEWAY_CG_*` for the gateway's sites). Nothing is templated into the config or the image at build time,
  so the image does not depend on the domain.
- The global options block does `import tls_mode_{$CG_TLS_MODE:acme}`: snippet `tls_mode_acme` sets `email {$CG_ACME_EMAIL}` (Let's Encrypt), `tls_mode_internal` sets `local_certs` + `skip_install_trust` (every site from Caddy's local CA; root in the `caddy-data` volume under `/data/caddy/pki/authorities/local/`). Any other value fails at startup. Compose passes `CG_TLS_MODE=${CG_TLS_MODE:-acme}`, so an `.env.selfhost` without the key stays on ACME.
- With `CG_WWW_REDIRECT=on`, `www.{$CG_DOMAIN}` gets a TLS site that permanently redirects to `https://{$CG_DOMAIN}{uri}`, preserving paths and queries. The default is `off`; the www DNS record must point at this server before enabling it.
- The main site imports `cg_app` with `X-Forwarded-Proto: https`, `frame-src https:`, `connect-src` for `https://` and `wss://` on the own domain, and adds HSTS (`max-age=31536000`, HTTPS responses only).
- `{$CG_DOMAIN}:4443` → `reverse_proxy https://mediasoup:4443` with `tls_insecure_skip_verify` (the internal hop trusts mediasoup's self-signed cert) — only with `CG_CALLS_EDGE=on`, which `docker-compose.selfhost.calls.yml` sets together with publishing the port.
- The legacy CG ID site (`{$CG_ID_DOMAIN}`) exists only with `CG_CGID_VHOST=on` (see [Legacy CG ID mini-app](#legacy-cg-id-mini-app)); `CG_ID_DOMAIN` is otherwise unused, and an `.env.selfhost` from before 2026-10-31 that still carries it no longer gets a second site or certificate.
- The gateway's sites (`{$CG_GATEWAY_DOMAIN}`, `{$CG_GATEWAY_ID_DOMAIN}`) exist only with `CG_GATEWAY_EDGE=on` (see [Gateway of a moved instance](#gateway-of-a-moved-instance)).
- Ports published: `80`, `443` (tcp+udp, HTTP/3), and `4443` (tcp) with calls. WebRTC media `40000–40099` (UDP and TCP) is published directly by the mediasoup container.

### Instance identity

The same build artifacts serve any domain: identity is configuration, not
code. Caddy renders `/instance-config.js` per request from the `CG_*`
variables of its container ([Instance config](#instance-config)); it is
active only when `CG_APP_URL` is set (always, in this profile). The object
carries `deployment`, `appUrl`, `passkeyRpId` (from `CG_PASSKEY_RP_ID`, default
the host of `CG_APP_URL`; must match the backend's `PASSKEY_RP_ID`) — or, only
with `CG_LEGACY_CGID=true`, `cgidUrl` from `CG_CGID_URL` (compose derives it
from `CG_ID_DOMAIN`) —, `activeChains`, a `features` map (`email`,
`twitterAuth`, `calls`, `imageFilter`, `passkeys`), `imageFilterThreshold`,
`giphyApiKey`, `walletConnectProjectId`, `recaptchaSiteKey` and
`captchaProvider`. Compose derives the boolean feature flags from whether the
corresponding key is set (e.g. `CG_FEATURE_EMAIL=${SMTP_HOST:+true}`), so the
frontend hides or honestly labels features that aren't configured. The
backend builds the same object for `GET /api/v2/Instance/config`. See
`src/common/instance.ts`.

### Optional integrations & graceful degradation

Every third-party integration is optional; leaving its key empty in `.env.selfhost` disables just that feature (email/OTP login, captcha, Twitter/X auth, Giphy, WalletConnect). The rest of the app keeps working — password/passkey/wallet login, RSVPs, injected wallets, etc. `docker/SELFHOST.md` has the full capability matrix.

### Blockchain endpoints

`init.sh` prefills `QUIKNODE_*` / `INFURA_LINEA` with free public endpoints and `CG_ACTIVE_CHAINS` selects which chains the instance offers (drives both backend workers and the UI chain lists — keep them in sync). The on-chain event listener issues ranged `eth_getLogs` calls; some free endpoints restrict that method, which is why the defaults favour drpc.org and official chain RPCs. Frontend wallet interactions use each chain's default public RPC when an instance config is present.

### Token staking (Spark)

Off by default. To enable, deploy your own non-custodial `CgStaking` contract (`contracts/staking/`) and set `STAKING_CHAIN` (must be in `CG_ACTIVE_CHAINS`), `STAKING_TOKEN_ADDRESS`, `STAKING_CONTRACT_ADDRESS`, and optionally `STAKING_BASE_RATE` / `STAKING_MIN_LOCK_DAYS` / `STAKING_MAX_LOCK_DAYS` in `.env.selfhost`, then `./selfhost/selfhost.sh up` to recreate the `api`, `job-runner` and `onchain` services. See [`docs/staking`](../staking/README.md).

### Backups & firewall

State lives in two named volumes: `pgdata` (database) and `seaweedfs-data` (uploaded media), plus `mail-data` (DKIM key and outgoing queue) when the mail relay runs; `caddy-data` holds the ACME account and certificates (or the local CA). `selfhost.sh backup run` saves a `pg_dump` (online), `seaweedfs-data` (read while the `seaweed` container is paused), `caddy-data`, the DKIM key and the secrets bundle (`.env.selfhost`, `vapid_keys.json`, `s3.selfhost.json`, `selfhost/certs/`, `backup/`) into restic — see [docs/deployment §3.7](../deployment/README.md#37-backup-and-restore). `valkey-data` holds the state instance's RDB snapshot (sessions, rate-limit windows, replay guards); it is not backed up — losing it logs everyone out once, and a database restore removes it on purpose. The cache instance is unpersisted. Ports to open: `80/tcp` (ACME + HTTPS redirect), `443/tcp+udp` (app, HTTP/3), `4443/tcp` (call signalling, with calls), `40000–40099/udp+tcp` (WebRTC media; TCP is the fallback for UDP-blocking client networks). The mail relay needs outbound `25/tcp` only. These are the only ports the self-host compose files publish — Docker-published ports bypass a host firewall such as ufw, so nothing else may be published; `harden.sh` sets up ufw for exactly this set and lists any published port outside it.
