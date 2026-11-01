# Common Ground Backend Documentation

> Status: verified against commit 0f1d72d66, 2026-08-03; rate-limit section
> against the 2026-08-04 dependency-update wave 1a; image-moderation sections
> against the fix/image-filter-review-53 branch, 2026-08-15; upload rate limit,
> `Instance` route, URL-preview note, OpenAPI drift check, axios note and §8
> (dependency notes) against commit 935232158, 2026-10-31; puppeteer browser
> install note against commit 5f73578, 2026-10-31; email (SMTP sending layer,
> `emailUnsubscribe` routes, `bucket` rate-limit option and
> `keyRateLimitHandler`, mail send limits, `bounceReceiver` job and bounce
> policy, Mailchimp removal), message access scope, `/deleteMessage`,
> `/getUrlPreview`, `safeFetch`, `/pluginRequest`, user-article visibility and
> the test list against commit e44dac1, 2026-10-31; URL-preview cache instance
> and the node-redis/Valkey note against commit ff0da06, 2026-10-31; §8 against
> commit ff0da06, 2026-10-31; passkeys (`Passkey` and legacy `CgId` routes,
> `srv/util/passkeys.ts`, `passkeyConfig.ts`, `authSession.ts`,
> `signupEmail.ts`, `srv/repositories/passkeys.ts`), the new `User` auth
> routes, step-up, the plugin URL check and the passkey test files against
> commit 54e2d73, 2026-10-31; the TypeScript 6 / joi 18 note in §8 against
> commit d604544, 2026-10-31; the `Instance` allowlist note against commit fe3937f, 2026-10-31;
> `asyncHandler` (raw-route error handling), the `/uploadImage` error note, the
> gated-file streaming note and the test list against commit 6934817, 2026-11-01;
> transfer links, the account-security step, password policy, login throttling,
> email codes, the SIWE domain check and the auth-path logging against commit
> 9fc05a9, 2026-11-01.

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
8. [Dependency Notes](#8-dependency-notes)

---

## 1. Server Configuration

### `srv/serverconfig.ts`

Server settings read from the environment. It is frozen and exported as an immutable object. (Email/SMTP settings are not here — they are parsed by `srv/util/mailConfig.ts`, see [docs/email-notifications](../email-notifications/README.md#transport--configuration).)

**Keys:**
- `SESSION_COOKIE_NAME` -- `connect.sid` in prod, `cg_<deployment>.sid` otherwise
- `PLATFORM_OPERATOR_USER_IDS` -- Frozen list of user IDs allowed to manage platform-owned bots (from `PLATFORM_OPERATOR_USER_IDS` env var, comma-separated)
- `BOT_USER_OWNER_LIMIT` (default 5), `BOT_COMMUNITY_OWNER_LIMIT` (default 10), `BOT_PLATFORM_OWNER_LIMIT` (default 10) -- Max active bots per owner
- `BOT_ACTIVE_TOKEN_LIMIT` (default 10) -- Max active API tokens per bot
- `BOT_API_RATE_LIMIT_PER_MINUTE` (default 120), `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` (default 30) -- Per-token rate limits for the Bot API

### `srv/moderation/imageFilter.ts` — NSFW image gate

Server-side, authoritative NSFW filter for every image that enters object
storage. Runs **in-process** via `@huggingface/transformers` +
`onnxruntime-node` (no Python, no sidecar) against a ViT-base image
classifier baked into the backend Docker image (int8/`q8` export of
`Falconsai/nsfw_image_detection`, ~87 MB, loaded from `/models/nsfw`).
The model is strong on photographic explicit content and deliberately tuned
for near-zero false positives; **drawn/anime explicit content (hentai) is a
known weak spot** of this classifier — a documented, accepted limitation
(community moderation covers it; evaluating a hentai-capable swap model is
tracked in `docs/todo/TODO.md`).

- **Hook point:** `fileHelper.saveImage()` (`srv/repositories/files.ts`),
  **before** the S3 `PutObject` — the single choke point for direct uploads
  *and* the server-side URL ingests (URL previews, LUKSO LSP3 profile
  images, Twitter/Farcaster avatars). Derived images whose source was
  already classified (social-preview compositions, old re-encoding
  migrations) pass `skipModeration: true`.
- **What is classified:** a 224px normalization of the *source* buffer
  (fit-inside, EXIF-rotated, webp), so size variants of one upload agree
  with each other and with the dedup cache. Uploads stored with
  `animated: true` are scanned frame by frame (up to 16 frames — **randomly**
  sampled above the cap, always incl. first and last, so the unchecked set is
  not attacker-predictable; early exit once a frame is over the threshold).
  Mostly-explicit animations are caught with near certainty; a single
  explicit frame hidden in a long animation can still slip through
  (~16/pages odds) — a deliberate best-effort trade-off, not a guarantee.
  Statically stored images check frame 0 only, matching what persists.
- **What is *not* classified:** the stored crops. Classification runs on a
  fit-inside normalization of the source while `saveImage` stores `fit:
  "cover"` crops, so edge content is judged but cropped away, and a
  whole-frame score diluted by benign filler can pass while the visible
  centre crop is explicit. Accepted deliberately: classifying per variant
  would break the dedup cache and make the verdict depend on which variant
  ran first. Partly inherent to any whole-image classifier; community
  moderation covers the residue.
- **Load bounds:** concurrency is `max(2, min(6, cores / 2))` jobs (ORT
  intra-op threads capped at 2), so the gate uses at most half a machine and
  still keeps the original 2-wide behavior on small selfhost boxes. Waiting
  requests are capped at 8× that; beyond it callers get `SERVICE_UNAVAILABLE`
  (retryable, distinct from the fail-closed `INTERNAL`) instead of queueing
  unboundedly with their source buffers held in memory. `POST
  /File/uploadImage` additionally carries a rate limit (`srv/api/files.ts`):
  40/min **per account** whenever there is a session, and — for the one upload
  type served without a login (pre-auth profile pictures) — 10/min per IPv4
  or IPv6 /64 (30 per /56, 60 per /48). Per-account keying is deliberate:
  uploading is routine, and IP-only keying would pool a whole CGNAT or campus
  network into one bucket. Skipped on `dev` deployments, and applied before
  body parsing so a shed request never buffers its payload.
- **Processes:** runs in `api` and (for chain-triggered LSP3 images)
  `onchain`. Neither process has an async startup sequence, so the pipeline
  loads lazily on the first classification (~100 ms) and is cached; the
  onchain process only pays the ~300 MB RSS after its first hit — which is
  why only `api` fires the non-blocking `imageFilter.warmUp()` at boot, the
  onchain ingest paths degrading to "no image" on failure rather than
  breaking. The warm-up loads the model *and*
  runs one throwaway classification, logging `imageFilter: ready` or a
  `MODEL UNAVAILABLE` error with remediation hints — a model that loads but
  cannot infer, or one whose labels the gate does not score on (which would
  silently pass everything), is reported there rather than by the first user
  who uploads a picture. Deliberately not wired into the container
  healthcheck: a broken model breaks uploads, whereas an unhealthy container
  gets restart-looped and would take chat, calls and login down with it.
- **Dedup:** a small promise-LRU keyed by the sha256 of the *source* buffer
  (plus the animated flag) — upload types that store small+large variants of
  one source classify once, including when both run concurrently.
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
  the instance config, gating the client-side pre-upload warning; the
  threshold itself ships alongside it as `imageFilterThreshold`, so the
  browser pre-check warns at the confidence this instance actually rejects
  at instead of at a hardcoded one.
- The runtime never fetches models from the network
  (`env.allowRemoteModels = false`); weights are downloaded at image build
  time from a pinned HF revision with sha256 verification
  (`docker/backend/download_model.sh`).
- **Scope, by design:** the filter blocks clearly pornographic content; mild
  or suggestive imagery is deliberately left to community moderation (the
  default model misses most of it, which is the price of near-zero false
  positives). It is **not** a CSAM control — that needs perceptual-hash
  matching against curated databases plus legal reporting processes, which is
  separate compliance work. Text, video and audio are not classified. The Bot
  API v1 and the plugin system have no upload endpoints (they reference
  existing `imageId`s), and Giphy GIFs are never stored server-side, so none
  of them can bypass the gate; the Giphy picker requests `rating: 'g'`
  explicitly instead.

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
- `apiErrorHandler` -- Express error middleware registered last in `api.ts`: errors that middleware passes to `next(error)` before a route runs (the session store failing while Valkey is unreachable, body-parser rejecting a malformed or oversized body) answer `{ status: 'ERROR', error: 'UNKNOWN' }` as JSON, with the middleware's 4xx status kept and 500 otherwise, instead of Express' default HTML error page
- `registerPostRoute(...)` -- The route registration helper
- `farcasterApi(type, data)` -- Wrapper for Farcaster Hub API calls (`onChainIdRegistryEventByAddress`, `userDataByFid`)
- `isSignatureValid(...)` -- Verify Ethereum personal signatures using `@metamask/eth-sig-util`
- `convertEventPermissionToCallPermission(...)` -- Map event permissions to call permissions
- `htmlToImage(...)` -- Use Puppeteer to render HTML to image (for social previews)

**Raw routes and `asyncHandler`.** A few routes are registered directly on
the router instead of through `registerPostRoute`: the multipart `/File/uploadImage`
(and its rate-limit middleware), `/Captcha/challenge`, the `emailUnsubscribe`
pages and every `async` route in `srv/api/getRoutes.ts` (the passport
`/twitter-callback` is plain middleware and is not wrapped). Express 4 ignores
the promise an `async` handler returns, so each of them is wrapped with
`asyncHandler(handler, onError?)` from `srv/api/asyncHandler.ts`: a throw or
rejection anywhere in the handler — including from its own `catch` block — ends
in `onError(response, error)`, which defaults to `handleError` and is the
route's own error page or status where it answers differently
(`/Captcha/challenge`: 500 `{ error: 'challenge_failed' }`; `emailUnsubscribe`:
its HTML error page; `/gated-videos`, `/gated-files`: plain-text 500 `Internal
server error`). If the response was already started, the error is only logged
(an unfinished response goes to `next(error)` so Express closes it); if
`onError` throws or its promise rejects, the error goes to `next(error)` and
`apiErrorHandler` answers. New raw `router.get/post/use(...)` registrations
with an `async` function must use `asyncHandler` as well.

`asyncHandler` is a thin default over the dependency-free
`asyncRequestHandler(handler, onError)` in `srv/util/asyncHandler.ts`, which
also wraps `registerPostRoute`'s own handler (so an error raised while
answering — e.g. a handler that already sent its own response — is caught) and
the `memberlist` process' routes (`/getMemberListWindow`,
`/getChannelMemberListWindow`, `/getUserCommunityRoleIds`: 500
`{ error: 'memberlist_request_failed' }`, which the calling `Community` route
answers with its generic error). Errors these wrappers, the gated-file routes,
`/Captcha/challenge` and the memberlist routes log go through
`describeErrorForLog` (name, message and stack only, see
[auth-identity §11 "Logging"](../auth-identity/README.md#logging)).

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
- `GET /token` -- Token/Spark page (OG tags)
- `GET /store` -- App store redirect
- `GET /push-icon` -- Push notification icon
- `GET /gated-videos/:filename` -- Role-gated video streaming
- `GET /gated-files/:filename` -- Role-gated file downloads

  Both stream from `/api_data`. A read error answers a plain-text 500
  `Internal server error` while nothing has been sent yet and otherwise aborts the response;
  a client that disconnects early releases the file handle.

Short links (here and in the frontend) are `short-uuid` translations with the
library's default flickrBase58 alphabet and 22-character length. Every shared
article/chat/call/user link depends on that mapping staying stable — the
2026-08 bump to short-uuid 6 was differential-tested for exactly that (0
mismatches over 20 000 UUIDs); any future change to the alphabet or library
breaks existing links.

### `srv/api/instance.ts` -- Instance Config (mounted at `/Instance`)

- `GET /config` -- the instance's public identity and capability flags as JSON:
  the same object `buildInstanceConfig()` (`srv/util/instanceConfig.ts`)
  injects into served HTML as `window.__CG_INSTANCE__`, typed by
  `InstanceConfig` in `src/common/instance.ts`. Public, unauthenticated,
  `Cache-Control: no-store`. It exists for clients that never load
  `index.html` — native apps, bots, the reference client in `sdk/` — and is the
  first call such a client makes; the web app keeps the HTML injection as its
  fast path. The `Instance` prefix is in the `/api/v2/` allowlist of the edge
  (`docker/caddy/common.caddy`, and the hosted `docker/nginx/nginx.conf`).

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

**Authentication** (details: [docs/auth-identity](../auth-identity/README.md)):
- `/getSignableSecret` -- Get a nonce for signing
- `/verifyCaptcha` -- Verify a captcha token (provider abstraction in `srv/util/captcha.ts`: ALTCHA default / reCAPTCHA / off; ALTCHA challenges via `GET /Captcha/challenge`, the effective provider via `GET /Captcha/config` — both public, `srv/api/captcha.ts`)
- `/login` -- every interactive and device-key login; each branch ends in `establishLoginSession()` (`srv/util/authSession.ts`: new session id, user set, `authAt`/`authMethod` recorded except for device-key logins, awaited save). `type: 'passkey'` verifies a WebAuthn assertion in the same call; `type: 'passkey-success'` exists only in legacy CG ID mode
- `/reauthenticate` -- step-up: passkey (`stepup` assertion), password or a fresh signature of a login-enabled wallet; refreshes `authAt` and returns `{ validUntil }`; rate-limited per IP and per user
- `/ensureSession` -- session keepalive (the web client calls it every 29 minutes)
- `/requestSignupEmailCode`, `/verifySignupEmailCode` -- verify the sign-up address before the account exists (`srv/util/signupEmail.ts`)
- `/clearLoginSession` -- Clear session
- `/checkLoginStatus` -- Check if logged in
- `/logout` -- Log out (the session is replaced by a new, empty one)
- `/getSecurityStatus` -- what the account-security step still needs (`srv/util/securityStep.ts`)
- `/createTransferLink` -- a one-time link for the session's own user to the instance `TRANSFER_TARGET_URL` names (off without it); limited per user
- `/previewTransferLink`, `/redeemTransferLink` -- show whose account a link signs in to; redeem it (logged out only, one conditional `UPDATE`, failed attempts limited per IP); not on a legacy CG ID process (`srv/util/transferLink.ts`, `srv/repositories/transferTokens.ts`)

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
- `/isEmailAvailable` -- Check email availability; only on an instance without mail (or in legacy CG ID mode), IP rate-limited — with mail every address flow answers the same for taken and free addresses
- `/setPassword` -- Set/change password: replacing one needs a step-up, a first password adds a sign-in method (see below); new passwords need at least 8 characters (`common.Password`, `src/common/passwordPolicy.ts`)

Sensitive actions call `requireRecentAuth()` (`srv/util/authSession.ts`)
before anything else and fail with `REAUTH_REQUIRED` unless the session
authenticated interactively within the last 5 minutes: `/setPassword`, an
`email` change through `/updateOwnData` (only an actual change),
`/addUserAccount` and `/removeUserAccount` of an X/LUKSO/Farcaster account, `/addPreparedWallet` with `loginEnabled`, `/updateWallet`
changing `loginEnabled`, `/deleteWallet` of a login-enabled wallet, the passkey
add/remove routes and `Bot` `/tokens/issue` and `/disable`.
`srv/tests/passkeyRoutes.spec.ts` keeps every `User`, `Passkey` and `Bot` route
classified as protected or not. Adding a way into the account (a passkey, a
sign-in wallet, a first password, an X/LUKSO/Farcaster account, an address while
none is verified) goes through `requireAuthToAdd()` (`srv/util/securityStep.ts`)
instead: a sign-in within the hour suffices while the account lacks exactly that (the account-security
step), otherwise a recent authentication where a transfer-link session counts.
Throttles (all numbers in `srv/util/authLimits.ts`; off on a dev stack, like
the sign-up limit): password login 60 attempts per 15 minutes per IP and, per
identifier as typed, 10 **failed** attempts per 15 minutes from the client's
network (IPv4 /24, IPv6 /56) and 100 per hour from everywhere; email-code login
60 per IP, five guesses per code and, per address, 30 failed guesses a day per
network and 200 overall; transfer links 120 per IP and 20 failures per IP.
Login failure budgets reserve their slot atomically before the check and give
it back on success (`failureBudget` / `reserveFailures`), so parallel attempts
cannot overrun them; the transfer failures use `ipFailureLimiter`
(`srv/util/rateLimit.ts`).

The api mounts `securityStepMiddleware` in front of every API router and the
gated file routes (not the page routes): a session whose
account still has to finish the account-security step reaches only that step's
endpoints, everything else answers `SECURITY_STEP_REQUIRED`
([docs/auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)).
Removing or switching off the account's last
sign-in method (passkey of this RP, password, login-enabled wallet) fails with
`LAST_LOGIN_METHOD` (`srv/repositories/loginMethods.ts`, checked under a lock
on the user row).

**Wallets:**
- `/prepareWalletAction` -- Prepare wallet linking
- `/addPreparedWallet` -- Complete wallet linking
- `/updateWallet`, `/deleteWallet`, `/getWallets`

**Newsletter / email preferences:**
- `/subscribeNewsletter`, `/unsubscribeNewsletter` -- set the local `users.newsletter` flag
- `GET`/`POST /emailUnsubscribe?token=…` -- one-click unsubscribe (RFC 8058) for digest and community-article mails; no login, signed token, Joi-validated, IP rate-limited, answers with small HTML pages. Registered from `srv/api/emailUnsubscribe.ts`; see [docs/email-notifications](../email-notifications/README.md#one-click-unsubscribe)

**Social:**
- `/followUser`, `/unfollowUser`
- `/getFollowers`, `/getFollowing`, `/getFriends`

**Articles (user blog):**
- `/getArticleList`, `/getArticleDetailView` -- a user article without a publish date or with one in the future is only returned to its author (`/getArticleList` with `drafts: true` requires the session user to be the `userId` asked for; `/getArticleDetailView` compares the session user with the author in SQL).
- `/createArticle`, `/updateArticle`, `/deleteArticle`

**Premium:**
- `/buyUserPremiumFeature`, `/setPremiumFeatureAutoRenew`

**Misc:**
- `/getUserCommunityIds` -- Get IDs of communities the user belongs to
- `/getTransactionData` -- Get point transaction history
- `/requestEmailVerification`, `/verifyEmail` -- a code bound to the session's account and the address it was sent to; the address changes only when the code comes back (`srv/util/emailCodes.ts`)
- `/sendOneTimePasswordForLogin` -- OTP login (same answer for unknown addresses)
- `/requestEmailVerification` and `/sendOneTimePasswordForLogin` are send-limited per client IP, per target address and (verification) per account -- `srv/util/mailSendLimits.ts`, numbers in [docs/email-notifications](../email-notifications/README.md#send-limits)

### `srv/api/messages.ts` -- Messaging Routes

- `/createMessage` -- Create a new message
- `/createModerationMessage` -- Create a moderation-flagged message
- `/editMessage` -- Edit an existing message
- `/deleteMessage` -- Delete a message. Creator and channel are read from the stored message (`messageHelper.getMessageOwnership`), not from the request: the message must live in `access.channelId`, deleting another user's message needs `CHANNEL_MODERATE` / `CALL_MODERATE` there (chats and article comments: own messages only), and the `UPDATE` filters on creator, channel and id.
- `/deleteAllUserMessages` -- Delete all messages from a user in a channel
- `/loadMessages` -- Load messages with pagination
- `/messagesById` -- Load specific messages by ID
- `/loadUpdates` -- Load message updates since a timestamp
- `/setReaction`, `/unsetReaction` -- Message reactions
- `/setChannelLastRead` -- Mark channel as read
- `/getUrlPreview` -- Get URL preview metadata (Open Graph scrape of a client-supplied URL, at most 2048 chars). Requires a session. Results are cached for 1 h on the Valkey cache instance (`redis-cache`, client type `cache`) under `urlpreview:<sha256(url)>` — skipped, not waited for, while that instance is unreachable; cache misses are rate-limited per account (30/min). The page (≤ 1 MB, `text/*` or XHTML) and the `og:image` (≤ 8 MB, `image/*`) are fetched through `safeFetch` (see `srv/util/safeFetch.ts` below) and the HTML is passed to `open-graph-scraper` as `ogs({ html })`. Title and description are cut to 2000 chars; the returned `url` is the page's `og:url` only if that is an http(s) URL of at most 2048 chars, otherwise the requested URL. Previews larger than 8 KB serialized are returned but not cached. The preview image is stored through `saveImage()`, i.e. it passes the NSFW gate.
- `/joinArticleEventRoom`, `/leaveArticleEventRoom` -- Join/leave article real-time rooms

Every route that takes an access object (`communityId`, `chatId`, `callId`, or `articleId` with `articleCommunityId`/`articleUserId`, each together with `channelId`) runs `_checkAccessOrThrow`, which first checks that `channelId` is the channel of the named community, chat, call or article (`messageHelper.isChannelInAccessScope`) and then evaluates the permissions for that scope. An article access must name the article's community or user. Deleted community channels, chats and articles do not match; a user article that is not published yet only matches for its author. Message edits and reaction removal additionally filter on `access.channelId` in SQL.

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

### `srv/api/passkeys.ts` -- Passkey Routes (`/Passkey`)

Passkeys on the instance's own origin, mounted unless the process runs in
legacy CG ID mode (`CG_LEGACY_CGID=true`). All ceremonies go through the
shared core `srv/util/passkeys.ts`; details in
[docs/auth-identity §7](../auth-identity/README.md#7-passkeys).

- `/registrationOptions` -- logged out: options for the sign-up passkey (`displayName` labels it; IP rate-limited; needs the verified sign-up address when the instance sends mail); logged in: options for adding one (step-up, stable user handle, `excludeCredentials`)
- `/verifyRegistration` -- logged in: stores the passkey, mails a notice to the verified address; logged out: keeps it in `session.pendingPasskey` for `/User/createUser`
- `/authenticationOptions` -- `{ purpose: 'login' }` (anonymous, IP rate-limited, empty `allowCredentials`) or `{ purpose: 'stepup' }` (the session user's credentials)
- `/list`, `/rename` -- the session user's passkeys on this relying party
- `/remove` -- step-up; refused with `LAST_LOGIN_METHOD` if no other sign-in method (passkey, password, login-enabled wallet) would remain

### `srv/api/cgid.ts` -- Legacy CG ID Routes (`/CgId`)

Mounted only with `CG_LEGACY_CGID=true` (gateway), instead of `/Passkey`:
authentication of existing credentials of the CG ID relying party (host of
`CGID_URL`) through the shared core — no registration, no user id from the
client.

- `/ensureSession` -- Ensure a valid session exists
- `/generateAuthenticationOptions` -- options with empty `allowCredentials` (IP rate-limited)
- `/verifyAuthenticationResponse` -- verifies the assertion, leaves `session.passkeyData` for `/User/login {type:'passkey-success'}` and emits `cliCgIdSignResponse` to the session room

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
  A request without an `uploaded` file answers `{ status: 'ERROR', error: 'INVALID_REQUEST' }`;
  multer and body-parser errors (file over 8 MB, unexpected field) go to
  `apiErrorHandler`.
- `/getSignedUrls` -- Get pre-signed S3 URLs for file access

### `srv/api/search.ts` -- Search Routes

Contains internal search logic (uses raw SQL `to_tsvector`/`websearch_to_tsquery` for full-text search).

- `/searchUsers` -- Search users by name
- `/searchArticles` -- Search articles by content. User articles appear once their publish date has passed.

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

Not a route file. The email layer: SMTP transport (nodemailer, configured by `srv/util/mailConfig.ts`), `emailEnabled()`, and the composers for newsletters, articles, event notifications, email verification and OTP login (HTML + text built locally). Details in [docs/email-notifications](../email-notifications/README.md).

---

## 3. Entity Model

All entities use TypeORM decorators and live in `srv/entities/`. The database is PostgreSQL (database name: `cryptogram`).

### Users Domain

**`User`** (`srv/entities/users.ts`, table: `users`)
- `id` (UUID, PK, auto-generated)
- `password` (text, nullable, select: false) -- bcrypt hash (cost 12; older hashes are replaced on the next successful check)
- `passwordChangeRequired` (boolean, select: false) -- a password below the policy signed in; the account-security step asks for a new one
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
- `data` (jsonb) -- WebAuthn credential data (credential id, public key, user handle, device type, backup state, transports)
- `counter` (bigint) -- signature counter
- `rpId` (text, nullable) -- relying party the credential belongs to; NULL matches none
- `origin` (text, nullable) -- registration origin (audit)
- `name` (text, nullable) -- user label
- `lastUsedAt` (timestamptz, nullable)

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
- User CRUD, account management, password hashing (bcrypt, cost `BCRYPT_COST` = 12, rehash on login), `checkPasswordLogin` / `findPasswordLoginUserId`, `setVerifiedEmail`
- Social preview data, profile details, own data retrieval
- User creation (complex: creates user + accounts + wallets + device in transaction)
- Account operations: add/update/remove accounts, contract wallet management
- Profile name and email availability checks
- Follow/unfollow users, newsletter flag (`users.newsletter`, local only)
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
    Lukso, Accounts, CgId, Passkey, Plugin, Search,
    Report, Bot
  }
}
```

Each API validator module exports Joi schemas matching the API request types. For example, `validators.API.Chat.startChat` validates the `API.Chat.startChat.Request` type.

Note: the Staking routes carry no validators (they take no meaningful request body), so there is no `validators.API.Staking` module.

**The validators are also the published API contract.** `docs/api/openapi.json`
(OpenAPI 3.1) is generated from the compiled validators by
`sdk/tools/generate-openapi.mjs`, run inside the backend image
(`sdk/tools/generate-openapi.sh`, i.e. `yarn openapi` in `sdk/`) — request
bodies come from `describe()` output; responses carry the standard envelope
with an open `data` schema, since response types are TypeScript-only. The
output is deterministic, and `generate-openapi.sh --check` (`yarn
openapi:check`) is the drift guard: **a validator change must be committed
together with the regenerated `openapi.json`**, or the reference-client
pipeline fails. A new validator domain also has to be added to the
generator's `DOMAIN_TO_ROUTE` map, otherwise it is skipped. The hand-written
siblings `docs/api/socket-events.md`, `docs/api/protoo-methods.md` and the
versioning policy `docs/api/VERSIONING.md` cover what is not
runtime-introspectable.

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
- `Password` (a new password: 8–1024 characters), `PasswordAttempt` (a password typed to sign in or re-authenticate: 1–1024), `EmailCode` (6 digits), `TransferToken` (43 base64url characters), `Secret`, `DateString`, `EIP712Signature`

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
- `cgid.ts` -- Legacy CG ID passkey authentication (gateway mode)
- `passkey.ts` -- Passkey API (WebAuthn JSON schemas themselves live in `common.ts`: `WebAuthnRegistrationResponse`, `WebAuthnAuthenticationResponse`)
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
  1. `articleNotifications` -- Finds community articles marked for email delivery, prepares them, and sends them over SMTP to newsletter subscribers. Per-recipient failures are logged and skipped (`srv/util/sendToAll.ts`); the article is marked as sent either way.
  2. `eventNotifications` -- Finds upcoming events that need notification, sends email reminders to participants (same per-recipient failure handling; the event is marked as notified either way).

### `newsletterDelivery.ts`
- **Purpose:** Sends the weekly platform newsletter to subscribed users.
- **Logic:** Generates a newsletter ID from the current date. Creates newsletter entries for eligible users. Sends personalized emails containing posts from followed communities plus general platform posts. Retries failed sends once. Before that, it deletes bounce records older than 180 days (`emailBounceHelper.deleteExpired()`).

### `bounceReceiver.ts`
- **Purpose:** Receives the selfhost mail relay's bounce reports (permanent worker, started by `jobs.ts` only with `MAIL_BOUNCE_RECEIVER=true` and a relay login).
- **Logic:** An smtp-server listener on port 2525 (`srv/util/bounceReceiverServer.ts`): connections only from the addresses the relay host (`mail`) resolves to, AUTH PLAIN with `SMTP_USER`/`SMTP_PASSWORD` (third failure closes the connection), no STARTTLS, 1 MB, 10 clients, idle and absolute session timeouts. Each message is parsed as an RFC 3464 report (`srv/util/dsn.ts`); permanent failures (`Action: failed`, 5.x.x) go to `emailBounceHelper.recordReport()` (`srv/repositories/emailBounces.ts`), which records them in `email_bounces` and applies `srv/util/bouncePolicy.ts`: unverify only after two counted bounces at least 24 h apart; bursts (more than 25 addresses per hour, or more than 10 of one domain) are flagged `senderSide`, unverify nobody there and log a `!!!` operator warning with the diagnostic texts. A database error answers 451, so the relay retries. See [docs/email-notifications](../email-notifications/README.md#bounces).

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
2. Checks counts in Redis sorted sets per URL+IP combination (`options.bucket` replaces the URL as the counter name — needed when the query string carries per-request data, e.g. the unsubscribe token)
3. Applies separate limits for IPv4/IPv6-64, IPv6-56, and IPv6-48 prefixes
4. Throws `RATE_LIMIT_EXCEEDED` if any limit is breached

`keyRateLimitHandler({ bucket, windowMs, limit })` -- the same sliding window on a key the caller computes (e.g. a hashed target address or an account id) instead of the IP; used by the mail send limits in `srv/util/mailSendLimits.ts`.

The IP classification itself lives in `srv/util/ipPrefix.ts` (2026-08: built on
`node:net` `isIPv4`/`isIPv6`, replacing the unmaintained `ip` package). IPv6
bucket keys are zero-padded per-byte hex of the /64, /56 and /48 prefixes;
v4-mapped addresses (`::ffff:a.b.c.d`) key on the embedded IPv4; inputs that
fail strict validation get no keys and the request is rejected with
`INVALID_REQUEST`. Unit tests: `srv/tests/ipPrefix.spec.ts` (runs via
`yarn tests` in `srv/`).

### `srv/util/express.ts` -- Express Configuration

Sets up Express with:
- CORS configuration (`BASE_URL`, dev origins; the `CGID_URL` origin only in legacy CG ID mode)
- Session management via `connect-redis` (Redis-backed sessions; host-only cookie, `.<APP_HOSTNAME>` only in legacy CG ID mode)
- Cookie parser
- Passport integration (for Twitter OAuth)

Declares TypeScript session data types including:
- `user?: { id, deviceId }` -- authenticated user
- `signSecret?` -- nonce for signature verification
- `twitter?`, `lukso?`, `farcaster?` -- OAuth/auth flow state
- `webauthnChallenges?`, `pendingPasskey?`, `signupEmail?`, `authAt?`/`authMethod?`, legacy `passkeyData?` -- passkey ceremonies, sign-up and step-up state ([docs/auth-identity §2](../auth-identity/README.md#session-data-shape))

### `srv/util/urls.ts` -- URL Configuration

Derives application URLs from `BASE_URL` env var or deployment settings:
- `APP_URL` -- Full app URL (e.g., `https://app.cg`)
- `API_URL` -- API base URL (e.g., `https://app.cg/api/v2`)
- `APP_HOSTNAME`, `PROTOCOL`, `PORT_SUFFIX`

### `srv/util/passkeyConfig.ts`, `passkeys.ts`, `authSession.ts`, `signupEmail.ts` -- Sign-in core

- `signInNotice.ts` -- best-effort "new sign-in method" mail (passkey, X/LUKSO/Farcaster account).
- `passkeyConfig.ts` -- the WebAuthn relying party of the process: `getMainRp()` (RP ID `PASSKEY_RP_ID` or the `BASE_URL` host, origin exactly `BASE_URL`, dev adds `localhost:3000/8000`) or, with `CG_LEGACY_CGID=true`, `getLegacyCgidRp()` (host/origin of `CGID_URL`). `validatePasskeyConfigAtStartup()` stops the api process on an RP ID that is not the app host or a parent domain of it.
- `passkeys.ts` -- shared ceremony core: challenge map in the session (max 5, TTL, consumed before verification and marked used in Redis), registration/authentication options and verification with user verification required, lookup by `(rpId, credentialID)`, counter check.
- `authSession.ts` -- `establishLoginSession()` (every login), `requireRecentAuth()` (step-up guard, `REAUTH_REQUIRED`), `recordReauthentication()`.
- `signupEmail.ts` -- sign-up email code state in the session (hashed 6-digit code bound to the address, 15 min, 5 attempts).

### `srv/util/memberListHelpers.ts` -- Member List Binary Conversion

Converts member lists between binary (UTF-16LE encoded UUIDs) and standard UUID string format. Used for efficient member list storage/transmission in Redis.

### `srv/util/safeFetch.ts` -- Outbound fetch of user-supplied URLs

`safeFetch(url, { maxBytes, timeoutMs?, maxRedirects?, acceptContentType?, headers? })` is the GET used for URLs that come from users or third-party data. It uses `node:http(s)` directly (no axios, no proxy environment, no keep-alive):

- only `http:`/`https:`, no credentials in the URL;
- host names are resolved by a custom `lookup` at connect time and rejected if *any* resolved address is not public unicast (private, loopback, link-local incl. metadata services, CGN, multicast, reserved and documentation ranges; IPv6 ULA, link-local, multicast, Teredo; v4-mapped, NAT64 and 6to4 addresses are judged by the embedded IPv4); IP literals are checked before connecting (`isPublicAddress`);
- redirects (default 5) are followed manually and every hop is checked again; the bodies of redirect and error responses are not read, their connections are closed;
- one deadline (default 10 s) covers all hops; the decoded body (gzip/deflate/br) is capped at `maxBytes`; `acceptContentType` gets the bare media type.

Errors are `SafeFetchError` with a `code` (`INVALID_URL`, `BLOCKED_ADDRESS`, `TOO_MANY_REDIRECTS`, `TOO_LARGE`, `TIMEOUT`, `BAD_STATUS`, `BAD_CONTENT_TYPE`, `NETWORK`). `fetchRemoteImage(url, headers?)` wraps it for images handed to `saveImage()` (8 MiB, `image/*`). Users in `api`: `/getUrlPreview`, and the profile pictures fetched during LUKSO, Twitter and Farcaster sign-up/login. The onchain LSP3 image fetch (`srv/onchain/generic.ts`) and web-push delivery do not use it yet. Tests: `srv/tests/safeFetch.spec.ts`.

### `srv/util/axios.ts` -- Axios Instance

Custom Axios instance that forces `keepAlive: false` on both the HTTP and HTTPS agent. It was introduced for a Node.js-20-era Axios bug ([axios#5929](https://github.com/axios/axios/issues/5929), rooted in [nodejs#47130](https://github.com/nodejs/node/issues/47130)): a pooled socket the server has already closed fails the next request with `ECONNRESET`. **Re-checked 2026-08-04 on Node 24 + axios 1.19 — still needed**: nodejs#47130 was closed as a known limitation, and the axios 1.x changelog fixes only keep-alive listener leaks, not the pooling race (sources in the code comment). Drop it only once Node changes the pooling behaviour or the backend moves to axios' fetch/undici adapter.

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

Builds the `window.__CG_INSTANCE__` script tag injected into served `index.html` pages (share links / social previews). Declares the deployment, the app URL, the passkey RP ID (`passkeyRpId`; `cgidUrl` instead only in legacy CG ID mode), active chains, and a `features` map derived from which credentials and services this server actually has (`email`, `twitterAuth`, `calls` from `CG_ENABLE_CALLS`, `imageFilter` from `IMAGE_MODERATION_ENABLED`, `passkeys` — false in legacy CG ID mode) so the frontend can hide features that would only fail, plus `imageFilterThreshold`. Optional keys (reCAPTCHA site key, Giphy key, WalletConnect project id) are included when configured. The same object is served as JSON by `GET /api/v2/Instance/config` (`srv/api/instance.ts`, see §2).

---

## 8. Dependency Notes

Version constraints in `srv/package.json` that are not self-explanatory. The
2026-08 dependency refresh brought every package to a current in-major
release, and the 2026-10-31 refresh (F6) to the newest in-major release that
has passed the 7-day age gate — except `mediasoup` (3.23.2) and `puppeteer`
(25.5.0), which move only together with their pinned worker / Chrome binaries
(see `docs/infrastructure/UPDATE-POLICY.md`). The remaining major jumps
(Express 5, TypeORM 1.x) are scheduled in `docs/todo/ROADMAP_cg-box.md`.

- **TypeScript 6 and joi 18** came with wave M1 (2026-10-31). joi 18.3.1 (the
  first 18.x that is not affected by GHSA-4528-x5fx-h6hg) needs Node ≥ 20 and
  replaces the `@sideway/*` helpers with `@hapi/address`/`formula`/`pinpoint`;
  its error-message templates are unchanged, and all validator schemas in
  `srv/validators/` were compared against 17.13.9: identical `describe()`
  output (hence an unchanged `docs/api/openapi.json`) and identical validation
  results/error details on a generated input corpus. `srv/tsconfig.json` uses
  no option TS 6 deprecates (no `ignoreDeprecations`); `Node16` resolution,
  `experimentalDecorators`/`emitDecoratorMetadata` (TypeORM) and the explicit
  `types: ["node", "jest"]` (TS 6 no longer loads every `@types/*` package by
  default) carry over. The TypeORM CLI scripts compile through
  `srv/tsconfig.typeorm-cli.json`, see [docs/database](../database/README.md).

- **`resolutions`**: `@types/express` / `@types/express-serve-static-core` →
  `"4"`. Several `@types/*` packages (`express-session`, `express-ws`,
  `passport`, `passport-twitter`, `multer`) depend on `@types/express@*` (and
  `@types/cookie-parser` peer-depends on it), which resolves to 5.x and hoists
  a second, incompatible `Request` type next to the v4 one. Drop both pins
  with Express 5.
- **`sharp: "^0.35.5"`** — the floor is security-motivated: earlier releases
  bundle affected libheif/librsvg builds (GHSA-rgj7-g3m4-5g8c,
  GHSA-wq5f-xc86-pv6w). `@huggingface/transformers` 4.3 (the NSFW gate) asks
  for `^0.35.4`, so both ranges resolve to one sharp copy without a
  `resolutions` entry (the one that forced this under transformers 4.2's
  `^0.34` was dropped on 2026-10-31). Re-check with `yarn why sharp` when
  either moves.
- **Exact pins** (kept exact on purpose; bump deliberately): `socket.io`
  (paired with the root workspace's exact `socket.io-client` — keep them on the
  same release), `@socket.io/redis-adapter`, `mediasoup`, `protoo-server`
  (paired with the root's exact `protoo-client`), `cookie`,
  `open-graph-scraper`, `altcha-lib`, `ethers` (v6, backend only),
  `@erc725/erc725.js`, `typescript`, and in `devDependencies`
  `@tsconfig/node24` and `@types/node`.
  `socket.io-adapter` is a direct dependency only to satisfy the redis
  adapter's peer range; nothing imports it.
- **`cookie` 0.7.2** is the same version `cookie-parser` depends on (one copy).
  Its only consumer is `cookie.parse()` on the Socket.IO handshake header in
  `wsapi.ts`. cookie 1.x is named-exports-only and 2.x is ESM-only with a
  renamed API — not worth it for one call in a CommonJS build. There is **no**
  `cookie-signature` dependency: `express-session` and `cookie-parser` each
  bring their own (byte-identical signatures across 1.0.6/1.0.7); the
  commented-out import in `wsapi.ts` records an alternative unsign path that
  would need the dependency back.
- **`@simplewebauthn/browser` is a devDependency of `srv/`** although nothing
  in `srv/` runs it: `srv/common` is a symlink into `src/common`, and
  `src/common/types/api/cgid.d.ts`, `passkey.d.ts` and `user.d.ts` import its types. Inside the container
  build there is no root `node_modules`, and `skipLibCheck` would silently turn
  the passkey API types into `any` without it.
- **ESM-only dependencies under a CommonJS build.** The backend compiles to
  CommonJS (`moduleResolution: Node16`) and loads ESM-only packages —
  currently `puppeteer` 25 — through Node's `require(ESM)` (Node ≥ 22.12). Keep
  that in mind if the Node floor ever moves down. puppeteer ≥ 23 returns
  screenshots as `Uint8Array`, hence the `Buffer.from()` in `htmlToImage()`.
  Its install script stays allowlisted (see docs/infrastructure §2) but
  downloads nothing in the images: the backend images set
  `PUPPETEER_SKIP_DOWNLOAD` and install the Chrome for Testing build puppeteer
  is pinned to from a sha256-verified download (`docker/backend/fetch_chrome.sh`)
  into `/opt/chrome`, found via `PUPPETEER_EXECUTABLE_PATH` — x86_64 only
  (Chrome for Testing has no linux-arm64 build; elsewhere the image builds
  without it and `htmlToImage()` fails). Debian's
  `chromium` package is not a drop-in replacement: it crashes on launch with the
  `--single-process` flag `htmlToImage()` passes (tested with 155 on trixie,
  2026-10-31).
- **S3 bodies must be Buffers.** Since the `@aws-sdk/*` 3.88 → 3.1102 bump (the
  change arrived somewhere in the 3.9x line) the client rejects stream bodies of
  unknown length, so `saveImage()` passes the materialised
  buffer, never the Sharp instance; `tests/saveImage.spec.ts` asserts exactly
  that. Presigning in `srv/repositories/files.ts` uses `@smithy/url-parser`,
  `@smithy/hash-node`, `@smithy/protocol-http` and `@aws-sdk/util-format-url`
  directly (declared explicitly — they used to be phantom `@aws-sdk/*`
  imports); the high-level `getSignedUrl` helper is not a drop-in, because
  `getSignedUrls()` mutates the request before formatting it.
- **node-redis 6** (see docs/realtime for the `RESP: 2` pin) gives every
  command a default 5 s timeout and a 30 s TCP keep-alive initial delay, so a
  wedged Redis fails single commands fast instead of hanging them. MULTI and
  pipeline chains get **no** timeout from node-redis 6, so every MULTI call
  site wraps `exec()`/`execTyped()` in `withTimeout()` from
  `srv/redis/client.ts` (5 s), and the offline queue is bounded
  (`commandsQueueMaxLength` 10,000). Measured against a stopped Valkey: rate
  limits, the bot rate limit, `UserDataManager` and plain commands all reject
  after ~5 s and the process stays up (every client has an `error` listener,
  and un-awaited PUBLISH rejections are handled — see docs/realtime). The server is Valkey 9.1
  since 2026-10-31; node-redis, connect-redis 10, `@socket.io/redis-adapter`
  8.3 and `@socket.io/redis-emitter` 5.1 work against it unchanged (smoke-tested:
  sessions, cross-process fan-out, rate limits, the bot-presence Lua script).
  TypeORM's peer
  warning about `redis` versions concerns its optional query cache, which this
  codebase does not use — inert.
- **Tests:** `yarn tests` in `srv/` runs jest 30 + ts-jest 29 (there is no
  ts-jest 30) over `tests/*.spec.ts` directly from the TypeScript sources —
  currently `ipPrefix`, `saveImage`, `imageFilter`, `stakingConfig`,
  `configuredSecret`, `onchainHelper`, `messageAccess`, `messageRepository`,
  `safeFetch`, `urlPreview`, `redisManager`, `pluginRequest`, `protooConnectionGate`,
  `typingCache`, `userArticleVisibility`, `userArticleRoute`, `passkeyCore`,
  `passkeyRoutes`, `passkeyConfig`, `signupEmail`, `asyncHandler`,
  `registerPostRoute`, `uploadImageRoute` and `gatedFileRoute` (the passkey tests drive
  a software authenticator, `tests/helpers/softAuthenticator.ts`). `npx tsc --noEmit`
  does not cover `tests/` (see `docs/todo/TODO.md`). ts-jest compiles the specs
  with `srv/tsconfig.json`, which therefore lists `"types": ["node", "jest"]`:
  `@tsconfig/node24` ≥ 24.0.5 sets `types: ["node"]`, which would otherwise hide
  the jest globals.
