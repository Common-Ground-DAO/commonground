# Roadmap: Native Clients (Electron desktop, iOS, Android)

> Status: draft 2026-08-04, decisions pending (see [Decisions needed](#decisions-needed)).
> Goal: ship Common Ground as a desktop app (Electron: macOS/Linux/Windows) and as
> two native mobile apps (Swift/iOS, Kotlin/Android). Native mobile means native
> codebases — not React Native / not a WebView wrapper.

## Overview

The server already speaks everything a native client needs; nothing about the
protocol is browser-only. What is missing is (a) a *contract*: the API surface is
defined implicitly by the web client, (b) *native transports* for a few
browser-shaped subsystems (push, captcha rendering, instance config injection),
and (c) the clients themselves.

Measured surface a client implements (as of 2026-08-04):

| Surface | Size | Native story |
|---|---|---|
| REST API (`/api/v2/*`, `registerPostRoute`/`registerGetRoute`) | ~198 routes | plain HTTPS + cookie session — trivial in any HTTP stack |
| Socket.IO events (server→client `cli*` types) | 16 event types | mature socket.io clients exist for Swift and Kotlin; handshake already carries `protocolVersion` |
| Call signaling (protoo over WebSocket) + mediasoup | 21 protoo methods | `libmediasoupclient` wrappers: [Mediasoup-Client-Swift](https://cocoapods.org/pods/Mediasoup-Client-Swift) (updated 2026-07), [libmediasoup-android](https://github.com/crow-misia/libmediasoup-android) (Maven Central). protoo is a ~small JSON-RPC-over-WS protocol; budget an in-house client (~500 LoC/platform) rather than depending on abandoned ports |
| Frontend | ~640 TS/TSX files | Electron reuses it wholesale; mobile reimplements a scoped subset (see MVP scoping) |

Tailwinds we already have:

- **ALTCHA captcha** (fail-closed default) is just SHA-256 proof-of-work + JSON —
  solvable natively on every platform. No WebView, unlike reCAPTCHA. Instances
  still on reCAPTCHA will need a WebView fallback or to switch providers.
- **Device-key auth**: every login mints a per-device EC keypair whose public JWK
  is registered and later used to sign server-issued secrets. This maps directly
  onto hardware-backed keystores (see the P-256 item in Phase 0).
- **Bearer-token precedent**: the bot API already runs cookie-less token auth,
  rate limiting and socket handshake auth — patterns to borrow, not invent.
- **Report feature** shipped 2026-07 — one of Apple's hard UGC requirements
  (guideline 1.2) already done. User-to-user *blocking* is not (gap, Phase 0).
- **AGPL + self-hosting**: the apps should follow the Element/Mastodon model —
  one official app that can connect to any instance (see Decisions).

---

## Phase 0 — platform-agnostic groundwork (blocks everything else)

Server/API work that all three clients need. Each item is small; together they
turn "the web client's private protocol" into "the Common Ground client API".

- [ ] **Instance config endpoint.** Today the config travels as a
  `window.__CG_INSTANCE__` script injected into `index.html` (nginx or API
  server). Native clients don't parse HTML: add `GET /api/v2/Instance/config`
  returning the same object (deployment, appUrl, cgidUrl, captcha provider,
  active chains, feature flags, giphy/walletconnect keys). The web client can
  keep the injection as a fast path.
- [ ] **API contract generation.** Every route already has a Joi validator
  (`srv/validators/`) and a TS request/response type (`src/common/types/api/`).
  Generate an OpenAPI 3.1 document from these (joi-to-json-schema + route table)
  and check it into `docs/api/`; from that, generate the Swift and Kotlin client
  stubs in CI. The socket (`cli*` events) and protoo methods get a hand-written
  but versioned catalog in the same folder — they are 16 + 21 items, not 198.
- [ ] **Versioning policy.** The socket handshake already negotiates
  `protocolVersion`; extend the same idea to REST (a `X-CG-Client` header +
  documented deprecation window) so old app builds against newer selfhost
  instances fail predictably, not mysteriously. Write the policy down in
  `docs/api/`.
- [ ] **P-256 device keys.** `common.JsonWebKey` requires `crv: P-384`, and the
  web client generates P-384. iOS's Secure Enclave only does **P-256** —
  hardware-backed keys on iOS are impossible under the current validator. Accept
  `P-256 | P-384` (verification code paths are curve-agnostic in WebCrypto/node)
  so mobile keys can live in Secure Enclave / Android StrongBox.
- [ ] **Push transport abstraction.** `sendWsOrWebPushNotificationEvent` knows
  exactly one transport (VAPID web push). Introduce a per-device transport
  (`webpush | apns | fcm | unifiedpush`) and payload mapping. Architectural
  decision required first: APNs/FCM credentials belong to the *app publisher*,
  not the instance operator — selfhost instances therefore need a **push
  gateway** (Matrix/Sygnal model: instance → gateway run by the app publisher →
  APNs/FCM), with UnifiedPush as the self-sovereign Android alternative. Design
  doc before code.
- [ ] **User-to-user blocking.** Community-level bans exist; personal blocks do
  not. Apple guideline 1.2 requires "the ability to block abusive users" for
  UGC apps — this is an App Review gate, not a nice-to-have. Backend + web UI
  first (small, self-contained), mobile inherits it.
- [ ] **Auth flows without a browser context.** Email+password and email-code:
  plain REST, fine. Passkeys/CGID and wallet logins assume the CGID popup /
  browser extensions:
  - Passkeys: native APIs (`ASAuthorizationPlatformPublicKeyCredential…`,
    Android Credential Manager) require the RP's domain to serve
    `apple-app-site-association` / `assetlinks.json` naming the app. Workable
    for app.cg; for arbitrary selfhost instances the fallback is an
    `ASWebAuthenticationSession`/Custom Tabs flow against the instance's CGID
    page. Both paths should be specified in Phase 0, implemented in Phases 3/4.
  - Wallets: WalletConnect deep links on mobile (no extensions). Staking/SIWE
    work over it; nothing server-side changes.

## Phase 1 — Electron desktop

The web frontend is the product; Electron adds chrome. This is deliberately a
**thin, hardened shell** — not a fork of the frontend.

- [ ] **Shell architecture**: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, a small typed preload bridge. Renderer loads the
  instance's deployed web app over HTTPS (site-specific-browser model, like
  Slack). Rationale: instances self-update server-side (service worker already
  handles versioning); the shell stays dumb and rarely needs updates; multi-
  instance support falls out for free. The alternative (bundling the frontend
  in the app) couples app releases to instance versions across arbitrary
  selfhosts — rejected unless a concrete need appears.
- [ ] **Native glue** (the actual value of the app): system tray + unread
  badges, native notifications (replacing web push while the app runs), deep
  links (`cg://` + `https://` handler registration), launch-at-login, global
  push-to-talk shortcut (calls), spellcheck, window state restore.
- [ ] **Screen sharing**: Chromium in Electron needs an explicit
  `setDisplayMediaRequestHandler` + `desktopCapturer` picker UI for
  `getDisplayMedia` — without it, call screenshare silently fails. Everything
  else (getUserMedia, mediasoup-client, WebAuthn via platform authenticators on
  macOS/Windows) works as in Chrome. Linux WebAuthn is spotty — the other auth
  methods cover it.
- [ ] **Multi-instance UI**: instance picker on first launch (default app.cg),
  stored per-profile; partition per instance (`session.fromPartition`) so
  cookies/service workers isolate.
- [ ] **Packaging + signing**: electron-builder. macOS: Developer ID +
  notarytool (hard requirement). Windows: Azure Trusted Signing (or EV cert).
  Linux: AppImage + deb/rpm, Flatpak later.
- [ ] **Auto-update**: electron-updater against GitHub Releases;
  update.electronjs.org is free for open-source apps (macOS/Windows) — we
  qualify (AGPL, public repo).
- [ ] **CI**: three-OS build matrix in the pipelines, artifacts attached to
  releases; smoke test = app boots, loads instance, logs in with email+password.

Scope estimate: the smallest of the three by far — the risky 10% is screenshare
picker + signing infrastructure, not app code.

## Phase 2 — mobile foundations (before either app)

- [ ] **Decide the sharing model** (see Decisions): pure native twice, vs
  Kotlin Multiplatform shared core (protocol/session/cache) with native UIs
  (SwiftUI + Compose). Recommendation: **spec-driven codegen, no shared
  runtime** — the OpenAPI-generated clients plus small hand-written
  socket/protoo layers keep both codebases idiomatic and avoid KMP toolchain
  tax; revisit if the two protocol layers drift.
- [ ] **Protocol conformance suite**: a headless test harness (extends the
  existing captcha/socket E2E scripts) that any client implementation runs
  against a disposable selfhost instance in CI — login, socket lifecycle,
  message send/receive, call join. This is what keeps three clients honest
  against one server.
- [ ] **MVP scope cut** for mobile v1: communities, channels, messaging
  (markdown incl. our renderer rules), notifications, profiles, onboarding
  (email+password + ALTCHA native solver + passkey where possible). Explicitly
  out of v1: calls (v1.1, it's the heaviest subsystem), staking/wallet
  (storefront-policy-dependent, see Decisions), plugins (WebView surface,
  needs its own design), article editor (read yes, write later).

## Phase 3 — iOS (Swift/SwiftUI)

- [ ] App skeleton: SwiftUI, min iOS 16, generated API client + session/device
  keystore (Secure Enclave P-256 after Phase 0), socket.io-client-swift.
- [ ] Messaging UI to MVP scope; local cache (GRDB/SwiftData) for offline reads.
- [ ] Push via APNs through the push gateway; Notification Service Extension
  for rich notifications.
- [ ] Passkey + web-session auth fallback per Phase 0 spec; WalletConnect for
  wallet login (if in scope for v1).
- [ ] v1.1 calls: Mediasoup-Client-Swift + in-house protoo client; CallKit +
  PushKit (VoIP push, ringing, system call UI); audio session management.
- [ ] App Review preparation: UGC checklist (report ✓, block from Phase 0,
  moderation contact), age rating, privacy manifest + nutrition labels,
  account deletion in-app (exists server-side — expose it), and the
  **crypto/payments file**: Spark purchase and anything smelling of digital-
  currency sales is IAP-only under 3.1.1 except via the US-storefront external
  purchase link rules (post-2025) — see Decisions; v1 likely ships with token
  features hidden on iOS outside the US storefront.
- [ ] TestFlight → phased release.

## Phase 4 — Android (Kotlin/Compose)

- [ ] Skeleton: Compose, min SDK ~26, generated client, Android Keystore
  (StrongBox where available), socket.io Java/Kotlin client.
- [ ] Messaging UI to MVP scope; Room cache.
- [ ] Push: FCM through the gateway **and** UnifiedPush (selfhost/degoogled
  users; also the F-Droid requirement).
- [ ] Credential Manager passkeys + Custom Tabs fallback; WalletConnect.
- [ ] v1.1 calls: libmediasoup-android + protoo client; ConnectionService +
  foreground service + full-screen intent for ringing.
- [ ] Distribution: Play Store + F-Droid (we're AGPL — F-Droid build must be
  FCM-free, which UnifiedPush covers) + direct APK on releases.

## Cross-cutting

- Crash/telemetry: **decision needed** (default: none, matching the web app's
  no-tracking stance on selfhost; opt-in crash reports at most).
- i18n: the web app is English-only today; mobile is the moment to introduce
  string catalogs — don't hardcode twice.
- Release trains: desktop can ride develop; mobile needs slower, versioned
  releases against the Phase 0 compatibility policy.

## Decisions needed

| # | Decision | Options / recommendation |
|---|---|---|
| 1 | Distribution model | One official multi-instance app (Element/Mastodon model) — **recommended**; per-instance whitelabel builds are a services offering later |
| 2 | Push gateway | Publisher-run gateway for APNs/FCM (Matrix/Sygnal model) + UnifiedPush; requires us to operate a small always-on service |
| 3 | iOS token features | Hide Spark purchase/staking on iOS non-US storefronts; US storefront may use external-purchase links (post-2025 3.1.1 rules); wallet *login* is fine everywhere |
| 4 | Mobile code sharing | Spec-driven codegen, no shared runtime (**recommended**) vs Kotlin Multiplatform core |
| 5 | Electron renderer source | Remote-load instance web app (**recommended**) vs bundled frontend |
| 6 | F-Droid | Yes (AGPL-consistent) — implies UnifiedPush path is non-optional |
| 7 | Telemetry | None / opt-in crash only (**recommended**) |
| 8 | Calls in mobile v1 | Out (v1.1) — **recommended**; halves time-to-first-release |

## Sequencing & rough effort

```
Phase 0 (API contract, push design, blocking)   ~3-4 weeks, server-side
Phase 1 (Electron)                              ~4-8 weeks, parallel to Phase 0 after week 1
Phase 2 (foundations + conformance suite)       ~2-3 weeks
Phase 3 (iOS MVP)        ~3-4 months ─┐  parallelizable if staffed separately
Phase 4 (Android MVP)    ~3-4 months ─┘
Calls on mobile (v1.1)                          ~6-8 weeks per platform
```

Electron delivers user-visible value in weeks and forces none of the hard
decisions; Phase 0 is cheap and de-risks everything; mobile is the long game
and should not start before Phase 0 lands and decisions 1–4 are made.

## Rules

- Phase 0 API artifacts live in `docs/api/` and are normative once merged —
  client repos consume them, they do not reverse-engineer the web client.
- Mobile repos start as separate repositories (`commonground-ios`,
  `commonground-android`, `commonground-desktop`) unless the maintainer prefers
  a monorepo — decide before Phase 1 CI work.
- Every phase updates this file; when a phase ships, its section dissolves into
  `docs/` per the living-documentation convention.
