> Status: verified against commit a3c3f7608, 2026-08-01

# Common Ground - Architecture Documentation

This document describes the system architecture of Common Ground, a browser-based communication platform (Discord alternative) with optional Web3 integration. It is intended for developers and AI agents who need to understand the system's internals.

---

## 1. System Overview

### High-Level Architecture

The reference (cloud) deployment terminates TLS at Cloudflare and routes everything through a single nginx reverse proxy in front of the backend services:

```
                                  +---------------------+
                                  |     Cloudflare      |
                                  |   (DNS / CDN / WAF) |
                                  +----------+----------+
                                             |
                                  +----------v----------+
                                  |       nginx         |
                                  |   (reverse proxy)   |
                                  |   ports 80 / 443    |
                                  +--+-----+-----+---+--+
                                     |     |     |   |
                     +---------------+     |     |   +------------------+
                     |                     |     |                      |
          +----------v-------+  +----------v-+  +v-----------+  +------v--------+
          |   Static Files   |  |    API      |  |   wsapi    |  | S3 (SeaweedFS)|
          |   (React SPA)    |  |  (Express)  |  | (Socket.IO)|  | file proxy    |
          |   served from    |  |  port 4000  |  | port 4000  |  | port 8333     |
          |   /www           |  +------+------+  +-----+------+  +---------------+
          +------------------+         |               |
                                       |               |
                              +--------v---------------v--------+
                              |           PostgreSQL             |
                              |         (primary database)       |
                              |           port 5432              |
                              +--------+------------------------+
                                       |
                    +------------------+-------------------+
                    |                  |                    |
          +---------v----+  +----------v-----+  +----------v-----+
          | redis-sessions|  | redis-socketio |  |   redis-data   |
          | (session store|  | (Socket.IO     |  | (caching /     |
          |  for Express) |  |  pub/sub       |  |  user data)    |
          +--------------+  |  adapter)       |  +----------------+
                            +----------------+

   +----------------+  +----------------+  +----------------+  +----------------+
   |   mediasoup    |  |   onchain      |  |   job-runner   |  |   memberlist   |
   |  (WebRTC SFU)  |  | (blockchain    |  | (background    |  | (member list   |
   |  port 4443 TCP |  |  watcher)      |  |  workers)      |  |  service)      |
   |  40000-40099   |  |                |  |                |  |                |
   |  UDP           |  |                |  |                |  |                |
   +----------------+  +----------------+  +----------------+  +----------------+
```

