# Roadmap: Bot Accounts

> **Audience:** the implementing agent/developer. This document assumes **zero prior context** — read it fully before writing code.
> **Status:** planned & approved 2026-07-14; amended after a code-backed implementation review on 2026-07-14. The identity architecture in §2 is locked (agreed with the product owner and CTO). The security, lifecycle, and delivery rules in this revision close gaps found in the current codebase.
> **Process:** you implement; a separate reviewer agent reviews every PR. Work in slices (§8), one PR per slice.

---

## 1. What we're building

Common Ground currently has only human user accounts. We're introducing **bot accounts**: programmable actors that post/read/react in community channels via an API, written and hosted by third-party bot authors. We provide identity, authentication, endpoints, and an event stream; we do **not** host bot code.

Three ownership flavors share one identity mechanism:

| Flavor | Owner | Presence rule |
|---|---|---|
| **Community bot** | a community | lives in its owning community; a community manager chooses its roles/channels |
| **User bot** | a user | can be installed only with community approval, only while user-owned bots are allowed, and never with effective channel access beyond its owner |
| **Platform bot** | the instance/platform | configurable: present in all communities or an explicit subset, reconciled for existing and newly created communities |

**v1 bot capability scope:** read channel messages, receive live channel-message events, post channel messages, reply in threads, and set/unset reactions.

The following are **not** bot-token capabilities in v1: DMs/chats, calls, articles, moderation actions, follows, account/security settings, KYC, premium/token-sale flows, notifications/push registration, community administration, and arbitrary human-authenticated endpoints. Existing endpoints often accept several context types, so bot authorization must reject non-community-channel access objects even when a bot has a valid token.

**Management scope:** v1 bot management is session-authenticated API/CLI only. There is no bot-management frontend in these slices. Slice 6 must provide operator/bot-author documentation; a management UI can be planned separately.

## 2. Core identity architecture (locked)

**A bot is a normal user.** Rewriting the message table with a nullable `creatorId` would force UI rebuilds throughout the application, while a users row gets the existing frontend user-cache and rendering machinery for free. Therefore:

- `users` gets a boolean **`is_bot`** (`NOT NULL DEFAULT false`). Otherwise bots are ordinary rows in `users`.
- `user_accounts` gets a profile type **`'bot'`**.
- Bot-specific metadata lives in the satellite table **`bots`**, keyed 1:1 by `userId`; it does not become a collection of bot-only columns on `users`.
- `messages.creatorId` remains a non-null FK to `users`; there are **zero message-schema changes**. Bot messages are ordinary messages.
- Channel access continues to use the existing community membership, role, and channel-permission system. There is no parallel bot ACL system.

The frontend resolves `creatorId`/userId through `useUserData` and the user-data cache (`src/context/UserDataProvider.tsx`, `src/data/databases/user.ts`). A real, non-deleted users row therefore renders through the same message, avatar, mention, member-list, and tooltip paths as a human.

### 2.1 Lifecycle decision

The public bot identity must survive deactivation so historical messages keep rendering. A bot **disable** operation, exposed to API clients as delete/disable, must:

- set `bots.deletedAt`;
- revoke every active token and disconnect active token-authenticated sockets;
- remove the bot from every community through the normal membership-removal path, including member counts, `communityOrder`, community state, events, and socket rooms;
- prevent all future bot authentication; and
- preserve the `users` and `user_accounts` rows and all messages.

Do not hard-delete a bot user: `messages.creatorId` currently cascades on user deletion, which would delete message history. Do not soft-delete the users row either: public user fetches exclude soft-deleted users and would render the bot as `<missing-user>`.

Disabling the owning user disables all of that user's bots. Deleting/disabling an owning community disables its community bots. Removing a platform bot from one configured community removes only that presence; disabling the platform bot disables it everywhere. Re-enabling a disabled bot is deferred unless explicitly added to a later roadmap.

### 2.2 Authentication boundary decision

Bot bearer authentication is a separate request principal; it is **not** a synthetic human login session.

