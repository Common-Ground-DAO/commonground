# End-to-end browser suite

Drives real Chrome against a running Common Ground instance, the way a
person uses it: sign-up, login, communities, real-time chat, images,
settings, calls, articles, plugins — with global guards that fail a flow on
any uncaught page error, error-boundary screen, console error, CSP
violation, unexpected API error or request to a URL with an `undefined` /
`null` path segment, also when the flow's own steps succeed.

- **No local Chrome, no new dependencies.** The suite runs inside the
  backend image (`cryptogram/backend`, or the `cg-e2e/backend` the disposable
  instance builds), which ships a sha256-pinned Chrome for Testing and the
  matching `puppeteer` (`docker/backend/fetch_chrome.sh`, `srv/package.json`).
  The sources are TypeScript run directly by Node's type stripping; `e2e/`
  has no `node_modules` of its own.
- **Every flow is independent**: fresh browser contexts, its own users and
  data with unique names.

## Run it

```bash
# the disposable instance (own compose project cg-e2e, own image tags cg-e2e/*)
./run.sh e2e_instance build      # typecheck + lint + frontend build (~4 GB RAM) + images from this checkout
./run.sh e2e_instance up         # fresh secrets, fresh volumes, Caddy local CA
./run.sh e2e --instance          # all flows
./run.sh e2e --instance --flow reload --reload-iterations 20
./run.sh e2e_instance down       # containers, volumes and generated files

# any other instance (e.g. the cg.test VM with "tls internal")
e2e/run.sh --url https://cg.test --ca /path/to/root.crt --add-host cg.test:192.0.2.10
```

`./run.sh e2e …` and `e2e/run.sh …` are the same (`run.sh` changes into
`docker/` first, so give file arguments as absolute paths there).

`instance.sh build` runs `yarn install`, `typecheck`, `lint`, `build` and
`check:html-rewrite` in the checkout like `selfhost.sh build` does: it
**overwrites the checkout's `node_modules/` and `build/`**. `down` removes
the stack by its compose project name (also when `e2e/.instance/` is gone),
its volumes, the generated files and the builder's `<project>-yarn-cache`
volume. Both scripts use only the local Docker daemon: a non-default Docker
context or `DOCKER_HOST` is refused unless `--allow-context` is given.

