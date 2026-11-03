# Real-time & WebRTC Documentation

> Status: verified against commit 91efa7c82, 2026-08-04; call-server
> connection handling (startup, ended-call check, authentication flow) against
> commit e44dac1, 2026-10-31; Redis/Valkey instances, clients, key prefixes and
> outage behaviour against commit ff0da06, 2026-10-31; the `MEDIASOUP_TRUST_PROXY`
> note (Caddy in front of 4443 in dev too) against commit fe3937f, 2026-10-31;
> the browser-socket session room (cookie optional), `watchCgIdRequest` and `sess-revoked:`
> against commit eab2a27, 2026-11-01; `sess-user:`, the session TTLs and the signed-out devices'
> `cliSignedOut` + disconnect against commit 23a4c1e, 2026-11-01; room close hardening and
> the call-ending safety net (Room Lifecycle, Call Flow) against commit 591e6cf, 2026-11-02;
> human online status (grace period, batched cluster-wide offline check with one retry, touch
> sets, change-only events, the stale job's events) against commit fc15832, 2026-11-02;
> the chat-sync fields of `cliMessageEvent` and `cliChannelLastRead` against commit 30ce83e,
> 2026-11-02; the page side of the tab/socket model (Socket.IO Client, Tab Coordination: one
> socket per tab, live signal, hidden-tab policy, login lock and post-reconnect snapshot)
> against commit 964f6b3, 2026-11-02; the service worker's part in tab coordination (no
> referee, one-release compat answer) against commit 79187d2, 2026-11-02; the notification
> routes and the `cliNotificationEvent` count fields against commit 3f204f4, 2026-11-02;
> socket-scoped targeting (`deviceSocket:` room, echo exclusion, article rooms, logout),
> call chat / `cliCallEvent new` delivery against commit ce09d8a, 2026-11-02; the logout
> without a header, per-socket article limit, second socket login, the never-rejecting message
> emit and the deploy-mix notes against commits 1b09f87 and f97ef1b, 2026-11-02; Tab
> Coordination after the chat-sync removal (why independent tabs, catch-up after a
> (re)connect, logout across tabs, the compat markers; no `tabState`/`lastDisconnect` any
> more) against commit 1e6a0d4, 2026-11-03; the end of the socket login (`finishSocketLogin`) against
> commit 043641d, 2026-11-03; the logout marker across tabs against commit 9d00729, 2026-11-03;
> who may join a call's room (`hasPermissionToJoinCall`, Public role) against commit 2484880, 2026-11-03

