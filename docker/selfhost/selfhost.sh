#!/bin/bash
# Build and operate a self-hosted Common Ground instance.
# Run docker/selfhost/init.sh once first — see docker/SELFHOST.md.
set -euo pipefail
cd "${0%/*}/.."   # docker/

# Backup and restore live in their own script (docker/SELFHOST.md, "Backup and
# restore"). A restore onto a fresh server runs before .env.selfhost exists —
# it brings that file back — so this comes before the check below.
case "${1:-}" in
  backup|restore)
    exec ./selfhost/backup.sh "$@"
    ;;
esac

if [ ! -f .env.selfhost ]; then
  echo "No .env.selfhost found. Run ./selfhost/init.sh <domain> <acme-email> first."
  exit 1
fi
source .env.selfhost

# Optional services live behind compose profiles. Calls and blockchain
# default to ON, so an .env.selfhost written before these switches existed
# keeps every service. The mail relay is the exception: it is on only when
# CG_ENABLE_MAIL=true (init.sh writes that), so upgrading an older instance
# never starts sending mail from this server before its DNS is set up.
mail_enabled() {
  [ "${CG_ENABLE_MAIL:-false}" = "true" ]
}

calls_enabled() {
  [ "${CG_ENABLE_CALLS:-true}" != "false" ]
}

compose_profiles() {
  local profiles=""
  if calls_enabled; then
    profiles="calls"
  fi
  if [ "${CG_ENABLE_BLOCKCHAIN:-true}" != "false" ]; then
    profiles="${profiles:+$profiles,}blockchain"
  fi
  if mail_enabled; then
    profiles="${profiles:+$profiles,}mail"
  fi
  echo "$profiles"
}

# Starts the stack and removes the containers of optional services that are
# switched off. `--remove-orphans` does not cover those: a service whose
# profile is inactive is still part of the compose file, so its container
# (and, for mediasoup, the published media ports) would stay. Idempotent.
start_stack() {
  # a backup killed while seaweed was frozen (docker pause) leaves it paused,
  # and `up` does not resume a paused container
  if [ -n "$(docker_compose ps -q --status paused seaweed)" ]; then
    echo "seaweed was left paused (an interrupted backup?) — resuming it"
    docker_compose unpause seaweed
  fi
  docker_compose up -d --remove-orphans
  local off=()
  if ! calls_enabled; then
    off+=(mediasoup)
  fi
  if [ "${CG_ENABLE_BLOCKCHAIN:-true}" = "false" ]; then
    off+=(onchain)
  fi
  if ! mail_enabled; then
    off+=(mail)
  fi
  if [ ${#off[@]} -gt 0 ]; then
    docker_compose rm -s -f "${off[@]}"
  fi
}

# loopback or a single-label name (a compose service such as the relay);
# the backend uses the same rule for its plaintext warning
internal_smtp_host() {
  case "$1" in
    localhost|::1|\[::1\]|127.*) return 0 ;;
    *.*) return 1 ;;
  esac
  [[ "$1" =~ ^[A-Za-z0-9-]+$ ]]
}

