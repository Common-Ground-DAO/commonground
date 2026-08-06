# Roadmap: Headless Reference Client + Conformance Suite

> **Status update 2026-08-06: R0–R6 plus a gap-closure round (R7–R10) all
> implemented and green** on `feat/reference-client` (not yet merged to
> develop — awaiting maintainer review). The `sdk/` workspace
> (`@commonground/client` + `@commonground/conformance`) now covers the large
> majority of the ~200 REST routes; **78 conformance tests** pass against a
> disposable instance, verified live on cg.mogged.eu.
>
> - R0–R6: instance config, identity/auth, realtime, files/notifications/
>   search/profile, call signaling, contract artifacts + CI, bot bearer API.
> - **R7 community management** (roles/areas/channels/moderation/events/
>   tokens), **R8 articles/posts**, **R9 plugins** (incl. the signed
>   plugin-runtime RPC), **R10 onchain** (contracts/staking/points/wallets/
>   token-gated role claims).
>
> Contract artifacts (`docs/api/openapi.json` — now 167 operations, socket/
> protoo catalogs, `VERSIONING.md`) and CI are in place. **16 contract findings**
> in `sdk/conformance/FINDINGS.md`; **four fixed on the branch** (the
> `Instance/config` endpoint, a selfhost first-boot migration race, a
> `getEventParticipants` phantom-column crash, and a `pluginRequest` NPE).
> Packaging decisions (npm/license/bot-SDK) await the maintainer —
> `sdk/PACKAGING.md`. The phase checkboxes below are left as originally
> written for reference.
>
> Status: active 2026-08-05 (maintainer approved the approach; desktop Electron
> shell deliberately deprioritized in its favor — no rush on desktop).
> Goal: a headless TypeScript client SDK that does everything a native client
> must do purely through the API, plus a conformance suite that runs it against
> a disposable selfhost instance in CI. It is the executable form of the
> native-clients roadmap's Phase 0: the artifact iOS/Android teams port from,
> and the guard that keeps server and contract honest in the meantime.

## Why this exists (relationship to ROADMAP_NATIVE_CLIENTS.md)

Client *code* never transfers between platforms (Swift/Kotlin/TS); what
transfers is the contract — API spec, auth flows, event catalog, versioning
policy — and a way to prove an implementation against it. Paper specs don't
surface real issues; only a working non-browser client does ("does device-key
login work without a browser?", "what does the protoo handshake actually
require?"). This project front-loads those discoveries at a tenth of the cost
of finding them during iOS development.

**Location: this monorepo, `sdk/` (yarn workspace).** Deliberately opposite to
the desktop app (separate repo): the reference client must evolve in lockstep
with the server — server change, SDK change and conformance test land in one
PR, and a contract break fails the same CI run that caused it. It also consumes
in-repo assets directly: `src/common` types, the Joi validators (OpenAPI
generation), and the compose stack for disposable test instances.

```
sdk/
├── client/        # @commonground/client — the SDK (no UI, no browser APIs)
│   └── src/
│       ├── transport/    # fetch wrapper, cookie jar, error mapping, retry
│       ├── identity/     # device keypair (P-256|P-384), signable-secret login
│       ├── captcha/      # ALTCHA v2 solver (PBKDF2 counter search)
│       ├── realtime/     # socket.io client, cli* event router, sync store
│       ├── calls/        # protoo client (in-house), mediasoup signaling
│       └── index.ts
└── conformance/   # test suite driving @commonground/client against an instance
```

Design rules:

- **Node ≥ 24, zero browser APIs.** If the SDK needs `window`, the server has a
  contract gap — that is a finding, not an inconvenience.
- **Every conformance test cites the contract section it proves.** Tests are
  the spec's teeth; an uncited test means an undocumented behavior.
- **No imports from `srv/`.** The SDK may import `src/common` types (shared by
  design) and generated artifacts from `docs/api/`; reaching into server
  internals would defeat the point.
- Findings that need server changes become small PRs against this repo (the
  instance-config endpoint is the first known one) and get recorded here.

## Branch & deployment policy (maintainer, 2026-08-05)

- All workstream code lives on **`feat/reference-client`** (branched from
  develop 2026-08-05). **No merging to develop without the maintainer's
  explicit go** — the branch accumulates reviewable commits and merges develop
  in regularly to stay current. Roadmap/doc updates about the workstream still
  land on develop as normal docs PRs.
- The branch **may be deployed to the reference instance (cg.mogged.eu) at any
  time** for live checks — same deploy flow as develop, just checked out to the
  branch. The instance is the workstream's live test bed; deploys back to
  develop-head whenever needed.

## Phases

### Phase R0 — scaffolding + first server gap (~2-3 days)

- [ ] `sdk/` yarn workspace: `@commonground/client` + `@commonground/conformance`,
  tsconfig (node24, ESM), vitest as runner (matches frontend tooling).
- [ ] **Server PR: `GET /api/v2/Instance/config`** — the injected
  `window.__CG_INSTANCE__` object as JSON (+ nginx route). First thing any
  client calls; native-clients roadmap Phase 0 item. The web keeps the
  injection as its fast path.
- [ ] Conformance bootstrap: spin the selfhost compose stack against a
  throwaway DB/volumes, wait healthy, run suite, tear down. Local script first;
  CI wiring in R5.
- [ ] First test: fetch instance config, assert shape.

### Phase R1 — identity & auth (~1 week)

- [ ] Device keypair module: generate P-256 and P-384 (both must pass — the
  P-256 path is the Secure Enclave stand-in), export JWK, sign secrets.
- [ ] Registration: `createUser` with email+password + native ALTCHA v2 solve
  (port of the existing E2E solver into the SDK proper).
- [ ] Login flows: email+password; device-signature (`getSignableSecret` →
  sign → login); session cookie lifecycle (jar, expiry, logout).
- [ ] Negative conformance: replayed captcha token rejected, bad signature
  rejected, expired challenge rejected.
- [ ] Findings log: anything a browserless client can't do cleanly (e.g.
  passkey flows are out of SDK scope by design — document the boundary and the
  native-API path instead, per the native-clients roadmap auth spec).

