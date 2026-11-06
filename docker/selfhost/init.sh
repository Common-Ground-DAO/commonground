#!/bin/bash
# Initializes a self-hosted Common Ground instance:
#   - generates docker/.env.selfhost with fresh random secrets
#   - generates docker/s3_config/s3.selfhost.json (matching S3 secret)
#   - generates a self-signed cert for the internal caddy->mediasoup hop
#
# Usage: ./init.sh [--tls-internal] <domain> <acme-email> [id-domain] [public-ip] [public-ipv6]
#   e.g.: ./init.sh chat.example.org admin@example.org
#
#   id-domain       only for the legacy CG ID gateway (CG_LEGACY_CGID=true);
#                   leave it out, or pass "-" when a public IP follows
#   public-ip       the server's public IPv4 address (detected when left out)
#   public-ipv6     its public IPv6 address, "-" for none (detected when left
#                   out, except with --tls-internal); recorded as
#                   CG_PUBLIC_IPV6 — see SELFHOST.md, "IPv6"
#
#   --tls-internal  local/LAN test instance without public DNS: Caddy issues
#                   all certificates from its own local CA instead of Let's
#                   Encrypt (CG_TLS_MODE=internal). The ACME email is unused —
#                   pass "-" — and the public IP must be given explicitly
#                   (the address browsers reach the machine at, e.g. its LAN IP):
#     ./init.sh --tls-internal cg.test - - 192.168.122.44
#
# Safe to re-run: existing files are never overwritten.
set -euo pipefail
cd "${0%/*}/.."   # docker/

usage() {
  echo "Usage: $0 [--tls-internal] <domain> <acme-email> [id-domain] [public-ip] [public-ipv6]"
  echo "  e.g. $0 chat.example.org admin@example.org"
  echo "       $0 --tls-internal cg.test - - 192.168.122.44   (local test instance)"
  exit 1
}

CG_TLS_MODE=acme
# a real instance runs the built-in mail relay; a LAN/test instance must not
# deliver mail to the internet, so it starts with email off
INIT_ENABLE_MAIL=true
INIT_SMTP_HOST=mail
if [ "${1:-}" = "--tls-internal" ]; then
  CG_TLS_MODE=internal
  INIT_ENABLE_MAIL=false
  INIT_SMTP_HOST=
  shift
fi

# --tls-internal is only recognised first; anything else that looks like an
# option would silently end up in .env.selfhost as a domain, email or IP
for arg in "$@"; do
  if [ "${arg#-}" != "$arg" ] && [ "$arg" != "-" ]; then
    echo "Unknown or misplaced option: $arg"
    usage
  fi
done

CG_DOMAIN="${1:-}"
CG_ACME_EMAIL="${2:-}"
# the CG ID domain is only for the legacy CG ID gateway; "-" = none
CG_ID_DOMAIN="${3:-}"
if [ "$CG_ID_DOMAIN" = "-" ]; then
  CG_ID_DOMAIN=""
fi
CG_PUBLIC_IP="${4:-}"
# "-" = this server has no public IPv6 address (skips the detection)
CG_PUBLIC_IPV6="${5:-}"
IPV6_GIVEN=false
if [ -n "$CG_PUBLIC_IPV6" ]; then
  IPV6_GIVEN=true
fi
if [ "$CG_PUBLIC_IPV6" = "-" ]; then
  CG_PUBLIC_IPV6=""
fi

if [ -z "$CG_DOMAIN" ]; then
  usage
fi

if [ "$CG_TLS_MODE" = "internal" ]; then
  # no ACME account in internal mode; "-" is the placeholder for "none"
  if [ "$CG_ACME_EMAIL" = "-" ]; then
    CG_ACME_EMAIL=""
  fi
  # public-IP detection would announce the WAN address of the router in
  # front of a LAN test machine, and calls would never connect
  if [ -z "$CG_PUBLIC_IP" ]; then
    echo "--tls-internal needs the IP browsers reach this machine at as the 4th argument."
    usage
  fi
elif [ -z "$CG_ACME_EMAIL" ] || [ "$CG_ACME_EMAIL" = "-" ]; then
  usage
fi

