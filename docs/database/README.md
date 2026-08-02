# Database Documentation

> Status: verified against commit 8133e43fe, 2026-08-01

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
| `verificationCode` | `varchar(32)` | Nullable, indexed (`idx_users_verification_codes`) |
| `verificationCodeExpiration` | `timestamptz(3)` | Nullable |
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
| `type` | `enum(WalletType)` | `cg_evm`, `evm`, `fuel`, `aeternity`, `contract_evm`. Default `evm`. `fuel`/`aeternity` are retired values (login removed 2026-08-01) kept for existing rows |
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
WebAuthn passkeys for passwordless authentication.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | Nullable, FK -> `users.id` (CASCADE) |
| `data` | `jsonb` | WebAuthn credential data, indexed on `credentialID` and `webAuthnUserID` |
| `counter` | `bigint` | Default `0`, authenticator counter |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

#### `devices`
User devices for push notifications and encryption.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `publicKey` | `jsonb` | JWK public key for E2E encryption |
| `webPushSubscription` | `jsonb` | Nullable, web push subscription data |
| `deviceInfo` | `jsonb` | Nullable, device metadata |
| `createdAt/updatedAt/deletedAt` | `timestamptz(3)` | Standard timestamps |

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
All messages across all channel types. Unique constraint on `(channelId, createdAt)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
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

#### `chats`
Direct message conversations. Currently supports 1:1 chats with provision for group chats (see code TODO).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `userIds` | `uuid[]` | Participants, indexed |
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
Tracks the last-read timestamp per user per channel. Composite PK: `(channelId, userId)`.

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
| `communityId` | `uuid` | FK -> `communities.id` (CASCADE), indexed |
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

### AI Assistant

#### `assistant_dialogs`
AI assistant conversation sessions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `request` | `jsonb` | Full conversation request/history |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed |
| `communityId` | `uuid` | Nullable, FK -> `communities.id` (CASCADE), indexed |
| `title` | `varchar(255)` | Nullable |
| `model` | `varchar(255)` | Model name used |
| `createdAt/updatedAt` | `timestamptz(3)` | Auto |

#### `assistant_availability`
Available AI model configurations. PK: `modelName`.

| Column | Type | Notes |
|--------|------|-------|
| `modelName` | `varchar(255)` PK | |
| `title` | `varchar(255)` | Display name |
| `isAvailable` | `boolean` | Default `false` |
| `domain` | `varchar(255)` | |
| `order` | `integer` | Default `0` |
| `extraData` | `jsonb` | Nullable |

---

### Other

#### `notifications`
User notifications.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Auto-generated |
| `type` | `enum(NotificationType)` | MENTION, REPLY, DM, APPROVAL, etc. |
| `userId` | `uuid` | FK -> `users.id` (CASCADE), indexed. Recipient |
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
- `channelreadstate` - Overwritten, not deleted
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
- `assistant_dialogs`, `assistant_availability` - No deletedAt
- `users_premium`, `communities_premium` - Expire via `activeUntil`, not deleted
- `bot_tokens` - Retired via `revokedAt`, not deletedAt
- `bots_platform_communities` - No timestamps at all
- `staking_positions` - Append-only from on-chain events; unstaking sets `unstakedAt`

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
- `assistant_availability.modelName` - `varchar(255)`
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

1. **TypeORM DataSource** (`srv/util/datasource.ts`): Used for migrations and entity metadata. Accessed via `getDataSource()`.
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

Migrations grant table permissions to two PostgreSQL roles:
- `writer`: Gets `ALL PRIVILEGES` on new tables
- `reader`: Gets `SELECT` on new tables

These roles are referenced in migration files but the role creation itself is handled outside of TypeORM migrations (likely in Docker/infrastructure setup).

Additionally, trigram indexes (`pg_trgm`) are used for fuzzy/partial matching:
- `idx_communities_title_gin_trgm` - Fuzzy search on community titles
- `idx_user_accounts_displayName_gin_trgm` - Fuzzy search on display names

### Database Roles

The PostgreSQL database uses two application-level roles with different privilege levels:
- **`writer`**: Full CRUD access (`GRANT ALL PRIVILEGES ON ALL TABLES`)
- **`reader`**: Read-only access (`GRANT SELECT ON ALL TABLES`)

Every migration that creates a new table must grant appropriate permissions to both roles.