### Phase R2 — realtime sync (~1-1.5 weeks)

- [ ] Socket.io connect with session auth + `protocolVersion` negotiation;
  reconnect/backoff semantics documented as observed.
- [ ] Event router for the 16 `cli*` event types; minimal normalized store
  (communities → channels → messages, own user, presence).
- [ ] Message send (REST) → own `cliMessageEvent` observed (round-trip
  conformance); edit + delete; markdown body preserved verbatim.
- [ ] Two-client test: A sends, B receives — first true multi-client
  conformance, catches room/permission regressions.

### Phase R3 — content & notifications (~1 week)

- [ ] File upload (image) + signed-URL download round-trip.
- [ ] Notification list/read; web-push subscription registration recorded
  as-is, with the transport field designed so the future push gateway
  (`apns|fcm|unifiedpush`) slots in without SDK surgery.
- [ ] Search, profile read/update — thin coverage, contract-cited.

### Phase R4 — calls: signaling first (~1-1.5 weeks)

- [ ] In-house protoo client (~small JSON-RPC over WS; do not depend on
  abandoned ports — same call as the native roadmap).
- [ ] Signaling-level conformance: `getSignableSecret` → `login` (the 64-hex
  secret path!), `getRouterRtpCapabilities`, `join`, transport
  creation/connect params — asserted against the mediasoup service **without
  sending media**.
- [ ] **Media is explicitly out of scope for the node SDK** (node WebRTC
  stacks are the flaky part; the risk isn't worth it). Full media E2E stays
  with browser-driven tests (existing puppeteer tooling); revisit only if a
  native team needs a media reference beyond libmediasoupclient's own examples.

### Phase R5 — contract artifacts + CI (~1 week)

- [ ] OpenAPI 3.1 generation from the Joi validators + route table →
  `docs/api/openapi.json`, CI drift check (regenerate, diff must be empty).
- [ ] Socket (`cli*`) + protoo method catalog in `docs/api/` — hand-written,
  small, each entry linked from the conformance test that proves it.
- [ ] Versioning/deprecation policy doc (extends the existing socket
  `protocolVersion` idea to REST).
- [ ] CI: conformance suite as a workflow — full run nightly + on-demand
  label; a fast subset (R0+R1, no compose rebuild) on PRs touching `srv/` or
  `sdk/`.

### Phase R6 — packaging (~2-3 days, decisions first)

- [ ] Decide npm publication (name/scope, license AGPL implications for SDK
  consumers — maybe MIT for the SDK alone, maintainer call).
- [ ] Bonus alignment: evaluate covering the bot API (bearer auth) so the SDK
  doubles as the official bot-developer library — it already speaks everything
  else.

## Risks / known unknowns

- **Server churn**: the dependency-modernization work is active. In-repo
  lockstep is the mitigation — breakage shows up in the same PR.
- **Session-cookie auth in non-browser HTTP stacks**: expected to work (plain
  `Set-Cookie`), but mobile teams may prefer token auth; if R1 findings
  support it, a token endpoint proposal graduates from the findings log.
- **Compose-stack CI cost**: full instance spin-up is minutes; mitigated by
  the nightly/full + PR/subset split in R5.

## Decisions needed

| # | Decision | When |
|---|---|---|
| 1 | npm publish + license for the SDK package | R6 |
| 2 | CI cadence acceptable (nightly full + PR subset)? | R5 |
| 3 | Bot-API coverage in the SDK | R6 |

## Sequencing

R0 → R1 → R2 are strictly ordered; R3/R4 parallelizable after R2; R5 starts
alongside R3 (generation work is independent). Total ≈ 5-7 weeks solo. The
Electron shell (native-clients roadmap Phase 1) is intentionally paused until
this is well underway; mobile remains gated as decided.