- Never assign a bearer-authenticated bot to `request.session.user`.
- Add an explicitly typed request principal, for example `{ kind: 'bot-token', user: { id, deviceId }, tokenId }`, and a helper used only by bot-capable routes.
- Session-only owner/operator endpoints must require `request.session.user` and must reject bot principals.
- Bot bearer requests must bypass Express session creation/persistence; this app currently has `saveUninitialized: true` and always writes `session.createdAt`, so merely mutating and later clearing the session is not sufficient.
- Reject requests that contain both a bot bearer token and a session cookie. Do not silently choose one identity.
- A valid bot token presented to a route outside the explicit bot allowlist returns 403. Invalid, malformed, disabled, or revoked bot credentials return an actual HTTP 401 before the normal `{ status: 'ERROR' }` route wrapper.
- No Authorization header leaves the existing cookie/session path unchanged.

The initial bot allowlist is limited to the Slice 3 identity check and the community-channel operations enabled in Slice 4. Being a normal users row does not mean a bot token can call every human endpoint.

## 3. Repository orientation

- **Monorepo:** React frontend in `src/`, Node/TypeScript backend in `srv/`, Docker deployment in `docker/`. `src/common` and `srv/common` are hard-linked in this checkout; editing either path updates the same inode. Keep the conceptual client/server API contract in sync and do not accidentally apply the same patch twice.
- **Backend services:** `api`, `wsapi`, `onchain`, `job-runner`, `memberlist`, `mediasoup`, and one-shot `migrate-db`, all built from `cryptogram/backend`.
- **DB:** Postgres. Entities are auto-discovered by the glob in `srv/util/datasource.ts`; a new `srv/entities/*.ts` file needs no manual registration list. Runtime repositories use raw SQL and runtime DB roles, so new tables require the same `reader`/`writer` grants as surrounding migrations.
- **REST auth today:** Express session cookies. Route handlers generally read `request.session.user` themselves; `registerPostRoute` validates the body but does not authenticate or set HTTP error codes.
- **Socket auth today:** `srv/wsapi.ts` requires a cookie at connection time and then handles a device-key challenge in the `"login"` event. A cookieless bot cannot currently reach that event.
- **Permissions:** role-based per community. Community membership is more than a role insert: it also maintains `users.communityOrder`, `user_community_state`, `communities.memberCount`, events, and socket rooms.
- **Branching:** base every slice on `develop`; target PRs to `develop`, never `main`. Use the branch names in §8.
- **Reference deployment:** `https://cg.mogged.eu` is live production. Prefer rollback-only verification or disposable schema/database copies and clean up any committed test data.

## 4. Target data model

```text
users
  + is_bot boolean NOT NULL DEFAULT false

user_accounts
  type enum gains 'bot'
  displayName + imageId remain the bot's ordinary display profile

bots
  userId       uuid PK, FK -> users(id) ON DELETE CASCADE
  deviceId     uuid NOT NULL UNIQUE, FK -> devices(id)
  ownerType    enum('community','user','platform') NOT NULL
  ownerId      uuid NULL              -- communityId | userId | NULL for platform
  description  text NULL              -- public profile description
  createdAt / updatedAt / deletedAt

bot_tokens
  id           uuid PK
  botUserId    uuid FK -> bots(userId) ON DELETE CASCADE
  tokenHash    char(64) NOT NULL UNIQUE
  name         varchar(100) NULL
  lastUsedAt   timestamptz NULL
  createdAt / revokedAt

communities
  + allowUserBots boolean NOT NULL DEFAULT false

platform bot presence config
  persisted desired mode: all communities or explicit community subset
  actual access remains ordinary membership + role assignment
```

Schema invariants and indexes:

- `ownerId IS NULL` iff `ownerType = 'platform'`; it is non-null for community/user owners.
- Because `ownerId` is polymorphic, repository operations must validate the referenced active owner in the correct table. If implemented with a DB trigger, keep the repository validation too for useful errors.
- Token authentication joins active `bot_tokens`, active `bots`, non-deleted `users`, `users.is_bot = true`, and the stored active bot device.
- `users.is_bot`, the `'bot'` display account, the `user_accounts` bot row, and the active/disabled `bots` row are created or changed atomically. Human users may never acquire a bot account type.
- Bot display names are case-insensitively unique among bot profiles, including disabled bots (names remain reserved with the historical identity). Add an index equivalent to the CG-name index for `type = 'bot'`.
- Add lookup indexes for active owner bot counts, active tokens, and presence reconciliation.
- Apply runtime DB grants for both new tables.

