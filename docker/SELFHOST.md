# Self-hosting Common Ground

This guide runs the complete Common Ground stack on **one server**. A machine
with 4–8 cores and 16 GB RAM is sufficient; the stack idles at well under
2 GB — RAM is mostly consumed under load (calls, many users, image
processing).

The self-host profile differs from the dev setup (`run.sh`): real TLS via
Let's Encrypt, production semantics on your own domain, generated secrets,
and no dev-chain/test-contract services.

## Prerequisites

- A Linux server with Docker + Docker Compose v2, ports **80, 443, 4443
  (tcp)** and **40000–40099 (udp)** reachable from the internet
- A domain with two DNS records pointing at the server:
  - `chat.example.org` — the app itself
  - `id.chat.example.org` — the CG ID passkey app (**must** be a separate
    origin; passkeys are scoped to it)

## Setup

```bash
git clone https://github.com/Common-Ground-DAO/commonground.git
cd commonground/docker

# 1. Generate secrets, S3 config and internal certs
./selfhost/init.sh chat.example.org admin@example.org

# 2. Build everything (frontend, backend, nginx, db) — ~15-20 min
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
```

## How instance identity works

Historically the frontend decided "am I prod?" by matching against
`app.cg` — any other domain silently ran in dev mode. Self-hosted instances
instead declare their identity at serve time: nginx (and the API server, for
share links) injects

```html
<script>window.__CG_INSTANCE__ = {"deployment":"prod","appUrl":"https://chat.example.org",...}</script>
```

into `index.html`. See `src/common/instance.ts`. This means the same build
artifacts work for any domain — the domain is configuration, not code.

## Optional integrations

All third-party services are optional; leave their keys empty in
`.env.selfhost` to disable the corresponding feature:

All integrations degrade gracefully: the server derives capability flags
from which keys are configured and ships them to the frontend via the
instance config, so unavailable features are hidden or replaced with an
honest message instead of breaking.

| Env keys | Feature | Without it |
|---|---|---|
| `SENDGRID_API_KEY`, `EMAIL_FROM` | email verification, one-time-code login, event mails, newsletters | password/passkey/wallet login still work; OTP login and newsletter UI hidden; event RSVP works without verified email |
| `CAPTCHA_PROVIDER`, `ALTCHA_HMAC_KEY`, `CG_RECAPTCHA_SITE_KEY`, `GOOGLE_RECAPTCHA_SECRET_KEY` | signup captcha (see [Captcha](#captcha)) | defaults to ALTCHA; captcha is never silently skipped |
| `TWITTER_API_KEY`, `TWITTER_API_SECRET` | Twitter/X login and account linking | X buttons hidden |
| `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY` | KYC verification | KYC steps show "not available on this instance" |
| `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID` | CG-updates newsletter list sync | subscription preference stored locally only |
| `CG_GIPHY_API_KEY` | GIF picker in the composer | GIF picker hidden |
| `CG_WALLETCONNECT_PROJECT_ID` | WalletConnect wallets (QR / mobile deep-link) | injected wallets (MetaMask etc.) still work |

## Captcha

Registration is protected by a captcha so open instances don't get flooded
with spam accounts. Unlike before, captcha is **never silently disabled** —
`CAPTCHA_PROVIDER` selects one of three modes:

- **`altcha`** (default) — [ALTCHA](https://altcha.org), a self-hosted,
  privacy-friendly proof-of-work captcha. No third-party keys, no external
  calls, GDPR-friendly. `init.sh` generates an `ALTCHA_HMAC_KEY` for you so
  challenges stay valid across restarts; if you clear it, the backend generates
  one and shares it across instances via Redis. This is the recommended default
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

- `REDIS_MAXMEMORY=512mb` — per Redis instance (3 instances)
- `SEAWEED_VOLUME_LIMIT_MB=1024` — SeaweedFS volume chunk size
- mediasoup spawns one media worker per CPU core

Postgres loads `docker/db/postgresql.conf`; tune `shared_buffers` etc. there
for larger instances.

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
[`docs/ROADMAP-staking.md`](../docs/ROADMAP-staking.md) for the design. The
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

## Backups

All state lives in three named Docker volumes:

- `pgdata` — the database (everything except uploaded files)
- `seaweedfs-volume`, `seaweedfs-buckets` — uploaded media

Example database backup:

```bash
./selfhost/selfhost.sh compose exec db pg_dump -U postgres cryptogram | gzip > backup.sql.gz
```

Redis is intentionally unpersisted (sessions and ephemeral data only) —
users just log in again after a restart.

## Firewall summary

| Port | Protocol | Purpose |
|---|---|---|
| 80 | tcp | HTTP → HTTPS redirect, ACME |
| 443 | tcp+udp | app + CG ID (HTTPS/HTTP3) |
| 4443 | tcp | call signalling (wss) |
| 40000–40099 | udp | WebRTC media (voice/video) |
