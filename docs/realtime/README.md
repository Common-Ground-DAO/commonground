# Real-time & WebRTC Documentation

> Status: verified against commit 96e828069, 2026-08-04

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

1. **Browser / device clients** (cookie-based). No `handshake.auth.token` is provided. On connection, the server parses the session cookie (`SESSION_COOKIE_NAME`, default `connect.sid`) via signed-cookie parsing to extract the Express session ID and joins the `expressSession:{sessionId}` room. If no cookie is present, the socket is immediately disconnected. These sockets stay unauthenticated until they complete the `login` event flow (device-signature challenge, see below).

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

This uses a dedicated publisher/subscriber connection pair on the shared Redis instance (`redis:6379`). The key prefix `v2:` namespaces all adapter messages. Any event emitted to a room on one server instance is automatically delivered to clients connected to other instances via Redis pub/sub.

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
| `expressSessionRoomKey(sessionId)` | `expressSession:{sessionId}` | Target a specific browser session |
| `articleRoomKey(articleId)` | `article:{articleId}` | Target viewers of a specific article |
| `botTokenRoomKey(tokenId)` | `botToken:{tokenId}` | Target all sockets authenticated with a specific bot token |

For browser clients, the socket immediately joins its `expressSession:{sessionId}` room on connection. On `login`, it joins `user:`, `device:`, all `role:`, and all `community:` rooms for that user (via `joinAuthenticatedRooms`). For bot clients the same room set (minus `expressSession:`, plus `botToken:`) is joined inside the handshake middleware, before the `connection` event.

### Client-to-Server Events

| Event | Data | Callback | Description |
|---|---|---|---|
| `getSignableSecret` | none | `(secret: string)` | Server generates a cryptographically random hex string, stores it on `socket.data.signableSecret`, returns it to the client for device authentication |
| `cgPing` | none | `(timestamp: number)` | Returns `Date.now()` for client-side latency/clock-drift detection |
| `login` | `{ deviceId, secret, base64Signature }` | `("OK" \| "ERROR")` | Authenticates the socket. Verifies the device signature against the signable secret. On success, joins user/device/role/community rooms and sets user online status |
| `logout` | none | none | Leaves all rooms except the temporary community visitor room. Sets user offline if this was the last socket |
| `joinCommunityVisitorRoom` | `{ communityId }` | none | Joins the community room temporarily so a non-member viewing a public community receives its live events. Validated with Joi. Leaves the previous visitor room first (unless the user is a member of it) |
| `leaveCommunityVisitorRoom` | none | none | Leaves the temporary community visitor room (only if the user is not a member) |
| `prepareWalletRequest` | none | `(requestId: string)` | Generates a random wallet request ID for Web3 auth flows |

### Server-to-Client Events

| Event | Data | Description |
|---|---|---|
| `buildId` | `(backendBuildId: string, timestamp: number)` | Sent immediately on connection. Client compares build IDs to detect app updates |
| `cli*` (any event starting with "cli") | varies | All application events (messages, notifications, call updates, etc.) are prefixed with `cli` and dispatched through the `onAny` handler on the client |

### Event Emission (Server-Side)

The `EventHelper` class (`srv/repositories/event.ts`) is the primary mechanism for emitting events from the API server to connected clients. It uses `@socket.io/redis-emitter` to emit events without needing a direct Socket.IO server reference -- allowing any backend process (API, job workers) to send events:

```typescript
class EventHelper {
  #io = new Emitter(redisManager.getClient('socketIOPub'), { key: 'v2:' });

  async emit(event, target, except?) { ... }
  async userJoinRooms(userId, target) { ... }
  async userLeaveRooms(userId, target) { ... }
}
```

The `emit` method takes an event and a target specifying which rooms to broadcast to (by userIds, roleIds, communityIds, deviceIds, sessionIds, articleIds), with optional exclusions. The event's `type` field becomes the Socket.IO event name; the rest is the payload.

### Online Status & Heartbeat

- On `login`, `userHelper.setUserOnlineStatus(userId, 'online')` is called and the userId is added to the process-local `localOnlineUsers` set.
- On disconnect/logout, if no other sockets remain for that user (`io.sockets.adapter.rooms.get(userRoomKey(userId))?.size` is falsy), the user is set offline. Bot sockets are excluded from this path and handled via the bot-presence mechanism instead (see below).
- A 60-second interval calls `userHelper.touchUserOnlineStatus(userIds)` for all locally connected human users and re-syncs bot presence for all locally connected bot users.
- On graceful shutdown (`SIGTERM`, plus `unhandledRejection` / `uncaughtException`), all human users whose last remaining socket is on this instance are batch-set to offline, all bot users have their presence cleared, and every socket is disconnected before `io.close()` and `process.exit`.