`description` is public and must be returned by the profile-details API from the `bots` satellite record without copying it into `users`. Ownership identifiers do not need to be public.

### 4.1 Stable device semantics

Use one stable device row per bot, stored as `bots.deviceId`, not one device per token. All tokens for the bot share it for message echo suppression. The creation repository should generate a valid synthetic P-384 public JWK and discard the private key; bot tokens never use the human device-signature flow. Revoking one token does not delete the shared device. Disabling the bot makes the device unusable through the active-bot authentication join.

### 4.2 Type touchpoints

- Both Postgres enums gain `'bot'`: `user_accounts_type_enum` and `users_displayaccount_enum`.
- Add `BOT = 'bot'` to `UserProfileTypeEnum`.
- Add `'bot'` to `Models.User.ProfileItemType`.
- Add a bot variant to `CreateUserAccountData` with `data: null` and `extraData: null`; the public description comes from `bots`.
- Add `isBot` to public user data when frontend support is delivered, and add a typed bot profile-details shape for the public description.

## 5. Ownership, provisioning, and presence policy

### 5.1 Owner authorization

- **User bot:** only the owning session user may create/update/disable the bot or manage its tokens.
- **Community bot:** require the caller to have `COMMUNITY_MANAGE_ROLES` in the owning community; do not key authorization to a role title.
- **Platform bot:** require a session user whose UUID appears in optional `PLATFORM_OPERATOR_USER_IDS`. With no configured IDs, platform-bot mutation endpoints are disabled. IDs are configuration, not secrets, but must be documented in self-host configuration.
- Bots cannot own bots or mint/manage tokens.

Use configurable, transaction-safe active-bot limits with defaults of 5 per user owner, 10 per community owner, and 10 platform bots. Serialize count-and-create per owner (transaction/advisory lock); a query followed by an unlocked insert is raceable. Also set a configurable active-token limit per bot with a documented default.

### 5.2 Community installation and channel access

- A dedicated bot installation/removal repository path must reuse/refactor the complete community join/leave bookkeeping; do not implement membership as a bare `roles_users_users` insert/delete.
- Community bots are installed only into their owner community.
- Platform bots follow their persisted presence configuration. Reconciliation is idempotent, covers existing communities when configuration changes, and hooks newly created communities. Failed partial reconciliation must be retryable and observable.
- A user bot can be installed only by a session user with `COMMUNITY_MANAGE_ROLES` in the target community, only if `allowUserBots = true`, and only while the owning user is an active member.
- Channel selection is expressed by assigning existing community roles after the Member role exists. If an exact channel set has no existing role representation, the community manager must create a suitable role; do not add a parallel per-bot channel ACL.
- A user bot's effective channel permissions may not exceed its owner's effective permissions. Validate this at installation/role update and reconcile it when the owner loses membership/roles. REST authorization must still re-check the active owner and community gate so delayed reconciliation cannot grant access.
- Turning `allowUserBots` off removes all user-owned bot memberships from that community and disconnects/reconciles their sockets there.
- Generic role-assignment endpoints must detect bot targets and apply the same ownership, gate, and effective-access rules; otherwise they would bypass the bot installation API.
- Bots count as community members because they are ordinary users. Join/leave must update `memberCount` consistently.

## 6. Token and API security policy

- Token format: `cgb_<base64url random>`, using at least 32 random bytes. Return the raw token exactly once.
- Store only SHA-256 of the complete raw token. SHA-256 is appropriate here because the input has high entropy; password hashing would add cost without compensating for low-entropy input.
- Never return or log `tokenHash`; list endpoints return metadata only.
- Issue/list/revoke endpoints are session-only and use §5.1 owner authorization.
- Update `lastUsedAt` with a write-throttle; REST and socket authentication share the same token repository.
- Revocation is immediately effective for REST. Once sockets exist, revocation also disconnects the token-specific socket room.
- Add configurable per-token API/message rate limits. Rate-limit keys are token IDs/hashes, not source IPs, so shared hosting/NAT does not merge unrelated bots.
- Bot message routes accept only `MessageAccess` containing `communityId` + `channelId`. Reject chat, call, and article variants before invoking shared message logic.
- Bot principals cannot call moderation-message, community-management, account, follow, chat, KYC, premium, or notification endpoints.