# warns (never fails) about mail settings that cannot work together
check_mail_config() {
  if [ -n "${SENDGRID_API_KEY:-}" ] || [ -n "${MAILCHIMP_API_KEY:-}" ]; then
    echo "Note: SENDGRID_API_KEY / MAILCHIMP_API_KEY in .env.selfhost are no longer used —"
    echo "      email goes out over SMTP now (SELFHOST.md, \"Email\"). Remove them."
    if [ -z "${SMTP_HOST:-}" ]; then
      echo "Warning: SMTP_HOST is not set, so EMAIL IS DISABLED — no login codes, no verification"
      echo "         and no notification mails — until you set SMTP_*. To keep sending through"
      echo "         SendGrid, see SELFHOST.md, \"Moving from SendGrid\"."
    fi
  fi
  if [ -n "${SMTP_HOST:-}" ] && [ "${SMTP_SECURITY:-starttls}" = "none" ] && ! internal_smtp_host "$SMTP_HOST"; then
    echo "Warning: SMTP_SECURITY=none sends every mail${SMTP_USER:+ and the SMTP password} to '$SMTP_HOST'"
    echo "         unencrypted. Use tls or starttls for any server other than the built-in relay."
  fi
  if mail_enabled; then
    if [ "${SMTP_HOST:-}" != "mail" ]; then
      echo "Warning: CG_ENABLE_MAIL=true starts the built-in relay, but SMTP_HOST is '${SMTP_HOST:-}'"
      echo "         — the app does not use it. Set SMTP_HOST=mail (or CG_ENABLE_MAIL=false)."
    fi
    if [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASSWORD:-}" ]; then
      echo "Warning: CG_ENABLE_MAIL=true needs SMTP_USER and SMTP_PASSWORD (the app's relay login);"
      echo "         the mail container does not start without them."
    fi
    # an empty EMAIL_FROM means no-reply@CG_DOMAIN (the host of BASE_URL)
    local from="${EMAIL_FROM:-no-reply@${CG_DOMAIN:-}}"
    local from_domain="${from##*@}"
    local mail_domain="${MAIL_DOMAIN:-${CG_DOMAIN:-}}"
    if [ "$from_domain" != "$mail_domain" ]; then
      echo "Warning: mail is sent from '$from' (EMAIL_FROM), but the relay only sends for"
      echo "         MAIL_DOMAIN '$mail_domain' — every mail would be refused. Make them match."
    fi
  elif [ "${SMTP_HOST:-}" = "mail" ]; then
    echo "Warning: SMTP_HOST=mail, but CG_ENABLE_MAIL is not true, so there is no mail container."
    echo "         Set CG_ENABLE_MAIL=true, or point SMTP_* at an external SMTP server."
  fi
}

# prints the DNS records the built-in relay needs
mail_dns() {
  if ! mail_enabled; then
    echo "CG_ENABLE_MAIL is not true, so the built-in mail relay is not used."
    echo "With an external SMTP server, its provider tells you which SPF/DKIM records to set."
    exit 1
  fi
  local domain="${MAIL_DOMAIN:-$CG_DOMAIN}"
  local host="${MAIL_HOSTNAME:-$CG_DOMAIN}"
  local selector="${MAIL_DKIM_SELECTOR:-cg}"
  local dkim
  # the key is generated by the relay on its first start and lives only in
  # the mail-data volume; read its public half with a throwaway container
  if ! dkim="$(docker_compose run --rm --no-deps -T --entrypoint cat mail "/data/dkim_keys/${domain}_${selector}.dns" 2>/dev/null)" || [ -z "$dkim" ]; then
    echo "No DKIM key yet — the mail container generates it on its first start."
    echo "Run ./selfhost/selfhost.sh up first, then this command again."
    exit 1
  fi
  # a TXT string holds at most 255 characters; zone files take several quoted
  # strings, which resolvers join without separator
  local chunked
  chunked="$(printf '%s' "$dkim" | fold -w 250 | sed 's/.*/"&"/' | paste -sd ' ' -)"

  cat <<EOF
DNS records for mail from ${domain} (built-in relay, sending host ${host}, IP ${CG_PUBLIC_IP}).
Set them at your DNS provider; TTLs are up to you.

1. SPF — which servers may send for ${domain}. If ${domain} already has an SPF
   record (e.g. for a mailbox provider), add ip4:${CG_PUBLIC_IP} to it instead:
   a domain must not have two SPF records.

   ${domain}.  TXT  "v=spf1 ip4:${CG_PUBLIC_IP} -all"

2. DKIM — public key of the relay's signing key (selector ${selector}):

   ${selector}._domainkey.${domain}.  TXT  ${chunked}

   The same value as one string, for DNS web interfaces that split it themselves:
   ${dkim}

3. DMARC — what receivers do with mail that fails SPF/DKIM. Start with p=none,
   watch the reports (add rua=mailto:<your address> to get them), then tighten
   to p=quarantine or p=reject:

   _dmarc.${domain}.  TXT  "v=DMARC1; p=none; adkim=s; aspf=s"

4. Reverse DNS (PTR) — set at your HOSTER (not your DNS provider) for the
   server IP. It must point to the relay's host name, and that name must
   resolve back to the same IP:

   ${CG_PUBLIC_IP}  PTR  ${host}.
   ${host}.  A  ${CG_PUBLIC_IP}

Also check that your hoster allows outbound connections to port 25 — many block
it for new servers until you ask. The relay keeps undeliverable mail in its
queue and retries for about three days (./selfhost/selfhost.sh logs mail).
EOF
}