### Tab Coordination

Multiple browser tabs share one Socket.IO connection. Coordination happens over a `BroadcastChannel('CG_WEBSOCKET_STATE')` shared between every tab (`src/data/appstate/webSocket.ts`) and the **service worker** (`src/service-worker.ts`), which acts as a referee. Only one tab (the "active" tab) holds the socket at any time; passive tabs mirror its connection state and do not process live events. See [Frontend Real-time → Tab Coordination](#tab-coordination-1) for the full protocol, including the visibility-based handoff and the service-worker referee.

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

---

## WebRTC / MediaSoup

**Source:** `srv/mediasoup.ts`, `srv/mediasoup/room.ts`, `srv/mediasoup/config.ts`

### Architecture

Common Ground uses **MediaSoup** as an SFU (Selective Forwarding Unit). The media server (`srv/mediasoup.ts`) is a standalone HTTPS process separate from the main API server. Multiple call servers can exist, each registered in the `callservers` database table.

The media server is **optional at deploy time**. In the self-host profile it sits behind the Compose profile `calls` (`CG_ENABLE_CALLS=false` leaves it out — see [docs/deployment §3.8](../deployment/README.md#38-optional-services-calls-and-blockchain)). Without it, no `callservers` row is fresh, so `getCallServerForScheduling` rejects with `SERVICE_UNAVAILABLE`; the instance config then ships `features.calls: false`, and the frontend hides every call entry point: the sidebar (`CallList`, `StartCallButton`) *and* the event path (`ScheduleEventModal` offers only `external` events, `AttendEventButton` drops its "Start Event"/"Join now" actions). `api`, `wsapi` and the job runner are otherwise unaffected — nothing in them talks to the media server directly (the coupling is the `callservers` / `calls` / `callmembers` tables plus `pg_notify`).

### Startup Sequence

1. `runExpressApp()` -- Creates an Express app with a `/rooms/:roomId` REST endpoint for fetching router RTP capabilities, plus a `/hello` health endpoint.
2. `runWebServer()` -- Creates an HTTPS server using TLS certificates (configured via `HTTPS_CERT_FULLCHAIN` / `HTTPS_CERT_PRIVKEY` env vars). Listens on port **4443** by default.
3. `runProtooWebSocketServer()` -- Creates a protoo WebSocket server on top of the HTTPS server for signaling. Max received frame/message size is 960 KB.
4. `runMediasoupWorkers()` -- Spawns MediaSoup workers (one per CPU core). Each worker optionally creates a `WebRtcServer` for multiplexing transports on a single port (controlled by `MEDIASOUP_USE_WEBRTC_SERVER` env var; enabled by default).
5. `updateServerStatus()` -- Periodically updates the `callservers` table with ongoing call count and network traffic stats.
6. `registerCallUpdateListener()` -- Listens for PostgreSQL `NOTIFY` events for live call config updates (slots, audio-only, etc.).

### MediaSoup Configuration

Defined in `srv/mediasoup/config.ts`:

- **Workers:** One per CPU core (`os.cpus().length`). mediasoup ≥ 3.16 removed the `disableLiburing` worker setting (it now relies on libuv's built-in io_uring), and `srv/mediasoup/config.ts` no longer defines it. `MEDIASOUP_DISABLE_LIBURING=true` survives only as a compatibility shim in `srv/mediasoup.ts` (~:180-186), which translates it into `process.env.UV_USE_IO_URING = '0'` — inherited by the spawned worker processes — unless `UV_USE_IO_URING` is already set explicitly.
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
4. **Close**: When the last peer leaves or all broadcasters leave (in broadcast mode), the room closes. On close, it emits either `'close'` (soft -- call the `softEndCall`) or `'forceClose'` (moderator-initiated -- calls `endCallForEveryone`).

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

When `getOrCreateRoom` is called, it checks `callHelper.getCallState(roomId)` and rejects the connection if `endedAt` is set. This prevents joining calls that have already ended in the database.

---

## Signaling (protoo)

**Source:** `srv/mediasoup/room.ts` (server), `src/util/RoomClient.tsx` (client)

protoo is used for all WebRTC signaling between the browser and the MediaSoup server. It provides a request/response and notification protocol over WebSocket.

### Connection URL

```
wss://{callServerUrl}:4443/?roomId={callId}&peerId={userId}&consumerReplicas=0&callCreator={creatorId}&callType={callType}
```

Built by `src/util/urlFactory.ts`. `consumerReplicas` is a debugging aid inherited from the mediasoup demo (it multiplies the consumers created per producer and is fixed room-wide by whoever connects first); the server clamps it to **[0, 4]**, with `NaN` or negative values falling back to `0` (`srv/mediasoup.ts` ~:339-348).

### Authentication Flow

Before any media operations, the client must authenticate:

1. Client sends `getSignableSecret` request -> server returns a cryptographically random hex string.
2. Client signs the secret using its device private key (`signApiSecret`).
3. Client sends `login` request with `{ deviceId, secret, base64Signature }`.
4. Server verifies the device and checks that `peerId === userId`.
5. On success, `peer.data._cgAuth = true`.

All subsequent requests (except `getSignableSecret` and `login`) require `_cgAuth === true`.

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
- **Authentication flow:**
  1. On `connect`, emit `cgPing` for clock sync.
  2. Emit `getSignableSecret` to get a challenge.
  3. Sign the secret with the device key.
  4. Emit `login` with `{ deviceId, secret, base64Signature }`.
  5. Track login state via `socket.cg_loggedin` (0 = not logged in, 1 = in progress, 2 = logged in).
- **Event routing:** Uses `socket.onAny()` to catch all events. Events are only dispatched when this tab is `active`/`active-throttled`; passive tabs ignore them. Events starting with `cli` are forwarded to the registered `clientEventHandler`. The `buildId` event has its own handler.
- **Reconnection logic:** Handles `disconnect` with reason-specific behavior:
  - `io server disconnect` -- Immediately reconnect.
  - `io client disconnect` -- Stay disconnected (intentional).
  - `transport close/error` -- Reconnect (state `connecting`) if online, disconnect if offline.
- **Connect-error handling:** socket.io keeps retrying (`reconnection: true`), but after 5 consecutive `connect_error`s while still in `connecting`, the displayed state is surfaced as `disconnected` so the UI does not claim "connecting" forever.
- **Disconnect detection:** A 59-second `cgPing` interval detects stale connections. If the last pong is >110 seconds old, forces reconnect. The same 110s staleness check runs when a stalled active tab becomes visible again.
- **Version detection:** When `buildId` from server differs from the client build, triggers `version-update` state.

### Tab Coordination

Exactly one tab (the "active" tab) holds the Socket.IO connection; every other tab is "passive" and mirrors the active tab's connection state without processing live events. Coordination uses a `BroadcastChannel('CG_WEBSOCKET_STATE')` shared by all tabs **and** the service worker (`src/service-worker.ts`), which acts as a referee.

**Participants and messages:**

- Each tab has a random `tabId` and a `tabState`. It broadcasts `TabToWorker` messages (`tabId`, `tabState`, optional `visible`, `socketState`, `lastEventTime`, `lastDisconnect`).
- The service worker broadcasts `WorkerToTab` messages assigning a `tabState` to a specific `tabId`, and relays `socketState` / `lastEventTime` / `lastDisconnect` so passive tabs and freshly opened tabs converge on the last known state.
- Tab states: `active`, `active-throttled`, `passive`, `passive-throttled`, `unknown`. `tabClosed` is a message value (sent on `beforeunload`), not a resting state. The `*-throttled` variants mark tabs whose heartbeat has slowed (backgrounded / timer-throttled).
- `lastEventTime` is persisted to `localStorage('CG_LAST_KNOWN_WS_CONNCETION')` (and mirrored via the `storage` event) for cross-tab awareness of the last event received.

**Service-worker referee (`src/service-worker.ts`):**

- Maintains a registry of known tabs (`tabId`, `tabState`, `visible`) plus an `alive` heartbeat map. Tabs that go silent for >4s are marked `*-throttled`; >70s are dropped.
- `selectNewActiveTabIfAppropriate()` promotes a passive tab to active whenever no active tab exists, preferring a `visible` passive tab. It is deliberately inert for the first 2.5s after the worker (re)starts, since the browser terminates idle workers and the registry must repopulate from heartbeats before any reassignment — otherwise a half-informed referee would fight the tabs' own collision handling.
- If the active tab's `socketState` has been stuck in `connecting` for >45s (a throttled background tab can stall there), the referee demotes it and hands the active role to a fresh passive tab.
- On worker `activate` (a new build), all currently-known tabIds are added to a `bannedTabIds` set, the registry is cleared, and every client is told to reload. Banned tabIds are ignored until they re-register with a new tabId.
- The referee only acts while `handleTabStates` is true (there are controlled window clients and tab handling has not been disabled via a `STOP_TAB_HANDLING` message).

**Tab-side handoff and collision handling (`webSocket.ts`):**

- **Visibility handoff:** when a `passive`/`passive-throttled` tab becomes `visible`, it immediately claims `active` and connects — the live connection follows the tab the user is looking at. An active tab that becomes visible after a long stall (last pong >110s old) forces a reconnect.
- **Born-visible tabs:** a tab that is foreground at first assignment never fires `visibilitychange`, so when it is initially assigned `passive` while visible it claims `active` on the spot.
- **Collision tie-break:** if two tabs both believe they are active, they resolve deterministically — the visible tab wins; with equal visibility the higher `tabId` wins. Exactly one side yields, demotes itself to passive, and disconnects its socket.
- **Ghost re-registration:** `reRegister()` abandons a banned tabId and negotiates a fresh one; used when the worker banned the tab at activation but the page keeps running (e.g. the worker's first install).
- In dev (`serviceWorkerManager.state === 'none'`, port 3000) there is no worker, so the single tab is forced `active` and only one tab is supported.

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
7. **Server cleanup:** On SIGTERM, `callHelper.resetCallServer` clears the server's association with active calls.

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
| `/getUnreadCount` | Get count of unread notifications |
| `/markAsRead` | Mark a single notification as read (emits `cliNotificationEvent` via Socket.IO) |
| `/markAllAsRead` | Mark all notifications as read (emits `cliNotificationEvent`) |
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

---

## Redis Pub/Sub & Data

**Source:** `srv/redis/index.ts`, `srv/redis/userdata.ts`

### Redis Instance

The system uses **one Redis instance** (`redis:6379`, override with `REDIS_URL`) for everything. It is shared by four clients with disjoint key spaces:

| Client Type | Key prefixes | Purpose |
|---|---|---|
| `session` | `sess:` | Express session storage |
| `socketIOPub`, `socketIOSub` | `v2:` (pub/sub only) | Socket.IO adapter pub/sub |
| `data` | `ud:`, `us:`, `online-user-addresses`, `ratelimit:`, `bot-*`, `captcha:`, `pluginRequest:`, `tmp:` | User online status, session tracking, rate limiting, captcha |

Until 2026-08-01 these were three identically configured instances (`redis-sessions`, `redis-socketio`, `redis-data`). Nothing is persisted (`--save ""`) and no eviction policy is set, so sessions and the captcha HMAC key are never evicted — but a Redis restart logs everyone out.

### RedisManager

The `RedisManager` class (`srv/redis/index.ts`) manages all Redis connections:

- Creates four clients: `session`, `socketIOPub`, `socketIOSub`, `data`
- `socketIOSub` is a `duplicate()` of `socketIOPub` (same connection config, separate client for subscribing)
- `isReady` promise resolves when all clients are connected
- Generates a random `instanceId` per process instance
- Exposes `get`, `set`, `del` convenience operations on any of the four clients
- Three of the four clients are created through `srv/redis/client.ts` (the
  fourth, `socketIOSub`, is `socketIOPub.duplicate()`, which inherits the same
  options), and that file pins `RESP: 2`. node-redis 6 defaults to RESP3;
  `@socket.io/redis-adapter` 8.3 is written against RESP2, so the protocol
  stays where node-redis 4 had it.
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
| `srv/redis/index.ts` | RedisManager: one Redis instance, four client objects |
| `srv/redis/userdata.ts` | UserDataManager for online status tracking |
| `srv/repositories/event.ts` | EventHelper: emit Socket.IO events from any process; `disconnectBotTokenSockets` |
| `srv/repositories/notifications.ts` | NotificationHelper: CRUD + web push delivery |
| `srv/entities/call.ts` | Call, CallMembership, CallPermissions entities |
| `srv/entities/callserver.ts` | CallServer entity |
| `srv/entities/device.ts` | Device entity (includes webPushSubscription) |
| `srv/entities/notifications.ts` | Notification entity |
| `srv/api/notifications.ts` | Notification REST API routes |
| `srv/common/enums.ts` | CallType, CallPermission enums |
| `src/data/appstate/webSocket.ts` | Frontend Socket.IO client (WebSocketManager), tab-side handoff & collision handling |
| `src/service-worker.ts` | Service worker: tab-coordination referee, web push display, precaching |
| `src/util/RoomClient.tsx` | Frontend protoo + mediasoup-client |
| `src/util/urlFactory.ts` | Builds protoo WebSocket URL |
| `src/context/CallProvider.tsx` | React context for call state management |
| `src/components/organisms/CallPage/CallPage.reducer.ts` | Call state reducer (peers, consumers, producers) |
| `src/views/CallPageView/CallPageView.tsx` | Call page view wrapper |
