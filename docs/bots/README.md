# Bot Accounts

> Status: verified against commit 523fceccd, 2026-07-25

Common Ground supports **bot accounts**: programmable actors that read and post
in community channels through a small, versioned bearer API and Socket.IO
stream. The platform provides identity, authentication, endpoints, and an event
stream; it does **not** host bot code.

This document describes the architecture and how the pieces integrate across the
schema, backend, real-time layer, and frontend. The **wire protocol** (bearer
format, request/response examples, rate limits, socket handshake, v1
exclusions) is specified separately in [`../BOT-API.md`](../BOT-API.md); this
README does not duplicate it.

---

## Table of Contents

1. [Design principle: a bot is a user](#design-principle-a-bot-is-a-user)
2. [Schema & entities](#schema--entities)
3. [Ownership flavors](#ownership-flavors)
4. [Provisioning & lifecycle](#provisioning--lifecycle)
5. [Community installation & channel access](#community-installation--channel-access)
6. [Tokens, hashing & bearer authentication](#tokens-hashing--bearer-authentication)
7. [Request principal & allowlist middleware](#request-principal--allowlist-middleware)
8. [Bot API v1 surface](#bot-api-v1-surface)
9. [Messaging restrictions & scope enforcement](#messaging-restrictions--scope-enforcement)
10. [Dynamic scope discovery](#dynamic-scope-discovery)
11. [Socket events & presence](#socket-events--presence)
12. [Rate limiting](#rate-limiting)
13. [Management UI](#management-ui)
14. [Operator configuration](#operator-configuration)
15. [Source map](#source-map)

---

## Design principle: a bot is a user

A bot is an ordinary `users` row with `is_bot = true`. It is **not** a parallel
account type with its own message table or ACL system:

- `messages.creatorId` remains a non-null FK to `users`; there are **zero**
  message-schema changes. Bot messages are ordinary messages and render through
  the same message, avatar, mention, member-list, and tooltip paths as a human
  (`src/context/UserDataProvider.tsx`, `src/data/databases/user.ts`).
- Channel access reuses the existing community membership, role, and
  channel-permission system. There is no bot-specific permission model.
- Bot-specific metadata lives in a satellite table `bots`, keyed 1:1 by
  `userId`, rather than as bot-only columns on `users`.

This means a disabled bot's `users`/`user_accounts` rows and all its messages
are **preserved** so history keeps rendering; only the `bots` satellite record
is soft-deleted (see [Lifecycle](#provisioning--lifecycle)).

---

## Schema & entities

Five migrations build the schema (all with `writer`/`reader` runtime grants):

| Migration | Adds |
|---|---|
| `1784037142000-addBotAccountsFoundation` | `users.is_bot`; `'bot'` value in `user_accounts_type_enum` and `users_displayaccount_enum`; the `bots` table |
| `1784038901000-addBotProvisioning` | `communities.allowUserBots`; `bots_platformpresencemode_enum`; the `bots_platform_communities` table |
| `1784040170000-addBotTokens` | the `bot_tokens` table |
| `1784056200000-unifyHumanAndBotUsernames` | shared case-insensitive username namespace across human and bot accounts |
| `1784141100000-addBotConnectionPresence` | `bots.connectedSocketCount`, `bots.lastConnectedAt`, non-negative check constraint |

### Entities

`srv/entities/bots.ts` — **`Bot`** (table `bots`):

| Column | Type | Notes |
|---|---|---|
| `userId` | uuid PK | 1:1 FK → `users(id)` `ON DELETE CASCADE` |
| `deviceId` | uuid, unique | FK → `devices(id)`; one stable synthetic device per bot |
| `ownerType` | enum | `community` \| `user` \| `platform` |
| `ownerId` | uuid null | community/user UUID, or `NULL` for platform |
| `platformPresenceMode` | enum null | `all` \| `selected`, only for platform bots |
| `description` | text null | public profile description (returned from this table, never copied to `users`) |
| `connectedSocketCount` | int | server-derived live socket count |
| `lastConnectedAt` | timestamptz null | last time a socket connected |
| `createdAt` / `updatedAt` / `deletedAt` | timestamptz | `deletedAt` is the **disabled** marker |

Partial index `idx_bots_active_owner (ownerType, ownerId) WHERE deletedAt IS NULL`
supports active-owner bot-count queries.

`srv/entities/bot-tokens.ts` — **`BotToken`** (table `bot_tokens`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | token metadata identity |
| `botUserId` | uuid | FK → `bots(userId)` `ON DELETE CASCADE` |
| `tokenHash` | char(64), unique, `select:false` | SHA-256 hex of the raw token |
| `name` | varchar(100) null | operator label |
| `lastUsedAt` | timestamptz null | throttled write |
| `createdAt` / `revokedAt` | timestamptz | `revokedAt` marks revoked |

Partial index `idx_bot_tokens_active_bot (botUserId) WHERE revokedAt IS NULL`.

`srv/entities/bots-platform-communities.ts` — **`BotPlatformCommunity`** (join
table `bots_platform_communities`) records the desired community subset for a
platform bot running in `selected` presence mode. Composite PK
`(botUserId, communityId)`, both FKs cascade-delete.

### Type touchpoints

- `User.isBot` is exposed in public user data; the frontend renders a badge
  (`src/components/atoms/BotBadge/BotBadge.tsx`).
- `UserProfileTypeEnum.BOT = 'bot'` and `Models.User.ProfileItemType` gain
  `'bot'`; a bot's `user_accounts` row has `type = 'bot'` with `data: null`.
- Bot usernames share the human, case-insensitively unique namespace
  (constraint `idx_user_accounts_principal_unique_username`); the repository
  maps a `23505` on that constraint to a username-taken error.

---

## Ownership flavors

| Flavor | `ownerType` | `ownerId` | Who may manage |
|---|---|---|---|
| **User bot** | `user` | owner's user UUID | only the owning session user |
| **Community bot** | `community` | community UUID | callers with `COMMUNITY_MANAGE_ROLES` in that community |
| **Platform bot** | `platform` | `NULL` | session users whose UUID is in `PLATFORM_OPERATOR_USER_IDS` |

Owner authorization is centralized in `_assertOwnerAuthorization`
(`srv/repositories/bots.ts`), which first asserts the actor is a non-deleted
human (`is_bot = false`) and then applies the per-flavor rule. Bots cannot own
bots or manage tokens — every management path requires a human session user
(`sessionUserId` in `srv/api/bots.ts`).

Platform bots have two presence modes:

- **`all`** — installed into every current community, and into newly created
  communities via reconciliation hooks.
- **`selected`** — installed only into the explicit `bots_platform_communities`
  subset; updating the selection adds/removes memberships automatically.

---

## Provisioning & lifecycle

### Creation

`botHelper.createBot` (`srv/repositories/bots.ts`) runs inside a transaction:

1. Authorize the actor for the requested owner flavor.
2. Serialize per owner with a transaction-scoped advisory lock
   (`pg_advisory_xact_lock` keyed on `bot-owner:<type>:<id>`) and enforce the
   active-bot limit (`_assertOwnerLimit`), closing the count-then-insert race.
3. Call `userHelper.createBotUserInTransaction`, which atomically creates the
   `users` row (`is_bot = true`), the `'bot'` `user_accounts` profile, a stable
   synthetic **device**, and the `bots` satellite row. The device's public key
   is a freshly generated **P-384 ECDSA** JWK whose private key is discarded —
   bot tokens never use the human device-signature login flow
   (`_createBotDevicePublicKey`, `srv/repositories/users.ts`).
4. Community bots are installed into their owner community immediately;
   platform bots are reconciled to their presence configuration.

Human/bot invariants are enforced in `_createUser`: a bot row must have exactly
one `'bot'` account, no email/password/passkey/wallet/newsletter, and
`displayAccount = 'bot'`; a human row may never carry any bot-only data.

### Update

`botHelper.updateBot` changes username, image ID, public description, and (for
platform bots) presence mode/subset. Ownership flavor and owner cannot change.
Changing platform presence triggers reconciliation.

### Disable (delete)

There is no hard delete. `botHelper.disableBot`:

- sets `bots.deletedAt`;
- revokes every active token (`bot_tokens.revokedAt = now()`);
- removes the bot from every community through the full membership-removal path
  (`_removeMembership` maintains `communityOrder`, `user_community_state`,
  `user_channel_settings`, `communities.memberCount`, and emits leave events);
- disconnects each token's live sockets (`eventHelper.disconnectBotTokenSockets`);
- **preserves** the `users`, `user_accounts`, and all message rows.

The authentication join requires a non-deleted `bots` row, so a disabled bot can
never authenticate again. Public user fetches still return the bot (its `users`
row is not soft-deleted), so historical messages keep rendering with its
identity.

### Cascading disable

- Disabling/deleting an owning **user** or **community** disables that owner's
  bots via `botHelper.disableBotsForOwner`.
- Removing a platform bot from one configured community removes only that
  presence; disabling the platform bot disables it everywhere.

Re-enabling a disabled bot is not implemented.

---

## Community installation & channel access

Bots are community members like any user; a bot's channel access is exactly the
union of its assigned roles' channel permissions. There is no per-bot ACL.

- **Membership bookkeeping** is centralized in `_installMembership` /
  `_removeMembership`, which reuse the full join/leave accounting (member role
  assignment, `communityOrder`, `user_community_state`, `memberCount`, socket
  rooms, and `cliMembershipEvent` / `cliCommunityEvent` emissions). Installs and
  removes never touch `roles_users_users` in isolation.
- **Community bots** can only be installed into their owner community
  (`_assertBotPolicy`).
- **User bots** can be installed into a target community only when
  `allowUserBots = true` there and the owning user is an active member; a user
  bot's assigned channel permissions may **not** exceed the owner's effective
  permissions (`_assertRoleSetAllowed` computes the permission set difference
  and rejects any excess).
- **Platform bots** are installed by reconciliation according to their presence
  mode, not by manual install/remove.

Channel selection is expressed by assigning existing community **custom roles**
(`setRoles`); the predefined Member role is managed automatically and the
predefined Public role's permissions are always included in the owner-permission
baseline.

### Guarding the generic role path

Because bots are ordinary members, the generic community role-assignment and
role-removal repository paths call `botHelper.guardGenericRoleAssignment` /
`guardGenericRoleRemoval` (invoked from `srv/repositories/communities.ts`) so a
manager cannot bypass the bot install rules by editing `roles_users_users`
directly. These guards re-run the policy, install, and (for user bots)
effective-access checks.

### Reconciliation

`srv/repositories/bots.ts` exposes idempotent reconcilers, hooked from
community lifecycle events in `srv/repositories/communities.ts`:

| Reconciler | Trigger |
|---|---|
| `reconcilePlatformBot` | platform bot presence change |
| `reconcilePlatformBotsForCommunity` | a new community is created (installs `all`-mode platform bots) |
| `reconcileUserBotsForOwner` | an owner's membership/roles change |
| `reconcileAllUserBotsInCommunity` | `allowUserBots` toggled off, or community-wide role/permission changes |

When `allowUserBots` is turned off, user-owned bot memberships in that community
are removed and their live rooms reconciled. When an owner loses membership or
roles, the owner's bots are removed or have excess roles stripped, and the
change is pushed to live sockets. REST and socket authorization always re-check
the current owner/gate/role state, so delayed reconciliation can never grant
access in the interim.

---

## Tokens, hashing & bearer authentication

Token management lives in `srv/repositories/botTokens.ts`.

- **Format:** `cgb_<base64url of 32 random bytes>` (validated by
  `/^cgb_[A-Za-z0-9_-]{43}$/`). The raw token is returned exactly **once** by
  `tokens/issue`.
- **Storage:** only the **SHA-256** hex digest of the full raw token is stored
  (`tokenHash`, `char(64)`, `select:false`). SHA-256 is appropriate because the
  input is high-entropy; a password KDF would add cost without benefit. The hash
  is never returned or logged; list endpoints return metadata only.
- **Issue** serializes per bot with an advisory lock and enforces
  `BOT_ACTIVE_TOKEN_LIMIT`.
- **Revoke** sets `revokedAt` and then disconnects that token's live sockets.

`authenticate(rawToken)` validates the format, hashes, and runs a single joined
query that requires all of: an unrevoked `bot_tokens` row, a non-deleted `bots`
row, a non-deleted `users` row with `is_bot = true`, the bot's stable
non-deleted device, **and** an active owner (a non-banned non-deleted human for
user bots, a non-deleted community for community bots, always-true for platform
bots). Only when every condition holds does it return a principal. `lastUsedAt`
is updated with a write throttle (~5 min) to avoid a write per request. The same
repository authenticates both REST and Socket.IO.

---

## Request principal & allowlist middleware

Bot bearer auth is a **separate request principal**, never a synthetic human
session. Two middlewares in `srv/util/botPrincipal.ts` bracket the request
pipeline (`srv/util/express.ts`):

1. **`botAuthenticationMiddleware`** (before the session layer):
   - No `Authorization` header → fall through to the normal cookie/session path
     unchanged.
   - Authorization header **plus** a session cookie → HTTP **400**.
   - Malformed header or invalid/revoked/disabled token → HTTP **401** (a real
     status code, before the `{ status: 'ERROR' }` route wrapper).
   - Valid token → attaches `request.botPrincipal = { kind: 'bot-token', user:
     { id, deviceId }, tokenId }`.

   When a bot principal is present, the session, passport-initialize,
   passport-session, and `session.createdAt` middlewares are all **skipped**, so
   bot requests create no Express session or cookie.

2. **`botAllowlistMiddleware`** (after the session layer): if a bot principal is
   present, the request must match a route registered via `allowBotRoute(method,
   path)`; otherwise HTTP **403**. The allowlist is an in-memory set populated at
   import time by `srv/api/botV1.ts` and `srv/api/messages.ts`. Being a normal
   `users` row does not let a bot token reach human endpoints — the allowlist is
   the authoritative HTTP surface, and a bot's assigned roles never expand it.

---

## Bot API v1 surface

The public bearer protocol is mounted at `/BotV1` (`srv/api.ts`,
`app.use('/BotV1', botV1Router)`). The nginx configs expose it publicly as
`/api/bot/v1/…`, rewriting to `/BotV1/…`
(`docker/nginx/nginx.conf`, `nginx_selfhost.conf`, `nginx_dev.conf`), kept
deliberately separate from the web app's `/api/v2` namespace. The protocol
version constant is `'1'` (`srv/common/botProtocol.ts`).

`botV1Router` rejects any request without a bot principal (403) and exposes:

| Route (`/BotV1/…`) | Purpose |
|---|---|
| `POST /whoami` | returns `protocolVersion`, `userId`, `deviceId`, `tokenId` |
| `POST /scopes/list` | paginated list of reachable community channels |
| `POST /messages/*` | the six allowed message operations (below) |

Human **management** is a distinct surface: `POST /api/v2/Bot/…`
(`srv/api/bots.ts`, session-authenticated) covering
`list`, `listCommunityBots`, `listInstallableUserBots`, `create`, `update`,
`disable`, `install`, `remove`, `setRoles`, `setAllowUserBots`, and
`tokens/{issue,list,revoke}`. See [`../BOT-API.md`](../BOT-API.md) for the full
request/response contract of both surfaces.

---

## Messaging restrictions & scope enforcement

Bot principals are enabled on exactly six message routes, registered via
`allowBotRoute('POST', '/BotV1/messages/…')` in `srv/api/messages.ts`:
`loadMessages`, `messagesById`, `loadUpdates`, `createMessage`, `setReaction`,
`unsetReaction`. The `/BotV1/messages` path mounts the **same** `messageRouter`
the web app uses, so bot and human message logic is shared; the difference is in
principal resolution.

`getMessageRequestUser` gates every bot message request:

1. If there is no bot principal, use `request.session.user` (human path
   unchanged).
2. Reject any access object that is not **exactly** `{ communityId, channelId }`
   (`isExactCommunityChannelAccess` — key-set checked, so chat/DM, call, and
   article variants are refused even for a valid token).
3. Enforce the per-token rate limits (API always, plus message limit on creates).
4. `botHelper.assertActiveCommunityAccess(botUserId, tokenId, communityId)`
   re-checks, in one transaction: the bot is active, the token is unrevoked, the
   bot policy holds (community-owner match / `allowUserBots` + active owner
   membership / selected-presence membership), and the bot is installed.
5. Ordinary channel read/write permission checks then run through the shared
   `_checkAccessOrThrow` path, exactly as for humans.

A created bot message emits the standard `cliMessageEvent` with an added
`creatorIsBot: true` flag (`srv/api/messages.ts`). Edit and delete are **not** in
the bot allowlist. Every request is re-validated, so a previously discovered
channel never grants standing access.

---

## Dynamic scope discovery

`POST /BotV1/scopes/list` (`botHelper.listScopes`) is the server-authoritative
answer to "where can this bot act right now". It:

1. Recomputes the bot's active communities and roles via
   `getActiveSocketRoomIds` (which applies the same policy/install checks per
   community and silently skips any that fail).
2. Selects the distinct `(communityId, channelId)` pairs where the bot's roles —
   or the predefined Public role — grant **both** `CHANNEL_EXISTS` and
   `CHANNEL_READ`.
3. Returns `items` (`communityId`, `communityTitle`, `channelId`,
   `channelTitle`) with keyset pagination via an opaque `nextCursor`.

Titles are informational; clients route by ID. Because messaging re-checks
access on every call, a cached scope list can never widen access — it only tells
the client where to look.

Scope changes are pushed live: `cliBotScopesEvent` with `action: 'refresh'` is
emitted to the bot's user room on join, leave, and role-change events
(`_emitJoin`, `_emitLeave`, `_emitRoleChange` in `srv/repositories/bots.ts`),
instructing the client to re-enumerate.

---

## Socket events & presence

Bot sockets authenticate during the Socket.IO handshake, not via cookies
(`srv/wsapi.ts`):

- The token is read from `socket.handshake.auth.token`; a token present together
  with a cookie header fails the handshake (`unauthorized`).
- `socket.handshake.auth.protocolVersion` must equal `'1'`, else
  `unsupported_bot_protocol`.
- `botTokenHelper.authenticate` validates the token, then
  `getActiveSocketRoomIds` computes the bot's current community and role rooms.
- `joinAuthenticatedRooms` joins the shared post-auth rooms (device, user, roles,
  communities) plus a **token-specific room** (`botTokenRoomKey(tokenId)`) used
  for targeted revocation disconnects.

**Supported v1 event contract:** `cliMessageEvent` (actions `new` / `update` /
`delete`, carrying `communityId`; `new` includes `creatorIsBot`) and
`cliBotScopesEvent` (`refresh`). Other internal frontend events may arrive on
shared rooms but are not part of the public contract. Live room membership is
reconciled — and sockets disconnected — on role, membership, `allowUserBots`,
owner-access, platform-presence, token-revoke, and bot-disable changes, so
access never lags behind a permission change.

### Connection presence

An authenticated bot socket drives the bot's visible **connection** presence,
tracked separately from human online/away/busy/invisible semantics:

- `bots.connectedSocketCount` and `lastConnectedAt` are updated by
  `setBotConnectionPresence` / `syncBotConnectionPresence` (`srv/wsapi.ts`),
  derived from the count of live token-authenticated sockets. Per-server Redis
  leases keep the count consistent across multiple websocket servers, and a
  shutdown / stale-cleanup path resets counts to 0.
- Bots are **not** added to `localOnlineUsers` and never call
  `setUserOnlineStatus`; bot connectivity does not create human presence.
- The `bots` view surfaces a `connectionStatus` of `connected` (when the bot
  user is online and at least one socket is live) or `offline`. This is pure
  transport state: REST activity cannot make a bot appear connected, and the bot
  cannot self-report it.

See [`../realtime/README.md`](../realtime/README.md) for the shared Socket.IO
infrastructure.

---

## Rate limiting

Per-token fixed-window (1 minute) limits in `srv/util/botRateLimit.ts`, keyed in
Redis by token ID (not source IP, so shared hosting/NAT does not merge unrelated
bots):

| Scope | Default | Env var |
|---|---:|---|
| all allowed bearer REST calls | 120/min | `BOT_API_RATE_LIMIT_PER_MINUTE` |
| `createMessage` (extra message budget) | 30/min | `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` |

A created message consumes one unit from **both** budgets. Exceeding a limit
raises `RATE_LIMIT_EXCEEDED` in the response envelope.

---

## Management UI

v1 management is available both via the session API and a frontend UI (the UI
was added after the initial API/CLI-only roadmap slices):

| Surface | Location |
|---|---|
| User's own bots | `src/components/organisms/UserSettingsModalContent/BotsPage/` (`BotsPage.tsx`, `BotEditor.tsx`) |
| Community bots tab | `src/components/templates/CommunityLobby/BotManagement/BotManagement.tsx`, embedded in `CommunitySettings` and routed at `…/bots/` via `views/BotManagementView/BotManagementView.tsx` |
| API client | `src/data/api/bot.ts` (`BotApiConnector`) |
| Bot badge | `src/components/atoms/BotBadge/BotBadge.tsx` |

The community UI lists installed bots with ownership metadata and assigned custom
role IDs, and lets managers enable/disable user bots and install/remove/assign
roles. The user bots page lets an owner create/update/disable bots and manage
tokens. The management UI also shows the owner the authenticated connection count
and last connection time. Hidden follow/DM controls on bot profiles are a UI
convenience only; the backend allowlist and permission checks are authoritative.

---

## Operator configuration

Self-hosted deployments set these in `docker/.env.selfhost` (read in
`srv/serverconfig.ts`), then recreate services. Existing `.env.selfhost` files
are never overwritten by the initializer, so add these manually when upgrading.

| Variable | Default | Meaning |
|---|---:|---|
| `PLATFORM_OPERATOR_USER_IDS` | empty | comma-separated human user UUIDs allowed to manage platform bots; empty disables platform-bot mutation entirely |
| `BOT_USER_OWNER_LIMIT` | 5 | active bots per user owner |
| `BOT_COMMUNITY_OWNER_LIMIT` | 10 | active bots per community owner |
| `BOT_PLATFORM_OWNER_LIMIT` | 10 | active platform bots |
| `BOT_ACTIVE_TOKEN_LIMIT` | 10 | active tokens per bot |
| `BOT_API_RATE_LIMIT_PER_MINUTE` | 120 | allowed REST calls per token/minute |
| `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` | 30 | message creates per token/minute |

`PLATFORM_OPERATOR_USER_IDS` is configuration, not a secret, but it grants
platform-wide bot control and should be treated carefully.

---

## Source map

| Concern | Files |
|---|---|
| Entities | `srv/entities/bots.ts`, `srv/entities/bot-tokens.ts`, `srv/entities/bots-platform-communities.ts` |
| Migrations | `srv/migrations/17840371420*`, `17840389010*`, `17840401700*`, `17840562000*`, `17841411000*` |
| Management API | `srv/api/bots.ts`, `srv/validators/api/bot.ts` |
| Bearer API v1 | `srv/api/botV1.ts`, `srv/util/botProtocol.ts`, `srv/common/botProtocol.ts` |
| Provisioning / lifecycle / reconciliation | `srv/repositories/bots.ts`, `srv/repositories/users.ts` (`createBotUser*`) |
| Tokens & auth | `srv/repositories/botTokens.ts` |
| Principal & allowlist | `srv/util/botPrincipal.ts`, `srv/util/express.ts` |
| Messaging | `srv/api/messages.ts` |
| Rate limiting | `srv/util/botRateLimit.ts` |
| Sockets & presence | `srv/wsapi.ts`, `srv/repositories/event.ts` (`disconnectBotTokenSockets`) |
| Community hooks | `srv/repositories/communities.ts` (guard/reconcile calls) |
| Frontend | `src/data/api/bot.ts`, `src/components/**/Bot*`, `src/views/BotManagementView/` |
| Protocol spec | [`../BOT-API.md`](../BOT-API.md) |
