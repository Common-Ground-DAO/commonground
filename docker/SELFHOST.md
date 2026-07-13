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

| Env keys | Feature | Without it |
|---|---|---|
| `SENDGRID_API_KEY`, `EMAIL_FROM` | email login, verification, notifications | email features unavailable |
| `CG_RECAPTCHA_SITE_KEY`, `GOOGLE_RECAPTCHA_SECRET_KEY` | signup captcha | registration is open (fine for private instances) |
| `TWITTER_OAUTH2_*` | Twitter login | Twitter login unavailable |
| `SUMSUB_*` | KYC verification | KYC unavailable |

## Blockchain RPC endpoints and chains

`init.sh` prefills the `QUIKNODE_*`/`INFURA_LINEA` variables with **free public
RPC endpoints** (the names are historical — any JSON-RPC URL works), so
token-gated roles, balance checks and premium payments work out of the box.
Public endpoints are rate-limited; for larger instances put your own paid
endpoints (QuikNode, Alchemy, Infura, ...) there.

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
