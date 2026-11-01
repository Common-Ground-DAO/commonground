# End-to-end browser suite

Drives real Chrome against a running Common Ground instance, the way a
person uses it: sign-up, login, communities, real-time chat, images,
settings, calls, articles, plugins — with global guards that fail a flow on
any uncaught page error, error-boundary screen, console error, CSP
violation or unexpected API error, also when the flow's own steps succeed.

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
| `--flow <id>[,<id>]` | run only these flows; `--list` shows the ids |
| `--reload-iterations <n>` | iterations of the reload flow (default 20) |
| `--reload-modes <m,…>` | reload modes to rotate through (validated); `session-expired` needs `E2E_REDIS_URL` — the instance's Valkey, which `--instance` passes through the environment, never on a command line |
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
| `reload` | reload robustness: N reloads (plain, hard reload bypassing cache + service worker, navigation), each followed immediately by sending a message, opening the settings and every few iterations creating a community. Modes (`--reload-modes`, default: all available): `natural`, `reordered` (responses of requests sent while the device login is out are delivered after it), `interrupted` (the page is reloaded again while the previous load's device login is in flight), `cookie-cleared` (the browser has lost its session cookie) and `session-expired` (the session is deleted server-side in Valkey — needs `E2E_REDIS_URL`, which `--instance` sets). Fails on `LOGIN_REQUIRED`, a lost message, an offline/disconnected connection indicator or any guard issue; `report.json` has the per-iteration results, the failure rate per mode and "cookie regressions" (a `Set-Cookie` of an outdated session id after the device login) as diagnostics |
| `community-chat` | community + channel, a second user joins, messages in both directions arrive over the websocket without a reload, a reaction, an edit |
| `images` | image attachment in a message and a profile picture, served via `/files/` |
| `settings` | profile edit; passkey add, rename, remove — the removal after a device-only re-login goes through the "Confirm it's you" step-up dialog; Accounts → Add Wallet → the RainbowKit modal: every entry that works without an extension (QR or "Get" view) |
| `call` | two users, fake camera/microphone: start, join, audio bytes both ways (RTCPeerConnection stats), leave, end; reload afterwards, and with the call camera unplugged |
| `article-plugin` | article with a YouTube embed, read in a fresh anonymous context; a community plugin iframe created by the community owner (fails if the owner cannot create one) |

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

Runtime on the dev VM: about 8–10 minutes for everything (the reload flow
with 20 iterations is the biggest part); a single flow takes 20–90 s.

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
6. `t.skip('reason')` when the instance lacks a feature; `t.note()` for
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
