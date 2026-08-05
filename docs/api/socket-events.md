# Socket (realtime) event catalog

The realtime channel is socket.io at path `/api/ws/` (default namespace,
transports `["polling","websocket"]`). It is push + auth + heartbeat only —
all writes are REST. This catalog is hand-maintained (the events are TS types,
not runtime-introspectable) and each entry cites the conformance test that
proves it.

Source of truth: `srv/wsapi.ts`, `srv/repositories/event.ts`,
`src/common/types/events/*.d.ts`. SDK: `@commonground/client`
`RealtimeClient`.

## Connection & auth

| Aspect | Value |
| --- | --- |
| Path | `/api/ws/` |
| Namespace | default (`/`) |
| Human auth | request cookie attaches the socket to the express session; **authenticated room membership requires the in-band `login`** below |
| Bot auth | handshake `auth: { token, protocolVersion: "1" }`, **no cookie** (mutually exclusive) |
| Version mismatch | bot handshake with wrong `protocolVersion` → `connect_error` `unsupported_bot_protocol` |
| Heartbeat | engine.io ping 15s/15s; app-level `cgPing` ack returns server `Date.now()` |
| Greeting | `buildId` emitted on every connect — **positional** args `(buildId: string, serverTime: number)`, not an object |

Wire encoding (critical): the server emits `io.to(rooms).emit(type, payload)`
where the socket.io **event name is the `type` string** and the payload object
**omits `type`**. The SDK router reassembles `{type, ...payload}`.

Rooms are server-managed: on `login` (or bot handshake) the socket joins its
user/role/community/device rooms; role/community changes move it via
`userJoinRooms`/`socketsJoin`. The only client-driven room ops are
`joinCommunityVisitorRoom` / `leaveCommunityVisitorRoom`. There is no
per-channel subscribe.

## Client → server (ack-callback RPCs; session clients)

| Event | Request | Response | Proven by |
| --- | --- | --- | --- |
| `getSignableSecret` | — | `secret: string` (64-hex) | r2-realtime "connects…logs in" |
| `login` | `{ secret, deviceId, base64Signature }` | `"OK"` \| `"ERROR"` | r2-realtime "connects…logs in", "bad signature rejected" |
| `logout` | — | — | (covered by HTTP logout tests) |
| `cgPing` | — | `serverTime: number` | r2-realtime "connects…answers cgPing" |
| `joinCommunityVisitorRoom` | `{ communityId }` | — | — |
| `leaveCommunityVisitorRoom` | — | — | — |
| `prepareWalletRequest` | — | `requestId: string` | — |

## Server → client (`cli*` events)

Payloads below are the object **minus `type`**. Most are
`{ action, data }`; the ones marked *flat* have no wrapper.

| Event name | Shape summary | Proven by |
| --- | --- | --- |
| `cliMessageEvent` | `new` / `update` / `delete` message in a channel | r2-realtime message round-trips, two-client A→B |
| `cliCommunityEvent` | `new-or-full-update` / `update` / `delete` community | r2-realtime (community create hydration) |
| `cliChannelEvent` | `new` / `update` / `delete` channel | store-applied (R2) |
| `cliAreaEvent` | `new` / `update` / `delete` area | catalog-only |
| `cliRoleEvent` | `new` / `update` / `delete` role | catalog-only |
| `cliPluginEvent` | `new`/`update`/`delete`/`dataUpdate`/`dataDelete` | catalog-only |
| `cliMembershipEvent` | `join`/`leave`/`roles_added`/`roles_removed` | r2-realtime "B sees A's membership join" |
| `cliMyRolesEvent` | *flat* `{ communityId, rolesGained, rolesLost }` | catalog-only |
| `cliChatEvent` | `new` / `update` / `delete` DM chat | r3-content DM delivery |
| `cliChannelLastRead` | *flat* `{ channelId, lastRead }` | r2-realtime cross-device read cursor |
| `cliNotificationEvent` | `new` / `update` / `allread` / `delete` | r3-content Follower notification |
| `cliUserData` | `{ data: Partial<UserData> & {id} }` (presence) | store-applied (R2/R3) |
| `cliUserOwnData` | `{ data: Partial<OwnData> }` | store-applied (R2) |
| `cliWalletEvent` | `new` / `update` / `delete` wallet | catalog-only |
| `cliCallEvent` | `new` / `update` / `delete` call | catalog-only (see protoo for media) |
| `cliBotScopesEvent` | bot token scope change | catalog-only |
| `cliCgIdSignResponse` | `{ frontendRequestId, data }` passkey handshake | catalog-only |

Client-synthesized names that are **never on the wire** (do not add wire
listeners): `cliConnectionLost`, `cliConnectionEstablished`,
`cliConnectionRestored`.
