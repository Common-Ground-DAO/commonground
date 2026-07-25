> Status: verified against commit 523fceccd, 2026-07-25

# Authentication & Identity

This document is the consolidated reference for how Common Ground authenticates users and models
identity. It covers every login method, the session infrastructure, device keypairs, the separate
bot-token authentication plane, signup (including captcha), and account linking.

The [architecture README](../architecture/README.md#3-authentication--sessions) keeps only a short
overview of this area — this file owns the detail. The bot HTTP surface is documented separately in
[`docs/BOT-API.md`](../BOT-API.md); bot identity/roadmap in
[`docs/ROADMAP-bot-accounts.md`](../ROADMAP-bot-accounts.md).

---

## Table of Contents

1. [Concepts & Data Model](#1-concepts--data-model)
2. [Session Infrastructure](#2-session-infrastructure)
3. [Device Keypairs (WebCrypto P-384)](#3-device-keypairs-webcrypto-p-384)
4. [The Login Endpoint](#4-the-login-endpoint)
5. [Login Methods](#5-login-methods)
6. [Signup Flow & Captcha](#6-signup-flow--captcha)
7. [CGID Subdomain & Passkeys](#7-cgid-subdomain--passkeys)
8. [Account Linking (user_accounts & wallets)](#8-account-linking-user_accounts--wallets)
9. [Bot Token Authentication (separate plane)](#9-bot-token-authentication-separate-plane)
10. [Frontend Login State Machine](#10-frontend-login-state-machine)

---

## 1. Concepts & Data Model

Identity in Common Ground is split across several tables. A **user** is the root account; everything
else hangs off it.

| Table | Entity | Purpose |
|-------|--------|---------|
| `users` | `srv/entities/users.ts` | Root account. Holds `email`, hashed `password`, `is_bot`, `displayAccount`, `trustScore`, etc. |
| `user_accounts` | `srv/entities/user-accounts.ts` | Linked identity/profile items (one row per provider). Composite PK `(userId, type)`. |
| `wallets` | `srv/entities/wallets.ts` | Crypto wallets attached to a user; may be login-enabled. |
| `devices` | `srv/entities/device.ts` | Per-device public keys used for silent re-authentication. |
| `passkeys` | `srv/entities/passkeys.ts` | WebAuthn credentials (managed on the CGID subdomain). |
| `bots` / `bot_tokens` | `srv/entities/bots.ts`, `srv/entities/bot-tokens.ts` | Bot users and their bearer tokens. |

### `user_accounts` types

`type` is a `UserProfileTypeEnum` (`srv/common/enums.ts`). One user can have several accounts of
different types linked at once (see [§8](#8-account-linking-user_accounts--wallets)). The `data`
column (jsonb, `select: false`) holds the provider identifier used for lookup; `extraData` holds
public profile fields (bio, links, etc.).

| Type | Provider identifier stored in `data` | Notes |
|------|--------------------------------------|-------|
| `cg` | none (`data: null`) | The native Common Ground profile (display name + description/links). |
| `twitter` | `id` (Twitter `id_str`) | Profile pulled via OAuth. |
| `lukso` | `id` (Universal Profile address) | LSP0 Universal Profile. |
| `farcaster` | `id` (FID as string) + `address` | Verified via SIWE + on-chain FID registry. |

`displayAccount` on `users` selects which linked account is shown as the user's primary public profile.

---

## 2. Session Infrastructure

Sessions are managed by `express-session` with a Redis-backed store, configured in
`srv/util/express.ts`.

| Setting | Value | Source |
|---------|-------|--------|
| Store | `connect-redis` on the `redis-sessions` instance | `srv/util/express.ts:137-142` |
| Cookie name | `connect.sid` in prod, `cg_<deployment>.sid` otherwise | `srv/serverconfig.ts:25` |
| Secret | Docker secret `redis_secret`, else `REDIS_SECRET` env | `srv/util/express.ts:144` |
| `maxAge` | 12 hours | `srv/util/express.ts:147` |
| `httpOnly` | `true` | `srv/util/express.ts:148` |
| `secure` | `true` except when `DEPLOYMENT === 'dev'` | `srv/util/express.ts:149` |
| `sameSite` | `lax` | `srv/util/express.ts:150` |
| `rolling` | `true` (cookie/expiry refresh on every request) | `srv/util/express.ts:154` |
| `saveUninitialized` | `true` (a session row is created for every visitor) | `srv/util/express.ts:153` |
| `resave` | `false` | `srv/util/express.ts:152` |
| `proxy` / `trust proxy` | `true` (behind nginx) | `srv/util/express.ts:127,145` |

### Cookie scoping across subdomains

Outside dev, the cookie `domain` is set to `.<APP_HOSTNAME>` (`srv/util/express.ts:160-162`).
`APP_HOSTNAME` is derived from `BASE_URL` (`srv/util/urls.ts`), so a self-hosted instance gets its
own domain automatically. This scoping is what lets the main app (`app.<domain>`) and the CGID app
(`id.<domain>`) share one session — the passkey flows on the CGID subdomain read and write the same
session the main app uses (see [§7](#7-cgid-subdomain--passkeys)).

### Middleware order

`srv/util/express.ts:168-189` wires the middleware chain. Bot-token authentication runs **first**; if
a request is authenticated as a bot, the session / passport middlewares are skipped entirely:

```
botAuthenticationMiddleware      # sets request.botPrincipal if a valid Bearer token is present
  → session (skipped if botPrincipal)
  → passport.initialize (skipped if botPrincipal)
  → passport.session (skipped if botPrincipal)
  → createdAt stamp (skipped if botPrincipal)
  → botAllowlistMiddleware       # restricts bot principals to explicitly allow-listed routes
```

### Session data shape

The authenticated identity plus in-flight login state live on the session
(`srv/util/express.ts:29-86`):

| Field | Meaning |
|-------|---------|
| `user` | `{ id, deviceId }` — set only after a successful login. Its presence *is* the "logged in" signal. |
| `signSecret` | One-time random challenge (20 chars) for signature-based flows. |
| `createdAt` | First-seen timestamp. |
| `passport` / `twitter` | Twitter OAuth data (via Passport.js). |
| `lukso` | Prepared LUKSO Universal Profile login/creation data. |
| `farcaster` | Prepared Farcaster login/creation data (FID, address, profile). |
| `preparedCredential` | Prepared wallet credential (see [§5](#5-login-methods)). |
| `passkeyData` | WebAuthn state machine: `registration_sign` → `authentication_sign` → `success`/`error`. |
| `temporaryArticleIds` | Unrelated to auth (draft article ownership). |

### CORS

Both the API and WebSocket servers keep their own allow-lists. In production the allowed origins are
`BASE_URL` and `CGID_URL`; dev adds a set of `localhost` / `app.cg.local` / `bs-local.com` origins
(`srv/util/express.ts:90-111`). Requests with **no** `Origin` header are allowed (mobile apps, curl).
Credentials are enabled (`credentials: true`) so the session cookie flows cross-origin between the two
allowed origins.

---

## 3. Device Keypairs (WebCrypto P-384)

Silent re-authentication is built on an asymmetric device key rather than a stored password.

- **Generation** (`src/data/util/device.ts:13-22`): `crypto.subtle.generateKey` with
  `ECDSA` / `namedCurve: "P-384"`, `extractable: false`, usages `["sign"]`. The **private key never
  leaves the browser** and is non-extractable.
- **Storage**: the `CryptoKeyPair` is stored in IndexedDB (`CG_DEVICE_KEY_IDENT`). Saving a new key
  clears the store first, so a browser profile holds one device keypair at a time
  (`src/data/util/device.ts:93-125`).
- **Public key**: exported as JWK (`key_ops: ["verify"]`) and sent to the server at login/signup,
  where it is persisted on the `devices` row (`srv/entities/device.ts:44-45`).
- **Signing** (`src/data/util/device.ts:149-167` and inline in `login.ts`): the browser signs the
  server-issued `signSecret` with `ECDSA` / `SHA-384`, base64-encodes the signature, and sends
  `{ deviceId, secret, base64Signature }`.
- **Verification**: the server checks the signature against the stored public key via
  `deviceHelper.verifyDeviceAndGetUserId()` (called from `srv/api/user.ts:193`).

A device is created on every non-device login (`deviceHelper.createDevice`) and deleted on logout
(`deviceHelper.deleteDevice`, `srv/api/user.ts:368`). If the server reports the device as
`NOT_FOUND` during auto-login, the client treats itself as logged out and clears local state
(`src/data/appstate/login.ts:194-204`).

The same device signature is also used to authenticate the Socket.IO connection — see the
[realtime docs](../realtime/README.md) and the architecture overview.

---

## 4. The Login Endpoint

All interactive logins go through `POST /User/login` (`srv/api/user.ts:143-343`), a discriminated
union on `data.type`. The generic shape of every branch is:

1. Validate the branch-specific proof (signature, prepared credential, OAuth session, code…).
2. Resolve the user (`userHelper.getOwnDataBy…` or `getUserByAccount`).
3. In parallel, load `communities`, `chats`, `unreadNotificationCount`, and — for methods that supply
   a fresh device public key — `deviceHelper.createDevice(userId, device.publicKey)`.
4. Set `request.session.user = { id, deviceId }`, clear `signSecret`, save the session
   (`srv/api/user.ts:326-331`).
5. Return `{ ownData, communities, chats, deviceId, webPushSubscription, unreadNotificationCount }`.

The challenge used by signature methods comes from `POST /User/getSignableSecret`
(`srv/api/user.ts:71-94`), which generates a 20-char random string
(`SIGNABLE_SECRET_LENGTH`), stores it as `session.signSecret`, and returns it. A given challenge is
consumed on use (`signSecret` is deleted after login).

`POST /User/checkLoginStatus` returns `{ userId | null }` for the current session, and
`POST /User/logout` deletes the device, clears the auth-related session fields, and saves.
`POST /User/clearLoginSession` clears the in-flight provider state (`lukso`, `farcaster`, `twitter`,
`passport`) without logging the user out.

---

## 5. Login Methods

### 5.1 Device (`type: "device"`) — silent re-auth

The default returning-session path. Client fetches a `signSecret`, signs it with the device private
key, and posts `{ type: "device", deviceId, secret, base64Signature }`. The server checks
`secret === session.signSecret`, verifies the signature against the stored public key, and logs in.
No new device is created (this branch reuses the existing `deviceId`). See
`srv/api/user.ts:187-206`.

### 5.2 Wallet (`type: "wallet"`) — EVM / Fuel / Aeternity

Two-step, using a **prepared credential** held in the session:

1. `POST /User/prepareWalletAction` (`srv/api/user.ts:904-922`): the client submits a signed
   challenge. The endpoint requires `data.data.secret === session.signSecret`, then calls
   `walletHelper.prepareWalletAction()`.
2. `prepareWalletAction` (`srv/repositories/wallets.ts:268+`) verifies the signature per wallet type:
   - **EVM**: SIWE message parsed and `ethers.verifyMessage` recovers the signer; the SIWE `Nonce`
     must equal the challenge and the recovered address must equal the claimed address
     (`parseAndVerifySiweWalletData`, `srv/repositories/wallets.ts:217-234`).
   - **Fuel**: `Signer.recoverAddress(hashMessage(secret), signature)`.
   - **Aeternity**: `@aeternity/aepp-sdk` `verifyMessage`.
   It then determines `readyForLogin` (wallet exists, `loginEnabled`, not deleted) vs
   `readyForCreation`, and stores the result as `session.preparedCredential`.
3. `POST /User/login` with `type: "wallet"` reads `preparedCredential`, requires
   `readyForLogin && ownerId`, creates a device, and logs in (`srv/api/user.ts:164-184`).

The SIWE message is built client-side in `src/util/siwe.ts` (host, `URI`, `Version`, `Chain ID`,
`Nonce: <signSecret>`, `Issued At`). A legacy mnemonic login (`prepareMnemonicLogin`,
`src/data/appstate/login.ts:418-440`) derives an EVM wallet from a stored mnemonic and reuses the
`cg_evm` wallet path; it is marked deprecated.

### 5.3 Passkey / WebAuthn (`type: "passkey-success"`)

FIDO2/WebAuthn, implemented with `@simplewebauthn/server`. The registration/authentication ceremonies
run on the **CGID subdomain** (`srv/api/cgid.ts`, see [§7](#7-cgid-subdomain--passkeys)) and leave
`session.passkeyData` in the `success` state with a `passkeyId`. The login branch
(`srv/api/user.ts:273-298`) reads that state, loads the passkey, verifies it is not deleted and has a
non-null `userId`, then creates a device and logs in. `passkeyData` is deleted afterward.

### 5.4 Email + Password (`type: "password"`)

Client posts `{ aliasOrEmail, password, device: { publicKey } }`. The server resolves and verifies
credentials via `userHelper.getOwnDataByCgProfileNameOrEmailAndPassword()`
(`srv/api/user.ts:208-220`) and creates a device. Passwords are set/changed via
`POST /User/setPassword` (`srv/api/user.ts:1113-1127`), which requires an authenticated session.

### 5.5 Email Verification Code / One-Time Password (`type: "verificationCode"`)

Passwordless email login:

1. `POST /User/sendOneTimePasswordForLogin` (`srv/api/user.ts:1494-1519`): only allowed when logged
   out and when email is enabled (`emailEnabled()` requires a real `SENDGRID_API_KEY`,
   `srv/api/emails.ts:15-16`); otherwise it throws `EMAIL_DISABLED`. It generates a token via
   `emailHelper.generateVerificationEmailToken(userId)` and emails it.
2. `POST /User/login` with `{ type: "verificationCode", email, code, device }` verifies the code via
   `userHelper.getOwnDataByEmailAndVerificationCode()` (`srv/api/user.ts:299-311`) and creates a
   device.

### 5.6 Twitter OAuth (`type: "twitter"`)

OAuth 1.0a via Passport.js (`passport-twitter`, `srv/api/twitter.ts`). The strategy is only
registered when `TWITTER_API_KEY`/`TWITTER_API_SECRET` are configured (`srv/api/twitter.ts:23-31`).

1. `GET /Twitter/startLogin` kicks off `passport.authenticate("twitter")`.
2. The provider redirects to `GET /twitter-callback` (`srv/api/getRoutes.ts:751-755`), which stores
   the Twitter profile in `session.passport`.
3. `POST /Twitter/finishLogin` (`srv/api/twitter.ts:46-67`) returns the pending profile
   (username, image, description, homepage) for the UI.
4. `POST /User/login` with `type: "twitter"` reads `session.passport.user._json.id_str` and resolves
   the user via `getUserByAccount("twitter", id)` (`srv/api/user.ts:222-228`).

### 5.7 LUKSO Universal Profile (`type: "lukso"`)

1. `POST /Lukso/PrepareLuksoAction` (`srv/api/luksoUniversalProfile.ts:15-69`): the client submits a
   signed message. The endpoint extracts the `Nonce` from the message and requires it to equal
   `session.signSecret`, verifies the signature on-chain via
   `onchainHelper.luksoIsValidSignature()` (ERC-1271 / LSP0), fetches the Universal Profile data, and
   stores `session.lukso` with `readyForLogin` / `readyForCreation`.
2. `POST /User/login` with `type: "lukso"` re-checks the nonce and on-chain signature, then resolves
   the user via `getUserByAccount("lukso", address)` (`srv/api/user.ts:248-272`).

### 5.8 Farcaster (`type: "farcaster"`)

SIWE-based, verified against the on-chain Farcaster ID registry:

1. `POST /Accounts/Farcaster/verifyLogin` (`srv/api/accounts.ts:17-129`): parses and verifies the
   SIWE signature (`walletHelper.parseAndVerifySiweData`), requires `issuedAt` within 60 s of now and
   the SIWE `nonce` to equal `session.signSecret`, extracts the FID from the message resources, and
   confirms ownership by comparing against the on-chain ID-registry event for the signer address
   (`farcasterApi('onChainIdRegistryEventByAddress', …)`). Profile data is fetched from a Farcaster
   hub for new accounts. Result is stored as `session.farcaster` with `readyForLogin`/
   `readyForCreation`.
2. `POST /User/login` with `type: "farcaster"` reads `session.farcaster.fid` and resolves the user
   via `getUserByAccount("farcaster", fid)` (`srv/api/user.ts:229-233`).

### Method comparison

| Method | `login` type | Challenge / proof | Creates device on login | Backing store |
|--------|--------------|-------------------|-------------------------|---------------|
| Device | `device` | Device signature over `signSecret` | No (reuses) | `devices` |
| Wallet | `wallet` | `preparedCredential` (SIWE / chain signature) | Yes | `wallets` |
| Passkey | `passkey-success` | `passkeyData.success` (WebAuthn) | Yes | `passkeys` |
| Password | `password` | email/alias + password | Yes | `users` |
| Email code | `verificationCode` | emailed one-time token | Yes | `users` / email token |
| Twitter | `twitter` | Passport OAuth session | Yes | `user_accounts` |
| LUKSO | `lukso` | on-chain signature + nonce | Yes | `user_accounts` |
| Farcaster | `farcaster` | SIWE + on-chain FID registry | Yes | `user_accounts` |

---

## 6. Signup Flow & Captcha

Account creation is `POST /User/createUser` (`srv/api/user.ts:385-702`). It is only allowed when
logged out, and it must add at least one usable login method (`loginMethodAdded`) or it throws.

The request bundles the new device public key plus one or more credential selectors, which are
resolved against the in-flight session state built by the prepare/verify endpoints above:

| Selector | Source of truth |
|----------|-----------------|
| `useEmailAndPassword` | request body (email + password) |
| `usePreparedWallet` | `session.preparedCredential` (must be `readyForCreation`) |
| `usePreparedPasskey` | `session.passkeyData.success` with `userId === null` |
| `usePreparedFarcaster` | `session.farcaster` (`readyForCreation`) |
| `useTwitterCredentials` | `session.passport.user` |
| `useLuksoCredentials` | `session.lukso` (not `existsAlready`) |
| `useCgProfile` | request body (display name/image) |
| `useWizardCode` | one-time community invite/wizard code |

On success the server creates the user + first device, sets `session.user`, clears all in-flight
provider state, and (for email signups) sends a verification email. The response mirrors the login
response shape (`srv/api/user.ts:652-700`).

The **wizard-code** path (`useWizardCode`) is a special onboarding route: it validates a community
wizard code, generates a random unique `cg` display name, creates a `cg` profile, and redeems the code
against the new user (`srv/api/user.ts:590-635`).

### Captcha

Signup is protected by a **captcha provider abstraction** (`srv/util/captcha.ts`), selected via
`CAPTCHA_PROVIDER = altcha | recaptcha | off`:

- **`altcha`** (default when no reCAPTCHA secret is configured): self-hosted
  [ALTCHA](https://altcha.org) proof-of-work captcha, fail-closed. Challenges come from
  `GET /Captcha/challenge` (`srv/api/captcha.ts`), signed with an HMAC key
  (Docker secret `altcha_hmac_key` / `ALTCHA_HMAC_KEY`, otherwise generated once and shared
  via Redis). Verification (`verifyCaptchaToken`) checks the solution and enforces single-use
  replay protection in Redis. PoW difficulty is tuned via `ALTCHA_MAX_NUMBER`.
- **`recaptcha`**: Google reCAPTCHA v2. Auto-selected when `CAPTCHA_PROVIDER` is unset but a
  secret (`google_recaptcha_secret_key` / `GOOGLE_RECAPTCHA_SECRET_KEY`) is present — this
  preserves the historical behaviour of the official instances.
- **`off`**: explicit opt-out only; the server logs a loud warning at startup. There is no
  silent skip-when-unconfigured anymore.

The active provider is advertised to the frontend via the instance config
(`captchaProvider` in `window.__CG_INSTANCE__`); `CaptchaModal` renders the matching widget
(`AltchaWidget` or reCAPTCHA). `createUser` verifies the token when `DEPLOYMENT !== 'dev'` and
no wizard code is used; a separate authenticated endpoint `POST /User/verifyCaptcha`
(`srv/api/user.ts`) lets a logged-in user raise their `trustScore` to `1.0` by solving a
captcha.

Rate limiting: `createUser` is IP-rate-limited (`createUserRateLimiter`: 2 per /64 per 24 h outside
dev); `verifyCaptcha` is limited to 3 per /64 per 24 h.

---

## 7. CGID Subdomain & Passkeys

WebAuthn credentials are managed on a dedicated origin, the **CGID app** at `id.<domain>`
(`CGID_URL`). Because the session cookie is scoped to `.<APP_HOSTNAME>` ([§2](#2-session-infrastructure)),
the CGID origin operates on the same session as the main app.

The relying-party settings are derived per environment (`srv/api/cgid.ts:28-41`): in dev `rpID` is
`localhost`; otherwise `rpID`/`expectedOrigin` come from the origin of `CGID_URL` (defaulting to
`id.<APP_HOSTNAME>`), which makes passkeys work for self-hosted instances.

### Endpoints (`srv/api/cgid.ts`)

| Endpoint | Purpose |
|----------|---------|
| `/CgId/ensureSession` | Force-save the session so a fresh cookie exists before a ceremony. |
| `/CgId/getLoggedInUserData` | Return the current user's passkeys (or `null`). |
| `/CgId/generateRegistrationOptions` | `generateRegistrationOptions` (alg IDs -7/-8/-257); stores `passkeyData: registration_sign`. |
| `/CgId/verifyRegistrationResponse` | Verify attestation, persist passkey (`walletHelper.addPasskey`), set `passkeyData: success`. |
| `/CgId/generateAuthenticationOptions` | `generateAuthenticationOptions`; stores `passkeyData: authentication_sign`. |
| `/CgId/verifyAuthenticationResponse` | Verify assertion, bump signature counter, set `passkeyData: success`. |

A passkey can be registered while logged out (`userId` stays `null` on the row until a `createUser`
with `usePreparedPasskey` claims it) or while logged in (attached to the current user).

### Window/subdomain hand-off

The CGID views (`src/cgid/login.tsx`, `src/cgid/home.tsx`) run the browser-side WebAuthn ceremony and
report the result back to the opener window via `postMessage` (`src/cgid/helpers.ts`,
`postEventToOpenerWindow`, targeted at `urlConfig.APP_URL`). In parallel the backend emits a
`cliCgIdSignResponse` socket event to the session (keyed by `frontendRequestId`), so the main app can
observe completion even if the window messaging path is unavailable
(`srv/api/cgid.ts:254-265,347-357`). After a successful ceremony the main app calls
`POST /User/login` with `type: "passkey-success"`.

---

## 8. Account Linking (user_accounts & wallets)

A logged-in user can link, update, and unlink identity items without changing their root account.

### Profile / social accounts

`POST /User/addUserAccount` (`srv/api/user.ts:736-869`) adds a `twitter`, `lukso`, `farcaster`, or
`cg` account to the current user, reading the prepared provider state from the session (same state
built by the prepare/verify endpoints). `POST /User/updateUserAccount` edits the `cg` profile, and
`POST /User/removeUserAccount` (`srv/api/user.ts:887-902`) removes an account of a given type. Because
`user_accounts` has a composite PK `(userId, type)`, a user holds at most one account per provider
type.

### Wallets

| Endpoint | Purpose |
|----------|---------|
| `/User/prepareWalletAction` | Verify a wallet signature and stage a `preparedCredential` ([§5.2](#52-wallet-type-wallet--evm--fuel--aeternity)). |
| `/User/addPreparedWallet` | Attach the prepared wallet to the current user, with `loginEnabled` / `visibility` flags (`srv/api/user.ts:924-968`). |
| `/User/updateWallet` | Update wallet flags. |
| `/User/deleteWallet` | Soft-delete a wallet. |
| `/User/getWallets` | List the current user's wallets. Querying **other** users' wallets is disabled and returns `NOT_ALLOWED` (`srv/api/user.ts:1032-1040`). |

Each wallet mutation emits a `cliWalletEvent` to the owning user over the socket. A wallet is unique
per `(type, walletIdentifier)`; `loginEnabled` controls whether it can be used as a login method, and
`visibility` (`private`/`public`) controls exposure. Deleting a user sets `wallets.userId` to `NULL`
(`onDelete: 'SET NULL'`), so a wallet identifier is not permanently burned.

### Email verification

Independent of any social account, an email can be verified:
`POST /User/requestEmailVerification` emails a token; `POST /User/verifyEmail`
(`srv/api/user.ts:1471-1492`) validates `(email, token)` and, on success, emits a
`cliUserOwnData { emailVerified: true }` event.

---

## 9. Bot Token Authentication (separate plane)

Bots authenticate with a **bearer token**, not a session cookie. This is a deliberately separate plane
from human auth. See [`docs/BOT-API.md`](../BOT-API.md) for the full HTTP contract.

- **Middleware**: `botAuthenticationMiddleware` runs before the session middleware
  (`srv/util/botPrincipal.ts:28-55`). It only engages when an `Authorization` header is present. If a
  session cookie is *also* present, the request is rejected (`400`) — a request is either a bot or a
  human, never both. A valid `Bearer <token>` sets `request.botPrincipal` and the session/passport
  middlewares are skipped.
- **Allow-list**: `botAllowlistMiddleware` (`srv/util/botPrincipal.ts:57-67`) restricts bot principals
  to routes explicitly registered via `allowBotRoute(method, path)`; anything else returns `403`.
- **Token format & storage**: tokens are `cgb_` followed by 32 random bytes (base64url) and are stored
  only as a SHA-256 hash (`srv/repositories/botTokens.ts:18-27,108-110`). The raw token is shown once
  at issue time. `authenticate()` hashes the presented token, joins to a non-deleted bot user, and
  returns a `{ kind: 'bot-token', user: { id, deviceId }, tokenId }` principal.
- **Lifecycle**: tokens are issued (`issueToken`), listed, and revoked by a user who can manage the
  bot; there is a per-bot active-token limit (`BOT_ACTIVE_TOKEN_LIMIT`). Revoking a token disconnects
  its live sockets (`srv/repositories/botTokens.ts:105`).

Because a bot principal carries a synthetic `{ id, deviceId }`, downstream handlers that read
`request.botPrincipal` (or a resolved user) treat the bot like a user for authorization purposes, but
scoped to the allow-listed surface.

---

## 10. Frontend Login State Machine

The client login lifecycle is owned by `LoginManager` (`src/data/appstate/login.ts`). States are
`pending` → `anonymous` / `loggingin` / `loggedin` / `loggingout` (`Common.LoginState`).

- **Current user** is cached in `localStorage` under `CG_CURRENT_USER` (`{ userId, deviceId }`), and
  changes are mirrored to other tabs via a `storage` event and a `CG_LOGIN_STATE` `BroadcastChannel`.
- **Auto-login** (`autoLogin`, `src/data/appstate/login.ts:150-243`): if offline, it optimistically
  trusts the cached user; otherwise it reconstructs the current user from IndexedDB device keypairs +
  local `OwnData`, then performs a `device` login. A deprecated mnemonic fallback runs if no device
  login is possible.
- **Multi-tab coordination**: only the active tab performs the network login; passive tabs wait for a
  `LOGIN_FINISHED`/`LOGIN_ERROR` broadcast (`loginRequiredErrorHandler`). This avoids concurrent
  device-signature races across tabs.
- **`checkLoginStatus`** compares the server's `userId` against the cached one and logs out on
  mismatch.
- **Post-login setup** (`setupAfterLogin`): seeds the local Dexie databases (user, communities, chats,
  notifications), logs the socket in, and registers the push subscription.

The `login()` method maps UI choices to the `POST /User/login` `type` values described in
[§5](#5-login-methods) (`src/data/appstate/login.ts:444-536`), generating a fresh device keypair for
every non-device method and persisting it after the server confirms the login.

---

## Cross-references

- Overview & session table: [architecture README §3](../architecture/README.md#3-authentication--sessions)
- Socket.IO auth handshake: [realtime README](../realtime/README.md)
- Bot HTTP API: [`docs/BOT-API.md`](../BOT-API.md), [`docs/ROADMAP-bot-accounts.md`](../ROADMAP-bot-accounts.md)
- Entities: [database README](../database/README.md)
