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
DNS propagates, the app is live at `https://chat.example.org`. Then set up
backups with an off-server copy — see [Backup and restore](#backup-and-restore).

Operating:

```bash
./selfhost/selfhost.sh logs          # follow all logs
./selfhost/selfhost.sh logs api      # follow one service
./selfhost/selfhost.sh stats        # container resource usage
./selfhost/selfhost.sh update       # git pull + rebuild + restart
./selfhost/selfhost.sh down         # stop
./selfhost/selfhost.sh mail-dns     # DNS records for the built-in mail relay
./selfhost/selfhost.sh backup run   # back up now (set up: "Backup and restore")
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

## Backup and restore

`./selfhost/selfhost.sh backup …` and `./selfhost/selfhost.sh restore …`
(implemented in `docker/selfhost/backup.sh`) back the instance up into an
encrypted [restic](https://restic.net) repository on the server and copy every
backup to a second repository **off the server**. restic runs in its official
image (pinned by version and digest in the script), so the host needs nothing
but Docker.

### What a backup contains

One backup is one restic snapshot:

| Part | Source | Notes |
|---|---|---|
| database | `pg_dump -Fc` of `cryptogram`, taken from the running `db` | online, a consistent snapshot; no downtime. The exact row count of every table is recorded in the same database snapshot, so a restore can prove it is complete |
| secrets | `.env.selfhost`, `vapid_keys.json`, `s3_config/s3.selfhost.json`, `selfhost/certs/`, `backup/` (the SSH key of an sftp repository) | without `vapid_keys.json` every stored push subscription stops working |
| media | the `seaweedfs-data` volume | see "Media and the freeze" below |
| caddy | the `caddy-data` volume | the ACME account and certificates — and, on a `tls internal` instance, the local CA every client trusts. Restoring it means certificates are not issued again (Let's Encrypt limits duplicate certificates to 5 per week) and clients keep trusting the local CA |
| mail | `dkim_keys/` of the `mail-data` volume (only with the mail relay) | a new key would mean publishing a new DKIM record. The queue is not backed up: restoring it would send mails twice |

Not backed up, on purpose:

- **Valkey** (`valkey-data`): sessions, rate-limit windows, email and login
  codes, captcha replay guards, presence. All of it is short-lived or can be
  rebuilt, and restoring sessions would revive logins that belong to another
  point in time. A restore logs everyone out once (it removes `valkey-data`
  when it restores the database). The cache instance keeps nothing on disk.
- `caddy-config` (Caddy rebuilds it), `builder-cache`, the images and the
  checkout itself — `git clone` and `./selfhost/selfhost.sh build` recreate them.

Each backup also carries a manifest: time, domain, the server that made it
(`machine-<id>`, a hash of `/etc/machine-id`, also a snapshot tag), code version
(git commit), PostgreSQL version, the newest migration and the SHA-256 of the
dump.

**Media and the freeze.** SeaweedFS has no online-consistent backup: a copy of
a running store can catch its filer index halfway through a change. So the
media is read while the `seaweed` container is frozen (`docker pause`).
Meanwhile uploads and media views **wait** — they do not fail unless the freeze
outlasts their timeout (a download and an S3 read issued during an 8-second
freeze both completed); chat, login and everything else keep working.

To keep the freeze short, each backup reads everything twice:

1. a **warm-up pass, unfrozen**: the dump, the secrets, `caddy-data` and all
   new media go into the repository;
2. the **frozen pass**, which uses the warm-up as its reference and so only
   re-reads the files that changed in the seconds in between. restic reads a
   changed file whole, so this is mostly the volume file SeaweedFS is
   appending to — up to `SEAWEED_VOLUME_LIMIT_MB` (1 GB by default) — and the
   filer's index files.

The warm-up snapshot is deleted right after; its data is shared with the real
one. Files that change or vanish during the warm-up are fine there (restic
exit 3 is accepted); the frozen pass must read everything. Measured on the development VM: 1 s of freeze when nothing changed in
between, 2 s when 50 MB were uploaded between the passes (a 100 MB volume file
re-read from the page cache). The worst case is a full 1 GB volume file being
appended to during the warm-up: expect several seconds from disk.

The copy is crash-consistent, the state a power cut would leave, which
SeaweedFS recovers from on start. Stopping the container instead would be no
better: its shutdown does not finish within Docker's 10-second grace period and
it is killed anyway, and after a restart it takes about 17 seconds until it
serves files again. The database is dumped first, the media copied afterwards,
so the media is never older than the database: a file uploaded in between is
merely an unreferenced extra.

### Setting it up

1. **Settings.** `init.sh` writes a `CG_BACKUP_*` block into `.env.selfhost`.
   An `.env.selfhost` from before backups existed gets the missing settings
   from the first `backup init` (step 3): each `CG_BACKUP_*` key that has no
   line yet — commented or not — is appended with its default, so nothing you
   set (or commented out) is overridden. The password is never replaced: an
   existing one stays; a password given in the environment is written to the
   file if it has none; otherwise one is generated. Then set
   `CG_BACKUP_REPOSITORY` (step 2) and run `backup init` again. Every setting
   except the password has a default:

   | Variable | Default | Meaning |
   |---|---|---|
   | `CG_BACKUP_PASSWORD` | generated | encrypts every backup — see "The password and the other keys" below |
   | `CG_BACKUP_DIR` | `/var/backups/commonground` | local repository (`repo/`), restic cache, staging area for the dump. Needs room for the dump plus the deduplicated history; must not be inside `docker/backup/` or another part of the secrets bundle |
   | `CG_BACKUP_REPOSITORY` | empty | the off-server repository (any restic repository URL); empty = local backups only, and every run warns |
   | `CG_BACKUP_AWS_ACCESS_KEY_ID`, `CG_BACKUP_AWS_SECRET_ACCESS_KEY` (`CG_BACKUP_AWS_DEFAULT_REGION`) | empty | credentials for an `s3:` repository |
   | `CG_BACKUP_KEEP_DAILY` / `_WEEKLY` / `_MONTHLY` | 7 / 4 / 6 | retention after every backup (`restic forget --prune`). Per day only the newest backup is kept, so a backup taken before a risky change disappears at the next backup on the same day; restic also keeps the oldest snapshot as long as a keep bucket is not full yet (the first days, or after a take-over) |
   | `CG_BACKUP_REMOTE_RETENTION` | `true` | `false`: no `forget`/`prune` on the off-server repository — for an append-only target, whose retention runs elsewhere (see step 2) |
   | `CG_BACKUP_ON_SUCCESS`, `CG_BACKUP_ON_FAILURE` | empty | shell commands run after a successful backup / a failed backup, check or verify, or a run that found another one holding the lock (environment: `CG_BACKUP_RESULT`, `CG_BACKUP_COMMAND`, `CG_BACKUP_EXIT_CODE`), e.g. `CG_BACKUP_ON_SUCCESS='curl -fsS -m 10 https://hc-ping.com/<uuid>'` as a dead-man switch |
   | `CG_BACKUP_CHECK_SUBSET` | `5%` | share of the stored data `backup check` reads back |
   | `CG_BACKUP_SCHEDULE`, `CG_BACKUP_CHECK_SCHEDULE` | `*-*-* 03:30:00`, `Sun *-*-* 05:00:00` | systemd calendar times used by `install-timer` |
   | `CG_BACKUP_TIMEOUT` | `4h` | systemd `TimeoutStartSec` of the backup and check units |
   | `CG_BACKUP_HOST` | `CG_DOMAIN` | the name snapshots are filed under; retention only ever touches this name's snapshots |
   | `CG_BACKUP_MACHINE_ID` | `/etc/machine-id` | what identifies this server in the snapshots (only needed where there is no `/etc/machine-id`) |
   | `CG_BACKUP_DRILL`, `CG_BACKUP_DRILL_SOURCE` | — | written by `restore --drill`, see "A restore drill on a separate server" |

   Quote values that contain spaces or `$` with single quotes, as in the
   hook example (the file is read by both bash and Docker Compose).

2. **Off-server repository.** Any restic repository works. Two examples:

   - **Storage box over SFTP** (e.g. a Hetzner Storage Box with SSH support
     on; it listens on port 23):
     `CG_BACKUP_REPOSITORY=sftp://u123456@u123456.your-storagebox.de:23/cg-backup`.
     `backup init` creates an SSH key in `docker/backup/ssh/`, records the
     host key (it prints the fingerprints — compare them with the ones your
     provider publishes), prints the public key and stops. Authorize the key
     for the storage account — for a Hetzner Storage Box, e.g.
     `ssh -p 23 u123456@u123456.your-storagebox.de install-ssh-key < docker/backup/ssh/id_ed25519.pub`
     — and run `backup init` again.
   - **S3-compatible object storage**:
     `CG_BACKUP_REPOSITORY=s3:https://<endpoint>/<bucket>/cg-backup` plus the
     two `CG_BACKUP_AWS_*` keys (a key limited to that bucket).

   With the defaults the server can delete what it wrote there (retention
   needs that). To survive an attacker who controls the server, turn on the
   provider's own snapshots or object versioning for that space, or use an
   **append-only** target (a restic rest-server with `--append-only`, an
   object-lock bucket): set `CG_BACKUP_REMOTE_RETENTION=false`, since
   `forget --prune` would fail there, and run the retention from a trusted
   machine instead (`restic forget --prune` with the same `--keep-*` and
   `--host` values, using credentials that may delete).

3. **Initialize** both repositories (safe to repeat):

   ```bash
   ./selfhost/selfhost.sh backup init
   ```

4. **First backup and a test restore of it:**

   ```bash
   ./selfhost/selfhost.sh backup run       # back up now
   ./selfhost/selfhost.sh backup list      # snapshots (--remote: the off-server ones)
   ./selfhost/selfhost.sh backup verify    # restore drill for the database, see below
   ```

5. **Schedule** a daily backup (03:30) and a weekly repository check (Sunday
   05:00) as systemd timers:

   ```bash
   sudo ./selfhost/selfhost.sh backup install-timer
   journalctl -u cg-backup -u cg-backup-check     # their logs
   systemctl list-timers 'cg-backup*'
   ```

   The units run `selfhost.sh backup run` / `backup check` from this checkout
   **as its owner** (who must be in the `docker` group, or be root —
   `install-timer` checks that this user can read `.env.selfhost` and use
   Docker), with `NoNewPrivileges`, a private `/tmp` and a start timeout of
   `CG_BACKUP_TIMEOUT`. A scheduled run that fails on its settings still
   calls `CG_BACKUP_ON_FAILURE` — also when it fails before it really
   starts (image pull, password, machine id, lock, backup directory).
   `CG_BACKUP_DIR` is created on first use owned by the checkout owner with
   mode 700; `install-timer` takes over an existing one only if it holds
   nothing but backup data (otherwise it warns and leaves it alone), and a run
   by a user who cannot enter it stops right away. A failed run exits non-zero (the unit shows
   as failed) and calls `CG_BACKUP_ON_FAILURE`; after every run, even one
   killed by the timeout, `backup resume` makes sure `seaweed` is not left
   frozen. `sudo ./selfhost/selfhost.sh backup uninstall-timer` removes the
   units; the repositories stay.

### The password and the other keys

Every backup — the off-server copy included — is encrypted with
`CG_BACKUP_PASSWORD`. It sits in `.env.selfhost` so the timer can run
unattended, and **a copy must live somewhere else**: in a password manager
and/or printed in a safe place. If the server is lost, the backups cannot be
read without it. `backup init` never prints it; show it with
`grep '^CG_BACKUP_PASSWORD=' .env.selfhost`.

To restore onto a new server you also need access to the off-server
repository: keep the S3 keys, or a copy of `docker/backup/ssh/` (the key
`id_ed25519` and the pinned host key `known_hosts`), next to the password — or
be able to authorize a new SSH key at the provider. Both are also inside every
backup, but only readable with the password.

Changing the password of existing repositories is not part of `selfhost.sh`
(restic's `key passwd` on both repositories, then update `.env.selfhost`).

### Commands

| Command | What it does |
|---|---|
| `backup init` | adds `CG_BACKUP_PASSWORD` if missing, creates the local and the off-server repository with the same chunker parameters (so copies deduplicate), sets up SSH for an sftp repository |
| `backup run [--take-over]` | dump + row counts, warm-up pass, freeze `seaweed`, snapshot to the local repository, resume, retention, copy to the off-server repository, retention there (unless `CG_BACKUP_REMOTE_RETENTION=false`). Without an off-server repository it warns loudly and still exits 0. `--take-over`: see "One server per backup timeline" |
| `backup list [--remote]` | lists the snapshots |
| `backup check [--read-data]` | `restic check` of both repositories, reading back `CG_BACKUP_CHECK_SUBSET` of the data (`--read-data`: all) |
| `backup verify [--remote] [snapshot]` | restore drill without touching the instance: restores the snapshot's dump (default: the latest) into a throwaway PostgreSQL container, checks the dump's SHA-256 and compares every table's row count with the backup; the container and its volume are removed afterwards |
| `backup resume` | resumes `seaweed` if an interrupted backup left it frozen (`./selfhost/selfhost.sh up` does that too); does nothing while a backup or restore holds the lock, so it never ends another run's freeze |
| `backup install-timer` / `uninstall-timer` | (root) the systemd timers above |
| `restore …` | see below; `restore --help` lists the options |

Only one backup or restore of an instance runs at a time (lock file
`/run/lock/cg-backup-<project>.lock`; without a usable `/run/lock` they refuse
to run); a second one stops with "another backup or restore … is running" and,
for backups, calls `CG_BACKUP_ON_FAILURE`. `selfhost.sh up`, `down` and
`update` refuse to run while the lock is taken. Each locked command first
removes what an interrupted run left behind (staging directories, a
throwaway verify database).

### One server per backup timeline

Every snapshot names the server that made it. `backup run` refuses to write
into a repository that holds backups of the same `CG_BACKUP_HOST` made by
another server which this server has not accepted — two servers would
interleave their backups in one timeline, and the retention would mix them up
(think of a test copy that got the production secrets and a timer). The rule
goes by identity, not by time, so the servers' clocks do not matter: the
accepted snapshots are remembered in `CG_BACKUP_DIR` (`guard-*`), and a new one
the other server makes later is caught again. After a restore onto a **new**
server that replaces the old one, take over once (it accepts the old server's
snapshots):

```bash
./selfhost/selfhost.sh backup run --take-over
```

A drill or test copy must not take over; restore it with `--drill` (below).

The check runs before anything is written: on the local repository and on the
off-server one before the dump, so a refused run leaves no local snapshot. If
the off-server repository cannot be read at that moment, the local backup still
runs and the check is repeated before the copy — a refusal there comes after
the local snapshot and the local retention.

Each local snapshot is copied to the off-server repository exactly once: the
copied ones are remembered in `CG_BACKUP_DIR` (`copied-*`; when that record is
missing it is rebuilt from the copies already in the repository). So none is
skipped because of a clock, and one that the off-server retention dropped is
not copied there again. After a take-over the old server's snapshots stay as
they are.

- The server is told apart by `/etc/machine-id`. A VM **cloned** from a
  snapshot or template shares it with the original: give the clone its own
  (`sudo rm /etc/machine-id /var/lib/dbus/machine-id && sudo
  systemd-machine-id-setup && sudo ln -sf /etc/machine-id
  /var/lib/dbus/machine-id`), or run `sudo ./selfhost/selfhost.sh backup
  uninstall-timer` on it. Where there is no `/etc/machine-id` (e.g. when the
  script runs in a container), backups refuse to run until
  `CG_BACKUP_MACHINE_ID` is set to a fixed value unique to the server.
- `CG_BACKUP_HOST` defaults to `CG_DOMAIN`, so **changing the domain starts a
  new timeline** (the old snapshots keep their old name and age out under
  their own retention). To continue the timeline, set `CG_BACKUP_HOST` to the
  old name explicitly before the first backup after the change.

### Restoring

```
./selfhost/selfhost.sh restore [--from local|remote] [--only secrets,db,media,caddy,mail]
                               [--force] [--with-secrets] [--drill] [--dry-run]
                               [--host NAME] <snapshot-id | latest>
./selfhost/selfhost.sh restore --db-file <dump.pgc> [--force] [--dry-run]
./selfhost/selfhost.sh restore --undo <stamp> [--force]
./selfhost/selfhost.sh restore --discard-undo <stamp> [--force]
```

A restore does not start while an earlier one is unfinished
(`docker/restore-undo.pre-restore-<stamp>` exists) or left copies behind (a
`.pre-restore-<stamp>` entry in a volume, a `cryptogram_pre_restore_<stamp>`
database): first `--undo <stamp>` it, or keep its state and remove its copies
with `--discard-undo <stamp>` (`--force` for one that did not finish).

What `restore` does, in this order:

1. Reads the snapshot (from the local repository if it exists, otherwise the
   off-server one; `--from` chooses), prints its manifest and the stamp of
   this restore (e.g. `20261101093913`). It warns when the backup's newest
   migration is not in this checkout (the code is older than the backup —
   `git pull` first).
2. **Plans every component — nothing is changed yet**:
   - secrets: missing files are restored, identical ones left alone; files
     that **differ** are **kept** (the database role passwords then come from
     the current `.env.selfhost`). With `--with-secrets --force` (or
     `--only secrets --force`) they are replaced and the current file is kept
     as `<file>.pre-restore-<stamp>`; `--with-secrets` without `--force` is
     refused. An existing `docker/backup/` — the SSH access that just reached
     the repository — is always kept. Restored files keep the owner and mode
     they were backed up with (also under `sudo`: `s3.selfhost.json` stays
     uid 1000 for seaweed); `.env.selfhost` and `backup/` belong to the owner
     of the checkout.
   - db: a **non-empty database is refused** without `--force`. To look
     inside, `restore` starts `db` alone if it is not running (it says so).
     The dump is fetched, its SHA-256 checked against the manifest, and a
     dump that needs a database role this cluster lacks is refused.
   - media: a **non-empty media volume is refused** without `--force`.
   - caddy, mail: a non-empty `caddy-data` / an existing DKIM key is kept
     without `--force`.
   - space: Docker's storage needs room for a database of about three times
     the dump plus the restored media and `caddy-data` (the old ones stay
     until the end), `CG_BACKUP_DIR` for the dump; too little is refused
     (`--ignore-space-check` overrides; `--force` does not). If both share a
     filesystem, both amounts come out of the same free space.

   Anything refused stops the restore here, with the instance untouched.
   `--dry-run` always stops here.
3. **Applies**: the secrets; then it stops every service and restores
   - **db**: starts `db` alone (building its image if needed), sets the
     passwords of `postgres`, `writer`, `reader` and `mediasoup` from the
     current `.env.selfhost` (creating missing roles), renames a non-empty
     database to `cryptogram_pre_restore_<stamp>`, restores the dump into a
     fresh `cryptogram`, refreshes the planner statistics, **compares every
     table's row count with the backup**, and removes the Valkey state volume
     (everyone logs in again);
   - **media / caddy**: moves the current contents into
     `.pre-restore-<stamp>/` inside the volume (a rename, no copy) and restores
     the backup's; restic verifies the restored files;
   - **mail**: the same for `dkim_keys/`.

   When the secrets restored or replaced `.env.selfhost` but the database is
   not part of this restore, it still starts `db` and sets the role passwords
   from the new file.
4. Only when **everything** succeeded it retires the undo record — from here
   on the restore counts as done and is never undone — and then drops
   `cryptogram_pre_restore_<stamp>` and the `.pre-restore-<stamp>/`
   directories, and leaves only `db` running. If that cleanup fails or is
   interrupted, it says that the restore succeeded and names
   `restore --discard-undo <stamp>` to remove the leftovers. Start the
   instance with `./selfhost/selfhost.sh up`; `migrate-db` applies the
   migrations of this checkout that the backup lacks.

A `--force` restore over existing data therefore needs **free disk space for a
second copy** of the database and of the media until it finishes.

**If a restore fails** after it began changing things, it prints what it had
already replaced, that the stack is stopped, and two commands: to go back to
the state before the restore (`restore --undo <stamp>`, then `up`) or to undo
and retry. `--undo` puts the previous database and volume contents and the
replaced secrets back, removes what was restored into empty targets, and sets
the role passwords from the then current `.env.selfhost` again (only the
removed Valkey state does not come back — it holds sessions). It works from
the record `docker/restore-undo.pre-restore-<stamp>`, which a successful
restore retires; each step can be repeated, and a volume whose contents were
only partly moved aside gets them moved back without anything being deleted.
If services other than `db` were started after the failed restore, the
instance has run on the restored data: `--undo` then asks for `--force`.

#### Roll back on the same server

```bash
./selfhost/selfhost.sh backup list
./selfhost/selfhost.sh restore --dry-run --force <snapshot-id>
./selfhost/selfhost.sh restore --force <snapshot-id>
./selfhost/selfhost.sh up
```

Everything written after that snapshot is lost. The secrets stay as they are
(add `--with-secrets` to roll them back too); `--only db` or `--only media`
rolls back one part. History that exists only off the server — e.g. older
backups after a restore onto a new server, whose local repository starts
empty — is listed with `backup list --remote` and restored with
`restore --from remote <snapshot-id>`. To keep a rollback point from before a
risky change, restore from it the same day: per day the retention keeps only
the newest backup.

#### Onto a new server (the old one is gone)

```bash
git clone https://github.com/Common-Ground-DAO/commonground.git
cd commonground/docker

# the off-server repository from your notes; the password is asked for (typing
# it keeps it out of the shell history)
export CG_BACKUP_REPOSITORY='sftp://u123456@u123456.your-storagebox.de:23/cg-backup'
# sftp: the saved key and known_hosts (s3: export the two CG_BACKUP_AWS_* keys)
(umask 077; mkdir -p backup/ssh) && cp /path/to/saved/ssh/{id_ed25519,known_hosts} backup/ssh/

./selfhost/selfhost.sh restore --only secrets latest   # brings back .env.selfhost & co.
./selfhost/selfhost.sh build                           # vapid_keys.json is kept
./selfhost/selfhost.sh restore latest                  # db, media, caddy, mail
./selfhost/selfhost.sh up
./selfhost/selfhost.sh backup init                     # a new local repository
./selfhost/selfhost.sh backup run --take-over          # this server continues the timeline
sudo ./selfhost/selfhost.sh backup install-timer
```

The copied `backup/ssh/` is kept as it is (the restore lists it as "in use");
`backup init` recreates the missing `id_ed25519.pub`. Host keys are checked
strictly. Without a saved `known_hosts`, create it from the provider's
published fingerprints (`ssh-keyscan -p 23 <host> > backup/ssh/known_hosts`,
then compare `ssh-keygen -lf backup/ssh/known_hosts`); a new SSH key works
too once it is authorized at the provider. Before `up`, check the restored
`.env.selfhost`: a new server usually has a new address, so update
`CG_PUBLIC_IP` (and the DNS records), and `CG_BACKUP_DIR` if the new server
keeps its backups elsewhere.

Settings exported in the shell override `.env.selfhost` for the backup
commands (`CG_BACKUP_DIR`, `CG_BACKUP_REPOSITORY`, `CG_BACKUP_PASSWORD`,
`CG_BACKUP_HOST`, `CG_BACKUP_AWS_*`, `CG_BACKUP_MACHINE_ID`), as shell
variables override the env file in Docker Compose.

#### A planned move to a new server

The same procedure, prepared so that the downtime is only the restore:

1. **Before the downtime window**, on the new server: clone, put the
   repository access in place, `restore --only secrets latest`, `build` (the
   longest step: ~2.5 min on the 4-core test VM), DNS TTLs lowered. Measure a
   full `restore` beforehand with a production-sized backup (a drill, below),
   so the window can be announced.
2. **Prove the off-site material from a third machine** — the password, the
   repository address and the SSH key or S3 keys, exactly as stored: `backup
   list --remote` must work there before you depend on it.
3. **In the window**, on the old server: `./selfhost/selfhost.sh down`, then
   the final `./selfhost/selfhost.sh backup run` (it starts `db` alone for the
   dump; with the stack down nothing changes during the copy), and remove the
   old server's schedule with `sudo ./selfhost/selfhost.sh backup
   uninstall-timer` — it must not write into the timeline the new server
   takes over.
4. On the new server: `restore latest`, `up`, `backup init`,
   `backup run --take-over`, `sudo … backup install-timer`; then switch DNS.
5. Everyone logs in again (sessions live in Valkey, which is not restored).

#### A restore drill on a separate server

A drill restores the production backup onto a throwaway server. With
`--drill`, that copy can never act as production:

```bash
export CG_BACKUP_REPOSITORY='…'                            # production's
read -rs CG_BACKUP_PASSWORD && export CG_BACKUP_PASSWORD   # its password, not echoed
# + its SSH key and known_hosts in docker/backup/ssh/, or the CG_BACKUP_AWS_* keys
./selfhost/selfhost.sh restore --drill --only secrets latest
unset CG_BACKUP_REPOSITORY CG_BACKUP_PASSWORD
./selfhost/selfhost.sh build
./selfhost/selfhost.sh restore latest
./selfhost/selfhost.sh up
```

Right after the secrets are restored, `--drill` rewrites the copy's
`.env.selfhost`: `CG_BACKUP_DRILL=true`; production's repository moves to
`CG_BACKUP_DRILL_SOURCE` and `CG_BACKUP_REPOSITORY` is emptied;
`CG_BACKUP_HOST=drill-<hostname>`; `CG_ENABLE_MAIL=false` and an empty
`SMTP_HOST`, so it sends no mail; `CG_TLS_MODE=internal`, so Caddy issues its
certificates from its own CA instead of renewing them on production's ACME
account. To reach the drill instance under the production domain, map that
name to the drill server in the `/etc/hosts` of the client machines, trust
its CA (see [Local test instance](#local-test-instance-no-public-dns)), and
set `CG_PUBLIC_IP` in its `.env.selfhost` to the drill server's address
before `up`. On a drill instance:

- the source repository is only read, without locks — no `backup init`,
  `copy`, retention or `check` ever touches it; backups stay in the local
  repository under the drill host name;
- the DKIM key is never restored (`--only mail` is refused);
- `backup install-timer` is refused.

The drill instance keeps production's `vapid_keys.json` (so the drill can
check it) and its stored push subscriptions: anything that triggers a
notification on the drill instance would reach real users' browsers. Do not
create content there that notifies others, or block outbound traffic to the
push services for the duration.

#### Into another instance (test server, rehearsal)

An instance set up with its own `init.sh` secrets can take the data of
another one. Differing secrets are kept by default, so restoring the data
alone is enough. `--drill` keeps this instance away from the other one's
repository for good (it also switches this instance's mail off and empties its
own `CG_BACKUP_REPOSITORY`, as described above):

```bash
export CG_BACKUP_REPOSITORY='…'                  # the other instance's
read -rs CG_BACKUP_PASSWORD && export CG_BACKUP_PASSWORD   # its password, not echoed
./selfhost/selfhost.sh restore --drill --only db,media --force latest
unset CG_BACKUP_REPOSITORY CG_BACKUP_PASSWORD
./selfhost/selfhost.sh up
```

Access to that repository comes the same way as on a new server: the
`CG_BACKUP_AWS_*` keys exported, or its SSH key and `known_hosts` in
`docker/backup/ssh/`. The database gets this instance's role passwords; uploads
work with this instance's S3 secret. Push subscriptions of the other instance
do not work here (they belong to its `vapid_keys.json`).

#### Only the database, from a dump file

`restore --db-file <dump.pgc>` restores a plain `pg_dump -Fc` file — for
example from another server — with the same safety rules, role handling and
`--undo` (a dump that needs a role this cluster lacks is refused before
anything is stopped; [docs/database](../docs/database/README.md#restoring-a-postgresql-14-database-into-18)
covers dumps from PostgreSQL 14). There is no row-count comparison for such a
file.

### Restore drill

A backup is only as good as the last restore that worked:

- **Monthly:** `./selfhost/selfhost.sh backup verify --remote` — restores the
  newest off-server dump into a throwaway database and compares the row
  counts. The weekly `backup check` covers the integrity of the media data
  (`backup check --read-data` reads all of it).
- **Before relying on it, and after changing the setup:** a full drill on a
  separate server with `--drill` (above), then check: the app loads, an
  existing account logs in, an old image or attachment opens (it is served
  through a signed `/files/` URL, so this proves media and the S3 secret fit
  together), and `sha256sum vapid_keys.json` matches the production server.

Measured on the development VM (2026-11-01, 50–300 MB of media, small
database, everything on local disk; times grow with the data): `backup run`
5–13 s, of which media requests waited 1–2 s; `backup verify` 4–5 s; a full
restore onto a fresh server 12–15 s plus about 20 s until `up` is healthy; a
`--force` restore over an existing instance about 25 s (stopping the stack
takes 11–15 s of that).

### Troubleshooting

- **Uploads hang after an interrupted backup**: the backup was killed while
  `seaweed` was frozen. `./selfhost/selfhost.sh backup resume` (or `up`, or the
  next backup) resumes it; the systemd unit does it on its own.
- **"the newest backup of … was made on another server"**: see "One server
  per backup timeline".
- **"CG_BACKUP_PASSWORD does not open the local repository"**: the password
  in `.env.selfhost` is not the repository's.
- **"restore … did not finish" / "left pre-restore copies behind"**: see the
  paragraph at the start of "Restoring" — `--undo <stamp>` or
  `--discard-undo <stamp>`.
- **"A backup or restore of this instance is running"** from `up`/`down`/
  `update`: wait for it (`journalctl -u cg-backup -f`).
- **An unreachable off-server repository** is retried by restic for several
  minutes before the run fails — the local backup is already made by then.

### Before this release

Older instances backed up by hand (`pg_dump` plus a snapshot of the stopped
`seaweedfs-data` volume). Those copies stay restorable the manual way (see
[PostgreSQL 18](#postgresql-18) for the dump); from now on use the commands
above.

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