# The legacy CG ID mini-app (passkeys on a separate CG ID origin) is served
# only by the legacy CG ID gateway: both CG_LEGACY_CGID=true and a
# CG_ID_DOMAIN are needed. Older .env.selfhost files carry a CG_ID_DOMAIN
# from init.sh; on a normal instance it is ignored.
cgid_vhost() {
  if [ "${CG_LEGACY_CGID:-false}" = "true" ] && [ -n "${CG_ID_DOMAIN:-}" ]; then
    echo on
  else
    echo off
  fi
}

# warns (never fails) about edge settings that do not do what they look like
check_edge_config() {
  if [ -n "${CG_ID_DOMAIN:-}" ] && [ "$(cgid_vhost)" = "off" ]; then
    echo "Note: CG_ID_DOMAIN is set, but the CG ID app is served only with CG_LEGACY_CGID=true"
    echo "      (the legacy CG ID gateway). Passkeys run on ${CG_DOMAIN:-CG_DOMAIN} itself; you can"
    echo "      remove CG_ID_DOMAIN from .env.selfhost and its DNS record."
  fi
  if [ "${CG_LEGACY_CGID:-false}" = "true" ] && [ -z "${CG_ID_DOMAIN:-}" ]; then
    echo "Warning: CG_LEGACY_CGID=true needs CG_ID_DOMAIN (the CG ID app's domain); without it"
    echo "         the backend refuses to start. Set CG_ID_DOMAIN, or CG_LEGACY_CGID=false."
  fi
}

# up, down and update must not run while a backup or restore of this instance
# does (backup.sh holds /run/lock/cg-backup-<project>.lock). The `compose`
# passthrough, which backup.sh itself uses, takes no lock.
backup_lock() {
  if [ "${CG_BACKUP_LOCK_HELD:-}" = 1 ]; then
    return 0
  fi
  local project lock
  project="${COMPOSE_PROJECT_NAME:-$(sed -n 's/^name:[[:space:]]*//p' docker-compose.selfhost.yml | head -1)}"
  lock="/run/lock/cg-backup-$project.lock"
  # without /run/lock no backup can run either
  if [ ! -d /run/lock ] || [ ! -w /run/lock ]; then
    return 0
  fi
  (umask 022; : >> "$lock") 2>/dev/null || true
  exec 8<"$lock" || return 0
  if ! flock -n 8; then
    echo "A backup or restore of this instance is running (lock $lock) — try again when it has finished."
    exit 1
  fi
  # held across the exec of `update` into the pulled script
  export CG_BACKUP_LOCK_HELD=1
}

docker_compose() {
  local profiles
  profiles="$(compose_profiles)"
  local files=(-f docker-compose.selfhost.yml)
  if calls_enabled; then
    files+=(-f docker-compose.selfhost.calls.yml)
  fi
  export CG_CGID_VHOST
  CG_CGID_VHOST="$(cgid_vhost)"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_PROFILES="$profiles" docker compose --env-file .env.selfhost "${files[@]}" "$@"
  elif docker-compose version >/dev/null 2>&1; then
    COMPOSE_PROFILES="$profiles" docker-compose --env-file .env.selfhost "${files[@]}" "$@"
  else
    echo "Neither docker compose nor docker-compose is available."
    exit 1
  fi
}

checkError() {
  if [ ! $? -eq 0 ]; then
    printf "\n\nAn error occurred in the current step\nExiting...\n"
    exit 1
  fi
}

