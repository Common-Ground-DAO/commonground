# Self-hosting Common Ground

This guide runs the complete Common Ground stack on **one server**. A machine
with 4–8 cores and 16 GB RAM is sufficient; the stack idles at well under
2 GB — RAM is mostly consumed under load (calls, many users, image
processing).

The self-host profile differs from the dev setup (`run.sh`): real TLS via
Let's Encrypt, production semantics on your own domain, generated secrets,
and no dev-chain/test-contract services. For a LAN/VM test instance without
public DNS, see [Local test instance](#local-test-instance-no-public-dns).

## Prerequisites

- A Linux server with Docker + Docker Compose v2, ports **80, 443, 4443
  (tcp)** and **40000–40099 (udp and tcp)** reachable from the internet (the
  last two only if you run voice/video calls — see
  [Optional services](#optional-services-calls-blockchain)). Run the scripts
  as a user in the `docker` group or as root; the builder container runs with
  the uid/gid of whoever ran `init.sh`.
- **x86_64 (amd64) for the full feature set.** The images are built on the
  server itself. On arm64 everything builds and runs except the social preview
  images (link cards for communities, events and plugins): they are rendered
  by Chrome for Testing, which Google publishes for linux x64 only — the build
  prints a warning and skips it.
- **Kernel and calls.** The call service uses mediasoup's prebuilt media
  worker, which mediasoup publishes per kernel major version (currently 6 and
  7); the build picks the one matching the server's kernel (`uname -r`).
  Kernels older than 6 (e.g. Ubuntu 22.04's 5.15, older WSL2) get the kernel 6
  build, which the build then test-runs. A kernel newer than the pinned
  builds stops the build with instructions — also with `CG_ENABLE_CALLS=false`,
  since every backend service shares one image; update to a Common Ground
  release that pins that kernel's build.
- **Memory for builds.** The frontend build (typecheck, lint, Vite) peaks at
  about 4.2 GB on top of whatever else runs. On an 8 GB server without swap it
  gets OOM-killed while the stack is up (measured 2026-10-31: the running
  stack used ~4.4 GB, `onchain` alone ~2 GB) — so `selfhost.sh update`, which
  builds before restarting, fails there. Add swap (e.g. 4 GB) or stop the
  stack before building (`selfhost.sh down`, then `build` and `up`).
- A domain with a DNS record pointing at the server, e.g. `chat.example.org`.
  Passkeys are bound to that host; no second (`id.`) domain is needed. (An
  `.env.selfhost` from before 2026-10-31 still carries `CG_ID_DOMAIN`; it is
  ignored unless the instance runs as the legacy CG ID gateway, and its DNS
  record can go.)
- For email (login codes, verification, notifications) either outbound
  **port 25** for the built-in mail relay plus a few DNS records, or an
  external SMTP server — see [Email](#email).

## Setup

```bash
git clone https://github.com/Common-Ground-DAO/commonground.git
cd commonground/docker

# 1. Generate secrets, S3 config and internal certs
./selfhost/init.sh chat.example.org admin@example.org

# 2. Build everything (frontend, backend, caddy, db) — ~15-20 min
./selfhost/selfhost.sh build

# 3. Start
./selfhost/selfhost.sh up
```

Caddy obtains Let's Encrypt certificates automatically on first start. After
DNS propagates, the app is live at `https://chat.example.org`.

Operating:

```bash
./selfhost/selfhost.sh logs          # follow all logs
./selfhost/selfhost.sh logs api      # follow one service
./selfhost/selfhost.sh stats        # container resource usage
./selfhost/selfhost.sh update       # git pull + rebuild + restart
./selfhost/selfhost.sh down         # stop
./selfhost/selfhost.sh mail-dns     # DNS records for the built-in mail relay
```

## Local test instance (no public DNS)

Let's Encrypt can only issue certificates for names that resolve publicly to
your server. For a test instance on a LAN or a local VM — e.g. to exercise
passkey login, uploads and calls in a real browser — let
Caddy issue every certificate from its own local CA instead:

```bash
./selfhost/init.sh --tls-internal cg.test - - 192.168.122.44
./selfhost/selfhost.sh build
./selfhost/selfhost.sh up
```

- `--tls-internal` writes `CG_TLS_MODE=internal` to `.env.selfhost` (default:
  `acme`). An existing install switches by editing that line — or adding it,
  in an `.env.selfhost` written before the switch existed — and running
  `./selfhost/selfhost.sh up`, which recreates the `caddy` container.
  Switching back to `acme` also needs a real `CG_ACME_EMAIL`; with an empty
  one Caddy refuses its config and keeps restarting.
- The first `-` stands in for the ACME email, which this mode does not use;
  the second for the CG ID domain (only for the legacy CG ID gateway).
- The fourth argument (the IP) is **required** here: it becomes
  `MEDIASOUP_ANNOUNCED_IP`, the address browsers send call media to, so it must
  be the address they reach the machine at — its LAN IP, not the public IP
  `init.sh` would otherwise detect.
- Pick names under a TLD that never resolves publicly, such as `.test`.
- Email starts **off** (`CG_ENABLE_MAIL=false`, empty `SMTP_HOST`), so a test
  instance never delivers mail to the internet. To try the built-in relay
  anyway, set `CG_ENABLE_MAIL=true` and `SMTP_HOST=mail` (see [Email](#email)).

### Name resolution

There is no DNS for these names, so every **client** machine needs them in its
hosts file (`/etc/hosts` on Linux/macOS,
`C:\Windows\System32\drivers\etc\hosts` on Windows):

```
192.168.122.44  cg.test
```

### Trusting Caddy's root certificate

On its first start Caddy creates its CA in the `caddy-data` volume, at
`/data/caddy/pki/authorities/local/root.crt` (next to `root.key`, the CA's
private key — never hand that out). Copy the certificate out of the container:

```bash
./selfhost/selfhost.sh compose cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/cg-root.crt
```

(Use an absolute destination — `selfhost.sh` runs from `docker/`.) Then copy
it to every client machine (e.g. `scp server:/tmp/cg-root.crt .`) and trust it
there; the commands below expect `cg-root.crt` in the current directory:

- **Debian/Ubuntu:** `sudo cp cg-root.crt /usr/local/share/ca-certificates/cg-test-root.crt && sudo update-ca-certificates`
  (the file name must end in `.crt`)
- **Fedora/RHEL:** `sudo cp cg-root.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain cg-root.crt`
- **Windows** (elevated prompt): `certutil -addstore -f Root cg-root.crt`
- **Firefox** keeps its own certificate store: Settings → Privacy & Security →
  Certificates → View Certificates → Authorities → Import…, then tick "Trust
  this CA to identify websites".
- **Chrome/Chromium on Linux** read the NSS database in `~/.pki/nssdb`; if the
  system store is not enough, import there:
  `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "CG test root" -i cg-root.crt`
  (`certutil` is in `libnss3-tools`).

Trust the **root**, don't click through certificate warnings: Caddy's leaf
certificates live only 12 hours (the intermediate is short-lived too, and both
are renewed automatically), a warning exception would be needed separately for
port 4443 (call signalling), and Chromium-based browsers refuse passkeys and
service workers on a connection with certificate errors. The root itself is valid for about ten
years.

### Reusing one root across reinstalls

Every fresh `caddy-data` volume (new VM, `down -v`) gets a new root, which
means importing it everywhere again. To keep one root, save `root.crt` **and**
`root.key` from the first install and seed them into the new volume before
Caddy first starts — Caddy then loads that root and issues a fresh
intermediate and leaf certificates from it:

```bash
# once, on the first install (root.key is a CA key: keep it private)
mkdir -p -m 700 /root/cg-ca
./selfhost/selfhost.sh compose cp caddy:/data/caddy/pki/authorities/local/root.crt /root/cg-ca/root.crt
./selfhost/selfhost.sh compose cp caddy:/data/caddy/pki/authorities/local/root.key /root/cg-ca/root.key

# on every reinstall: after init.sh, before the first `up`
mkdir -p /tmp/cg-ca-seed/caddy/pki/authorities/local
cp /root/cg-ca/root.crt /root/cg-ca/root.key /tmp/cg-ca-seed/caddy/pki/authorities/local/
./selfhost/selfhost.sh compose create caddy        # creates the container and its volumes, doesn't start it
./selfhost/selfhost.sh compose cp /tmp/cg-ca-seed/caddy caddy:/data/
rm -rf /tmp/cg-ca-seed
./selfhost/selfhost.sh up
```

If Caddy already started with a fresh volume, run `./selfhost/selfhost.sh down`
and `docker volume rm cg-selfhost_caddy-data` first. Seeding the volume keeps
the Caddyfile unchanged; Caddy's `pki` global option could point at the files
instead, but would need them mounted into the container on every install.

## How instance identity works

Historically the frontend decided "am I prod?" by matching against
`app.cg` — any other domain silently ran in dev mode. Self-hosted instances
instead declare their identity at serve time: Caddy serves
`/instance-config.js`, rendered from `.env.selfhost` settings,

```js
window.__CG_INSTANCE__ = {"deployment":"prod","appUrl":"https://chat.example.org",...};
```

and every page of the app loads it. See `src/common/instance.ts`. This means
the same build artifacts — and the same Caddy image — work for any domain:
the domain is configuration, not code.

## Optional integrations

All third-party services are optional; leave their keys empty in
`.env.selfhost` to disable the corresponding feature:

All integrations degrade gracefully: the server derives capability flags
from which keys are configured and ships them to the frontend via the
instance config, so unavailable features are hidden or replaced with an
honest message instead of breaking.

| Env keys | Feature | Without it |
|---|---|---|
| `SMTP_HOST` (+ `SMTP_*`, `EMAIL_FROM`; see [Email](#email)) | email verification, one-time-code login, event mails, newsletters | password/passkey/wallet login still work; OTP login and newsletter UI hidden; event RSVP works without verified email |
| `CAPTCHA_PROVIDER`, `ALTCHA_HMAC_KEY`, `CG_RECAPTCHA_SITE_KEY`, `GOOGLE_RECAPTCHA_SECRET_KEY` | signup captcha (see [Captcha](#captcha)) | defaults to ALTCHA; captcha is never silently skipped |
| `TWITTER_API_KEY`, `TWITTER_API_SECRET` | Twitter/X login and account linking | X buttons hidden |
| `CG_GIPHY_API_KEY` | GIF picker in the composer | GIF picker hidden |
| `CG_WALLETCONNECT_PROJECT_ID` | WalletConnect wallets (QR / mobile deep-link) | injected wallets (MetaMask etc.) still work |

## Optional services (calls, blockchain)

Two of the backend services can be left out of the deployment entirely. Set
either switch to `false` in `.env.selfhost` and run `./selfhost/selfhost.sh up`
— the wrapper turns them into Docker Compose profiles, so the container is
never created, and `up` (also as part of `update`) stops and removes it if it
was running before (`compose rm -sf`; switching a profile off is not enough
for Compose to remove a container). Running `up` again changes nothing.

| Switch | Off means | What still works |
|---|---|---|
| `CG_ENABLE_CALLS=false` | no `mediasoup` container | everything except voice/video calls. The call UI is hidden through the instance config — the sidebar start-call button and call list, and in the events UI the Group Call / Broadcast event types and the "Start Event" / "Join now" buttons (events themselves stay, as external-link events). Nobody is offered a call that cannot happen. On a running instance, `up` removes the `mediasoup` container and Caddy's `:4443` site, so ports 4443/tcp and 40000–40099/udp+tcp are no longer published. |
| `CG_ENABLE_BLOCKCHAIN=false` | no `onchain` container | wallet login (EVM/SIWE), communities, messaging, events, bots, premium/Spark balances that already exist. |

Both default to `true`; leaving them out of `.env.selfhost` keeps the full
stack, so existing instances are unaffected by an update. The mail relay is
switched the same way (`CG_ENABLE_MAIL`), but an unset switch means off — see
[Email](#email).

### NSFW image filter

A third switch, `CG_ENABLE_IMAGE_FILTER` (default `true`), is not a Compose
profile — it controls the server-side NSFW image filter that runs inside the
`api` and `onchain` containers and rejects pornographic uploads before they
reach object storage. The model (~87 MB, Apache-2.0) is baked into the
backend image; no extra service, no network access at runtime. Setting it to
`false` disables the filter and (via the instance config) the client-side
pre-upload warning.

Tuning/swapping:

- `CG_IMAGE_FILTER_THRESHOLD` — NSFW probability above which an image is
  rejected (default `0.8`).
- `CG_IMAGE_FILTER_MODEL_PATH` — mount any Transformers.js-layout image
  classifier into the `api` and `onchain` containers and point this at its
  directory. It must contain `config.json`, `preprocessor_config.json` and
  `onnx/model_quantized.onnx`; labels named `nsfw`, `porn`, `hentai` or
  `explicit` count toward the reject score. Beware: models exported without
  a `preprocessor_config.json` (e.g. straight from timm) load fine but
  silently produce garbage scores.

**What `CG_ENABLE_BLOCKCHAIN=false` costs in detail** — the `onchain` service
is the only component that talks to a chain, so without it:

- token-gated roles are never re-evaluated (existing assignments stay as they
  are — nobody is stripped of a role, but nobody gains one either),
- wallet token balances are never refreshed,
- staking positions are never indexed and no Spark accrues from them,
- Spark purchases are never credited (the payment is detected on-chain),
- LUKSO Universal Profile login stops working,
- adding a new token contract to a community fails with a clean "not found".

Those API calls now fail immediately with `SERVICE_UNAVAILABLE` instead of
waiting out a 10-second timeout. Everything else — including connecting and
logging in with an EVM wallet, which is verified by signature in the API
process — is unaffected.

## Email

Common Ground sends its mail over SMTP: one-time login codes, email
verification, event mails, the weekly digest and community post
notifications. Pick one of two setups in `.env.selfhost`:

### Built-in mail relay (`CG_ENABLE_MAIL=true`, the `init.sh` default)

(Not for `--tls-internal` test instances, which start with email off.)

A small send-only mail server ([maddy](https://maddy.email), service `mail`)
runs next to the app. The app hands it every mail over an internal network;
the relay signs it with DKIM and delivers it directly to the recipients' mail
servers, retrying for about three days when a server is unreachable or
greylists. It accepts mail only from the app (relay login + your sender
domain) and has no public port — it receives no mail.

The settings `init.sh` writes — `SMTP_*` is the app's login for the relay
(`SMTP_SECURITY=none` is fine for this internal hop only), `MAIL_DOMAIN` must
be the domain of `EMAIL_FROM`, and `MAIL_HOSTNAME` is the name the relay
greets other mail servers with:

```bash
CG_ENABLE_MAIL=true
SMTP_HOST=mail
SMTP_PORT=587
SMTP_SECURITY=none
SMTP_USER=cg-app
SMTP_PASSWORD=<random, generated by init.sh>
EMAIL_FROM=no-reply@chat.example.org
EMAIL_FROM_NAME="Common Ground"
MAIL_DOMAIN=chat.example.org
MAIL_HOSTNAME=chat.example.org
MAIL_DKIM_SELECTOR=cg
```

Before mail is reliably delivered:

1. **Outbound port 25.** Many hosters block it for new servers (or
   entirely); check their documentation and ask them to unblock it. If they
   won't, use an external SMTP server instead (below).
2. **DNS records.** After the first `up` (the relay generates its DKIM key on
   first start), run

   ```bash
   ./selfhost/selfhost.sh mail-dns
   ```

   and publish what it prints: an **SPF** record (which IP may send for your
   domain — merge it into an existing SPF record rather than adding a second
   one), the **DKIM** public key (`cg._domainkey.<domain>`), and a **DMARC**
   policy (start with `p=none`, move to `quarantine`/`reject` once mail
   passes).
3. **Reverse DNS (PTR).** Set at your hoster, not at your DNS provider: the
   server's IP must point to `MAIL_HOSTNAME`, and that name must resolve back
   to the IP. Many receivers reject mail from IPs without a matching PTR.
4. **Warm-up.** A new IP has no sending reputation. Expect the first mails to
   land in spam folders now and then; keep volumes low at first (e.g. don't
   turn on newsletters for a large imported user base on day one), and watch
   `./selfhost/selfhost.sh logs mail`. Tools such as mail-tester.com or a
   mail to a Gmail address ("Show original": SPF/DKIM/DMARC = PASS) show
   whether the records work.

The DKIM private key lives only in the `mail-data` volume (never in the app
containers) — include that volume in your backups, or you'll have to publish
a new DKIM record after a reinstall.

**Bounces** are handled for you: when a recipient's server rejects an address
permanently (e.g. "no such user"), the relay reports it to the app. Once the
same address has bounced on two occasions at least a day apart, the app marks
it as unverified — the user gets no more digest, community-post or event mails
until they verify an address again. Temporary failures are just retried. If
many addresses bounce at once, the app assumes the problem is on your side
(blocklisted IP, DNS records) rather than with the addresses: it unverifies
nobody and logs a warning starting with `!!!` in
`./selfhost/selfhost.sh logs job-runner` — check `mail-dns` and the relay log
then. Details: [docs/email-notifications](../docs/email-notifications/README.md#bounces).

The relay is meant to be the only thing on the server that talks to port 25,
but the app containers have normal internet access too. If you want to
enforce it (e.g. so a compromised container can't send spam directly), block
outbound 25/tcp on the host for every container except the relay, e.g. in the
`DOCKER-USER` iptables chain.

### External SMTP server (`CG_ENABLE_MAIL=false`)

Use your mail provider or a transactional mail service instead — no relay
container runs, and SPF/DKIM are set up as that provider documents:

```bash
CG_ENABLE_MAIL=false
SMTP_HOST=smtp.example.net
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=...
SMTP_PASSWORD=...
EMAIL_FROM=no-reply@chat.example.org
```

`SMTP_SECURITY=tls` (implicit TLS, usually port 465) works too; use
`SMTP_SECURITY=none` only for a relay on the same machine or docker network
(`up` warns otherwise, as does the `api` log). Leave `SMTP_HOST` empty to run
without email. `selfhost.sh up` warns when the settings don't fit together
(e.g. `SMTP_HOST=mail` with the relay off).

Bounces then go wherever your provider sends them (its suppression list or
dashboard, or the `EMAIL_FROM` mailbox); the app doesn't read them.

### Moving from SendGrid

An `.env.selfhost` from before this setup still carries `SENDGRID_API_KEY` /
`MAILCHIMP_*`. Those are no longer read, and until `SMTP_*` is set **email is
disabled** — no login codes, no verification, no notification mails (`up`
says so). Two ways forward:

- **Keep sending through SendGrid**, over its SMTP interface — the same
  account, sender domain and DNS records as before:

  ```bash
  CG_ENABLE_MAIL=false
  SMTP_HOST=smtp.sendgrid.net
  SMTP_PORT=587
  SMTP_SECURITY=starttls
  SMTP_USER=apikey                  # literally "apikey"
  SMTP_PASSWORD=<your old SENDGRID_API_KEY>
  EMAIL_FROM=no-reply@chat.example.org
  ```

  The key needs SendGrid's "Mail Send" permission.
- **Switch to the built-in relay**: copy the email block from a freshly
  generated file (`./selfhost/init.sh` in a scratch checkout) or the lines in
  [Built-in mail relay](#built-in-mail-relay-cg_enable_mailtrue-the-initsh-default),
  set a random `SMTP_PASSWORD` (`openssl rand -hex 24`), run `up`, then
  `mail-dns`. Check that the new SPF record doesn't replace SendGrid's include
  while you still need it.

Then remove `SENDGRID_API_KEY` and `MAILCHIMP_*` and run
`./selfhost/selfhost.sh up`.

### Unsubscribing

Digest and community-post mails carry a one-click unsubscribe link
(`List-Unsubscribe`, RFC 8058), which mail apps show as an "Unsubscribe"
button, plus an unsubscribe link in the footer. Either turns off exactly that
kind of mail for that user; login codes, verification and event mails are
not affected.

## Captcha

Registration is protected by a captcha so open instances don't get flooded
with spam accounts. Unlike before, captcha is **never silently disabled** —
`CAPTCHA_PROVIDER` selects one of three modes:

- **`altcha`** (default) — [ALTCHA](https://altcha.org), a self-hosted,
  privacy-friendly proof-of-work captcha. No third-party keys, no external
  calls, GDPR-friendly. `init.sh` generates an `ALTCHA_HMAC_KEY` for you so
  challenges stay valid across restarts; if you clear it, the backend generates
  one and shares it across processes via Valkey. This is the recommended default
  for public instances.
- **`recaptcha`** — Google reCAPTCHA v2. Set `CAPTCHA_PROVIDER=recaptcha` and
  fill in both `CG_RECAPTCHA_SITE_KEY` (public, injected into the frontend) and
  `GOOGLE_RECAPTCHA_SECRET_KEY` (server-side verification). When
  `CAPTCHA_PROVIDER` is unset but a reCAPTCHA secret is present, reCAPTCHA is
  used automatically (matches the official app.cg setup). Set the provider
  explicitly and fill in **both** keys.
- **`off`** — no captcha. The server logs a loud warning on startup. Only use
  this for local development or fully trusted/private instances.

The backend is the authority: the frontend asks `GET /Captcha/config` at runtime
and renders the widget for whichever provider the server verifies against, so
you only configure the provider in one place. A half-configured reCAPTCHA setup
therefore fails loudly instead of silently: with a secret key but no site key
the registration form shows "Captcha is misconfigured on this instance — please
contact the operator." instead of an unexplained dead signup button, and with
`CAPTCHA_PROVIDER=recaptcha` but no secret key the server logs an error at
startup and rejects every token. When `CAPTCHA_PROVIDER` is unset, a site key
alone no longer flips the frontend to reCAPTCHA — both sides stay on ALTCHA.

## Blockchain RPC endpoints and chains

(Skip this section entirely if you run with `CG_ENABLE_BLOCKCHAIN=false`.)

`init.sh` prefills the `QUIKNODE_*`/`INFURA_LINEA` variables with **free public
RPC endpoints** (the names are historical — any JSON-RPC URL works), so
token-gated roles, balance checks and premium payments work out of the box.
Public endpoints are rate-limited; for larger instances put your own paid
endpoints (QuikNode, Alchemy, Infura, ...) there.

When picking an endpoint yourself, note that the event listener performs
**unfiltered ranged `eth_getLogs`** calls (up to 40 blocks on Arbitrum-family
chains). Many free endpoints restrict that method — all `*.publicnode.com`
endpoints started rejecting it in July 2026, which is why the defaults use
drpc.org and official chain RPCs. Test a candidate endpoint with an
unfiltered `eth_getLogs` over a few blocks before swapping it in.

`CG_ACTIVE_CHAINS` (comma-separated chain keys, e.g.
`eth,arbitrum,xdai,base,matic,lukso`) controls which chains the instance
offers — it drives both the backend chain workers and the chain lists in the
UI (token gating, wallets). Keep it in sync with the endpoints you configure.

Frontend wallet interactions on self-hosted instances use each chain's
default public RPC (CG's own Alchemy key is domain-locked to app.cg and is
not used when an instance config is present).

## Resource tuning

Defaults in `.env.selfhost` are sized for a 16 GB machine:

- `REDIS_MAXMEMORY=1024mb` — the Valkey **state** instance (`redis`):
  sessions, Socket.IO pub/sub, rate limits. It never evicts; when it is full,
  logins fail, so leave headroom.
- `REDIS_CACHE_MAXMEMORY=256mb` — the Valkey **cache** instance
  (`redis-cache`): rebuildable data such as link previews. When full it drops
  its least recently used entries.

  Both limits cover the data only: while the state instance writes its
  snapshot (a forked process), memory use can briefly reach about twice the
  data size, plus allocator overhead. Below 8 GB of RAM the defaults are
  tight next to the rest of the stack.
- `SEAWEED_VOLUME_LIMIT_MB=1024` — SeaweedFS volume chunk size
- mediasoup spawns one media worker per CPU core

Postgres loads `docker/db/postgresql.conf`, sized for the same 16 GB machine
(`shared_buffers=1GB`, `effective_cache_size=4GB`, `work_mem=8MB`; every
setting is commented there). Raise `shared_buffers` and
`effective_cache_size` for larger instances, lower them for smaller ones.

> **If logins stop sticking** (users are logged out right after logging in,
> the API logs `OOM command not allowed`): the Valkey state instance is full,
> most likely of sessions — the backend stores a session for every API request
> without a session cookie (`saveUninitialized: true` in
> `srv/util/express.ts`), so crawlers or scripts can fill it. Check with
> `./selfhost/selfhost.sh compose exec redis valkey-cli INFO memory`
> (`used_memory_human` vs. `maxmemory_human`), then remove all sessions
> (everyone is logged out, rate limits stay):
>
> ```bash
> ./selfhost/selfhost.sh compose exec redis sh -c "valkey-cli --scan --pattern 'sess:*' | xargs -r -n 500 valkey-cli UNLINK"
> ```
>
> or clear everything with `… compose exec redis valkey-cli FLUSHDB`. A
> restart does not help: the snapshot brings the sessions back. Afterwards
> raise `REDIS_MAXMEMORY` or block the source of the requests. Details:
> `docs/infrastructure/README.md` (Valkey section).

> **Upgrading from a release that ran Redis 6.2** (before 2026-10-31): the
> `redis` service now runs **Valkey** (a drop-in, Redis-compatible server), and
> a second instance `redis-cache` is added. Valkey itself needs nothing
> beyond `./selfhost/selfhost.sh update`: it recreates `redis` with the new
> image, starts `redis-cache` and creates the `valkey-data` volume. **But the
> same release moves the database to PostgreSQL 18** — if your instance still
> runs PostgreSQL 14, `update` fails at `up`; follow
> [PostgreSQL 18](#postgresql-18) first (its dump/restore steps bring Valkey
> along). Everyone is logged out
> once — the old Redis kept nothing on disk; from now on sessions survive
> restarts and updates. Your `.env.selfhost` keeps working unchanged: an old
> `REDIS_MAXMEMORY=1536mb` now applies to the state instance alone, and the
> cache instance takes its default `256mb` (add `REDIS_CACHE_MAXMEMORY` to
> change that). Recommended once on the host: `sysctl vm.overcommit_memory=1`
> (persist it in `/etc/sysctl.d/`) — Valkey forks for its background saves and
> warns at startup without it. Going back to an older release is a cold start
> as well (its `redis` service does not use the `valkey-data` volume).

> **Upgrading from a release that ran three Redis instances** (`redis-sessions`,
> `redis-socketio`, `redis-data`): they are replaced by a single `redis`
> service (since 2026-10-31 a Valkey state instance plus a cache instance, see
> above). Set `REDIS_MAXMEMORY` in `.env.selfhost` to the state budget
> (the old per-instance `512mb` becomes `1024mb`), then
> `./selfhost/selfhost.sh up` — it runs with `--remove-orphans` and cleans up
> the three old containers. Everyone is logged out once.

> **Upgrading from a release that ran nginx behind Caddy**: Caddy is now the whole edge (image `cryptogram/caddy-selfhost`,
> built by `build`); the `nginx` service is gone. The **first**
> `./selfhost/selfhost.sh update` onto this release still runs the complete
> frontend build (a few minutes) and then stops with an error
> (`no such service: nginx`; the running containers are untouched): the
> script that ran it is the old one, still trying to build the old image. Finish the update with the freshly pulled script:
>
> ```bash
> ./selfhost/selfhost.sh build
> ./selfhost/selfhost.sh up
> ```
>
> `up` runs with `--remove-orphans`, which removes the old `nginx` container;
> `caddy` is recreated from the new image and keeps its `caddy-data` volume,
> so certificates (and a local test CA) carry over. From this release on,
> `update` continues in the pulled script, so later changes to the build
> steps no longer trip it. A `CG_ID_DOMAIN` from an older `init.sh` is now
> ignored unless the instance is the legacy CG ID gateway (`up` says so);
> its DNS record can go. Port 4443 is published only while calls are enabled.

> **SeaweedFS image is pinned** by version and digest (the exact tag is in
> `docker/docker-compose.selfhost.yml`; every pulled image is pinned, see
> `docs/infrastructure/UPDATE-POLICY.md`) since 2026-08-02; releases before
> that pulled the untagged `:latest`. If your
> install already runs a *newer* SeaweedFS than the pinned tag, do not let an
> update pull it back down — keep or raise the tag locally. Treat `4.34` as
> the security floor (2026 fixes).

> **Upgrading from a release that ran three SeaweedFS containers**
> (`seaweedmaster`, `seaweedvolume`, `s3`): they are replaced by a single
> `seaweed` service running `weed server`, and the two volumes
> `seaweedfs-volume` + `seaweedfs-buckets` are replaced by one `seaweedfs-data`.
> `SEAWEED_VOLUME_LIMIT_MB` keeps its meaning. The uploaded media must be
> merged into the new volume **once, with the stack stopped**:
>
> ```bash
> ./selfhost/selfhost.sh down
> ./selfhost/migrate_seaweed_volumes.sh      # defaults to the cg-selfhost project
> ./selfhost/selfhost.sh up
> ```
>
> The helper copies (never moves), so the host temporarily needs free disk at
> least the size of the current media store. It refuses to run while a container
> still uses the old volumes or if `seaweedfs-data` already holds data, so it is
> safe to re-run. Skip it entirely on a fresh install.
>
> On the first start the container entrypoint may `chown -R /data` — the image
> has run as uid 1000 since 4.00, so an older store has mismatched ownership.
> On a large store this takes a while and **looks like a hang**; let it finish.
>
> The old volumes are left untouched. Delete them once the new stack has proven
> healthy:
>
> ```bash
> docker volume rm cg-selfhost_seaweedfs-volume cg-selfhost_seaweedfs-buckets
> ```

## Bot accounts

Bot management is API/CLI only in v1. Existing instances should add the bot
owner/token/rate-limit variables documented in
[`docs/BOT-API.md`](../docs/BOT-API.md#instance-operator-configuration) to
`.env.selfhost`, then run `./selfhost/selfhost.sh up` so Compose recreates the
services whose configuration changed. In particular,
`PLATFORM_OPERATOR_USER_IDS` is a comma-separated allowlist of human user UUIDs
that may create and manage platform-owned bots; it is empty by default.

## Token staking (Spark)

Users can time-lock an ERC-20 token onchain and earn Spark (the platform
currency) while it is locked — see
[`docs/staking`](../docs/staking/README.md) for the design. The
feature is **off by default**; the token page's Stake tab shows an
informational placeholder until it is configured.

To enable it on your instance:

1. Deploy your own `CgStaking` contract for your token
   ([`contracts/staking/README.md`](../contracts/staking/README.md) — a
   self-contained Foundry project with a deployment script). The contract is
   non-custodial and admin-less; constructor lock bounds are immutable.
2. Add to `.env.selfhost` (the chain must be part of `CG_ACTIVE_CHAINS`, since
   the onchain listener indexes the contract's events):

   ```sh
   STAKING_CHAIN=eth
   STAKING_TOKEN_ADDRESS=0x...   # the ERC-20 being staked
   STAKING_CONTRACT_ADDRESS=0x...
   STAKING_BASE_RATE=0.012       # Spark per token per 365 days
   STAKING_MIN_LOCK_DAYS=7      # informational; enforced by the contract
   STAKING_MAX_LOCK_DAYS=730
   ```

3. `./selfhost/selfhost.sh up` to recreate the api, job-runner and onchain
   services with the new configuration.

Spark accrues only for positions staked from wallets linked to a user account,
never retroactively; the accrual job credits balances every few hours. Rate
changes apply prospectively and never claw back credited Spark.

## PostgreSQL 18

The database runs PostgreSQL 18 (before 2026-10-31: 14). A PostgreSQL 14 volume
does not start on 18: `up` fails with `dependency failed to start: container
cg-selfhost-db-1 is unhealthy`, and `./selfhost/selfhost.sh logs db` shows
`Error: in 18+, these Docker images are configured to store database data in a
format …`. The old data stays untouched.

**On an instance that still runs PostgreSQL 14, do not use
`./selfhost/selfhost.sh update`** for the release that brings PostgreSQL 18: it
pulls, builds and then fails at `up` as above. Follow these steps instead (they
include the update); later updates work as usual. To keep the data, dump and
restore:

```bash
# 1. before `git pull` (old compose file + old image), with nothing else running
./selfhost/selfhost.sh down
./selfhost/selfhost.sh compose up -d --wait db
./selfhost/selfhost.sh compose exec -T db pg_dump -U postgres -Fc cryptogram > ~/cryptogram-pg14.pgc
./selfhost/selfhost.sh down

# 2. update, then check which roles the dump needs (uses the new cryptogram/db:18
#    image); expected: postgres, writer, reader, mediasoup — anything else, see
#    docs/database/README.md before going on
git pull && ./selfhost/selfhost.sh build
docker run --rm -i cryptogram/db:18 pg_restore --schema-only -f - < ~/cryptogram-pg14.pgc \
  | grep -E '^(ALTER .*OWNER TO|GRANT|REVOKE)' | grep -oE '(TO|FROM) [^;]+' | sort -u

# 3. replace the volume (from here on the dump is the only copy); the fresh
#    cluster gets all roles. initdb logs "WARNING: no usable system locales were
#    found" — benign on Alpine/musl.
docker volume rm cg-selfhost_pgdata
./selfhost/selfhost.sh compose up -d --wait db

# 4. restore (compose cp needs an absolute source path), refresh planner
#    statistics, start; migrate-db applies newer migrations
./selfhost/selfhost.sh compose cp "$HOME/cryptogram-pg14.pgc" db:/tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db pg_restore -U postgres -d cryptogram --exit-on-error -j 4 /tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db rm /tmp/cryptogram.pgc
./selfhost/selfhost.sh compose exec db vacuumdb -U postgres -d cryptogram --analyze-in-stages
./selfhost/selfhost.sh up
```

Already updated? Take step 1's dump with a throwaway PostgreSQL 14 container on
the volume (after `down`): `docker run -d --name pg14-dump -v
cg-selfhost_pgdata:/var/lib/postgresql/data
postgres:14.23-alpine@sha256:f1341c01408dc7278e9d365ed4f860cd3f87dd16b4464ac326fc0f422083a579`,
wait for `docker exec pg14-dump pg_isready`, then `docker exec pg14-dump
pg_dump -U postgres -Fc cryptogram > ~/cryptogram-pg14.pgc` and
`docker rm -f pg14-dump`. Keep the dump until the instance runs normally; if
`pg_restore` stops, see `docs/database/README.md` ("Restoring a PostgreSQL 14
database into 18").

## Backups

All state lives in two named Docker volumes:

- `pgdata` — the database (everything except uploaded files)
- `seaweedfs-data` — uploaded media (blobs and filer metadata in one tree)

With the built-in mail relay there is a third, small one: `mail-data` — the
DKIM key and the outgoing mail queue. Back up at least the key
(`dkim_keys/` in that volume).

Example database backup:

```bash
./selfhost/selfhost.sh compose exec -T db pg_dump -U postgres cryptogram | gzip > backup.sql.gz
```

For the media volume the blessed baseline is **stop → snapshot → start**:

```bash
./selfhost/selfhost.sh down
# snapshot cg-selfhost_seaweedfs-data (LVM/ZFS snapshot, or a tar of its
# mountpoint) — one volume, so blobs and filer metadata are always consistent
./selfhost/selfhost.sh up
```

SeaweedFS has no online-consistent backup mechanism, so a snapshot taken while
the stack is running can capture a blob whose metadata was not written yet (or
the reverse). Since the storage consolidation, blobs and metadata at least share
a single volume, so one snapshot covers both.

The Valkey state instance keeps a snapshot in the `valkey-data` volume, so a
restart or update keeps everyone logged in. It does not need a backup: losing
it only logs everyone out once and resets rate-limit windows. The cache
instance keeps nothing on disk.

## Firewall summary

| Port | Protocol | Purpose |
|---|---|---|
| 80 | tcp | HTTP → HTTPS redirect, ACME |
| 443 | tcp+udp | app (HTTPS/HTTP3) |
| 4443 | tcp | call signalling (wss) — only with `CG_ENABLE_CALLS=true` |
| 40000–40099 | udp+tcp | WebRTC media (voice/video); TCP is the fallback for clients whose network blocks UDP — only with `CG_ENABLE_CALLS=true` |

**Reserve the media ports.** 40000–40099 lies inside Linux's default range for
outgoing connections (`net.ipv4.ip_local_port_range`, 32768–60999). If an
outgoing connection happens to hold one of these ports when `mediasoup`
starts, Docker cannot publish it and the container fails to start (seen on a
test instance on 2026-10-31; afterwards it kept restarting without a network
until recreated with `./selfhost/selfhost.sh compose up -d --force-recreate
--no-deps mediasoup`). Reserve the range on the host once:

```bash
echo 'net.ipv4.ip_local_reserved_ports = 40000-40099' | sudo tee /etc/sysctl.d/60-cg-mediasoup.conf
sudo sysctl --system
```

Outbound: the built-in mail relay (`CG_ENABLE_MAIL=true`) connects to port
25 of the recipients' mail servers. Nothing listens for mail on this server.
To make the relay the only container that can reach port 25, block outbound
25/tcp for the others on the host (see [Email](#email)).