## 7. Socket event-stream policy

- Authenticate bot sockets during the Socket.IO handshake using `socket.handshake.auth.token`; never put tokens in query strings.
- Preserve the existing cookie + device-signature human path unchanged.
- A connection may use one auth path only. Invalid/revoked/disabled tokens fail the handshake.
- Join the bot's user, stable device, active role, and active community rooms through a shared post-auth room helper. Also join a token-specific room used for revocation.
- Do not add bots to `localOnlineUsers` or call `setUserOnlineStatus`; bot connectivity does not create human presence.
- The supported v1 bot event contract is `cliMessageEvent` for authorized community channels. Other internal frontend events may arrive because rooms are shared, but they are not part of the public bot API contract and must not expose data beyond the bot's active rooms.
- Permission, membership, owner-access, `allowUserBots`, token revocation, and bot-disable changes must update/disconnect live sockets without waiting for reconnect.

## 8. Delivery slices — one branch + PR each, in order

Every PR includes code/migrations as applicable and a **verification section** with repeatable commands or scripts and their transcript. This repository has no automated test suite, but security-sensitive verification should live as reusable scripts where practical rather than only as prose. Never consume the live signup IP allowance to prove human signup; use repository-level rollback tests or a disposable schema/database.

### Slice 1 — Schema + model foundation (`feature/bot-accounts-schema`)

- Migration: `users.is_bot`, `bots`, both enum changes, bot-name uniqueness, constraints/indexes/FKs, and runtime grants.
- Follow the established enum-recreation/index-recreation migration pattern unless a safely separated nontransactional migration is proven against the deployed Postgres/TypeORM combination. Do not add an enum value and use it in a partial index in an unsafe transaction.
- Entity updates: `User.isBot`, new `Bot`; entity discovery is automatic through the datasource glob.
- Shared enum/union/`CreateUserAccountData` updates.
- Add the minimal frontend `ExternalIconType`/account-branch handling needed to keep the frontend typecheck/build green when `ProfileItemType` gains `'bot'`; the visible badge remains Slice 6.
- Add a transactional repository-level `createBotUser` primitive that atomically creates the users row, bot account, valid stable device, and bots row. It accepts owner metadata but has no public endpoint yet.
- Keep human `createUser` separate. Explicitly exclude `'bot'` from human signup/account validators and enforce human/bot invariants in the repository.
- Verification: migration on a schema copy; rollback-only repository bot creation proving every invariant; existing human repository creation/typecheck still works; malformed human requests cannot select the bot profile type.

### Slice 2 — Provisioning, ownership, presence, and lifecycle (`feature/bot-accounts-provisioning`)

- Add session-only list/create/update/disable bot endpoints for all owner flavors.
- Add and document platform-operator configuration.
- Add `communities.allowUserBots` and its management endpoint/permission check.
- Add complete bot install/remove/role-update operations with §5 rules and guard the generic role-assignment path against bypass.
- Add persisted platform presence mode/subset configuration and idempotent reconciliation for existing/new communities.
- Implement owner bot limits, owner deletion/disable behavior, and the disable lifecycle while preserving users/profile/message history.
- Bot update supports display name, image ID, and public description without allowing ownership flavor/owner changes.
- Verification: create/update/disable every flavor; authorization failures; limits under concurrent attempts; community membership bookkeeping; user-bot gate off/on; owner-access loss; platform reconciliation; historical identity remains fetchable after disable.

### Slice 3 — Bot tokens and stateless bearer auth (`feature/bot-accounts-auth`)

