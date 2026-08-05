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
