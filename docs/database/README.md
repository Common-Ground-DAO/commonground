# Database Documentation

> Status: verified against commit a3ab0dcc4, 2026-08-01; `email_bounces` against commit
> e44dac1, 2026-10-31; database roles and the PostgreSQL 18 server against commit
> ff0da06, 2026-10-31; `passkeys` against commit 54e2d73, 2026-10-31; the TypeORM CLI
> compile step (`srv/tsconfig.typeorm-cli.json`) against commit d604544, 2026-10-31;
> `transfer_tokens`, `users.passwordChangeRequired`, `security_step_db_required` and the
> dropped verification-code columns against commit 9fc05a9, 2026-11-01;
> `selfhost.sh restore --db-file` note against commit 818d4c6, 2026-11-01; session generations
> (`session_generation_seq`, `users.sessionGeneration`, `devices.generation`,
> `transfer_tokens.generation`, `session_generation_of`) against commit 23a4c1e, 2026-11-01;
> TypeORM 1.x (the data source, the CLI, the entity metadata of the GIN index and the
> `roles_contracts_contracts` foreign key, the schema comparison) against commit 8dcbb42,
> 2026-11-01; `channelreadstate` write rule and the `calls` open-calls index against commit
> 591e6cf, 2026-11-02; the message sync sequence (`channel_sync_state`, `messages.syncSeq`,
> the `messages_sync_seq_*` triggers, the delete lock order, the migration's write stall),
> `idx_messages_channelId_createdAt_live` and the idempotent message insert against commit
> 30ce83e, 2026-11-02; the `createMessage` channel lock and `createdAt` rule against commits
> 959064f and 1963d4f, 2026-11-02; the `notifications` unread index, the `chats` GIN
> index and their lock note against commit 312b5e7, 2026-11-02; why the sync sequence and not an
> `updatedAt` cursor (chat-sync close-out) against commit 3567377, 2026-11-03

Common Ground uses PostgreSQL with TypeORM as the ORM layer. The database name is `cryptogram`. All entities live in `srv/entities/` and migrations in `srv/migrations/`. Schema synchronization is disabled (`synchronize: false`); all schema changes go through migrations.

---

## Table of Contents

1. [Schema Overview](#schema-overview)
2. [Entity Relationships](#entity-relationships)
3. [Migration Strategy](#migration-strategy)
4. [Key Patterns](#key-patterns)

---

## Schema Overview

### User & Identity

#### `users`
Primary user table. One row per registered user.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated (`gen_random_uuid()`) |
| `password` | `text` | Nullable, `select: false` |
| `onlineStatus` | `enum(OnlineStatusEnum)` | OFFLINE, ONLINE, AWAY, DND |
| `onlineStatusUpdatedAt` | `timestamptz(3)` | Default `now()` |
| `bannerImageId` | `varchar(64)` | Nullable, references a file objectId |
| `previewImageId` | `varchar(64)` | Nullable, references a file objectId |
| `email` | `varchar(128)` | Nullable, indexed (`idx_users_email`) |
| `finishedTutorials` | `varchar(20)[]` | Array, default `[]` |
| `newsletter` | `boolean` | Default `false` |
| `weeklyNewsletter` | `boolean` | Default `false` |
| `dmNotifications` | `boolean` | Default `true` |
| `displayAccount` | `enum(UserProfileTypeEnum)` | Which account type to display |
| `is_bot` | `boolean` | Default `false`. Flags a user row as a bot account (mapped to `isBot` in the entity) |
| `features` | `jsonb` | User feature flags |
| `platformBan` | `jsonb` | Nullable, ban details |
| `followerCount` | `integer` | Denormalized count, default `0` |
| `followingCount` | `integer` | Denormalized count, default `0` |
| `trustScore` | `numeric(10,6)` | Default `1` |
| `communityOrder` | `uuid[]` | User's preferred community ordering |
| `emailVerified` | `boolean` | Default `false` |
| `extraData` | `jsonb` | Default `{}` |
| `passwordChangeRequired` | `boolean` | Default `false`, `select: false`. Set when a password below the policy signed in; the account-security step asks for a new one ([auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)) |
| `sessionGeneration` | `bigint` | Default `0`, `select: false`. Raised to the next `session_generation_seq` value when the account signs out its other devices; sessions, device keys and transfer links below it are no longer valid ([session generations](#session-generations)). Partial index `idx_users_sessionGeneration` where > 0 (declared on the entity with `synchronize: false`) |
| `pointBalance` | `integer` | Default `0` |
| `tags` | `text[]` | Nullable, indexed |
| `createdAt` | `timestamptz(3)` | Auto |
| `updatedAt` | `timestamptz(3)` | Auto |
| `deletedAt` | `timestamptz(3)` | Soft delete, indexed |

Relations: `OneToMany` to `user_accounts`, `devices`, `roles_users_users`, `notifications`, `callmembers`, `users_premium`, `passkeys`, `tokensale_registrations`.

#### `user_accounts`
Each user can have multiple profile accounts (e.g., CG account, wallet-based account). Composite PK: `(userId, type)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `type` | `enum(UserProfileTypeEnum)` PK | `cg`, `twitter`, `lukso`, `farcaster`, `bot` |
| `displayName` | `varchar(255)` | |
| `imageId` | `varchar(64)` | Nullable |
| `data` | `jsonb` | Nullable, `select: false` |
| `extraData` | `jsonb` | Nullable |
| `createdAt` | `timestamptz(3)` | Auto |
| `updatedAt` | `timestamptz(3)` | Auto |
| `deletedAt` | `timestamptz(3)` | Soft delete, indexed |

Custom indexes (created via migration, `synchronize: false`):
- `idx_user_accounts_type_id`
- `idx_user_accounts_type_lower_id`
- `idx_user_accounts_principal_unique_username` — partial unique index on `LOWER(displayName)` where `type IN ('cg', 'bot')` and `displayName <> ''`. Human (`cg`) and bot usernames share a single namespace: a bot cannot take a name already used by a human account or another bot, and vice versa. This replaced the earlier `cg`-only unique index (`idx_user_accounts_cg_unique_displayName`) plus a short-lived `bot`-only variant (see migration `1784056200000-unifyHumanAndBotUsernames`).
- `idx_user_accounts_displayName_gin_trgm` (trigram index for fuzzy search)

#### `wallets`
Blockchain wallets linked to users. Unique constraint on `(type, walletIdentifier)` and `(type, walletIdentifier, chain)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | Nullable, FK -> `users.id` (SET NULL) |
| `type` | `enum(WalletType)` | `cg_evm`, `evm`, `contract_evm`. Default `evm`. `fuel`/`aeternity` were dropped from the enum on 2026-08-01 together with their rows (`1785632400000-dropFuelAeternityWallets`) |
| `walletIdentifier` | `text` | Wallet address |
| `loginEnabled` | `boolean` | Default `false` |
| `visibility` | `enum(WalletVisibility)` | PRIVATE, PUBLIC. Default `PRIVATE` |
| `signatureData` | `jsonb` | Signature verification data |
| `chain` | `varchar(64)` | Nullable, indexed |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `wallet_balances`
Token balances per wallet per contract. Composite PK: `(walletId, contractId)`.

| Column | Type | Notes |
|--------|------|-------|
| `walletId` | `uuid` PK | FK -> `wallets.id` (CASCADE) |
| `contractId` | `uuid` PK | FK -> `contracts.id` (CASCADE) |
| `balance` | `jsonb` | Balance data |
| `updatedAt` | `timestamptz(3)` | Auto |

#### `passkeys`
WebAuthn passkeys for passwordless authentication ([docs/auth-identity §7](../auth-identity/README.md#7-passkeys)).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | Nullable, FK -> `users.id` (CASCADE). New rows always have one (a sign-up passkey is inserted by `createUser`); NULL only on rows from the former CG ID sign-up flow |
| `data` | `jsonb` | `webAuthnUserID` (user handle, stable per account and RP), `credentialID`, `credentialPublicKeyBase64`, `credentialDeviceType`, `credentialBackedUp`, `transports`; older rows also carry `debugData` (registration options/response), new rows do not |
| `counter` | `bigint` | Default `0`, authenticator counter |
| `rpId` | `text` | Nullable. WebAuthn relying party the credential belongs to; every lookup is scoped to the process's RP ID, so a NULL matches nothing. Backfilled from `debugData` by `1793480000000-passkeyRelyingParty` |
| `origin` | `text` | Nullable. Origin from `clientDataJSON` at registration (audit) |
| `name` | `text` | Nullable. User label (defaults to "<browser> on <OS>") |
| `lastUsedAt` | `timestamptz(3)` | Nullable. Last successful assertion |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

Indexes: unique `("rpId", data->>'credentialID')` (`IDX_passkeys_rpId_credentialID`, the lookup), `("userId", "rpId")`, and the older unique `(data->>'credentialID', data->>'webAuthnUserID')`.

#### `transfer_tokens`
One-time sign-in links from an instance on the same database (the app.cg gateway) to this one
([auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `tokenHash` | `char(64)` | SHA-256 of the token, unique, `select: false`; the token itself is never stored |
| `nextPath` | `varchar(2048)` | Nullable, a same-site path to continue to |
| `createdAt` | `timestamptz(3)` | Default `now()` |
| `expiresAt` | `timestamptz(3)` | About 10 minutes after creation, indexed |
| `usedAt` | `timestamptz(3)` | Nullable; set by the single statement that redeems the token |
| `generation` | `bigint` | Default `0`. The generation of the session that minted it; redeemable only while not below the user's `sessionGeneration` |

Rows that expired more than a day ago are deleted whenever a new link is minted. Added by
`1793520000000-transferLinksAndSecurityStep`, which also drops `users.verificationCode` /
`verificationCodeExpiration` (email codes live in Valkey now), adds `users.passwordChangeRequired`
and creates the function below.

#### `security_step_db_required`
`security_step_db_required(p_user_id uuid, p_rp_id text) RETURNS boolean` — the database part of
the account-security step for the realtime servers ([auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)):
true when the account has no passkey of `p_rp_id`, no password and no login-enabled EVM wallet,
when its password must be changed, or when it is missing, deleted or a bot. `SECURITY DEFINER`
with a pinned `search_path`; `EXECUTE` is revoked from `PUBLIC` and granted to `writer`, `reader`
and `mediasoup` — the call server's role gets the answer without any access to `users`,
`passkeys` or `wallets`.

#### `devices`
User devices for push notifications and encryption.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `publicKey` | `jsonb` | JWK public key for E2E encryption |
| `webPushSubscription` | `jsonb` | Nullable, web push subscription data |
| `deviceInfo` | `jsonb` | Nullable, device metadata |
| `generation` | `bigint` | Default `0`, `select: false`. The generation of the login that created the key (or of the account's last sign-out of other devices, for the device that did it); the key signs in only while it is not below the user's `sessionGeneration` |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### Session generations
Added by `1793560000000-sessionGenerations` ([auth-identity §2](../auth-identity/README.md#signing-out-other-devices)):

- `session_generation_seq` (`bigint`): one sequence for all generations. A login takes the next
  value before it checks a credential; a sign-out of other devices raises `users.sessionGeneration`
  to the next value in the transaction of the change that caused it (user row locked first, then
  the advisory lock 7312001 exclusively for its last statement until COMMIT; logins and the
  reconciler take it shared; `lock_timeout` 5 s). `USAGE, SELECT, UPDATE` for `writer`, `SELECT`
  for `reader`.
- `users.sessionGeneration`, `devices.generation`, `transfer_tokens.generation` (see the tables
  above); existing rows got 0 and stay valid until their account's first sign-out of other devices.
- `session_generation_of(p_user_id uuid) RETURNS bigint`: the user's generation (0 if unknown),
  `SECURITY DEFINER` with a pinned `search_path`; `EXECUTE` revoked from `PUBLIC` and granted to
  `writer`, `reader` and `mediasoup` — the device-key lookup uses it, also under the call server's
  role, which may not read `users`.

#### `followers`
User-to-user follow relationships. Composite PK: `(userId, otherUserId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `otherUserId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `user_newsletter_status`
Tracks per-user newsletter delivery status. Composite PK: `(userId, newsletterId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `newsletterId` | `integer` PK | |
| `emailClicked` | `boolean` | Default `false` |
| `sentAt` | `timestamptz(3)` | Nullable |

#### `email_bounces`
Permanent bounces reported by the selfhost mail relay (`srv/jobs/bounceReceiver.ts`; policy in [docs/email-notifications](../email-notifications/README.md#bounces)). Migration `1793453486482-addEmailBounces`. Keyed by address, not user id (a report names an address; accounts can change theirs). Rows older than 180 days are deleted by the `newsletterDelivery` job.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `address` | `varchar(320)` | Lower-cased recipient address |
| `reportId` | `varchar(255)` | Message-ID of the bounce report; unique with `address` (`UQ_email_bounces_report_address`) |
| `status` | `varchar(16)` | Status field, e.g. `5.0.0` |
| `diagnostic` | `varchar(500)` | Nullable; the receiving server's answer, truncated |
| `senderSide` | `boolean` | Default `false`; set for bounces in a burst — they never count |
| `createdAt` | `timestamptz(3)` | Auto |

Indexes: `idx_email_bounces_address_createdAt` (`address`, `createdAt`), `idx_email_bounces_createdAt`.

#### `users_premium`
User premium feature subscriptions. Composite PK: `(userId, featureName)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `featureName` | `enum(UserPremiumFeatureName)` PK | |
| `activeUntil` | `timestamptz(3)` | Indexed |
| `autoRenew` | `enum(PremiumRenewal)` | Nullable, indexed |
| `updatedAt` | `timestamptz(3)` | Auto |

---

### Bots

Bot accounts are ordinary `users` rows flagged with `is_bot = true`; they carry a `user_accounts` row of type `bot` and share the human username namespace (see `idx_user_accounts_principal_unique_username`). The tables below hold the bot-specific metadata layered on top of the user identity.

#### `bots`
One row per bot, keyed by the underlying user. PK is `userId` (the same UUID as the `users` row).

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE). OneToOne with the bot's user row |
| `deviceId` | `uuid` | Unique, FK -> `devices.id` (NO ACTION). The device the bot connects through |
| `ownerType` | `enum(BotOwnerType)` | `community`, `user`, or `platform` |
| `ownerId` | `uuid` | Nullable. Community or user that owns the bot; NULL for platform bots |
| `platformPresenceMode` | `enum(BotPlatformPresenceMode)` | Nullable. `all` or `selected`; set only for platform bots |
| `description` | `text` | Nullable |
| `connectedSocketCount` | `integer` | Default `0`. Server-derived count of live bot sockets (CHECK `>= 0`) |
| `lastConnectedAt` | `timestamptz(3)` | Nullable |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto, `select: false` |
| `deletedAt` | `timestamptz(3)` | Soft delete, indexed |

Constraints:
- `CHK_bots_owner`: platform bots must have `ownerId IS NULL` and `platformPresenceMode IS NOT NULL`; community/user bots must have `ownerId IS NOT NULL` and `platformPresenceMode IS NULL`.
- `idx_bots_active_owner` — partial index on `(ownerType, ownerId)` where `deletedAt IS NULL`.

#### `bot_tokens`
API tokens used by bots to authenticate. A bot may have multiple tokens; a token is retired by setting `revokedAt` (no soft-delete column).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `botUserId` | `uuid` | FK -> `bots.userId` (CASCADE) |
| `tokenHash` | `char(64)` | Unique, `select: false`. Hash of the token (the plaintext token is never stored) |
| `name` | `varchar(100)` | Nullable, label for the token |
| `lastUsedAt` | `timestamptz(3)` | Nullable |
| `createdAt` | `timestamptz(3)` | Auto |
| `revokedAt` | `timestamptz(3)` | Nullable. Set to retire the token |

`idx_bot_tokens_active_bot` — partial index on `botUserId` where `revokedAt IS NULL`.

#### `bots_platform_communities`
Restricts a platform bot (`platformPresenceMode = 'selected'`) to a set of communities. Composite PK: `(botUserId, communityId)`. No timestamps.

| Column | Type | Notes |
|--------|------|-------|
| `botUserId` | `uuid` PK | FK -> `bots.userId` (CASCADE) |
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE) |

`idx_bots_platform_communities_community` — index on `(communityId, botUserId)`.

Whether a community permits user-owned bots is governed by the `communities.allowUserBots` flag (see the `communities` table).

---

### Communities

#### `communities`
Top-level community entity. Think of it as a "server" in Discord terminology.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `creatorId` | `uuid` | Nullable, FK -> `users.id` (SET NULL) |
| `url` | `varchar(30)` | Unique, URL slug |
| `title` | `varchar(50)` | |
| `description` | `varchar(1000)` | |
| `shortDescription` | `varchar(50)` | |
| `password` | `varchar(50)` | Nullable, for password-protected communities |
| `logoSmallId` | `varchar(64)` | Nullable, file reference |
| `logoLargeId` | `varchar(64)` | Nullable, file reference |
| `headerImageId` | `varchar(64)` | Nullable, file reference |
| `previewImageId` | `varchar(64)` | Nullable, file reference |
| `tags` | `varchar(50)[]` | Indexed |
| `links` | `jsonb` | Social/website links |
| `onboardingOptions` | `jsonb` | Nullable, onboarding questionnaire config |
| `activityScore` | `double precision` | Default `0`, indexed |
| `memberCount` | `integer` | Denormalized, default `1` |
| `pointBalance` | `integer` | Default `0` |
| `tsv_description` | `tsvector` | Full-text search vector, `select: false` |
| `official` | `boolean` | Default `false` |
| `enablePersonalNewsletter` | `boolean` | Default `false` |
| `allowUserBots` | `boolean` | Default `false`. Whether members may add user-owned bots to this community |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

Custom indexes: `idx_communities_title_gin_trgm` (trigram for fuzzy search), `idx_groups_tsv_description` (full-text).

#### `areas`
Organizational grouping of channels within a community (like Discord channel categories).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE), indexed |
| `title` | `varchar(100)` | |
| `order` | `integer` | Default `0` |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `channels`
Abstract channel entity. Serves as the shared messaging container for community channels, DM chats, and article comment threads. Contains only a UUID primary key; all metadata lives in the linking tables.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |

Relations: `OneToMany` messages, `OneToOne` to `communities_channels`, `OneToOne` to `chats`, `OneToOne` to `articles`.

#### `communities_channels`
Links a channel to a community with metadata. Composite PK: `(communityId, channelId)`. Unique constraint on `(communityId, url)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE), indexed |
| `channelId` | `uuid` PK | FK -> `channels.id` (CASCADE), unique |
| `areaId` | `uuid` | Nullable, FK -> `areas.id` (CASCADE) |
| `title` | `varchar(100)` | |
| `url` | `varchar(30)` | Nullable, slug within community |
| `order` | `integer` | Default `0` |
| `description` | `varchar(256)` | Nullable |
| `emoji` | `varchar(16)` | Nullable |
| `pinnedMessageIds` | `jsonb` | Nullable, array of message UUIDs |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `communities_channels_roles_permissions`
Per-role permissions on community channels. Composite PK: `(communityId, channelId, roleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | |
| `channelId` | `uuid` PK | Composite FK -> `communities_channels` |
| `roleId` | `uuid` PK | FK -> `roles.id` (CASCADE) |
| `permissions` | `enum(ChannelPermission)[]` | READ, WRITE, etc. Indexed |

#### `roles`
Community roles with associated permissions. Roles can be token-gated via linked contracts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE), indexed |
| `title` | `varchar(64)` | Unique per community (case-insensitive, custom index) |
| `type` | `enum(RoleType)` | DEFAULT, MEMBER, ADMIN, etc. |
| `imageId` | `varchar(64)` | Nullable |
| `description` | `varchar(140)` | Nullable |
| `airdropConfig` | `jsonb` | Nullable, airdrop configuration for role |
| `assignmentRules` | `jsonb` | Nullable, automatic role assignment rules |
| `permissions` | `enum(CommunityPermission)[]` | Array of community-level permissions |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

Relations: `ManyToMany` with `contracts` (via join table `roles_contracts_contracts`), `OneToMany` to `roles_users_users`.

#### `roles_users_users`
Join table between users and roles. Composite PK: `(userId, roleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `roleId` | `uuid` PK | FK -> `roles.id` (CASCADE) |
| `claimed` | `boolean` | Default `false`, indexed. Whether user has claimed a token-gated role |
| `updatedAt` | `timestamptz(3)` | Auto, indexed |

#### `communities_tokens`
Tokens (contracts) associated with a community. Composite PK: `(communityId, contractId)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE) |
| `contractId` | `uuid` PK | FK -> `contracts.id` (CASCADE) |
| `order` | `integer` | Default `0` |
| `active` | `boolean` | Default `true` |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

#### `communities_premium`
Community premium feature subscriptions. Composite PK: `(communityId, featureName)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE) |
| `featureName` | `enum(CommunityPremiumFeatureName)` PK | |
| `activeUntil` | `timestamptz(3)` | Indexed |
| `autoRenew` | `enum(PremiumRenewal)` | Nullable, indexed |
| `updatedAt` | `timestamptz(3)` | Auto |

#### `communities_events`
Scheduled events within a community.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE), indexed |
| `url` | `varchar(30)` | Nullable, unique per community |
| `eventCreator` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `callId` | `uuid` | Nullable, FK -> `calls.id` (SET NULL) |
| `type` | `enum(CommunityEventType)` | CALL, IN_PERSON, EXTERNAL, etc. |
| `imageId` | `varchar(64)` | Nullable |
| `title` | `varchar(100)` | |
| `description` | `jsonb` | Rich text content |
| `externalUrl` | `varchar(250)` | Nullable |
| `location` | `varchar(250)` | Nullable |
| `scheduleDate` | `timestamptz(3)` | |
| `duration` | `integer` | Nullable, minutes |
| `eventNotified` | `boolean` | Default `false` |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `communities_events_participants`
Composite PK: `(eventId, userId)`.

| Column | Type | Notes |
|--------|------|-------|
| `eventId` | `uuid` PK | FK -> `communities_events.id` (CASCADE), indexed |
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `createdAt` | `timestamptz(3)` | Auto |

#### `communities_events_permissions`
Per-role permissions on events. Composite PK: `(communityEventId, roleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityEventId` | `uuid` PK | FK -> `communities_events.id` (CASCADE), indexed |
| `roleId` | `uuid` PK | FK -> `roles.id` (CASCADE), indexed |
| `permissions` | `enum(CommunityEventPermission)[]` | VIEW, PARTICIPATE, etc. |

#### `user_community_state`
Per-user, per-community state including block status, approval state, and notification preferences. Composite PK: `(communityId, userId)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE) |
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `blockState` | `enum(UserBlockState)` | Nullable, BLOCKED, MUTED, etc. |
| `blockStateUpdatedAt` | `timestamptz(3)` | Nullable |
| `blockStateUntil` | `timestamptz(3)` | Nullable, temporary blocks |
| `questionnaireAnswers` | `jsonb` | Nullable, onboarding answers |
| `approvalState` | `enum(CommunityApprovalState)` | Nullable, PENDING, APPROVED, REJECTED |
| `approvalUpdatedAt` | `timestamptz(3)` | Nullable |
| `notifyMentions` | `boolean` | Default `true` |
| `notifyReplies` | `boolean` | Default `true` |
| `notifyPosts` | `boolean` | Default `true` |
| `notifyEvents` | `boolean` | Default `true` |
| `notifyCalls` | `boolean` | Default `true` |
| `newsletterJoinedAt` | `timestamptz(3)` | Nullable |
| `newsletterLeftAt` | `timestamptz(3)` | Nullable |
| `userLeftCommunity` | `timestamptz(3)` | Nullable |

#### `user_channel_settings`
Per-user, per-channel settings. Composite PK: `(userId, channelId, communityId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `channelId` | `uuid` PK | Composite FK -> `communities_channels` |
| `communityId` | `uuid` PK | Composite FK -> `communities_channels` |
| `pinType` | `enum(ChannelPinTypeEnum)` | AUTOPIN, PINNED, UNPINNED |
| `notifyType` | `enum(ChannelNotificationTypeEnum)` | WHILE_PINNED, ALWAYS, NEVER |
| `pinnedUntil` | `timestamptz(3)` | Nullable |
| `updatedAt` | `timestamptz(3)` | Auto |

---

### Messaging

#### `messages`
All messages across all channel types. Unique constraint on `(channelId, createdAt)`
(`UQ_6df0905b0802e8402e6570c6505`; ms precision, database clock).
`messageHelper.createMessage` inserts in a transaction that first locks the channel's
`channel_sync_state` row (`INSERT … ON CONFLICT DO UPDATE … WHERE false`, which locks
without writing) and then sets `createdAt` = `updatedAt` = `GREATEST(clock_timestamp(),
newest createdAt of the channel + 1 ms)`, so creates in one channel get distinct,
increasing timestamps in sequence order even in bursts. The +1 ms chain is followed only
while it stays within 5 s of the clock: after a clock that ran ahead was corrected, a new
message takes `clock_timestamp()` instead of a future time. A collision with a writer that
does not take the lock first (an API process from before this change, during a deploy) is
retried, up to 3 attempts. The insert is idempotent on the
client-chosen `id`: a known id is answered from a lookup without an INSERT (an INSERT
that inserts nothing would still take a sync seq), checked again under the channel lock,
and `ON CONFLICT ("id") DO NOTHING` covers a same-id create in another channel racing it;
the creator's `channelreadstate` (`lastRead` = the message's `createdAt`) is only
written for a new row. Partial indexes from migration `1793635200000-chatSyncSeq`:
`idx_messages_channelId_syncSeq` on `("channelId", "syncSeq") WHERE "syncSeq" IS NOT
NULL` (see [Message sync sequence](#message-sync-sequence)) and
`idx_messages_channelId_createdAt_live` on `("channelId", "createdAt") INCLUDE
("creatorId") WHERE "deletedAt" IS NULL`, which makes the capped unread counts
(`setChannelLastRead`, `getSyncState`: other users' live messages after `lastRead`)
index-only scans.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Chosen by the client on create (idempotency key) |
| `creatorId` | `uuid` | FK -> `users.id` (CASCADE) |
| `channelId` | `uuid` | FK -> `channels.id` (CASCADE), indexed |
| `body` | `jsonb` | Message content (rich text) |
| `attachments` | `jsonb` | Nullable, array of attachment objects |
| `parentMessageId` | `uuid` | Nullable, FK -> `messages.id` (SET NULL), indexed. For threaded replies |
| `reactions` | `jsonb` | Nullable, denormalized reaction counts |
| `tsv_tags` | `tsvector` | Full-text search on tags, `select: false` |
| `editedAt` | `timestamptz(3)` | Nullable |
| `createdAt` | `timestamptz(3)` | Indexed |
| `updatedAt` | `timestamptz(3)` | Indexed |
| `deletedAt` | `timestamptz(3)` | Soft delete, indexed |
| `syncSeq` | `bigint` | Nullable, `select: false`. Channel sequence of the row's last write, set only by the `messages_sync_seq_*` triggers; NULL for rows not written since migration `1793635200000-chatSyncSeq` (no backfill) |

#### Message sync sequence
Per-channel, commit-ordered change sequence for messages (chat-sync catch-up,
`Message/getChanges`; migration `1793635200000-chatSyncSeq`):

- Why a sequence and not an `updatedAt` cursor: commit order is not timestamp order
  (the timestamp is taken when the statement runs, lock waits before the commit are
  unbounded), so a time cursor needs an overlap window, `(updatedAt, id)` paging and
  dedupe and can still miss a late commit. The trigger-set sequence is exact without a
  clock, covers soft deletes (they are updates) and also covers writes by API processes of
  the previous build during a deploy. The column is nullable without backfill so the
  migration stays cheap on a large `messages` table (a row gets its seq on its next
  write).
- `channel_sync_state("channelId" uuid PK, "seq" bigint NOT NULL)` holds the last
  sequence assigned in a channel. A channel without a row has seq 0. GRANT `SELECT,
  INSERT, UPDATE` to `writer`, `SELECT` to `reader`. Entity
  `srv/entities/channel-sync-state.ts`.
- Function `messages_set_sync_seq()` (plpgsql, `SECURITY INVOKER`, table name
  schema-qualified) upserts the channel's row (`INSERT … VALUES (NEW."channelId", 1) ON
  CONFLICT DO UPDATE SET seq = seq + 1`) and stores the new value in `NEW."syncSeq"`.
  Triggers: `messages_sync_seq_insert` (`BEFORE INSERT … FOR EACH ROW`) and
  `messages_sync_seq_update` (`BEFORE UPDATE … FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM
  NEW.*)`, so an update that changes no column takes no sequence). An explicit
  `syncSeq` in a write is overwritten.
- Every write is covered: create, edit, reactions (the counter update on `messages`), soft
  deletes (a tombstone keeps its seq; deletion is terminal) and the reply cleanup that
  sets `parentMessageId` to NULL. A multi-row write takes one seq per row.
- Commit order: the upsert keeps the channel's row locked until the writing transaction
  ends, so writers of one channel are serialised and commit in sequence order. A statement
  that reads `seq = S` and the channel's messages in one snapshot sees every row whose
  last write had a seq `<= S` and none above. A rolled-back write releases its seq (no
  gap); an `INSERT … ON CONFLICT DO NOTHING` that inserts nothing still takes one (BEFORE
  triggers fire before the conflict check), which is why `createMessage` looks a known id
  up first (and again under the channel lock); only a create that loses a same-id race against a create in another channel leaves such a gap. Writes to different
  channels do not wait for each other.
- Lock order of the writers: `set/unsetReaction` lock the reaction row, then the message
  row, then the sequence row; an edit locks the message row, then the sequence row; `createMessage` locks the sequence row first (then inserts); a new
  reply (or a changed `parentMessageId`) takes the sequence row first and then `FOR KEY
  SHARE` on the parent (foreign-key check). The soft delete
  (`messageHelper.deleteMessage`/`deleteAllUserMessages`) writes several rows and runs in
  one transaction that follows the same order: it selects its targets, locks their
  reaction rows (`FOR UPDATE`, key order), then the targets and their replies (`FOR NO KEY
  UPDATE`, id order — the strength of an update of non-key columns, which does not block
  the `KEY SHARE` of a concurrent reply insert), and writes exactly the rows it locked, so
  it never waits for a row while holding the sequence row. A reply committed after that
  lock keeps its `parentMessageId`, the same outcome as a reply committed after the
  delete. During a rolling deploy, API processes from before this change delete without
  the pre-lock; a deadlock with them is possible for that window only (PostgreSQL aborts
  one of the two transactions, the request fails and can be repeated).
- Cost: one primary-key upsert on a small table per message write. Adding the column is
  catalog-only; while every row is NULL the `syncSeq` index build is one sequential scan of
  `messages`; the `createdAt_live` index build took 2.3 s on 6.5M messages (measured during
  review). Covered by `srv/tests/chatSyncSeqDb.spec.ts` (real PostgreSQL, opt-in
  `CG_TEST_PG_HOST` + `CG_TEST_PG_PORT`, see docs/backend §8 "Tests"; it also checks that the
  unread count is an index-only scan).
- **Write stall on a live deploy:** the `ALTER TABLE … ADD "syncSeq"` takes an `ACCESS
  EXCLUSIVE` lock on `messages` and both indexes are built without `CONCURRENTLY`.
  `migrateDb.ts` runs `runMigrations()` with TypeORM's default transaction mode `all` (all
  pending migrations in one transaction), and TypeORM 1.1.2 refuses a per-migration
  `transaction = false` in that mode (`ForbiddenTransactionModeOverrideError`), so
  `CREATE INDEX CONCURRENTLY` is not available. Reads and writes of `messages` therefore
  wait until the whole migration run commits, and the locks taken by later migrations of
  the same deploy are held until then as well. The runtime on the production dump is timed
  in the cg.box dress rehearsal.

#### `chats`
Direct message conversations. Currently supports 1:1 chats with provision for group chats (see code TODO).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userIds` | `uuid[]` | Participants, indexed (btree). Also GIN index `idx_chats_userIds_gin` (added by `1793660400000-syncStateIndexes`, declared on the entity with `synchronize: false`) for the membership test `"userIds" @> ARRAY[user]` of `getChats` and `Message/getSyncState`, which the btree cannot serve. Built with a plain `CREATE INDEX` (see the note on `idx_notifications_userId_unread`) |
| `adminIds` | `uuid[]` | Admins of the chat |
| `channelId` | `uuid` | FK -> `channels.id`, unique. OneToOne |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `reactions`
User reactions on items (messages, articles, etc.). Composite PK: `(userId, itemId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `itemId` | `uuid` PK | Generic reference to any reactable entity, indexed |
| `reaction` | `varchar(3)` | Emoji shortcode |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | All indexed |

#### `channelreadstate`
Tracks the last-read timestamp per user per channel. Composite PK: `(channelId, userId)`. Every upsert keeps the later of the stored and the new value (`ON CONFLICT … DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")`), so `lastRead` never moves backwards; `/setChannelLastRead` also clamps a posted time to the server's `now()` (or takes the `createdAt` of a posted `messageId` in the channel). The own-message upsert in `createMessage` runs only when the message row is new.

| Column | Type | Notes |
|--------|------|-------|
| `channelId` | `uuid` PK | FK -> `channels.id` (CASCADE) |
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `lastRead` | `timestamptz(3)` | Default `now()` |

---

### Content

#### `articles`
Blog posts / articles created by users. Can be published to communities or user profiles.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `creatorId` | `uuid` | Nullable, FK -> `users.id` (CASCADE) |
| `headerImageId` | `varchar(64)` | Nullable |
| `thumbnailImageId` | `varchar(64)` | Nullable |
| `title` | `varchar(256)` | |
| `content` | `jsonb` | Rich text content with version |
| `previewText` | `varchar(150)` | Nullable |
| `tags` | `text[]` | Nullable, indexed |
| `channelId` | (via JoinColumn) | FK -> `channels.id`, OneToOne. Comment channel for the article |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `communities_articles`
Links articles to communities. Composite PK: `(communityId, articleId)`. Unique on `(communityId, url)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | FK -> `communities.id` (CASCADE) |
| `articleId` | `uuid` PK | FK -> `articles.id` (CASCADE), unique |
| `url` | `varchar(30)` | Nullable, slug within community |
| `published` | `timestamptz(3)` | Nullable, publish date |
| `markAsNewsletter` | `boolean` | Default `false` |
| `sentAsNewsletter` | `timestamptz(3)` | Nullable |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `communities_articles_roles_permissions`
Per-role permissions on articles. Composite PK: `(communityId, articleId, roleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `communityId` | `uuid` PK | |
| `articleId` | `uuid` PK | Composite FK -> `communities_articles` |
| `roleId` | `uuid` PK | FK -> `roles.id` (CASCADE) |
| `permissions` | `enum(ArticlePermission)[]` | READ, COMMENT, etc. Indexed |

#### `users_articles`
Links articles to user profiles (personal blog). Composite PK: `(userId, articleId)`. Unique on `(userId, url)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE), indexed |
| `articleId` | `uuid` PK | FK -> `articles.id` (CASCADE), unique |
| `url` | `varchar(30)` | Nullable |
| `published` | `timestamptz(3)` | Nullable |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

---

### Blockchain

#### `contracts`
On-chain token contracts. Unique on `(chain, address)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `chain` | `varchar(64)` | Chain identifier (e.g., `ethereum`, `polygon`) |
| `address` | `varchar(50)` | Contract address |
| `data` | `jsonb` | On-chain metadata (name, symbol, type, etc.) |
| `updatedAtBlock` | `bigint` | Nullable, `select: false`. Last synced block |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

Relations: `ManyToMany` with `roles` (via `roles_contracts_contracts` join table), `OneToMany` to `wallet_balances`.

#### `chaindata`
Per-chain configuration/state data. Simple key-value store.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `varchar(255)` PK | Chain identifier |
| `data` | `json` | Chain-specific data |

#### `user_community_airdrops`
Tracks airdrop eligibility/status per user per community role.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE) |
| `roleId` | `uuid` | FK -> `roles.id` (CASCADE) |
| `userId` | `uuid` | FK -> `users.id` (CASCADE) |
| `airdropData` | `jsonb` | Airdrop details |
| `airdropEndDate` | `timestamptz(3)` | |

#### `tokensales`
Token sale definitions. The token-sale feature was removed in the Phase-2 slimming
(2026-08-01); the four `tokensale*` tables and their entities are kept for
auditability and no longer have any reader or writer in the codebase.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `name` | `text` | |
| `saleContractChain` | `varchar(64)` | |
| `saleContractAddress` | `varchar(50)` | |
| `saleContractType` | `varchar(50)` | |
| `targetTokenChain` | `varchar(64)` | |
| `targetTokenAddress` | `varchar(50)` | |
| `targetTokenDecimals` | `integer` | |
| `recentUpdateBlockNumber` | `bigint` | Default `0` |
| `totalInvested` | `varchar(255)` | Default `'0'` |
| `startDate` | `timestamptz(3)` | Default `now()` |
| `endDate` | `timestamptz(3)` | |
| `oneDayEmailSentAt/startsNowEmailSentAt` | `timestamptz(3)` | Nullable, email scheduling |
| `createdAt` | `timestamptz(3)` | Auto |

#### `tokensale_registrations`
User registrations for token sales (pre-registration before sale goes live).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | Nullable, FK -> `users.id` (NO ACTION) |
| `email` | `varchar` | Indexed (case-insensitive unique) |
| `referredBy` | `uuid` | Nullable, FK -> `users.id` (NO ACTION) |
| `oneDayEmailSentAt/startsNowEmailSentAt` | `timestamptz(3)` | Nullable |
| `createdAt` | `timestamptz(3)` | Auto |

#### `tokensale_userdata`
Per-user, per-token-sale investment tracking. Composite PK: `(userId, tokenSaleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `tokenSaleId` | `uuid` PK | FK -> `tokensales.id` (CASCADE) |
| `referredByUserId` | `uuid` | Nullable, FK -> `users.id` (SET NULL) |
| `totalInvested` | `decimal(80,0)` | Default `'0'` |
| `totalTokensBought` | `decimal(80,0)` | Default `'0'` |
| `referralBonus` | `decimal(80,0)` | Default `'0'` |
| `referredUsersDirectCount` | `integer` | Default `0` |
| `referredUsersIndirectCount` | `integer` | Default `0` |
| `rewardProgram` | `jsonb` | Default `{}` |
| `rewardClaimedTimestamp` | `timestamptz(3)` | Nullable |
| `rewardClaimedSecurityData` | `jsonb` | Nullable |
| `targetAddress` | `varchar(50)` | Nullable |
| `oneDayEmailSentAt/startsNowEmailSentAt` | `timestamptz(3)` | Nullable, indexed |
| `oneDayNotificationSentAt/startsNowNotificationSentAt` | `timestamptz(3)` | Nullable, indexed |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

#### `tokensale_investments`
Individual investment events. Composite PK: `(investmentId, tokenSaleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `investmentId` | `bigint` PK | On-chain investment ID |
| `tokenSaleId` | `uuid` PK | FK -> `tokensales.id` (CASCADE) |
| `userId` | `uuid` | FK -> `users.id` (CASCADE) |
| `event` | `jsonb` | Raw event data from chain |
| `createdAt` | `timestamptz(3)` | Auto |

Composite FK `(tokenSaleId, userId)` -> `tokensale_userdata`.

#### `point_transactions`
Tracks point (premium currency) transactions for users and communities.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | Nullable, indexed |
| `communityId` | `uuid` | Nullable, indexed |
| `amount` | `integer` | Transaction amount |
| `data` | `jsonb` | Transaction metadata |
| `createdAt` | `timestamptz(3)` | Auto |

`point_transactions` also serves as the ledger for Spark credited by staking accrual: the accrual job inserts one `staking-accrual` row (with chain/contract/position details in `data`) per credited delta and bumps the user's `pointBalance`.

#### `staking_positions`
One row per on-chain `CgStaking` position. Rows are created by the on-chain listener from `Staked` events and are never deleted; unstaking sets `unstakedAt`. `userId` is resolved from the wallet mapping at indexing time and backfilled/cleared as wallets are linked or removed — only positions with a `userId` accrue Spark.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `chain` | `varchar(64)` | Chain identifier |
| `contractAddress` | `varchar(50)` | Staking contract address |
| `walletAddress` | `varchar(50)` | Owning wallet address |
| `positionId` | `bigint` | Per-owner position index inside the staking contract |
| `userId` | `uuid` | Nullable, FK -> `users.id` (SET NULL) |
| `amount` | `numeric(39,0)` | Token base units (uint128) as a numeric string. CHECK `amount > 0` |
| `stakedAt` | `timestamptz(3)` | |
| `unlockAt` | `timestamptz(3)` | |
| `unstakedAt` | `timestamptz(3)` | Nullable |
| `stakeTxHash` | `varchar(80)` | |
| `stakeLogIndex` | `integer` | |
| `unstakeTxHash` | `varchar(80)` | Nullable |
| `accruedThroughDay` | `date` | Nullable. Last UTC day (inclusive) the accrual job credited |
| `accruedSpark` | `bigint` | Default `0`. Running total of Spark credited for this position |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

Constraints and indexes:
- Unique `(chain, contractAddress, walletAddress, positionId)` — on-chain identity.
- Unique `(chain, stakeTxHash, stakeLogIndex)` — dedupes replayed stake logs.
- `idx_staking_positions_userId` — partial on `userId` where `userId IS NOT NULL`.
- `idx_staking_positions_unclaimed_wallet` — partial on `walletAddress` where `userId IS NULL` (positions awaiting a wallet-to-user mapping).
- `idx_staking_positions_accrual_scan` — partial on `accruedThroughDay` where `userId IS NOT NULL` (drives the accrual scan).

The accrual job credits each claimed position up to a time-based pro-rata target in a single atomic statement (row-locked with `SKIP LOCKED`), writing the delta to `point_transactions` and bumping user balances; it is idempotent and self-catching-up after downtime.

---

### Media & Files

#### `files`
Uploaded file metadata. Actual file storage is external (object storage); this table maps IDs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `creatorId` | `uuid` | Nullable, FK -> `users.id` (CASCADE) |
| `objectId` | `varchar(64)` | Unique, indexed. The object storage key |
| `data` | `jsonb` | Nullable, image metadata (dimensions, etc.) |
| `uploadOptions` | `jsonb` | Nullable, original upload options |
| `accessedAt` | `timestamptz(3)` | Default `now()`, indexed. For cache eviction |
| `createdAt` | `timestamptz(3)` | Auto |

#### `role_gated_files`
Files that require a specific role to access. PK: `filename`.

| Column | Type | Notes |
|--------|------|-------|
| `filename` | `varchar(255)` PK | |
| `type` | `varchar(30)` | `'download'` or `'video'` |
| `roleId` | `uuid` | FK -> `roles.id` (CASCADE) |
| `createdAt` | `timestamptz(3)` | Auto |

---

### Plugins

#### `plugins`
Third-party plugin/app definitions. Each plugin is owned by a community.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `ownerCommunityId` | `uuid` | FK -> `communities.id` (CASCADE) |
| `url` | `varchar(255)` | Plugin endpoint URL |
| `tags` | `text[]` | Nullable, indexed |
| `privateKey` | `text` | Plugin's private key (for signing) |
| `publicKey` | `text` | Plugin's public key (for verification) |
| `permissions` | `jsonb` | Nullable, declared permissions |
| `description` | `text` | Nullable |
| `imageId` | `varchar(64)` | Nullable |
| `clonable` | `boolean` | Default `false` |
| `appstoreEnabled` | `boolean` | Default `false` |
| `warnAbusive` | `boolean` | Default `false` |
| `requiresIsolationMode` | `boolean` | Default `false` |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `communities_plugins`
Plugin installations per community.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE) |
| `pluginId` | `uuid` | FK -> `plugins.id` (CASCADE) |
| `name` | `varchar(255)` | Display name for this installation |
| `config` | `jsonb` | Default `{}` |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Nullable timestamps |

#### `user_plugin_state`
Per-user plugin authorization state. Composite PK: `(userId, pluginId)`.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | `uuid` PK | FK -> `users.id` (CASCADE) |
| `pluginId` | `uuid` PK | FK -> `plugins.id` (CASCADE) |
| `acceptedPermissions` | `jsonb` | Nullable |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

---

### Calls (Voice/Video)

#### `calls`
Active or past voice/video calls.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE), indexed; also partial index `idx_calls_communityId_open` over the open calls (`"endedAt" IS NULL`, added by `1793600000000-openCallsIndex`, declared on the entity with `synchronize: false`) for the call-ending sweeps of the jobs process and the call lists |
| `callCreator` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `channelId` | `uuid` | FK -> `channels.id` (CASCADE), indexed |
| `callServerId` | `uuid` | Nullable, FK -> `callservers.id` (CASCADE), indexed |
| `callType` | `enum(CallType)` | DEFAULT, etc. |
| `title` | `varchar(100)` | |
| `description` | `varchar(200)` | Nullable |
| `previewUserIds` | `uuid[]` | Users shown as preview |
| `slots` | `int` | Default `100` |
| `stageSlots` | `int` | |
| `audioOnly` | `boolean` | Default `false` |
| `highQuality` | `boolean` | Default `false` |
| `scheduleDate` | `timestamptz(3)` | Nullable |
| `startedAt` | `timestamptz(3)` | Auto (CreateDateColumn) |
| `updatedAt` | `timestamptz(3)` | Auto |
| `endedAt` | `timestamptz(3)` | Soft delete (DeleteDateColumn) |

#### `callmembers`
Call participation records.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `callId` | `uuid` | FK -> `calls.id` (CASCADE), indexed |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `joinedAt` | `timestamptz(3)` | Auto (CreateDateColumn) |
| `leftAt` | `timestamptz(3)` | DeleteDateColumn |

#### `callpermissions`
Per-role permissions for calls. Composite PK: `(callId, roleId)`.

| Column | Type | Notes |
|--------|------|-------|
| `callId` | `uuid` PK | FK -> `calls.id` (CASCADE), indexed |
| `roleId` | `uuid` PK | FK -> `roles.id` (CASCADE), indexed |
| `permissions` | `enum(CallPermission)[]` | JOIN, SPEAK, SCREENSHARE, etc. |

#### `callservers`
Media server instances for call routing.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `status` | `jsonb` | Server health/capacity info |
| `url` | `varchar(255)` | Unique |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

---

### Other

#### `notifications`
User notifications.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `type` | `enum(NotificationType)` | MENTION, REPLY, DM, APPROVAL, etc. |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed. Recipient. Also partial index `idx_notifications_userId_unread` over the unread notifications (`"read" = FALSE`, added by `1793660400000-syncStateIndexes`, declared on the entity with `synchronize: false`) for the unread count. The migration builds both of its indexes with a plain `CREATE INDEX`, which blocks writes to `notifications` and `chats` while it runs; `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and the migration runner uses transaction mode `all` (one transaction for the whole run). The build time on the production data is measured in the cg.box dress rehearsal |
| `subjectUserId` | `uuid` | Nullable, indexed. Who triggered it |
| `subjectCommunityId` | `uuid` | Nullable, indexed |
| `subjectArticleId` | `uuid` | Nullable, FK -> `articles.id`, indexed |
| `subjectItemId` | `uuid` | Nullable, indexed. Generic item reference |
| `text` | `varchar(256)` | |
| `read` | `boolean` | Default `false`, indexed |
| `extraData` | `jsonb` | Nullable |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `reports`
Content/user reports. Unique on `(reporterId, targetId, type)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `reporterId` | `uuid` | FK -> `users.id` (CASCADE) |
| `reason` | `text` | |
| `message` | `text` | Nullable |
| `type` | `enum(ReportType)` | USER, COMMUNITY, MESSAGE, ARTICLE, etc. Indexed |
| `targetId` | `uuid` | Generic reference, indexed |
| `resolved` | `boolean` | Default `false`, indexed |
| `remark` | `text` | Nullable, admin notes |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `logging`
Generic server-side log table.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `service` | `varchar(30)` | Service name |
| `data` | `jsonb` | Log payload |
| `createdAt` | `timestamptz(3)` | Auto |

#### `oneshot_jobs`
Tracks one-time migration/maintenance jobs to prevent re-execution.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `varchar(256)` PK | Job identifier |
| `createdAt` | `timestamptz(3)` | Auto |

---

## Entity Relationships

### ASCII Relationship Diagram (Core Entities)

```
                                    +------------------+
                                    |      users       |
                                    +------------------+
                                    | id (PK, uuid)    |
                                    | email            |
                                    | password         |
                                    | pointBalance     |
                                    +--------+---------+
                                             |
              +-------------+----------------+----------------+----------------+
              |             |                |                |                |
              v             v                v                v                v
     +--------+-----+ +----+------+ +-------+------+ +------+------+ +-------+--------+
     | user_accounts| |  wallets  | |   devices    | |  passkeys   | | users_premium   |
     +--------------+ +-----------+ +--------------+ +-------------+ +----------------+
     | userId (PK)  | | id (PK)   | | id (PK)      | | id (PK)     | | userId (PK)    |
     | type (PK)    | | userId    | | userId       | | userId      | | featureName(PK)|
     | displayName  | | type      | | publicKey    | | data        | | activeUntil    |
     +--------------+ | walletId  | +--------------+ +-------------+ +----------------+
                      +-----------+
                           |
                           v
                    +------+----------+
                    | wallet_balances  |
                    +------------------+
                    | walletId (PK)    |
                    | contractId (PK)  +------> contracts
                    | balance          |
                    +------------------+


     +------------------+       +------------------+       +------------------+
     |   communities    |       |      areas       |       |    channels      |
     +------------------+       +------------------+       +------------------+
     | id (PK, uuid)    |<------+ communityId      |       | id (PK, uuid)    |
     | creatorId -> user |       | title            |       +-------+----------+
     | url (unique)     |       | order            |               |
     | title            |       +------------------+        +------+------+
     | activityScore    |              |                    |             |
     | memberCount      |              |                    v             v
     +--------+---------+              |           +--------+---+ +------+------+
              |                        |           |  messages  | |   chats     |
              |                        v           +------------+ +-------------+
              |              +---------+-----------+ | id (PK)   | | id (PK)     |
              +------------->| communities_channels| | channelId | | channelId   |
              |              +---------------------+ | creatorId | | userIds[]   |
              |              | communityId (PK)     | | body      | +-------------+
              |              | channelId (PK) ------+-+ parentMsg |
              |              | areaId -> areas      |  +-----------+
              |              | title, url           |
              |              +---------------------+
              |                        |
              |                        v
              |    +------------------------------------+
              |    | communities_channels_roles_perms    |
              |    +------------------------------------+
              |    | communityId, channelId, roleId (PK)|
              |    | permissions[]                      |
              |    +------------------------------------+
              |
              +------------->+------------------+
              |              |      roles       |
              |              +------------------+
              |              | id (PK, uuid)    |
              |              | communityId      |
              |              | title            |
              |              | type             |
              |              | permissions[]    |
              |              +-------+----------+
              |                      |
              |            +---------+---------+
              |            |                   |
              |            v                   v
              |  +---------+--------+  +-------+----------+
              |  | roles_users_users|  | roles_contracts   |
              |  +------------------+  | _contracts (M2M) |
              |  | userId (PK)      |  +------------------+
              |  | roleId (PK)      |  | rolesId          |
              |  | claimed          |  | contractsId      |
              |  +------------------+  +------------------+
              |
              +------------->+---------------------+
              |              | communities_tokens   |
              |              +---------------------+
              |              | communityId (PK)     |
              |              | contractId (PK)      |
              |              +---------------------+
              |
              +------------->+---------------------+
              |              | communities_events   |
              |              +---------------------+
              |              | id (PK)              |
              |              | communityId           |
              |              | callId -> calls       |
              |              +---------------------+
              |
              +------------->+---------------------+
                             | communities_articles |
                             +---------------------+
                             | communityId (PK)     |
                             | articleId (PK)        |
                             +---------------------+
                                      |
                                      v
                             +------------------+
                             |    articles      |
                             +------------------+
                             | id (PK, uuid)    |
                             | creatorId -> user|
                             | channelId -> ch. |
                             | title, content   |
                             +------------------+
```

### Key Foreign Key Behaviors

| Relationship | ON DELETE |
|---|---|
| `user_accounts.userId` -> `users.id` | CASCADE |
| `wallets.userId` -> `users.id` | SET NULL |
| `communities.creatorId` -> `users.id` | SET NULL |
| `areas.communityId` -> `communities.id` | CASCADE |
| `communities_channels.communityId` -> `communities.id` | CASCADE |
| `roles.communityId` -> `communities.id` | CASCADE |
| `messages.creatorId` -> `users.id` | CASCADE |
| `messages.parentMessageId` -> `messages.id` | SET NULL |
| `tokensale_registrations.userId` -> `users.id` | NO ACTION |
| `bots.userId` -> `users.id` | CASCADE |
| `bots.deviceId` -> `devices.id` | NO ACTION |
| `bot_tokens.botUserId` -> `bots.userId` | CASCADE |
| `bots_platform_communities.*` -> `bots` / `communities` | CASCADE (both) |
| `staking_positions.userId` -> `users.id` | SET NULL |
| Most join tables | CASCADE on both sides |

The general pattern: when a parent entity (community, user) is deleted, child entities cascade-delete. Wallets and community creator references use SET NULL to preserve the wallet/community even when the user is deleted. Token sale registrations use NO ACTION to prevent accidental data loss.

---

## Migration Strategy

### Overview

The project uses **TypeORM migrations** with `synchronize: false`. The database schema is never auto-synced from entities; all changes require explicit migrations.

### DataSource Configuration

Defined in `srv/util/datasource.ts` (TypeORM DataSource) and `srv/util/postgres.ts` (raw `pg` Pool):

**TypeORM DataSource** (`srv/util/datasource.ts`):
- Database: PostgreSQL, database name `cryptogram`, schema `public`
- Entities loaded from: `srv/entities/*.js` (compiled)
- Migrations loaded from: `srv/migrations/*.js` (compiled)
- UUID extension: `pgcrypto` (`gen_random_uuid()`)
- Used primarily for migrations and entity definitions
- The TypeORM CLI tools (`tools/makeMigration.sh` = `./run.sh make_migration`,
  `tools/revertLastMigration.sh`, `tools/testEntities.sh`) compile the
  entities, migrations and this data source to `srv/__tmp` with
  `srv/tsconfig.typeorm-cli.json` (extends `srv/tsconfig.json`, i.e. the
  backend build settings) and point the CLI at `__tmp/util/datasource.js`
- TypeORM **1.1.2** (wave M2, 2026-11-01; was 0.3.31). Nothing in the app
  used the APIs 1.x removed (`Connection`, the global `getRepository` etc.,
  `findByIds`, string `relations`/`select`); the only call sites are
  `migrateDb.ts` (`runMigrations()`) and the migrations' `queryRunner.query()`
  (`initdb` reads the database name from `queryRunner.dataSource.options`; the
  old `manager.connection` is a deprecated alias in 1.x). The data source is
  initialized on the first `getDataSource()` call, not on import: the CLI
  loads the file and initializes `ormDataSource` itself, and 1.x refuses a
  second `initialize()` while one is in flight (0.3 let both connect). The
  migration table (`migrations`), the class-name timestamps and the default
  transaction mode (`all`: one transaction for the whole run) are unchanged,
  so an existing database runs none of the 167 migrations again and a fresh
  one runs all of them. No migration uses the schema-builder helpers
  (`createTable`, `TableColumn`, `addColumn`, …) — only raw
  `queryRunner.query()`. Checked with 1.1.2 against a throwaway database:
  `migration:generate` (what `./run.sh make_migration` runs) writes a file,
  `migration:revert` (`tools/revertLastMigration.sh`) reverts the last
  migration and `migration:run` applies it again
- Schema comparison (`typeorm migration:generate --dr` against a freshly
  migrated database) now also compares **index types** and defaults the
  **inverse side** of a many-to-many junction's foreign key to `CASCADE`.
  Two entities therefore spell out what the database already has, so the
  upgrade adds no diff: `@Index('idx_groups_tsv_description', { type: 'gin' })`
  on `communities.tsv_description`, and `{ onDelete: 'NO ACTION', onUpdate:
  'NO ACTION' }` on `Contract.roles` (the `roles_contracts_contracts.contractsId`
  key from `1676888170060-rolesAndPermissions`). What `--dr` still reports is
  the drift that 0.3.31 reported as well: the bot tables (foreign-key and
  index names, `CHECK` constraints, enum order), `staking_positions`
  (constraint names, `CHECK`), and indexes created by migrations only
  (`idx_users_suggest_popular`, `idx_roles_users_users_role_user`, the
  `*_articles_feed` indexes) — the same 36 `up()` statements (in another
  order); its `down()` now spells out the default index method (`USING
  btree`). A database migrated by 0.3.31 and one migrated by 1.1.2 have an
  identical `pg_dump --schema-only` and an identical `migrations` table
  (structure and rows)

**Raw pg Pool** (`srv/util/postgres.ts`):
- A raw `pg.Pool` instance with the same connection credentials
- No explicit pool sizing configuration (uses `pg` defaults: 10 connections)
- Used by all repository files for queries (most queries are raw SQL, not TypeORM QueryBuilder)
- SSL is configured identically to the TypeORM DataSource when Docker secrets are available

### Migration File Naming Convention

```
{unix_timestamp_ms}-{descriptive_name}.ts
```

Examples:
- `1648214442313-initdb.ts`
- `1738852388814-add_plugins_table.ts`
- `1784037142000-addBotAccountsFoundation.ts`
- `1784170800000-addStakingPositions.ts`

The timestamp prefix ensures migrations run in chronological order. Names use either camelCase or snake_case (inconsistent, but both are accepted).

### Migration Class Structure

Each migration implements `MigrationInterface` with `up()` and `down()` methods:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPluginsTable1738852388814 implements MigrationInterface {
    name = 'AddPluginsTable1738852388814'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE ...`);
        // Grant permissions to reader/writer roles
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "table_name" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "table_name" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE ...`);
    }
}
```

### Creating a New Migration

1. **Generate the timestamp**: Use the current Unix timestamp in milliseconds. You can generate this with `Date.now()` in Node.js.

2. **Create the file**: `srv/migrations/{timestamp}-{description}.ts`

3. **Write raw SQL**: Migrations use `queryRunner.query()` with raw SQL. They do NOT use TypeORM's schema builder.

4. **Grant permissions**: New tables must grant permissions to the `writer` and `reader` database roles:
   ```sql
   GRANT ALL PRIVILEGES ON "new_table" TO writer;
   GRANT SELECT ON "new_table" TO reader;
   ```

5. **Run migrations**: Execute `srv/migrateDb.ts` which calls `dataSource.runMigrations()`. TypeORM tracks executed migrations in the `migrations` table.

6. **Update the entity**: Create or update the corresponding TypeORM entity in `srv/entities/` to match the new schema.

### Important Notes

- Some early migrations wrap queries in try/catch (e.g., `initdb`) for idempotency. Newer migrations do not.
- Migrations frequently create PostgreSQL functions and triggers (e.g., for circular referral prevention, access checks, update notifications). The `notify_call_change` trigger, for example, was patched in `1784030000000-fixCallChangeTriggerNullCallServer` to skip the per-call-server notification when a scheduled call has no assigned call server yet.
- Enum type changes normally use `ALTER TYPE ... ADD VALUE` rather than drop/recreate, as noted in the enums file header comment. The exception is when the new value must be usable in the same transaction (e.g. inside an index predicate): `1784037142000-addBotAccountsFoundation` adds `bot` to `user_accounts_type_enum` / `users_displayaccount_enum` by renaming the old enum, creating a new one, re-casting the column, and dropping the old type — because `ADD VALUE` cannot be used before commit.
- Granting `writer`/`reader` on every new table is mandatory: `staking_positions` was created without grants in `1784170800000` and every runtime query failed until the follow-up `1784180000000-grantStakingPositions` added them.
- Removals get a drop migration too. `1785542400000-dropFeedsDomain` drops the never-created feeds tables with `IF EXISTS` and a no-op `down()`; `1785628800000-dropWizardDomain` drops the five `wizard*` tables **including their rows** (maintainer decision 2026-08-01, backups exist) and its `down()` recreates the schema — constraint names, indexes and grants included — from the four creating migrations, without data. `communities` is untouched by the wizard drop: the only FK runs `wizards."communityId" -> communities(id)`.
  `1785632400000-dropFuelAeternityWallets` is the third variant: it deletes rows *and* shrinks an enum — `DELETE FROM wallets WHERE type IN ('fuel','aeternity')` first (their `wallet_balances` follow via `ON DELETE CASCADE`), then the rename/create/re-cast/drop dance on `wallets_type_enum`, bracketed by dropping and re-adding the two unique constraints on the column. Its `down()` restores the enum but not the rows.

---

## Key Patterns

### Soft Deletes

Most entities use TypeORM's `@DeleteDateColumn` for soft deletes:

```typescript
@DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
deletedAt!: Date | null;
```

- When a row is "deleted", `deletedAt` is set to the current timestamp instead of removing the row.
- The column has `select: false`, meaning it is excluded from default SELECT queries.
- TypeORM automatically adds `WHERE "deletedAt" IS NULL` to all queries on soft-delete entities.
- The `deletedAt` column is often indexed for query performance.

**Entities WITHOUT soft deletes** (hard delete or append-only):
- `channelreadstate` - Overwritten (only forwards), not deleted
- `chaindata` - Configuration data
- `wallet_balances` - Cascade-deleted with wallet
- `communities_tokens` - No deletedAt
- `communities_channels_roles_permissions` - No deletedAt
- `communities_articles_roles_permissions` - No deletedAt
- `communities_events_participants` - No deletedAt
- `communities_events_permissions` - No deletedAt
- `callpermissions` - No deletedAt
- `roles_users_users` - No deletedAt
- `logging` - Append-only
- `oneshot_jobs` - Append-only
- `point_transactions` - Append-only
- `files` - No deletedAt
- `role_gated_files` - No deletedAt
- `user_community_state` - State record, not deletable
- `user_channel_settings` - Settings record
- `user_plugin_state` - No deletedAt
- `user_newsletter_status` - No deletedAt
- `users_premium`, `communities_premium` - Expire via `activeUntil`, not deleted
- `bot_tokens` - Retired via `revokedAt`, not deletedAt
- `bots_platform_communities` - No timestamps at all
- `staking_positions` - Append-only from on-chain events; unstaking sets `unstakedAt`
- `email_bounces` - No deletedAt; rows expire after 180 days (hard delete)

The `bots` table itself does use `@DeleteDateColumn` (indexed `deletedAt`) for soft deletes.

### Timestamps

Nearly all entities include timestamp columns with this pattern:

```typescript
@CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
createdAt!: Date;

@UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
updatedAt!: Date;
```

- Type is always `timestamptz` (timestamp with time zone) with millisecond precision (`precision: 3`).
- Both are `select: false` -- excluded from default queries to reduce payload size. Must be explicitly selected when needed.
- `@CreateDateColumn` is auto-set on INSERT.
- `@UpdateDateColumn` is auto-set on every UPDATE.

Notable exceptions:
- `calls` uses `startedAt` (CreateDateColumn) and `endedAt` (DeleteDateColumn) instead of standard names.
- `callmembers` uses `joinedAt` / `leftAt`.
- `channelreadstate` has no timestamps besides `lastRead`.
- `communities_plugins` uses manual `timestamptz` columns (not TypeORM decorators).

### UUID Usage

All primary keys across the system are UUIDs, generated using PostgreSQL's `gen_random_uuid()` (via the `pgcrypto` extension):

```typescript
@PrimaryGeneratedColumn('uuid')
id!: string;
```

Join/bridge tables use composite primary keys of UUIDs:

```typescript
@PrimaryColumn({ type: 'uuid' })
userId!: string;

@PrimaryColumn({ type: 'uuid' })
roleId!: string;
```

Exceptions where PK is not a UUID:
- `chaindata.id` - `varchar(255)`, chain identifier string
- `oneshot_jobs.id` - `varchar(256)`, job name string
- `role_gated_files.filename` - `varchar(255)`
- `tokensale_investments.investmentId` - `bigint` (on-chain ID)

### Enum Patterns

Enums are defined in `srv/common/enums.ts` and used as PostgreSQL enum types:

```typescript
// In enums.ts
export enum RoleType {
  DEFAULT = 'default',
  MEMBER = 'member',
  ADMIN = 'admin',
  ...
}

// In entity
@Column({ type: 'enum', enum: RoleType, nullable: false })
type!: RoleType;
```

For array-of-enum columns (permission systems):

```typescript
@Column({ type: 'enum', enum: CommunityPermission, array: true })
permissions!: CommunityPermission[];
```

**Critical warning from the codebase**: When modifying existing enum types, migrations must use `ALTER TYPE ... ADD VALUE` rather than dropping and recreating the enum. Dropping an enum will fail if any column references it.

Key enums:
- `CommunityPermission` - Community-level permissions (MANAGE_ROLES, MANAGE_CHANNELS, etc.)
- `ChannelPermission` - Channel-level permissions (READ, WRITE, etc.)
- `ArticlePermission` - Article access permissions
- `CallPermission` - Call permissions (JOIN, SPEAK, SCREENSHARE, etc.)
- `CommunityEventPermission` - Event permissions (VIEW, PARTICIPATE, etc.)
- `RoleType` - DEFAULT, MEMBER, ADMIN
- `UserProfileTypeEnum` - `cg`, `twitter`, `lukso`, `farcaster`, `bot`
- `BotOwnerType` - `community`, `user`, `platform`
- `BotPlatformPresenceMode` - `all`, `selected`
- `WalletType` / `WalletVisibility` - Wallet classification
- `NotificationType` - Notification categories
- `OnlineStatusEnum` - OFFLINE, ONLINE, AWAY, DND
- `UserBlockState` - Block/mute states
- `CommunityApprovalState` - PENDING, APPROVED, REJECTED
- `ReportType` - USER, COMMUNITY, MESSAGE, ARTICLE, etc.
- `CallType` - DEFAULT, etc.

### JSONB Columns

The codebase heavily uses `jsonb` columns for flexible/semi-structured data rather than creating additional tables. Common uses:

- **Message bodies**: `messages.body` stores rich text content
- **Configuration**: `roles.assignmentRules`, `roles.airdropConfig`, `communities.onboardingOptions`
- **Metadata**: `contracts.data` (on-chain token metadata), `files.data` (image dimensions)
- **Features/flags**: `users.features`, `users.platformBan`
- **Cryptographic data**: `wallets.signatureData`, `passkeys.data`, `devices.publicKey`
- **Plugin config**: `communities_plugins.config`, `plugins.permissions`

TypeScript types for these JSONB columns are defined in the `Models.*` namespace (declared in separate type definition files, not in the entity files).

### select: false Pattern

Many columns are marked with `select: false`:

```typescript
@Column({ type: 'text', nullable: true, select: false })
password!: string | null;
```

This means the column is **excluded from all default SELECT queries**. To retrieve these fields, they must be explicitly requested:

```typescript
// Using QueryBuilder
.addSelect('user.password')

// Using find options
{ select: { password: true } }
```

This pattern is used for:
- Sensitive data (passwords, emails, verification codes)
- Large/rarely-needed data (tsvector columns, timestamps)
- Performance optimization (reduce default payload size)

### Full-Text Search

The project uses PostgreSQL's native full-text search via `tsvector` columns:

- `communities.tsv_description` - Full-text search on community descriptions
- `messages.tsv_tags` - Full-text search on message tags

These are indexed with GIN indexes and maintained via database triggers (set up in migrations).

### Trigram Search

The project uses the `pg_trgm` extension for fuzzy/partial text matching:

- `idx_user_accounts_displayName_gin_trgm` on `user_accounts.displayName`
- `idx_communities_title_gin_trgm` on `communities.title`

These GIN trigram indexes support `LIKE`/`ILIKE` queries and similarity-based search on display names and community titles.

### Dual Database Access

The project maintains two parallel database access methods:

1. **TypeORM DataSource** (`srv/util/datasource.ts`): Used for migrations and entity metadata. Accessed via `getDataSource()` (connects on the first call).
2. **Raw `pg` Pool** (`srv/util/postgres.ts`): Used by all repository files for queries. Most application queries are written as raw SQL using `pg-format` for parameterization.

Transactions in repositories follow this pattern:
```typescript
const client = await pool.connect();
await client.query("BEGIN");
try {
  // ... queries using client ...
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```

### Database Roles

Four login roles exist in every cluster:

| Role | Created by | Privileges | Used by |
|---|---|---|---|
| `postgres` | the image entrypoint (`POSTGRES_PASSWORD` = `PG_SU_PASSWORD`) | superuser, owns every object | `migrate-db`, `cg-builder` (migration tooling) |
| `writer` | `docker/db/init.sh` (`PG_WRITER_PASSWORD`) | `ALL PRIVILEGES` on every table except `logging` (`INSERT` only) and `channel_sync_state` (`SELECT, INSERT, UPDATE`, written by the `messages` triggers under the writing role); `USAGE, SELECT` on `migrations_id_seq` | api, wsapi, memberlist, job-runner, onchain |
| `reader` | `docker/db/init.sh` (`PG_READER_PASSWORD`) | `SELECT` on every table except `logging` (`INSERT` only); `USAGE, SELECT` on `migrations_id_seq` | no service today |
| `mediasoup` | `docker/db/init.sh` (`PG_MEDIASOUP_PASSWORD`); migration `1689160339881-addMediasoupRole` creates it only if it is missing (`PG_MEDIASOUP_PASSWORD` empty at initialization) | `SELECT` on seven tables, `INSERT`/`UPDATE` on `calls`, `callmembers`, `callservers` (`1689160339881`, `1689184137878`, `1689258457796`, `1690444603969`) | mediasoup |

`init.sh` runs only when the official image initializes an empty data directory.
It creates the `cryptogram` database and the three application roles but grants
nothing: every table privilege comes from the migrations, which run as `postgres`.
Every migration that creates a new table must therefore grant `writer` and
`reader` (and `mediasoup` where the call server needs it).

Because the roles exist right after initialization, a fresh cluster can take
either the full migration chain or a `pg_restore` of an existing database whose
ACLs name these roles (see [below](#restoring-a-postgresql-14-database-into-18)).

On PostgreSQL 18 the `writer` grant `ALL PRIVILEGES` also includes `MAINTAIN`
(new in 17: `VACUUM`, `ANALYZE`, `REINDEX`, `REFRESH MATERIALIZED VIEW`, `LOCK
TABLE` on those tables). Since PostgreSQL 15, `PUBLIC` no longer has `CREATE` on
schema `public`; no application role needs it — the app runs no DDL outside
migrations.

### PostgreSQL server

PostgreSQL **18** (`postgres:18-alpine` line; exact tag + digest pinned in
`docker/db/Dockerfile`), configured by `docker/db/postgresql.conf` — see
[docs/infrastructure §1](../infrastructure/README.md#db-postgresql) for the image,
the volume layout and major upgrades. Database `cryptogram`: `UTF8`, libc locale
`en_US.utf8` — on Alpine that is musl, whose collation is plain code-point order
(`A B Z _x a b e é`), not the linguistic order of glibc's `en_US.utf8`. Fresh 18
clusters have data checksums on (the 18 `initdb` default).

The migration chain produces the same schema on 18 as on 14 (same tables,
indexes, triggers, role privileges and extensions; TypeORM's `schema:log`
reports the same statements on both). TypeORM 0.3.31 and node-postgres 8.22
(`srv/yarn.lock`) needed no changes (today: TypeORM 1.1.2 since wave M2,
node-postgres 8.23). The remaining `pg_dump --schema-only`
differences are version noise:

- 18 records `NOT NULL` as named constraints; columns created under an older
  name keep the old constraint name (e.g. `CONSTRAINT areas_name_not_null` on
  `areas.title`). A database restored from a dump gets default names instead.
  Nothing in the app or in TypeORM refers to these names.
- `writer` grants show as `GRANT ALL` (includes `MAINTAIN`, see above).
- Schema `public` is owned by `pg_database_owner` with `USAGE` for `PUBLIC`
  (14: owner `postgres`, `CREATE` for `PUBLIC`).
- `pgcrypto` is at extension version 1.4 (14: 1.3; adds `fips_mode()`).

#### Restoring a PostgreSQL 14 database into 18

This is the cg.box import path (roadmap G5). What has been tried: a 14.23
database **built by this repository's own migrations** (three migrations
behind, synthetic rows, all objects owned by `postgres`, created by the
Alpine-based `docker/db` image) restored cleanly into a fresh 18 cluster with
the commands below; row counts matched table by table, `migrate-db` then
applied the missing migrations, and the result equals a freshly migrated 18
schema except for the `NOT NULL` constraint names above. A real production
dump has not been restored yet.

TODO(verify) against the production database before move day:

- server version and platform: `SELECT version()` (`-musl` = Alpine like ours,
  `-gnu` = glibc);
- object owners and roles: the pre-flight below; production may own its
  objects as `cryptoadmin`, the code default when `PG_SU_NAME` is unset
  (`srv/util/datasource.ts:20`);
- extensions: `SELECT extname, extversion FROM pg_extension` (expected
  `plpgsql`, `pgcrypto`, `pg_trgm`);
- locale/collation: `SELECT datcollate, datctype FROM pg_database WHERE
  datname = 'cryptogram'` (on the 18 side add `datlocprovider`, which 14
  lacks; ours is `c` = libc). If production runs on glibc,
  text sorts differently after the move (musl orders by code point, so
  uppercase before lowercase and accents last): compare `ORDER BY` output of a
  text column, e.g. `SELECT title FROM communities ORDER BY title LIMIT 200`,
  on both sides. Indexes are rebuilt by the restore, so nothing is corrupted —
  only the order users see can change.

```bash
# on the old server: custom-format dump with its own (14) pg_dump
docker exec <old-db-container> pg_dump -U postgres -Fc cryptogram > ~/cryptogram-pg14.pgc

# pre-flight, after `selfhost.sh build` (which creates the cryptogram/db:18
# image): every role the dump assigns ownership or privileges to
docker run --rm -i cryptogram/db:18 pg_restore --schema-only -f - < ~/cryptogram-pg14.pgc \
  | grep -E '^(ALTER .*OWNER TO|GRANT|REVOKE)' | grep -oE '(TO|FROM) [^;]+' | sort -u
#   expected: postgres, writer, reader, mediasoup. Roles that only
#   own objects: restore with --no-owner (everything is then owned by postgres,
#   as on a fresh install). Roles that receive grants: create them after the
#   db is up and before pg_restore, e.g.
#   ./selfhost/selfhost.sh compose exec db psql -U postgres -c 'CREATE ROLE cryptoadmin NOLOGIN'

# new stack: start only the db; init.sh creates cryptogram, writer, reader, mediasoup
# (initdb logs "WARNING: no usable system locales were found" — benign on
# Alpine/musl, the cluster still uses en_US.utf8)
./selfhost/selfhost.sh compose up -d --wait db
# compose cp needs an absolute source path (selfhost.sh runs in docker/)
./selfhost/selfhost.sh compose cp "$HOME/cryptogram-pg14.pgc" db:/tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db pg_restore -U postgres -d cryptogram --exit-on-error -j 4 /tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db rm /tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db vacuumdb -U postgres -d cryptogram --analyze-in-stages   # planner statistics right away
./selfhost/selfhost.sh up      # migrate-db applies the migrations the dump lacks
```

For a self-host instance on PostgreSQL 14, `docker/SELFHOST.md`
([PostgreSQL 18](../../docker/SELFHOST.md#postgresql-18)) has the same steps in
order, including the update itself.

`./selfhost/selfhost.sh restore --db-file ~/cryptogram-pg14.pgc` (since
2026-11-01, [docs/deployment §3.7](../deployment/README.md#37-backup-and-restore))
runs the new-stack half of these commands in one go. Before it changes
anything it runs the role pre-flight (refusing a dump that needs a role other
than `postgres`/`writer`/`reader`/`mediasoup` that the cluster lacks) and
refuses a non-empty database unless `--force`. Then it stops the stack, starts
`db`, sets the role passwords from `.env.selfhost` (creating a missing
`writer`/`reader`/`mediasoup`), renames an existing database to
`cryptogram_pre_restore_<stamp>`, runs `pg_restore -j` and `vacuumdb
--analyze-in-stages`, and drops the renamed one only when that succeeded (a
failure prints `restore --undo <stamp>` to get it back). It does not create
foreign roles or pass `--no-owner`; for a dump that needs either, use the
manual steps above.
TODO(verify): not yet run against a PostgreSQL 14 dump (tested with 18 dumps).

**If `pg_restore` stops** (`--exit-on-error`; with `-j` there is no single
transaction, so the database is left partially restored): fix the cause — e.g.
`role "mediasoup" does not exist` when `PG_MEDIASOUP_PASSWORD` was empty at
initialization — then recreate the empty database and run the restore again.
Roles are cluster-wide and survive this:

```bash
./selfhost/selfhost.sh compose exec db psql -U postgres -c 'DROP DATABASE cryptogram' -c "CREATE DATABASE cryptogram ENCODING 'utf8'"
```

(Tried with the role-missing case: the second restore succeeded.)

Notes:

- The dump carries no roles and no passwords; the roles get the passwords from
  the new `.env.selfhost`.
- Dump with the **old server's own** `pg_dump` (14) as shown. A `pg_dump` 18 run
  against the 14 server also restored cleanly in the test, but carries over
  14's schema-`public` settings (owner `postgres`, `CREATE` for `PUBLIC`) and
  the explicit pre-17 privilege lists instead of `GRANT ALL`.
- `--no-owner` was not part of the test (the test dump's objects were all owned
  by `postgres`).