- Add `bot_tokens` entity/migration with constraints, indexes, and runtime grants.
- Implement raw-token generation, hashing, one-time return, list/revoke, owner authorization, active-token limit, and throttled `lastUsedAt`.
- Add the separate bot request principal and make bot bearer requests bypass Express sessions. Reject mixed cookie+bearer credentials.
- Add a bot-capable route mechanism plus a minimal session-free, versioned `whoami` endpoint; all other routes remain denied to bot principals until explicitly enabled.
- Verification: no Redis session/cookie is created for a bearer request; bearer identity works on the identity endpoint; revoked/disabled/malformed token is HTTP 401; valid token on a non-allowlisted route is 403; mixed auth is rejected; ordinary cookie and cookieless/no-header behavior remains unchanged.

### Slice 4 — Restricted community-channel messaging (`feature/bot-accounts-messaging`)

- Enable bot principals only on `loadMessages`, `messagesById`, `loadUpdates`, `createMessage`, `setReaction`, and `unsetReaction`.
- Require community-channel access objects and existing channel read/write permissions as appropriate. Explicitly reject chat/DM, call, article, moderation, edit, delete, and other message operations.
- Re-check active bot, owner/gate rules for user bots, and trust/permission state.
- Fix `unsetReaction` to perform the same access validation as `setReaction`.
- Apply configurable per-token request/message rate limits.
- Verification: read/pagination/update polling, post, thread reply, set/unset reaction; permission denial; owner/gate denial; rate limit; all non-community access variants denied; a human UI renders the bot's message through ordinary user data.

### Slice 5 — Socket event stream (`feature/bot-accounts-events`)

- Add handshake token authentication and refactor shared post-auth room joining without weakening human device login.
- Add token-specific rooms and immediate disconnect on revoke/disable.
- Reconcile live rooms/disconnects on role, membership, community gate, owner-access, and platform-presence changes.
- Do not emit human online presence for bots.
- Document the supported `cliMessageEvent` payload/actions and reconnection/revocation behavior.
- Verification: cookieless bot socket receives only authorized live channel-message events; cannot receive a private-channel event; human login still works; revoked token disconnects immediately and cannot reconnect; role/gate removal stops delivery.

### Slice 6 — Frontend polish + bot-author documentation (`feature/bot-accounts-frontend`)

- Include `isBot` in public user payloads and frontend cache models/placeholders.
- Add a Bot badge wherever display names render, following existing supporter/verified badge patterns.
- Hide follow and DM controls on bot profiles; backend bot-token restrictions remain authoritative.
- Render bot account types safely in profile/search/account-type branches. Bot profiles do not show human account-add/edit/security controls.
- Return and render the public bot description from the bots satellite table.
- Add `docs/BOT-API.md` covering management endpoints, bearer format, allowed REST operations, request/response examples, rate limits, socket handshake/events/reconnect, token rotation/revocation, and the explicit v1 exclusions.
- State clearly that v1 management is API/CLI only.
- Verification: frontend build/typecheck; screenshots of badge/profile/message/member-list behavior; direct API attempts cannot reveal follow/DM controls as an authorization substitute; documentation examples run successfully.

### Slice 7 — Deferred, do not start: DMs with bots

DMs require a separate authorization, consent, event, abuse-prevention, and UI design. Nothing in the bearer allowlist or bot socket contract should accidentally enable them.

## 9. Working agreements

- **License headers:** every new source file starts with the repository SPDX AGPL header.
- **Style:** raw-SQL repositories, Joi validators, and shared API request/response types matching surrounding code.
- **Migrations:** epoch-ms filename, matching class name, explicit constraints/indexes/grants, and migration strategy verified against a schema copy. Empty `down()` is accepted house style where rollback is not safely meaningful.
- **Transactions:** provisioning, limits, lifecycle, membership, and ownership changes must be atomic or explicitly retryable. Never rely on an uncommitted user row from a second DB connection.
- **Secrets:** never commit or print `docker/.env.selfhost`, raw bot tokens, hashes, session cookies, or Authorization headers.
- **Commits/PRs:** descriptive commits, one slice per PR, PRs target `develop`, and every PR includes the verification transcript.
- **Live instance:** do not pollute or destabilize it. Prefer `BEGIN ... ROLLBACK`, disposable databases/schemas, and cleanup with an explicit transcript.
- **When reality conflicts:** code wins on factual behavior, but §2's bot-as-user/message-schema decisions remain locked. Stop and flag any contradiction rather than redesigning them silently.