build() {
  printf "\n---\n--- Building builder image\n---\n"
  docker_compose build cg-builder
  checkError



  printf "\n---\n--- Installing frontend dependencies\n---\n"
  docker_compose run --rm cg-builder yarn install --immutable
  checkError

  buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
  else
    sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
  fi

  # Type-check and lint are separate steps now: the webpack build ran
  # ForkTsChecker + ESLintPlugin inline and a Vite build does neither.
  # Sourcemaps ship on every path — the app is AGPL, the old no-sourcemap
  # policy dated from the closed-source era.
  printf "\n---\n--- Type-checking, linting and building the frontend\n---\n"
  docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod cg-builder \
    bash -c "yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite"
  checkError
  mkdir -p caddy/dist && rm -rf caddy/dist/* && rsync -a ../build/* caddy/dist/
  checkError

  printf "\n---\n--- Building caddy image\n---\n"
  docker_compose build --no-cache caddy
  checkError

  if [ ! -f vapid_keys.json ]; then
    printf "\n---\n--- Generating vapid_keys.json for web push\n---\n"
    if [ ! -d ../srv/node_modules/web-push ]; then
      docker_compose run --rm -T cg-builder bash -c "cd srv && yarn install --immutable"
    fi
    docker_compose run --rm -T cg-builder bash -c "cd srv && npx --no web-push generate-vapid-keys --json > ../docker/vapid_keys.json"
    checkError
  fi

  printf "\n---\n--- Building backend\n---\n"
  rm -rf backend/dist/{*,.??*} || true
  rsync -aL --exclude=node_modules --exclude=.yarn ../srv/ backend/dist/
  cp ../build/index.html backend/dist/
  docker build --tag commonground/backend_stage_0 -f backend/Dockerfile_dev_stage_0 ./backend/
  checkError
  docker_compose build --no-cache api
  checkError

  printf "\n---\n--- Building database image\n---\n"
  docker_compose build --no-cache db
  checkError

  printf "\n---\n--- Build finished. Start your instance with: ./selfhost/selfhost.sh up\n---\n"
}

case "${1:-}" in
  build)
    build
    ;;
  up)
    backup_lock
    check_mail_config
    check_edge_config
    # --remove-orphans cleans up containers of services that are no longer
    # part of the stack (e.g. after the three redis instances were merged
    # into one); start_stack also removes switched-off optional services
    start_stack
    docker_compose ps
    ;;
  down)
    backup_lock
    docker_compose down --remove-orphans
    ;;
  logs)
    docker_compose logs -f "${@:2}"
    ;;
  ps)
    docker_compose ps
    ;;
  stats)
    docker stats --no-stream
    ;;
  compose)
    docker_compose "${@:2}"
    ;;
  update)
    backup_lock
    git pull
    # Continue in the script that was just pulled: bash keeps running the old
    # copy, whose build steps may no longer match the pulled compose files.
    # (cwd is docker/ here, see the top of the script.)
    exec ./selfhost/selfhost.sh _build-and-up
    ;;
  _build-and-up)
    # second half of `update`, run by the freshly pulled script
    backup_lock
    build
    check_mail_config
    check_edge_config
    start_stack
    docker_compose ps
    ;;
  mail-dns)
    mail_dns
    ;;
  *)
    printf "Usage: ./selfhost.sh <command>\n\n"
    printf "  build    Build frontend, backend, caddy and db images\n"
    printf "  up       Start the instance (detached)\n"
    printf "  down     Stop the instance\n"
    printf "  logs     Follow logs (optionally: logs <service>)\n"
    printf "  ps       Show container status\n"
    printf "  stats    Show container resource usage\n"
    printf "  compose  Pass arguments to docker compose\n"
    printf "  update   git pull + rebuild + restart\n"
    printf "  mail-dns Print the DNS records (SPF, DKIM, DMARC, PTR) for the built-in mail relay\n"
    printf "  backup   Backups: init | run | list | check | verify | install-timer (see: backup help)\n"
    printf "  restore  Restore a backup (see: restore --help)\n\n"
    printf "Optional services (set in .env.selfhost):\n"
    printf "  CG_ENABLE_CALLS=false       do not run mediasoup (no voice/video calls)\n"
    printf "  CG_ENABLE_BLOCKCHAIN=false  do not run onchain (no token gating/indexing)\n"
    printf "  CG_ENABLE_IMAGE_FILTER=false  disable the server-side NSFW image filter\n"
    printf "  CG_ENABLE_MAIL=true         run the built-in send-only mail relay (init.sh sets it;\n"
    printf "                              false: send through an external SMTP server, SMTP_*)\n"
    exit 1
    ;;
esac
