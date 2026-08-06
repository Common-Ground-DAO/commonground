# Common Ground SDK

A headless TypeScript reference client for Common Ground instances, plus the
conformance suite that proves it against a real server. This is the executable
form of the API contract: everything a native client (desktop, iOS, Android) or
a bot must do, done purely through the API with **zero browser dependencies**.

Two packages (yarn workspace):

- **`@commonground/client`** — the SDK. Node ≥ 24, ESM, no `window`, no DOM.
- **`@commonground/conformance`** — tests driving the client against a live
  instance. Private (needs a running instance).

## Why it exists

Client *code* never transfers between platforms (Swift/Kotlin/TS); the
*contract* does — API shapes, auth flows, the event catalog, versioning. A
paper spec doesn't surface real issues; a working browserless client does.
This project front-loads those discoveries (see `conformance/FINDINGS.md`)
before native development pays for them. It lives in the monorepo on purpose:
server change, SDK change, and conformance test land in one PR, and a contract
break fails the same CI run that caused it.

## Capabilities

| Area | What the SDK does | Phase |
| --- | --- | --- |
| Instance | `GET /Instance/config` — instance identity/capabilities | R0 |
| Identity | device keypairs (P-256 & P-384), native ALTCHA v2 solve, register, password + device-signature login, session lifecycle | R1 |
| Realtime | socket.io connect + in-band login, typed `cli*` event router, normalized sync store | R2 |
| Content | image upload/download, notifications + push registration, search, profile | R3 |
| Calls | protoo signaling handshake (getSignableSecret → login → caps → join); **signaling only, no media** | R4 |
| Contract | OpenAPI generation from the Joi validators, event/protoo catalogs, versioning policy | R5 |
| Bots | bearer-token `BotClient` (whoami, scopes, messages, realtime) — the SDK doubles as the bot library | R6 |
| Community admin | roles (CRUD + assignment + token-gated claim), areas, channels + permissions, moderation (ban/approvals/password), events, tokens | R7 |
| Articles | community + user posts (draft/publish, structured content), comment threads via article access | R8 |
| Plugins | appstore discovery, install/configure/clone, and the signed plugin-runtime RPC (RSA request/response) | R9 |
| Onchain | contract metadata, staking positions/config, Spark/points ledger + premium, wallets, token-gated role claims | R10 |

## Quick start

```ts
import { CommonGroundClient, textBody } from "@commonground/client";

const cg = new CommonGroundClient({ baseUrl: "https://cg.mogged.eu" });

// Instance identity (public, no auth)
const config = await cg.getInstanceConfig();

// Register (solves the instance's ALTCHA challenge natively)
const session = await cg.auth.register({
  email: "me@example.org",
  password: "…",
  displayName: "my_handle",
});

// Realtime: connect, authenticate the socket, react to events
const realtime = cg.realtime();
await realtime.connect();
await realtime.login(session.deviceId, session.deviceKey);
realtime.onEvent((e) => console.log(e.type, e.payload));

// Post to a channel
const community = await cg.communities.create({ title: "my_community" });
await cg.messages.send({
  access: { channelId: community.channels[0].channelId, communityId: community.id },
  body: textBody("hello from the reference client"),
});
```

### As a bot

```ts
import { BotClient } from "@commonground/client";

const bot = new BotClient({ baseUrl: "https://cg.mogged.eu", token: "cgb_…" });
console.log(await bot.whoami());
const rt = bot.realtime();       // handshake auth, auto-joined to bot rooms
await rt.connect();
```

## Design rules (enforced, not aspirational)

- **Zero browser APIs.** If the SDK ever needs `window`, the server has a
  contract gap — that becomes a finding, not a workaround.
- **Every conformance test cites the contract section it proves.**
- **No imports from `srv/`.** The SDK mirrors `src/common` shapes and consumes
  generated `docs/api/` artifacts; it never reaches into server internals.
- **Findings are first-class.** Anything a browserless client can't do cleanly
  is recorded in `conformance/FINDINGS.md`; server-fixable ones become PRs.

## Running the conformance suite

```bash
# 1. Build the selfhost images once (from repo root)
sudo docker/selfhost/selfhost.sh build

# 2. Spin a disposable, throwaway instance (loopback HTTP, own volumes)
yarn instance:up            # → http://127.0.0.1:18080

# 3. Build the client and run the suite
yarn build
CG_BASE_URL=http://127.0.0.1:18080 yarn test

# 4. Tear it down (deletes volumes)
yarn instance:down
```

Against a **live** instance (e.g. `CG_BASE_URL=https://cg.mogged.eu`), the
mutating tests (registration, messaging, calls, bots) auto-skip so a shared
instance isn't polluted; the read-only checks still run. Set
`CG_LIVE_MUTATIONS=1` to opt in.

## Contract artifacts

- `docs/api/openapi.json` — generated from the Joi validators;
  `yarn openapi:check` is the CI drift guard.
- `docs/api/socket-events.md`, `docs/api/protoo-methods.md` — the realtime and
  call-signaling catalogs, each entry citing its conformance test.
- `docs/api/VERSIONING.md` — the versioning & deprecation policy.

## Status & scope

- Media (WebRTC) is deliberately out of scope for the node SDK — calls are
  signaling-only. Browser-driven tooling keeps full media coverage.
- Passkey and wallet/OAuth logins are out of SDK scope (they need a
  platform/browser); the SDK covers email+password and device-signature auth,
  the substrate every native client needs first.
- Onchain *writes* (staking lock/unlock, wallet signing) happen against the
  chain via a wallet, not the API — the SDK covers the API's indexed reads and
  the token-gated role claim; a real chain is needed for the non-empty paths.
- The SDK now wraps the large majority of the ~200 REST routes as typed
  methods; anything not yet wrapped is still reachable via
  `client.transport.call(route, body)`.
- Packaging (npm publication, license) is pending a maintainer decision — see
  `PACKAGING.md`.
