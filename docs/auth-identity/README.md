> Status: verified against commit 40f4a0b0f, 2026-08-04; `emailEnabled()` reference and email
> send limits against commit e44dac1, 2026-10-31; session store instance (Valkey state
> instance) against commit ff0da06, 2026-10-31; sessions (§2), the login endpoint (§4), passkeys
> (§5.3, §7), the recovery-phrase gate (§5.2), sign-up (§6), step-up (§7), the keepalive (§10)
> and the client side of sign-up, passkeys and step-up (§6, §7, §10) against commit 54e2d73,
> 2026-10-31; `trust proxy` row against the Caddy edge replacing nginx (feat/f5-caddy, base d604544), 2026-10-31

# Authentication & Identity

This document is the consolidated reference for how Common Ground authenticates users and models
identity. It covers every login method, the session infrastructure, device keypairs, the separate
bot-token authentication plane, signup (including captcha), and account linking.

The [architecture README](../architecture/README.md#3-authentication--sessions) keeps only a short
overview of this area — this file owns the detail. The bot HTTP surface is documented separately in
[`docs/BOT-API.md`](../BOT-API.md); the bot account architecture (identity model, ownership,
lifecycle) in [the bots docs](../bots/README.md).

---

## Table of Contents

1. [Concepts & Data Model](#1-concepts--data-model)
2. [Session Infrastructure](#2-session-infrastructure)
3. [Device Keypairs (WebCrypto P-384)](#3-device-keypairs-webcrypto-p-384)
4. [The Login Endpoint](#4-the-login-endpoint)
5. [Login Methods](#5-login-methods)
6. [Signup Flow & Captcha](#6-signup-flow--captcha)
7. [Passkeys](#7-passkeys)
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
| `passkeys` | `srv/entities/passkeys.ts` | WebAuthn credentials, each bound to one relying party (`rpId`), see [§7](#7-passkeys). |
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
| Store | `connect-redis` 10 (`RedisStore`) on the `redis` Valkey state instance (`sess:` prefix; `noeviction`, persisted — sessions survive restarts, a full cache cannot evict them) | `srv/util/express.ts` |
| Cookie name | `connect.sid` in prod, `cg_<deployment>.sid` otherwise | `srv/serverconfig.ts:25` |
| Secret | Docker secret `redis_secret`, else `REDIS_SECRET` env | `srv/util/express.ts:144` |
| `maxAge` | 12 hours | `srv/util/express.ts:147` |
| `httpOnly` | `true` | `srv/util/express.ts:148` |
| `secure` | `true` except when `DEPLOYMENT === 'dev'` | `srv/util/express.ts:149` |
| `sameSite` | `lax` | `srv/util/express.ts:150` |
| `rolling` | `true` (cookie/expiry refresh on every request) | `srv/util/express.ts:154` |
| `saveUninitialized` | `true` (a session row is created for every visitor) | `srv/util/express.ts:153` |
| `resave` | `false` | `srv/util/express.ts:152` |
| `proxy` / `trust proxy` | `true` (behind the Caddy edge, which sets `X-Forwarded-*` itself) | `srv/util/express.ts:127,145` |

### Cookie scoping

The session cookie is **host-only**: it is sent to the instance's own host and to no other host
under the domain. Only a process running in legacy CG ID mode (`CG_LEGACY_CGID=true`, the gateway,
see [§7](#legacy-cg-id-gateway-only)) sets the cookie `domain` to `.<APP_HOSTNAME>`
(`srv/util/express.ts`), so that the main app and the CG ID app (`id.<domain>`) share one session.
`APP_HOSTNAME` is derived from `BASE_URL` (`srv/util/urls.ts`).

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

The authenticated identity plus in-flight login state live on the session (`SessionData` in
`srv/util/express.ts`):

| Field | Meaning |
|-------|---------|
| `user` | `{ id, deviceId }` — set only after a successful login. Its presence *is* the "logged in" signal. |
| `authAt` / `authMethod` | When and how the session last authenticated interactively (login, account creation, `User/reauthenticate`). Never set by a device-key login. Read by the step-up guard ([§7](#step-up-for-sensitive-actions)). |
| `signSecret` | One-time random challenge (20 chars) for signature-based flows. |
| `createdAt` | First-seen timestamp. |
| `passport` / `twitter` | Twitter OAuth data (via Passport.js). |
| `lukso` | Prepared LUKSO Universal Profile login/creation data. |
| `farcaster` | Prepared Farcaster login/creation data (FID, address, profile). |
| `preparedCredential` | Prepared wallet credential incl. the time of the signature check (see [§5](#5-login-methods)). |
| `webauthnChallenges` | WebAuthn ceremonies in flight, keyed by challenge ([§7](#ceremony-state)). |
| `pendingPasskey` | A passkey registered during sign-up, waiting for `createUser` ([§7](#sign-up-with-a-passkey)). |
| `signupEmail` | Sign-up address verification: hashed code bound to the address, expiry, attempts, then `verifiedAt` ([§6](#6-signup-flow--captcha)). |
| `legacyDomainCookieCleared` | Set once an obsolete subdomain-scoped session cookie has been expired ([§7](#session-cookie-on-upgraded-instances)). |
| `passkeyData` | Legacy CG ID mode only: `{ step: 'success', passkeyId, userId }` left by `CgId/verifyAuthenticationResponse`. |
| `temporaryArticleIds` | Unrelated to auth (draft article ownership). |

Every login (all `User/login` branches and `createUser`) ends in `establishLoginSession()`
(`srv/util/authSession.ts`): `session.regenerate()` (a session id known before the login is
worthless afterwards and all pre-login state is dropped), set `user`, record `authAt`/`authMethod`
(not for a device-key login), and an awaited `session.save()`. When the session was already logged
in as the **same** user (a device-key re-login, e.g. after the page reload that ends the X OAuth
redirect), the in-flight linking state (`passport`, `twitter`, `lukso`, `farcaster`,
`preparedCredential`) and `authAt`/`authMethod` are kept. The X OAuth callback
(`/twitter-callback`) passes `keepSessionInfo: true`, so passport's own session regeneration keeps
the logged-in user. TODO(verify): X linking end to end on the test VM.

### CORS

Both the API and WebSocket servers keep their own allow-lists. Outside dev the allowed origin is
`BASE_URL`; dev adds a set of `localhost` / `app.cg.local` / `bs-local.com` origins
(`srv/util/express.ts`, `srv/wsapi.ts`). Only the API of a legacy CG ID process additionally allows
the `CGID_URL` origin. Requests with **no** `Origin` header are allowed (mobile apps, curl).
Credentials are enabled (`credentials: true`).

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

All logins go through `POST /User/login` (`srv/api/user.ts`), a discriminated union on
`data.type`. The generic shape of every branch is:

1. Validate the branch-specific proof (signature, prepared credential, OAuth session, code…).
2. Resolve the user (`userHelper.getOwnDataBy…` or `getUserByAccount`).
3. In parallel, load `communities`, `chats`, `unreadNotificationCount`, and — for methods that supply
   a fresh device public key — `deviceHelper.createDevice(userId, device.publicKey)`.
4. `establishLoginSession()` ([§2](#session-data-shape)): new session id, `user = { id, deviceId }`,
   `authAt`/`authMethod` for every type except `device`, awaited save.
5. Return `{ ownData, communities, chats, deviceId, webPushSubscription, unreadNotificationCount }`.

The challenge used by signature methods comes from `POST /User/getSignableSecret`
(`srv/api/user.ts:71-94`), which generates a 20-char random string
(`SIGNABLE_SECRET_LENGTH`), stores it as `session.signSecret`, and returns it. A given challenge is
consumed on use (`signSecret` is deleted after login).

`POST /User/checkLoginStatus` returns `{ userId | null }` for the current session,
`POST /User/ensureSession` saves the session (keepalive for the rolling cookie), and
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

### 5.2 Wallet (`type: "wallet"`) — EVM only

Two-step, using a **prepared credential** held in the session:

1. `POST /User/prepareWalletAction` (`srv/api/user.ts:904-922`): the client submits a signed
   challenge. The endpoint requires `data.data.secret === session.signSecret`, then calls
   `walletHelper.prepareWalletAction()`.
2. `prepareWalletAction` (`srv/repositories/wallets.ts:247+`) verifies the signature: the SIWE
   message is parsed and `ethers.verifyMessage` recovers the signer; the SIWE `Nonce` must equal
   the challenge and the recovered address must equal the claimed address
   (`parseAndVerifySiweWalletData`). Only `evm` and `cg_evm` are accepted. Fuel and Aeternity are
   gone entirely (Phase 3/3.5 of the slimming roadmap, 2026-08-01): verification branches, enum
   values, address types and the stored rows themselves
   (`1785632400000-dropFuelAeternityWallets`).
   `prepareWalletAction` then determines `readyForLogin` (wallet exists, `loginEnabled`, not
   deleted) vs `readyForCreation`, and stores the result as `session.preparedCredential`.
3. `POST /User/login` with `type: "wallet"` reads `preparedCredential`, requires
   `readyForLogin && ownerId`, creates a device, and logs in (`srv/api/user.ts:164-184`).

The SIWE message is built client-side in `src/util/siwe.ts` (host, `URI`, `Version`, `Chain ID`,
`Nonce: <signSecret>`, `Issued At`).

**Recovery phrase (12 words).** The deprecated recovery-phrase login (`prepareMnemonicLogin`,
`src/data/appstate/login.ts`) derives an EVM key from the phrase and signs in as the account's
`cg_evm` wallet (`prepareWalletAction` with `type: 'cg_evm'`, then `login {type:'wallet'}`). It is
independent of the device key. Outside legacy CG ID mode `prepareWalletAction` refuses
`type: 'cg_evm'` with `NOT_SUPPORTED`, so the recovery phrase no longer signs in; ordinary EVM
wallets are unaffected. The web app matches this: the recovery-phrase entry (AuthFlow "More") and
the stored-phrase re-login in `autoLogin` exist only on a legacy CG ID instance.

### 5.3 Passkey / WebAuthn (`type: "passkey"`)

FIDO2/WebAuthn on the instance's own origin, implemented with `@simplewebauthn/server` (details in
[§7](#7-passkeys)). The client fetches `POST /Passkey/authenticationOptions {purpose:'login'}`
(empty `allowCredentials`: discoverable credentials and autofill), runs the browser ceremony and posts
`{ type: "passkey", authenticationResponse, device }`. The branch verifies the assertion through the
shared core, rejects credentials without an owner, creates a device and logs in. An unknown
credential is `NOT_FOUND`, a removed one `DELETED`. On a legacy CG ID process the branch is
`NOT_SUPPORTED`; there the CG ID popup flow and `type: "passkey-success"` remain
([§7](#legacy-cg-id-gateway-only)).

### 5.4 Email + Password (`type: "password"`)

Client posts `{ aliasOrEmail, password, device: { publicKey } }`. The server resolves and verifies
credentials via `userHelper.getOwnDataByCgProfileNameOrEmailAndPassword()`
and creates a device. Passwords are set/changed via `POST /User/setPassword`, which requires a
recent authentication (step-up, [§7](#step-up-for-sensitive-actions)).

### 5.5 Email Verification Code / One-Time Password (`type: "verificationCode"`)

Passwordless email login:

1. `POST /User/sendOneTimePasswordForLogin` (`srv/api/user.ts:1494-1519`): only allowed when logged
   out and when email is enabled (`emailEnabled()` in `srv/api/emails.ts` requires a valid SMTP
   configuration, `SMTP_HOST` set — see [docs/email-notifications](../email-notifications/README.md));
   otherwise it throws `EMAIL_DISABLED`. Send limits apply first — 10 per hour per client IP
   (IPv4 address / IPv6 /64) and, per target address, one per minute and 10 per hour,
   `RATE_LIMIT_EXCEEDED` beyond
   (`srv/util/mailSendLimits.ts`, see [docs/email-notifications](../email-notifications/README.md#send-limits)).
   It generates a token via `emailHelper.generateVerificationEmailToken(userId)` and emails it.
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
| Passkey | `passkey` (`passkey-success` on a legacy CG ID process) | WebAuthn assertion, user verification required | Yes | `passkeys` |
| Password | `password` | email/alias + password | Yes | `users` |
| Email code | `verificationCode` | emailed one-time token | Yes | `users` / email token |
| Twitter | `twitter` | Passport OAuth session | Yes | `user_accounts` |
| LUKSO | `lukso` | on-chain signature + nonce | Yes | `user_accounts` |
| Farcaster | `farcaster` | SIWE + on-chain FID registry | Yes | `user_accounts` |

---

## 6. Signup Flow & Captcha

Account creation is `POST /User/createUser` (`srv/api/user.ts`). It is only allowed when logged
out, and it must add at least one usable sign-in method (`loginMethodAdded`) or it throws.

**Email first.** On an instance that can send mail (`emailEnabled()`), the sign-up address is
verified *before* the account exists:

1. `POST /User/requestSignupEmailCode { email, recaptchaToken }` (logged out only;
   `EMAIL_DISABLED` without mail) first checks the **sign-up captcha** (`CAPTCHA_FAILED`; skipped
   in dev) — before any mail goes out — then applies the send limits (10/h per client IP, per
   address one per minute and 5 per hour), stores a hash of a 6-digit code (CSPRNG) bound to the
   address in `session.signupEmail` (valid 15 minutes) together with `captchaAt`, and mails the
   code. A resend to the same address in the same session within 2 hours needs no new token. If
   the address already belongs to an account, no code is sent; the address receives a notice
   instead, and the session state, the response and a later resend or code check behave the same
   as for a free address.
2. `POST /User/verifySignupEmailCode { email, code }` checks code and address (5 wrong attempts per
   code, counted atomically in Redis per issued code) and marks the address verified for one
   hour.
3. `createUser` without such a verified address fails with `EMAIL_VERIFICATION_REQUIRED`; with it,
   the account gets exactly that address with `emailVerified = true` (a `useEmailAndPassword.email`
   must match it), and its captcha counts — `recaptchaToken` is not needed (it is still checked on
   every path that did not go through the code: instances without mail, legacy CG ID mode). On such an instance a sign-up passkey also needs the verified address first
   (`Passkey/registrationOptions` and `verifyRegistration` while logged out fail with
   `EMAIL_VERIFICATION_REQUIRED`), so the order is: email code → sign-in method → `createUser`.
   Instances without mail skip this step and create accounts with an unverified address (cg.box
   runs with mail).

The request bundles the new device public key plus one or more credential selectors, which are
resolved against the in-flight session state built by the prepare/verify endpoints above:

| Selector | Source of truth |
|----------|-----------------|
| `useEmailAndPassword` | request body (email + password) |
| `usePreparedWallet` | `session.preparedCredential` (must be `readyForCreation`) |
| `usePreparedPasskey` | `session.pendingPasskey` ([§7](#sign-up-with-a-passkey)), not expired, of this RP |
| `usePreparedFarcaster` | `session.farcaster` (`readyForCreation`) — legacy CG ID mode only |
| `useTwitterCredentials` | `session.passport.user` — legacy CG ID mode only |
| `useLuksoCredentials` | `session.lukso` (not `existsAlready`) — legacy CG ID mode only |
| `useCgProfile` | request body (display name/image) |

X (Twitter), LUKSO and Farcaster no longer create accounts: outside legacy CG ID mode those
selectors are refused with `NOT_SUPPORTED`. They can still be linked to an existing account
([§8](#8-account-linking-user_accounts--wallets)) and then sign in.

On success the server creates the user + first device (and the sign-up passkey, in the same
statement), establishes the login session (`authMethod: 'signup'`) and — only when the address is
not verified yet — sends a verification email. The response mirrors the login response shape.

**Client.** The web app's sign-up (`AuthFlow`, [frontend §10](../frontend/README.md#10-authentication-ui))
follows exactly this order: display name + email + captcha → `requestSignupEmailCode` /
`verifySignupEmailCode` (skipped when the instance config says `features.email: false`, and on a
legacy CG ID instance) → "How will you sign in?" (passkey, password or wallet) → `createUser`
immediately. It offers no X, LUKSO or Farcaster sign-up and no recovery phrase. The captcha is
solved where the server checks it — on the details step with the code request, or (no mail /
legacy) on the step that calls `createUser` — so no token has to survive several steps.
`EMAIL_VERIFICATION_REQUIRED` sends the user back to the details for a new code.

### Captcha

Signup is protected by a **captcha provider abstraction** (`srv/util/captcha.ts`), selected via
`CAPTCHA_PROVIDER = altcha | recaptcha | off`:

- **`altcha`** (default when no reCAPTCHA secret is configured): self-hosted
  [ALTCHA](https://altcha.org) proof-of-work captcha, fail-closed. Challenges come from
  `GET /Captcha/challenge` (`srv/api/captcha.ts`), signed with an HMAC key
  (Docker secret `altcha_hmac_key` / `ALTCHA_HMAC_KEY`, otherwise generated once and shared
  via Redis; the two HMAC secrets ALTCHA v2 needs are derived from it). Verification
  (`verifyCaptchaToken`) checks the challenge signature, its expiry and the proof of work, and
  enforces single-use replay protection in Redis keyed on the challenge signature. The proof of
  work is ALTCHA v2 (`PBKDF2/SHA-256` key search): difficulty is tuned via `ALTCHA_COST`
  (iterations per attempt, default 5000) and `ALTCHA_COUNTER_MAX` (upper bound of the answer the
  client must find, default 4000 — the counter is drawn per challenge from
  `[max/2, max]`). Neither variable is set in either compose file; tuning the difficulty means
  adding it to the `api` service's environment. The v1-era `ALTCHA_MAX_NUMBER` no longer does
  anything and logs a warning when set.
- **`recaptcha`**: Google reCAPTCHA v2. Auto-selected when `CAPTCHA_PROVIDER` is unset but a
  secret (`google_recaptcha_secret_key` / `GOOGLE_RECAPTCHA_SECRET_KEY`) is present — this
  preserves the historical behaviour of the official instances.
- **`off`**: explicit opt-out only; the server logs a loud warning at startup. There is no
  silent skip-when-unconfigured anymore.

The **backend is the runtime authority** for the provider: `GET /Captcha/config`
(`srv/api/captcha.ts`, public, `Cache-Control: no-store`) returns `{ provider }` — the value
`verifyCaptchaToken` actually uses — for every provider. The frontend fetches it once per page
load (`useCaptchaProvider` in `src/context/CaptchaContext.tsx`) and renders the matching widget
in `CaptchaModal` / `SignupCaptcha` (the AuthFlow sign-up); the instance config (`captchaProvider` in
`window.__CG_INSTANCE__`) is only the initial hint and the fallback when the fetch fails. If the
resolved provider is `recaptcha` but no site key is configured, both surfaces show an explicit
"captcha is misconfigured" message instead of rendering nothing (which used to leave a dead
signup button). The server logs an error at startup for the mirror case (`recaptcha` without a
secret key).

`createUser` verifies the token when `DEPLOYMENT !== 'dev'`;
a separate authenticated endpoint `POST /User/verifyCaptcha`
(`srv/api/user.ts`) lets a logged-in user raise their `trustScore` to `1.0` by solving a
captcha.

Rate limiting: `createUser` is IP-rate-limited (`createUserRateLimiter`: 2 per /64 per 24 h outside
dev); `verifyCaptcha` is limited to 3 per /64 per 24 h.

---

## 7. Passkeys

Passkeys run on the instance's own origin. The `Passkey` router (`srv/api/passkeys.ts`, mounted at
`/Passkey`) and the passkey branches of `User/login` and `User/reauthenticate` share one WebAuthn
core, `srv/util/passkeys.ts`, which takes the relying-party configuration as a parameter.

### Relying party

`srv/util/passkeyConfig.ts`:

- **RP ID** = `PASSKEY_RP_ID` if set, else the host of `BASE_URL`. It must equal that host or be a
  parent domain of it; otherwise the api process refuses to start. **The RP ID is permanent:** every
  credential is bound to it, so changing it later strands all registered passkeys.
- **Origin** = exactly the `BASE_URL` origin (dev adds `http://localhost:3000` and
  `http://localhost:8000`). There is no CG ID origin.
- Every stored credential records its `rpId` ([database docs](../database/README.md#passkeys)), and
  every lookup is scoped to the process's RP ID: a credential of another RP ID is unknown here, a
  NULL `rpId` matches nothing, and the browser and the server (RP ID hash) refuse assertions for
  another RP ID anyway.
- Nothing user-controlled may be served from the RP ID's host or any subdomain of it, because such
  a page could run ceremonies for the relying party. Plugin create/update therefore reject URLs
  whose host is `APP_HOSTNAME`, the RP ID or a subdomain of either (not enforced in dev).
- The instance config carries `features.passkeys` and `passkeyRpId`; `cgidUrl` only on a legacy
  CG ID process.
- **Every backend process** (api, wsapi, jobs, onchain, memberlist, mediasoup) must run with the same
  `PASSKEY_RP_ID` and `CG_LEGACY_CGID` values: shared code (e.g. the own-data query behind
  `OwnData.passkeys`) asks `getProcessRpIdOrNull()` for the RP ID in whichever process it runs.
  Only the api validates the configuration at startup; elsewhere an invalid value yields no RP
  (no passkeys listed). TODO(verify): the compose files do not pass these variables yet.

### Ceremony state

`session.webauthnChallenges` maps each issued challenge to `{ purpose: register | login | stepup,
rpId, userId, userHandle?, expiresAt }`: at most 5 entries (oldest evicted), so ceremonies in two
tabs do not overwrite each other; 5 minutes, 10 minutes for a conditional (autofill) login request.
A challenge is removed from the session *before* its response is verified, whatever the outcome,
and marked used in Redis (`SET NX`), so it can be answered once — also when two requests race on
the same session. Purpose, RP ID and session user must match the entry.

Options and verification:

- registration: `residentKey: 'required'`, `userVerification: 'required'`, attestation `none`,
  algorithms EdDSA/ES256/RS256, `excludeCredentials` = the account's credentials of this RP, one
  stable WebAuthn user handle per account and RP (reused from its existing credentials, else 32
  random bytes), label = the account's email or profile name;
- both verifications pass `requireUserVerification: true` and the configured RP ID and origin,
  never values from the stored options;
- assertions are looked up by `(rpId, credentialID)`; a user handle in the response must match the
  stored one (a missing handle is accepted for step-up); a signature counter that does not increase
  (unless both are 0, as with synced passkeys) is rejected and logged as a `[security]` warning.
- Request bodies are validated by strict schemas for the WebAuthn JSON (`srv/validators/common.ts`:
  `WebAuthnRegistrationResponse`, `WebAuthnAuthenticationResponse`).

### Endpoints

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `/Passkey/registrationOptions` | logged out (IP rate-limited; verified sign-up address required when the instance sends mail) or logged in (step-up) | Options for the sign-up passkey (`displayName` labels it; the verified sign-up address is the user name) or for adding one to the account. |
| `/Passkey/verifyRegistration` | same | Logged in: stores the passkey (`name` or "<browser> on <OS>"), emits the new list, mails a notice to the verified address. Logged out: keeps it in `session.pendingPasskey`. |
| `/Passkey/authenticationOptions` | `login`: anyone (IP rate-limited); `stepup`: logged in | `login`: empty `allowCredentials`, no user id accepted from the client. `stepup`: the session user's credentials of this RP. |
| `/User/login {type:'passkey'}` | logged out | Verifies the assertion and logs in ([§5.3](#53-passkey--webauthn-type-passkey)). |
| `/Passkey/list`, `/Passkey/rename` | logged in | The session user's passkeys of this RP (`id`, `credentialID`, `name`, device type, backup state, `createdAt`, `lastUsedAt`). |
| `/Passkey/remove` | logged in, step-up | Soft-deletes; `LAST_LOGIN_METHOD` if it is the account's last sign-in method (see below). |

`OwnData.passkeys` lists only credentials of the process's RP ID.

### Sign-up with a passkey

A passkey registered while logged out is not written to the database: `verifyRegistration` keeps
it in `session.pendingPasskey` for 15 minutes, and `createUser {usePreparedPasskey: true}` inserts
it in the same statement as the user. An abandoned sign-up therefore leaves no row behind.

### Step-up for sensitive actions

`requireRecentAuth()` (`srv/util/authSession.ts`) runs before any side effect of a sensitive
action and fails with `REAUTH_REQUIRED` unless `session.authAt` is at most 5 minutes old and
`authMethod` is an interactive one (any login type except the device key, or `signup`; a future
transfer-link session — `transfer` — never qualifies). Because nothing has changed when it fails,
the client can re-authenticate and retry the same request.

Protected: `User/setPassword`; an `email` change via `User/updateOwnData` (only when the address
actually changes — re-sending the current address with other settings is ignored);
`User/addUserAccount` and `User/removeUserAccount` of an account that can sign in (X, LUKSO,
Farcaster);
`User/addPreparedWallet` with `loginEnabled`; `User/updateWallet` when it changes `loginEnabled`;
`User/deleteWallet` of a login-enabled wallet; adding (`registrationOptions` /
`verifyRegistration` while logged in) and removing a passkey; the bot owner's `Bot/tokens/issue`
and `Bot/disable`. Routine moderation (including `Bot/remove`, which removes a bot from a
community) is not protected.

**Last sign-in method.** An account never loses its last sign-in method of this instance — a
passkey of this RP, a password or a login-enabled EVM wallet (`srv/repositories/loginMethods.ts`;
X, LUKSO and Farcaster accounts do not count). `Passkey/remove`, `User/deleteWallet` of a
login-enabled wallet, `User/updateWallet` switching `loginEnabled` off and `User/removeUserAccount`
of an X/LUKSO/Farcaster account fail with `LAST_LOGIN_METHOD` when nothing would remain. The check
locks the user row inside the transaction that makes the change. Future account/community deletion and ownership transfer use
the same guard. `srv/tests/passkeyRoutes.spec.ts` keeps every `User`, `Passkey` and `Bot` route
classified.

`POST /User/reauthenticate` (logged in; rate-limited per IP and per user) accepts
`{type:'passkey', authenticationResponse}` (a `stepup` assertion of one of the user's own
credentials), `{type:'password', password}` (also for accounts that have passkeys) or
`{type:'wallet'}` (a `prepareWalletAction` signature of one of the user's login-enabled wallets,
at most 5 minutes old). It sets `authAt`/`authMethod` and returns `{ validUntil }`.

**Client.** `BaseApiConnector` answers `REAUTH_REQUIRED` by opening the "Confirm it's you to
{action}" dialog (`ReauthDialog`: passkey if the account has one here, password, or a sign-in
wallet) and retries the same request once after `User/reauthenticate`; a cancelled dialog surfaces
as `REAUTH_REQUIRED` and is not shown as an error. Screens that start a WebAuthn ceremony after the
confirmation (adding a passkey) or that need the prepared wallet afterwards (adding a sign-in
wallet) confirm first (`useStepUp().ensureRecentAuth`). `LAST_LOGIN_METHOD` is shown as "This is
your last way to sign in …". Details: [frontend §10](../frontend/README.md#10-authentication-ui).

### Passkeys in the web app

Login: the username field carries `autocomplete="username webauthn"` and a conditional (autofill)
request is armed while the login form is shown (renewed every 9 minutes); "Sign in with a passkey" runs the modal ceremony
from the click. Both post `User/login {type:'passkey'}`; an unknown or deleted credential is
reported to the browser with `PublicKeyCredential.signalUnknownCredential`. After a password login
without a passkey here, the app tries a conditional create (`useAutoRegister`) once per account and
browser and otherwise asks once to add a passkey. Settings → Passkeys lists `Passkey/list` (name,
created, last used, synced), renames, removes and adds, and reports the list with
`signalAllAcceptedCredentials` / `signalCurrentUserDetails` (per WebAuthn user handle, which
`Passkey/list` returns as `userHandle`). Every browser call is wrapped; a cancelled ceremony is
never shown as an error. On a legacy CG ID instance (`cgidUrl` or `features.passkeys: false` in the
instance config) the app keeps the CG ID popup for login only (`src/context/LegacyCgIdPasskey.tsx`).

### Legacy CG ID (gateway only)

A process started with `CG_LEGACY_CGID=true` (the `app.cg` gateway during the move) mounts the old
`CgId` router (`srv/api/cgid.ts`) **instead of** `Passkey`. Its relying party is the host of
`CGID_URL` with exactly that origin, and it only *authenticates* existing credentials of that RP:
`/CgId/generateAuthenticationOptions` (empty `allowCredentials`, no user id parameter) and
`/CgId/verifyAuthenticationResponse` through the shared core, plus `/CgId/ensureSession`. There is no
registration. A successful assertion leaves `session.passkeyData = {step:'success', ...}` and emits
`cliCgIdSignResponse` to the `expressSession:<sid>` room; the main window then calls
`User/login {type:'passkey-success'}`, which is accepted only in this mode and within 5 minutes
(`passkeyData.expiresAt`). Only in this mode does
the session cookie cover subdomains, does the API CORS list include the `CGID_URL` origin and does
the instance config carry `cgidUrl`. The CG ID views (`src/cgid/*`) still call the registration
endpoints, which no backend serves any more.

Apart from the passkey surface, legacy mode keeps the **full previous sign-up and login surface**:
`createUser` with every selector (including X, LUKSO and Farcaster), no sign-up email verification,
the recovery-phrase wallet path, and all other routers. Restricting what a gateway process serves is
left entirely to the gateway's server-side route allowlist (roadmap item G1); legacy mode itself
does not restrict it.

### Session cookie on upgraded instances

Outside legacy mode the session cookie is host-only. A browser may still hold the
subdomain-scoped cookie (`Domain=.<APP_HOSTNAME>`) of an instance that ran an older version; the
api expires it once per session (`legacyDomainCookieCleared`), and the session it pointed to stays
valid. Release note for in-place upgrades: users keep their sessions; nothing to do.

## 8. Account Linking (user_accounts & wallets)

A logged-in user can link, update, and unlink identity items without changing their root account.

### Profile / social accounts

`POST /User/addUserAccount` (for X, LUKSO and Farcaster: step-up, then a notice mail to the verified
address) adds a `twitter`, `lukso`, `farcaster`, or `cg` account to the current
user, reading the prepared provider state from the session (same state built by the prepare/verify
endpoints). `POST /User/updateUserAccount` edits the `cg` profile, and `POST /User/removeUserAccount`
removes an account of a given type (for X, LUKSO and Farcaster: step-up and the last-method check,
[§7](#step-up-for-sensitive-actions)). Because
`user_accounts` has a composite PK `(userId, type)`, a user holds at most one account per provider
type.

### Wallets

| Endpoint | Purpose |
|----------|---------|
| `/User/prepareWalletAction` | Verify a wallet signature and stage a `preparedCredential` ([§5.2](#52-wallet-type-wallet--evm-only)). |
| `/User/addPreparedWallet` | Attach the prepared wallet to the current user, with `loginEnabled` / `visibility` flags (step-up when `loginEnabled`). |
| `/User/updateWallet` | Update wallet flags (step-up when `loginEnabled` changes; switching off the last sign-in method is refused). |
| `/User/deleteWallet` | Soft-delete a wallet (step-up for a login-enabled wallet; the last sign-in method is refused). |
| `/User/getWallets` | List the current user's wallets. Querying **other** users' wallets is disabled and returns `NOT_ALLOWED` (`srv/api/user.ts:1032-1040`). |

Each wallet mutation emits a `cliWalletEvent` to the owning user over the socket. A wallet is unique
per `(type, walletIdentifier)`; `loginEnabled` controls whether it can be used as a login method, and
`visibility` (`private`/`public`) controls exposure. Deleting a user sets `wallets.userId` to `NULL`
(`onDelete: 'SET NULL'`), so a wallet identifier is not permanently burned.

### Email verification

Independent of any social account, an email can be verified:
`POST /User/requestEmailVerification` emails a token (send limits: 10/h per client IP, 5/h per
target address, 5/h per account — [docs/email-notifications](../email-notifications/README.md#send-limits));
`POST /User/verifyEmail`
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
- **Auto-login** (`autoLogin`, `src/data/appstate/login.ts`): if offline, it optimistically
  trusts the cached user; otherwise it reconstructs the current user from IndexedDB device keypairs +
  local `OwnData`, then performs a `device` login. The deprecated stored-mnemonic fallback runs only
  on a legacy CG ID instance; elsewhere a stored phrase is deleted.
- **Step-up freshness**: an interactive login and `createUser` mark the session as freshly
  authenticated for the client's `stepUpManager` (`src/data/auth/stepUp.ts`); a `device` login,
  `logout()` and a logout in another tab clear it. It is only an estimate used to confirm before a WebAuthn ceremony — the
  server's `REAUTH_REQUIRED` stays authoritative.
- **Multi-tab coordination**: only the active tab performs the network login; passive tabs wait for a
  `LOGIN_FINISHED`/`LOGIN_ERROR` broadcast (`loginRequiredErrorHandler`). This avoids concurrent
  device-signature races across tabs.
- **`checkLoginStatus`** compares the server's `userId` against the cached one and logs out on
  mismatch.
- **Keepalive**: `WebSocketManager` calls `POST /User/ensureSession` on start and every 29 minutes.
- **Post-login setup** (`setupAfterLogin`): seeds the local Dexie databases (user, communities, chats,
  notifications), logs the socket in, and registers the push subscription.

The `login()` method maps UI choices to the `POST /User/login` `type` values described in
[§5](#5-login-methods) (`_login` in `src/data/appstate/login.ts`; `{account:'passkey',
authenticationResponse}` → `passkey`, `{account:'passkey-legacy'}` → `passkey-success`), generating a
fresh device keypair for every non-device method and persisting it after the server confirms the
login. The login and sign-up UI is `AuthFlow`, in the onboarding modal and on `/login`
([frontend §10](../frontend/README.md#10-authentication-ui)).

---

## Cross-references

- Overview & session table: [architecture README §3](../architecture/README.md#3-authentication--sessions)
- Socket.IO auth handshake: [realtime README](../realtime/README.md)
- Bot HTTP API: [`docs/BOT-API.md`](../BOT-API.md); bot account architecture: [bots README](../bots/README.md)
- Entities: [database README](../database/README.md)
