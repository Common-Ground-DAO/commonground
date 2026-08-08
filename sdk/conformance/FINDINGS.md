# Conformance findings

Contract gaps, surprises, and boundaries surfaced by building the headless
reference client. Per the roadmap, anything a browserless client can't do
cleanly is a finding, not an inconvenience — and server-side fixes ride this
branch as reviewable commits.

## Fixed on this branch

- **F-01 — No API route for instance identity.** The instance config only
  existed as HTML injection (`window.__CG_INSTANCE__`); a client that never
  loads index.html had no way to learn the instance's captcha provider,
  features, or URLs. Fixed: `GET /api/v2/Instance/config` (srv/api/instance.ts)
  returns the identical object; conformance asserts endpoint and injection
  agree.

- **F-02 — First-boot migration race in the selfhost stack.** `migrate-db`
  used `deploy.restart_policy` (swarm-only syntax, silently ignored by plain
  docker compose) and a bare `depends_on: [db]`. On a *fresh* postgres volume,
  the cluster init window loses the race and a new install ends up with no
  schema and no retry — every API call fails `relation "users" does not
  exist`. Existing installs never see this (pgdata already initialized), which
  is why the July install worked. Fixed: db healthcheck gets
  `start_period`/`start_interval`, migrate-db gates on `service_healthy` and
  uses a real `restart: on-failure:3`. Reproduced + verified by the disposable
  conformance instance, which cold-boots the stack every time.

## Fixed on this branch (continued — gap-closure round)

- **F-12 — `getEventParticipants` queried a phantom column.** The SQL filtered
  on `"leftAt" IS NULL`, but `communities_events_participants` has only
  `eventId, userId, createdAt` (leaving an event DELETEs the row) — every call
  errored Postgres 42703 → `UNKNOWN`. Fixed by dropping the clause
  (srv/repositories/communityEvents.ts). Pinned by r7-community-admin.

- **F-15 — `pluginRequest` userInfo/userFriends NPE before first consent.**
  `getUserPluginPermissions` returned `result.rows[0]` (undefined when the
  user has no `user_plugin_state` row), and the userInfo handler dereferenced
  `.acceptedPermissions` → `TypeError` → `UNKNOWN`. So a plugin's very first
  userInfo request crashed until the user had accepted something. Fixed to
  default to `{acceptedPermissions: []}` (srv/repositories/plugins.ts). Pinned
  by r9-plugins.

- **F-13 — `createArticle` now honors the `published` field.** The create
  validator required `published`, but the INSERT dropped it, so every article
  was created as a draft regardless (the response also hard-coded
  `published: null`). Native clients (iOS) hit this trying to publish in one
  step. Fixed: `_createCommunityArticle`/`_createUserArticle` store the
  requested value (`null` → draft, timestamp → published/scheduled) and the
  handlers return the actual state. Backward-compatible — the web always sends
  `published: null` on create and publishes via `updateArticle`. Pinned by
  r8-articles (create-with-published + draft-then-publish).

- **F-14 — user `updateArticle` accepts a userArticle-only update.** The user
  variant's cross-field check compared `userArticle.articleId` to
  `article.articleId` without guarding for a missing `article`, so publishing a
  user article (userArticle only) failed `VALIDATION`. Fixed by guarding the
  check like the community variant; the SDK's no-op stub workaround is removed.
  Pinned by r8-articles.

## Recorded (documented behavior, maintainer may want changes)

- **F-03 — Rate-limit keying trusts the leftmost `X-Forwarded-For` entry.**
  `srv/util/rateLimit.ts` buckets by the *first* XFF address, and the selfhost
  nginx uses `$proxy_add_x_forwarded_for`, which **appends** to any
  client-supplied header. Behind caddy (which replaces client XFF) this is
  safe; anyone terminating on nginx directly is spoofable — a client can dodge
  the createUser limit (2/24h per /64) by minting XFF values. The conformance
  suite exploits exactly this against its own disposable instance for fixture
  isolation (sdk/conformance/src/fixtures.ts), which doubles as proof.
  Suggested hardening: have nginx *set* (not append) the header from
  `$remote_addr` when it is the TLS edge, or make the API prefer the
  rightmost-trusted entry.

- **F-04 — Password policy is absent server-side.** `common.Password` is a
  bare `Joi.string()`: no minimum length, no complexity, and in
  `createUser.useEmailAndPassword` the password key is not even `.required()`.
  Any policy lives client-side only; native clients will inherit "1-char
  passwords accepted" unless the validator is tightened. (bcrypt cost 8 for
  storage is fine.)