is_ipv4() {
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
}
# loose on purpose (any hex/colon form, no zone index); the point is to tell
# an IPv6 address from an IPv4 address or a host name
is_ipv6() {
  [[ "$1" == *:* ]] && [[ "$1" =~ ^[0-9A-Fa-f:.]+$ ]]
}

if [ -z "$CG_PUBLIC_IP" ]; then
  echo "Detecting public IP..."
  CG_PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
  if [ -z "$CG_PUBLIC_IP" ]; then
    echo "Could not detect public IP; pass it as the 4th argument."
    exit 1
  fi
  echo "Public IP: $CG_PUBLIC_IP"
fi
# mediasoup announces this address to callers and listens on IPv4 only
if ! is_ipv4 "$CG_PUBLIC_IP"; then
  echo "The public IP '$CG_PUBLIC_IP' is not an IPv4 address. Pass the IPv4 address as the 4th"
  echo "argument and an IPv6 address, if any, as the 5th."
  usage
fi

# The IPv6 address is recorded, not used by the stack: its Docker network is
# IPv4-only (SELFHOST.md, "IPv6"). Detected only for a public instance — a LAN
# test machine would report the router's prefix, not something browsers reach.
if [ "$IPV6_GIVEN" = false ] && [ "$CG_TLS_MODE" != "internal" ]; then
  echo "Detecting public IPv6 address..."
  CG_PUBLIC_IPV6=$(curl -6 -fsS --max-time 10 https://api6.ipify.org 2>/dev/null || true)
  if [ -n "$CG_PUBLIC_IPV6" ]; then
    echo "Public IPv6: $CG_PUBLIC_IPV6"
  else
    echo "No public IPv6 address detected."
  fi
fi
if [ -n "$CG_PUBLIC_IPV6" ] && ! is_ipv6 "$CG_PUBLIC_IPV6"; then
  echo "The public IPv6 address '$CG_PUBLIC_IPV6' is not an IPv6 address."
  usage
fi

rand() { openssl rand -hex "$1"; }

if [ -f .env.selfhost ]; then
  echo ".env.selfhost already exists, leaving it untouched."
else
  S3_SECRET_GEN=$(rand 48)
  cat > .env.selfhost <<EOF
# Generated by docker/selfhost/init.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# KEEP THIS FILE SECRET — it contains all credentials of your instance.

CG_DOMAIN=${CG_DOMAIN}
# Passkeys (docs/auth-identity §7) are bound to PASSKEY_RP_ID: empty = the
# host of CG_DOMAIN (the usual choice); otherwise that host or a parent domain
# of it. Never change it once passkeys exist. CG_LEGACY_CGID=true is only for
# the legacy CG ID gateway (passkeys on the CG ID app at CG_ID_DOMAIN, which
# Caddy then serves as a second site); keep false and CG_ID_DOMAIN empty.
PASSKEY_RP_ID=
CG_LEGACY_CGID=false
CG_ID_DOMAIN=${CG_ID_DOMAIN}
# Where Caddy gets its TLS certificates from:
#   acme      Let's Encrypt (default). The domain needs a public DNS record
#             pointing here, and ports 80/443 must be reachable from the
#             internet. CG_ACME_EMAIL is the ACME account contact.
#   internal  Caddy's own local CA, for LAN/test instances without public DNS.
#             Browsers only accept it after trusting Caddy's root certificate
#             (SELFHOST.md, "Local test instance"); CG_ACME_EMAIL is unused.
CG_TLS_MODE=${CG_TLS_MODE}
CG_ACME_EMAIL=${CG_ACME_EMAIL}
# address WebRTC media (calls) is announced at — must be reachable by every
# caller: the server's public IPv4 address, or its LAN IP for a local test
# instance (mediasoup listens on IPv4 only)
CG_PUBLIC_IP=${CG_PUBLIC_IP}
# the server's public IPv6 address, if it has one (empty = none). Recorded
# only: the stack's Docker network is IPv4-only, so do not publish an AAAA
# record for CG_DOMAIN before reading SELFHOST.md, "IPv6"
CG_PUBLIC_IPV6=${CG_PUBLIC_IPV6}

PG_SU_PASSWORD=$(rand 24)
PG_WRITER_PASSWORD=$(rand 24)
PG_READER_PASSWORD=$(rand 24)
PG_MEDIASOUP_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
REDIS_SECRET=$(rand 24)
S3_SECRET=${S3_SECRET_GEN}

# resource tuning (defaults are sized for a 16 GB machine)
# Valkey memory: REDIS_MAXMEMORY for the state instance (sessions, rate
# limits, pub/sub; refuses writes when full), REDIS_CACHE_MAXMEMORY for the
# cache instance (evicts its oldest entries when full)
REDIS_MAXMEMORY=1024mb
REDIS_CACHE_MAXMEMORY=256mb
SEAWEED_VOLUME_LIMIT_MB=1024
MEDIASOUP_DISABLE_LIBURING=true
# memory limit per container, CG_MEM_LIMIT_<SERVICE> (defaults and reasons in
# docker-compose.selfhost.yml / SELFHOST.md, "Resource tuning"); a Node
# service gets about half of it as heap. Keep REDIS at >= 2 x REDIS_MAXMEMORY.
#CG_MEM_LIMIT_API=2g
#CG_MEM_LIMIT_MEMBERLIST=4g
#CG_MEM_LIMIT_DB=4g
#CG_MEM_LIMIT_REDIS=2g
# container logs: at most CG_LOG_MAX_FILE files of CG_LOG_MAX_SIZE each
#CG_LOG_MAX_FILE=5
#CG_LOG_MAX_SIZE=20m
# uid/gid the frontend builder container runs as, so files it writes into the
# checkout keep their owner (0/0 when init.sh ran as root — that works too)
BUILDER_UID=$(id -u)
BUILDER_GID=$(id -g)

# Optional services. Set to false to leave the service out of the stack
# entirely (selfhost.sh translates these into compose profiles):
#   CG_ENABLE_CALLS=false      no mediasoup container -> no voice/video calls.
#     The call UI is hidden via the instance config, ports 4443/tcp and
#     40000-40099/udp+tcp are not needed. Everything else is unaffected.
#   CG_ENABLE_BLOCKCHAIN=false no onchain container -> no token-gated roles,
#     no balance/staking indexing, no Spark purchases, no LUKSO UP login.
#     Wallet login (EVM/SIWE) keeps working; the affected API calls fail fast
#     instead of hanging. Leave the QUIKNODE_*/CG_ACTIVE_CHAINS values alone.
CG_ENABLE_CALLS=true
CG_ENABLE_BLOCKCHAIN=true

# Server-side NSFW image filter (in-process classifier, model baked into the
# backend image). CG_ENABLE_IMAGE_FILTER=false disables it (and the client
# pre-upload warning). CG_IMAGE_FILTER_THRESHOLD overrides the reject
# threshold (default 0.8 = nsfw probability). CG_IMAGE_FILTER_MODEL_PATH
# swaps in another Transformers.js-layout classifier (mount it into the api
# and onchain containers; it needs config.json, preprocessor_config.json and
# onnx/model_quantized.onnx).
CG_ENABLE_IMAGE_FILTER=true
#CG_IMAGE_FILTER_THRESHOLD=0.8
#CG_IMAGE_FILTER_MODEL_PATH=

# bot accounts (all limits are per active owner/token; comma-separate platform operator user UUIDs)
PLATFORM_OPERATOR_USER_IDS=
BOT_USER_OWNER_LIMIT=5
BOT_COMMUNITY_OWNER_LIMIT=10
BOT_PLATFORM_OWNER_LIMIT=10
BOT_ACTIVE_TOKEN_LIMIT=10
BOT_API_RATE_LIMIT_PER_MINUTE=120
BOT_MESSAGE_RATE_LIMIT_PER_MINUTE=30

# Email (SMTP) — SELFHOST.md, "Email". Without it, email login codes,
# email verification and notification mails are unavailable.
#   CG_ENABLE_MAIL=true   run the built-in send-only relay (the "mail"
#     container): it DKIM-signs and delivers straight to the recipients' mail
#     servers over outbound port 25. Before it delivers reliably: your hoster
#     must allow outbound port 25 (many block it by default), and the DNS
#     records printed by ./selfhost/selfhost.sh mail-dns (SPF, DKIM, DMARC)
#     plus a PTR record for CG_PUBLIC_IP -> MAIL_HOSTNAME must be in place.
#     The SMTP_* values below are the app's login for this relay — keep them.
#   CG_ENABLE_MAIL=false  no relay container. Point SMTP_* at an external
#     SMTP server (your mail provider / a sending service) instead, or empty
#     SMTP_HOST to run without email.
# SMTP_SECURITY: tls (implicit TLS, usually port 465) | starttls (required,
# usually 587) | none (no TLS — only for the internal relay).
# Instances set up with --tls-internal start with email off (CG_ENABLE_MAIL=false,
# empty SMTP_HOST) so a test instance never mails the internet; to try the relay
# anyway, set CG_ENABLE_MAIL=true and SMTP_HOST=mail.
CG_ENABLE_MAIL=${INIT_ENABLE_MAIL}
SMTP_HOST=${INIT_SMTP_HOST}
SMTP_PORT=587
SMTP_SECURITY=none
SMTP_USER=cg-app
SMTP_PASSWORD=$(rand 24)
EMAIL_FROM=no-reply@${CG_DOMAIN}
EMAIL_FROM_NAME="Common Ground"
# built-in relay only: the domain it signs for (must be the domain of
# EMAIL_FROM), the name it greets other mail servers with (the PTR record of
# CG_PUBLIC_IP must point to it, and it must resolve back to CG_PUBLIC_IP)
# and the DKIM selector (the key is generated on the relay's first start)
MAIL_DOMAIN=${CG_DOMAIN}
MAIL_HOSTNAME=${CG_DOMAIN}
MAIL_DKIM_SELECTOR=cg

# Backups — SELFHOST.md, "Backup and restore". Set up with
# ./selfhost/selfhost.sh backup init, schedule with backup install-timer.
# Every backup is encrypted with CG_BACKUP_PASSWORD: keep a copy of it OFF
# this server (password manager) — without it no backup can be restored.
CG_BACKUP_PASSWORD=$(rand 32)
# local repository + staging area (absolute path on this server)
CG_BACKUP_DIR=/var/backups/commonground
# off-server copy (strongly recommended; empty = local backups only, every
# run warns) — any restic repository, e.g. a storage box over SFTP:
#   CG_BACKUP_REPOSITORY=sftp://u123456@u123456.your-storagebox.de:23/cg-backup
# or S3-compatible object storage (fill in the two keys below):
#   CG_BACKUP_REPOSITORY=s3:https://fsn1.your-objectstorage.com/my-bucket/cg-backup
CG_BACKUP_REPOSITORY=
CG_BACKUP_AWS_ACCESS_KEY_ID=
CG_BACKUP_AWS_SECRET_ACCESS_KEY=
# retention, applied to both repositories
CG_BACKUP_KEEP_DAILY=7
CG_BACKUP_KEEP_WEEKLY=4
CG_BACKUP_KEEP_MONTHLY=6
# false: never forget/prune on the off-server repository (an append-only
# target, whose retention runs elsewhere)
CG_BACKUP_REMOTE_RETENTION=true
# optional shell commands after a backup run (success) or a failed run or
# check (failure), e.g. a dead-man switch:
#   CG_BACKUP_ON_SUCCESS='curl -fsS -m 10 https://hc-ping.com/<uuid>'
#   CG_BACKUP_ON_FAILURE='curl -fsS -m 10 https://hc-ping.com/<uuid>/fail'
CG_BACKUP_ON_SUCCESS=
CG_BACKUP_ON_FAILURE=

### Optional third-party integrations — leave empty to disable the feature.

# Captcha (registration spam protection). The default provider is ALTCHA, a
# self-hosted proof-of-work captcha that needs no third-party keys — leave this
# as-is and it works out of the box. Set CAPTCHA_PROVIDER=recaptcha to use
# Google reCAPTCHA instead (fill in both keys below), or CAPTCHA_PROVIDER=off to
# disable captcha entirely (development / trusted private instances only).
CAPTCHA_PROVIDER=altcha
# HMAC secret ALTCHA signs its challenges with. Generated once here so it stays
# stable across restarts and across multiple backend instances. If left empty,
# the backend generates one and shares it via Redis.
ALTCHA_HMAC_KEY=$(rand 32)
# reCAPTCHA v2 keys (only used when CAPTCHA_PROVIDER=recaptcha).
CG_RECAPTCHA_SITE_KEY=
GOOGLE_RECAPTCHA_SECRET_KEY=

# Blockchain RPC endpoints (token-gated roles, balances, premium payments).
# The QUIKNODE_* names are historical — any JSON-RPC URL works. Defaults are
# free public endpoints (rate-limited but fine for small instances); swap in
# paid endpoints (QuikNode, Alchemy, Infura, ...) for heavier use.
# NOTE: the event listener needs unfiltered ranged eth_getLogs; many public
# endpoints restrict that method (e.g. all *.publicnode.com since 2026-07),
# so test with an unfiltered eth_getLogs call before swapping one in.
# CG_ACTIVE_CHAINS controls which chains the instance offers (backend workers
# AND the chain lists in the UI) — keep it in sync with the endpoints you set.
CG_ACTIVE_CHAINS=eth,arbitrum,xdai,base,matic,lukso
QUIKNODE_ETH=https://eth.drpc.org
QUIKNODE_BSC=https://bsc.blockrazor.xyz
QUIKNODE_MATIC=https://polygon.drpc.org
QUIKNODE_XDAI=https://rpc.gnosischain.com
QUIKNODE_FANTOM=https://rpc.fantom.network
QUIKNODE_AVAX=https://avalanche.drpc.org
QUIKNODE_ARBITRUM=https://arb1.arbitrum.io/rpc
QUIKNODE_OPTIMISM=https://optimism.drpc.org
QUIKNODE_BASE=https://mainnet.base.org
INFURA_LINEA=https://linea.drpc.org
QUIKNODE_ARBITRUM_NOVA=https://nova.arbitrum.io/rpc
QUIKNODE_CELO=https://celo.drpc.org
QUIKNODE_POLYGON_ZKEVM=https://zkevm-rpc.com
QUIKNODE_SCROLL=https://rpc.scroll.io
QUIKNODE_ZKSYNC=https://mainnet.era.zksync.io
QUIKNODE_LUKSO=https://rpc.mainnet.lukso.network/

# Token staking (docs/staking/README.md): users time-lock an ERC-20 onchain
# and earn Spark while it is locked. Off until STAKING_CHAIN,
# STAKING_TOKEN_ADDRESS and STAKING_CONTRACT_ADDRESS are all set (deploy your
# own CgStaking instance — see contracts/staking/README.md). The chain must be
# in CG_ACTIVE_CHAINS. STAKING_BASE_RATE is Spark per token per 365 days.
#STAKING_CHAIN=eth
#STAKING_TOKEN_ADDRESS=
#STAKING_CONTRACT_ADDRESS=
#STAKING_BASE_RATE=0.012
#STAKING_MIN_LOCK_DAYS=7
#STAKING_MAX_LOCK_DAYS=730

# Twitter/X login (v1 consumer keys drive the login feature; without them
# the X buttons are hidden)
TWITTER_CALLBACK_URL=https://${CG_DOMAIN}/twitter-callback
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_OAUTH2_CLIENT_ID=
TWITTER_OAUTH2_CLIENT_SECRET=

# Giphy Web SDK key (https://developers.giphy.com). Without it the GIF
# picker is hidden.
CG_GIPHY_API_KEY=

# WalletConnect Cloud project id (https://cloud.walletconnect.com). Project
# ids are origin-allowlisted, so create your own for your domain; without it
# WalletConnect-based wallets may fail to connect (injected wallets like
# MetaMask still work).
CG_WALLETCONNECT_PROJECT_ID=
EOF
  chmod 600 .env.selfhost
  echo "Wrote .env.selfhost"
fi

if [ -f s3_config/s3.selfhost.json ]; then
  echo "s3_config/s3.selfhost.json already exists, leaving it untouched."
else
  S3_SECRET_VAL=$(grep '^S3_SECRET=' .env.selfhost | cut -d= -f2)
  # the directory holds no tracked file since the dev s3.json went untracked,
  # so a fresh clone does not have it
  mkdir -p s3_config
  cat > s3_config/s3.selfhost.json <<EOF
{
  "identities": [
    {
      "name": "anonymous",
      "actions": [
        "Read:cg-media"
      ]
    },
    {
      "name": "cg_admin_user",
      "credentials": [
        {
          "accessKey": "cgadmin",
          "secretKey": "${S3_SECRET_VAL}"
        }
      ],
      "actions": [
        "Admin",
        "Read",
        "List",
        "Tagging",
        "Write"
      ]
    }
  ]
}
EOF
  # seaweed reads the bind-mounted file as its in-container user, uid 1000
  # (chrislusf/seaweedfs drops root via su-exec). Keep the production secret
  # unreadable for others: owned by 1000 with mode 600 — which needs either
  # running as uid 1000 or the right to chown (root).
  if [ "$(id -u)" = "1000" ] || chown 1000:1000 s3_config/s3.selfhost.json 2>/dev/null; then
    chmod 600 s3_config/s3.selfhost.json
  else
    chmod 644 s3_config/s3.selfhost.json
    echo "Note: s3_config/s3.selfhost.json is world-readable (mode 644): seaweed reads it as"
    echo "      uid 1000 and this user can't chown it. To tighten it, run as root:"
    echo "        chown 1000:1000 s3_config/s3.selfhost.json && chmod 600 s3_config/s3.selfhost.json"
  fi
  echo "Wrote s3_config/s3.selfhost.json"
fi

if [ -f selfhost/certs/server.crt ]; then
  echo "selfhost/certs/server.crt already exists, leaving it untouched."
else
  mkdir -p selfhost/certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=mediasoup" \
    -keyout selfhost/certs/server.key \
    -out selfhost/certs/server.crt 2>/dev/null
  chmod 644 selfhost/certs/server.crt
  chmod 600 selfhost/certs/server.key
  echo "Wrote selfhost/certs/ (internal cert for the caddy->mediasoup hop)"
fi

# an existing .env.selfhost was left untouched, so its mode is the one that
# applies, not the flag of this run
EXISTING_TLS_MODE=$(grep '^CG_TLS_MODE=' .env.selfhost | cut -d= -f2 || true)
EXISTING_TLS_MODE="${EXISTING_TLS_MODE:-acme}"
if [ "$EXISTING_TLS_MODE" != "$CG_TLS_MODE" ]; then
  echo
  echo "Note: the existing .env.selfhost uses CG_TLS_MODE=${EXISTING_TLS_MODE}; this run's"
  echo "      setting was not applied. Edit .env.selfhost to switch (see SELFHOST.md)."
  CG_TLS_MODE="$EXISTING_TLS_MODE"
fi

echo
echo "Initialization complete. Next steps:"
if [ "$CG_TLS_MODE" = "internal" ]; then
  echo "  1. On every client machine, map ${CG_DOMAIN} to ${CG_PUBLIC_IP}"
  echo "     (/etc/hosts or local DNS), and after the first start trust Caddy's root"
  echo "     certificate there — see SELFHOST.md, \"Local test instance\""
else
  echo "  1. Point a DNS A record for ${CG_DOMAIN} to ${CG_PUBLIC_IP}. No AAAA record for now"
  echo "     (the stack is IPv4-only behind Docker's proxy — SELFHOST.md, \"IPv6\")"
fi
echo "  2. Open ports 80, 443 (tcp+udp) in your firewall, plus 4443 (tcp) and 40000-40099"
echo "     (udp+tcp) for calls (CG_ENABLE_CALLS). On a dedicated Ubuntu/Debian server,"
echo "     sudo ./selfhost/harden.sh --dry-run shows the firewall, SSH and system settings"
echo "     it would apply (SELFHOST.md, \"Server hardening\")"
echo "  3. Run: ./selfhost/selfhost.sh build"
echo "  4. Run: ./selfhost/selfhost.sh up"
if grep -q '^CG_ENABLE_MAIL=true' .env.selfhost; then
  echo "  5. Email (built-in relay, CG_ENABLE_MAIL=true): run ./selfhost/selfhost.sh mail-dns and"
  echo "     publish the records it prints; check that your hoster allows outbound port 25"
  echo "     (or switch to an external SMTP server — SELFHOST.md, \"Email\")"
else
  echo "  5. Email is off (CG_ENABLE_MAIL / SMTP_HOST in .env.selfhost) — see SELFHOST.md, \"Email\""
fi