This document covers all real-time communication in Common Ground: the Socket.IO event layer, WebRTC media via MediaSoup, signaling via protoo, push notifications, and the Redis infrastructure tying it together.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Socket.IO Layer](#socketio-layer)
3. [Bot Socket Connections](#bot-socket-connections)
4. [WebRTC / MediaSoup](#webrtc--mediasoup)
5. [Signaling (protoo)](#signaling-protoo)
6. [Frontend Real-time](#frontend-real-time)
7. [Call System](#call-system)
8. [Push Notifications](#push-notifications)
9. [Redis Pub/Sub & Data](#redis-pubsub--data)

---

## Architecture Overview

Common Ground uses two entirely separate WebSocket systems for different purposes:

1. **Socket.IO** (`srv/wsapi.ts`) -- General-purpose real-time event delivery (chat messages, presence, community updates, notification events). Runs on port **4000**. Uses the `@socket.io/redis-adapter` so that multiple server instances can broadcast to any connected client.

2. **protoo + MediaSoup** (`srv/mediasoup.ts`, `srv/mediasoup/room.ts`) -- WebRTC signaling and SFU media server for voice/video calls. Runs on port **4443** (HTTPS/WSS). Each call server is a standalone process; there is no cross-instance media routing.

The two systems are deployed as separate services (separate Docker containers / processes). They share a PostgreSQL database for call state and user data.

```
Browser
  |
  |--- Socket.IO (wss://.../api/ws/)  --> srv/wsapi.ts  (port 4000)
  |       Uses Redis adapter for multi-instance broadcast
  |
  |--- protoo WebSocket (wss://callserver:4443/) --> srv/mediasoup.ts (port 4443)
          MediaSoup SFU for audio/video
```

---

## Socket.IO Layer

**Source:** `srv/wsapi.ts`

### Server Setup

The Socket.IO server is created with typed events (`API.Server.ServerToClientEvents`, `API.Server.ClientToServerEvents`, etc.):

```typescript
const io = new Server<...>({
  transports: ["polling", "websocket"],
  cors: corsOptions,
  path: "/api/ws/",
  pingInterval: 15000,
  pingTimeout: 15000,
  perMessageDeflate: false,
});
```

It listens on **port 4000**.

**CORS:** Allows requests from `BASE_URL` (and several localhost/dev origins when `DEPLOYMENT === 'dev'`). Requests with no `Origin` header are allowed (for mobile apps and non-browser clients).

### Connection Authentication

There are **two mutually exclusive connection paths**, distinguished at handshake time:

1. **Browser / device clients** (cookie-based). No `handshake.auth.token` is provided. On connection, the server parses the session cookie (`SESSION_COOKIE_NAME`, default `connect.sid`) via signed-cookie parsing to extract the Express session ID and joins the `expressSession:{sessionId}` room. Without a validly signed session cookie the socket stays connected and joins no session room — anonymous visitors have no session until something is stored in one. These sockets stay unauthenticated until they complete the `login` event flow (device-signature challenge, see below).

2. **Bot clients** (token-based). A Socket.IO middleware (`io.use`) inspects `handshake.auth.token`. If a token is present it must be a non-empty string **and no cookie header may be set**; the middleware also requires `handshake.auth.protocolVersion === BOT_PROTOCOL_VERSION` (`"1"`). The token is verified by `botTokenHelper.authenticate`; on success the socket is joined to its user/device/role/community rooms plus a `botToken:{tokenId}` room during the handshake, before `connection` fires. See [Bot Socket Connections](#bot-socket-connections). If the token is absent, the middleware falls through to the cookie path.

### Redis Adapter

Multi-instance broadcasting is enabled via `@socket.io/redis-adapter`:

```typescript
io.adapter(createAdapter(
  redisManager.getClient('socketIOPub'),
  redisManager.getClient('socketIOSub'),
  { key: 'v2:' }
));
```

This uses a dedicated publisher/subscriber connection pair on the state instance (`redis:6379`, Valkey). The key prefix `v2:` namespaces all adapter messages. Any event emitted to a room on one server instance is automatically delivered to clients connected to other instances via Redis pub/sub.

### Namespaces

The server uses a **single default namespace** (`/`). There are no custom namespaces.

### Rooms

Sockets are organized into rooms based on identity and membership. Room key functions are defined in `srv/util/index.ts`:

| Room Key Function | Format | Purpose |
|---|---|---|
| `userRoomKey(userId)` | `user:{userId}` | Target a specific user (all their devices/tabs) |
| `communityRoomKey(communityId)` | `community:{communityId}` | Broadcast to all members of a community |
| `roleRoomKey(roleId)` | `role:{roleId}` | Target users with a specific role |
| `deviceRoomKey(deviceId)` | `device:{deviceId}` | Target a specific device |
| `expressSessionRoomKey(sessionId)` | `expressSession:{sessionId}` | Target a specific browser session (only the legacy CG ID result still uses it, for clients that predate `watchCgIdRequest`) |
| `cgIdRequestRoomKey(frontendRequestId)` | `cgIdRequest:{frontendRequestId}` | Legacy CG ID: the socket that watches a CG ID popup request (`watchCgIdRequest`) |
| `articleRoomKey(articleId)` | `article:{articleId}` | Target viewers of a specific article |
| `botTokenRoomKey(tokenId)` | `botToken:{tokenId}` | Target all sockets authenticated with a specific bot token |
| `deviceSocketRoomKey(deviceId, socketId)` (`srv/util/requestSocket.ts`) | `deviceSocket:{deviceId}:{socketId}` | One logged-in socket of a device: what [socket-scoped targeting](#socket-scoped-targeting) addresses |

For browser clients with a session cookie, the socket immediately joins its `expressSession:{sessionId}` room on connection. On `login`, it joins `user:`, `device:`, `deviceSocket:{deviceId}:{socket.id}`, all `role:`, and all `community:` rooms for that user (via `joinAuthenticatedRooms`). For bot clients the same room set (minus `expressSession:`, plus `botToken:`) is joined inside the handshake middleware, before the `connection` event.

### Client-to-Server Events

| Event | Data | Callback | Description |
|---|---|---|---|
| `getSignableSecret` | none | `(secret: string)` | Server generates a cryptographically random hex string, stores it on `socket.data.signableSecret`, returns it to the client for device authentication |
| `cgPing` | none | `(timestamp: number)` | Returns `Date.now()` for client-side latency/clock-drift detection |
| `login` | `{ deviceId, secret, base64Signature }` | `("OK" \| "ERROR")` | Authenticates the socket. Verifies the device signature against the signable secret. A socket already logged in as another device or user first leaves every room of that login (as on `logout`). On success, joins user/device/`deviceSocket:`/role/community rooms and sets user online status |
| `logout` | none | none | Leaves all rooms except the temporary community visitor room. Sets user offline if this was the last socket |
| `joinCommunityVisitorRoom` | `{ communityId }` | none | Joins the community room temporarily so a non-member viewing a public community receives its live events. Validated with Joi. Leaves the previous visitor room first (unless the user is a member of it) |
| `watchCgIdRequest` | `{ frontendRequestId }` | none | Legacy CG ID: joins `cgIdRequest:{frontendRequestId}` so the popup's result (`cliCgIdSignResponse`) reaches this socket; one request per socket (the previous one is left). Validated with Joi. The client re-sends it after a reconnect |
| `leaveCommunityVisitorRoom` | none | none | Leaves the temporary community visitor room (only if the user is not a member) |
| `prepareWalletRequest` | none | `(requestId: string)` | Generates a random wallet request ID for Web3 auth flows |

### Server-to-Client Events

| Event | Data | Description |
|---|---|---|
| `buildId` | `(backendBuildId: string, timestamp: number)` | Sent immediately on connection. Client compares build IDs to detect app updates |
| `cli*` (any event starting with "cli") | varies | All application events (messages, notifications, call updates, etc.) are prefixed with `cli` and dispatched through the `onAny` handler on the client |

#### Message and read-state events (chat-sync fields)

Types in `src/common/types/events/{message,channel}.d.ts`; emitted from `srv/api/messages.ts`.
All fields below are additive; clients that do not know them ignore them.

| Event | Sync fields |
|---|---|
| `cliMessageEvent` `new` | the full `ApiMessage` incl. `syncSeq` (the channel change sequence of the row, see [docs/database](../database/README.md#message-sync-sequence)) |
| `cliMessageEvent` `update` | `syncSeq` of the write; an edit also carries `editedAt`; reactions carry it in both the room copy and the reacting user's `ownReaction` copy; replies of a deleted parent (`parentMessageId: null`) carry their own |
| `cliMessageEvent` `delete` | `syncSeq` = highest seq of the deleted rows, `syncSeqs` = the seq of every deleted row (a multi-row delete bumps the sequence once per row). Sent only when a row was deleted |
| `cliChannelLastRead` | `lastRead` (stored, max-merged), `unread` (other users' messages after it, capped at 999), `syncSeq` (the channel seq that count is valid at), and `communityId` (community channels) or `chatId` (DMs); to the user's own room |

A client that misses events (disconnect, reload, frozen tab) catches up per channel with
`POST /Message/getChanges` from its last contiguous `syncSeq` (see
[docs/backend](../backend/README.md#srvapimessagests----messaging-routes)). Seq bumps
without an event exist (a same-id create in another channel losing a race: its `ON CONFLICT DO NOTHING` insert), so a gap in
the received seqs is a hint to call `getChanges`, not proof of a lost event.

### Event Emission (Server-Side)

The `EventHelper` class (`srv/repositories/event.ts`) is the primary mechanism for emitting events from the API server to connected clients. It uses `@socket.io/redis-emitter` to emit events without needing a direct Socket.IO server reference -- allowing any backend process (API, job workers) to send events:

```typescript
class EventHelper {
  // created on first use, so importing the module opens no connection
  get #io() { /* new Emitter(redisManager.getClient('socketIOPub'), { key: 'v2:' }) */ }

  async emit(event, target, except?) { ... }
  async userJoinRooms(userId, target) { ... }
  async userLeaveRooms(userId, target) { ... }
}
```

The `emit` method takes an event and a target specifying which rooms to broadcast to (by userIds, roleIds, communityIds, deviceIds, sessionIds, articleIds), with optional exclusions (the same lists plus `deviceSockets`, see below). The event's `type` field becomes the Socket.IO event name; the rest is the payload. One emit to several rooms reaches every socket once, however many of the rooms it is in.

### Socket-scoped targeting

New clients send the id of the tab's socket.io socket in every HTTP request, header
`x-cg-socket-id` (`SOCKET_ID_HEADER` in `src/data/appstate/transport.ts`; a tab without a socket
sends a random id of the same format). The server reads it with `getRequestSocketId()`
(`srv/util/requestSocket.ts`): only a single value matching `^[A-Za-z0-9_-]{20}$` counts, and bot
requests never use it (the Bot API keeps the per-device behaviour). The header name is fixed (the
cg.box gateway allows it by name).

The header never selects a socket on its own. Every socket-scoped operation addresses the room
`deviceSocket:{deviceId}:{socketId}`, built from the **session's** device and the header; wsapi
joins that room at socket login with the device the socket proved, and the socket leaves it with
its other authenticated rooms on socket `logout` or disconnect (and before a second socket `login`
as another device or user, which first leaves every room of the previous login). An id of another
device's socket, an unknown id or the id of a socket that is not logged in therefore names an empty
room: nothing is excluded, nothing joins or leaves. No lookup per request; cluster-wide because
rooms live in the adapter.

During a deploy, sockets logged in on a wsapi process older than this change are not in their
`deviceSocket:` room until they reconnect and log in again. For those tabs: they get their own
events back (the chat-sync client store merges by message id and `syncSeq`); an article join
joins nothing and a leave leaves nothing (no live article comments until the reconnect; the
catch-up covers them); and a logout cannot tell the requesting socket from the others, so all
of the device's sockets get `cliSignedOut` and are disconnected — the requesting tab ignores
the event because its own logout is in flight (`LoginManager.signedOutElsewhere`). The same
holds for a tab whose header carries its fallback id (no socket, or a stale one).

| Site | With a valid header | Without one (old clients) |
|---|---|---|
| Echo of the request's own event: `createMessage`, `createModerationMessage`, `editMessage` (`srv/api/messages.ts`), `startChat`, `closeChat` (`srv/api/chats.ts`), `joinCommunity`, `createCommunity`, `setChannelPinState` (`srv/api/community.ts`) | `except: { deviceSockets: [{deviceId, socketId}] }` — only the sending socket misses it; the sender's other tabs get it live | `except: { deviceIds: [deviceId] }` — the whole device |
| `/Message/joinArticleEventRoom`, `/leaveArticleEventRoom` | `eventHelper.requestSocketsJoinRooms/LeaveRooms` on the requesting socket only, so closing an article in one tab keeps the other tab in the room. Tracked in the session as `socketArticleRooms` (`{articleId, socketId}`): at most 5 per socket (a sixth join leaves that socket's oldest room; other tabs keep theirs) and at most 50 per session (the oldest entries, mostly of closed tabs, are left first). Both are soft bounds: concurrent requests of one session save the session last-write-wins, so an entry can get lost while its socket stays in the room until it disconnects | the device's sockets, tracked in `temporaryArticleIds` (at most 5) |
| `/User/logout` (logout disconnects the device's sockets: `eventHelper.logoutDeviceSockets`) | `cliSignedOut` to the device's other sockets, then `disconnectSockets(false)` on them; the requesting socket is left out (its tab sends the socket `logout` itself) | `disconnectSockets(false)` on all of the device's sockets, no `cliSignedOut` (an old client would show it as a sign-out from elsewhere) |

Reactions keep excluding the whole user and re-sending the `ownReaction` copy to the user room,
unchanged.

### Online Status & Heartbeat

Human presence is one column per user (`users.onlineStatus` + `onlineStatusUpdatedAt`). The decisions live in `PresenceTracker` (`srv/util/presence.ts`, specs `srv/tests/presence.spec.ts`); wsapi passes it the socket lookups and the repository writes.

- On `login` the user is tracked by the process (`socketAuthenticated`, before the rooms are joined; a pending offline is cancelled) and `userHelper.touchUserOnlineStatus([userId], { emitOwnData: true })` runs: it flips only `offline` to `online` and refreshes `onlineStatusUpdatedAt` otherwise, so a status other than online/offline is never overwritten by a login. If the socket disconnected while the login was in flight (its disconnect handler may have run before the user id was set), the login releases the presence itself (`socketGone`, and leaves any room the join still added) instead of acknowledging — also when the device key turned out to be revoked meanwhile (`srv/util/socketLogin.ts`, `srv/tests/socketLogin.spec.ts`). A connected socket with a revoked key gets `ERROR` and is disconnected; its disconnect handler releases the presence. socket.io 4.8 leaves every room at a disconnect and makes a later `join` a no-op (checked by the spec).
- On disconnect/socket `logout`, if no other socket of the user remains on this process (`io.sockets.adapter.rooms.get(userRoomKey(userId))?.size` is falsy), a **grace period** of `PRESENCE_OFFLINE_GRACE_MS` (30 s) starts. A login on this process within it cancels the offline. Short disconnect/reconnect cycles (hidden tabs, network loss, reloads) therefore do not change the status. Bot sockets are excluded from this path and handled via the bot-presence mechanism instead (see below).
- When grace periods expire, the decisions due within `PRESENCE_DECISION_BATCH_MS` (500 ms) of each other are taken together (a proxy reload drops many sockets at once): one cluster lookup and one `userHelper.setUsersOffline(userIds)` UPDATE. The lookup is a `presenceProbe` server-side emit with acknowledgement through the Redis adapter (`io.serverSideEmitWithAck`): every other wsapi process answers with the subset of the user ids it holds a logged-in socket for, so only ids travel (no handshake or socket data as with `fetchSockets`). Users found elsewhere get no write — the other process keeps them. If a process does not answer within the adapter's `requestsTimeout` (5 s), the answers received still count and the remaining users are decided once more after `PRESENCE_RETRY_DELAY_MS` (10 s), staying tracked meanwhile; if the second lookup is incomplete too, they go offline. A process that does not know `presenceProbe` (an older build during a rolling deploy) counts as not answering. A login on this process that lands during the lookup or the write is detected (login sequence per user) and wins; a login on another process that races the offline write is not detected, and that process's next touch restores `online` within 60 s.
- Events go out only on a real change: the UPDATEs return a row only when the status changed, and only then are `cliUserData` (to all the user's communities and the user) and, for `online`, `cliUserOwnData { onlineStatus }` (to the user) emitted. Each change also fires `pg_notify('userdatachange')` for `memberlist` (users trigger).
- A 60-second interval refreshes every human user the process tracks (`touchSets()`): users with a logged-in socket here get `touchUserOnlineStatus(userIds, { emitOwnData: true })`, which also flips them back online if something set them offline; users in their grace period or waiting for the retry only get `refreshOnlineStatusTimestamps` (timestamp, never a status flip), so an offline decided by another process is not undone. It also re-syncs bot presence for all locally connected bot users.
- The `onlineStatusCheck` job (every 30 s) sets users offline whose status has not been refreshed for 90 s (`setStaleUsersOffline`, `srv/repositories/userPresence.ts`) and emits `cliUserData { onlineStatus: 'offline' }` for each of them, so other clients see it too. It is the fallback for a crashed process and a decision lost on shutdown. (A frozen client is not one of its cases: while the server still holds its socket the user is touched every 60 s, and once the ping timeout drops the socket the normal grace path decides.) Because grace users are refreshed, it never fires before a grace decision.
- On graceful shutdown (`SIGTERM`, plus `unhandledRejection` / `uncaughtException`), pending grace decisions are dropped and human users are **not** set offline: their clients reconnect (to another process, or to this one after a restart) and the login refreshes them; users who do not come back go offline through the stale job. All bot users have their presence cleared, and every socket is disconnected before `io.close()` and `process.exit`.
- `/User/setOwnStatus` stores a status in Redis (`ud:{userId}`, see `UserDataManager` below), which nothing reads; the `away`/`dnd`/`invisible` values of `users.onlineStatus` have no writer.

### Tab Coordination

Every browser tab owns its own Socket.IO connection and login state (`src/data/appstate/webSocket.ts`); there are no tab roles and the page does not talk to the service worker about sockets. A visible tab is always connected, a hidden tab closes its socket after 5 minutes unless it is in a call. Each tab's socket logs in with the device key, so one user has one socket per open, non-idle tab (browsers allow 200–255 connections per host; each socket login costs the server a handful of queries). A tab that missed events catches up over HTTP (`Message/getSyncState`, `Message/getChanges`, see [Message and read-state events](#message-and-read-state-events-chat-sync-fields)); presence counts users, not sockets, and its grace period keeps reconnecting tabs from flapping the status. See [Frontend Real-time → Tab Coordination](#tab-coordination-1).

---

## Bot Socket Connections

**Source:** `srv/wsapi.ts`, `srv/repositories/botTokens.ts`, `srv/repositories/bots.ts`, `srv/repositories/event.ts`, `srv/common/botProtocol.ts`

Bots connect to the same Socket.IO server as browser clients but authenticate with a bearer token instead of a session cookie, and use a distinct lifecycle.

### Authentication

A single Socket.IO middleware (`io.use`) runs on every handshake:

- If `handshake.auth.token` is `undefined`, the middleware calls `next()` and the connection continues down the normal cookie path.
- Otherwise the token must be a non-empty string **and** the request must carry **no** cookie header; violating either rejects the handshake with `Error('unauthorized')`.
- `handshake.auth.protocolVersion` must equal `BOT_PROTOCOL_VERSION` (`"1"`, from `srv/common/botProtocol.ts`), else the handshake is rejected with `unsupported_bot_protocol`.
- The token is verified by `botTokenHelper.authenticate(token)`, which resolves to a principal (`{ user, tokenId }`) or `null`. `null` rejects with `unauthorized`.
- On success, `botHelper.getActiveSocketRoomIds(userId, tokenId)` computes the community and role rooms the bot is currently entitled to, and `joinAuthenticatedRooms` joins `device:`, `user:`, `role:*`, `community:*` and `botToken:{tokenId}`. `socket.data.botTokenId` and `socket.data.botProtocolVersion` are set.

Because room membership is established during the handshake, a bot socket is fully authenticated by the time the `connection` event fires — there is no post-connection `login` handshake for bots.

### Connection Lifecycle & Events

Inside the `connection` handler, sockets with `socket.data.botTokenId` set take a dedicated branch:

- Only the `cgPing` event is registered (echoes `Date.now()`); the human-only events (`getSignableSecret`, `login`, `logout`, `joinCommunityVisitorRoom`, `leaveCommunityVisitorRoom`, `prepareWalletRequest`) are **not** wired up for bots.
- Bots still receive all room-targeted server-to-client `cli*` events for the rooms they joined (community, role, user), giving them a read stream of the same real-time events a member would see.
- The userId is added to a process-local `localOnlineBotUsers` set.

### Presence

Bot presence is tracked separately from human online status, because a bot may hold multiple sockets spread across server instances.

- `syncBotConnectionPresence(userId)` counts the bot's sockets on the local instance (from the `user:{userId}` room) and calls `setBotConnectionPresence`.
- `setBotConnectionPresence` runs a Redis Lua script (`BOT_PRESENCE_SCRIPT`) on the `data` client against `bot-presence:{userId}:counts` (per-instance socket counts) and `bot-presence:{userId}:expirations` (a sorted set of instance leases). Each write refreshes this instance's lease (`BOT_PRESENCE_LEASE_MS = 90s`), sweeps expired instance entries, and returns the cluster-wide total socket count.
- If the total is `> 0`, `userHelper.touchUserOnlineStatus` and `botHelper.setConnectionPresence(userId, count, markConnectedAt)` are written (updating the `bots.connectedSocketCount` / `lastConnectedAt` columns). If it drops to `0`, presence is cleared and the user is set offline. Ordering of the two writes is deliberate so the stale-presence worker cannot reset a freshly connected bot.
- The 60-second keepalive interval re-runs `syncBotConnectionPresence` for every locally connected bot user.

### Forced Disconnect on Revocation

`eventHelper.disconnectBotTokenSockets(tokenId)` (`srv/repositories/event.ts`) calls `io.in(botToken:{tokenId}).disconnectSockets(true)` across all instances via the Redis adapter. It is invoked when a token is revoked (`botTokenHelper`), and when a bot is uninstalled or banned (`botHelper`), so live sockets for an invalidated token are torn down immediately rather than lingering until their next request.

Browser sockets of devices that were signed out from elsewhere (another device's "Sign out other devices", or a replaced password, email or removed sign-in method, [auth-identity §2](../auth-identity/README.md#signing-out-other-devices)) are handled the same way: `eventHelper.signOutDeviceSockets(deviceIds)` emits `cliSignedOut` to their `device:{deviceId}` rooms and then calls `disconnectSockets(false)` on them, through the same publisher in this order. A logout in one tab does the same for the device's other sockets (`logoutDeviceSockets`, see [Socket-scoped targeting](#socket-scoped-targeting)). The client signs out locally on the event; a socket that reconnects cannot log in again, its device key is gone. The socket `login` verifies the key with the same lookup as the HTTP device login, which rejects a key below the account's session generation, and after joining its rooms checks once more that its key is still valid (one DB read) and disconnects if it is not — a key that became invalid between the check and the joining.

---

## WebRTC / MediaSoup

**Source:** `srv/mediasoup.ts`, `srv/mediasoup/room.ts`, `srv/mediasoup/config.ts`

### Architecture

Common Ground uses **MediaSoup** as an SFU (Selective Forwarding Unit). The media server (`srv/mediasoup.ts`) is a standalone HTTPS process separate from the main API server. Multiple call servers can exist, each registered in the `callservers` database table.

The media server is **optional at deploy time**. In the self-host profile it sits behind the Compose profile `calls` (`CG_ENABLE_CALLS=false` leaves it out — see [docs/deployment §3.8](../deployment/README.md#38-optional-services-calls-and-blockchain)). Without it, no `callservers` row is fresh, so `getCallServerForScheduling` rejects with `SERVICE_UNAVAILABLE`; the instance config then ships `features.calls: false`, and the frontend hides every call entry point: the sidebar (`CallList`, `StartCallButton`) *and* the event path (`ScheduleEventModal` offers only `external` events, `AttendEventButton` drops its "Start Event"/"Join now" actions). `api`, `wsapi` and the job runner are otherwise unaffected — nothing in them talks to the media server directly (the coupling is the `callservers` / `calls` / `callmembers` tables plus `pg_notify`).

### Startup Sequence

1. `runExpressApp()` -- Creates the Express app the HTTPS server is built on. It serves no routes of its own; the server exists for the protoo WebSocket upgrade.
2. `runWebServer()` -- Creates an HTTPS server using TLS certificates (configured via `HTTPS_CERT_FULLCHAIN` / `HTTPS_CERT_PRIVKEY` env vars). Listens on port **4443** by default.
3. `runProtooWebSocketServer()` -- Creates a protoo WebSocket server on top of the HTTPS server for signaling. Max received frame/message size is 960 KB.
4. `runMediasoupWorkers()` -- Spawns MediaSoup workers (one per CPU core). Each worker optionally creates a `WebRtcServer` for multiplexing transports on a single port (controlled by `MEDIASOUP_USE_WEBRTC_SERVER` env var; enabled by default).
5. `updateServerStatus()` -- Periodically updates the `callservers` table with ongoing call count and network traffic stats.
6. `registerCallUpdateListener()` -- Listens for PostgreSQL `NOTIFY` events for live call config updates (slots, audio-only, etc.).

### MediaSoup Configuration

Defined in `srv/mediasoup/config.ts`:

- **Workers:** One per CPU core (`os.cpus().length`). mediasoup ≥ 3.16 removed the `disableLiburing` worker setting (it now relies on libuv's built-in io_uring), and `srv/mediasoup/config.ts` no longer defines it. `MEDIASOUP_DISABLE_LIBURING=true` survives only as a compatibility shim in `srv/mediasoup.ts` (~:204-210), which translates it into `process.env.UV_USE_IO_URING = '0'` — inherited by the spawned worker processes — unless `UV_USE_IO_URING` is already set explicitly.
- **RTC Port Range:** `MEDIASOUP_MIN_PORT` to `MEDIASOUP_MAX_PORT` (default 40000-40099)
- **Media Codecs:**
  - `audio/opus` (48kHz, stereo)
  - `video/VP8` (start bitrate 1000 kbps)
  - `video/VP9` (profile-id 2, start bitrate 1000 kbps)
  - `video/h264` (packetization-mode 1, profile-level-id 4d0032)
- **WebRtcServer listen:** UDP + TCP on port 40000 (incremented per worker)
- **Transport options:** `initialAvailableOutgoingBitrate: 1000000` (1 Mbps default; overridden to 10 Mbps for high-quality calls), `maxSctpMessageSize: 262144`
- **WebRtcServer listen IPs:** Configurable via `MEDIASOUP_LISTEN_IP` (default `0.0.0.0`) and `MEDIASOUP_ANNOUNCED_IP` env vars

### Room Lifecycle

The `Room` class (`srv/mediasoup/room.ts`) wraps a protoo Room and a MediaSoup Router:

1. **Creation** (`Room.create`): Allocates a MediaSoup Router (with media codecs), an `AudioLevelObserver` (threshold -50dB, interval 500ms), and an `ActiveSpeakerObserver` (interval 2500ms).
2. **Worker assignment**: Workers are assigned round-robin via `getMediasoupWorker()`.
3. **Room map**: Active rooms are stored in `rooms: Map<string, Room>`.
4. **Close**: When the last peer leaves or all broadcasters leave (in broadcast mode), the room closes. On close, it emits either `'close'` (soft -- call the `softEndCall`) or `'forceClose'` (moderator-initiated -- calls `endCallForEveryone`). The peer `close` handler guards each of its steps (leaving the membership, updating `previewUserIds`, the notifications to the remaining peers, closing transports) separately, so a database error or a notification to a peer that disconnects at the same moment does not skip the last-peer / last-broadcaster check; `Room.close()` emits its event even if closing the protoo Room or the Router throws. A failed `softEndCall` / `endCallForEveryone` is retried after 1, 5 and 15 s. Calls whose room still went away without ending them are ended by the jobs process (`callUpdateEmitter`, docs/backend §6).

### Transports

Each peer gets up to two WebRTC transports:

1. **Send transport** (`producing: true, consuming: false`) -- For uploading audio/video.
2. **Receive transport** (`producing: false, consuming: true`) -- For downloading other peers' media.

Transports are created via the `createWebRtcTransport` protoo request. They use the `WebRtcServer` for port multiplexing. For high-quality calls, `initialAvailableOutgoingBitrate` is set to 10M.

### Producers

A Producer represents a media track (audio or video) being sent by a peer to the server. When a peer produces:

1. The `produce` protoo request creates a server-side Producer on the peer's send transport.
2. The Producer is added to the `AudioLevelObserver` and `ActiveSpeakerObserver` (if audio).
3. Consumers are automatically created for all other joined peers.

In broadcast mode, only peers in the `_broadcasters` map are allowed to produce.

### Consumers

A Consumer represents a media track being forwarded from one peer to another:

1. Created server-side in **paused** mode.
2. A `newConsumer` protoo request is sent to the receiving peer with RTP parameters.
3. On acknowledgment, the Consumer is resumed, sending the first key frame.
4. Consumer events (`transportclose`, `producerclose`, `producerpause`, `producerresume`, `score`, `layerschange`) trigger corresponding protoo notifications.

### Active Speaker Detection

Two observers run per room:

- **AudioLevelObserver**: Fires `volumes` events every 500ms with the loudest producer. All peers receive `activeSpeaker` notifications with peerId and volume.
- **ActiveSpeakerObserver**: Fires `dominantspeaker` events every 2500ms. All peers receive `dominantSpeaker` notifications.

### Server Status Reporting

The call server periodically reports to the database:

- **Traffic monitoring**: Reads `/proc/net/dev` every `CALLSERVER_UPDATE_TRAFFIC_INTERVAL` to compute bytes sent/received.
- **Status upsert**: Every `CALLSERVER_UPDATE_DATA_INTERVAL`, updates the `callservers` row with `{ ongoingCalls, traffic }`.

### Call Config Live Updates

The call server listens for PostgreSQL `NOTIFY` on a per-server channel (`callservercallupdate_{serverId}`). When call parameters change (slots, stageSlots, audioOnly, highQuality), the Room's `handleCallUpdate` method notifies all peers via a `callUpdate` protoo notification.

A PostgreSQL keepalive query (`SELECT 1`) runs every 60 seconds on the LISTEN connection. If it fails, the process exits immediately to force a restart.

### Ended Call Protection

`getOrCreateRoom` reads `callHelper.getCallState(roomId)` once, before any Room is created, and rejects the connection if the call does not exist, `endedAt` is set, or the user is neither the call creator nor allowed to join (`callHelper.hasPermissionToJoinCall`, the same rule as the `join` request: the call has not ended, its community is not deleted, and `CALL_JOIN` on the call is granted to one of the user's claimed roles or to the predefined Public role of the call's community — a call open to the Public role can be joined by every logged-in user who sees it through that role, members or not, except users banned from the community); the same row provides the room parameters (call type, creator, slots, stage slots, audio-only, high quality). This prevents joining calls that have already ended in the database. If the connection that caused a Room's creation is gone before it is attached, the Room is closed again (`closeIfEmpty`). Room creation and joining are serialized per `roomId` (one `AwaitQueue` per room).

---

## Signaling (protoo)

**Source:** `srv/mediasoup/room.ts` (server), `src/util/RoomClient.tsx` (client)

protoo is used for all WebRTC signaling between the browser and the MediaSoup server. It provides a request/response and notification protocol over WebSocket.

### Connection URL

```
wss://{callServerUrl}:4443/?roomId={callId}&peerId={userId}&consumerReplicas=0&callCreator={creatorId}&callType={callType}
```

Built by `src/util/urlFactory.ts`. `consumerReplicas` is a debugging aid inherited from the mediasoup demo (it multiplies the consumers created per producer and is fixed room-wide by whoever connects first); the server clamps it to **[0, 4]**, with `NaN` or negative values falling back to `0` (`srv/mediasoup.ts` ~:333-343).

### Authentication Flow

`roomId` and `peerId` must be UUIDs, otherwise the WebSocket upgrade is refused (400). A new connection then goes through a login phase (`srv/mediasoup/connectionGate.ts`) **before** it is attached to a room — until it has logged in it creates no Room/Router, holds no slot and does not touch an existing peer with the same id:

1. Client sends `getSignableSecret` request -> server returns a cryptographically random hex string.
2. Client signs the secret using its device private key (`signApiSecret`).
3. Client sends `login` request with `{ deviceId, secret, base64Signature }` (validated against `validators.API.Socket.login`; one attempt per secret).
4. Server verifies the device signature and checks that `peerId === userId`. On failure it answers `"ERROR"` and closes the connection.
5. On success the server reads the call state, gets or creates the Room and attaches the connection as an authenticated peer; only then does it answer the `login` request with `"OK"`. If joining the room fails it answers with an error response whose reason is one of `CALL_LIMIT_EXCEEDED`, `NOT_ALLOWED`, `NOT_FOUND` (no ongoing call) or `UNKNOWN`, and closes. If the user already had a peer in that room (reconnect, second tab), the previous connection is closed and replaced.

Limits of the login phase:

- 5 s to complete it;
- at most 8 messages of any kind (including binary or unparsable frames) and at most 4096 characters per message before login; any method other than `getSignableSecret`/`login` is answered with `LOGIN_REQUIRED`;
- at most 500 connections in the login phase in total and 10 per source, where a source is an IPv4 address or an IPv6 /64; beyond that the upgrade is refused with 429. The source is the socket address, or, with `MEDIASOUP_TRUST_PROXY=true`, the last `X-Forwarded-For` entry (the one the proxy added). Only set that flag when 4443 is reachable through the proxy alone: the self-host and dev stacks set it (Caddy terminates TLS on 4443 in front of mediasoup, which publishes no signalling port of its own); the conformance stack, which publishes mediasoup's 4443 directly, sets it to `false`.

The room's call type (default/broadcast), creator, slots and flags are taken from the stored call (`calls` row); the `callType` and `callCreator` query parameters are not used by the server.

### Protoo Requests (Client -> Server)

**Every protoo request that carries data is Joi-validated** since the mediasoup hardening of 2026-08-03. `srv/mediasoup/room.ts` validates the request's `data` before touching it: 18 call sites against `validators.API.Mediasoup.*` (`srv/validators/api/mediasoup.ts`), plus `login` against the shared `validators.API.Socket.login`. The three data-less methods (`getSignableSecret`, `getRouterRtpCapabilities`, `endCallForEveryone`) need none.

The schemas are `.strict(true)` (no type coercion — `"1"` is not accepted where a number is expected) and, being plain Joi objects, **reject unknown keys**; only the opaque mediasoup protocol objects (`rtpParameters`, `dtlsParameters`, `device`, `appData`, …) are `.unknown(true)` and are not validated structurally — their only size bound is the 960 KB protoo frame limit (`maxReceivedFrameSize`/`maxReceivedMessageSize`, `srv/mediasoup.ts`). Ids are length-bounded strings, `peerId`s must be UUIDs. This is a **wire-visible change**: a client sending extra top-level fields now gets an error where it previously succeeded.

| Method | Data | Response | Description |
|---|---|---|---|
| `getSignableSecret` | none | `string` | Get authentication challenge |
| `login` | `{ deviceId, secret, base64Signature }` | `"OK" \| "ERROR"` | Authenticate with device signature |
| `getRouterRtpCapabilities` | none | `RtpCapabilities` | Get the router's codec capabilities for device loading |
| `join` | `{ displayName, device, rtpCapabilities }` | `{ peers, broadcasters, handsRaised }` | Join the room. Returns existing peers and broadcast state |
| `createWebRtcTransport` | `{ forceTcp, producing, consuming }` | `{ id, iceParameters, iceCandidates, dtlsParameters }` | Create a send or receive transport |
| `connectWebRtcTransport` | `{ transportId, dtlsParameters }` | `{ success: true }` | Complete DTLS handshake for a transport |
| `produce` | `{ transportId, kind, rtpParameters, appData }` | `{ id }` | Start sending a media track |
| `closeProducer` | `{ producerId }` | `{ success: true }` | Stop sending a media track |
| `pauseProducer` | `{ producerId }` | `{ success: true }` | Pause a producer (mute) |
| `resumeProducer` | `{ producerId }` | `{ success: true }` | Resume a producer (unmute) |
| `pauseConsumer` | `{ consumerId }` | `{ success: true }` | Pause receiving a consumer |
| `resumeConsumer` | `{ consumerId }` | `{ success: true }` | Resume receiving a consumer |
| `setConsumerPreferredLayers` | `{ consumerId, spatialLayer, temporalLayer }` | `{ success: true }` | Set SVC/simulcast layer preference |
| `setConsumerPriority` | `{ consumerId, priority }` | `{ success: true }` | Set consumer bandwidth priority |
| `restartIce` | `{ transportId }` | `iceParameters` | Restart ICE for a transport |
| `promoteBroadcaster` | `{ promotedPeerId }` | `{ success: true }` | Promote a peer to broadcaster (requires moderate permissions) |
| `demoteBroadcaster` | `{ demotedPeerId }` | `{ success: true }` | Demote a broadcaster (requires moderate permissions) |
| `endCallForEveryone` | none | `{ success: true }` | End the call for all peers (requires moderate permissions) |
| `raiseHand` | `{ peerId }` | `{ success: true }` | Raise hand (broadcast mode) |
| `lowerHand` | `{ peerId }` | `{ success: true }` | Lower hand (broadcast mode) |
| `moderationMute` | `{ mutedPeerId }` | `{ success: true }` | Force-mute a peer's audio (requires moderate permissions) |
| `peerReaction` | `{ peerId, reaction }` | `{ success: true }` | Send an emoji reaction (rate-limited: one per reaction per 200ms) |

### Protoo Notifications (Server -> Client)

| Method | Data | Description |
|---|---|---|
| `newPeer` | `{ id, displayName, device }` | A new peer has joined |
| `peerClosed` | `{ peerId }` | A peer has left |
| `newConsumer` | `{ peerId, producerId, id, kind, rtpParameters, type, appData, producerPaused }` | Server-initiated request (not notification) to create a consumer |
| `consumerClosed` | `{ consumerId }` | A consumer's producer has been closed |
| `consumerPaused` | `{ consumerId }` | A consumer's producer has been paused |
| `consumerResumed` | `{ consumerId }` | A consumer's producer has been resumed |
| `consumerScore` | `{ consumerId, score }` | Consumer quality score update |
| `consumerLayersChanged` | `{ consumerId, spatialLayer, temporalLayer }` | Consumer SVC layer change |
| `producerScore` | `{ producerId, score }` | Producer quality score update |
| `activeSpeaker` | `{ peerId, volume }` or `{ peerId: null }` | Audio level update (from AudioLevelObserver) |
| `dominantSpeaker` | `{ peerId }` | Dominant speaker changed (from ActiveSpeakerObserver) |
| `downlinkBwe` | `{ desiredBitrate, effectiveDesiredBitrate, availableBitrate }` | Bandwidth estimation trace |
| `promotedBroadcaster` | `{ peerId }` | A peer has been promoted to broadcaster |
| `demotedBroadcaster` | `{ peerId }` | A peer has been demoted from broadcaster |
| `raisedHand` | `{ peerId }` | A peer raised their hand |
| `loweredHand` | `{ peerId }` | A peer lowered their hand |
| `callEnded` | none | Call has been ended for everyone |
| `moderationMuted` | none | You have been force-muted by a moderator |
| `reactionReceived` | `{ peerId, reaction }` | An emoji reaction from a peer |
| `callUpdate` | `{ slots, stageSlots, audioOnly, highQuality }` | Call configuration changed |

---

## Frontend Real-time

### Socket.IO Client

**Source:** `src/data/appstate/webSocket.ts`

The `WebSocketManager` singleton manages the Socket.IO connection:

- **Connection:** `io(WS_URL, { transports: ['polling', 'websocket'], path: '/api/ws/', reconnection: true, reconnectionDelayMax: 10000 })`. In dev mode, polling is skipped (websocket-only).
- **Contract:** it implements `Transport` (`src/data/appstate/transport.ts`); `connectionManager.start`s it once the login manager is loaded, so a stored device is known before the first socket login.
- **Authentication flow (socket login):**
  1. On `connect`, emit `cgPing` for clock sync and re-send the socket-scoped joins (`watchCgIdRequest`).
  2. If the tab has a device: emit `getSignableSecret` to get a challenge, sign it with the device key, emit `login` with `{ deviceId, secret, base64Signature }`. Each ack (and the signature) has a 20 s timeout. A timeout retries the login after the backoff below; after two timeouts in a row the retry restarts the connection.
  3. On `"OK"` (the server has joined all rooms) the tab is **live**. An anonymous tab is live right after step 1. `"SECURITY_STEP_REQUIRED"` and `"ERROR"` are not live; `"ERROR"`, a failed signature and an ack timeout are retried with a backoff (5 s, 15 s, 60 s, each ±50 % random) while the tab is visible; a `"SECURITY_STEP_REQUIRED"` is not asked again on the same connection.
  4. A login, user switch or logout on a connected socket runs the same steps (a `logout` first if the socket was logged in) and is not live in between. Socket logins never overlap: the server runs socket handlers concurrently.
- **Live signal:** `live` is true only while connected and logged in (or anonymous and set up); `Common.WebSocketState` is `connected` only while live. `onLive(kind)` fires on every transition to live: `established` (first in this page load), `restored` (after the connection was lost or closed by policy), `user` (same connection, its user changed). `onResume(reason)` (`visible` after ≥ 30 s hidden, `pageshow` from bfcache, `resume`, `online`) fires only when the socket stayed live; otherwise the tab reconnects and only the later `onLive` fires.
- **Event routing:** Uses `socket.onAny()` to catch all events and forwards those starting with `cli` to the registered `clientEventHandler` (every tab handles its own events). The `buildId` event has its own handler.
- **Reconnection logic:** A reconnect performs the socket login only (no HTTP device login). Handles `disconnect` with reason-specific behavior:
  - `io server disconnect` -- Immediately reconnect (unless closed by policy).
  - `io client disconnect` -- Stay disconnected (policy close, or a deliberate restart).
  - other reasons (`transport close`, `ping timeout`, …) -- socket.io reconnects with its backoff; a visible tab that comes back (`visible`, `pageshow`, `resume`, `online`) reconnects at once instead of waiting for the backoff.
- **Connect-error handling:** socket.io keeps retrying (`reconnection: true`), but after 5 consecutive `connect_error`s the displayed state is `disconnected` so the UI does not claim "connecting" forever.
- **Disconnect detection:** A 59-second `cgPing` interval detects stale connections. If the last pong is >110 seconds old, forces reconnect. The same check runs when a live tab comes back.
- **Version detection:** When `buildId` from server differs from the client build, `updateAvailable` is set (once per page load) and the service-worker update starts. The socket, pings, socket re-login and reconnects keep working.
- **Request socket id:** `getRequestSocketId()` is the connected socket's id, else a random per-tab id in the same format; `BaseApiConnector` sends it as `x-cg-socket-id` on every API request.

### Tab Coordination

Every tab owns its Socket.IO connection, its login state and its in-memory data (messages, read state, notifications: `src/data/chat/`, [docs/frontend §3 "Chat stores"](../frontend/README.md#chat-stores-srcdatachat)). There is no leader tab, no relay of events between tabs and no shared message cache; the page never opens `BroadcastChannel('CG_WEBSOCKET_STATE')`.

**Why independent tabs.** Before, the service worker assigned one "active" tab that owned the socket and the others mirrored it, with a chunked message cache in IndexedDB shared over BroadcastChannel. Browser behaviour makes any such hand-off fragile: Chrome closes every WebSocket of a page it freezes (not only on bfcache), Chrome for Android freezes hidden tabs after about a minute, iOS suspends a backgrounded tab almost at once (Firefox does not freeze); a frozen tab keeps its Web Locks, so a lock alone is no safe leader election; SharedWorker is not available on every supported browser (Safari 16, Chrome for Android); and Socket.IO connection-state recovery does not work with the classic Redis adapter in use and covers neither reloads nor new tabs. Every model ends in "socket gone → reconnect → catch up", so the client relies on that alone: background tabs only have to be correct once they are visible again. The only cross-tab mechanisms left are the login lock and the auth broadcast below.

**Catch-up after a (re)connect (`src/data/chat/`):**

- "Live" means socket logged in and rooms joined: `onLive` (and the app events `cliConnectionEstablished` / `cliConnectionRestored`) fire only after the socket `login` ack, because events emitted between `connect` and the room join are lost on the server.
- Triggers (each store debounces them into one round): `onLive` — first login ack of the page (`established`), after a lost or policy-closed connection (`restored`), a user change on the same connection (`user`, also when the login settles after the socket went live) — and `onResume` while the socket stayed live (`visible` after ≥ 30 s hidden, `pageshow` from bfcache, `resume`, `online`).
- On each round: `Message/getSyncState` (read state of every readable channel and DM plus the notification count), `Message/getChanges` for every open message window from its `"1:<seq>"` cursor, and the notification count/open list. Live events arriving meanwhile are applied too; the stores merge by `syncSeq`, so order and duplicates do not matter. A live event that leaves a `syncSeq` gap open for 1.5 s triggers a `getChanges` of that channel.
- Community, chat and own-user data are refreshed by the device `User/login` snapshot after a `restored` live (below); their Dexie writers are monotonic. A reconnect never runs a full HTTP device login.

**Hidden-tab policy (`webSocket.ts`):**

- Visible tabs (also several in split view) are always connected.
- A hidden tab closes its socket (`socket.disconnect()`, no auto-reconnect) after `HIDDEN_DISCONNECT_AFTER_MS` (5 min) unless a `SocketHold` is active. `CallProvider` holds the socket while the tab is in a call; after the last release of a hidden tab the 5 minutes start from the release. Inside the 5 minutes socket.io's own reconnection stays on.
- `freeze` and `pagehide` close the socket at once, holds or not (`pagehide` replaces `beforeunload`; nothing is written to localStorage per event or on unload).
- After such a policy close the tab reconnects only on `visibilitychange` to visible, `pageshow` (persisted), `resume` or `online` while visible — never on a timer while hidden.

**Login across tabs (`login.ts`, `authBroadcast.ts`):**

- The HTTP device login runs once per page load in every tab (on the first socket connect). Each HTTP login holds the Web Lock `cg:login` for its whole exchange — for a device login: `User/getSignableSecret`, signature and `User/login`, because the server keeps one signable secret per session and the tabs share the session cookie. A tab that had to wait for the lock re-checks `User/checkLoginStatus` and takes the session over if it belongs to the stored user (another tab has just logged in). After 10 s (`LOGIN_LOCK_HOLD_MAX_MS`) the lock is released for the other tabs, but the holder keeps waiting for its own request; it only starts no further step (signature, request) without the lock — it queues again once. A device login answered `INVALID_SECRET` (a late secret request of another tab replaced the secret) is repeated once under the lock with a fresh secret. Inside the lock a tab compares the stored current user with the device it is about to log in and follows the stored user if they differ. A page device login that fails with anything but `NOT_FOUND` is retried with a backoff (5/15/60 s, ±50 %) and on the next visibility/online check (never sooner than 5 s after the failure); `User/logout` also runs under the lock. A waiting tab logs in without the lock after 15 s (a frozen tab keeps its locks). After a `restored` live a visible tab re-runs the device `User/login` for its snapshot (own communities, chats, own data, unread count) under the same lock, debounced by a random 1–3 s; a hidden tab does so when it becomes visible.
- A logout or login is broadcast on `BroadcastChannel('cg:auth')`; the `storage` event on `CG_CURRENT_USER` is the fallback. On a logout every other tab emits socket `logout` and drops its login state (no second `User/logout`); on a login an anonymous tab takes over the session after `User/checkLoginStatus`; a login of another user is handled as a logout first. For one release a logout also posts `'anonymous'` on `CG_LOGIN_STATE` for still-open older pages (`authBroadcast.ts`, marked `COMPAT — remove one release after chat-sync`).
- On the server, `User/logout` disconnects the device's other sockets and sends them `cliSignedOut` first (see [Socket-scoped targeting](#socket-scoped-targeting)), before the logging-out tab has finished. That tab writes `CG_LOGOUT_IN_PROGRESS` to localStorage before the request; a tab that gets `cliSignedOut` and sees it (or the changed `CG_CURRENT_USER`, or the broadcast) follows the logout without the "signed out" notice and without a second `User/logout`. Otherwise it re-checks for 1 s and decides under `cg:login`, so of several tabs signed out from elsewhere normally one logs out and the others follow (a second `User/logout` is harmless) ([docs/frontend §10](../frontend/README.md)). A disconnected tab reconnects anonymously.

**Service worker (`src/service-worker.ts`, compat answer in `src/serviceWorkerLegacyTabs.ts`):** precache, Web Push, `notificationclick`, the update/`reload` flow and `CHANNEL_VISITED` (a page that opens a channel closes that channel's push notifications) are its only jobs. For one release it keeps a compat answer for pages of the previous build (marked `COMPAT — remove one release after chat-sync`, together with the `Legacy*` types in `src/data/appstate/transport.ts`):

- Every `TabToWorker` with `tabState: 'unknown'` gets exactly `{ type: 'WorkerToTab', tabId, tabState: 'active' }` back: no socket state is relayed, so the tab does not mirror stale values. Every other message on the channel (heartbeats, `tabClosed`) is ignored; there is no tab registry, no promotion and no ban list.
- Only the activated worker answers (its own `self.serviceWorker.state`; where that is missing, once its `activate` handler ran or when it started up already active after a browser restart); a new worker that is installed but still waiting stays silent next to the worker of the previous build.
- New pages never open this channel (see above). Purpose: pages of the previous build that are still open after an update without having reloaded on the `reload` message `activate` posts to every client connect instead of waiting for a role forever. The answer is removed one release after chat-sync; new pages give every tab its own socket and never use the channel.
- Several old pages answered "active" settle on one active tab through their own collision tie-break (visible tab wins, else the higher `tabId`). When the active tab closes, a passive tab takes over once it becomes visible (visibility handoff); nobody promotes a hidden passive tab.
- Accepted regression: for old pages that never reload, nothing promotes a passive tab any more, so when the active old tab closes, the passive one shows "Disconnected" until its visibility changes. Its reach is tiny, because old pages reload at most 1.5 s after `activate`.
- `STOP_TAB_HANDLING` messages of old pages are ignored.

### WebRTC Client

**Source:** `src/util/RoomClient.tsx`

The `RoomClient` class manages the protoo peer and MediaSoup device on the frontend:

- **Libraries:** `protoo-client`, `mediasoup-client`
- **State management:** All state changes are dispatched to a React `useReducer` (defined in `CallPage.reducer.ts`) via the `_dispatch` callback.

#### Join Flow

1. Create `protooClient.WebSocketTransport` with the protoo URL.
2. Create `protooClient.Peer` with the transport.
3. On `open` event, call `_joinRoom()`:
   a. Create `mediasoupClient.Device`.
   b. Authenticate via `getSignableSecret` + `login`.
   c. Load device with `getRouterRtpCapabilities`.
   d. Create send transport (`enableProducing`) and receive transport (`enableConsuming`).
   e. Send `join` request with display name, device info, and RTP capabilities.
   f. Dispatch `initializeCall` to initialize UI state.

#### Transport Setup

**Send transport (`enableProducing`):**
- Requests `createWebRtcTransport` with `producing: true`.
- Creates `mediasoupDevice.createSendTransport()`.
- Hooks `connect` event to send `connectWebRtcTransport`.
- Hooks `produce` event to send `produce` request.
- On `connectionstatechange` failure, closes and recreates the transport.

**Receive transport (`enableConsuming`):**
- Requests `createWebRtcTransport` with `consuming: true`.
- Creates `mediasoupDevice.createRecvTransport()`.
- Hooks `connect` event to send `connectWebRtcTransport`.
- On `connectionstatechange` failure, requests `restartIce`.

#### Media Controls

| Method | Description |
|---|---|
| `enableMic()` | Gets audio stream via `getUserMedia`, creates mic producer with opus DTX/FEC |
| `disableMic()` | Closes mic producer, sends `closeProducer` |
| `muteMic()` | Pauses mic producer locally, sends `pauseProducer` |
| `unmuteMic()` | Resumes mic producer, sends `resumeProducer` |
| `enableWebcam()` | Gets video stream (720p default, 1080p60 for HD), creates webcam producer with simulcast |
| `disableWebcam()` | Closes webcam producer |
| `enableShare()` | Gets display stream via `getDisplayMedia`, creates share producer |
| `disableShare()` | Closes share producer |
| `endCallForEveryone()` | Sends protoo request to end call |
| `moderationMuteMic(peerId)` | Sends `moderationMute` request |

#### Simulcast / SVC

- **VP9:** Uses `L3T3_KEY` scalability mode (3 spatial, 3 temporal layers).
- **VP8/H264:** Uses up to 3 simulcast streams with `L1T3` scalability mode and `scaleResolutionDownBy` factors of 2, 1.25, and 1.

### Call Provider

**Source:** `src/context/CallProvider.tsx`

The `CallProvider` React context wraps the entire call lifecycle:

- **State:** Uses `useReducer(callReducer, initialState)` for call state (peers, consumers, producers, active speaker, mute state, etc.).
- **`startCall`:** Calls the API to create a call, then joins it.
- **`joinCall`:** Creates a new `RoomClient`, calls `roomClient.join()`, plays join sound, requests wake lock.
- **`leaveCall`:** Closes the `RoomClient`, plays leave sound, releases wake lock.
- **`toggleMute`:** Enables mic if needed, then toggles mute/unmute.
- **Audio rendering:** For each peer, a `<PeerAudio>` component creates a `<audio>` element and wires it to the peer's audio consumer track.
- **Sound effects:** Join, leave, new peer, and peer left events trigger audio file playback (`/audio/joinCall.mp3`, etc.).
- **Wake Lock:** Requests a screen wake lock while in a call to prevent the device from sleeping.

### Call Page UI

**Source:** `src/views/CallPageView/CallPageView.tsx`, `src/components/organisms/CallPage/`

The call page view renders the `<CallPage>` component within a community context. The CallPage directory contains:

- `CallPage.tsx` -- Main call page layout
- `CallPage.reducer.ts` -- State management (peers, consumers, producers, broadcasters, reactions)
- `PeerCard.tsx` -- Individual peer video/audio card
- `Peers.tsx` -- Grid layout of peer cards
- `CallActions.tsx` -- Mute, camera, screen share, leave buttons
- `BroadcastActions.tsx` -- Broadcast-specific actions (promote, demote, hand raise)
- `BroadcastCards.tsx` -- Broadcaster video layout
- `AudienceList/` -- Audience list for broadcast mode
- `AudienceCard.tsx` -- Individual audience member card
- `CallHeader/` -- Call title, description, timer
- `CallTimer.tsx` -- Elapsed call time display
- `CallWidget.tsx` -- Minimized call widget
- `PreviewCards/` -- Preview cards before joining
- `ReactionPicker/` -- Emoji reaction selector
- `ReactionOverlay/` -- Floating reaction animations
- `PeerReactionOverlay/` -- Per-peer reaction display

---

## Call System

### Data Model

**Source:** `srv/entities/call.ts`, `srv/entities/callserver.ts`

#### `Call` Entity (table: `calls`)

| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Call identifier (also used as roomId in MediaSoup) |
| `communityId` | UUID (FK -> communities) | Community the call belongs to |
| `callCreator` | UUID (FK -> users) | User who started the call |
| `channelId` | UUID (FK -> channels) | Channel the call is associated with |
| `callServerId` | UUID (FK -> callservers, nullable) | Which call server handles this call |
| `callType` | enum (`default`, `broadcast`) | Call mode |
| `title` | varchar(100) | Call title |
| `description` | varchar(200, nullable) | Call description |
| `previewUserIds` | UUID[] | Array of currently-joined user IDs (for preview) |
| `slots` | int (default 100) | Maximum participants |
| `stageSlots` | int | Maximum broadcasters (for broadcast mode) |
| `audioOnly` | boolean | Whether video is disabled |
| `highQuality` | boolean | Whether HD mode is enabled |
| `scheduleDate` | timestamptz (nullable) | Scheduled start time |
| `startedAt` | timestamptz | Actual start time |
| `updatedAt` | timestamptz | Last update |
| `endedAt` | timestamptz (soft delete) | When the call ended |

#### `CallMembership` Entity (table: `callmembers`)

Tracks individual user participation:

| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Membership record ID |
| `callId` | UUID (FK -> calls) | Which call |
| `userId` | UUID (FK -> users) | Which user |
| `joinedAt` | timestamptz | When they joined |
| `leftAt` | timestamptz (soft delete) | When they left |

#### `CallPermissions` Entity (table: `callpermissions`)

Role-based permissions per call:

| Column | Type | Description |
|---|---|---|
| `callId` | UUID (PK, FK -> calls) | Which call |
| `roleId` | UUID (PK, FK -> roles) | Which role |
| `permissions` | enum[] | Array of `CallPermission` values |

**CallPermission enum values:**
`CALL_EXISTS`, `CALL_JOIN`, `CALL_MODERATE`, `CHANNEL_READ`, `CHANNEL_WRITE`, `AUDIO_SEND`, `VIDEO_SEND`, `SHARE_SCREEN`, `PIN_FOR_EVERYONE`, `END_CALL_FOR_EVERYONE`

#### `CallServer` Entity (table: `callservers`)

| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Server ID |
| `status` | JSONB | `{ ongoingCalls, traffic }` |
| `url` | varchar(255, unique) | Server domain |
| `createdAt` | timestamptz | Registration time |
| `updatedAt` | timestamptz | Last status update |
| `deletedAt` | timestamptz (soft delete) | Decommissioned |

#### `CallType` Enum

```typescript
enum CallType {
  DEFAULT = 'default',    // Standard group call, all participants can produce
  BROADCAST = 'broadcast' // Stage mode: only broadcasters can produce, others listen
}
```

### Call Flow

1. **Start call:** Frontend calls `data.community.startCall()` API, which creates a `Call` row and assigns a call server.
2. **Join call:** Frontend creates a `RoomClient` with the call server URL, which opens a protoo WebSocket to the call server.
3. **Room creation:** On the call server, if no Room exists for the callId, one is created (with a MediaSoup Router).
4. **Permission checks:** `hasJoinPermissions` and `hasModeratePermissions` verify role-based permissions via the `callpermissions` table.
5. **Member tracking:** On join, `callHelper.insertCallMember` creates a `CallMembership` row. On leave, `callHelper.callMemberLeave` soft-deletes it. `previewUserIds` is updated on join/leave.
6. **End call:** When the last peer leaves, `callHelper.softEndCall` is called. For forced end, `callHelper.endCallForEveryone` is called.
7. **Server cleanup:** On SIGTERM, and on start, `callHelper.resetCallServer` ends the calls of this call server (matched by its URL), event calls included. A failure at start is logged and does not keep the call server from registering its call update listener. An ended event call can be started again (`startScheduledCall` resets `endedAt`).
8. **Safety net (jobs process):** `callUpdateEmitter` ends non-scheduled calls whose members have all left more than 60 s ago (checked every second), and every open call (event calls included) of call servers that are gone — row deleted or missing, or heartbeat (`callservers.updatedAt`, written every 2 s) older than 60 s (checked every 15 s). Every call that gets an `endedAt`, by whichever path, is sent to the community room as `cliCallEvent` `delete`.

**Live delivery of call chat and new calls.** Nobody joins a Public role room, so role rooms alone
miss everyone who sees a call only through the Public role. Call-chat `cliMessageEvent`s
(`emitMessageEvents`, `srv/api/messages.ts`) therefore go, in one emit, to the role rooms with
`CALL_EXISTS` + `CHANNEL_READ`, to the user rooms of the call's present members
(`callmembers.leftAt IS NULL`) who hold those permissions through a claimed role or Public
(`callHelper.getActiveMemberUserIds`, evaluated like `permissionHelper.hasPermissions`), and to
the community room (members and visitors) when Public is among those roles. `cliCallEvent` `new`
(`startCall`, `startScheduledCall`, `emitCallNew` in `srv/api/community.ts`) goes to its role rooms
plus the present members with `CALL_EXISTS` and the community room when Public has `CALL_EXISTS`
(`callHelper.getCallEventExtraTargets`, one statement; if it fails, the role rooms still get the
event). For call chat the role query and the member query each fall back to "none" on their own
(the other targets still get the event); `emitMessageEvents`, which no caller waits for, never
rejects — a failed target query of any channel kind is logged. Members who join after a message
catch up through `getChanges`.

### Broadcast Mode

In broadcast mode (`CallType.BROADCAST`):
- The call creator is automatically a broadcaster.
- Non-broadcasters can only consume (listen/watch), not produce.
- Moderators can promote/demote broadcasters via `promoteBroadcaster`/`demoteBroadcaster` requests.
- Non-broadcasters can raise/lower their hand to request broadcast access.
- When demoted, the **client-side** closes its own send transport and stops all producers (mic, webcam, share). The server only removes the peer from the broadcasters map and notifies all peers.
- If all broadcasters leave, the room closes.
- When a non-creator peer joins an empty broadcast room and has moderate permissions, they are automatically promoted to broadcaster.

---

## Push Notifications

**Source:** `srv/repositories/notifications.ts`, `srv/api/notifications.ts`, `srv/entities/notifications.ts`, `srv/entities/device.ts`

### Web Push Setup

Uses the `web-push` npm library with VAPID keys loaded from Docker secrets (`vapid_keys_json`):

```typescript
webPush.setVapidDetails(
  "mailto:ola@dao.cg",
  vapidKeyData.publicKey,
  vapidKeyData.privateKey,
);
```

### Device Entity

The `Device` entity (`srv/entities/device.ts`, table: `devices`) stores:
- `publicKey` (JSONB) -- Device's public key for authentication
- `webPushSubscription` (JSONB, nullable) -- Web Push subscription object (`{ endpoint, keys: { p256dh, auth } }`)
- `deviceInfo` (JSONB, nullable) -- Device metadata

### Notification Entity

The `Notification` entity (`srv/entities/notifications.ts`, table: `notifications`):
- `type` -- NotificationType enum (e.g., Mention, Reply, Call, DM, etc.)
- `userId` -- Target user
- `subjectUserId`, `subjectCommunityId`, `subjectArticleId`, `subjectItemId` -- Context references
- `text` -- Notification text
- `read` -- Boolean read status
- `extraData` -- JSONB for additional structured data

### API Endpoints

All routes are POST under the notification router (`srv/api/notifications.ts`):

| Endpoint | Description |
|---|---|
| `/loadNotifications` | Load notifications with pagination (before/after cursor, unread filter) |
| `/loadUpdates` | Load notifications updated since a timestamp (for incremental sync) |
| `/getUnreadCount` | Count of unread notifications as a number; `{ withTime: true }` answers `{ unreadCount, unreadCountAt }`. A call without a body (older clients) gets the plain number |
| `/markAsRead` | Mark a single unread notification as read; emits `cliNotificationEvent` `update` only when it was unread (already read: no write, no event) |
| `/markAllAsRead` | Mark the unread notifications as read; emits `cliNotificationEvent` `allread` only when at least one changed |
| `/getPublicVapidKey` | Return the VAPID public key for push subscription |
| `/registerWebPushSubscription` | Store the push subscription on the device record |
| `/unregisterWebPushSubscription` | Remove the push subscription from the device record |
| `/channelPushNotificationClosed` | Currently disabled (no-op) |

### Push Notification Delivery

The `sendWsOrWebPushNotificationEvent` method (`srv/repositories/notifications.ts`) handles notification delivery:

1. **Community-scoped notifications:** Queries `user_community_state` joined with `devices` to find devices with push subscriptions. Checks per-community notification preferences (`notifyMentions`, `notifyReplies`, `notifyPosts`, `notifyEvents`, `notifyCalls`).
2. **Non-community notifications (DMs):** Queries all devices with push subscriptions for the user. Checks `dmNotifications` preference.
3. **Sending:** Calls `webPush.sendNotification(subscription, eventString, { urgency: "high" })` for each eligible device (excluding the origin device).
4. **Error handling:** On 410/404 (subscription expired), removes the subscription from the device. Other errors are logged.
5. **Notification preferences:** Community-scoped notifications are gated by the recipient's per-community preference flags (e.g. `notifyMentions`, `notifyReplies`, `notifyCalls`); DMs are gated by `dmNotifications`.
6. **Socket.IO fallback:** For notification types that are stored in the DB (not DMs, ChannelMessages, or Calls), also emits the event via `eventHelper.emit` for real-time Socket.IO delivery.

### Unread count in notification events

`cliNotificationEvent` `new` (stored types only, see 6. above), `update` and `allread` carry two additional fields next to `action`/`data`:

- `unreadCount` -- the user's unread notification count after the change, a number;
- `unreadCountAt` -- the database `now()` (ISO) of the statement that read the count.

The count is read in its own statement after the write (`notificationHelper.withUnreadCount`), so a count with a later `unreadCountAt` includes every change committed before it; clients keep the count with the newest time. If the count cannot be read, the event goes out without both fields (as from older servers) and clients refresh with `getUnreadCount`. The web-push payload of a `new` notification is unchanged (no count). No server path emits `delete` today; the type keeps it. The same count, as a number, is the login response's `unreadNotificationCount` and `notificationUnreadCount` of `Message/getSyncState` ([docs/backend](../backend/README.md)).

---

## Redis Pub/Sub & Data

**Source:** `srv/redis/index.ts`, `srv/redis/userdata.ts`

### Instances

The backend talks to **two Valkey instances** (Redis-protocol compatible; compose services `redis` and `redis-cache`, see [docs/infrastructure](../infrastructure/README.md#redis-and-redis-cache-valkey) for their configuration). Which client goes where is fixed in `srv/redis/index.ts` (`INSTANCE_OF`):

| Client type | Instance | Key prefixes | Purpose |
|---|---|---|---|
| `session` | state (`REDIS_URL`, default `redis://redis:6379`) | `sess:`, `sess-revoked:`, `sess-user:`, `sess-gen:`, `sess-keep:`, `sess-gen-copied` | Express session storage (connect-redis); ids of destroyed/replaced sessions (1 h, [auth-identity §2](../auth-identity/README.md#when-a-session-exists)); each user's logged-in session ids (sorted set, expires with its sessions) and the copies of the session generations (no TTL, reconciled from PostgreSQL at api start and every 30 s, `sess-gen-copied` records how far; `sess-keep:` 13 h; [auth-identity §2](../auth-identity/README.md#signing-out-other-devices)) |
| `socketIOPub`, `socketIOSub` | state | `v2:` (pub/sub channels only, no keys) | Socket.IO adapter and emitter |
| `data` | state | `ud:`, `us:`, `online-user-addresses`, `ratelimit:`, `bot-ratelimit:`, `bot-presence:`, `captcha:`, `pluginRequest:`, `tmp:` | User online status, rate limiting, captcha key + replay guards, plugin replay keys, bot presence leases |
| `cache` | cache (`REDIS_CACHE_URL`, default `redis://redis-cache:6379`) | `urlpreview:` | URL-preview cache |

What is state and what is cache:

| Data | Instance | Lost on a cold start |
|---|---|---|
| Sessions (`sess:`; 12 h rolling TTL when logged in, 1 h without a user), the index of each user's sessions (`sess-user:`) and the copies of the session generations (`sess-gen:`, `sess-keep:`; reconciled from PostgreSQL at api start and every 30 s) | state | every user is logged out once |
| Rate-limit windows (`ratelimit:` sorted sets, `bot-ratelimit:` counters; TTL = window) | state | limits restart from zero for one window |
| Replay guards (`captcha:altcha:used:` 10 min, `pluginRequest:` 15 min) | state | a captcha solution / signed plugin request from the last minutes could be redeemed once more |
| ALTCHA HMAC key (`captcha:altcha:hmackey`, no TTL; only when `ALTCHA_HMAC_KEY` is not configured) | state | regenerated; challenges issued before become invalid. Each process caches the key in memory after first use, so processes started before and after a loss disagree until they restart — configure `ALTCHA_HMAC_KEY` to avoid this |
| Bot presence leases (`bot-presence:`) | state | rebuilt within one 60 s keepalive round |
| User status (`ud:`, no TTL) | state | nothing visible — `/User/setOwnStatus` writes it, but nothing reads it (`UserDataManager.getUserData` has no caller) |
| `online-user-addresses`, `us:` | state | nothing — `addUserSession`/`removeUserSession` have no caller, so these keys are never written; `intersectWithOnlineUsers` (used by `onchain`) reads an empty set |
| URL previews (`urlpreview:`, 1 h TTL, ≤ 8 KB each) | cache | rebuilt on the next request |
| Socket.IO pub/sub | state | nothing stored; messages published while a subscriber is disconnected are lost |

No queue or job state lives in Valkey (the job runner schedules in-process and keeps its state in PostgreSQL). The state instance is persisted (RDB, final snapshot on shutdown), so a planned restart keeps all of the above; only a crash loses what changed since the last snapshot. Until 2026-10-31 a single unpersisted `redis:6.2` instance held everything, so every restart was a cold start; before 2026-08-01 there were three identically configured instances (`redis-sessions`, `redis-socketio`, `redis-data`).

### RedisManager

The `RedisManager` class (`srv/redis/index.ts`) manages all connections:

- Up to five clients: `session`, `socketIOPub`, `socketIOSub`, `data` (state instance) and `cache` (cache instance), each built by `srv/redis/client.ts`, which pins `RESP: 2` (node-redis 6 defaults to RESP3; `@socket.io/redis-adapter` 8.3 is written against RESP2).
- **Clients are created and connect on first use** (`getClient(type)`), so a process holds only the connections it needs. Measured on a smoke stack: `api` 3 state connections (`session`, `data`, `socketIOPub`) + 1 cache connection once a URL preview was requested; each `wsapi` 3 (`socketIOPub`, `socketIOSub`, `data` — it never reads the session store, it only unsigns the session cookie); `memberlist` 0 (it used to open 4 through `healthcheck.ts`). By the import graph, the job-runner main thread and `migrate-db` open none either, and job workers that emit events open `socketIOPub` only. Commands sent before a connection is up wait in node-redis' offline queue, bounded to 10,000 commands per client (`commandsQueueMaxLength`; beyond it node-redis rejects new commands at once with "The queue is full").
- `ready(...types)` resolves once the given clients have connected (once — it says nothing about the connection still being up, and it waits for as long as the server is unreachable), so it is only used for startup ordering (`wsapi` attaches the Socket.IO adapter after it); request paths never wait on it. If a client's `connect()` gives up anyway (e.g. an invalid URL), the client is dropped and the next `getClient()` starts over. `connectedClient(type)` returns the client only if it is connected right now — the URL-preview cache uses it, so previews are built uncached instead of waiting while the cache instance is down.
- Exposes `get`, `set`, `del` convenience operations and `userData` (below); generates a random `instanceId` per process (bot presence leases).
- **Error handling:** every client has an `error` listener (`client.ts`). Without one, node-redis' `error` event — emitted on every failed (re)connection attempt — is thrown and kills the process; before 2026-10-31 only the two Socket.IO clients had one (attached by the adapter, in `wsapi` only), so a Redis restart crashed every process that imports `srv/redis` — observed for `memberlist`, which exited with `SocketClosedUnexpectedlyError`. The listener logs at most one line per client every 30 s (with a count of suppressed errors) and one line when the client is connected again. Reconnects use node-redis' default strategy (exponential backoff capped at 2 s plus jitter, unlimited retries); pub/sub subscriptions are restored on reconnect.
- **Timeouts:** node-redis 6 gives every single command a 5 s timeout, but **not** MULTI or pipeline chains (`_executeMulti` / `_executePipeline` queue their commands without one), so such a chain would wait in the offline queue for the whole outage. Every MULTI call site (`srv/util/rateLimit.ts` `countWithinWindow`, `srv/util/botRateLimit.ts`, the four MULTIs in `srv/redis/userdata.ts`) therefore goes through `withTimeout()` (`client.ts`, 5 s, rejects with `Redis <what> timed out after 5000 ms`); the chain itself stays queued and runs if the connection returns. `PUBLISH` gets a handler attached in `client.ts`: `@socket.io/redis-emitter` and the adapter call `publish()` without awaiting it, so a PUBLISH timing out during an outage used to be an unhandled rejection, on which `api` and `wsapi` exit (reproduced with a plain node-redis client: `TimeoutError` unhandled after 5 s).
- **Outage behaviour (measured):** with the state instance stopped, requests that touch it fail after 5 s (single commands via node-redis' command timeout — a request carrying a session cookie gets HTTP 500 with the API's JSON error body `{"status":"ERROR","error":"UNKNOWN"}` from `apiErrorHandler` in `srv/api/util.ts`, because the session lookup fails before any route runs; rate-limit, bot-rate-limit and `UserDataManager` MULTIs via `withTimeout()`) instead of hanging — both for a process that had connected before and for one that never reached the server; `eventHelper.emit` returns at once and its PUBLISH times out without an unhandled rejection; every process stays up, and after the restart sessions, rate-limit windows and Socket.IO fan-out across both `wsapi` instances work again without restarting anything. With the cache instance stopped, URL previews are served uncached at normal speed. A process started while Valkey is unreachable keeps retrying and connects when it comes up.
- `REDIS_LEGACY_MODE` is gone: node-redis 6 dropped `legacyMode`, connect-redis
  10 speaks the promise API, and the backend never reads the variable any more.
  The inert `REDIS_LEGACY_MODE=true` lines were removed from both compose files
  (maintainer decision, 2026-08-04).

### Socket.IO Redis Adapter

The `@socket.io/redis-adapter` uses the `socketIOPub`/`socketIOSub` client pair:

```typescript
io.adapter(createAdapter(
  redisManager.getClient('socketIOPub'),
  redisManager.getClient('socketIOSub'),
  { key: 'v2:' }
));
```

This enables:
- **Cross-instance event broadcasting:** Events emitted to a room on any server instance are delivered to all clients in that room, regardless of which instance they're connected to.
- **Cross-instance room management:** `socketsJoin` and `socketsLeave` work across instances (used by `EventHelper.userJoinRooms` / `userLeaveRooms`).

The `@socket.io/redis-emitter` (used in `EventHelper`) can emit events without a Socket.IO server, using only the pub Redis client. This allows API processes and background jobs to push events.

### UserDataManager

The `UserDataManager` class (`srv/redis/userdata.ts`) manages user online state on the `data` client:

| Operation | Redis Commands | Description |
|---|---|---|
| `addUserSession(userId, sessionId)` | `SADD us:{userId} {sessionId}`, `SADD online-user-addresses {userId}` | Track a user session, mark user online |
| `removeUserSession(userId, sessionId)` | `SREM us:{userId} {sessionId}`, `SCARD us:{userId}`, (if 0) `SREM online-user-addresses {userId}` | Remove session, mark offline if last session |
| `setUserData(userId, data)` | `HSET ud:{userId} status {status}` | Set user online status |
| `getUserData(userIds)` | `HGETALL ud:{userId}` (pipelined) | Batch-get user online statuses |
| `intersectWithOnlineUsers(userIds)` | `SADD tmp:{random} {userIds}`, `SINTER tmp:{random} online-user-addresses`, `DEL tmp:{random}` | Filter a list of user IDs to only those currently online |

Only `setUserData` (from `/User/setOwnStatus`) and `intersectWithOnlineUsers` (from `onchain`) have callers today; the other three methods are unused, so `us:` and `online-user-addresses` are never written.

Key prefixes:
- `us:{userId}` -- Set of active session IDs for a user
- `ud:{userId}` -- Hash of user data (currently only `status`)
- `online-user-addresses` -- Global set of all online user IDs

---

## Key File Reference

| File | Purpose |
|---|---|
| `srv/wsapi.ts` | Socket.IO server, connection/auth/room management, bot socket lifecycle & presence |
| `srv/common/botProtocol.ts` | `BOT_PROTOCOL_VERSION` constant for the bot socket handshake |
| `srv/repositories/botTokens.ts` | Bot token authentication; triggers `disconnectBotTokenSockets` on revoke |
| `srv/repositories/bots.ts` | Bot presence writes, active socket room resolution |
| `srv/mediasoup.ts` | MediaSoup entry point, worker management, protoo server |
| `srv/mediasoup/room.ts` | Room class: protoo + MediaSoup Router, all signaling handlers |
| `srv/mediasoup/config.ts` | MediaSoup worker/router/transport configuration |
| `srv/mediasoup/utils.ts` | `clone()` deep-copy utility |
| `srv/mediasoup/logger.ts` | Debug logger wrapper |
| `srv/mediasoup/mediasoupHealthcheck.ts` | Fake healthcheck (writes file periodically) |
| `srv/redis/index.ts` | RedisManager: two Valkey instances (state, cache), up to five lazily created clients |
| `srv/redis/client.ts` | The one `createClient` call: `RESP: 2`, `error` listener, reconnect logging |
| `srv/redis/userdata.ts` | UserDataManager for online status tracking |
| `srv/repositories/event.ts` | EventHelper: emit Socket.IO events from any process; `disconnectBotTokenSockets`; socket-scoped `requestSocketsJoinRooms`/`LeaveRooms`, `logoutDeviceSockets` |
| `srv/util/requestSocket.ts` | `x-cg-socket-id` header (`getRequestSocketId`), `deviceSocketRoomKey`, `senderExcept` |
| `srv/repositories/notifications.ts` | NotificationHelper: CRUD + web push delivery |
| `srv/entities/call.ts` | Call, CallMembership, CallPermissions entities |
| `srv/entities/callserver.ts` | CallServer entity |
| `srv/entities/device.ts` | Device entity (includes webPushSubscription) |
| `srv/entities/notifications.ts` | Notification entity |
| `srv/api/notifications.ts` | Notification REST API routes |
| `srv/common/enums.ts` | CallType, CallPermission enums |
| `src/data/appstate/webSocket.ts` | Frontend Socket.IO client (WebSocketManager, implements `Transport` from `transport.ts`): one socket per tab, live signal, hidden-tab policy |
| `src/service-worker.ts` | Service worker: precaching, web push display and notification clicks, update/reload; one-release compat answer to old pages' tab-role requests (`src/serviceWorkerLegacyTabs.ts`) |
| `src/util/RoomClient.tsx` | Frontend protoo + mediasoup-client |
| `src/util/urlFactory.ts` | Builds protoo WebSocket URL |
| `src/context/CallProvider.tsx` | React context for call state management |
| `src/components/organisms/CallPage/CallPage.reducer.ts` | Call state reducer (peers, consumers, producers) |
| `src/views/CallPageView/CallPageView.tsx` | Call page view wrapper |