- **F-05 — RPC errors ride HTTP 200.** `{status:"ERROR", error}` with HTTP
  200 for all handler failures (only bot-auth middleware and non-envelope GET
  routes use real status codes). Not a defect — but every client stack must
  parse the envelope instead of trusting HTTP semantics, so it is contract,
  documented here and enforced by tests (r1-identity: LOGIN_REQUIRED @ 200).

- **F-06 — Logout destroys the device.** `POST /User/logout` soft-deletes the
  session's device row, so a stored (deviceId, private key) pair does not
  survive logout — a native client that logs out must re-register its device
  on next login (password login mints a new device implicitly). Pinned by
  r1-identity "logout ends the session and soft-deletes the device".

- **F-07 — No same-device echo for own writes.** Message events (and the
  creator's `cliCommunityEvent`) exclude the DEVICE that performed the REST
  write (`emitMessageEvents(..., {deviceIds:[user.deviceId]})`): the REST
  response is that device's echo. Other devices of the same user receive the
  events normally. A native client must apply its own writes from the REST
  response, never wait for the socket echo. Pinned by r2-realtime
  "send/edit/delete echo to the user's OTHER device".

- **F-08 — `getUnreadCount` returns a string.** The SQL COUNT is passed
  through unconverted, so `data` is `"3"` where the ambient type says
  `number`. The web client survives via implicit coercion; typed native
  clients won't. SDK normalizes with `Number()`; server-side `Number(...)`
  in the handler would fix the contract.

- **F-09 — `File/uploadImage` has an asymmetric envelope.** Success responds
  with the bare `UploadResponse` (`{imageId}` — `res.send(result)`), while
  failures go through `handleError` and arrive as the standard
  `{status:"ERROR"}` envelope. Every other RPC wraps success in
  `{status:"OK", data}`. Clients must special-case this one route (the SDK
  transport does); wrapping the success path server-side would restore
  uniformity at the cost of a web-client change.

- **F-10 — `getCall` response type overpromises.** `API.Community.getCall.
  Response` declares `callServerId` and `communityId`, but
  `communityHelper.getCall`'s SQL selects neither (srv/repositories/
  communities.ts) — both come back `undefined` at runtime. A typed native
  client trusting the `.d.ts` would silently read undefined. Fix: add the two
  columns to the SELECT (they exist on `calls`), or drop them from the type.
  Pinned by r4-calls "getCall omits the call-server fields its type promises".

- **F-11 — A freshly-created community bot cannot post.** `Bot/create` with
  `ownerType:"community"` returns success and lists the community in the bot's
  `communityIds`, but the bot ends up with **no role** in that community. So
  when it posts, `assertActiveCommunityAccess → _assertBotInstalled` (which
  requires the predefined Member role) rejects with `NOT_ALLOWED` —
  `createMessage` never even reaches the channel-permission check. The Member
  role *does* grant `CHANNEL_WRITE` (a human member posts fine, R2), so the
  bot is one missing membership row away from working. Either `_installMembership`
  isn't landing the row for this path, or an explicit install step is expected
  that `create` implies but doesn't perform. Pinned by r6-bot "a freshly-created
  community bot cannot yet post"; the test flips to a success round-trip when
  the server side is fixed. (The bearer surface itself — token issuance,
  `whoami`, `scopes/list`, realtime handshake — is fully proven.)

- **F-16 — `previewText` type mismatch between model and create.** The model
  and the create validator disagree: `Models.BaseArticle.Preview.previewText`
  is `string | null`, but the create validator requires a string ("" allowed).
  The SDK coerces null → "" on create.

## Boundaries (out of SDK scope by design)

- **B-01 — Passkeys.** WebAuthn ceremonies need a platform authenticator API;
  headless node has none. Native clients use their platform passkey APIs
  against the same endpoints; the SDK documents but does not implement them
  (per the native-clients roadmap auth spec).
- **B-02 — Wallet/OAuth logins (SIWE, Twitter, Lukso, Farcaster).** All
  involve a browser or wallet app in the loop. The SDK covers the
  email+password and device-signature flows, which are the substrate every
  native client needs first.
- **B-03 — Call media.** Signaling only (R4); node WebRTC stacks are
  explicitly out (roadmap).