A single-server self-hosting profile is also supported; it places **Caddy** (automatic Let's Encrypt TLS) in front of the same nginx + backend stack. See [§7 Self-Host Topology](#7-self-host-topology).

### Component Summary

| Component | Technology | Docker Service | Purpose |
|-----------|-----------|----------------|---------|
| **Frontend** | React SPA (TypeScript) | Served via nginx | Single-page application; communicates via REST + Socket.IO |
| **API Server** | Express.js (TypeScript) | `api` | REST API for all CRUD operations, session management, authentication, bot protocol |
| **WebSocket Server** | Socket.IO (TypeScript) | `wsapi` | Real-time event broadcasting (messages, presence, notifications), bot socket streams |
| **Database** | PostgreSQL | `db` | Primary persistent data store; uses LISTEN/NOTIFY for some inter-service signaling |
| **Session Cache** | Redis 6.2 | `redis-sessions` | Express session storage via `connect-redis` |
| **Socket.IO Adapter** | Redis 6.2 | `redis-socketio` | Pub/sub adapter for Socket.IO to enable multi-instance broadcasting |
| **Data Cache** | Redis 6.2 | `redis-data` | General-purpose caching (user data, rate limiting, bot presence) |
| **File Storage** | SeaweedFS (S3-compatible) | `seaweedmaster`, `seaweedvolume`, `s3` | S3-compatible object storage for uploaded files and images |
| **Reverse Proxy** | nginx | `nginx` | TLS termination (cloud), routing, static file serving, S3 file proxying, instance-config injection (self-host) |
| **WebRTC SFU** | MediaSoup | `mediasoup` | Selective Forwarding Unit for voice/video calls |
| **Blockchain Watcher** | Custom (ethers.js) | `onchain` | Monitors multi-chain token balances for role gating; indexes staking contract events |
| **Job Runner** | Node.js worker threads | `job-runner` | Scheduled and permanent background tasks |
| **Member List Service** | Custom Express | `memberlist` | In-memory member list management via PostgreSQL LISTEN/NOTIFY |
| **DB Migrations** | Custom | `migrate-db` | Runs database schema migrations on startup |
| **Local Blockchain** | Hardhat | `hardhat` | Local Ethereum node for development only (not part of the self-host or production profile) |

**Note on "components" vs. "services":** *Bots* and *Staking* are product features, not separate containers. They are served by the existing `api`/`wsapi` processes (bot routers, socket streams) and the `job-runner`/`onchain` processes (Spark accrual, event indexing).

### Key Source Paths

- **Frontend**: `src/` (React SPA, TypeScript)
- **Backend**: `srv/` (all server-side code, TypeScript)
- **API routes**: `srv/api/` (Express routers)
- **Bot auth middleware**: `srv/util/botPrincipal.ts` (bearer token authentication + route allowlist)
- **Instance config**: `srv/util/instanceConfig.ts` (builds `window.__CG_INSTANCE__`) / `src/common/instance.ts` (frontend accessor)
- **Repositories**: `srv/repositories/` (data access layer)
- **Background jobs**: `srv/jobs/` (worker thread scripts)
- **WebRTC**: `srv/mediasoup/` + `srv/mediasoup.ts`
- **Blockchain**: `srv/onchain/` + `srv/onchain.ts`
- **Infrastructure**: `docker/docker-compose.yml` (cloud/dev), `docker/docker-compose.selfhost.yml` (self-host)
- **nginx config**: `docker/nginx/nginx_dev.conf`, `docker/nginx/nginx_selfhost.conf`

---

## 2. Request Flow

### Typical Flow: Sending a Message

```
 User types message in React SPA
           |
           v
 Frontend calls BaseApiConnector.ajax("POST", "/sendMessage", {...})
   - Uses XMLHttpRequest with withCredentials: true
   - Sends to: {BASE_URL}/api/v2/Message/sendMessage
   - Content-Type: application/json
           |
           v
 nginx receives request
   - Matches: /api/v2/Message/...
   - Rewrites: strips /api/v2 prefix
   - Proxies to: http://api:4000/Message/sendMessage
           |
           v
 Express API server (srv/api.ts)
   - Request passes through middleware chain:
     1. CORS check (origin whitelist)
     2. JSON Content-Type header set on all responses
     3. Cookie parser
     4. Bot authentication (only if an Authorization: Bearer header is present)
     5. Session middleware (skipped for authenticated bot requests)
     6. Passport initialization + session (skipped for bots)
     7. Session-timestamp middleware (skipped for bots)
     8. Bot allowlist middleware (blocks bot principals from non-allowlisted routes)
   - Route matched: app.use('/Message', messageRouter)
           |
           v
 registerPostRoute handler (srv/api/util.ts)
   - Parses JSON body
   - Validates with Joi schema
   - Executes handler function
   - Wraps result in { status: "OK", data: result }
   - On error: returns { status: "ERROR", error: "..." }
           |
           v
 Repository layer (srv/repositories/*)
   - Writes message to PostgreSQL
   - Generates S3 pre-signed URLs if attachments present
           |
           v
 Socket.IO broadcast (wsapi)
   - API server emits event via redis-socketio pub/sub
   - wsapi server(s) pick up event and broadcast to relevant rooms
   - Rooms are keyed by: user ID, community ID, role ID, device ID
           |
           v
 Frontend receives Socket.IO event
   - Updates local state/store
   - Re-renders UI
```

### Middleware Chain (`srv/util/express.ts`)

The middleware order is significant. A **bot authentication** step (`botAuthenticationMiddleware`) runs immediately after cookie parsing and before the session stack:

- If the request carries **no `Authorization` header**, the middleware is a no-op and the request continues as a normal (cookie/session) request.
- If it carries a `Bearer` token, it is authenticated against the bot-token store. On success `request.botPrincipal` is set, and each of the session, Passport, and session-timestamp middlewares is **short-circuited** (bots never get an Express session).
- After the session stack, `botAllowlistMiddleware` ensures that a request bearing a bot principal may only reach routes that were explicitly opted in via `allowBotRoute(method, path)`; anything else returns `403`.

This makes the public **Bot API** a bearer-only surface that shares the same Express app as the human/session API but is isolated from it by the allowlist. See [§3 Bot Token Authentication](#bot-token-authentication).

### Typical Flow: File Access

```
 Frontend requests file URL
   - URL format: /files/{fileId}/{signature}/{date}T{time}Z/{expires}
           |
           v
 nginx matches file pattern
   - Rewrites to S3 pre-signed URL format
   - Proxies directly to the SeaweedFS S3 gateway (http://s3.local:8333)
   - Adds Cache-Control: private,max-age=604800,immutable
   - The API server is NOT involved in file serving
```

### Typical Flow: Social Preview / SSR + Instance Config

```
 Bot/crawler requests: /c/{communityUrl}/  (or /u/, /gated-videos/, /gated-files/)
           |
           v
 nginx proxies to API server (matches ^/(c|u|gated-videos|gated-files)/)
           |
           v
 getRoutes.ts (srv/api/getRoutes.ts)
   - Parses community URL or short UUID
   - Fetches metadata from PostgreSQL
   - Injects OpenGraph meta tags into the index.html template
   - Injects the instance-config <script> (window.__CG_INSTANCE__) into <head>
     if not already present (see instanceConfigScriptTag())
   - Returns server-rendered HTML with social-preview data
```

Every `index.html` the backend serves for share links / previews is stamped with a `window.__CG_INSTANCE__` script that declares the instance's identity (deployment mode, URLs, capability flags). See [§7 Instance Config](#instance-configuration-__cg_instance__).

---

## 3. Authentication & Sessions

### Session Infrastructure

Sessions are managed by `express-session` with a Redis-backed store. Key configuration from `srv/util/express.ts` and `srv/serverconfig.ts`:

- **Store**: `connect-redis` backed by the `redis-sessions` instance
- **Cookie name**: `connect.sid` when `DEPLOYMENT === 'prod'`; otherwise `cg_{deployment}.sid` (`SESSION_COOKIE_NAME` in `srv/serverconfig.ts`)
- **Cookie settings**: `httpOnly`, `secure` (except in dev), `sameSite: lax`, 12-hour max age, `rolling: true` (refreshed on every request)
- **Cookie domain**: for non-dev deployments the cookie domain is set to `.{APP_HOSTNAME}` (derived from `BASE_URL`), so the app and the CG ID app (`id.<domain>`) share a session. Self-hosted instances get their own domain automatically.
- **Secret**: loaded from Docker secret `redis_secret` or `REDIS_SECRET` env var
- **saveUninitialized**: `true` (sessions are created for every non-bot request)
- **trust proxy / proxy**: enabled (nginx/Caddy sit in front)

### CORS Configuration

Both the API (`srv/util/express.ts`) and WebSocket (`srv/wsapi.ts`) servers maintain their own CORS allowed-origin lists:
- **Production/Staging**: `BASE_URL` + `CGID_URL` (the CG ID subdomain)
- **Dev**: additional localhost origins on ports 3000/8000/8001, plus `app.cg.local`, `bs-local.com`, and an optional `LOCAL_CERTIFICATE_IP`
- Requests with no `Origin` header are allowed (mobile apps, curl, server-to-server)
- The mediasoup server uses `cors()` with no restrictions (allows all origins)

### Session Data Shape

The session stores authentication state, declared in `srv/util/express.ts`:

```typescript
interface SessionData {
  user?: { id: string; deviceId: string };  // Set after successful login
  signSecret?: string;                       // One-time challenge for device auth
  createdAt?: Date;
  passport?: any;                            // Passport (Twitter OAuth) data
  twitter?: { codeVerifier, state, accessToken, userData, ... };
  lukso?: { message, address, username, ... };
  farcaster?: { address, fid, username, ... };
  preparedCredential?: PreparedCredential;   // For wallet-based login
  passkeyData?: { step, ... };               // WebAuthn/passkey state machine
  temporaryArticleIds?: string[];
}
```

Bot requests never populate a session; bots are identified purely by `request.botPrincipal`.

### Authentication Methods (Human / Session)

The login endpoint at `POST /User/login` (in `srv/api/user.ts`) supports multiple authentication types via a discriminated union on `data.type`:

1. **Device-based (`type: "device"`)** — primary re-authentication. `POST /User/getSignableSecret` returns a random 20-char challenge stored in `session.signSecret`; the frontend signs it with the device private key; the server verifies via `deviceHelper.verifyDeviceAndGetUserId()` and populates `session.user`.
2. **Wallet-based (`type: "wallet"`)** — a "prepared credential" assembled in a prior step (`session.preparedCredential`) is verified, then a device is created.
3. **Passkey / WebAuthn (`type: "passkey-success"`)** — multi-step state machine in `session.passkeyData` (`registration_sign` → `authentication_sign` → `success`/`error`); login requires the `success` state with a valid, non-deleted passkey.
4. **Email + password (`type: "password"`)** — verified via `userHelper.getOwnDataByCgProfileNameOrEmailAndPassword()`; creates a device from the supplied public key.
5. **Twitter OAuth (`type: "twitter"`)** — Passport.js flow in `getRoutes.ts`; Twitter user id read from `session.passport`.
6. **Lukso Universal Profile (`type: "lukso"`)** — on-chain signature over the nonce, verified via `onchainHelper.luksoIsValidSignature()`.
7. **Farcaster (`type: "farcaster"`)** — SIWE flow verified via `/Farcaster/verifyLogin`, checking the Farcaster id registry on-chain.
8. **Email verification code (`type: "verificationCode"`)** — passwordless; verified via `userHelper.getOwnDataByEmailAndVerificationCode()`.

**Post-login state.** After any successful login the server creates a device entry, sets `request.session.user = { id, deviceId }`, clears `session.signSecret`, and returns `{ ownData, communities, chats, deviceId, webPushSubscription, unreadNotificationCount }`.

### Captcha Verification

Human-facing endpoints (`/User/verifyCaptcha`, user creation) verify a captcha token server-side against the configured provider (`verifyCaptchaToken` in `srv/util/captcha.ts`). The provider is selected via `CAPTCHA_PROVIDER = altcha | recaptcha | off`: **ALTCHA** (self-hosted proof-of-work, challenges from `GET /Captcha/challenge`, HMAC-signed, single-use via Redis) is the fail-closed default; **reCAPTCHA v2** is auto-selected when a reCAPTCHA secret is configured (official instances); **off** must be set explicitly and logs a startup warning. The frontend resolves the provider at runtime from `GET /Captcha/config` (public, returns the provider the server verifies against) and only falls back to the instance config hint (`captchaProvider` / `recaptchaSiteKey` in `window.__CG_INSTANCE__`) when that request fails; widgets are rendered by `src/components/molecules/CaptchaModal/` and the signup form. See [docs/auth-identity/](../auth-identity/README.md) §6 for details.

### Bot Token Authentication

Bots authenticate with a **bearer token** rather than a session cookie:

1. A community/user manager provisions a bot and issues a token via the internal `/Bot/*` management routes (session-authenticated, human-only).
2. The bot sends requests to the public Bot API (`/api/bot/v1/...`, mapped to `/BotV1/...`) with `Authorization: Bearer <token>`.
3. `botAuthenticationMiddleware` (`srv/util/botPrincipal.ts`) validates the token via `botTokenHelper.authenticate()` and attaches `request.botPrincipal` ( = user id, token id, scopes). A request that presents **both** a bearer token and the session cookie is rejected (`400`).
4. `botAllowlistMiddleware` gates which routes a bot principal may reach. `/BotV1` additionally requires `request.botPrincipal` to be present on every route (bearer-only), and rejects otherwise with `403`.
5. Bot tokens are rejected if the owning account is inactive.

The Bot API is versioned (`BOT_PROTOCOL_VERSION` in `srv/common/botProtocol.ts`) and rate-limited per token (`enforceBotRateLimit`). Its message surface reuses the human `messageRouter`, mounted at `/BotV1/messages`.

### Socket.IO Authentication

The WebSocket server (`srv/wsapi.ts`) has its own auth flow, separate from the REST session:

1. On connection, the session cookie is decoded from `socket.handshake.headers.cookie`.
2. The socket joins an `expressSession:{sessionId}` room (server-to-socket signalling).
3. The socket requests a `signableSecret` via `getSignableSecret`, then sends a `login` event with `{ deviceId, secret, base64Signature }`.
4. The server verifies the device signature (same mechanism as REST device auth).
5. On success the socket joins rooms for the user (`user:{userId}`), each role (`role:{roleId}`), each community (`community:{communityId}`), and the device (`device:{deviceId}`), and the user is marked `online`.

**Bot sockets.** Bots may also connect over Socket.IO using their bearer identity. A bot socket is tagged with `botTokenId`, joins a per-token room (`botTokenRoomKey`), and drives a Redis-backed **connection-presence** lease (`bot-presence:{userId}`, 90 s lease) so the platform can show a server-derived "connected" state for the bot even across multiple `wsapi` instances.

---

## 4. Multi-Service Communication

### Service Topology

The system runs as multiple independent Node.js processes (Docker containers), each with a specific entry point:

| Service | Entry Point | Listens On | Communicates With |
|---------|------------|------------|-------------------|
| `api` | `srv/api.ts` | HTTP :4000 | PostgreSQL, all 3 Redis instances, S3, onchain |
| `wsapi` | `srv/wsapi.ts` | Socket.IO :4000 | PostgreSQL, redis-sessions (cookie decode), redis-socketio (pub/sub adapter), redis-data (bot presence) |
| `mediasoup` | `srv/mediasoup.ts` | HTTPS :4443 + UDP 40000-40099 | PostgreSQL (LISTEN/NOTIFY) |
| `onchain` | `srv/onchain.ts` | HTTP :4000 (internal) | PostgreSQL, Redis, blockchain RPC nodes |
| `job-runner` | `srv/jobs.ts` | None (worker threads) | PostgreSQL, Redis, S3 |
| `memberlist` | `srv/memberlist.ts` | HTTP :4000 (internal) | PostgreSQL (LISTEN/NOTIFY) |

### API Routers

The API server (`srv/api.ts`) mounts the following Express routers:

| Route Prefix | Router | Source |
|-------------|--------|--------|
| `/Chat` | chatRouter | `srv/api/chats.ts` |
| `/Community` | communityRouter | `srv/api/community.ts` |
| `/File` | fileRouter | `srv/api/files.ts` |
| `/Message` | messageRouter | `srv/api/messages.ts` |
| `/User` | userRouter | `srv/api/user.ts` |
| `/Contract` | contractRouter | `srv/api/contracts.ts` |
| `/Notification` | notificationRouter | `srv/api/notifications.ts` |
| `/Twitter` | twitterRouter | `srv/api/twitter.ts` |
| `/Lukso` | luksoUniversalProfileRouter | `srv/api/luksoUniversalProfile.ts` |
| `/CgId` | cgIdRouter | `srv/api/cgid.ts` |
| `/Accounts` | accountsRouter | `srv/api/accounts.ts` |
| `/Plugins` | pluginRouter | `srv/api/plugins.ts` |
| `/Search` | searchRouter | `srv/api/search.ts` |
| `/Report` | reportRouter | `srv/api/report.ts` |
| `/Bot` | botRouter | `srv/api/bots.ts` (session-authenticated bot **management**) |
| `/BotV1` | botV1Router | `srv/api/botV1.ts` (bearer-only public **bot protocol**) |
| `/Staking` | stakingRouter | `srv/api/staking.ts` |
| `/` | getRoutes | `srv/api/getRoutes.ts` (social previews, SSR, Twitter OAuth callbacks) |

### Socket.IO Redis Adapter

The Socket.IO server uses `@socket.io/redis-adapter` with the dedicated `redis-socketio` instance for cross-instance pub/sub:

```
srv/wsapi.ts:
  io.adapter(createAdapter(
    redisManager.getClient('socketIOPub'),
    redisManager.getClient('socketIOSub'),
    { key: 'v2:' }
  ));
```

This allows the API server to emit events (via the shared Redis pub/sub channel) that are broadcast by any connected `wsapi` instance. The `v2:` key prefix namespaces the adapter messages.

### Redis Instance Separation

Three separate Redis instances isolate concerns (configured in `srv/redis/index.ts`):

| Redis Instance | Docker Service | Purpose |
|----------------|---------------|---------|
| `session` | `redis-sessions` | Express session storage (connect-redis). Written by `api`, read by `wsapi` for cookie verification. |
| `socketIOPub` / `socketIOSub` | `redis-socketio` | Socket.IO adapter pub/sub for broadcasting across `wsapi` instances. |
| `data` | `redis-data` | General-purpose caching, `UserDataManager`, rate limiting, bot connection-presence leases. |

### PostgreSQL LISTEN/NOTIFY

Several services use PostgreSQL's built-in LISTEN/NOTIFY for event-driven communication without Redis:

- **mediasoup**: Listens for `callservercallupdate_{serverId}` events (hyphens in the server UUID replaced by underscores) to receive call state changes directly from the database. Uses a dedicated long-lived `PoolClient` with a 60s keepalive; on keepalive failure the process exits.
- **memberlist**: Listens for `userdatachange`, `userrolechange`, `rolechange`, and `channelrolepermissionchange` events (lowercase channel names) to maintain its in-memory member list. Also uses a dedicated long-lived `PoolClient` with a 60s keepalive; events are queued and processed in batches on a 1-second loop.

### API-to-Onchain Communication

The `api` service communicates with the internal-only `onchain` service via HTTP within the Docker network (not exposed through nginx). Available endpoints (`srv/onchain.ts`):

- `POST /getContractData` — contract metadata (chain, address)
- `POST /checkRoleClaimability` — whether a user qualifies for a token-gated role
- `POST /checkMultiRoleClaimability` — batch role check
- `POST /checkCommunityRoleClaimability` — all token-gated roles in a community
- `POST /luksoIsValidSignature` — verify a Lukso Universal Profile signature
- `POST /luksoGetUniversalProfileData` — fetch Lukso profile metadata
- `POST /getSingleTransactionData` — transaction details
- `POST /getErc20Balance` — ERC-20 balance
- `POST /getBlockNumber` — current block number for a chain

The `onchain` process also runs the multi-chain balance watcher and, when staking is configured, an **event indexer** that reads `Staked` / `Unstaked` events from the `CgStaking` contract (`srv/onchain/generic.ts`) and persists positions via the staking repository.

### Background Jobs

The job runner (`srv/jobs.ts`) spawns Node.js `worker_threads` in three modes:

1. **Permanent workers** (auto-restart on crash):
   - `premiumRenewal`, `callUpdateEmitter`, `handleCommunityAirdrops`

2. **Cron/interval workers** (spawned on schedule, exit after completion):
   - `onlineStatusCheck` — every 30 s
   - `stakingAccrual` — cron `17 */6 * * *` (credits Spark to staking positions pro-rata; no-op when staking is unconfigured)
   - `activityScore` — every 10 minutes
   - `newsletterDelivery` — weekly (Saturday noon)
   - `emailNotifications` — every minute

3. **One-shot workers** (run once ~30 s after startup, then exit; each job checks the `oneshot_jobs` table itself to guard against re-running):
   - none currently — the mechanism (`createOneshotWorker` + `oneshot_jobs`) is kept for future backfills

**Healthcheck.** All backend services currently invoke `fakeHealthcheck()`, which writes `'0'` to `./healthcheck.txt` every 10 seconds unconditionally. A real connectivity-checking `startHealthcheck` exists in `srv/healthcheck.ts` but is not the active code path.

---

## 5. Data Flow Patterns

### Pattern 1: REST API (CRUD Operations)

All REST endpoints follow the `registerPostRoute` helper (`srv/api/util.ts`):

```
Client                    nginx                  API Server
  |                         |                        |
  |-- POST /api/v2/X/y --> |-- rewrite /X/y ------> |
  |                         |                        |-- express.json() parse body
  |                         |                        |-- Joi validation
  |                         |                        |-- handler(req, res, validatedData)
  |                         |                        |-- { status: "OK", data: result }
  | <-- 200 JSON ---------- | <--------------------- |
```

Key characteristics:
- **All mutations are POST** (no PUT/PATCH/DELETE at the HTTP level)
- **Validation**: every route uses Joi schemas for request-body validation
- **Response format**: always `{ status: "OK", data: ... }` or `{ status: "ERROR", error: "..." }`
- **Error handling**: only whitelisted error messages (from `srv/common/errors.ts`) are returned; unknown errors return a generic error
- **Binary uploads**: supported via `application/octet-stream` (file uploads)

The frontend API layer (`src/data/api/baseConnector.ts`) uses `XMLHttpRequest` with `withCredentials: true` and automatic retry on `LOGIN_REQUIRED` (re-authentication flow).

### Pattern 2: Socket.IO (Real-Time Events)

Socket.IO is used primarily for server-to-client event broadcasting. Events are targeted using rooms:

| Room Key Pattern | Purpose |
|-----------------|---------|
| `user:{userId}` | Direct events for a specific user |
| `device:{deviceId}` | Events for a specific device |
| `role:{roleId}` | Events for all users with a specific role |
| `community:{communityId}` | Events broadcast to an entire community |
| `expressSession:{sessionId}` | Events tied to an HTTP session |
| `botTokenRoomKey(tokenId)` | Events for a specific bot connection |

**Event flow (e.g., new message)**:

```
API Server (handles POST /Message/sendMessage)
  -> Writes to PostgreSQL
  -> Emits event to redis-socketio (Socket.IO server-side emit)
  -> redis-socketio pub/sub distributes to all wsapi instances
  -> Each wsapi instance broadcasts to matching rooms
  -> Connected clients in those rooms receive the event
```

**Built-in socket events** include: `buildId` (server→client build id for version checks), `cgPing` (latency), `getSignableSecret`, `login`, `logout`, `joinCommunityVisitorRoom` / `leaveCommunityVisitorRoom` (public-community visitors), and `prepareWalletRequest`. Bot connections additionally drive server-derived presence streams.

**Online status management**: on `login` the user is added to a local online set and marked `online`; on `disconnect`/`logout` a user with no remaining sockets is marked `offline`; a 60 s heartbeat touches all locally connected users; on graceful shutdown all connected users are explicitly set `offline`.

### Pattern 3: WebRTC Signaling (protoo)

The MediaSoup server (`srv/mediasoup.ts`) uses **protoo** (a WebSocket request/response protocol) for signaling, separate from Socket.IO:

```
Client Browser
  |-- wss://mediasoup:4443 (protoo) --> MediaSoup Server
  |  <-- protoo request/response -->    |
  |  Media via WebRTC (UDP 40000-40099) <-> |
```

- Runs its own HTTPS/WSS server, isolated from the API/WebSocket stack
- Uses PostgreSQL LISTEN/NOTIFY (not Redis) for call state
- Registers itself in the `callservers` table on startup and tracks call/traffic status in the database

### Pattern 4: Inter-Service HTTP (Internal)

`api` calls the internal `onchain` service over HTTP within the Docker network (see [§4](#api-to-onchain-communication)). Neither the `onchain` nor `memberlist` internal servers are exposed through nginx.

### Pattern 5: nginx as S3 Proxy

File serving bypasses the API server. nginx rewrites the signed file path into standard AWS S3 query parameters and proxies to the SeaweedFS S3 gateway (`http://s3.local:8333`). The signature/date/expiry are embedded in the URL path; the API server generates these signed URLs when returning file references.

---

## 6. Process Lifecycle & Error Handling

### Shutdown Behavior

| Service | Shutdown Behavior |
|---------|------------------|
| `api` | `process.exit(0)` immediately |
| `wsapi` | Sets `shuttingDown`, fetches all local sockets, marks single-socket users offline, disconnects sockets, closes the server |
| `mediasoup` | Resets call-server state in DB, stops protoo, closes rooms/workers and the HTTPS server; 5s hard-exit timeout |
| `onchain` | `process.exit(0)` immediately |
| `job-runner` | Sets `processIsExiting`, waits 4s if `activityScore` is running, terminates named workers, waits 1s, exits |
| `memberlist` | `process.exit(0)` immediately |

### Crash Handling

- `api`, `wsapi`, `mediasoup`: handlers for both `unhandledRejection` and `uncaughtException` log and call `shutdown(1)`
- `onchain`, `job-runner`, `memberlist`: handle `SIGTERM` only; unhandled rejections use Node.js defaults
- `mediasoup` workers: on the mediasoup `Worker.died` event the process exits after a 2s delay

---

## 7. Self-Host Topology

Common Ground ships a **single-server self-hosting profile** (`docker/docker-compose.selfhost.yml`, documented in `docker/SELFHOST.md`) that runs the full stack on one machine. It differs from the cloud/dev profile in a few structural ways:

- **Caddy** is added in front of nginx. Caddy owns ports 80/443 (and forwards mediasoup's 4443/tcp), obtains Let's Encrypt certificates automatically for the app domain and the CG ID subdomain, and reverse-proxies into the internal nginx. There is no Cloudflare layer.
- **nginx** uses `nginx_selfhost.conf` (image `cryptogram/nginx-selfhost`). Upstreams are **resolved dynamically** via Docker's embedded DNS (`resolver 127.0.0.11; set $upstream ...; proxy_pass $upstream;`) so nginx starts even if a backend container is not yet up, instead of failing at config-load time on a static upstream.
- **No dev-chain / test-contract services** (`hardhat` is dev-only). Blockchain features work against public RPC endpoints and are optional.
- All backend containers (`api`, `wsapi`, `mediasoup`, `onchain`, `job-runner`, `memberlist`, `migrate-db`) run from the same `cryptogram/backend` image, alongside Postgres, the three Redis instances, and SeaweedFS — identical to the cloud topology.

The two DNS records `chat.example.org` and `id.chat.example.org` must be distinct origins because passkeys are scoped to the CG ID origin.

### Instance Configuration (`__CG_INSTANCE__`)

Historically the frontend inferred its deployment mode and URLs from a hardcoded domain list (`app.cg`, `staging.app.cg`); any other domain silently ran with dev semantics. That coupling has been removed. An instance now **declares its identity at serve time** through a single global:

```html
<script>window.__CG_INSTANCE__ = {"deployment":"prod","appUrl":"https://chat.example.org","cgidUrl":"https://id.chat.example.org/#", ...}</script>
```

- **Build** (`srv/util/instanceConfig.ts`): `buildInstanceConfig()` assembles the object (`deployment`, `appUrl`, `cgidUrl`, optional `recaptchaSiteKey`, `activeChains`, `features`, `giphyApiKey`, `walletConnectProjectId`) and `instanceConfigScriptTag()` renders a `<`-escaped `<script>`.
- **Injection**: the API server injects the tag into any `index.html` it serves (share links / SSR, in `getRoutes.ts`); the self-host nginx image performs the equivalent injection into the statically served `index.html`/`index_cgid.html` at container start (`docker/nginx/inject-instance-config.sh`, driven by `CG_*` env vars in the compose file).
- **Consumption** (`src/common/instance.ts`): `getInstanceConfig()` is the single, validating accessor. When the global is absent it falls back to the legacy domain-based detection, so `app.cg` and local dev are unaffected. The same build artifacts therefore work for any domain — the domain is configuration, not code.

### Graceful Degradation & Capability Flags

All third-party integrations are optional. The server derives **capability flags** from which secrets are actually configured (`configured()` in `instanceConfig.ts`) and ships them to the frontend via `features` in `__CG_INSTANCE__`:

| Flag | Enabled when configured |
|------|-------------------------|
| `email` | SendGrid API key |
| `twitterAuth` | Twitter API v1 key + secret |

An **absent** flag means "feature available" (the behaviour on official instances that always have the keys); an explicit `false` lets a self-hosted frontend hide features that would only fail. Related optional values shipped the same way: `captchaProvider` / `recaptchaSiteKey` (captcha), `giphyApiKey` (GIF picker), `walletConnectProjectId` (wallet connect), and `activeChains` (the chains with working RPC endpoints for this instance). Backend endpoints for unconfigured integrations degrade to no-ops rather than erroring — with the exception of captcha, which stays fail-closed via the built-in ALTCHA default (no external service needed).

---

## Appendix: nginx Routing Summary

Based on `docker/nginx/nginx_dev.conf` and `docker/nginx/nginx_selfhost.conf`, request routing:

| URL Pattern | Destination | Notes |
|-------------|-------------|-------|
| `/api/bot/v1/...` | `http://api:4000` | Public bot protocol; rewritten to `/BotV1/...` |
| `/api/v2/{Router}/...` | `http://api:4000` | REST API; prefix stripped. Router whitelist: `Chat\|Community\|File\|Message\|User\|Contract\|Notification\|Twitter\|Lukso\|CgId\|Accounts\|Plugins\|Search\|Report\|Bot\|Staking` |
| `/api/ws/` | `http://wsapi:4000` | Socket.IO (WebSocket upgrade) |
| `/files/{id}/{sig}/{date}/{expires}` | `http://s3.local:8333` | Direct S3 proxy (rewritten to a signed S3 URL) |
| `/c/`, `/u/`, `/gated-videos/`, `/gated-files/` | `http://api:4000` | Social previews / gated content (SSR + instance-config injection) |
| `/sitemap.xml`, `/twitter-callback`, `/twitter-login`, `/verify-email`, `/push-icon`, `/token-sale`, `/token`, `/store` | `http://api:4000` | Server-rendered pages |
| `/fonts/`, `/icons/`, `/images/`, `/static/`, `/audio/`, `/downloads/` | Local filesystem `/www` | Static assets |
| `/index.html`, `/service-worker.js`, `/e/*` | Local filesystem `/www` | SPA entry point (fallback to index.html) |
| `/index_cgid.html` | Local filesystem `/www` | CG ID subdomain entry point |
| `/community/{10-char}` | 301 redirect | Legacy community URLs rewritten to `/c/{url}/` |
| `/enable-cross-origin-security`, `/disable-cross-origin-security` | Local filesystem `/www` | COOP/COEP toggling entry points |
| Everything else | Local filesystem `/www` | Static files, 404 if not found |

In the self-host config the same routes are used, but every proxied `location` resolves its upstream dynamically through Docker DNS (`resolver 127.0.0.11 valid=10s ipv6=off`) rather than binding the upstream at config-load time.