Options (`e2e/run.sh --help` shows the suite's own):

| Option | |
|---|---|
| `--instance` | target the disposable instance: its URL (`https://cg-e2e.test`), CA, docker network and its Mailpit |
| `--url <url>` | instance under test |
| `--ca <file>` | PEM root of the instance's private CA (self-host `CG_TLS_MODE=internal`: `docker/selfhost/selfhost.sh compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`) |
| `--spki <hash>` | accept an extra certificate key pin instead of / in addition to `--ca` |
| `--add-host host:ip`, `--network <net>` | name resolution / docker network of the runner container |
| `--mailpit <url>` | Mailpit API to read sign-up codes from (instances that send mail) |
| `--flow <id>[,<id>]` | run only these flows or groups (`chat-sync` = the chat-sync acceptance flows, see below); `--list` shows the ids and groups |
| `--reload-iterations <n>` | iterations of the reload flow (default 20) |
| `--reload-modes <m,…>` | reload modes to rotate through (validated; default all available); `session-expired` needs `E2E_REDIS_URL` — the instance's Valkey, which `--instance` passes through the environment, never on a command line |
| `--screenshots` | screenshot after every step (always on failure) |
| `--flow-timeout <s>`, `--slow-mo <ms>` | per-flow timeout (default 240 s), slow motion for debugging |
| `--image <image>` | runner image (default: `cg-e2e/backend` if built, else `cryptogram/backend`) |
| `--out <dir>` | results directory (default `e2e/results/<timestamp>`, `e2e/results/latest` links the last run) |

Exit code: 0 the flows passed or were skipped and at least one passed; 1 a
flow failed (a flow that skips after its guards recorded issues counts as
failed) or nothing passed; 2 the suite could not start. Results: `report.json` (per flow: steps, timings, every
guard finding — failing and allowlisted —, expected API errors, notes and
metrics) and screenshots of every failed step under `<out>/<flow>/`.

### Against a real instance

- **Certificates.** A publicly trusted certificate needs nothing. For a
  private CA pass `--ca`: the suite verifies the chain each port (443, 4443)
  presents against it (`node:tls`, host name included) and then pins only
  the **leaf** certificates' keys in Chrome
  (`--ignore-certificate-errors-spki-list`) — Chrome for Testing cannot
  import a root CA without NSS tools. Pinning an intermediate or root key
  would make any server with that (public) intermediate acceptable for any
  host; a leaf key is this instance's alone. A pinned leaf counts as valid:
  secure context, service worker and WebAuthn work. Caddy renews internal
  leaves with a new key, so the run refuses to start when a leaf expires
  within 20 minutes (and warns below an hour).
- **Accounts.** Flows sign up their own users. The backend allows **20
  sign-ups per client address and hour (50 per day)**; the disposable
  instance's edge maps a per-browser cookie to the client address
  (`e2e/Caddyfile.e2e`, test only), a real instance does not — a full run
  there needs about a dozen sign-ups, which fits, but repeated full runs
  within an hour do not.
- **Limit messages.** `E2E_AUTH_LIMITS='{"createUser.hour":1}' e2e/instance.sh
  compose up -d api` restarts the disposable instance's api with single auth
  limits lowered (`CG_TEST_AUTH_LIMITS`, `srv/util/authLimits.ts`; it can
  only lower them), to see a limit message without hundreds of requests.
- **Mail.** An instance that sends mail verifies the address before the
  account exists; without `--mailpit` the flows that need a user skip with a
  message.
- **Internet access** from the runner is needed by: `settings` (the
  WalletConnect QR views need the WalletConnect relay; without it no QR
  renders and the step fails), `article-plugin` (the YouTube player in the
  embed and the plugin page `https://example.org/` load from the internet;
  the flow checks the iframes' `src`, so it passes offline unless the
  third-party frames' load errors reach the console — if they do, allowlist
  them by URL, narrowly). All other flows need only the instance.

## The flows

| id | what it covers |
|---|---|
| `anonymous` | home page in light and dark scheme, `window.__CG_INSTANCE__`, service worker registers and controls the page, deep links to a community and a channel in a fresh context |
| `auth` | sign-up with password (ALTCHA + mailed code), logout, wrong-password message, login by email and by username; a second browser signed in to the same account is signed out ("You were signed out") when the password changes in the first, and signs in again with the new one; sign-up with a passkey (CDP virtual authenticator), logout, passkey login |
| `reload` | reload robustness: N reloads (plain, hard reload bypassing cache + service worker, navigation), each followed immediately by sending a message, opening the settings and every few iterations creating a community. Modes (`--reload-modes`, default: all available): `natural`, `reordered` (responses of requests sent while the device login is out are delivered after it), `interrupted` (the page is reloaded again while the previous load's device login is in flight), `cookie-cleared` (the browser has lost its session cookie), `session-expired` (the session is deleted server-side in Valkey — needs `E2E_REDIS_URL`, which `--instance` sets) and `force-reload-cold-sw` (the service worker is stopped over CDP — the guards' worker sessions are detached first, see below — then the page is reloaded, alternating a plain reload through the cold worker and a hard reload, `Page.reload {ignoreCache}`, which bypasses the worker: an uncontrolled page with a cold worker; the indicator must show "connected" within 12 s of the load — "hidden", i.e. never connected, fails in this mode). Fails on `LOGIN_REQUIRED`, a lost message, an offline/disconnected connection indicator or any guard issue; `report.json` has the per-iteration results, the failure rate per mode and "cookie regressions" (a `Set-Cookie` of an outdated session id after the device login) as diagnostics |
| `community-chat` | community + channel, a second user joins, messages in both directions arrive over the websocket without a reload, a reaction, an edit (live in the other browser, with its "edited" marker) |
| `images` | image attachment in a message and a profile picture, served via `/files/` |
| `settings` | profile edit; passkey add, rename, remove — the removal after a device-only re-login goes through the "Confirm it's you" step-up dialog; Accounts → Add Wallet → the RainbowKit modal: every entry that works without an extension (QR or "Get" view) |
| `call` | two users, fake camera/microphone: start, join, audio bytes both ways (RTCPeerConnection stats), leave, end; reload afterwards, and with the call camera unplugged |
| `article-plugin` | article with a YouTube embed, read in a fresh anonymous context; a community plugin iframe created by the community owner (fails if the owner cannot create one) |
| `cs-call-chat` | E1, three variants with a member and a call each: plain, skew (B's clock 2 s ahead, B's message reads — `loadMessages` or `getChanges` — answered 2.5 s late), then public (a call whose only role permission is the Public role's, started through `Community/startCall` with custom role permissions like "Limit Access" does: B reaches it, its chat and its room through the Public role alone — a call without custom permissions grants the Member role). B opens the call while A posts its first message: B shows it without a reload and keeps it after the (late) first page arrives; a second message arrives live; B has joined the call's room (the owner's peer card) |
| `cs-unread-tabs` | E2: B has two tabs (tab 2 in the background); A posts in another channel, tab 1 shows the unread dot; B reads it in tab 1, reloads tab 1, brings tab 2 to the front, reloads it: the dot stays cleared everywhere and neither the server's `lastRead` (`Message/getSyncState`, or `Community/getCommunityDetailView` on a server without it) nor any `lastRead` a tab sends ever moves backwards |
| `cs-reconnect` | E3: B offline (emulated offline + open sockets closed); A posts three messages and edits an older one; B back online shows all of it in order (the edit with its "edited" marker) without scrolling or a reload, connected within 12 s; a message after the reconnect arrives live |
| `cs-multi-tab` | E4: two tabs of B in one channel; A posts, B switches tabs and writes from tab 2, both tabs reloaded: every tab in front shows every message in order, is connected, no tab has an empty channel |
| `cs-notifications` | E5: A mentions B twice: the badge goes up by one each time and holds; B opens one notification: down by one and holds; after a reload the badge equals `Notification/getUnreadCount`; a second tab of B in the background (home page) shows the same badge at every step |
| `cs-login-time` | E7: six page loads of a user in a channel with history; per load the time to the device login's OK, to "connected", to the first and to all messages (report: `loginTimeSamples`, `loginTimeSummary`); fails above 10 s to logged-in-and-connected or to the first message |
| `cs-split-frozen` | E8: B's channel in two windows side by side (both visible): A's posts show in both live; B's tab hidden behind another tab and frozen (`Page.setWebLifecycleState`), A posts and edits, the tab resumed: connected within 12 s and caught up (the edit with its "edited" marker); with the service worker stopped, a plain reload and a hard reload (uncontrolled page): each connected within 12 s of the reload |

The other flows wait for the device login of a page load to finish before
they act (`waitAppReady`) and navigate client-side once the app is loaded
(`navigate`), like a person clicking links — provoking the session race is
the `reload` flow's job. Init requests of a page load can still hit it; the
guards report that wherever it happens.

### What the guards do not see

- **Cross-origin iframes** (YouTube embed, plugin pages, the WalletConnect
  frames) run in their own renderer. Their uncaught exceptions and console
  messages reach the guards only as far as puppeteer forwards them for
  out-of-process frames; the `securitypolicyviolation` listener and the CDP
  Audits session cover the top document and same-origin frames. The app's
  own CSP decisions about a frame (`frame-src`) are reported in the parent
  document and are covered; a third-party page's violations of its *own*
  policy are not.
- **Popups** a page opens get the same guards as the page (attached when
  the target appears, so the very first messages of a popup can be missed),
  but no virtual authenticator and no device-login tracking; no flow relies
  on a popup.

### The chat-sync flows

`cs-*` are the acceptance scenarios E1–E5, E7, E8 of the chat-sync package
(messages and read state in memory + server, independent tabs with
catch-up: docs/frontend "Chat stores", docs/realtime "Tab Coordination").
E6, offline display, needs message persistence, which is not built (open
item in `docs/todo/TODO.md`). They are black-box: they act through the UI and
read the DOM, the network, CDP and the app's own API routes — never the
app's data-layer objects — so they stay valid while that layer is
replaced. They were written before the rewrite and are red where the code
they were written against is buggy. Every one of them fails when a tab's
connection indicator shows "Disconnected" or does not reach "connected"
within 12 s (`assertConnected`, `lib/live.ts`). "Shows a message" means
in the list and, for the newest one waited for, in view inside the list's
scroll container — a list that does not follow new messages to the bottom
fails (`waitMessagesShown`). Every poll's `page.evaluate` has its own 10 s
limit (`lib/within.ts`), so a page that stops answering fails a poll, not
the whole step after the 120 s protocol timeout.

What the flows rely on from the app (an unwritten contract — change it
together with `lib/app.ts`/`lib/live.ts`): the connection indicator
`#cg-connection-indicator` with the class `cg-connection-indicator-<state>`
(`hidden`, `connecting`, `connected`, `disconnected`, `offline`, …); the
stored user under the `localStorage` key `CG_CURRENT_USER` (readiness and
login tracking); `.message-item` / `.message-item-message` for messages, confirmed by the
server when the item's `.message-item-content` has `data-timestamp` and no
`data-send-status` (present while a send or edit is in flight or failed —
`data-timestamp` alone is on pending sends too),
`.text-channel-item-info[title].item-unread` for the unread dot and
`.notification-count` in the main menu for the badge.

```bash
./run.sh e2e --instance --flow chat-sync                     # the seven flows (~10 min)
./run.sh e2e --instance --flow cs-reconnect,cs-multi-tab     # single ones
./run.sh e2e --instance --flow reload --reload-modes force-reload-cold-sw --reload-iterations 5
```

Runtime on the dev VM: about 8–10 minutes for everything (the reload flow
with 20 iterations is the biggest part); a single flow takes 20–90 s.

## Checks

Scripted checks of server-side behaviour that a browser flow cannot provoke,
run against the disposable instance (never the dev stack — they refuse
`E2E_PROJECT=docker` / `cg-selfhost`). They insert their own rows into the
instance's database, so run them after the suite.

| script | what it checks |
|---|---|
| `checks/call-sweep.sh` | the jobs process's call-ending sweeps (docs/backend §6, `callUpdateEmitter.ts`): calls of a call server whose heartbeat stopped, event and scheduled calls, calls everyone left, and that each ended call is published as `cliCallEvent delete` (Valkey `PSUBSCRIBE`); calls ended at job-runner startup (restarts the job-runner); restarting an ended event call; `updateCallPermissions` without role permissions; the monotonic, clamped `setChannelLastRead`. Output: `results/call-sweep-<timestamp>/` (or `CHECK_OUT`) |

```bash
./run.sh e2e_instance up && ./run.sh e2e --instance   # suite first: its data provides a community and a user
e2e/checks/call-sweep.sh                              # E2E_PROJECT as for instance.sh
```

## Adding a flow

1. `src/flows/NN-name.ts` exporting a `Flow` (`id`, `title`, `run(t)`); add it
   to `src/flows/index.ts`.
2. Open browser contexts with `t.session(name, { colorScheme, authenticator })`
   — each is guarded automatically, popups included.
3. Wrap user-visible actions in `await t.step('what a person does', async () => …)`:
   failures are attributed to the step and screenshotted.
4. Use the helpers: `lib/account.ts` (sign-up, login), `lib/app.ts`
   (navigation, user menu, communities, channels, messages), `lib/ui.ts`
   (find/click by visible text, fill, wait). Prefer visible texts, input
   names and placeholders over CSS structure.
5. An API error the flow provokes on purpose goes into
   `t.expectApiErrors(['NOT_ALLOWED'], async () => …)`; everything else fails.
6. Several tabs of one user: `t.tab(session, name)` opens a further guarded
   page in the session's browser context (same cookies, storage, service
   worker), `{ window: true }` in a window of its own; `lib/tabs.ts`
   (`openTab`, `showTab`, `expectVisibility`). Tabs of one window are really
   hidden behind the front tab (`document.visibilityState`), only their timers
   run at full speed (`src/main.ts` disables throttling); windows are visible
   side by side.
7. Browser conditions through CDP, `lib/cdp.ts`: `setOffline` (emulated
   offline does not close an open WebSocket in Chrome, so the helper closes
   the page's sockets too — with a clean `close()` from the page, code 1005
   on its side, not the abnormal 1006 of a dead link; install
   `trackWebSockets`/`prepareLivePage` before the load), `holdResponses`
   (Fetch at the response stage), `setClockOffset` (a `Date` replacement in
   the page only — its workers and the browser keep the real clock),
   `setLifecycle` (frozen/active — nothing may evaluate in a frozen page,
   keep freeze and resume in one step), `stopServiceWorkers` (detaches the
   guards' debugger sessions from the workers first: a worker that restarts
   with one still attached waits for the debugger and never runs),
   `coldServiceWorkerReload` (`plain`: through the cold worker;
   `ignore-cache`: `Page.reload {ignoreCache}` bypasses the worker, so the
   page loads uncontrolled). Guard findings such a condition causes on
   purpose go into `t.expectFailures(offlineFailures(name), …)`.
8. `t.skip('reason')` when the instance lacks a feature; `t.note()` for
   findings that should not fail the flow (prefix `FINDING:`), `t.metric()`
   for numbers that belong in the report.

Type-check (inside the runner image, with its puppeteer types):
`docker run --rm -v "$PWD/e2e:/dist/e2e:ro" -w /dist/e2e cg-e2e/backend node /dist/node_modules/typescript/bin/tsc -p tsconfig.json`

## Allowlist policy

`src/allowlist.ts` lists console/network noise the guards ignore. An entry is
only for noise **outside the app's control or caused by the test environment
itself** (third-party SDKs, browser behaviour of automated contexts), says
why it is harmless, and is as narrow as possible (issue kind + a specific
text and/or URL pattern). Never allowlist an error of the app to get a run
green — fix it or let the flow fail. Uncaught page errors and the error
boundary screen are never allowlisted. Allowlisted findings still appear in
`report.json` (`allowed`).
