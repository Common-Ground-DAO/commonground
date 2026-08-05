# Common Ground Backend Documentation

> Status: verified against commit 0f1d72d66, 2026-08-03; rate-limit section
> against the 2026-08-04 dependency-update wave 1a; image-moderation sections
> against the feat/image-filter branch, 2026-08-05.

This document provides a comprehensive reference for the Common Ground backend. It is intended for AI agents and developers working on the codebase.

Common Ground is a web3 community platform (similar to Discord but with blockchain integrations). The backend is a Node.js/TypeScript application using Express, PostgreSQL (via both raw `pg` queries and TypeORM entities), Redis, and Socket.IO for real-time events.

Optional third-party services (email, Twitter auth, blockchain, staking) degrade gracefully: when their credentials are absent the affected feature simply switches off instead of crashing the server. Captcha is the exception — it stays fail-closed via a built-in self-hosted ALTCHA default (`srv/util/captcha.ts`) and only uses reCAPTCHA when that secret is configured. This makes single-server self-hosting viable. The set of enabled capabilities is advertised to the frontend via `srv/util/instanceConfig.ts` (see §7).

---

## Table of Contents

1. [Server Configuration](#1-server-configuration)
2. [API Structure](#2-api-structure)
3. [Entity Model](#3-entity-model)
4. [Repositories](#4-repositories)
5. [Validation](#5-validation)
6. [Background Jobs](#6-background-jobs)
7. [Utilities](#7-utilities)

---

## 1. Server Configuration

### `srv/serverconfig.ts`

Configures external service credentials. It is frozen and exported as an immutable object.

**Keys:**
- `MAILCHIMP_API_KEY` -- Mailchimp marketing API key (from Docker secret `mailchimp_api` or env var; defaults to `placeholder`)
- `MAILCHIMP_SERVER` -- Hardcoded to `us9`
- `MAILCHIMP_DEFAULT_LIST_ID` -- Default mailing list ID (Docker secret `mailchimp_list_id` / env var)
- `SENDGRID_API_KEY` -- SendGrid email API key (from Docker secret `sendgrid_api` or env var; defaults to `placeholder`)
- `SESSION_COOKIE_NAME` -- `connect.sid` in prod, `cg_<deployment>.sid` otherwise
- `PLATFORM_OPERATOR_USER_IDS` -- Frozen list of user IDs allowed to manage platform-owned bots (from `PLATFORM_OPERATOR_USER_IDS` env var, comma-separated)
- `BOT_USER_OWNER_LIMIT` (default 5), `BOT_COMMUNITY_OWNER_LIMIT` (default 10), `BOT_PLATFORM_OWNER_LIMIT` (default 10) -- Max active bots per owner
- `BOT_ACTIVE_TOKEN_LIMIT` (default 10) -- Max active API tokens per bot
- `BOT_API_RATE_LIMIT_PER_MINUTE` (default 120), `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` (default 30) -- Per-token rate limits for the Bot API

On import, it also initializes:
- `mailchimpClient.setConfig(...)` with the Mailchimp credentials
- `sgMail.setApiKey(...)` with the SendGrid key

### `srv/moderation/imageFilter.ts` — NSFW image gate

Server-side, authoritative NSFW filter for every image that enters object
storage. Runs **in-process** via `@huggingface/transformers` +
`onnxruntime-node` (no Python, no sidecar) against a ViT-base image
classifier baked into the backend Docker image (int8/`q8` export of
`Falconsai/nsfw_image_detection`, ~87 MB, loaded from `/models/nsfw`).

- **Hook point:** `fileHelper.saveImage()` (`srv/repositories/files.ts`),
  after sharp normalization and **before** the S3 `PutObject` — the single
  choke point for direct uploads *and* the server-side URL ingests (URL
  previews, LUKSO LSP3 profile images, Twitter/Farcaster avatars). Derived
  images whose source was already classified (social-preview compositions,
  old re-encoding migrations) pass `skipModeration: true`.
- **Processes:** runs in `api` and (for chain-triggered LSP3 images)
  `onchain`. Neither process has an async startup sequence, so the pipeline
  loads lazily on the first classification (~100 ms) and is cached; the
  onchain process only pays the ~300 MB RSS after its first hit.
- **Dedup:** a small promise-LRU keyed by the sha256 of the *source* buffer —
  upload types that store small+large variants of one source classify once,
  including when both run concurrently.
- **Verdict:** the scores of the labels `nsfw`/`porn`/`hentai`/`explicit`
  (case-insensitive; covers swapped-in models) are summed; above
  `IMAGE_MODERATION_THRESHOLD` the upload fails with
  `IMAGE_CONTENT_REJECTED`. Rejections are logged (upload type, scores,
  userId if present, process name — never image data). URL-ingest callers
  already wrap `saveImage()` in try/catch and proceed without an image.
- **Fail-closed:** when classification itself fails (model directory missing
  or unreadable), the image is **not** stored and the caller gets `INTERNAL`.
  A failed model load is retried on the next classification.
- **Config** (env vars, parsed in the shared config): `IMAGE_MODERATION_ENABLED`
  (default `true`), `IMAGE_MODERATION_MODEL_PATH` (default `/models/nsfw`;
  any Transformers.js-layout classifier with `config.json`,
  `preprocessor_config.json` and `onnx/model_quantized.onnx` works — models
  exported without `preprocessor_config.json`, e.g. from timm, silently
  produce garbage), `IMAGE_MODERATION_THRESHOLD` (default `0.8`). The
  enabled-flag is advertised to the frontend as `features.imageFilter` via
  the instance config, gating the client-side pre-upload warning.
- The runtime never fetches models from the network
  (`env.allowRemoteModels = false`); weights are downloaded at image build
  time from a pinned HF revision with sha256 verification
  (`docker/backend/download_model.sh`).

### `src/common/config.ts` (shared config)

Shared between frontend and backend. Contains **no secrets**. Key settings:

- `DEPLOYMENT` -- `'prod'`, `'staging'`, or `'dev'`. Detected from browser URL or `process.env.DEPLOYMENT`.
- `AVAILABLE_CHAINS` / `ACTIVE_CHAINS` -- Supported blockchain networks (Ethereum, Arbitrum, Base, Polygon, Lukso, etc.)
- `PREMIUM` -- Pricing tiers for community and user premium features (Free, Basic, Pro, Enterprise for communities; Supporter 1/2 for users)
- URL path segments (`URL_COMMUNITY = 'c'`, `URL_USER = 'u'`, `URL_ARTICLE = 'article'`, etc.)
- Various limits: `MESSAGE_MAX_CHARS = 2000`, `MAX_LINKED_ADDRESSES = 5`, `IMAGE_UPLOAD_SIZE_LIMIT = 8MB`, etc.
- Feature flags: `NOTIFICATIONS_PAGE_ENABLED`, `TOKEN_CREATION_ENABLED`, etc.
- `COMMUNITY_CONTRACT` -- Address of the on-chain community NFT contract (differs per deployment)

---

## 2. API Structure

### Route Registration Pattern

**File:** `srv/api/util.ts`

All API routes use the `registerPostRoute` helper function, which provides a standardized pattern:

```typescript
registerPostRoute<RequestType, ResponseType>(
  router,
  '/routeName',
  validators.API.Domain.routeName,  // Joi validator (or undefined)
  async (request, response, data) => {
    // handler logic
    return responseData;
  }
);
```

How it works:
1. Registers an Express POST route with `express.json()` middleware
2. Validates the request body against the Joi schema (if provided)
3. Calls the handler with the validated data
4. Wraps the response in `{ status: 'OK', data: result }`
5. On error, calls `handleError()` which returns `{ status: 'ERROR', error: '...' }` -- known errors are passed through; Joi validation errors become `VALIDATION`; unknown errors are generic

**Key exports from `srv/api/util.ts`:**
- `OK` / `ERROR` -- Standard response templates
- `handleError(response, error)` -- Centralized error handling
- `registerPostRoute(...)` -- The route registration helper
- `farcasterApi(type, data)` -- Wrapper for Farcaster Hub API calls (`onChainIdRegistryEventByAddress`, `userDataByFid`)
- `isSignatureValid(...)` -- Verify Ethereum personal signatures using `@metamask/eth-sig-util`
- `convertEventPermissionToCallPermission(...)` -- Map event permissions to call permissions
- `htmlToImage(...)` -- Use Puppeteer to render HTML to image (for social previews)

### `srv/api/getRoutes.ts` -- Social Preview & SSR Routes

An Express router that handles GET requests for social media previews (Open Graph / Twitter Cards). Uses `short-uuid` to translate between short IDs and UUIDs. For each entity type, there are two routes: one for the preview image (`/image.jpeg`) and one for the HTML page with meta tags.

**Routes:**
- `GET /<URL_USER>/:userId/image.jpeg` -- User profile preview image
- `GET /<URL_USER>/:userId` -- User profile HTML with OG tags
- `GET /<URL_COMMUNITY>/:url/<URL_ARTICLE>/:id/image.jpeg` -- Article preview image
- `GET /<URL_COMMUNITY>/:url/<URL_ARTICLE>/:id` -- Article HTML with OG tags
- `GET /<URL_COMMUNITY>/:url/<URL_EVENT>/:id/image.jpeg` -- Event preview image (rendered via Puppeteer)
- `GET /<URL_COMMUNITY>/:url/<URL_EVENT>/:id` -- Event HTML with OG tags
- `GET /<URL_COMMUNITY>/:url/<URL_PLUGIN>/:id/image.jpeg` -- Plugin preview image (rendered via Puppeteer)
- `GET /<URL_COMMUNITY>/:url/<URL_PLUGIN>/:id` -- Plugin HTML with OG tags
- `GET /<URL_APPSTORE>/:id/image.jpeg` -- Appstore plugin preview image
- `GET /<URL_APPSTORE>/:id` -- Appstore plugin HTML
- `GET /<URL_COMMUNITY>/:url/image.jpeg` -- Community preview image (rendered via Puppeteer)
- `GET /<URL_COMMUNITY>/:url` -- Community HTML with OG tags
- `GET /sitemap.xml` -- Dynamic sitemap
- `GET /twitter-callback` -- Twitter OAuth callback (Passport)
- `GET /twitter-login` -- Post-auth Twitter redirect
- `GET /verify-email` -- Email verification redirect
- `GET /token-sale`, `/token` -- Token/Spark page (redirect + OG tags)
- `GET /store` -- App store redirect
- `GET /push-icon` -- Push notification icon
- `GET /gated-videos/:filename` -- Role-gated video streaming
- `GET /gated-files/:filename` -- Role-gated file downloads

### `srv/api/community.ts` -- Community Routes

The largest route file. All routes use `registerPostRoute` on `communityRouter`.

**Community management:**
- `/getCommunityList` -- List communities for the current user
- `/getCommunitiesById` -- Get communities by IDs
- `/getCommunityDetailView` -- Full community detail view
- `/joinCommunity` -- Join a community
- `/leaveCommunity` -- Leave a community
- `/setUserBlockState` -- Ban/unban users
- `/getMemberList` -- Get community members
- `/getChannelMemberList` -- Get channel members
- `/getMemberNewsletterCount` -- Count newsletter subscribers
- `/getUserCommunityRoleIds` -- Get roles for a user in a community
- `/createCommunity` -- Create new community
- `/updateCommunity` -- Update community settings

**Areas (channel groups):**
- `/createArea`, `/updateArea`, `/deleteArea`

**Channels:**
- `/createChannel`, `/updateChannel`, `/deleteChannel`
- `/setChannelPinState` -- Pin/unpin channels

**Roles:**
- `/createRole`, `/updateRole`, `/deleteRole`
- `/checkCommunityRoleClaimability` -- Check if user can claim a token-gated role
- `/claimRole` -- Claim a token-gated role
- `/addUserToRoles`, `/removeUserFromRoles`

**Community tokens:**
- `/addCommunityToken`, `/removeCommunityToken`

**Premium:**
- `/givePointsToCommunity` -- Add points to a community balance
- `/buyCommunityPremiumFeature` -- Purchase premium features
- `/setPremiumFeatureAutoRenew` -- Toggle auto-renewal

**Onboarding:**
- `/getCommunityPassword`, `/verifyCommunityPassword`
- `/setOnboardingOptions`
- `/getPendingJoinApprovals`, `/setAllPendingJoinApprovals`, `/setPendingJoinApproval`
- `/getBannedUsers`

**Articles:**
- `/getArticleList`, `/getArticleDetailView`
- `/createArticle`, `/updateArticle`, `/deleteArticle`
- `/sendArticleAsEmail`

**Calls (voice/video):**
- `/getCall`, `/startCall`, `/startScheduledCall`
- `/getCurrentCalls`, `/getCallParticipantEvents`

**Tags:**
- `/getTagFrequencyData`

**Events:**
- `/getEventList`, `/getMyEvents`, `/getUpcomingEvents`, `/getEvent`
- `/createCommunityEvent`, `/updateCommunityEvent`, `/deleteCommunityEvent`
- `/getEventParticipants`, `/addEventParticipant`, `/addEventParticipantByCallId`, `/removeEventParticipant`

**Transactions:**
- `/getTransactionData`

**Notifications:**
- `/updateNotificationState`

**Newsletter:**
- `/subscribeToCommunityNewsletter`, `/unsubscribeFromCommunityNewsletter`
- `/getLatestArticleSentAsNewsletterDate`, `/getNewsletterHistory`

**Airdrops:**
- `/getAirdropClaimHistory`, `/getAirdropCommunities`

### `srv/api/user.ts` -- User Routes

**Authentication:**
- `/getSignableSecret` -- Get a nonce for signing
- `/verifyCaptcha` -- Verify a captcha token (provider abstraction in `srv/util/captcha.ts`: ALTCHA default / reCAPTCHA / off; ALTCHA challenges via `GET /Captcha/challenge`, the effective provider via `GET /Captcha/config` — both public, `srv/api/captcha.ts`)
- `/clearLoginSession` -- Clear session
- `/checkLoginStatus` -- Check if logged in
- `/logout` -- Log out

**User creation and profile:**
- `/createUser` -- Create new user account
- `/updateOwnData` -- Update own profile data
- `/setOwnExtraDataField` -- Set individual extra data fields
- `/addUserAccount` -- Add an account (CG, Lukso, Twitter, Farcaster)
- `/updateUserAccount`, `/removeUserAccount`
- `/getUserData` -- Get public user data
- `/getUserProfileDetails` -- Get detailed user profile
- `/setOwnStatus` -- Set online status
- `/isCgProfileNameAvailable` -- Check profile name availability
- `/isEmailAvailable` -- Check email availability
- `/setPassword` -- Set/change password

**Wallets:**
- `/prepareWalletAction` -- Prepare wallet linking
- `/addPreparedWallet` -- Complete wallet linking
- `/updateWallet`, `/deleteWallet`, `/getWallets`

**Newsletter:**
- `/subscribeNewsletter`, `/unsubscribeNewsletter`

**Social:**
- `/followUser`, `/unfollowUser`
- `/getFollowers`, `/getFollowing`, `/getFriends`

**Articles (user blog):**
- `/getArticleList`, `/getArticleDetailView`
- `/createArticle`, `/updateArticle`, `/deleteArticle`

**Premium:**
- `/buyUserPremiumFeature`, `/setPremiumFeatureAutoRenew`

**Misc:**
- `/getUserCommunityIds` -- Get IDs of communities the user belongs to
- `/getTransactionData` -- Get point transaction history
- `/requestEmailVerification`, `/verifyEmail`
- `/sendOneTimePasswordForLogin` -- OTP login

### `srv/api/messages.ts` -- Messaging Routes

- `/createMessage` -- Create a new message
- `/createModerationMessage` -- Create a moderation-flagged message
- `/editMessage` -- Edit an existing message
- `/deleteMessage` -- Delete a message
- `/deleteAllUserMessages` -- Delete all messages from a user in a channel
- `/loadMessages` -- Load messages with pagination
- `/messagesById` -- Load specific messages by ID
- `/loadUpdates` -- Load message updates since a timestamp
- `/setReaction`, `/unsetReaction` -- Message reactions
- `/setChannelLastRead` -- Mark channel as read
- `/getUrlPreview` -- Get URL preview metadata (Open Graph scrape of a client-supplied URL)
- `/joinArticleEventRoom`, `/leaveArticleEventRoom` -- Join/leave article real-time rooms

A subset of message routes is also reachable over the Bot API v1 surface (see below). At module load, `messages.ts` allowlists `POST /BotV1/messages/{loadMessages, messagesById, loadUpdates, createMessage, setReaction, unsetReaction}` for bot bearer principals. When a request carries a `botPrincipal`, the handler resolves the acting user from the bot instead of the session, requires an exact `{communityId, channelId}` access target, enforces the per-token bot rate limits, and verifies the bot's active membership/policy for that community before proceeding.

### `srv/api/chats.ts` -- DM / Chat Routes

- `/startChat` -- Start a direct message chat
- `/closeChat` -- Close/delete a chat
- `/getChats` -- Get user's chats

### `srv/api/notifications.ts` -- Notification Routes

- `/loadNotifications` -- Load notification list
- `/loadUpdates` -- Load notification updates
- `/getUnreadCount` -- Get unread count
- `/markAsRead`, `/markAllAsRead` -- Mark notifications read
- `/getPublicVapidKey` -- Get VAPID key for web push
- `/registerWebPushSubscription`, `/unregisterWebPushSubscription` -- Web push management
- `/channelPushNotificationClosed` -- Handle push notification dismissal

### `srv/api/plugins.ts` -- Plugin Routes

- `/createPlugin` -- Create a new plugin
- `/clonePlugin` -- Clone an existing plugin
- `/updatePlugin` -- Update plugin configuration
- `/deletePlugin` -- Delete a plugin
- `/pluginRequest` -- Proxy requests to plugin backends
- `/acceptPluginPermissions` -- Accept plugin permission grants
- `/getAppstorePlugin` -- Get a single appstore plugin
- `/getAppstorePlugins` -- List appstore plugins
- `/getPluginCommunities` -- Get communities using a plugin

### `srv/api/cgid.ts` -- CG ID / Passkey Authentication Routes

- `/ensureSession` -- Ensure a valid session exists
- `/getLoggedInUserData` -- Get data for the logged-in user
- `/generateRegistrationOptions` -- Generate WebAuthn registration options
- `/generateAuthenticationOptions` -- Generate WebAuthn authentication options
- `/verifyRegistrationResponse` -- Verify WebAuthn registration
- `/verifyAuthenticationResponse` -- Verify WebAuthn authentication

### `srv/api/accounts.ts` -- External Account Routes

- `/Farcaster/verifyLogin` -- Verify a Farcaster SIWE login

### `srv/api/contracts.ts` -- Smart Contract Routes

- `/getContractData` -- Get contract metadata (name, symbol, type, etc.)
- `/getContractDataByIds` -- Get contract data for multiple IDs

### `srv/api/files.ts` -- File Upload Routes

- `POST /uploadImage` -- Multipart image upload (handled directly via Express).
  Every stored variant passes the NSFW gate (see
  [`srv/moderation/imageFilter.ts`](#srvmoderationimagefilterts--nsfw-image-gate));
  rejected content answers `{ status: 'ERROR', error: 'IMAGE_CONTENT_REJECTED' }`.
- `/getSignedUrls` -- Get pre-signed S3 URLs for file access

### `srv/api/search.ts` -- Search Routes

Contains internal search logic (uses raw SQL `to_tsvector`/`websearch_to_tsquery` for full-text search).

- `/searchUsers` -- Search users by name
- `/searchArticles` -- Search articles by content

### `srv/api/report.ts` -- Reporting Routes

Both routes require an authenticated session.

- `/createReport` -- Create (or upsert) a report flagging content. Keyed by `(reporterId, targetId, type)`; re-reporting the same target updates the reason and re-opens it.
- `/getReportReasons` -- Get the distinct unresolved report reasons for a given target.

### `srv/api/bots.ts` -- Bot Management Routes (mounted at `/Bot`)

Session-authenticated routes for humans to provision and manage bot accounts. Every handler resolves the acting human user from the session and authorizes against the bot's owner (user / community / platform). Bots themselves cannot reach these routes.

- `/list` -- List bots for an owner (user/community/platform)
- `/listCommunityBots` -- List bots installed in a community (community managers)
- `/listInstallableUserBots` -- Paginated catalog of user-owned bots installable in a community
- `/create` -- Create a bot (creates the underlying bot user, account, and device)
- `/update` -- Update a bot's username, image, description, or platform presence
- `/disable` -- Soft-disable a bot (revokes tokens, removes memberships)
- `/install` -- Install a bot into a community
- `/remove` -- Remove a bot from a community
- `/setRoles` -- Set a bot's custom roles within a community
- `/setAllowUserBots` -- Toggle whether a community accepts user-owned bots
- `/tokens/issue` -- Issue a new bot API token (raw token returned once)
- `/tokens/list` -- List a bot's tokens (metadata only, no secrets)
- `/tokens/revoke` -- Revoke a bot API token

### `srv/api/botV1.ts` -- Bot API v1 (mounted at `/BotV1`)

The public, versioned bot protocol. **Bearer-token only:** requests must carry `Authorization: Bearer cgb_...` and no session cookie; anything without a resolved `botPrincipal` is rejected with 403. Individual routes must be added to the bot allowlist (`allowBotRoute`) to be reachable. Rate limiting is enforced per token.

- `/whoami` -- Return the authenticated bot's identity (protocol version, userId, deviceId, tokenId)
- `/scopes/list` -- Paginated list of community channels the bot may read/write, derived dynamically from its memberships and roles
- `/messages/*` -- The messaging subset re-mounted from `messages.ts` (see the Messaging Routes note above)

### `srv/api/staking.ts` -- Staking Routes (mounted at `/Staking`)

Session-authenticated read-only views over on-chain staking positions. Neither route takes a validator (no request body of note). Staking is disabled unless the instance is configured (see `srv/util/stakingConfig.ts`).

- `/getConfig` -- Return the public staking config (chain, token/contract addresses, base rate, lock bounds) or `null` if unconfigured
- `/getPositions` -- Return the caller's staking positions with accrued and projected total Spark

### `srv/api/twitter.ts` -- Twitter/X Routes

- `GET /startLogin` -- Initiate Twitter OAuth (Passport)
- `/finishLogin` -- Complete Twitter OAuth flow
- `/shareJoined` -- Share a "joined community" post to Twitter/X

### `srv/api/luksoUniversalProfile.ts` -- Lukso Routes

- `/PrepareLuksoAction` -- Prepare a Lukso Universal Profile action

### `srv/api/emails.ts`

Not a route file. Contains email-sending utilities used by other routes. Handles SendGrid email composition for newsletters, articles, event notifications, email verification, and OTP login.

---

## 3. Entity Model

All entities use TypeORM decorators and live in `srv/entities/`. The database is PostgreSQL (database name: `cryptogram`).

### Users Domain

**`User`** (`srv/entities/users.ts`, table: `users`)
- `id` (UUID, PK, auto-generated)
- `password` (text, nullable, select: false) -- bcrypt hash
- `onlineStatus` (enum: OFFLINE, ONLINE, AWAY, DND, INVISIBLE)
- `onlineStatusUpdatedAt` (timestamptz)
- `email` (varchar 64, nullable, select: false)
- `imageId` (varchar 64, nullable) -- profile image hash
- `previewImageId` (varchar 64, nullable)
- `coverImageId` (varchar 64, nullable)
- `tags` (varchar 50 array)
- `features` (jsonb) -- user feature flags
- `platformBan` (jsonb, nullable) -- platform-level ban data
- `followerCount`, `followingCount` (integer)
- `trustScore` (numeric)
- `communityOrder` (UUID array, select: false) -- ordered community IDs
- `emailVerified` (boolean)
- `displayAccount` (enum: UserProfileTypeEnum) -- which account to display
- `newsletter`, `weeklyNewsletter`, `dmNotifications` (booleans)
- `isBot` (boolean, column `is_bot`, default false) -- distinguishes bot accounts from humans; bot management routes assert `is_bot = FALSE` for the acting human
- Relations: `userAccounts`, `devices`, `userRoleClaims`, `notifications`, `callMemberships`, `premiumFeatures`

**`UserAccount`** (`srv/entities/user-accounts.ts`, table: `user_accounts`)
- Composite PK: `userId` + `type` (enum: cg, lukso, twitter, farcaster, bot)
- Bot users own a single `bot`-type account. Bot and `cg` usernames share a case-insensitive uniqueness constraint (`idx_user_accounts_principal_unique_username`), so bots cannot collide with human handles.
- `displayName` (varchar 255)
- `imageId` (varchar 64, nullable)
- `data` (jsonb, nullable, select: false) -- platform-specific data
- `extraData` (jsonb, nullable) -- additional platform data
- ManyToOne -> User

**`UserPremium`** (`srv/entities/users-premium.ts`, table: `users_premium`)
- Composite PK: `userId` + `featureName` (enum: UserPremiumFeatureName)
- `activeUntil` (timestamptz)
- `autoRenew` (enum: PremiumRenewal, nullable)
- ManyToOne -> User

**`Passkey`** (`srv/entities/passkeys.ts`, table: `passkeys`)
- `id` (UUID, PK, auto-generated)
- `userId` -> User
- `data` (jsonb) -- WebAuthn credential data
- `counter` (bigint) -- signature counter

**`Device`** (`srv/entities/device.ts`, table: `devices`)
- `id` (UUID, PK, auto-generated)
- `userId` -> User
- `data` (jsonb) -- device info
- `webPushSubscription` (jsonb, nullable)
- `deviceChannelNotificationSettings` (jsonb, nullable)

### Communities Domain

**`Community`** (`srv/entities/communities.ts`, table: `communities`)
- `id` (UUID, PK, auto-generated)
- `creatorId` -> User (nullable, SET NULL on delete)
- `url` (varchar 30, unique) -- community slug
- `title` (varchar 50)
- `description` (varchar 1000)
- `logoSmallId`, `logoLargeId`, `previewImageId`, `coverImageId` (varchar 64, image hashes)
- `tags` (varchar 50 array)
- `themeData` (jsonb) -- UI theme configuration
- `onboardingOptions` (jsonb, nullable)
- `activityScore` (double precision)
- `memberCount` (integer)
- `pointBalance` (integer)
- `official` (boolean) -- verified community flag
- `hidden` (boolean)
- `searchVector` (tsvector) -- full-text search index
- Relations: `roles`, `areas`, `premiumFeatures`, `communityTokens`, `communityChannels`

**`Area`** (`srv/entities/areas.ts`, table: `areas`)
- `id` (UUID, PK)
- `communityId` -> Community
- `title` (varchar 100)
- `order` (integer)
- OneToMany -> CommunityChannel

**`CommunityChannel`** (`srv/entities/communities-channels.ts`, table: `communities_channels`)
- Composite PK: `communityId` + `channelId`
- `areaId` -> Area (nullable)
- `title` (varchar 100), `url` (varchar 30), `order` (integer)
- `description` (varchar 256, nullable)
- `emoji` (varchar 16, nullable)
- `pinnedMessageIds` (jsonb, nullable)
- `createdAt`, `updatedAt`, `deletedAt` (soft delete)
- OneToMany -> CommunityChannelRolePermissions

**`CommunityChannelRolePermissions`** (table: `communities_channels_roles_permissions`)
- Composite PK: `communityId` + `channelId` + `roleId`
- `permissions` (ChannelPermission enum array)

**`Channel`** (`srv/entities/channels.ts`, table: `channels`)
- `id` (UUID, PK, auto-generated)
- OneToMany -> Message

**`Role`** (`srv/entities/roles.ts`, table: `roles`)
- `id` (UUID, PK)
- `communityId` -> Community
- `title` (varchar 64)
- `type` (enum: RoleType -- e.g., EVERYONE, CUSTOM, TOKEN_GATED)
- `hexColor` (varchar 64, nullable)
- `description` (varchar 140, nullable)
- `assignmentRules` (jsonb, nullable) -- token gating rules
- `contracts` (ManyToMany -> Contract) -- linked smart contracts
- `airdropConfig` (jsonb, nullable) -- airdrop configuration
- `permissions` (CommunityPermission enum array)
- Relations: `userRoleClaims`, `callPermissions`, `eventPermissions`

**`UserRoleClaim`** (`srv/entities/roles.ts`, table: `roles_users_users`)
- Composite PK: `userId` + `roleId`
- `claimed` (boolean) -- whether the role was actively claimed

**`CommunityPremium`** (`srv/entities/communities-premium.ts`, table: `communities_premium`)
- Composite PK: `communityId` + `featureName` (enum)
- `activeUntil` (timestamptz)
- `autoRenew` (enum: PremiumRenewal, nullable)

**`CommunityToken`** (`srv/entities/communities-tokens.ts`, table: `communities_tokens`)
- Composite PK: `communityId` + `contractId`
- `order` (integer)
- `visible` (boolean)

**`UserCommunityState`** (`srv/entities/user-community-state.ts`, table: `user_community_state`)
- Composite PK: `communityId` + `userId`
- `joinedAt`, `leftAt` (timestamptz, nullable)
- `blockState` (enum: UserBlockState, nullable)
- `blockStateData` (jsonb, nullable)
- `approvalState` (enum: CommunityApprovalState, nullable)
- `approvalDate` (timestamptz, nullable)
- Multiple boolean notification preferences: `notifyOnMessages`, `notifyOnArticles`, `notifyOnEvents`, `notifyOnCalls`, `notifyOnBroadcasts`
- `lastEmailSent`, `lastEventEmailSent`, `lastCallEmailSent` (timestamptz)

### Messaging Domain

**`Message`** (`srv/entities/messages.ts`, table: `messages`)
- `id` (UUID, PK, auto-generated)
- `creatorId` -> User
- `channelId` -> Channel
- `body` (jsonb) -- structured message content
- `attachments` (jsonb, nullable)
- `parentMessageId` -> Message (nullable, SET NULL on delete) -- thread replies
- `reactions` (jsonb, nullable)
- `searchVector` (tsvector) -- full-text search
- `editedAt` (timestamptz, nullable)
- Soft delete via `deletedAt`

**`Reaction`** (`srv/entities/reactions.ts`, table: `reactions`)
- Composite PK: `itemId` + `userId`
- `reaction` (varchar 3) -- emoji reaction

**`ChannelReadState`** (`srv/entities/channelreadstate.ts`, table: `channelreadstate`)
- Composite PK: `channelId` + `userId`
- `lastRead` (timestamptz)

**`Chat`** (`srv/entities/chats.ts`, table: `chats`)
- `id` (UUID, PK, auto-generated)
- `userIds` (UUID array) -- participants
- `adminIds` (UUID array)
- `channelId` (UUID, unique) -- associated channel for messages

### Notification Domain

**`Notification`** (`srv/entities/notifications.ts`, table: `notifications`)
- `id` (UUID, PK)
- `type` (enum: NotificationType)
- `userId` -> User (recipient)
- `senderUserId` -> User (nullable)
- `communityId` -> Community (nullable)
- `articleId` -> Article (nullable)
- `channelId` (UUID, nullable)
- `message` (varchar 256)
- `isRead` (boolean, default false)
- `data` (jsonb, nullable) -- extra notification data

### Content Domain

**`Article`** (`srv/entities/articles.ts`, table: `articles`)
- Base article entity for both community and user articles.

**`CommunityArticle`** (`srv/entities/communities-articles.ts`, table: `communities_articles`)
- Composite PK: `communityId` + `articleId`
- `url` (varchar 30, nullable)
- `publishedAt` (timestamptz, nullable)
- `sentAsNewsletter` (boolean)
- `sentAsNewsletterAt` (timestamptz, nullable)
- OneToMany -> CommunityArticleRolePermissions

**`CommunityArticleRolePermissions`** (table: `communities_articles_roles_permissions`)
- Composite PK: `communityId` + `articleId` + `roleId`
- `permissions` (ArticlePermission enum array)

**`UserArticle`** (`srv/entities/users-articles.ts`, table: `users_articles`)
- Composite PK: `userId` + `articleId`
- `url` (varchar 30, nullable)
- `publishedAt` (timestamptz, nullable)

### Calls Domain

**`Call`** (`srv/entities/call.ts`, table: `calls`)
- `id` (UUID, PK)
- `communityId` -> Community
- `creatorId` -> User
- `channelId` -> Channel
- `callServerId` -> CallServer (nullable)
- `type` (enum: CallType -- DEFAULT, BROADCAST)
- `title` (varchar 100), `description` (varchar 200, nullable)
- `userIds` (UUID array), `slots` (int), `stageSlots` (int)
- `audioOnly`, `highQuality` (boolean)
- `endedAt` (timestamptz, nullable)
- Relations: `memberships`, `permissions`

**`CallMembership`** (table: `callmembers`)
- `id` (UUID, PK)
- `callId` -> Call
- `userId` -> User

**`CallPermissions`** (table: `callpermissions`)
- Composite PK: `callId` + `roleId`
- `permissions` (CallPermission enum array)

**`CallServer`** (`srv/entities/callserver.ts`, table: `callservers`)
- `id` (UUID, PK)
- `status` (jsonb) -- server status data
- `url` (varchar 255, unique)
- OneToMany -> Call

### Events Domain

**`CommunityEvent`** (`srv/entities/communities-events.ts`, table: `communities_events`)
- `id` (UUID, PK)
- `communityId` -> Community
- `url` (varchar 30, nullable)
- `creatorId` -> User
- `channelId` (UUID, nullable) -- associated channel for the event
- `type` (enum: CommunityEventType)
- `externalUrl` (varchar 64, nullable)
- `title` (varchar 100)
- `body` (jsonb) -- event description
- `location`, `coverImageId` (varchar 250)
- `scheduleDate` (timestamptz)
- `durationMinutes` (integer, nullable)
- `isAllDay` (boolean)
- Relations: `participants`, `permissions`

**`CommunityEventParticipant`** (table: `communities_events_participants`)
- Composite PK: `communityEventId` + `userId`

**`CommunityEventPermissions`** (table: `communities_events_permissions`)
- Composite PK: `communityEventId` + `roleId`
- `permissions` (CommunityEventPermission enum array)

### Blockchain Domain

**`Contract`** (`srv/entities/contracts.ts`, table: `contracts`)
- `id` (UUID, PK)
- `address` (varchar 64) -- contract address
- `chain` (varchar 50) -- chain identifier
- `contractData` (jsonb) -- name, symbol, type, decimals, etc.
- `lastCheckedBlock` (bigint, select: false)
- ManyToMany -> Role
- OneToMany -> WalletBalance

**`TokenData`** (table: `token_data`)
- Composite PK: `contractId` + `tokenId`
- `metadata` (jsonb) -- NFT/token metadata

**`Wallet`** (`srv/entities/wallets.ts`, table: `wallets`)
- `id` (UUID, PK)
- `userId` -> User (nullable, SET NULL on delete)
- `type` (enum: WalletType -- CG_EVM, EVM, CONTRACT_EVM)
- `walletIdentifier` (text) -- address
- `isLoginWallet` (boolean)
- `visibility` (enum: WalletVisibility -- PUBLIC, FOLLOWED, PRIVATE)
- `signatureData` (jsonb) -- verification signature
- `label` (varchar 64, nullable)
- OneToMany -> WalletBalance

**`WalletBalance`** (table: `wallet_balances`)
- Composite PK: `walletId` + `contractId`
- `balance` (jsonb) -- balance data (supports multiple token standards)

**`ChainData`** (`srv/entities/chaindata.ts`, table: `chaindata`)
- `key` (varchar 255, PK) -- arbitrary key
- `value` (json) -- cached on-chain data

### Token Sale Domain (retired, kept for auditability)

The token-sale feature was removed in the Phase-2 slimming (2026-08-01). The four
tables and their entities are deliberately **kept**: they hold the historical sale
records. No code writes them any more, and no route reads them.

**`TokenSale`** (`srv/entities/tokensale.ts`, table: `tokensales`)
- Configuration for a token sale event (contract addresses, chains, dates, pricing).

**`TokenSaleRegistration`** (table: `tokensale_registrations`)
- User registration for token sales with referral tracking.

**`TokenSaleUserData`** (table: `tokensale_userdata`)
- Per-user/per-sale data: investment amounts, reward calculations, contribution tracking.

**`TokenSaleInvestment`** (table: `tokensale_investments`)
- Individual investment events linked to on-chain transactions.

### Plugins Domain

**`Plugin`** (`srv/entities/plugins.ts`, table: `plugins`)
- `id` (UUID, PK)
- `communityId` -> Community (creator's community)
- `name` (varchar 255)
- `permissions` (text array, nullable)
- `description` (text), `iframeUrl` (text)
- `configuration` (jsonb, nullable) -- plugin schema
- `imageId` (varchar 64, nullable)
- `verified`, `published`, `flagged`, `editable` (boolean flags)

**`CommunityPlugin`** (`srv/entities/communities-plugins.ts`, table: `communities_plugins`)
- `id` (UUID, PK)
- `communityId` -> Community, `pluginId` -> Plugin
- `name` (varchar 255) -- display name override
- `configuration` (jsonb) -- instance configuration
- `createdAt`, `updatedAt`, `lastDataUpdate` (timestamptz)

**`UserPluginState`** (`srv/entities/user-plugin-state.ts`, table: `user_plugin_state`)
- Composite PK: `userId` + `pluginId`
- `data` (jsonb, nullable) -- per-user plugin state

### Misc Entities

**`UploadFile`** (`srv/entities/files.ts`, table: `files`)
- `id` (UUID, PK)
- `userId` -> User (nullable)
- `sha256` (varchar 64, unique) -- content hash
- `metadata` (jsonb, nullable), `previewMetadata` (jsonb, nullable)
- `createdAt` (timestamptz)

**`RoleGatedFile`** (`srv/entities/role-gated-files.ts`, table: `role_gated_files`)
- `filename` (varchar 255, PK)
- `type` (varchar 30) -- "video" or "file"
- `roleId` -> Role

**`Report`** (`srv/entities/reports.ts`, table: `reports`)
- Reports/flags for content moderation.

**`LogEntry`** (`srv/entities/logging.ts`, table: `logging`)
- `id` (UUID, PK)
- `action` (varchar 30) -- log action type
- `data` (jsonb) -- log payload

**`OneshotJob`** (`srv/entities/oneshots.ts`, table: `oneshot_jobs`)
- `id` (varchar 256, PK) -- job identifier
- Used to track one-time migration/fix jobs so they are not re-run.

**`PointTransaction`** (`srv/entities/transactions.ts`, table: `point_transactions`)
- `id` (UUID, PK)
- `communityId`, `userId` (UUID, nullable)
- `amount` (integer)
- `data` (jsonb) -- transaction details

**`UserCommunityAirdrop`** (`srv/entities/airdrops.ts`, table: `user_community_airdrops`)
- `id` (UUID, PK)
- `communityId` -> Community, `roleId` -> Role, `userId` -> User
- `airdropData` (jsonb) -- airdrop details
- `executedAt` (timestamptz)

**`UserChannelSettings`** (`srv/entities/user-channel-settings.ts`)
- Per-user per-channel notification settings.

### Bots Domain

**`Bot`** (`srv/entities/bots.ts`, table: `bots`)
- `userId` (UUID, PK) -- OneToOne -> User (the bot's user account, CASCADE on delete)
- `deviceId` (UUID, unique) -- OneToOne -> Device (the bot's synthetic device)
- `ownerType` (enum: BotOwnerType -- user, community, platform)
- `ownerId` (UUID, nullable) -- the owning user or community; `NULL` for platform bots
- `platformPresenceMode` (enum: BotPlatformPresenceMode -- all, selected; nullable) -- for platform bots, whether they auto-join all communities or a curated set
- `description` (text, nullable)
- `connectedSocketCount` (integer, default 0), `lastConnectedAt` (timestamptz, nullable) -- server-derived connection presence
- `createdAt`, `updatedAt`, `deletedAt` (soft delete; disabling a bot sets `deletedAt`)
- Partial index on `(ownerType, ownerId)` where not deleted

**`BotToken`** (`srv/entities/bot-tokens.ts`, table: `bot_tokens`)
- `id` (UUID, PK)
- `botUserId` -> Bot (CASCADE on delete)
- `tokenHash` (char 64, unique, select: false) -- SHA-256 hash of the raw bearer token; the raw token (`cgb_` + base64url random) is shown only once at issue time and never stored
- `name` (varchar 100, nullable)
- `lastUsedAt` (timestamptz, nullable) -- throttled write (at most every 5 minutes)
- `createdAt` (timestamptz), `revokedAt` (timestamptz, nullable)
- Partial index on `botUserId` where not revoked

**`BotPlatformCommunity`** (`srv/entities/bots-platform-communities.ts`, table: `bots_platform_communities`)
- Composite PK: `botUserId` + `communityId`
- Join table selecting which communities a `selected`-mode platform bot participates in.

### Staking Domain

**`StakingPosition`** (`srv/entities/staking-positions.ts`, table: `staking_positions`)
- One on-chain `CgStaking` position, indexed from contract events by the on-chain listener. Rows are created on `Staked` events and never deleted; unstaking sets `unstakedAt`.
- `id` (UUID, PK)
- `chain` (varchar 64), `contractAddress` (varchar 50), `walletAddress` (varchar 50)
- `positionId` (bigint) -- per-owner position index inside the contract
- `userId` (UUID, nullable) -> User (SET NULL) -- resolved from the wallet mapping at indexing time, backfilled/cleared as wallets are linked/deleted; only positions with a `userId` accrue Spark
- `amount` (numeric(39,0)) -- token base units (18-decimal), stored as a numeric string
- `stakedAt`, `unlockAt` (timestamptz), `unstakedAt` (timestamptz, nullable)
- `stakeTxHash` (varchar 80), `stakeLogIndex` (integer), `unstakeTxHash` (varchar 80, nullable)
- `accruedThroughDay` (date, nullable) -- last UTC day the accrual job credited
- `accruedSpark` (bigint, default 0) -- running total of Spark credited for this position
- Unique on `(chain, contractAddress, walletAddress, positionId)` and on `(chain, stakeTxHash, stakeLogIndex)` so at-least-once event delivery yields exactly-once effects.

---

## 4. Repositories

Located in `srv/repositories/`. Each file exports a singleton helper class (or module) that encapsulates database operations for a domain. Repositories use **raw SQL** via the `pg` Pool (not TypeORM query builder) for performance and control. SQL is constructed using `pg-format` for safe parameter interpolation.

### Pattern

```typescript
// Private function with db parameter for transaction support
async function _doSomething(db: Pool | PoolClient, ...) { ... }

// Public class wrapping private functions with pool
class DomainHelper {
  async doSomething(...) { return _doSomething(pool, ...); }
  async doSomethingInTransaction(...) {
    const client = await pool.connect();
    await client.query('BEGIN');
    // ... call _doSomething(client, ...) ...
    await client.query('COMMIT');
    client.release();
  }
}
export default new DomainHelper();
```

The `db: Pool | PoolClient` parameter pattern enables functions to work both standalone and within transactions.

### Repository Files

**`srv/repositories/users.ts`** -- `userHelper`
- User CRUD, account management, password hashing (bcrypt, 8 salt rounds)
- Social preview data, profile details, own data retrieval
- User creation (complex: creates user + accounts + wallets + device in transaction)
- Account operations: add/update/remove accounts, contract wallet management
- Profile name and email availability checks
- Follow/unfollow users, Mailchimp newsletter subscription
- Premium feature purchases

**`srv/repositories/communities.ts`** -- `communityHelper`
- Largest repository (~4700 lines). Handles all community operations.
- Community CRUD, member management, area/channel/role management
- Token-gated role claim checks (delegates to onchain service)
- Permission checking, community premium features
- Newsletter operations, airdrop handling, social preview generation

**`srv/repositories/messages.ts`** -- `messageHelper`
- Message CRUD with structured body (jsonb)
- Message loading with pagination, reactions, own-reaction tracking
- URL preview generation, search via `to_tsvector`
- Reaction management (set/unset with validation)
- Channel read state management

**`srv/repositories/chats.ts`** -- `chatHelper`
- DM chat creation (creates a Chat + Channel in one transaction)
- Chat retrieval with unread counts and last message
- Chat closing (soft delete)

**`srv/repositories/notifications.ts`** -- `notificationHelper`
- Notification creation and delivery
- Web push notification sending (via `web-push` library)
- Batch operations (mark as read, load with pagination)

**`srv/repositories/event.ts`** -- `eventHelper`
- Real-time event emission via Socket.IO Redis Emitter
- Routes events to specific rooms (user, community, role, device, session, article)
- `emit(event, target, except)` pattern for targeted delivery

**`srv/repositories/permissions.ts`** -- `permissionHelper`
- Role permission queries for channels, calls, events, articles, and communities
- User permission checks (e.g., does user have CHANNEL_WRITE in a channel?)

**`srv/repositories/files.ts`** -- `fileHelper`
- S3 storage operations (upload, download, signed URLs)
- `saveImage()` runs the NSFW gate on the normalized buffer before the S3
  upload (`srv/moderation/imageFilter.ts`); internal derived images opt out
  via `skipModeration`
- Image processing with `sharp` (resize, convert to JPEG/WebP, hexagonal crops for profile images)
- Preview image generation (community previews, user previews)
- Composite image creation for social previews

**`srv/repositories/articles.ts`** -- `articleHelper`
- Community and user article CRUD
- Article listing with role-based permission filtering
- Article social preview data retrieval
- Newsletter email preparation

**`srv/repositories/calls.ts`** -- `callHelper`
- Call lifecycle management (create, end, join, leave)
- Call server management and allocation
- Participant tracking, permission management

**`srv/repositories/communityEvents.ts`** -- `communityEventHelper`
- Community event CRUD
- Participant management, upcoming event queries
- Event notification preparation

**`srv/repositories/contracts.ts`** -- `contractHelper`
- Smart contract data retrieval and caching
- Contract creation and updates

**`srv/repositories/wallets.ts`** -- `walletHelper`
- Wallet CRUD, SIWE (Sign-In With Ethereum) data parsing and verification
- Wallet balance tracking, login wallet management
- EVM only: Fuel and Aeternity were removed entirely on 2026-08-01, rows included

**`srv/repositories/onchain.ts`** -- `onchainHelper`
- Proxy to the separate `onchain` microservice (HTTP at `http://onchain:4000`)
- Contract data retrieval, role claimability checks
- RPC provider management

**`srv/repositories/plugins.ts`** -- `pluginHelper`
- Plugin CRUD, appstore operations
- Plugin permission management
- Community plugin instance management

**`srv/repositories/emails.ts`** -- `emailHelper`
- Email content preparation (articles, newsletters)
- Post retrieval for newsletter content

**`srv/repositories/newsletter.ts`** -- `newsletterHelper`
- Newsletter entry management
- Community newsletter subscription tracking
- Delivery status tracking

**`srv/repositories/report.ts`** -- `reportHelper`
- Report creation (upsert keyed by reporter/target/type) and unresolved-reason retrieval

**`srv/repositories/bots.ts`** -- `botHelper`
- Bot lifecycle: create/update/disable, install/remove into communities, role assignment
- Authorization helpers that assert the actor is a human with the right owner authority (user owns the bot / community manager / platform operator) and per-owner bot limits (advisory-lock guarded)
- Membership and role reconciliation for user- and platform-owned bots (e.g. re-checking policy when `allowUserBots` changes or a new community appears), with real-time membership/role events
- Scope discovery (`listScopes`) and socket-room computation for the Bot API, plus server-derived connection presence (`setConnectionPresence`)

**`srv/repositories/botTokens.ts`** -- `botTokenHelper`
- Issue/list/revoke bot API tokens (SHA-256 hashed, `BOT_ACTIVE_TOKEN_LIMIT` enforced under an advisory lock)
- `authenticate(rawToken)` -- validates the bearer token format, looks up the active token + bot + device, re-verifies the owner is still valid (owner not platform-banned, community not deleted), and returns a `BotTokenPrincipal`

**`srv/repositories/staking.ts`** -- `stakingHelper`
- Idempotent recording of `Staked` / `Unstaked` events into `staking_positions`
- `syncClaimsForUser` -- (re)assigns positions to a user from their linked wallets; newly claimed positions have their accrual baseline raised to the current pro-rata target so past growth is never minted retroactively
- `getPositionsByUser` -- position views with accrued and projected total Spark
- `runAccrual(config)` -- single atomic statement (`FOR UPDATE ... SKIP LOCKED`) that credits each claimed position up to its time-based pro-rata target, writes the delta to the `point_transactions` ledger, and bumps user `pointBalance`; fully idempotent and self-catching-up after downtime

**`srv/repositories/device.ts`** -- `deviceHelper`
- Device registration, update, deletion
- Web push subscription management

**`srv/repositories/logging.ts`** -- `loggingHelper`
- Audit log entry creation

---

## 5. Validation

### Pattern

**Index file:** `srv/validators/index.ts`

Exports a nested validator object mirroring the API structure:

```typescript
validators = {
  Common,        // Shared validators
  API: {
    BaseArticle, User, Community, Chat, Message,
    Files, Contract, Notification, Socket, Twitter,
    Lukso, Accounts, CgId, Plugin, Search,
    Report, Bot
  }
}
```

Each API validator module exports Joi schemas matching the API request types. For example, `validators.API.Chat.startChat` validates the `API.Chat.startChat.Request` type.

Note: the Staking routes carry no validators (they take no meaningful request body), so there is no `validators.API.Staking` module.

### Common Validators (`srv/validators/common.ts`)

Reusable Joi schemas:
- `Uuid` -- UUID v4 regex
- `ImageId` -- SHA-256 hex string (64 chars)
- `ItemUrl` -- URL slug (`/^[a-z0-9-]{3,50}$/i`)
- `ChainIdentifier` -- Whitelisted blockchain identifiers (eth, optimism, arbitrum, base, matic, lukso, etc.)
- `Address` -- Ethereum address (`/^0x[a-fA-F0-9]{40}$/`)
- `JsonWebKey` -- WebAuthn public key (P-384 curve)
- `Base64DeviceSignature` -- Device signature
- `CgProfileDisplayName` -- `/^[a-z0-9_-]{3,30}$/i`
- `OnlineStatus` -- online, away, dnd, invisible
- `Tag` / `Tags` -- Tag strings, max 50 unique tags
- `Emoji` -- Unicode emoji
- `Password`, `Secret`, `DateString`, `EIP712Signature`

### Content Validators (`srv/validators/content.ts`)

Validates structured message/article content. Content is an array of typed items:
- `Text` -- `{ type: 'text', value, bold?, italic? }`
- `Tag` -- `{ type: 'tag', value }`
- `Ticker` -- `{ type: 'ticker', value }`
- `Link` -- `{ type: 'link', value }`
- `RichTextLink` -- `{ type: 'richTextLink', value, url }`
- `Newline` -- `{ type: 'newline' }`
- `Mention` -- `{ type: 'mention', userId, alias? }`
- `Header` -- `{ type: 'header', value: Text[] }`
- `ArticleImage` -- `{ type: 'articleImage', imageId, largeImageId, caption, size }`
- `ArticleEmbed` -- `{ type: 'articleEmbed', ... }`

### API Validator Modules (`srv/validators/api/`)

Each module exports Joi schemas matching their domain's API request types. Files:
- `accounts.ts` -- Farcaster login
- `basearticle.ts` -- Shared article validation
- `bot.ts` -- Bot management and Bot API v1 operations
- `cgid.ts` -- Passkey authentication
- `chat.ts` -- Chat operations
- `community.ts` -- Community operations (the largest)
- `contract.ts` -- Contract queries
- `file.ts` -- File uploads
- `lukso.ts` -- Lukso operations
- `mediasoup.ts` -- Protoo request handlers of the call server (wired as `validators.API.Mediasoup`)
- `message.ts` -- Message operations
- `notification.ts` -- Notification operations
- `plugin.ts` -- Plugin operations
- `report.ts` -- Reports
- `search.ts` -- Search queries
- `socket.ts` -- WebSocket event validation
- `twitter.ts` -- Twitter operations
- `user.ts` -- User operations

---

## 6. Background Jobs

Located in `srv/jobs/`. All jobs are designed to run as **worker threads** (they throw if run on the main thread). They import `pool` directly and execute SQL queries.

### Scheduling (`srv/jobs.ts`)

`srv/jobs.ts` spawns each job as a worker thread and manages three kinds:
- **Permanent workers** (long-running, auto-restart on exit): `premiumRenewal`, `callUpdateEmitter`, `handleCommunityAirdrops`.
- **Cron / interval workers** (re-spawned on a schedule, skipped if the previous run is still alive): `onlineStatusCheck` (every 30 s), `stakingAccrual` (`17 */6 * * *`, every 6 h), `activityScore` (`*/10 * * * *`), `newsletterDelivery` (`0 12 * * 6`, weekly Saturday noon), `emailNotifications` (every minute).
- **One-shot workers** (run once at startup, guarded by the `oneshot_jobs` table): none currently. The `createOneshotWorker` helper and the `oneshot_jobs` table are kept for future backfills; the eight historical backfill jobs were removed in 2026-08 after they had run everywhere (their code is in git history).

### `activityScore.ts`
- **Purpose:** Recalculates community activity scores based on recent messages and articles.
- **Logic:** Iterates over all communities. For each, queries recent messages and articles (within ~90 days). Applies a decay function: newer content is worth more. Verified (premium) users' contributions are weighted 3x for messages, 3x/5x for articles. Updates the `activityScore` field on each community.

### `emailNotifications.ts`
- **Purpose:** Sends article-as-email notifications and event-starting notifications.
- **Two jobs in one:**
  1. `articleNotifications` -- Finds community articles marked for email delivery, prepares them, and sends via SendGrid to newsletter subscribers.
  2. `eventNotifications` -- Finds upcoming events that need notification, sends email reminders to participants.

### `newsletterDelivery.ts`
- **Purpose:** Sends the weekly platform newsletter to subscribed users.
- **Logic:** Generates a newsletter ID from the current date. Creates newsletter entries for eligible users. Sends personalized emails containing posts from followed communities plus general platform posts. Retries failed sends once.

### `premiumRenewal.ts`
- **Purpose:** Auto-renews expiring premium features for communities and users.
- **Logic:** Queries features expiring within 3 minutes that have `autoRenew` set. Checks if the entity has enough point balance. If so, deducts points and extends the active period. Emits real-time events on renewal or expiration.

### `onlineStatusCheck.ts`
- **Purpose:** Sets stale users to offline.
- **Logic:** Updates users whose `onlineStatusUpdatedAt` is older than 90 seconds and status is not already offline. Simple cleanup query.

### `stakingAccrual.ts`
- **Purpose:** Credits Spark for on-chain staking positions.
- **Logic:** No-op if staking is unconfigured on the instance. Otherwise calls `stakingHelper.runAccrual`, which advances every claimed position to its current time-based pro-rata target in one atomic statement and ledgers the delta. Because the target is a function of elapsed time (not of job executions), the job is idempotent and self-catching-up after downtime. Emits `cliUserOwnData` events so credited users see their balance update live.

### `handleCommunityAirdrops.ts`
- **Purpose:** Executes finished role-based airdrops.
- **Logic:** Finds roles with airdrop configurations past their end date that haven't been executed. For each, finds eligible members (those who claimed the role), calculates distribution using configurable price functions, and records airdrop entries.

### `callUpdateEmitter.ts`
- **Purpose:** Monitors call server status and emits real-time updates about active calls.
- **Logic:** Tracks call servers, their online status, and ongoing calls. Ends empty/stale calls. Emits updates to relevant community rooms.

---

## 7. Utilities

Located in `srv/util/`.

### `srv/util/index.ts` -- Core Utilities

- `move(oldPath, newPath)` -- Move files across filesystems (rename with copy fallback)
- `sha256(filePath)` -- Compute SHA-256 hash of a file
- `sleep(ms)` -- Promise-based delay
- `requestData(url, acceptContentTypes?)` -- Low-level HTTP/HTTPS request helper
- `randomString(length=20)` -- Generate random alphanumeric string
- `realRandomHexString(byteLength=16)` -- Cryptographically secure random hex
- `dockerSecret(secretName)` -- Read Docker secrets from `/run/secrets/<name>`. Returns the secret string or `false` if not found.
- `getTruncatedId(userId)` -- Truncate UUID for display (`xxxx...xxxx`)
- `getDisplayNameString(userData)` -- Get the display name from user's active account
- Room key generators for Socket.IO rooms:
  - `userRoomKey(userId)` -> `user:<id>`
  - `communityRoomKey(communityId)` -> `community:<id>`
  - `roleRoomKey(roleId)` -> `role:<id>`
  - `deviceRoomKey(deviceId)` -> `device:<id>`
  - `expressSessionRoomKey(sessionId)` -> `expressSession:<id>`
  - `articleRoomKey(articleId)` -> `article:<id>`

### `srv/util/postgres.ts` -- PostgreSQL Connection Pool

Creates and exports a `pg.Pool` instance connected to database `cryptogram`. Configuration:
- User: `PG_SU_NAME` or `DB_TYPE` env vars, default `cryptoadmin`
- Host: `DB_HOST` env var, default `db`
- Password: from Docker secrets (`pg_su_password` or `pg_password`) or env vars
- Port: `DB_PORT` env var, default `5432`
- Supports mutual TLS via Docker secrets (`rootca.crt`, `appservers.key`, `appservers.crt`)

### `srv/util/datasource.ts` -- TypeORM DataSource

Configures the TypeORM DataSource for entity management and migrations. Uses the same database credentials as the raw pool. Key settings:
- Entities loaded from `srv/entities/*.js`
- Migrations loaded from `srv/migrations/*.js`
- `synchronize: false` -- migrations must be run manually
- `uuidExtension: 'pgcrypto'`
- Exports `ormDataSource` and `getDataSource()` (async, initializes once)

### `srv/util/rateLimit.ts` -- IP Rate Limiting

Redis-based rate limiter using sorted sets for sliding window counting.

`ipRateLimitHandler(options)` -- Returns an async function that:
1. Extracts IP from `x-forwarded-for` header (supports IPv4 and IPv6 with /48, /56, /64 subnets)
2. Checks counts in Redis sorted sets per URL+IP combination
3. Applies separate limits for IPv4/IPv6-64, IPv6-56, and IPv6-48 prefixes
4. Throws `RATE_LIMIT_EXCEEDED` if any limit is breached

The IP classification itself lives in `srv/util/ipPrefix.ts` (2026-08: built on
`node:net` `isIPv4`/`isIPv6`, replacing the unmaintained `ip` package). IPv6
bucket keys are zero-padded per-byte hex of the /64, /56 and /48 prefixes;
v4-mapped addresses (`::ffff:a.b.c.d`) key on the embedded IPv4; inputs that
fail strict validation get no keys and the request is rejected with
`INVALID_REQUEST`. Unit tests: `srv/tests/ipPrefix.spec.ts` (runs via
`yarn tests` in `srv/`).

### `srv/util/express.ts` -- Express Configuration

Sets up Express with:
- CORS configuration
- Session management via `connect-redis` (Redis-backed sessions)
- Cookie parser
- Passport integration (for Twitter OAuth)

Declares TypeScript session data types including:
- `user?: { id, deviceId }` -- authenticated user
- `signSecret?` -- nonce for signature verification
- `twitter?`, `lukso?`, `farcaster?`, `cgid?` -- OAuth/auth flow state

### `srv/util/urls.ts` -- URL Configuration

Derives application URLs from `BASE_URL` env var or deployment settings:
- `APP_URL` -- Full app URL (e.g., `https://app.cg`)
- `API_URL` -- API base URL (e.g., `https://app.cg/api/v2`)
- `APP_HOSTNAME`, `PROTOCOL`, `PORT_SUFFIX`

### `srv/util/memberListHelpers.ts` -- Member List Binary Conversion

Converts member lists between binary (UTF-16LE encoded UUIDs) and standard UUID string format. Used for efficient member list storage/transmission in Redis.

### `srv/util/axios.ts` -- Axios Instance

Custom Axios instance that forces `keepAlive: false` on both the HTTP and HTTPS agent. It was introduced for a Node.js-20-era Axios bug ([axios#5929](https://github.com/axios/axios/issues/5929), rooted in [nodejs#47130](https://github.com/nodejs/node/issues/47130)) and has **not** been re-checked since the Node 24 bump — see `docs/todo/TODO.md`.

### `srv/util/botPrincipal.ts` -- Bot Bearer Authentication

Express middleware and helpers for the Bot API:
- `allowBotRoute(method, path)` -- register a route as reachable by bot bearer principals
- `botAuthenticationMiddleware` -- if an `Authorization` header is present (and no session cookie), resolve the bearer token to a `botPrincipal`; requests with both a cookie and a bearer header are rejected
- `botAllowlistMiddleware` -- restrict bot principals to the allowlisted routes

### `srv/util/botProtocol.ts` -- Bot Identity

`getBotIdentity(request)` -- builds the `/BotV1/whoami` response (protocol version, userId, deviceId, tokenId) and enforces the per-token API rate limit.

### `srv/util/botRateLimit.ts` -- Bot Rate Limiting

`enforceBotRateLimit(tokenId, scope)` -- Redis fixed-window counter (per minute) applying `BOT_API_RATE_LIMIT_PER_MINUTE` (`api` scope) or `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` (`message` scope); throws `RATE_LIMIT_EXCEEDED` when the limit is exceeded.

### `srv/util/stakingConfig.ts` -- Staking Configuration

Parses the staking feature configuration from env vars (`STAKING_CHAIN`, `STAKING_CONTRACT_ADDRESS`, `STAKING_TOKEN_ADDRESS`, `STAKING_BASE_RATE`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`). Returns `null` (feature off) unless chain plus both addresses are present and valid. `getStakingConfig()` exposes the parsed config.

### `srv/util/instanceConfig.ts` -- Instance Identity / Capability Flags

Builds the `window.__CG_INSTANCE__` script tag injected into served `index.html` pages (share links / social previews). Declares the deployment, app/CGID URLs, active chains, and a `features` map derived from which credentials and services this server actually has (`email`, `twitterAuth`, and `calls` from `CG_ENABLE_CALLS`) so the frontend can hide features that would only fail. Optional keys (reCAPTCHA site key, Giphy key, WalletConnect project id) are included when configured.
