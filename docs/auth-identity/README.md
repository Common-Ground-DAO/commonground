> Status: verified against commit 40f4a0b0f, 2026-08-04; `emailEnabled()` reference and email
> send limits against commit e44dac1, 2026-10-31; session store instance (Valkey state
> instance) against commit ff0da06, 2026-10-31; sessions (§2), the login endpoint (§4), passkeys
> (§5.3, §7), the recovery-phrase gate (§5.2), sign-up (§6), step-up (§7), the keepalive (§10)
> and the client side of sign-up, passkeys and step-up (§6, §7, §10) against commit 54e2d73,
> 2026-10-31; `trust proxy` row against commit fe3937f, 2026-10-31; logout, password login and
> policy (§5.4), email codes (§5.5, §8), the wallet message domain (§5.2), the add-method rule (§7)
> and transfer links / the account-security step (§11) against commit 9fc05a9, 2026-11-01;
> session creation, cookie, middleware order, logout and keepalive (§2, §4, §7, §10) against
> commit eab2a27, 2026-11-01; limits, limit errors and the sign-up code state (§4 "Limits", §5.4,
> §5.5, §6, §8) against commit 2fad7d3, 2026-11-01; 8-digit email codes and the hourly email-code
> failure budgets (§4, §5.5, §6, §8) against commit 2fad7d3, 2026-11-01; the store TTL of sessions
> without a user, the index of each user's sessions, signing out other devices and the pre-login
> limits (§2, §3, §4, §5.4, §7, §8, §10, §11) against commit 23a4c1e, 2026-11-01; the per-tab
> login state, login lock, cross-tab broadcast, `checkLoginStatus`, LOGIN_REQUIRED handling and
> the signed-out path across tabs (§10) against commit 964f6b3, 2026-11-02, the logout marker
> and the signed-out re-check against commit 9d00729, 2026-11-03; the logout's
> sign-out of the device's other sockets against commit ce09d8a, 2026-11-02; the header-less
> logout disconnect and the own-logout guard against commits 1b09f87 and f97ef1b, 2026-11-02; the post-login setup
> (no notification database) against commit 1e6a0d4, 2026-11-03; the socket's immediate drop of
> a signed-out device against commit 1b9948c, 2026-11-03;
> the session secret at startup, the instance key prefix, CORS and origin checks (§2), Farcaster message
> parsing (§5.8), the legacy CG ID surface (§7), transfer links (§11) and gateway mode (§12)
> against commit 696102b, 2026-11-06; the session secret as configured (§2), the gateway's start-up
> checks, storage, mail-limit secret and web app (old page data, continuation per tab) (§12)
> against commit 696102b, 2026-11-07; the LUKSO sign-in message (§5.7), the host-only cookie on
> every process and the old-scope cleanup (§2, §7), the transfer link's next path, confirmation
> identifier, declining and sign-out (§11), and the gateway's start-up checks and cookie notes (§12)
> against commit 04c72b2, 2026-11-07; what a transfer-link session may add (§7, §11, §12) and the
> step-up dialog's methods (§7) against commit c18b233, 2026-11-07

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
11. [Transfer Links and the Account-Security Step](#11-transfer-links-and-the-account-security-step)
12. [Gateway Mode](#12-gateway-mode)

---

## 1. Concepts & Data Model

Identity in Common Ground is split across several tables. A **user** is the root account; everything
else hangs off it.

| Table | Entity | Purpose |
|-------|--------|---------|
| `users` | `srv/entities/users.ts` | Root account. Holds `email`, hashed `password`, `is_bot`, `displayAccount`, `trustScore`, etc. |
| `user_accounts` | `srv/entities/user-accounts.ts` | Linked identity/profile items (one row per provider). Composite PK `(userId, type)`. |
| `wallets` | `srv/entities/wallets.ts` | Crypto wallets attached to a user; may be login-enabled. |
| `devices` | `srv/entities/device.ts` | Per-device public keys used for silent re-authentication; valid while their `generation` is not below the user's `sessionGeneration` ([§2](#signing-out-other-devices)). |
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
`srv/util/sessionSetup.ts` (wired into the api app by `srv/util/express.ts`).

| Setting | Value | Source |
|---------|-------|--------|
| Store | `connect-redis` 10 (`RedisStore`) on the `redis` Valkey state instance (`sess:` prefix — `gateway:sess:` on a gateway, [§12](#12-gateway-mode); `noeviction`, persisted — sessions survive restarts, a full cache cannot evict them) | `srv/util/express.ts` |
| Store TTL | the rest of the cookie's 12 hours for a logged-in session; an hour after the last request for any other session (longer only while a sign-up in it needs its state, see below) | `sessionStoreTtlSeconds`, `srv/util/sessionSetup.ts` |
| Cookie name | `connect.sid` in prod, `cg_<deployment>.sid` otherwise | `srv/serverconfig.ts` |
| Secret | Docker secret `redis_secret`, else `REDIS_SECRET` env, used as it is (a secret file's trailing newline included — the key the cookies were always signed with; the unsubscribe-link and mail-limit keys come from the same value, `configuredSessionSecret`); read at startup by every process that needs it (api, wsapi, job-runner), which refuses to start when it is missing, the template placeholder or shorter than 16 characters (each without surrounding whitespace) | `srv/util/sessionSecret.ts` |
| `maxAge` | 12 hours | `srv/util/sessionSetup.ts` |
| `httpOnly` | `true` | `srv/util/sessionSetup.ts` |
| `secure` | `true` except when `DEPLOYMENT === 'dev'` | `srv/util/sessionSetup.ts` |
| `sameSite` | `lax` | `srv/util/sessionSetup.ts` |
| `saveUninitialized` | `false` — a session (and its cookie) exists only once a request stores something in it, see below | `srv/util/sessionSetup.ts` |
| `rolling` | `false` — the cookie of a **logged-in** session is still re-sent on every response (`rollLoggedInSessionCookie`), any other session's only when it changes | `srv/util/sessionSetup.ts` |
| `resave` | `false` | `srv/util/sessionSetup.ts` |
| `proxy` / `trust proxy` | `true` (behind the Caddy edge, which sets `X-Forwarded-*` itself) | `srv/util/sessionSetup.ts`, `srv/util/express.ts` |

### When a session exists

An anonymous request that stores nothing in the session creates none: no `sess:` key, no
`Set-Cookie`. A session is created by the first request that writes to it — `getSignableSecret`
(the device login's and SIWE challenge), WebAuthn ceremonies (`webauthnChallenges`), sign-up email
verification (`signupEmail`), `pendingPasskey`, wallet/LUKSO/Farcaster/X preparation, a login — and
that response sets the cookie. This matters on a page load without a valid session (cookie expired,
cleared or unknown to the store): the app's parallel requests used to mint one anonymous session
each, and their cookies could arrive after — and overwrite — the one the device login had just set.

**Sessions without a logged-in user are short-lived.** The store keeps such a session for an
hour after its last request (`ANONYMOUS_SESSION_TTL_MS`; connect-redis `ttl` is a function of
the session, `sessionStoreTtlSeconds`), never longer than the cookie. Every request refreshes it,
so does the web app's keepalive (`User/ensureSession`, every 29 minutes) while a tab is open —
twice within the hour, so one keepalive that a throttled background tab or a sleeping laptop
delays does not lose pre-login state (a prepared wallet signature, the X/LUKSO/Farcaster state, a
WebAuthn ceremony). A
sign-up in progress keeps its session as long as it needs its state: until the verified address or
the code runs out (`signupEmail.expiresAt`, at most an hour) and while the solved captcha still
counts for a new code (2 hours after `captchaAt`). The cookie keeps its 12-hour `maxAge`; once the
store has dropped the session, the browser's cookie names an unknown id, which is the same as no
session (a later write creates a new one). From login on, the full 12 hours apply: the TTL is
computed again on every write and touch, and a logged-in session gets the rest of the cookie's
lifetime. Every endpoint that can start a session for a visitor without one is limited per client
network ([§4 "Limits"](#limits)).

Sliding expiry is kept for logged-in sessions only: `rolling` is off, and a hook that runs right
before the headers go out re-sends the cookie of a session with `user` (signed like
express-session signs it) unless express-session set it in that response itself. A response to a
request that left with the anonymous pre-login cookie (the one holding the device login's
challenge) therefore cannot put that id back into the browser after the login replaced it. Every
request still refreshes the store TTL of an existing session (connect-redis `touch`). Code that
needs a stable `request.sessionID` only runs once the session holds data (the sign-up code attempt
limiter keys on `sessionID` + the stored code id).

A session id that is destroyed (logout) or replaced (`regenerate()`: login) is **revoked** for an
hour (`sess-revoked:<id>`, `withSessionRevocation` around the store): the store refuses to write that
id again (and re-checks after each write, removing it if a destroy overtook the write), and a
request that loaded the session before it went away ends without it (`revokedSessionGuard`, one
key lookup per request with a stored session, made before the response starts — before `res.end`
or the first write of a streamed response) — no Set-Cookie of the old id, no save that would
bring a logged-out session back. Left open: a response that the server had finished before the
revocation but that reaches the browser after the new cookie (delivery reordering) can still set
the old id; the store no longer knows it, so the browser is anonymous until the next login.

### Signing out other devices

**Session generations** decide which sessions, device keys and transfer links of an account are
still valid. The authority is PostgreSQL ([database](../database/README.md#session-generations)):

- one sequence, `session_generation_seq`;
- the account's generation, `users."sessionGeneration"` (0 until its first sign-out of other
  devices);
- the generation each device key and transfer link was created with (`devices."generation"`,
  `transfer_tokens."generation"`; 0 for those from before).

**Logins.** A login's first step (`beginLogin` in `User/login`, `createUser` and
`redeemTransferLink`) takes the next sequence value, before any credential is checked
(`users.nextSessionGeneration`). The session it establishes carries that value as `gen`, and so
does a device key it creates. `establishLoginSession` reads the account's generation again after
saving the session (and after the login created its device key). If the generation is above the
login's own, the login destroys the new session, deletes the new key, and is refused
(`NOT_ALLOWED`; `NOT_FOUND` for a device login).

**Signing out others.** A sign-out of the other devices raises the account's generation to the next
sequence value (`users.bumpSessionGeneration`). It runs in the same transaction as the change that
caused it, right before COMMIT, and gives the calling session's device the new generation:

- the change and the sign-out commit together or not at all. A refused change (`LAST_LOGIN_METHOD`,
  `NOT_FOUND`, a wrong code, …) signs nobody out;
- from the commit on, a device key or transfer link below the account's generation no longer
  works. The SQL that looks the key or link up checks this in the same statement:
  - `verifyDeviceAndGetUserId`, used by the HTTP device login, the socket login and the call server;
    the call server's role uses `session_generation_of()` because it may not read `users`;
  - `isLiveDevice`, which the socket login checks again after joining its rooms;
  - transfer-link `peek` and `consume`;
  - the push-notification device queries and `registerWebPushSubscription`.

  Bot devices are not checked this way: a bot account never signs out other devices, so its
  generation stays 0.

  A link carries the generation of the session that minted it.
- **Lock order.** The step locks the user row (`FOR UPDATE`) first. Only for its last statement,
  which draws the new value and also stamps the caller's device, does it take an advisory lock
  exclusively, held until COMMIT. A login's first step takes the same lock shared. A login
  therefore either got its value before the sign-out (lower generation: it is refused or ended),
  or after the commit, in which case its credential check sees the change. Logins wait only for
  that last statement and the COMMIT;
- `SET LOCAL lock_timeout = '5s'`: if the step cannot get its locks in time (a long transaction
  holds the user row), it fails with `SERVICE_UNAVAILABLE` instead of waiting. The change is
  rolled back with it, and the request can be retried;
- a session whose own generation is below the account's is refused (`LOGIN_REQUIRED`), with its
  change rolled back. A session that was itself signed out cannot sign out anyone.

**Sessions.** Sessions live in Valkey, so their check uses a copy of each account's generation
there, `sess-gen:<userId>` (`srv/util/sessionGenerations.ts`):

- **Load check** (`sessionGenerationGuard`, right after the revocation guard): for a session with a
  user, one round (`MGET`) reads the copy and `sess-keep:<userId>`, the session that signed the
  others out (13 hours).
  - A session with a lower generation is destroyed and revoked in the store. The request runs
    anonymously, and the revocation guard keeps the session from being saved or its cookie being
    sent.
  - A session without `gen` (from before generations existed) counts as 0.
  - The session named in `sess-keep:` is stamped with the new generation instead of being ended. A
    request of the signing device may have loaded its session before the sign-out, or written it
    back afterwards.
  - If the copy cannot be read, the request fails (fail closed). So do logged-in requests until the
    api has reconciled the copies with PostgreSQL once since it started (`SERVICE_UNAVAILABLE`);
    anonymous requests are unaffected.
- **Writing the copy:** after the commit, one script writes the copy and `sess-keep:` together,
  and only if the generation is greater than the stored one. Copies are never lowered, and an
  older sign-out arriving late cannot rename the kept session. The write is retried a few times.
- **Reconciler** (`GenerationReconciler`, started by the api): copies every generation committed
  since its last run. It runs at start (every 2 s until PostgreSQL and Valkey answer, e.g. while
  Valkey is still loading a snapshot) and then every 30 s:
  - the sequence is monotonic, so each run asks only for accounts above the last complete value
    (`users.sessionGenerationsSince`, partial index on `"sessionGeneration" > 0`). It reads them
    while holding the advisory lock shared, so no sign-out sits between drawing its value and its
    COMMIT, and every value up to the sequence's current one is complete;
  - Valkey records up to which value it holds every copy (`sess-gen-copied`, written after the
    copies). If that is behind — its data was lost or restored from an older snapshot — the next
    run copies from there again.
- **If the copy fails at sign-out time:** the answer says so (`delayed: true`;
  `signOutDelayed: true` for `setPassword`), and the web app shows "Other devices will be signed
  out within a minute." The reconciler copies it within one interval. Until then, sessions of the
  account from before the sign-out still pass the load check, but their device keys and transfer
  links are already invalid.

**Index.** Each account's logged-in sessions are also indexed, so the others can be ended right away
and counted:

- The index is a sorted set `sess-user:<userId>`, member = session id, score = when the session
  runs out in the store (`srv/util/userSessions.ts`).
- The store wrapper (`withUserSessionIndex`, together with `withSessionRevocation`) records a
  logged-in session on every write. On a touch it records only when the expiry moved by more than
  5 minutes.
- Recording drops expired entries and sets the key's expiry (`PEXPIREAT`).
- Logout and a login that replaces a logged-in session drop the old id. Ids whose session is gone
  are dropped when the index is read.
- Index writes are best effort: a write the Valkey instance refuses is logged, and the session
  write still succeeds.

Bots never have sessions.

`changeAndSignOut()` / `signOutOtherDevices()` (`srv/util/signOutOtherDevices.ts`). After the commit,
it does the following, all best effort (none of it is needed for the device keys and links to be
invalid):

1. copies the new generation to Valkey and names this session in `sess-keep:` (failing that, the
   reconciler does it, and the answer says `delayed`);
2. stamps this session with the new generation;
3. ends the other indexed sessions below it through the store's `destroy`. Each id is revoked first,
   so a request still running with one of them neither writes it back nor sends its cookie again
   ([above](#when-a-session-exists));
4. deletes the old device keys (`deviceHelper.deleteStaleDevices`, like a logout of each: push
   subscription dropped). The deleted devices get the socket event `cliSignedOut`, and then their
   sockets are disconnected (`eventHelper.signOutDeviceSockets`, through the Redis emitter, in this
   order);
5. deletes the old unused transfer links (`transferTokenHelper.deleteStale`).

The current session and device stay as they are (the step-up state included). The result is the
number of other devices signed out: the deleted device keys plus the devices of the ended sessions
(a key whose browser has long lost it counts as well).

It runs:

- on request: `POST /User/signOutOtherDevices` (step-up, [§7](#step-up-for-sensitive-actions)) →
  `{ devices, delayed }`;
- with every change that takes a way in away from the account. These are the changes that need the
  plain step-up because they remove or replace something:
  - replacing the password (`setPassword` when the account has one; the answer carries
    `signedOutDevices` and `signOutDelayed`);
  - replacing the verified email address (`verifyEmail`; without mail, `updateOwnData` replacing or
    removing the address);
  - removing a passkey (`Passkey/remove`);
  - deleting a sign-in wallet or switching its sign-in off (`deleteWallet`, `updateWallet`);
  - removing an X/LUKSO/Farcaster account (`removeUserAccount`);
  - linking a different X/LUKSO/Farcaster account than the one of that type already linked
    (`addUserAccount` replaces it; plain step-up then).

  The repository functions behind these changes take the sign-out as a step to run before their
  COMMIT (`beforeCommit`).

Two sign-outs of one account at the same time: the second waits for the first. Its session was
signed out by the first one, so it is refused. Generations only grow.

Adding a way in (a first password, a passkey, a sign-in wallet, an X/LUKSO/Farcaster account, a
first verified address) signs nobody out:

- the sessions that exist are as legitimate as before;
- the verified address gets a notice ([§7](#step-up-for-sensitive-actions));
- someone who wants the other devices out uses the explicit action.

This also keeps the transfer flow intact. Completing the account-security step in a transfer
session adds methods and leaves the account's other sessions and device keys alone, including those
of the gateway, which shares the `devices` table ([§11](#11-transfer-links-and-the-account-security-step)).
A password below the policy is replaced there, which signs the other devices out like any replaced
password.

The notices to the verified address say so when other devices were signed out: the password notice
after a replaced password, the email-change notice to the previous address.

### Cookie scoping

The session cookie is **host-only** on every process, a legacy CG ID gateway included
(`srv/util/sessionSetup.ts`): it is sent to the instance's own host and to no other host under the
domain. The CG ID app (`id.<domain>`, [§7](#legacy-cg-id-gateway-only)) needs no shared scope: it
calls the api only on the app's own host (`APP_URL`, `src/data/util/urls.ts`) with credentials, a
same-site request that carries that host's cookie. A gateway's cookie never reaches the main
instance's host (`cg.box`), and it would be worthless there anyway: the gateway signs with its own
secret and keeps its sessions under its own key prefix ([§12](#12-gateway-mode)).

### Middleware order

`srv/util/express.ts` wires the middleware chain (`createSessionMiddlewares()` in
`srv/util/sessionSetup.ts`). The origin check, CORS and — on a gateway — its allowlist come first,
so a refused request never reads or creates a session. Then bot-token authentication; if a request
is authenticated as a bot, the session / passport middlewares are skipped entirely:

```
originGuard                      # 403 for a request whose Origin is not on the list (CORS below)
  → cors
  → gatewayApiGuard              # gateway mode only: 404 for every route off its allowlist (§12)
  → botAuthenticationMiddleware  # sets request.botPrincipal if a valid Bearer token is present
  → logged-in cookie hook (skipped if botPrincipal; registered before the session so it runs
                                   after express-session's own Set-Cookie decision)
  → session (skipped if botPrincipal)
  → revocation guard (skipped if botPrincipal; §2 "When a session exists")
  → session-generation guard (skipped if botPrincipal; §2 "Signing out other devices")
  → passport.initialize (skipped if botPrincipal)
  → passport.session (skipped if botPrincipal)
  → old-scope cookie cleanup (skipped if botPrincipal, see §7; writes nothing to the session)
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
| `createdAt` | When the login session was created (`establishLoginSession`). Nothing reads it. |
| `gen` | The session generation the login took when it started (`beginLogin` → `establishLoginSession`); a lower one than the account's ends the session ([§2](#signing-out-other-devices)). |
| `passport` / `twitter` | Twitter OAuth data (via Passport.js). |
| `lukso` | Prepared LUKSO Universal Profile login/creation data. |
| `farcaster` | Prepared Farcaster login/creation data (FID, address, profile). |
| `preparedCredential` | Prepared wallet credential incl. the time of the signature check (see [§5](#5-login-methods)). |
| `webauthnChallenges` | WebAuthn ceremonies in flight, keyed by challenge ([§7](#ceremony-state)). |
| `pendingPasskey` | A passkey registered during sign-up, waiting for `createUser` ([§7](#sign-up-with-a-passkey)). |
| `signupEmail` | Sign-up address verification: hashed code bound to the address, expiry, attempts, then `verifiedAt` ([§6](#6-signup-flow--captcha)). |
| `legacyDomainCookieCleared` | Set at login: an obsolete subdomain-scoped session cookie has been expired ([§7](#session-cookie-on-upgraded-instances)). |
| `securityStepClearFor` | The session user's account was found complete for the account-security step ([§11](#11-transfer-links-and-the-account-security-step)); a new login starts without it. |
| `passkeyData` | Legacy CG ID mode only: `{ step: 'success', passkeyId, userId }` left by `CgId/verifyAuthenticationResponse`. |
| `temporaryArticleIds` | Unrelated to auth (draft article ownership). |

Every login (all `User/login` branches, `createUser` and transfer-link redemption) ends in
`establishLoginSession()` (`srv/util/authSession.ts`). Whenever the session gains a principal or
authority — anonymous → user, user A → user B, and every interactive login (it refreshes the
step-up time) — it does `session.regenerate()` (a session id known before the login is worthless
afterwards: no session fixation, and all pre-login state is dropped), sets `user`, records
`authAt`/`authMethod` and awaits `session.save()`. An interactive re-login of the **same** user keeps
the in-flight linking state (`passport`, `twitter`, `lukso`, `farcaster`, `preparedCredential`).

A **device-key login of the user the session already belongs to** — the automatic re-login on every
page load, also the one that ends the X OAuth redirect — gains nothing and keeps the session as it
is: same id, same linking state, and `authAt`/`authMethod` untouched (a silent login never extends
step-up freshness); only its challenge (`signSecret`) is used up. Regenerating here would destroy
the id the page's other requests are still sending, so they would run anonymously
(`LOGIN_REQUIRED`) until the new cookie arrived. The X OAuth callback
(`/twitter-callback`) passes `keepSessionInfo: true`, so passport's own session regeneration keeps
the logged-in user. TODO(verify): X linking end to end on the test VM.

### CORS

The api and the wsapi share **one** origin list (`allowedOrigins()`, `srv/util/origins.ts`), derived
from the environment: the `BASE_URL` origin; in dev also a set of `localhost` / `app.cg.local` /
`bs-local.com` origins (and `LOCAL_CERTIFICATE_IP`); on a legacy CG ID process outside dev also the
`CGID_URL` origin (the CG ID app calls the api from its own origin).

- **api** — a request whose `Origin` header is not on the list (`null` included) is answered with
  `403 {status:'ERROR', error:'NOT_ALLOWED'}` before anything else runs, preflights included
  (`originGuard`) — except one-click unsubscribe (`/User/emailUnsubscribe`, `ORIGIN_FREE_ROUTES`):
  mail providers send its RFC 8058 POST from their servers or their web mail's pages, and the signed
  token alone authorizes it. Listed origins get CORS headers with credentials; allowed request headers are
  `Accept`, `Content-Type`, `Authorization` and `X-Cg-Socket-Id` (`CORS_ALLOWED_HEADERS`). A request
  without an `Origin` passes without CORS headers: browsers omit it on same-origin GETs, and the SDK,
  bots and curl send none; the session cookie (`SameSite=Lax`) never comes along on another site's
  requests anyway.
- **wsapi** (`srv/util/socketServer.ts`) — every Socket.IO request is checked: the handshake by
  `allowRequest`, and every engine request (later polling requests and the WebSocket upgrade of an
  existing session, which `allowRequest` does not see) by an engine middleware. An `Origin` that is
  present must be on the list (browsers always send one on a WebSocket and on cross-origin requests).
  Requests without one pass: the web app's same-origin polling GETs and non-browser clients — bots
  with their token, the SDK with its session cookie (`sdk/client/src/realtime/socket.ts`). A refusal
  ends the request with HTTP 400 (403 from `allowRequest`).

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
(`deviceHelper.deleteDevice`, `User/logout` in `srv/api/user.ts`) and, for every device but the
current one, when the account signs out its other devices
([§2](#signing-out-other-devices)). If the server reports the device as `NOT_FOUND` during
auto-login, the client treats itself as signed out from elsewhere, clears local state and says so
(`signedOutElsewhere`, `src/data/appstate/login.ts`, [§10](#10-frontend-login-state-machine)).

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
(`srv/api/user.ts`), which generates a 20-char random string
(`SIGNABLE_SECRET_LENGTH`), stores it as `session.signSecret`, and returns it. A given challenge is
consumed on use (`signSecret` is deleted after login). A call that starts a session (the request
had none with data) counts against a limit per client network ([Limits](#limits)); a page load with
a live session reuses it and is not counted.

`POST /User/checkLoginStatus` returns `{ userId | null }` for the current session,
`POST /User/ensureSession` is the keepalive: it stores nothing and creates no session, in every
mode (the response itself refreshes an existing session's store TTL and re-sends a logged-in
session's cookie).
`POST /User/logout` deletes the device, destroys the session (`endLoginSession()`; the old id is
dead and leaves the user's session index) and expires the cookie; no new session takes its place.
Logout disconnects the device's sockets: when the request names its tab's socket
(`x-cg-socket-id`), the device's other sockets (its other tabs) get `cliSignedOut` and are
disconnected, and the requesting tab's socket logs out itself; requests without the header
(older clients) disconnect all of the device's sockets without `cliSignedOut`
([docs/realtime](../realtime/README.md#socket-scoped-targeting)). A tab ignores `cliSignedOut`
while its own logout is in flight (`LoginManager.signedOutElsewhere`), so a logout whose socket the
server could not tell apart shows no "signed out" notice.
`POST /User/signOutOtherDevices` (step-up) ends every other session and device key of the account
and answers `{ devices, delayed }`, the number of other devices signed out
([§2](#signing-out-other-devices)).

Every login response also carries `securityStepRequired`: whether the account has to finish the
account-security step before anything else works ([§11](#11-transfer-links-and-the-account-security-step)),
and `stepUpValidUntil`: until when the session's last interactive authentication counts for
sensitive actions (null if it does not) — also after a silent device re-login that kept the session.
`POST /User/clearLoginSession` clears the in-flight provider state (`lukso`, `farcaster`, `twitter`,
`passport`) without logging the user out.

### Limits

Decision 21 of the cg.box roadmap: sign-up and login never lock out a person who mistypes, retries
or shares a network with many others (offices, universities, mobile carriers); limits only stop
volumes that look like abuse, and every refusal says how long to wait. All numbers live in
`srv/util/authLimits.ts`; "per IP" means per IPv4 address or IPv6 /64, with three and six times
the value per IPv6 /56 and /48 (`ipRateLimitHandler`, `srv/util/rateLimit.ts`). Sliding windows in
Valkey. The limits of one request (the hour and the day of the account limit, the IPv6 prefixes,
a client and a target address) are counted together (`enforceLimits`): if one refuses, the hits in
the others are taken back, so a refused request counts nowhere and waiting never takes longer
than the wait announced.
Off on a dev stack (`DEPLOYMENT=dev`): account creation and the login throttles.

| What | Key | Limit |
|------|-----|-------|
| Accounts created (`createUser`; the sign-up code request checks it first without counting) | per IP | 20 per hour and 50 per day |
| Sign-up passkey ceremonies while logged out (`Passkey/registrationOptions` + `verifyRegistration`) | per IP | 60 per hour |
| Passkey login options (`Passkey/authenticationOptions {purpose:'login'}`, every view of the login form) | per IP | 300 per hour |
| Password login attempts | per IP | 60 per 15 minutes |
| Failed password logins | per identifier as typed + network (IPv4 /24, IPv6 /56) | 10 per 15 minutes |
| Failed password logins | per identifier, all networks | 100 per hour |
| Email-code login attempts | per IP | 60 per 15 minutes |
| Failed email-code logins | per address + network / all networks | 10 / 30 per hour |
| Guesses per code (sign-up, login, confirmation) | per issued code | 5 (then a new code is needed) |
| Login code mails (`sendOneTimePasswordForLogin`) | per IP / per address | 30 per hour / 1 per minute and 10 per hour |
| Sign-up code mails (`requestSignupEmailCode`) | per IP / per address | 40 per hour / 1 per minute and 5 per hour |
| Confirmation mails (`requestEmailVerification`, signed in) | per IP / address / account | 30 / 5 / 5 per hour |
| Re-authentication (`reauthenticate`) | per IP / per account | 30 / 10 per 15 minutes |
| Captcha for trust score (`verifyCaptcha`, signed in) | per IP | 3 per day |
| Transfer links | per user / per IP / failures per IP | 10 per hour / 120 / 20 per 15 minutes |
| `isEmailAvailable` (instances without mail only) | per IP | 60 per hour |
| Device-login and SIWE challenges that start a session (`getSignableSecret` without a session) | per IP | 600 per hour |
| Signed challenges checked (`prepareWalletAction`, `Lukso/PrepareLuksoAction`, `Accounts/Farcaster/verifyLogin`) | per IP, each | 300 per hour |
| X sign-in redirects (`Twitter/startLogin`) | per IP | 120 per hour |

Changed on 2026-11-01 (G10): accounts per network from 2 per day (a single office or mobile-carrier
address could block every further sign-up for a day) to 20 per hour and 50 per day; the sign-up
code mails per IP from 10 to 40 per hour and the sign-up passkey ceremonies from 20 to 60 per hour,
so they never cap sign-ups below the account limit; login code and confirmation mails per IP from
10 to 30 per hour (shared networks); passkey login options from 120 to 300 per hour (every login
page view fetches them for autofill); `isEmailAvailable` from 30 to 60 per hour; failed email-code
logins per address from 30 per day (per network) and 200 per day (overall) to 10 and 30 per hour,
so a person who mistyped is not locked out until the next day, together with codes of 8 instead of
6 digits (a hundred times more codes to guess). The other guessing budgets are unchanged; the
sign-up and confirmation codes have no per-address budget beyond their 5 guesses per code.

Added on 2026-11-01 (G12): every endpoint that stores something for a visitor without a session has
a limit per client network now — the three `preLogin` rows above (the WebAuthn options and the
sign-up code requests had theirs already). A page load makes one device-login challenge, and only
one that starts a session counts, so the challenge limit is far above what a shared network uses.
These limits also apply on a dev stack.

**Limit errors.** A refusal is `RATE_LIMIT_EXCEEDED` with the seconds until the limit lets the next
attempt through, in the envelope and as the standard header:

```
HTTP/1.1 200 OK
Retry-After: 240

{ "status": "ERROR", "error": "RATE_LIMIT_EXCEEDED", "retryAfterSeconds": 240, "limit": "accounts" }
```

`limit` says what was limited, so the client can word its message: `accounts` (accounts per
network), `mail` (code and confirmation mails, per network or per address) or `attempts`
(everything else). It depends only on which IP- or address-keyed limiter refused, never on
whether an account exists.

The HTTP status stays 200 like every RPC error. The server throws `RateLimitError`
(`srv/util/rateLimitError.ts`; its message is the plain code, so existing checks keep working) and
`handleError` (`srv/api/util.ts`) writes both. The wait is the time until enough of the oldest hits
have left the window (the longest one when several limits refused, with that limit's kind).
`API.AjaxResponse` carries the optional `retryAfterSeconds` and `limit`; the web app's
`BaseApiConnector` throws an `ApiRequestError` (`src/data/api/apiError.ts`, message = code, plus
both fields), the SDK's `ApiError` has the same fields (`sdk/client/src/transport/errors.ts`). The per-code guess budget answers without a
wait: the remedy is a new code. The web app's messages are described in
[frontend §10](../frontend/README.md#limits-and-input-checks).

**Testing the messages.** `CG_TEST_AUTH_LIMITS` (JSON, e.g. `{"createUser.hour": 1}`) lowers single
limits at startup — it can never raise one; unknown names stop the process. The disposable e2e
instance passes `E2E_AUTH_LIMITS` through to it (`e2e/docker-compose.e2e.yml`).


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
   deleted) vs `readyForCreation`, and stores the result as `session.preparedCredential` (with the
   signed address, its type and the time of the check).
3. `POST /User/login` with `type: "wallet"` reads `preparedCredential` (and uses it up), requires
   `readyForLogin && ownerId`, a signature at most 5 minutes old, and that the wallet is a live,
   login-enabled wallet of that owner right now (`walletHelper.isSignInWallet`) — a wallet removed
   or switched off after the signature signs in no one —, then creates a device and logs in.
   `User/reauthenticate {type:'wallet'}` applies the same check. The LUKSO, Farcaster and X logins
   resolve the account from the linked provider id at login time (`getUserByAccount`), so an
   unlinked account signs in no one there either.

The SIWE message is built client-side in `src/util/siwe.ts` (host, `URI`, `Version`, `Chain ID`,
`Nonce: <signSecret>`, `Issued At`). The server checks that the message was made for this
instance: its first line must name the host and its `URI` the origin of the instance's web app
(`BASE_URL`; in dev also the local dev origins, `srv/util/origins.ts`;
`assertSiweForThisInstance`, `srv/repositories/wallets.ts`). A message for another site does not
fail the request: `prepareWalletAction` answers `walletValid: false` (nothing ready for login or
creation), like any other signature that does not check out. The challenge
(`getSignableSecret`) comes from a CSPRNG. Farcaster's SIWE messages are not checked this way yet.

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

Client posts `{ aliasOrEmail, password, device: { publicKey } }`. The server

1. throttles: 60 attempts per 15 minutes per client IP (IPv4 address / IPv6 /64; generous because
   many users can share an address), and **failed** attempts per identifier — 10 per 15 minutes
   from the client's network (IPv4 /24, IPv6 /56), so a third party elsewhere cannot lock the user
   out, and 100 per hour from all networks against distributed guessing. The budgets are keyed by
   the identifier as typed (normalized), not by the account it names, so reaching a limit never
   shows that a username and an address belong to the same account. Each attempt reserves its
   failure slot atomically before the password is checked and gives it back on success
   (`failureBudget` / `reserveFailures`, `srv/util/rateLimit.ts`), so parallel attempts cannot
   overrun a budget and a successful login never uses it up. All numbers:
   `srv/util/authLimits.ts` ([§4 "Limits"](#limits)); a refusal carries the wait;
2. checks the password (`checkPasswordLogin`; an unknown account is compared against a throwaway
   hash, same answer `NOT_ALLOWED`; a failed check against an older, cheaper hash also runs a
   cost-12 check, so there is no practical timing difference);
3. on success replaces a hash of a lower bcrypt cost than 12 with one of cost 12, and — if the
   password does not meet the policy — sets `users.passwordChangeRequired`
   ([§11](#11-transfer-links-and-the-account-security-step)); then creates a device.

The throttles are off on a dev stack (`DEPLOYMENT=dev`), like the sign-up limit.

**Password policy** (`src/common/passwordPolicy.ts`, Joi `common.Password`): at least 8 characters,
nothing else — no composition rules, no blocklist. It applies to new passwords
(`createUser {useEmailAndPassword}`, where the password is required, and `setPassword`); a
password typed to sign in or re-authenticate (`common.PasswordAttempt`) may be older and shorter.
The web app shows the same rule.

Passwords are set/changed via `POST /User/setPassword`: replacing one requires a recent
authentication (step-up, [§7](#step-up-for-sensitive-actions)) and signs the account out on every
other device ([§2](#signing-out-other-devices)); a first password adds a sign-in method
(`requireAuthToAdd`) and signs nobody out. The answer is `{ signedOutDevices }` (0 for a first
password). Setting one clears `passwordChangeRequired`; the verified address gets a notice, which
says when the other devices were signed out.

### 5.5 Email Verification Code / One-Time Password (`type: "verificationCode"`)

Passwordless email login:

1. `POST /User/sendOneTimePasswordForLogin` (`srv/api/user.ts`): only allowed when logged
   out and when email is enabled (`emailEnabled()` in `srv/api/emails.ts` requires a valid SMTP
   configuration, `SMTP_HOST` set — see [docs/email-notifications](../email-notifications/README.md));
   otherwise it throws `EMAIL_DISABLED`. Send limits apply first — 30 per hour per client IP
   (IPv4 address / IPv6 /64) and, per target address, one per minute and 10 per hour,
   `RATE_LIMIT_EXCEEDED` with the wait beyond
   (`srv/util/mailSendLimits.ts`, see [docs/email-notifications](../email-notifications/README.md#send-limits)).
   Only if the address is the **verified** address of an account (case-insensitive) is an 8-digit
   login code (CSPRNG, 15 minutes, `srv/util/emailCodes.ts`) stored as a hash bound to the account
   and the address and mailed; for an unconfirmed or unknown address nothing is sent. The answer
   is the same in every case, and the mail is sent after the response. Someone whose address was
   never confirmed signs in another way and asks for the confirmation again while signed in
   ([§8](#email-verification)); there is deliberately no logged-out "confirm this address", which
   would let the address's owner confirm it for someone else's account. The login form says so
   next to the uniform answer.
2. `POST /User/login` with `{ type: "verificationCode", email, code, device }` (60 attempts per 15
   minutes per client IP; five guesses per code; failed guesses per address — 10 an hour from the
   client's network, 30 an hour from all networks, reserved atomically like the password budgets)
   checks the code against the address, deletes it in the same step (single use), and creates a
   device. A wrong code, an unknown or unconfirmed address, an expired code and a code whose five
   guesses are used up (it is deleted) all answer `VERIFY_EMAIL_INVALID_TOKEN`, so the answer
   never tells whether a code was sent. An email-verification code is never accepted here.

### 5.6 Twitter OAuth (`type: "twitter"`)

OAuth 1.0a via Passport.js (`passport-twitter`, `srv/api/twitter.ts`). The strategy is only
registered when `TWITTER_API_KEY`/`TWITTER_API_SECRET` are configured (`srv/api/twitter.ts:23-31`).

1. `GET /Twitter/startLogin` kicks off `passport.authenticate("twitter")` (limited per IP; a
   refusal redirects the popup to `/twitter-login?error=rate-limited&retryAfter=<s>`, which says how
   long to wait).
2. The provider redirects to `GET /twitter-callback` (`srv/api/getRoutes.ts:751-755`), which stores
   the Twitter profile in `session.passport`.
3. `POST /Twitter/finishLogin` (`srv/api/twitter.ts:46-67`) returns the pending profile
   (username, image, description, homepage) for the UI.
4. `POST /User/login` with `type: "twitter"` reads `session.passport.user._json.id_str` and resolves
   the user via `getUserByAccount("twitter", id)` (`srv/api/user.ts:222-228`).

### 5.7 LUKSO Universal Profile (`type: "lukso"`)

1. `POST /Lukso/PrepareLuksoAction` (`srv/api/luksoUniversalProfile.ts`): the client submits the
   Universal Profile address, a signature and the signed message. The message must be a Sign-In with
   Ethereum message made for this instance, checked like a wallet or Farcaster sign-in message
   (`assertLuksoSignInMessage`, `srv/util/luksoSignIn.ts`): parsed by its structure
   (`parseSiweMessage`), its domain line and `URI` name this instance's web app
   (`assertSiweForThisInstance`), its address is the profile's, `Version` is 1, `Chain ID` is 42
   (LUKSO mainnet, the chain the signature is checked on), its `Nonce` equals `session.signSecret`
   (single use), its `Issued At` lies within 15 minutes of the server's clock either way (room for
   client clocks that are off), and it is not expired. The endpoint then verifies the
   signature on-chain via `onchainHelper.luksoIsValidSignature()` (ERC-1271 / LSP0), uses the nonce
   up (`signSecret` is deleted), fetches the Universal Profile data, and stores `session.lukso` with
   `readyForLogin` / `readyForCreation` and the time of the check (`preparedAt`). The web app builds
   the message with `src/util/siwe.ts` from `window.location.host` and the page origin
   (`src/context/UniversalProfileProvider.tsx`), so it names whichever instance it runs on — the
   gateway's domain on a gateway (§12).
2. `POST /User/login` with `type: "lukso"` requires a prepared sign-in at most 10 minutes old,
   checks again that the stored message names this instance and the profile, re-checks the on-chain
   signature, then resolves the user via `getUserByAccount("lukso", address)` (`srv/api/user.ts`).
   `User/addUserAccount` (linking a profile) uses the same prepared, checked state.

### 5.8 Farcaster (`type: "farcaster"`)

SIWE-based (Sign In With Farcaster), verified against the on-chain Farcaster ID registry:

1. `POST /Accounts/Farcaster/verifyLogin` (`srv/api/accounts.ts`): parses the message by its
   structure (`parseSiweMessage`, `srv/util/siweMessage.ts` — every field by its label in the order
   EIP-4361 defines, so optional fields cannot shift another one into place; the wallet sign-in uses
   the same parser) and verifies the signature (`walletHelper.parseAndVerifySiweData`: version 1,
   signer = the message's address, not expired, not before its `Not Before`); requires `issuedAt`
   within 60 s of now and the SIWE `nonce` to equal `session.signSecret`; checks the message was made
   for this instance like a wallet sign-in message (`assertSiweForThisInstance`: its domain is the
   host of this instance's web app and its URI is on that origin — the web app sends
   `window.location.host` and the page URL); takes the FID from the one `farcaster://fid/<fid>`
   resource (`farcasterIdOf`; none, two or a malformed one are refused) and confirms ownership by
   comparing against the on-chain ID-registry event for the signer address
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
| Email code | `verificationCode` | emailed 8-digit code, bound to the address | Yes | `users` / Valkey |
| Twitter | `twitter` | Passport OAuth session | Yes | `user_accounts` |
| LUKSO | `lukso` | SIWE for this instance + on-chain (ERC-1271) signature | Yes | `user_accounts` |
| Farcaster | `farcaster` | SIWE + on-chain FID registry | Yes | `user_accounts` |

---

## 6. Signup Flow & Captcha

Account creation is `POST /User/createUser` (`srv/api/user.ts`). It is only allowed when logged
out, and it must add at least one usable sign-in method (`loginMethodAdded`) or it throws.

**Email first.** On an instance that can send mail (`emailEnabled()`), the sign-up address is
verified *before* the account exists:

1. `POST /User/requestSignupEmailCode { email, recaptchaToken }` (logged out only;
   `EMAIL_DISABLED` without mail) first checks the **sign-up captcha** (`CAPTCHA_FAILED`; skipped
   in dev) — before any mail goes out; before that, the account limit of the client's network is
   checked without counting (`peekLimits`, the longer wait of hour and day), so nobody fills in a whole sign-up only to be refused at
   the end — then applies the send limits (40/h per client IP, per
   address one per minute and 5 per hour), stores a hash of an 8-digit code (CSPRNG, uniform over 00000000–99999999) bound to the
   address in `session.signupEmail` (valid 15 minutes) together with `captchaAt`, and mails the
   code. A resend to the same address in the same session within 2 hours needs no new token. If
   the address already belongs to an account, no code is sent; the address receives a notice
   instead, and the session state, the response and a later resend or code check behave the same
   as for a free address.
2. `POST /User/verifySignupEmailCode { email, code }` checks code and address (5 wrong attempts per
   code, counted atomically in Redis per issued code) and marks the address verified for one
   hour. A code that expired or whose guesses are spent is dropped, but the address and the solved
   captcha stay in the session, so a new code needs no new captcha; the state of a taken address
   (no code) answers the same way, also once expired.
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

Rate limiting: `createUser` is limited per client network (20 per hour and 50 per day per IPv4
address / IPv6 /64, outside dev; [§4 "Limits"](#limits)); `verifyCaptcha` to 3 per /64 per 24 h.

**Taken addresses.** On an instance that sends mail no endpoint tells whether an address has an
account: sign-up, address changes and the email login answer the same either way (the owner gets
a notice where it matters). `POST /User/isEmailAvailable` therefore only answers on an instance
without mail (or in legacy CG ID mode), IP rate-limited (60/h per /64); elsewhere it is
`NOT_SUPPORTED`.

**Anti-bot.** New accounts on an instance with mail need the captcha (checked before the code is
sent) and an address verified before the account exists; nothing further applies.

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
  (no passkeys listed). Both compose files pass `PASSKEY_RP_ID`, `CG_LEGACY_CGID` and `BASE_URL`
  (from which the RP ID is derived when `PASSKEY_RP_ID` is empty) to every backend process —
  `mediasoup` included, which checks the account-security step at its login ([§11](#11-transfer-links-and-the-account-security-step)).

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
`authMethod` is an interactive one (any login type except the device key, or `signup`; a
transfer-link session — `transfer` — never qualifies). Because nothing has changed when it fails,
the client can re-authenticate and retry the same request.

**Adding a way in** — a passkey (`registrationOptions` / `verifyRegistration` while logged in), a
sign-in wallet (`addPreparedWallet` with `loginEnabled`, `updateWallet` switching it on), a first
password (`setPassword` without one; written only while the account still has none, so of two
concurrent requests the second answers `REAUTH_REQUIRED` like a replacement), an
X/LUKSO/Farcaster account (`addUserAccount`), an address
while the account has none verified (`requestEmailVerification`) — goes through
`requireAuthToAdd()` (`srv/util/securityStep.ts`): while the account lacks exactly that (no
sign-in method here / no verified address — the account-security step, [§11](#11-transfer-links-and-the-account-security-step)),
it may have nothing to confirm "it's you" with, so a sign-in (or transfer link) within the last
60 minutes is enough (`SECURITY_STEP_AUTH_MAX_AGE_MS`, accepted methods `SECURITY_STEP_AUTH`); a
silent device-key session alone is not (`REAUTH_REQUIRED` — the user signs in again or gets a new
transfer link). Otherwise the plain step-up applies, exactly as for removing or replacing a method
or a verified address: a transfer-link session never satisfies it, so for a complete account a
transfer-link session is an ordinary sign-in and adds a method only after `User/reauthenticate`.
Whether the account lacks it is computed from the database at the time of the request
(`computeSecurityStatus`, with the api's mail setting) — not from the session's cached
`securityStepClearFor`, the realtime record in Valkey or anything the client sends.

Protected: `User/setPassword` replacing a password; a new address via
`User/requestEmailVerification` replacing a verified one (and, on an instance without mail, an
`email` change via `User/updateOwnData` — only when the address actually changes, re-sending the
current address with other settings is ignored);
`User/addUserAccount` and `User/removeUserAccount` of an account that can sign in (X, LUKSO,
Farcaster);
`User/addPreparedWallet` with `loginEnabled`; `User/updateWallet` when it changes `loginEnabled`;
`User/deleteWallet` of a login-enabled wallet; adding (`registrationOptions` /
`verifyRegistration` while logged in) and removing a passkey; signing out the other devices
(`User/signOutOtherDevices` — otherwise whoever holds a session alone could sign the owner out
everywhere else); the bot owner's `Bot/tokens/issue` and `Bot/disable`. Routine moderation
(including `Bot/remove`, which removes a bot from a community) is not protected.

Every protected change that removes or replaces a way in also signs the account out on its other
devices once it is done; adding one does not ([§2](#signing-out-other-devices)).

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
at most 5 minutes old, the wallet checked again as at login). It sets `authAt`/`authMethod` and returns `{ validUntil }`.

**Client.** `BaseApiConnector` answers `REAUTH_REQUIRED` by opening the "Confirm it's you to
{action}" dialog (`ReauthDialog`: of the account's own methods a passkey of this site first,
then the password, then a sign-in wallet — `reauthMethods`; whether the account has a password it
learns from `User/getSecurityStatus`; a passkey or wallet shows at once, the password form only
once the account is known to have one, or after a failed lookup) and retries
the same request once after `User/reauthenticate`; a cancelled dialog surfaces as
`REAUTH_REQUIRED` and is not shown as an error. The same dialog serves a session from a transfer
link of a complete account; `redeemTransferLink` clears the client's freshness estimate, so the
settings screens ask before a ceremony there too. Screens that start a WebAuthn ceremony after the
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
`cliCgIdSignResponse` to the `cgIdRequest:<frontendRequestId>` room — the main window's socket
joins it with the `watchCgIdRequest` socket event before it opens the popup, so the result does not
depend on which session cookie the socket connected with — and, for clients from before that
event, to the `expressSession:<sid>` room; the popup also posts the result to its opener, which
accepts it only from the CG ID origin. The request id is 120 random bits (`crypto.getRandomValues`). Popup and
main window share the session: the popup calls the api on the app's host (`APP_URL`), so its
credentialed, same-site requests carry the app host's host-only cookie, and its first write (the
challenge) creates it if there is none. `/CgId/ensureSession` is a keepalive like
`User/ensureSession` and creates nothing. The main window then calls
`User/login {type:'passkey-success'}`, which is accepted only in this mode and within 5 minutes
(`passkeyData.expiresAt`). Only in this mode does
the API CORS list include the `CGID_URL` origin and does the instance config carry `cgidUrl`. The CG ID views (`src/cgid/*`) still call the registration
endpoints, which no backend serves any more.

Apart from the passkey surface, legacy mode keeps the **full previous sign-up and login surface**:
`createUser` with every selector (including X, LUKSO and Farcaster), no sign-up email verification,
the recovery-phrase wallet path, and all other routers. Restricting what a gateway process serves is
left entirely to the gateway's server-side allowlists ([§12](#12-gateway-mode)); legacy mode itself
does not restrict it. That is why, outside `DEPLOYMENT=dev`, an api or wsapi refuses to start with
`CG_LEGACY_CGID=true` unless it is a gateway (`CG_GATEWAY=true`; `validateGatewayConfig`,
`srv/util/gateway.ts`).

### Session cookie on upgraded instances

The session cookie is host-only. A browser may still hold the subdomain-scoped cookie
(`Domain=.<APP_HOSTNAME>`) of an instance that ran an older version — on a gateway, the cookie of
the old instance it replaces; the api (outside dev, legacy mode included) expires it in the
response to every request that carries a session cookie until a login marks the session
(`legacyDomainCookieCleared`, set by `establishLoginSession`). Without that, the browser would send
both cookies of the same name, the older one first, and the api would read the old one. The cleanup only adds a
header and never writes to the session, so it creates none. The session the old cookie pointed to
stays valid. Release note for in-place upgrades: users keep their sessions; nothing to do.

## 8. Account Linking (user_accounts & wallets)

A logged-in user can link, update, and unlink identity items without changing their root account.

### Profile / social accounts

`POST /User/addUserAccount` (for X, LUKSO and Farcaster: step-up, then a notice mail to the verified
address) adds a `twitter`, `lukso`, `farcaster`, or `cg` account to the current
user, reading the prepared provider state from the session (same state built by the prepare/verify
endpoints). `POST /User/updateUserAccount` edits the `cg` profile, and `POST /User/removeUserAccount`
removes an account of a given type (for X, LUKSO and Farcaster: step-up and the last-method check,
[§7](#step-up-for-sensitive-actions), then the other devices are signed out,
[§2](#signing-out-other-devices)). Because
`user_accounts` has a composite PK `(userId, type)`, a user holds at most one account per provider
type: linking a different X/LUKSO/Farcaster account than the one of that type already linked
replaces it — that takes the plain step-up (no transfer session) and signs the other devices out
like a removal; linking the same account again (a profile refresh) is an add.

### Wallets

| Endpoint | Purpose |
|----------|---------|
| `/User/prepareWalletAction` | Verify a wallet signature and stage a `preparedCredential` ([§5.2](#52-wallet-type-wallet--evm-only)). |
| `/User/addPreparedWallet` | Attach the prepared wallet to the current user, with `loginEnabled` / `visibility` flags (step-up when `loginEnabled`). |
| `/User/updateWallet` | Update wallet flags (step-up when `loginEnabled` changes; switching off the last sign-in method is refused; switching sign-in off signs the other devices out). |
| `/User/deleteWallet` | Soft-delete a wallet (step-up for a login-enabled wallet; the last sign-in method is refused; a deleted sign-in wallet signs the other devices out). |
| `/User/getWallets` | List the current user's wallets. Querying **other** users' wallets is disabled and returns `NOT_ALLOWED` (`srv/api/user.ts:1032-1040`). |

Each wallet mutation emits a `cliWalletEvent` to the owning user over the socket. A wallet is unique
per `(type, walletIdentifier)`; `loginEnabled` controls whether it can be used as a login method, and
`visibility` (`private`/`public`) controls exposure. Deleting a user sets `wallets.userId` to `NULL`
(`onDelete: 'SET NULL'`), so a wallet identifier is not permanently burned.

### Email verification

Independent of any social account, an address can be confirmed for the account:

- `POST /User/requestEmailVerification { email }` (logged in; mail required) mails an 8-digit code
  (24 hours) bound to the session's account and to that address (`srv/util/emailCodes.ts`). The
  current address is untouched. Replacing a verified address needs a step-up; setting one while
  none is verified adds a way in (`requireAuthToAdd`, [§7](#step-up-for-sensitive-actions)).
  An address another account has gets a notice instead of a code, with the same answer. Send
  limits: 30/h per client IP, 5/h per target address, 5/h per account
  ([docs/email-notifications](../email-notifications/README.md#send-limits)). "Another account
  has it" means: has it **verified**. An account that holds the address unverified does not block
  its owner — confirming the address removes it from that account in the same transaction
  (`setVerifiedEmail`), which is told by a `cliUserOwnData { email: null }` event. In both cases a
  code is pending afterwards and no mail is awaited, so the answer and its timing are the same.
- `POST /User/verifyEmail { email, token }` (logged in as that account; five wrong guesses per
  code; replacing a verified address needs a step-up here as well, before the code is used up)
  makes the address the account's verified address — this is how the address changes on an
  instance that sends mail; `updateOwnData` refuses a new `email` there with
  `EMAIL_VERIFICATION_REQUIRED`. `EXISTS_ALREADY` if another account took it meanwhile. A replaced
  verified address signs the account out on its other devices
  ([§2](#signing-out-other-devices)), and the previous address gets a notice that says so; a first
  verified address signs nobody out. A `cliUserOwnData { email, emailVerified: true }` event
  follows.
- The mail also links to `/verify-email?email=…&token=<code>`, which does the same while signed in
  to that account.
- **Sending the confirmation again** (the mail got lost): `requestEmailVerification` with the
  account's own unconfirmed address needs no step-up and replaces the previous code; the send
  limits apply. The web app offers it with a countdown in the settings, in the account-security
  step and in the newsletter prompt — only for the signed-in account.

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

- **Current user** is cached in `localStorage` under `CG_CURRENT_USER` (`{ userId, deviceId }`).
  Every tab keeps its own login state; logins and logouts reach the other tabs as
  `BroadcastChannel('cg:auth')` notices (`src/data/appstate/authBroadcast.ts`), with the `storage`
  event on `CG_CURRENT_USER` (and a re-check when a tab becomes visible) as fallback.
- **Auto-login** (`autoLogin`, `src/data/appstate/login.ts`): if offline, it optimistically
  trusts the cached user; otherwise it reconstructs the current user from IndexedDB device keypairs +
  local `OwnData`, then performs a `device` login. The deprecated stored-mnemonic fallback runs only
  on a legacy CG ID instance; elsewhere a stored phrase is deleted.
- **Step-up freshness**: an interactive login and `createUser` mark the session as freshly
  authenticated for the client's `stepUpManager` (`src/data/auth/stepUp.ts`); a `device` login takes
  `stepUpValidUntil` from its response (the session's earlier sign-in, e.g. right after a reload) or
  clears it; `logout()` and a logout in another tab clear it. It is only an estimate used to confirm before a WebAuthn ceremony — the
  server's `REAUTH_REQUIRED` stays authoritative.
- **Multi-tab coordination**: every tab runs its own `device` login once per page load (on its
  first socket connect; a socket reconnect logs only the socket in). All HTTP logins (`device`,
  interactive, `createUser`, transfer links) run one at a time across the tabs of a browser under
  the Web Lock `cg:login`, because an anonymous → user login regenerates the session id
  ([§2](#when-a-session-exists)) and the tabs share its cookie; a `device` login of the same user
  keeps the session. A device login holds the lock for `User/getSignableSecret`, the signature and
  `User/login` together: the session keeps one signable secret, which a concurrent login in another
  tab would replace. A tab that had to wait for the lock and then finds the session logged in as
  the stored user takes it over instead of logging in again. A tab waits at most 15 s for the lock
  (a frozen tab keeps its locks). After 10 s a slow request releases the lock for the other tabs,
  but its tab keeps waiting for it and starts no further step without the lock (it queues again
  once). An `INVALID_SECRET` (a late secret request of another tab replaced the secret) is retried
  once under the lock with a fresh secret. Inside the lock a tab compares the stored current user
  with the device it is about to log in and follows the stored user if they differ (no login over
  another user's new session). A page device login that fails with anything but `NOT_FOUND` is
  retried with a backoff (5/15/60 s, ±50 %) and on the next visibility/online check (never sooner than 5 s after the failure); `User/logout` also runs under the lock.
  After its socket was live again following a gap, a visible tab re-runs the device `User/login`
  for its snapshot (debounced, under the lock; no login-state change). On another tab's logout a tab drops its own login (socket `logout`, in-memory state)
  without a second `User/logout`; on another tab's login an anonymous tab checks
  `User/checkLoginStatus` and takes the session over without an HTTP login (else it logs in with its
  device key); a login of another user is handled as a logout first. For one release a logout also
  posts `'anonymous'` on the legacy `CG_LOGIN_STATE` channel for older pages still open.
- **`loginRequiredErrorHandler`** (a request answered `LOGIN_REQUIRED`, any tab): under the login
  lock it re-checks `User/checkLoginStatus`; only if the session is not this tab's user any more it
  runs `autoLogin()`.
- **`checkLoginStatus`** (on becoming visible or online, logged-in tabs): a session without a user
  gets the silent re-login above; a session of another user is never logged out from here — the tab
  follows the stored current user (another tab's login).
- **Keepalive**: `WebSocketManager` calls `POST /User/ensureSession` every 29 minutes (it creates
  no session, [§4](#4-the-login-endpoint)); there is no call on start — the socket needs no session
  cookie. It also keeps a session without a user alive while the tab is open (its store TTL is an
  hour, [§2](#when-a-session-exists)), even when one keepalive is late.
- **Signed out from elsewhere**: the socket event `cliSignedOut` (another device signed this one
  out, or the account's password, email or sign-in methods changed there,
  [§2](#signing-out-other-devices)) or a `NOT_FOUND` for the device at the automatic login makes
  `LoginManager.signedOutElsewhere()` sign out locally (`logout()`: local databases, device key,
  current user) and raise `signedOutNotice` (`src/data/auth/signedOut.ts`); `SignedOutNotice`
  shows "You were signed out" with "Sign in" / "Not now". Every tab gets `cliSignedOut`; its
  socket drops the device at once (it reconnects anonymously, never with the revoked key), and it
  re-checks for 1 s and decides under the login lock, so normally one tab calls `User/logout`
  and the others follow it (all show the notice; a second `User/logout` is harmless). Signing
  in again, also in another tab, dismisses the notice. A logout in another tab of the same browser (which
  deletes this device's key too, and whose `cliSignedOut` reaches the other tabs before that tab
  is done) shows no notice: the logging-out tab writes `CG_LOGOUT_IN_PROGRESS` before its
  `User/logout`, and a tab that sees it, the changed stored current user or the broadcast follows
  that logout.
- **Post-login setup** (`setupAfterLogin`): seeds the local Dexie databases (user, communities,
  chats), hands the notification count to the in-memory chat stores (`setupChatAfterLogin`), starts the socket login (not awaited: the transport reports when the tab is live),
  and registers the push subscription.

**Account-security step and transfer links (client).** Login responses set
`securityStepState` (`src/data/auth/securityStep.ts`) from `securityStepRequired`, and
`BaseApiConnector` sets it on any `SECURITY_STEP_REQUIRED`; while it is set, `RoutedContent` shows
`SecurityStepView` on every route, and `setupAfterLogin` skips the socket login and the push
subscription. `loginManager.redeemTransferLink(token)` signs in with a transfer link like an
interactive login (new device key), without a step-up freshness. Details: [§11](#11-transfer-links-and-the-account-security-step),
[frontend §10](../frontend/README.md#10-authentication-ui).

The `login()` method maps UI choices to the `POST /User/login` `type` values described in
[§5](#5-login-methods) (`_login` in `src/data/appstate/login.ts`; `{account:'passkey',
authenticationResponse}` → `passkey`, `{account:'passkey-legacy'}` → `passkey-success`), generating a
fresh device keypair for every non-device method and persisting it after the server confirms the
login. The login and sign-up UI is `AuthFlow`, in the onboarding modal and on `/login`
([frontend §10](../frontend/README.md#10-authentication-ui)).

---

## 11. Transfer Links and the Account-Security Step

Built for the move of the hosted instance (app.cg → cg.box): the old domain runs a sign-in-only
gateway on the same database, which hands its users a one-time link to the new instance; there
they set up a way to sign in that works on the new origin before they continue. Both parts are
generic.

### Transfer links

`srv/util/transferLink.ts`, `srv/repositories/transferTokens.ts`, table `transfer_tokens`
([database](../database/README.md#transfer_tokens)).

- **Minting** — `POST /User/createTransferLink { nextPath? }` (logged in; 10 per hour per user)
  mints a token for the session's own user only; there is no user id parameter. It is on only where
  `TRANSFER_TARGET_URL` names the instance the links lead to (an `https` origin; `NOT_SUPPORTED`
  otherwise; a malformed value stops the api at startup). The answer is
  `{ url: "<target>/transfer#<token>", expiresAt }`. `nextPath` is kept only if it is a same-site
  path on the target (`safeNextPath`, `src/common/safeNextPath.ts`, shared with the web app): a
  plain absolute path that resolves to the target's origin, checked before and after normalisation,
  so dot segments that collapse into a leading `//` (`/.//host`, `/%2e//host`) are refused too.
- **Token** — 32 random bytes, base64url (43 characters), valid 10 minutes. Only its SHA-256 is
  stored, with the user id and the path. It travels in the URL fragment, which browsers never send
  to a server — not in requests, server logs or `Referer`.
- **Confirmation** — the target's web app (`/transfer`, `TransferView`) takes the token out of the
  address bar first thing at startup (`history.replaceState`, kept in memory only), shows whose
  account the link signs in to (`POST /User/previewTransferLink { token }`, which does not use the
  token) and redeems it only after an explicit "Continue as …". A different account signed in there
  is signed out first (after the page said so). "This isn't me" uses the link up without signing
  anyone in, together with every other unused link of that account (`POST
  /User/declineTransferLink { token }`, same limits as the preview; only a usable link does that,
  and the answer is the same whether it was usable or not), so none of them can be opened again,
  from the browser's history for example.
- **Sign-out** — where links are minted (`TRANSFER_TARGET_URL` set, i.e. on the gateway),
  `User/logout` also uses up every unused link of that account (`discardUnused`): a link that is
  still open somewhere stops working once its owner signs out where they got it. The gateway
  session itself stays valid after a link was minted (its page offers "Continue to …" again).
- **Redemption** — `POST /User/redeemTransferLink { token, device }` only from a logged-out session
  (`ALREADY_LOGGED_IN` otherwise). One conditional statement (`UPDATE … SET "usedAt" = now() WHERE
  "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now() AND <live human account>
  RETURNING …`) uses the token up, so of two concurrent redemptions exactly one succeeds. Then a
  device is created and `establishLoginSession()` runs with `authMethod: 'transfer'` (new session
  id, awaited save). The answer is the login response plus `nextPath`. While the account is in the
  account-security step, a transfer session may add what the step asks for (below); otherwise it is
  an ordinary sign-in and no recent authentication for anything — adding a sign-in method included
  ([§7](#step-up-for-sensitive-actions)).
- **Limits** (`srv/util/authLimits.ts`) — preview and redemption: 120 attempts per 15 minutes per
  client IP, and after 20 failed attempts in 15 minutes an IP is refused before the lookup
  (`ipFailureLimiter`); more than 100 failures per hour instance-wide log one `[security]` warning
  per hour. Unknown, used and expired tokens all answer `TRANSFER_LINK_INVALID`.
- **Confirmation page** shows the account's display name and profile image, and next to them an
  identifier no other account has (`previewTransferLink` → `{ userId, displayName, username,
  identity, imageId, expiresAt }`; `transferIdentity`, `srv/api/user.ts`): the cg profile name
  (`@name`), else the linked X handle, the Farcaster username or the Universal Profile address,
  else the start of the account id (`src/views/TransferView/transferIdentity.ts`). A look-alike
  display name and image therefore never stand alone.
- **Legacy CG ID mode** (the gateway) mints but never redeems: preview, redemption and declining
  are `NOT_SUPPORTED` there (on a gateway they are off its allowlist as well). The gateway
  ([§12](#12-gateway-mode)) exposes `User/createTransferLink` to its logged-in users and runs with
  `TRANSFER_TARGET_URL=https://<new instance>`.

### Account-security step

`srv/util/securityStep.ts`. An account has to finish the step before it can use the instance when

- it has **no sign-in method that works here**: a passkey of this instance's relying party, a
  password or a login-enabled EVM wallet (X, LUKSO and Farcaster accounts still sign in, but do
  not count; neither do passkeys of another RP, e.g. the old `id.app.cg` ones), or
- it has **no verified email address** (only on an instance that sends mail), or
- its password **does not meet the policy** and signed in that way (`passwordChangeRequired`).

The state is derived from the account (`getSecurityFacts`, `srv/repositories/loginMethods.ts`),
never from how the session came about, and it is not enforced in legacy CG ID mode.

- **api** — `securityStepMiddleware` runs in front of every API router and the gated file routes
  (`/gated-videos`, `/gated-files`), not in front of the page routes (social previews, redirects,
  `/verify-email` …), which serve HTML. For a session whose account is in
  the step, only the step's endpoints work (method + path, case-insensitive): `User/`
  `getSecurityStatus`, `checkLoginStatus`, `ensureSession`, `getSignableSecret`, `login`, `logout`,
  `clearLoginSession`, `reauthenticate`, `setPassword`, `requestEmailVerification`, `verifyEmail`,
  `prepareWalletAction`, `addPreparedWallet`, `updateWallet`, `getWallets`, `getUserData`,
  `previewTransferLink`, `redeemTransferLink`, `emailUnsubscribe` (GET and POST, token-authenticated
  one-click links); `Passkey/` `registrationOptions`,
  `verifyRegistration`, `authenticationOptions`, `list`; `GET` `Captcha/config`,
  `Captcha/challenge`, `Instance/config`. Everything else — messages, uploads, communities, bot
  management, gated files — answers `{status:'ERROR', error:'SECURITY_STEP_REQUIRED'}`. A
  complete account is remembered in the session (`securityStepClearFor`) together with the
  account's change counter in Valkey (`security-step-version:<userId>`,
  `srv/util/securityStepVersion.ts`); the counter moves when something outside the session may
  have made the step due again — a password below the policy signed in, or the bounce policy reset
  the verified address — and every session then checks again.
- **wsapi** refuses the socket `login` of such an account with `SECURITY_STEP_REQUIRED` (the web
  app then shows the step): the parts that need no mail configuration come from the database
  function `security_step_db_required(userId, rpId)`, the email part from a Valkey record the api
  keeps (`security-step:<userId>`, written whenever it computes the state). The **call server**
  checks the database part only, through the same function: its role has no Valkey access and may
  not read `users`, `passkeys` or `wallets` — the `SECURITY DEFINER` function only answers yes or
  no ([database](../database/README.md#security_step_db_required)). It needs `BASE_URL` (and
  `PASSKEY_RP_ID`, if set) like every backend process, for the relying party.
- **What is missing** — `POST /User/getSecurityStatus` → `{ required, needsSignInMethod,
  needsVerifiedEmail, needsNewPassword, email, emailVerified, hasPassword, passkeys, loginWallets,
  pendingEmail, recentSignIn }`; login responses carry `securityStepRequired`. `pendingEmail` is
  set after a code request whether or not the address was free, so it reveals nothing.
  `recentSignIn: false` means the session cannot add what is missing (see below).
- **Completing it** — adding what is missing needs a sign-in or transfer link within the last
  60 minutes, but no step-up (`requireAuthToAdd`, [§7](#step-up-for-sensitive-actions)); a transfer
  link counts only for what the account still lacks at that moment, so once the step is done the
  same session needs the step-up for every further change to its sign-in methods:
  a passkey on this origin, a password, or a wallet — a new one is linked as a sign-in wallet, one
  the account already has gets sign-in switched on; either way a SIWE signature checked against
  this instance's domain ([§5.2](#52-wallet-type-wallet--evm-only)) —, and an address confirmed
  with a code ([§8](#email-verification)). Methods added this way, also in a transfer-link
  session, are full sign-in methods; the notices to the verified address are the safeguard
  (decisions 18 and 30 of the cg.box roadmap). Adding
  them signs no other device out, so the account's other transfer sessions and its gateway devices
  stay signed in ([§2](#signing-out-other-devices)). A password below the policy is replaced with
  `setPassword`, which asks for the current password first (step-up) and, like every replaced
  password, signs the other devices out. Every added method is reported to the verified address. An account whose only
  sign-in was X/LUKSO/Farcaster therefore must add one of these; afterwards the normal step-up
  works with it (there is no X/LUKSO/Farcaster option in the step-up dialog).
- **Web app** — `SecurityStepView` / `SecurityStep` organism ([frontend §10](../frontend/README.md#10-authentication-ui)).
- **Operational dependency** — on an instance that sends mail, accounts without a verified
  address can only finish the step with a code by mail: while outgoing mail does not work, they
  cannot get into the app.

### Logging

Unexpected errors are logged as name, message and stack only (`describeErrorForLog`,
`srv/util/errorLog.ts`, dependency-free and re-exported by `srv/api/util.ts`; also used by the
async route wrappers and the memberlist process) — never the error object, which can hold request data (an HTTP client error
carries the request it sent, a database error the row's values) — and a validation error only
with the paths of the failing fields. Sign-in paths log no request bodies, passwords, codes or
tokens.

---

## 12. Gateway Mode

During the move of the hosted instance (app.cg → cg.box) the old domain keeps working as a
**gateway**: the same code a second time (`CG_GATEWAY=true`), next to the new instance on the same
server and on the same PostgreSQL and Valkey (not the storage: no route it serves reads or writes
files, so it gets no storage credentials). People sign in there exactly as before —
device key, password, email code, wallet, the old CG ID passkeys (`id.app.cg`), X, LUKSO, Farcaster —
and continue on the new instance with a one-time transfer link ([§11](#11-transfer-links-and-the-account-security-step)).
Nothing else is served. Deployment: [docker/SELFHOST.md](../../docker/SELFHOST.md#gateway-for-a-moved-instance).

`srv/util/gateway.ts`.

**Configuration.** Every gateway process (api, wsapi) runs with `CG_GATEWAY=true`,
`CG_LEGACY_CGID=true`, `BASE_URL=https://<old domain>`, `CGID_URL=https://<old CG ID domain>`; the
api also with `TRANSFER_TARGET_URL=https://<new instance>` and the shared mail-limit secret (below).
Missing pieces stop the process at startup (`validateGatewayConfig`), and so do `DEPLOYMENT=dev`
(a dev stack turns off the login throttles and allows `http` transfer targets) and a
`TRANSFER_TARGET_URL` whose host is the gateway's own domain or lies under it: that instance would
receive every cookie scoped to the old domain, the old instance's session cookie of the same name
included. The other way round, outside dev an api or wsapi with the gateway's settings
(`CG_LEGACY_CGID=true` or `TRANSFER_TARGET_URL`) but without `CG_GATEWAY=true` refuses to start:
it would be a full instance on the old domain, on the main instance's Valkey keys and Socket.IO
channels. The singleton processes — job-runner, onchain, memberlist, the
call server and migrate-db — run once, for the new instance; started in gateway mode they exit
(`refuseInGatewayMode`).

**The allowlists are the only boundary.** Legacy CG ID mode keeps the full old sign-up and sign-in
surface ([§7](#legacy-cg-id-gateway-only)), so the gateway's server-side allowlists alone decide what
it serves:

- **api** (`GATEWAY_API_ALLOWLIST`, `gatewayApiGuard`) — mounted right after the origin check and
  CORS, before the bot authentication, the session and every router. A request is served only if its
  method and path are on the list (compared like Express routes: case-insensitive, one trailing slash
  ignored, `HEAD` as `GET`); anything else — another spelling, encoded characters, double slashes —
  and every request with an `Authorization` header (bot tokens are not even looked up) gets
  `404 {status:'ERROR', error:'NOT_SUPPORTED'}` without a session being read or created. The list:

  | Route | For |
  |---|---|
  | `POST /User/getSignableSecret`, `/User/login`, `/User/checkLoginStatus`, `/User/ensureSession`, `/User/logout`, `/User/clearLoginSession` | the session and sign-in (every `User/login` type) |
  | `POST /User/prepareWalletAction` | wallet and recovery-phrase sign-in |
  | `POST /User/sendOneTimePasswordForLogin` | email-code sign-in |
  | `POST /CgId/generateAuthenticationOptions`, `/CgId/verifyAuthenticationResponse`, `/CgId/ensureSession` | the CG ID passkey assertion |
  | `GET /Twitter/startLogin`, `GET /twitter-callback`, `GET /twitter-login`, `POST /Twitter/finishLogin` | X sign-in |
  | `POST /Lukso/PrepareLuksoAction`, `POST /Accounts/Farcaster/verifyLogin` | LUKSO and Farcaster sign-in of existing accounts: on a gateway a profile or FID without an account is refused (`ACCOUNT_DOES_NOT_EXIST`) before any profile lookup — no image fetched or stored, no sign-up prepared. LUKSO checks signatures through the instance's `onchain` service, so the gateway api follows the instance's `CG_ENABLE_BLOCKCHAIN` |
  | `POST /User/createTransferLink` | the link to the new instance |
  | `GET /Instance/config` | the instance configuration |

  No sign-up (`createUser`, the sign-up codes), no transfer-link preview or redemption, no data. The
  login answer on a gateway carries the account (`ownData`) but no communities, chats, unread count
  or push subscription. `User/clearLoginSession` creates no session when there is none.
  A device-key session on the gateway can mint a transfer link as well; it yields a `transfer`
  session on the new instance, which adds a sign-in method or an address there only while the
  account still lacks it (the account-security step); for a complete account it is an ordinary
  sign-in, and any change to its sign-in methods takes the step-up (decisions 18 and 30 of the
  cg.box roadmap, [§7](#step-up-for-sensitive-actions), [§11](#11-transfer-links-and-the-account-security-step)).
- **wsapi** (`GATEWAY_SOCKET_EVENTS`, `gatewaySocketEventGuard`) — a Socket.IO middleware in front
  of every event handler lets only `cgPing` and `watchCgIdRequest` (the CG ID popup's result) through;
  every other event is dropped without an acknowledgement. There is no socket sign-in, so a gateway
  socket never joins a user's, device's, role's or community's room. Token handshakes (bots) are
  refused (`gatewayHandshakeGuard`).

`srv/tests/gatewayAllowlist.spec.ts` builds the **complete route list** of the api from the code —
every router mounted like the api does it (`srv/api/mountRouters.ts`), routes read from Express'
router stacks, nested routers included — and sends every route through the guard: all but the
allowlisted ones are refused, every allowlisted one exists and is reached.
`srv/tests/gatewaySocket.spec.ts` does the same for every socket event the wsapi handles (read from
its source and from `API.Server.ServerToClientEvents`) on a real Socket.IO server.
`e2e/checks/gateway.sh` repeats both against a running gateway.

**Isolation from the new instance.**

- Own **session secret** (`REDIS_SECRET` of the gateway; the self-host profile takes
  `CG_GATEWAY_SESSION_SECRET` and refuses to start the gateway when it equals the instance's), so a
  cookie of one instance fails the other's signature check.
- Own **Valkey key prefix** `gateway:` for everything per-instance (`instanceKeyPrefix()`): sessions
  (`gateway:sess:`), revoked session ids (`gateway:sess-revoked:`), the index of each user's sessions
  (`gateway:sess-user:`), the copies of the session generations (`gateway:sess-gen:`,
  `gateway:sess-keep:`, `gateway:sess-gen-copied`) and the Socket.IO adapter and emitter channels
  (`gateway:v2:`). The main instance keeps its key names. A session id of one instance is therefore
  unknown to the other even with a valid signature, a logout or revocation on one never touches the
  other, and each instance's sockets only receive its own events.
- **Session generations** are still per account and live in PostgreSQL ([§2](#signing-out-other-devices)):
  the gateway's own reconciler copies them into its prefix, so a sign-out of other devices on the
  new instance (a replaced password, …) ends the account's gateway sessions within one reconciler
  interval, and its gateway device keys at once (shared `devices` table).
- Shared on purpose: the per-network and per-account limits (`ratelimit:`, the same budgets on both
  instances), the account-security records (`security-step:`, account facts; not enforced on the
  gateway), WebAuthn challenge markers (random).
- The per-address mail limits are keyed by an HMAC with a key derived from `CG_MAIL_LIMIT_SECRET`
  ([email docs](../email-notifications/README.md#send-limits)), which both instances share, so the
  login-code mails to one address count together; a gateway api refuses to start without it (the
  Docker secret `mail_limit_secret` counts as well — the check reads it like the mail limits do,
  `sharedMailLimitSecret`, without surrounding whitespace).
- Both session cookies are host-only (`app.cg` and `cg.box`; [§2](#cookie-scoping)): no other host
  under the old domain receives the gateway's cookie, and the CG ID app on `id.app.cg` reaches the
  gateway's session through its same-site requests to `app.cg`. A cookie the old instance scoped to
  `.app.cg` is expired by the gateway ([§7](#session-cookie-on-upgraded-instances)). The new
  instance must not lie on or under the gateway's domain all the same (checked by the gateway api
  and by `selfhost.sh up`); a gateway under the new instance's domain is fine. Every other host name
  under the old domain still receives what browsers keep for `.app.cg`, so the operator keeps only
  the gateway's two host names in DNS while the gateway runs
  ([docker/SELFHOST.md](../../docker/SELFHOST.md#gateway-for-a-moved-instance)).

**Web app.** The instance config of a gateway carries `gatewayTargetUrl` (the new instance's origin;
`srv/util/instanceConfig.ts`, the Caddy template renders it from `GATEWAY_CG_GATEWAY_TARGET_URL`).
With it the app renders only `GatewayView` (`src/views/GatewayView/`), keeps no local data, leaves
the data an old page of the app stored on that origin untouched (its databases are never opened or
cleared; a sign-out still deletes the device key, in the browser and on the server, as on any
instance) and opens no data socket (`isGatewayInstance()`, `src/common/gateway.ts`: the login setup — also when a
tab takes over another tab's login —, the data socket and the chat stores stay off; the choke points
are listed in [docs/frontend](../frontend/README.md#the-gateway-page-gatewayview)); the automatic device-key sign-in, which the data socket's connection starts
elsewhere, is started by `GatewayView`, and the CG ID popup's result arrives over a minimal socket
of its own (`src/views/GatewayView/cgIdResultSocket.ts`, `watchCgIdRequest`) or the popup's
`postMessage`. Every path, old deep links included, plus the X popup's page shows "Common Ground has moved to <host>", the login form without
sign-up (`AuthFlow allowSignup={false}`), and for a signed-in account "Continue to <host>", which
mints a transfer link with the path the page was opened with (`nextPath`) and opens it. Right after
a sign-in with a sign-in method in that tab it continues by itself; a tab that took over that
sign-in from another tab, like a page that opens signed in, shows the button. On the new instance the confirmation page redeems the
link and goes to that path, so `app.cg/<path>` ends on `cg.box/<path>`.

---

## Cross-references

- Overview & session table: [architecture README §3](../architecture/README.md#3-authentication--sessions)
- Socket.IO auth handshake: [realtime README](../realtime/README.md)
- Bot HTTP API: [`docs/BOT-API.md`](../BOT-API.md); bot account architecture: [bots README](../bots/README.md)
- Entities: [database README](../database/README.md)
