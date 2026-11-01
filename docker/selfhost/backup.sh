#!/bin/bash
# Backup and restore of a self-hosted Common Ground instance — called by
# selfhost.sh (`./selfhost/selfhost.sh backup …` / `restore …`); the guide is
# docker/SELFHOST.md, "Backup and restore".
#
# One backup = one restic snapshot (tag cg-backup, plus machine-<id> of the
# server that made it) holding:
#   /cg/MANIFEST          format, time, domain, machine, commit, Postgres
#                         version, newest migration, sha256 of the dump,
#                         components
#   /cg/db/               pg_dump -Fc of the database (uncompressed — restic
#                         compresses and deduplicates) + exact row counts
#                         taken in the same database snapshot as the dump
#   /cg/secrets/          .env.selfhost, vapid_keys.json,
#                         s3_config/s3.selfhost.json, selfhost/certs/, backup/
#   /cg/media/            the seaweedfs-data volume (see "freeze" below)
#   /cg/caddy/            the caddy-data volume (ACME account, certificates,
#                         the local CA of a `tls internal` instance)
#   /cg/mail/dkim_keys/   the DKIM key of the built-in mail relay
# Everything is encrypted by restic with CG_BACKUP_PASSWORD. Valkey is not
# backed up (sessions, rate-limit windows and short-lived codes; a restore
# logs everyone out once).
#
# The snapshot lands in a local repository (CG_BACKUP_DIR/repo) and is then
# copied to the off-server repository CG_BACKUP_REPOSITORY (any restic
# repository: sftp:, s3:, rest:, …) — without one, every run warns loudly.
#
# Secrets never appear in process arguments: restic, pg_restore and psql get
# them as environment variables (docker run -e NAME passes the value from the
# environment of the docker CLI) or read them inside the container.
# The single-quoted scripts below run in helper containers and expand there.
# The undo record is read in loops that also grep it (never written there).
# shellcheck disable=SC2016,SC2094
set -euo pipefail
umask 077
cd "${0%/*}/.."   # docker/
DOCKER_DIR="$(pwd)"
SELFHOST="$DOCKER_DIR/selfhost/selfhost.sh"

# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md). The image also serves as the helper
# for file operations in volumes (busybox, jq, ssh tools).
RESTIC_IMAGE="restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510"
FORMAT="cg-backup-1"
TAG="cg-backup"
WARMUP_TAG="cg-warmup"
# files and directories of the secrets bundle, relative to docker/
SECRET_PATHS=(.env.selfhost vapid_keys.json s3_config/s3.selfhost.json selfhost/certs backup)
ALL_COMPONENTS="secrets db media caddy mail"
# digits only: also part of database names (pre-restore copies)
STAMP="$(date -u +%Y%m%d%H%M%S)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
HOOK_ON_DIE=0
die() {
  printf 'ERROR: %s\n' "$*" >&2
  # a scheduled backup/check/verify that fails before its EXIT trap exists
  # (settings, image pull, password, machine id, lock, backup dir) must still
  # alert — once: never from a $(…) subshell, and the trap clears the flag
  if [ "$HOOK_ON_DIE" = 1 ] && [ "$BASHPID" = "$$" ]; then
    HOOK_ON_DIE=0
    run_hook "${CG_BACKUP_ON_FAILURE:-}" failure 1
  fi
  exit 1
}

# ---------------------------------------------------------------- settings --

# Backup settings from the caller's environment win over .env.selfhost (as
# shell variables win over --env-file in docker compose): a restore can read
# another instance's repository — e.g. production's on a drill server — and a
# fresh server has no .env.selfhost to read them from.
OVERRIDABLE=(CG_BACKUP_DIR CG_BACKUP_REPOSITORY CG_BACKUP_PASSWORD CG_BACKUP_HOST
  CG_BACKUP_AWS_ACCESS_KEY_ID CG_BACKUP_AWS_SECRET_ACCESS_KEY CG_BACKUP_AWS_DEFAULT_REGION
  CG_BACKUP_MACHINE_ID)
declare -A FROM_ENV=()
for v in "${OVERRIDABLE[@]}"; do
  if [ -n "${!v+x}" ]; then FROM_ENV[$v]="${!v}"; fi
done
unset v

load_settings() {
  if [ -f .env.selfhost ]; then
    # shellcheck disable=SC1091
    source ./.env.selfhost
  fi
  local v p
  for v in "${!FROM_ENV[@]}"; do
    printf -v "$v" '%s' "${FROM_ENV[$v]}"
  done
  CG_BACKUP_DIR="${CG_BACKUP_DIR:-/var/backups/commonground}"
  CG_BACKUP_DIR="${CG_BACKUP_DIR%/}"
  CG_BACKUP_REPOSITORY="${CG_BACKUP_REPOSITORY:-}"
  CG_BACKUP_PASSWORD="${CG_BACKUP_PASSWORD:-}"
  CG_BACKUP_HOST="${CG_BACKUP_HOST:-${CG_DOMAIN:-cg-selfhost}}"
  CG_BACKUP_KEEP_DAILY="${CG_BACKUP_KEEP_DAILY:-7}"
  CG_BACKUP_KEEP_WEEKLY="${CG_BACKUP_KEEP_WEEKLY:-4}"
  CG_BACKUP_KEEP_MONTHLY="${CG_BACKUP_KEEP_MONTHLY:-6}"
  CG_BACKUP_REMOTE_RETENTION="${CG_BACKUP_REMOTE_RETENTION:-true}"
  CG_BACKUP_CHECK_SUBSET="${CG_BACKUP_CHECK_SUBSET:-5%}"
  CG_BACKUP_DRILL="${CG_BACKUP_DRILL:-false}"
  CG_BACKUP_DRILL_SOURCE="${CG_BACKUP_DRILL_SOURCE:-}"
  CG_BACKUP_SSH_DIR="$DOCKER_DIR/backup/ssh"
  case "$CG_BACKUP_DIR" in
    /?*) ;;
    *) die "CG_BACKUP_DIR must be an absolute path below / (is: ${CG_BACKUP_DIR:-/})" ;;
  esac
  # the backups must not end up inside what they back up
  for p in "${SECRET_PATHS[@]}"; do
    case "$CG_BACKUP_DIR/" in
      "$DOCKER_DIR/$p/"*) die "CG_BACKUP_DIR ($CG_BACKUP_DIR) is inside docker/$p, which is part of every backup — move it elsewhere" ;;
    esac
  done
  case "$CG_BACKUP_REMOTE_RETENTION" in
    true|false) ;;
    *) die "CG_BACKUP_REMOTE_RETENTION must be true or false" ;;
  esac
  # the compose project (volume prefix): COMPOSE_PROJECT_NAME wins over the
  # name: line of the compose file, as in docker compose itself
  PROJECT="${COMPOSE_PROJECT_NAME:-$(sed -n 's/^name:[[:space:]]*//p' docker-compose.selfhost.yml | head -1)}"
  [ -n "$PROJECT" ] || die "could not determine the compose project name"
}

# which server made a backup: guards a repository against two servers writing
# one timeline (a drill copy, a forgotten old server). Sets MACHINE_TAG.
MACHINE_TAG=""
ensure_machine_tag() {
  local mid="${CG_BACKUP_MACHINE_ID:-}"
  if [ -z "$mid" ]; then
    [ -s /etc/machine-id ] || die "this system has no /etc/machine-id (e.g. a container) — set CG_BACKUP_MACHINE_ID to a fixed value unique to this server"
    mid="$(cat /etc/machine-id)"
  fi
  MACHINE_TAG="machine-$(printf '%s' "$mid" | sha256sum | cut -c1-12)"
}

# owner of the checkout: restored .env.selfhost and backup/ belong to it, also
# when the restore runs as root (sudo)
CHECKOUT_UID="$(stat -c %u "$DOCKER_DIR")"
CHECKOUT_GID="$(stat -c %g "$DOCKER_DIR")"

require_env_file() {
  [ -f .env.selfhost ] || die "no .env.selfhost — run ./selfhost/init.sh first (or restore the secrets: SELFHOST.md, \"Backup and restore\")"
}

require_password() {
  if [ -z "$CG_BACKUP_PASSWORD" ]; then
    if [ -t 0 ]; then
      read -rsp "Backup password (CG_BACKUP_PASSWORD): " CG_BACKUP_PASSWORD
      echo
    fi
    [ -n "$CG_BACKUP_PASSWORD" ] || die "CG_BACKUP_PASSWORD is not set — run ./selfhost/selfhost.sh backup init"
  fi
}

RESTORE_DRILL=0
# A drill instance (restore --drill) holds another instance's data. It reads
# that instance's repository (CG_BACKUP_DRILL_SOURCE) but never writes to it.
drill_mode() { [ "$CG_BACKUP_DRILL" = true ] || [ "$RESTORE_DRILL" = 1 ]; }
# what a restore changed because this is a drill; printed at its end
DRILL_NOTES=()
drill_note() { DRILL_NOTES+=("$*"); }

# the off-server repository: CG_BACKUP_REPOSITORY, or — on a drill instance,
# for reading only — the repository it was restored from
remote_url() {
  if [ -n "$CG_BACKUP_REPOSITORY" ] && ! drill_mode; then
    printf '%s' "$CG_BACKUP_REPOSITORY"
  elif drill_mode; then
    printf '%s' "${CG_BACKUP_DRILL_SOURCE:-$CG_BACKUP_REPOSITORY}"
  fi
}
remote_configured() { [ -n "$(remote_url)" ]; }
remote_writable() { remote_configured && ! drill_mode; }

# a repository URL without the credentials a rest: URL may carry
redact_url() { sed -E 's#(://)[^/@]*:[^/@]*@#\1***@#' <<< "$1"; }

warn_no_remote() {
  if drill_mode; then
    log "drill instance: nothing is written to an off-server repository"
    return
  fi
  cat >&2 <<'EOF'

######################################################################
# WARNING: NO OFF-SERVER COPY. CG_BACKUP_REPOSITORY is empty, so this
# backup exists on this server only — a failed disk, a lost server or
# a compromised host takes it along. Configure an off-server
# repository (SELFHOST.md, "Backup and restore", "Setting it up").
######################################################################

EOF
}

# --------------------------------------------------------- docker helpers --

sh_compose() { "$SELFHOST" compose "$@"; }
# the same without compose's per-container progress lines (errors still show)
sh_compose_q() { "$SELFHOST" compose --progress quiet "$@"; }

# $1 = service, $2 = running | paused. A failing compose call is an error,
# never "not running".
service_in_state() {
  local out
  out="$(sh_compose ps -q --status "$2" "$1")" || die "docker compose ps failed for $1"
  [ -n "$out" ]
}
service_running() { service_in_state "$1" running; }

volume_name() { printf '%s_%s' "$PROJECT" "$1"; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# runs a busybox shell script in the restic image; extra docker options
# (mounts) come before "--", the script and its arguments after it
helper() {
  local -a opts=()
  while [ "$1" != "--" ]; do opts+=("$1"); shift; done
  shift
  local script="$1"; shift
  docker run --rm --network none "${opts[@]}" --entrypoint /bin/sh "$RESTIC_IMAGE" -c "$script" helper "$@"
}

# true when volume $1 holds nothing; a failing helper is an error, never "empty"
volume_empty() {
  local out
  out="$(helper -v "$1:/v:ro" -- 'ls -A /v | head -1')" || die "could not look into volume $1"
  [ -z "$out" ]
}

volume_size() {
  helper -v "$1:/v:ro" -- 'du -sh /v | cut -f1'
}

# creates a volume the way compose would, so `up` adopts it without warning
ensure_volume() {
  local vol; vol="$(volume_name "$1")"
  if ! volume_exists "$vol"; then
    docker volume create \
      --label "com.docker.compose.project=$PROJECT" \
      --label "com.docker.compose.volume=$1" \
      "$vol" >/dev/null
  fi
}

# restic in its pinned container. $1 = local | remote: which repository
# RESTIC_REPOSITORY points at; FROM_REPO=local|remote (set by the caller)
# names the source repository of copy / init --copy-chunker-params. Docker
# options before "--", restic arguments after it. CG_BACKUP_DIR is mounted at
# /backup (cache in /backup/cache). On a drill instance the remote is read
# without locks, so nothing is ever written to it.
restic_c() {
  local repo="$1"; shift
  local -a opts=(--rm --hostname cg-backup -v "$CG_BACKUP_DIR:/backup"
    -e RESTIC_CACHE_DIR=/backup/cache -e RESTIC_PASSWORD -e RESTIC_REPOSITORY
    -e RESTIC_FROM_PASSWORD -e RESTIC_FROM_REPOSITORY)
  local -a ropts=()
  while [ "$1" != "--" ]; do opts+=("$1"); shift; done
  shift
  local url remote
  remote="$(remote_url)"
  if [ "$repo" = local ]; then
    url=/backup/repo
  else
    url="$remote"
    if drill_mode; then ropts+=(--no-lock); fi
  fi
  # the remote may be the source of a copy too, so its transport options are
  # always set when it is configured
  case "$remote" in
    s3:*)
      opts+=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)
      if [ -n "${CG_BACKUP_AWS_DEFAULT_REGION:-}" ]; then opts+=(-e AWS_DEFAULT_REGION); fi
      ;;
    sftp:*)
      [ -f "$CG_BACKUP_SSH_DIR/id_ed25519" ] || die "no SSH key for the sftp repository at $CG_BACKUP_SSH_DIR/id_ed25519 — run ./selfhost/selfhost.sh backup init"
      opts+=(-v "$CG_BACKUP_SSH_DIR:/ssh:ro")
      ropts+=(-o "sftp.args=-i /ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=/ssh/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ServerAliveInterval=60")
      ;;
  esac
  (
    export RESTIC_PASSWORD="$CG_BACKUP_PASSWORD" RESTIC_FROM_PASSWORD="$CG_BACKUP_PASSWORD"
    export RESTIC_REPOSITORY="$url"
    case "${FROM_REPO:-}" in
      local) export RESTIC_FROM_REPOSITORY=/backup/repo ;;
      remote) export RESTIC_FROM_REPOSITORY="$remote" ;;
      *) unset RESTIC_FROM_REPOSITORY ;;
    esac
    export AWS_ACCESS_KEY_ID="${CG_BACKUP_AWS_ACCESS_KEY_ID:-}"
    export AWS_SECRET_ACCESS_KEY="${CG_BACKUP_AWS_SECRET_ACCESS_KEY:-}"
    export AWS_DEFAULT_REGION="${CG_BACKUP_AWS_DEFAULT_REGION:-}"
    # RESTIC_C_TIMEOUT (seconds, set by the caller) bounds a call that must
    # not hang on an unreachable repository
    exec ${RESTIC_C_TIMEOUT:+timeout "$RESTIC_C_TIMEOUT"} docker run "${opts[@]}" "$RESTIC_IMAGE" "$@" "${ropts[@]}"
  )
}

# jq in the restic image, JSON on stdin
jq_c() { docker run --rm -i --network none --entrypoint jq "$RESTIC_IMAGE" "$@"; }

# only for the local repository: a remote one that does not exist yet makes
# restic retry for minutes (see init_repo)
repo_initialized() {
  restic_c "$1" -- cat config >/dev/null 2>&1
}

# fails with a precise message unless the local repository opens
require_local_repo() {
  local out rc=0
  out="$(restic_c local -- cat config 2>&1 >/dev/null)" || rc=$?
  case "$rc" in
    0) ;;
    10) die "the local repository $CG_BACKUP_DIR/repo is not initialized — run ./selfhost/selfhost.sh backup init" ;;
    12) die "CG_BACKUP_PASSWORD does not open the local repository $CG_BACKUP_DIR/repo" ;;
    *) printf '%s\n' "$out" >&2; die "cannot open the local repository $CG_BACKUP_DIR/repo (restic exit $rc)" ;;
  esac
}

# initializes repository $1 unless it already is: `restic init` refuses an
# existing repository right away, whereas probing a missing remote one first
# would make restic retry for minutes
init_repo() {
  local repo="$1" out rc=0
  shift
  out="$(restic_c "$repo" -- init "$@" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then
    log "$repo repository initialized"
  elif grep -qiE 'already (initialized|exists)' <<< "$out"; then
    log "$repo repository: already initialized"
  else
    printf '%s\n' "$out" >&2
    die "could not initialize the $repo repository"
  fi
}

# ------------------------------------------------------------ lock + hooks --

CURRENT_COMMAND=""
run_hook() {
  local hook="$1" result="$2" rc="$3"
  [ -n "$hook" ] || return 0
  log "running the $result hook"
  CG_BACKUP_RESULT="$result" CG_BACKUP_COMMAND="$CURRENT_COMMAND" CG_BACKUP_EXIT_CODE="$rc" \
    bash -c "$hook" || log "the $result hook failed (exit $?)"
}

# Exactly one backup or restore of this instance at a time (a timer run and a
# manual restore must not interleave). The lock file has a fixed path, shared
# by every user that runs the script.
open_lock() {
  [ -d /run/lock ] && [ -w /run/lock ] \
    || die "/run/lock is missing or not writable — backups need it for their lock file"
  LOCK_FILE="/run/lock/cg-backup-$PROJECT.lock"
  (umask 022; : >> "$LOCK_FILE") 2>/dev/null || true
  exec 9<"$LOCK_FILE" || die "cannot open the lock file $LOCK_FILE"
}

take_lock() {
  open_lock
  if ! flock -n 9; then
    log "ERROR: another backup or restore of $PROJECT is running (lock $LOCK_FILE) — this $CURRENT_COMMAND did not run"
    if [[ "$CURRENT_COMMAND" == backup* ]]; then run_hook "${CG_BACKUP_ON_FAILURE:-}" failure 75; fi
    HOOK_ON_DIE=0
    exit 75
  fi
  # a signal (Ctrl-C, systemctl stop) ends the run through the EXIT trap, so
  # a frozen seaweed is resumed and temporary files are removed
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  ensure_backup_dir
  sweep_leftovers
}

# CG_BACKUP_DIR is created owned by the checkout owner with mode 700 —
# otherwise the first `docker run -v` would create it as root, mode 755
ensure_backup_dir() {
  if [ ! -d "$CG_BACKUP_DIR" ]; then
    helper -v "$CG_BACKUP_DIR:/b" -- 'chown "$1:$2" /b && chmod 700 /b' "$CHECKOUT_UID" "$CHECKOUT_GID" \
      || die "could not create $CG_BACKUP_DIR"
  fi
  # the dump and the restore staging are read on the host
  if [ "$(id -u)" != 0 ] && { [ ! -r "$CG_BACKUP_DIR" ] || [ ! -x "$CG_BACKUP_DIR" ]; }; then
    die "$(id -un) cannot enter $CG_BACKUP_DIR ($(stat -c '%U %a' "$CG_BACKUP_DIR")) — chown it to the checkout owner (sudo ./selfhost/selfhost.sh backup install-timer does that for a dedicated directory) or run as root"
  fi
}

# bookkeeping files in CG_BACKUP_DIR, read and written through the helper (they
# may have been written by root, the directory belongs to the checkout owner)
state_read() {
  helper -v "$CG_BACKUP_DIR:/backup" -- 'cat "/backup/$1" 2>/dev/null || true' "$1"
}
# $1 = file, $2 = replace | append, the remaining arguments = lines
state_write() {
  local f="$1" how="$2"; shift 2
  helper -v "$CG_BACKUP_DIR:/backup" -- '
f="/backup/$1"; how="$2"; shift 2
if [ "$how" = replace ]; then printf "%s\n" "$@" > "$f.tmp" && mv -f "$f.tmp" "$f"
else printf "%s\n" "$@" >> "$f"; fi' "$f" "$how" "$@" || die "could not write $CG_BACKUP_DIR/$f"
}
# a short key for repository $1 + this backup host (file names)
repo_key() {
  local url; if [ "$1" = local ]; then url=local; else url="$(remote_url)"; fi
  printf '%s %s' "$url" "$CG_BACKUP_HOST" | sha256sum | cut -c1-12
}

# temporary data an interrupted run may have left behind: the throwaway
# verify database and the dump / secrets staging directories
sweep_leftovers() {
  local c
  for c in $(docker ps -aq --filter "name=^cg-backup-verify-$PROJECT-"); do
    docker rm -fv "$c" >/dev/null 2>&1 || true
  done
  if [ -d "$CG_BACKUP_DIR" ]; then
    helper -v "$CG_BACKUP_DIR:/backup" -- 'rm -rf /backup/staging /backup/restore-* /backup/verify-*' \
      || die "could not clean up temporary files in $CG_BACKUP_DIR"
  fi
}

# -------------------------------------------------------------- db helpers --

# psql in the running db container as postgres over the local socket;
# SQL on stdin, unaligned tuples-only output
db_psql() {
  sh_compose exec -T db psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres "$@"
}

# one "schema.table|rows" line per table, sorted — the same query runs at
# backup time (in the dump's snapshot) and after a restore
ROWCOUNT_SQL="SELECT n.nspname || '.' || c.relname || '|' ||
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1;"

# dumps the database into $1/cryptogram.pgc and writes $1/rowcounts.txt and
# the variables DB_VERSION, DB_MIGRATION. The row counts are taken inside the
# transaction whose snapshot pg_dump uses, so they describe exactly the dump.
dump_db() {
  local out="$1" snap
  coproc PSQL { db_psql -d cryptogram; }
  # shellcheck disable=SC2153  # PSQL_PID is set by coproc
  local rfd="${PSQL[0]}" wfd="${PSQL[1]}" psql_pid="$PSQL_PID"
  # reads the coprocess output up to the marker line
  psql_until_marker() {
    local l
    while IFS= read -r -t 3600 l <&"$rfd"; do
      [ "$l" = "__CG_MARKER__" ] && return 0
      printf '%s\n' "$l"
    done
    return 1
  }
  printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" '\echo __CG_MARKER__' >&"$wfd"
  snap="$(psql_until_marker)" || die "could not open a database snapshot"
  [ -n "$snap" ] || die "could not open a database snapshot"

  log "dumping the database (pg_dump -Fc, snapshot $snap)"
  # a lock pg_dump cannot get within 5 minutes fails the backup instead of
  # hanging it
  sh_compose exec -T db pg_dump -U postgres -Fc -Z 0 --lock-wait-timeout=5min \
    --snapshot="$snap" cryptogram > "$out/cryptogram.pgc"

  log "counting rows in the same snapshot"
  printf '%s\n' "$ROWCOUNT_SQL" '\echo __CG_MARKER__' >&"$wfd"
  psql_until_marker > "$out/rowcounts.txt" || die "row counts failed"
  printf '%s\n' "SELECT current_setting('server_version');" \
    "SELECT to_regclass('public.migrations') IS NOT NULL AS has_migrations \\gset" \
    '\if :has_migrations' \
    "SELECT name FROM public.migrations ORDER BY \"timestamp\" DESC, id DESC LIMIT 1;" \
    '\else' "SELECT '-';" '\endif' '\echo __CG_MARKER__' >&"$wfd"
  {
    IFS= read -r DB_VERSION
    IFS= read -r DB_MIGRATION
  } < <(psql_until_marker) || die "could not read the database version"
  printf '%s\n' "COMMIT;" '\q' >&"$wfd"
  exec {wfd}>&-
  wait "$psql_pid" || die "psql session failed"
  [ -s "$out/rowcounts.txt" ] || die "row counts are empty"

  # a dump pg_restore cannot list is useless; catch that now, not at restore time
  sh_compose exec -T db pg_restore --list < "$out/cryptogram.pgc" > /dev/null \
    || die "the dump is not readable by pg_restore"
}

# ------------------------------------------------------- timeline guard --

TAKE_OVER=0
# the lines of $1 that are not lines of $2 (exact match, order kept)
lines_not_in() {
  { grep -vxF -f <(printf '%s\n' "$2" | sed '/^$/d') <<< "$1" || true; } | sed '/^$/d'
}
# Refuses to write into repository $1 when the newest backup of this host
# name there came from another machine: two servers would interleave their
# backups in one timeline and the retention would mix them. --take-over
# accepts it once (this server replaced that one).
# The rule is about identity, not time (two servers' clocks need not agree):
# a snapshot of this host made by another machine that this server has not
# accepted yet is a second writer. The accepted ones are remembered in
# CG_BACKUP_DIR/guard-<key> — written by --take-over, and refreshed after
# every run, so the old server's snapshots stay accepted and any new one it
# makes later is caught.
guard_timeline() {
  local repo="$1" when="${2:-}" foreign known new key
  local q='[.[] | select(((.tags // []) | any(startswith("machine-"))) and ((.tags // []) | index($m) == null)) | .id] | .[]'
  if [ "$when" = early ]; then
    # before anything is written: a refusal costs no local snapshot. An
    # unreachable remote is not fatal here (the local backup still runs);
    # it is checked again before the copy.
    if ! foreign="$(RESTIC_C_TIMEOUT=120 restic_c "$repo" -- snapshots --json --host "$CG_BACKUP_HOST" --tag "$TAG" 2>/dev/null \
        | jq_c -r --arg m "$MACHINE_TAG" "$q")"; then
      log "could not read the off-server repository now — it is checked again before the copy"
      return 0
    fi
  else
    foreign="$(restic_c "$repo" -- snapshots --json --host "$CG_BACKUP_HOST" --tag "$TAG" \
        | jq_c -r --arg m "$MACHINE_TAG" "$q")" \
      || die "could not list the snapshots of the $repo repository"
  fi
  key="guard-$(repo_key "$repo")"
  known="$(state_read "$key")"
  new="$(lines_not_in "$foreign" "$known")"
  if [ -z "$new" ]; then
    return 0
  fi
  if [ "$TAKE_OVER" = 1 ]; then
    log "taking over the backups of $CG_BACKUP_HOST in the $repo repository ($(wc -l <<< "$new") from other servers accepted, --take-over)"
    # shellcheck disable=SC2086
    state_write "$key" replace $foreign
    return 0
  fi
  cat >&2 <<EOF
ERROR: the $repo repository holds $(wc -l <<< "$new") backup(s) of "$CG_BACKUP_HOST" made by
another server, not accepted by this one ($MACHINE_TAG). Writing here would mix
two servers' backups in one timeline.
  - This server replaced that one (restored onto a new server)? Take over once:
      ./selfhost/selfhost.sh backup run --take-over
  - This is a drill or test copy? It must not write there: restore it with
    --drill, or give it its own CG_BACKUP_HOST and CG_BACKUP_REPOSITORY.
EOF
  exit 1
}

# Copies every local snapshot of this host that was never copied — chosen by
# identity, not by time: the ids already copied are remembered in
# CG_BACKUP_DIR/copied-<key>. Each local snapshot is copied once, so one the
# remote retention forgot (the local retention keeps its oldest snapshot while
# a keep bucket is not full) is not copied again on every run, and none is
# skipped because of a clock. Without the record (first run, or a record
# lost), it is seeded from the remote: restic marks every copy with the id of
# its source ("original").
copy_new_snapshots() {
  local key copied local_ids ids
  key="copied-$(repo_key remote)"
  if [ -z "$(state_read "$key")" ]; then
    local seed
    seed="$(restic_c remote -- snapshots --json --host "$CG_BACKUP_HOST" --tag "$TAG" \
        | jq_c -r '.[] | (.original // empty)')" \
      || die "could not list the snapshots of the off-server repository"
    # shellcheck disable=SC2086
    state_write "$key" replace "# local snapshot ids copied to the off-server repository" $seed
  fi
  copied="$(state_read "$key")"
  local_ids="$(restic_c local -- snapshots --json --host "$CG_BACKUP_HOST" --tag "$TAG" | jq_c -r '.[].id')" \
    || die "could not list the snapshots of the local repository"
  ids="$(lines_not_in "$local_ids" "$copied" | tr '\n' ' ')"
  ids="${ids% }"
  if [ -z "$ids" ]; then
    log "the off-server repository is up to date"
    return 0
  fi
  log "copying $(wc -w <<< "$ids") new snapshot(s) to the off-server repository"
  # shellcheck disable=SC2086
  FROM_REPO=local restic_c remote -- copy $ids
  # shellcheck disable=SC2086
  state_write "$key" append $ids
}

# after a successful run: the other servers' snapshots this one has accepted
# stay accepted (also when the retention forgets some of them)
refresh_guard() {
  local repo="$1" key foreign
  key="guard-$(repo_key "$repo")"
  foreign="$(restic_c "$repo" -- snapshots --json --host "$CG_BACKUP_HOST" --tag "$TAG" \
      | jq_c -r --arg m "$MACHINE_TAG" '[.[] | select(((.tags // []) | any(startswith("machine-"))) and ((.tags // []) | index($m) == null)) | .id] | .[]')" \
    || return 0
  if [ -n "$foreign" ]; then
    # shellcheck disable=SC2086
    state_write "$key" replace $foreign
  fi
}

# forgets warm-up snapshots (see cmd_backup_run) left in the local repository
forget_warmups() {
  local ids
  ids="$(restic_c local -- snapshots --json --tag "$WARMUP_TAG" | jq_c -r '.[].id')" \
    || die "could not list the warm-up snapshots"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    restic_c local -- forget $ids >/dev/null
  fi
}

# ------------------------------------------------------------ backup run --

STAGING=""
SEAWEED_PAUSED=0
DB_STARTED=0
backup_cleanup() {
  local rc=$?
  if [ "$SEAWEED_PAUSED" = 1 ]; then
    log "resuming seaweed"
    sh_compose_q unpause seaweed || log "could not resume seaweed — run ./selfhost/selfhost.sh backup resume"
  fi
  if [ "$DB_STARTED" = 1 ]; then
    sh_compose_q stop db >/dev/null 2>&1 || true
  fi
  if [ -n "$STAGING" ]; then
    helper -v "$CG_BACKUP_DIR:/backup" -- 'rm -rf /backup/staging' || true
  fi
  if [ "$rc" != 0 ]; then
    log "backup FAILED (exit $rc)"
    run_hook "${CG_BACKUP_ON_FAILURE:-}" failure "$rc"
  fi
  exit "$rc"
}

cmd_backup_run() {
  CURRENT_COMMAND="backup run"
  while [ $# -gt 0 ]; do
    case "$1" in
      --take-over) TAKE_OVER=1; shift ;;
      *) die "unknown option for backup run: $1" ;;
    esac
  done
  require_env_file
  require_password
  ensure_machine_tag
  take_lock
  trap backup_cleanup EXIT
  HOOK_ON_DIE=0
  local t_start t_freeze t_end rc
  t_start=$(date +%s)
  require_local_repo
  if ! remote_writable; then
    warn_no_remote
  fi
  guard_timeline local
  if remote_writable; then
    guard_timeline remote early
  fi

  local media_vol caddy_vol mail_vol
  media_vol="$(volume_name seaweedfs-data)"
  caddy_vol="$(volume_name caddy-data)"
  mail_vol="$(volume_name mail-data)"
  volume_exists "$media_vol" || die "volume $media_vol does not exist — has the instance ever been started?"
  if service_in_state seaweed paused; then
    log "seaweed is paused (left over from an interrupted backup?) — resuming it first"
    sh_compose_q unpause seaweed >/dev/null
  fi
  forget_warmups

  # staging for the dump, owned by whoever runs this
  STAGING="$CG_BACKUP_DIR/staging"
  helper -v "$CG_BACKUP_DIR:/backup" -- \
    'rm -rf /backup/staging && mkdir -p /backup/staging/db && chown -R "$1:$2" /backup/staging && chmod 700 /backup/staging' \
    "$(id -u)" "$(id -g)"

  if ! service_running db; then
    log "db is not running — starting it for the dump"
    sh_compose_q up -d --wait --no-deps db
    DB_STARTED=1
  fi
  DB_VERSION=""; DB_MIGRATION=""
  dump_db "$STAGING/db"
  local db_sha db_size
  db_sha="$(sha256sum "$STAGING/db/cryptogram.pgc" | cut -d' ' -f1)"
  db_size="$(du -h "$STAGING/db/cryptogram.pgc" | cut -f1)"
  log "dump: $db_size, $(wc -l < "$STAGING/db/rowcounts.txt") tables, sha256 $db_sha"
  if [ "$DB_STARTED" = 1 ]; then
    sh_compose_q stop db >/dev/null
    DB_STARTED=0
  fi

  # what goes into the snapshot
  local -a mounts=(-v "$STAGING/db:/cg/db:ro" -v "$STAGING/MANIFEST:/cg/MANIFEST:ro")
  local -a paths=(/cg/MANIFEST /cg/db)
  local components="db secrets media"
  local p
  for p in "${SECRET_PATHS[@]}"; do
    if [ -e "$p" ]; then
      mounts+=(-v "$DOCKER_DIR/$p:/cg/secrets/$p:ro")
    fi
  done
  paths+=(/cg/secrets)
  mounts+=(-v "$media_vol:/cg/media:ro")
  paths+=(/cg/media)
  if volume_exists "$caddy_vol"; then
    mounts+=(-v "$caddy_vol:/cg/caddy:ro")
    paths+=(/cg/caddy)
    components="$components caddy"
  fi
  local dkim=no
  if volume_exists "$mail_vol"; then
    dkim="$(has_dkim_key "$mail_vol")" || die "could not look into $mail_vol"
  fi
  if [ "$dkim" = yes ]; then
    mounts+=(-v "$mail_vol:/cg/mail:ro")
    paths+=(/cg/mail/dkim_keys)
    components="$components mail"
  fi

  local commit
  commit="$(git -c safe.directory="$(cd .. && pwd)" -C .. rev-parse HEAD 2>/dev/null || echo unknown)"
  cat > "$STAGING/MANIFEST" <<EOF
format=$FORMAT
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
domain=${CG_DOMAIN:-}
host=$CG_BACKUP_HOST
machine=$MACHINE_TAG
git_commit=$commit
postgres_version=$DB_VERSION
last_migration=$DB_MIGRATION
db_sha256=$db_sha
components=$components
EOF

  # SeaweedFS has no online-consistent backup: a copy of a running store can
  # catch its filer leveldb halfway through a change. So the media is read
  # while the container is frozen (docker pause): requests to it (uploads,
  # media views) wait meanwhile, everything else keeps working. The copy is
  # crash-consistent — what a power cut would leave, which SeaweedFS recovers
  # from. (Stopping it gives no better copy: its shutdown hangs and is killed
  # after Docker's 10 s grace period, and it serves again ~17 s after a start.)
  #
  # To keep the freeze short, a warm-up pass first reads everything unfrozen
  # (dump, secrets, caddy-data and all new media go into the repository
  # then). The frozen pass uses it as parent, so it only re-reads files that
  # changed in between — typically the volume file seaweed is appending to
  # (up to SEAWEED_VOLUME_LIMIT_MB) and the filer's leveldb files. The
  # warm-up snapshot is forgotten afterwards; its data is shared.
  log "warm-up pass (unfrozen)"
  # only a cache warmer: files that vanish or cannot be read (restic exit 3)
  # are read again by the frozen pass, which must not miss any
  rc=0
  restic_c local "${mounts[@]}" -- backup --quiet --host "$CG_BACKUP_HOST" --tag "$WARMUP_TAG" "${paths[@]}" || rc=$?
  case "$rc" in
    0) ;;
    3) log "warm-up pass: some files changed or could not be read (restic exit 3) — the frozen pass reads them" ;;
    *) die "the warm-up pass failed (restic exit $rc)" ;;
  esac
  local warm
  warm="$(restic_c local -- snapshots --json --tag "$WARMUP_TAG" | jq_c -r 'sort_by(.time) | last | .id')"
  [ -n "$warm" ] && [ "$warm" != null ] || die "the warm-up snapshot is missing"

  t_freeze=$(date +%s)
  if service_running seaweed; then
    log "freezing seaweed for a consistent copy of the media"
    # marked first: a pause that fails after freezing must still be undone
    SEAWEED_PAUSED=1
    sh_compose_q pause seaweed >/dev/null
  fi
  log "writing the snapshot to the local repository ($components)"
  restic_c local "${mounts[@]}" -- backup --host "$CG_BACKUP_HOST" --tag "$TAG" --tag "$MACHINE_TAG" \
    --parent "$warm" "${paths[@]}" || die "the backup pass failed (restic exit $?; 3 = files could not be read)"
  if [ "$SEAWEED_PAUSED" = 1 ]; then
    sh_compose_q unpause seaweed >/dev/null
    SEAWEED_PAUSED=0
    log "seaweed resumed — media requests waited for $(( $(date +%s) - t_freeze ))s"
  fi
  forget_warmups

  refresh_guard local
  log "applying the retention policy to the local repository"
  restic_c local -- forget --host "$CG_BACKUP_HOST" --tag "$TAG" --group-by host \
    --keep-daily "$CG_BACKUP_KEEP_DAILY" --keep-weekly "$CG_BACKUP_KEEP_WEEKLY" \
    --keep-monthly "$CG_BACKUP_KEEP_MONTHLY" --prune

  if remote_writable; then
    guard_timeline remote
    copy_new_snapshots
    refresh_guard remote
    if [ "$CG_BACKUP_REMOTE_RETENTION" = true ]; then
      log "applying the retention policy to the off-server repository"
      restic_c remote -- forget --host "$CG_BACKUP_HOST" --tag "$TAG" --group-by host \
        --keep-daily "$CG_BACKUP_KEEP_DAILY" --keep-weekly "$CG_BACKUP_KEEP_WEEKLY" \
        --keep-monthly "$CG_BACKUP_KEEP_MONTHLY" --prune
    else
      log "off-server retention is off (CG_BACKUP_REMOTE_RETENTION=false) — it runs elsewhere"
    fi
  else
    warn_no_remote
  fi
  t_end=$(date +%s)
  log "backup finished in $(( t_end - t_start ))s"
  run_hook "${CG_BACKUP_ON_SUCCESS:-}" success 0
}

# resumes a seaweed a killed backup left frozen (also run by the systemd unit
# after every backup, ExecStopPost). It never touches the freeze of a run that
# is still going: while the lock is taken it does nothing.
cmd_backup_resume() {
  require_env_file
  open_lock
  if ! flock -n 9; then
    log "a backup or restore is running — leaving seaweed alone"
    return 0
  fi
  if service_in_state seaweed paused; then
    sh_compose_q unpause seaweed
    log "seaweed resumed"
  fi
}

# ----------------------------------------------------------- backup init --

# sets KEY=value in .env.selfhost (appends it if missing): written to a temp
# file next to it and renamed over it, with the owner and mode of the old
# one; printf is a builtin, so the value never shows up in a process list
env_set() {
  local key="$1" value="$2" tmp line found=0
  tmp="$(mktemp .env.selfhost.XXXXXX)"
  {
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == "$key="* ]]; then
        printf "%s='%s'\n" "$key" "$value"
        found=1
      else
        printf '%s\n' "$line"
      fi
    done < .env.selfhost
    if [ "$found" = 0 ]; then
      printf "%s='%s'\n" "$key" "$value"
    fi
  } > "$tmp"
  chmod --reference=.env.selfhost "$tmp"
  chown --reference=.env.selfhost "$tmp" 2>/dev/null || true
  mv -f "$tmp" .env.selfhost
}

# yes / no: does mail volume $1 hold a DKIM key? A failing look is an error,
# never "no key" (fail closed)
has_dkim_key() {
  local out
  out="$(helper -v "$1:/v:ro" -- 'if [ -n "$(ls -A /v/dkim_keys 2>/dev/null)" ]; then echo yes; else echo no; fi')" \
    || die "could not look into $1"
  printf '%s' "$out"
}

# An .env.selfhost from before backups existed: adds each CG_BACKUP_* setting
# that has no line yet — commented or not, so a setting someone switched off
# or wrote differently is never overridden by a default after it (the file is
# sourced: later lines win). The password is never written here (see init).
add_missing_backup_settings() {
  local -a lines=() added=()
  local entry key
  for entry in "CG_BACKUP_DIR=$CG_BACKUP_DIR" "CG_BACKUP_REPOSITORY=" \
      "CG_BACKUP_AWS_ACCESS_KEY_ID=" "CG_BACKUP_AWS_SECRET_ACCESS_KEY=" \
      "CG_BACKUP_KEEP_DAILY=7" "CG_BACKUP_KEEP_WEEKLY=4" "CG_BACKUP_KEEP_MONTHLY=6" \
      "CG_BACKUP_REMOTE_RETENTION=true" "CG_BACKUP_ON_SUCCESS=" "CG_BACKUP_ON_FAILURE="; do
    key="${entry%%=*}"
    if ! grep -qE "^[[:space:]]*#?[[:space:]]*$key=" .env.selfhost; then
      lines+=("$entry"); added+=("$key")
    fi
  done
  [ ${#lines[@]} -gt 0 ] || return 0
  {
    printf '%s\n' "" \
      "# Backups — SELFHOST.md, \"Backup and restore\" (added by selfhost.sh backup init)." \
      "# CG_BACKUP_REPOSITORY: the off-server copy, any restic repository, e.g." \
      "#   sftp://u123456@u123456.your-storagebox.de:23/cg-backup  or" \
      "#   s3:https://fsn1.your-objectstorage.com/my-bucket/cg-backup (+ the two AWS keys)"
    printf '%s\n' "${lines[@]}"
  } >> .env.selfhost
  log "added ${added[*]} to .env.selfhost — set CG_BACKUP_REPOSITORY there for the off-server copy and run backup init again"
}

cmd_backup_init() {
  CURRENT_COMMAND="backup init"
  require_env_file
  take_lock
  add_missing_backup_settings
  # the password this run uses must be the one in .env.selfhost
  local file_pw
  file_pw="$(sed -n 's/^CG_BACKUP_PASSWORD=//p' .env.selfhost | tail -1)"
  file_pw="${file_pw#[\"\']}"; file_pw="${file_pw%[\"\']}"
  if [ -z "$CG_BACKUP_PASSWORD" ]; then
    CG_BACKUP_PASSWORD="$(openssl rand -hex 32)"
    env_set CG_BACKUP_PASSWORD "$CG_BACKUP_PASSWORD"
    log "generated CG_BACKUP_PASSWORD and wrote it to .env.selfhost"
  elif [ -z "$file_pw" ]; then
    env_set CG_BACKUP_PASSWORD "$CG_BACKUP_PASSWORD"
    log "wrote the CG_BACKUP_PASSWORD given in the environment to .env.selfhost"
  elif [ "$file_pw" != "$CG_BACKUP_PASSWORD" ]; then
    log "WARNING: CG_BACKUP_PASSWORD in the environment differs from the one in .env.selfhost — the file is left unchanged; scheduled runs use the file's"
  fi
  cat <<'EOF'

Every backup — the off-server copy included — is encrypted with
CG_BACKUP_PASSWORD from .env.selfhost. Store a copy of it NOW somewhere that is
not this server (password manager, a printout in a safe place); if the server
is lost, nothing can be restored without it. To display it:

    grep '^CG_BACKUP_PASSWORD=' .env.selfhost

EOF

  log "local repository: $CG_BACKUP_DIR/repo"
  if ! remote_writable; then
    init_repo local
    warn_no_remote
    return 0
  fi
  if [[ "$CG_BACKUP_REPOSITORY" == sftp:* ]]; then
    ensure_ssh_access
    if [ "$SSH_NEW_KEY" = 1 ]; then
      return 0
    fi
  fi
  log "off-server repository: $(redact_url "$CG_BACKUP_REPOSITORY")"
  # Both repositories need the same chunker parameters, or every copy stores
  # the data a second time. Whichever exists passes them on: the local one to
  # a new remote, or — on a server restored from the remote — the remote one
  # to the new local repository.
  if repo_initialized local; then
    log "local repository: already initialized"
    FROM_REPO=local init_repo remote --copy-chunker-params
  else
    init_repo remote
    FROM_REPO=remote init_repo local --copy-chunker-params
  fi
  log "done — take a first backup with ./selfhost/selfhost.sh backup run"
}

# host and port of an sftp: repository (sftp:user@host:path or
# sftp://user@host:port//path)
sftp_host_port() {
  local r="${CG_BACKUP_REPOSITORY#sftp:}" hostpart port=22
  r="${r#//}"
  hostpart="${r%%[:/]*}"
  hostpart="${hostpart#*@}"
  if [[ "$CG_BACKUP_REPOSITORY" == sftp://* ]]; then
    local rest="${r#*@}"
    rest="${rest#"$hostpart"}"
    if [[ "$rest" =~ ^:([0-9]+) ]]; then port="${BASH_REMATCH[1]}"; fi
  fi
  printf '%s %s\n' "$hostpart" "$port"
}

# The SSH key and the pinned host key live in docker/backup/ssh/ (part of the
# secrets bundle). The OpenSSH tools of the restic image are used, so the host
# needs none. Sets SSH_NEW_KEY=1 when it just generated the key: it has to be
# authorized at the storage provider before the repository can be reached.
SSH_NEW_KEY=0
ensure_ssh_access() {
  mkdir -p "$CG_BACKUP_SSH_DIR" || die "cannot create $CG_BACKUP_SSH_DIR"
  chmod 700 "$DOCKER_DIR/backup" "$CG_BACKUP_SSH_DIR" || die "cannot restrict $CG_BACKUP_SSH_DIR"
  local host port
  read -r host port < <(sftp_host_port) || die "cannot parse the sftp repository URL"
  [ -n "$host" ] || die "no host in CG_BACKUP_REPOSITORY"
  [ -f "$CG_BACKUP_SSH_DIR/id_ed25519" ] || SSH_NEW_KEY=1
  docker run --rm -v "$CG_BACKUP_SSH_DIR:/ssh" --entrypoint /bin/sh "$RESTIC_IMAGE" -c '
set -eu
umask 077
if [ ! -f /ssh/id_ed25519 ]; then
  echo "Generating the SSH key for the sftp repository (docker/backup/ssh/id_ed25519)"
  ssh-keygen -q -t ed25519 -N "" -C "cg-backup@$3" -f /ssh/id_ed25519
fi
# a key copied over without its public half (restore onto a new server)
if [ ! -s /ssh/id_ed25519.pub ]; then
  ssh-keygen -y -f /ssh/id_ed25519 > /ssh/id_ed25519.pub
fi
if [ ! -s /ssh/known_hosts ]; then
  ssh-keyscan -p "$2" -t ed25519,rsa "$1" 2>/dev/null > /ssh/known_hosts || true
  if [ ! -s /ssh/known_hosts ]; then
    rm -f /ssh/known_hosts
    echo "ERROR: no host key from $1 port $2" >&2
    exit 1
  fi
  echo "Host key fingerprints of $1 — compare them with what your provider publishes"
  echo "(wrong ones: delete docker/backup/ssh/known_hosts and stop):"
  ssh-keygen -l -f /ssh/known_hosts
fi
echo
echo "Public key of this server for the sftp repository — authorize it there"
echo "(e.g. append it to .ssh/authorized_keys of the storage account):"
cat /ssh/id_ed25519.pub
chown "$4:$5" /ssh/id_ed25519 /ssh/id_ed25519.pub /ssh/known_hosts
echo' ssh-setup "$host" "$port" "${CG_DOMAIN:-selfhost}" "$(id -u)" "$(id -g)" \
    || die "the SSH setup for the sftp repository failed"
  if [ "$SSH_NEW_KEY" = 1 ]; then
    echo "Authorize this key for the repository account, then run"
    echo "./selfhost/selfhost.sh backup init again to create the repository."
  fi
}

# ---------------------------------------------------- backup list / check --

cmd_backup_list() {
  local from=local
  if [ "${1:-}" = "--remote" ]; then from=remote; fi
  ensure_backup_dir
  require_password
  if [ "$from" = remote ]; then
    remote_configured || die "CG_BACKUP_REPOSITORY is not set"
  fi
  restic_c "$from" -- snapshots --tag "$TAG"
}

cmd_backup_check() {
  CURRENT_COMMAND="backup check"
  require_env_file
  require_password
  take_lock
  trap 'rc=$?; if [ $rc != 0 ]; then log "check FAILED (exit $rc)"; run_hook "${CG_BACKUP_ON_FAILURE:-}" failure $rc; fi; exit $rc' EXIT
  HOOK_ON_DIE=0
  local subset="$CG_BACKUP_CHECK_SUBSET"
  if [ "${1:-}" = "--read-data" ]; then subset="100%"; fi
  log "checking the local repository (reading $subset of the data)"
  restic_c local -- check --read-data-subset "$subset"
  # `check` locks the repository exclusively — never on a drill's source
  if remote_writable; then
    log "checking the off-server repository (reading $subset of the data)"
    restic_c remote -- check --read-data-subset "$subset"
  else
    warn_no_remote
  fi
  log "check passed"
}

# ------------------------------------------------------ snapshot helpers --

# resolves $2 (an id or "latest") in repository $1 to a full snapshot id;
# sets SNAP_ID, SNAP_TIME, SNAP_HOST
resolve_snapshot() {
  local repo="$1" want="$2" json
  local -a filter=(--tag "$TAG")
  if [ -n "${RESTORE_HOST:-}" ]; then filter+=(--host "$RESTORE_HOST"); fi
  if [ "$want" = latest ]; then
    json="$(restic_c "$repo" -- snapshots --json "${filter[@]}" --latest 1 --group-by '')"
  else
    # an explicit id: filters would only make restic print "Ignoring filters"
    json="$(restic_c "$repo" -- snapshots --json "$want")"
  fi
  local fields
  fields="$(printf '%s' "$json" | jq_c -r \
    'sort_by(.time) | last | select(. != null) | "\(.id) \(.time) \(.hostname)"')"
  [ -n "$fields" ] || die "no snapshot '$want' (tag $TAG${RESTORE_HOST:+, host $RESTORE_HOST}) in the $repo repository"
  read -r SNAP_ID SNAP_TIME SNAP_HOST <<< "$fields"
}

# prints the value of key $2 from MANIFEST text $1
manifest_get() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1
}

# restores the snapshot path $2 of repository $1 into the directory
# /backup/$3 (CG_BACKUP_DIR/$3). $4 = give: the files are handed to the
# caller (the dump, read on the host); keep: they keep the owner and mode they
# were backed up with (the secrets — seaweed reads s3.selfhost.json as uid 1000)
restore_to_dir() {
  local repo="$1" path="$2" sub="$3" mode="${4:-give}"
  helper -v "$CG_BACKUP_DIR:/backup" -- 'rm -rf "/backup/$1" && mkdir -p "/backup/$1"' "$sub"
  restic_c "$repo" -- restore "$SNAP_ID:$path" --target "/backup/$sub" --verify >/dev/null
  if [ "$mode" = give ]; then
    helper -v "$CG_BACKUP_DIR:/backup" -- 'chown -R "$2:$3" "/backup/$1" && chmod 700 "/backup/$1"' "$sub" "$(id -u)" "$(id -g)"
  else
    helper -v "$CG_BACKUP_DIR:/backup" -- 'chmod 700 "/backup/$1"' "$sub"
  fi
}

# --------------------------------------------------------------- restore --

RESTORE_FORCE=0
RESTORE_DRY=0
RESTORE_FROM=""
RESTORE_ONLY=""
RESTORE_HOST=""
RESTORE_DB_FILE=""
RESTORE_WITH_SECRETS=0
RESTORE_UNDO=""
RESTORE_DISCARD=""
RESTORE_IGNORE_SPACE=0
RESTORE_TMP=""
RESTORE_ARGS=""
APPLY_STARTED=0
STACK_STOPPED=0
CURRENT_STEP=""
# what this restore replaced, one line per step (read by restore --undo)
UNDO_FILE=""

restore_usage() {
  cat <<'EOF'
Usage: ./selfhost/selfhost.sh restore [options] <snapshot-id | latest>
       ./selfhost/selfhost.sh restore --db-file <dump.pgc> [--force] [--drill] [--dry-run]
       ./selfhost/selfhost.sh restore --undo <stamp> [--force]
       ./selfhost/selfhost.sh restore --discard-undo <stamp> [--force]

  --from local|remote  repository to restore from (default: the local one if it
                       is initialized, otherwise the off-server one)
  --only LIST          comma-separated components: secrets,db,media,caddy,mail
                       (default: all that the snapshot contains)
  --host NAME          with "latest": the newest snapshot of this backup host
  --force              replace a non-empty database or media store (and a
                       non-empty caddy-data / DKIM key, otherwise kept). The
                       previous state is kept until the restore succeeded.
  --with-secrets       also replace secrets that differ (needs --force; implied
                       by --only secrets). Without it they are kept.
  --drill              this server is a drill/test copy: never write to the
                       source repository, mail off, its own backup host name,
                       fresh VAPID keys, push subscriptions removed, no DKIM
                       key, no timer
  --dry-run            print what would happen, change nothing
  --db-file FILE       restore a plain pg_dump -Fc file (e.g. from another
                       server) into the database instead of a snapshot
  --undo STAMP         go back to the state before the restore STAMP (printed
                       by a restore that failed); --force: also when services
                       have run since
  --discard-undo STAMP keep the current state and remove the pre-restore copies
                       of restore STAMP (--force for one that did not finish)
  --ignore-space-check restore even when the free-space check says no

Run it with the stack stopped or running — it stops every service itself and
leaves only db running. Start the instance afterwards with
./selfhost/selfhost.sh up (migrate-db applies newer migrations).
EOF
  exit "${1:-1}"
}

undo_record() { printf '%s\n' "$*" >> "$UNDO_FILE"; }

# what the undo record says, in words
describe_undo() {
  local kind a b c
  while read -r kind a b c; do
    case "$kind $a" in
      "secret new") echo "  - secret $b: restored (it did not exist before)" ;;
      "secret replace") echo "  - secret $b: replaced (previous: $b.pre-restore-$STAMP)" ;;
      "db restore") echo "  - database: restored into an empty database" ;;
      "db replace") echo "  - database: replaced or partly replaced (previous: database cryptogram_pre_restore_$STAMP)" ;;
      "volume restore") echo "  - $b: restored into the empty volume $c" ;;
      "volume moving")
        if grep -q "^volume moved $b " "$UNDO_FILE"; then
          echo "  - $b: replaced or partly replaced (previous contents: .pre-restore-$STAMP/ in volume $c)"
        else
          echo "  - $b: previous contents partly moved into .pre-restore-$STAMP/ in volume $c (nothing restored yet)"
        fi ;;
      "mail restore") echo "  - DKIM key: restored" ;;
      "mail replace") echo "  - DKIM key: replaced (previous: dkim_keys.pre-restore-$STAMP in $b)" ;;
      "valkey removed") echo "  - Valkey state removed (sessions; not undoable, not needed)" ;;
      "push cleared") echo "  - web-push subscriptions removed from the database (not undoable, not needed)" ;;
      "roles set") echo "  - database role passwords set from .env.selfhost" ;;
    esac
  done < "$UNDO_FILE"
}

restore_cleanup() {
  local rc=$?
  if [ -n "$RESTORE_TMP" ]; then
    helper -v "$CG_BACKUP_DIR:/backup" -- 'rm -rf "/backup/$1"' "$RESTORE_TMP" || true
  fi
  if [ "$rc" != 0 ]; then
    echo >&2
    if [ -n "$RESTORE_UNDO" ]; then
      log "undo FAILED (exit $rc) — the record $UNDO_FILE is kept; every step can be repeated: fix the cause and run the same --undo again" >&2
    elif [ -n "$RESTORE_DISCARD" ]; then
      log "discard FAILED (exit $rc) — fix the cause and run the same --discard-undo again" >&2
    elif [ "$RESTORE_COMMITTED" = 1 ]; then
      {
        log "the restore SUCCEEDED; removing its pre-restore copies was interrupted (exit $rc)"
        echo "Remove them with: ./selfhost/selfhost.sh restore --discard-undo $STAMP"
      } >&2
    elif [ "$APPLY_STARTED" = 0 ]; then
      log "restore FAILED (exit $rc) — nothing was changed"
    else
      {
        log "restore FAILED (exit $rc) while: ${CURRENT_STEP:-?}"
        if [ -s "$UNDO_FILE" ]; then
          echo "Already done by this restore ($STAMP):"
          describe_undo
        else
          echo "Nothing was replaced yet."
        fi
        if [ "$STACK_STOPPED" = 1 ]; then
          echo "The stack is stopped (db may be running)."
        fi
        echo
        echo "Go back to the state before this restore, then start the instance:"
        echo "    ./selfhost/selfhost.sh restore --undo $STAMP && ./selfhost/selfhost.sh up"
        echo "Or fix the cause and try again (after the undo, so it starts from the same state):"
        echo "    ./selfhost/selfhost.sh restore --undo $STAMP && ./selfhost/selfhost.sh restore $RESTORE_ARGS"
      } >&2
    fi
  fi
  exit "$rc"
}

cmd_restore() {
  CURRENT_COMMAND="restore"
  RESTORE_ARGS="$*"
  local snapshot=""
  # an option that takes a value must get one (not the next option)
  need_value() {
    if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
      echo "Option $1 needs a value."
      restore_usage
    fi
  }
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) need_value "$@"; RESTORE_FROM="$2"; shift 2 ;;
      --only) need_value "$@"; RESTORE_ONLY="$2"; shift 2 ;;
      --host) need_value "$@"; RESTORE_HOST="$2"; shift 2 ;;
      --force) RESTORE_FORCE=1; shift ;;
      --with-secrets) RESTORE_WITH_SECRETS=1; shift ;;
      --drill) RESTORE_DRILL=1; shift ;;
      --dry-run) RESTORE_DRY=1; shift ;;
      --ignore-space-check) RESTORE_IGNORE_SPACE=1; shift ;;
      --db-file) need_value "$@"; RESTORE_DB_FILE="$2"; shift 2 ;;
      --undo) need_value "$@"; RESTORE_UNDO="$2"; shift 2 ;;
      --discard-undo) need_value "$@"; RESTORE_DISCARD="$2"; shift 2 ;;
      -h|--help) restore_usage 0 ;;
      -*) echo "Unknown option: $1"; restore_usage ;;
      *) [ -z "$snapshot" ] || restore_usage; snapshot="$1"; shift ;;
    esac
  done
  take_lock
  trap restore_cleanup EXIT

  if [ -n "$RESTORE_UNDO" ]; then
    [ -z "$snapshot" ] || restore_usage
    cmd_undo "$RESTORE_UNDO"
    return
  fi
  if [ -n "$RESTORE_DISCARD" ]; then
    [ -z "$snapshot" ] || restore_usage
    cmd_discard "$RESTORE_DISCARD"
    return
  fi
  check_no_unfinished
  UNDO_FILE="$DOCKER_DIR/restore-undo.pre-restore-$STAMP"
  if [ -n "$RESTORE_DB_FILE" ]; then
    [ -z "$snapshot" ] || restore_usage
    restore_db_file_cmd
    return
  fi
  [ -n "$snapshot" ] || restore_usage

  # which components
  local comps="$ALL_COMPONENTS" c
  if [ -n "$RESTORE_ONLY" ]; then
    comps="${RESTORE_ONLY//,/ }"
    for c in $comps; do
      [[ " $ALL_COMPONENTS " == *" $c "* ]] || die "unknown component '$c' (secrets, db, media, caddy, mail)"
    done
    # naming the secrets explicitly is asking for them
    if [[ " $comps " == *" secrets "* ]]; then RESTORE_WITH_SECRETS=1; fi
  fi
  if drill_mode && [[ " $comps " == *" mail "* ]]; then
    [ -z "$RESTORE_ONLY" ] || die "a drill never restores the DKIM key (mail): it could sign mail as the real instance"
    comps="${comps/mail/}"
  fi
  if [ ! -f .env.selfhost ] && [[ " $comps " != *" secrets "* ]]; then
    die "no .env.selfhost — restore the secrets too (--only secrets,…) or run ./selfhost/init.sh first"
  fi

  # repository
  if [ -z "$RESTORE_FROM" ]; then
    if [ -n "$CG_BACKUP_PASSWORD" ] && repo_initialized local; then
      RESTORE_FROM=local
    else
      RESTORE_FROM=remote
    fi
  fi
  case "$RESTORE_FROM" in
    local) ;;
    remote)
      if ! remote_configured; then
        if [ -t 0 ]; then
          read -rp "Off-server repository (CG_BACKUP_REPOSITORY): " CG_BACKUP_REPOSITORY
        fi
        remote_configured || die "CG_BACKUP_REPOSITORY is not set"
      fi
      ;;
    *) die "--from must be local or remote" ;;
  esac
  require_password
  # the repository this run reads from, kept when the restored .env.selfhost
  # is loaded (it may name another one, or none on a drill)
  local source_repo; source_repo="$(remote_url)"

  resolve_snapshot "$RESTORE_FROM" "$snapshot"
  local manifest
  manifest="$(restic_c "$RESTORE_FROM" -- dump "$SNAP_ID" /cg/MANIFEST)" \
    || die "snapshot $SNAP_ID has no /cg/MANIFEST — not a backup made by selfhost.sh"
  [ "$(manifest_get "$manifest" format)" = "$FORMAT" ] || die "snapshot $SNAP_ID has an unknown format: $(manifest_get "$manifest" format)"
  local available
  available=" $(manifest_get "$manifest" components) "

  echo
  echo "Snapshot ${SNAP_ID:0:8} from the $RESTORE_FROM repository"
  echo "  taken          $SNAP_TIME (backup host $SNAP_HOST, $(manifest_get "$manifest" machine))"
  echo "  domain         $(manifest_get "$manifest" domain)"
  echo "  code version   $(manifest_get "$manifest" git_commit)"
  echo "  postgres       $(manifest_get "$manifest" postgres_version), newest migration $(manifest_get "$manifest" last_migration)"
  echo "  contains       $(manifest_get "$manifest" components)"
  if [ -n "${CG_DOMAIN:-}" ] && [ "$(manifest_get "$manifest" domain)" != "$CG_DOMAIN" ]; then
    echo "  NOTE: this instance is $CG_DOMAIN, the backup comes from $(manifest_get "$manifest" domain)."
  fi
  if drill_mode; then
    echo "  DRILL: nothing is written to the source repository; mail stays off;"
    echo "         fresh VAPID keys instead of the backup's, push subscriptions removed"
  fi
  warn_newer_migration "$(manifest_get "$manifest" last_migration)"
  echo
  echo "This restore: $STAMP"

  local -a todo=()
  for c in $ALL_COMPONENTS; do
    [[ " $comps " == *" $c "* ]] || continue
    if [[ "$available" != *" $c "* ]]; then
      if [ -n "$RESTORE_ONLY" ]; then die "the snapshot has no '$c' component"; fi
      continue
    fi
    todo+=("$c")
  done
  [ ${#todo[@]} -gt 0 ] || die "nothing to restore"
  RESTORE_TMP="restore-$STAMP"

  # ---- plan: every check that can refuse runs before anything is changed
  declare -gA ACTION=()
  local rest=()
  for c in "${todo[@]}"; do [ "$c" = secrets ] || rest+=("$c"); done
  if [[ " ${todo[*]} " == *" secrets "* ]]; then
    plan_secrets
  fi
  for c in "${rest[@]}"; do
    case "$c" in
      db) plan_db ;;
      media) plan_volume media seaweedfs-data 1 ;;
      caddy) plan_volume caddy caddy-data 0 ;;
      mail) plan_mail ;;
    esac
  done
  check_space "${rest[@]}"
  if [[ " ${rest[*]} " == *" db "* ]] && [ "${ACTION[db]}" != refuse ] && [ "${ACTION[space]:-}" != refuse ] \
      && [ "$RESTORE_DRY" = 0 ]; then
    fetch_dump "$manifest"
  fi
  local refused=""
  for c in "${todo[@]}" space; do
    if [ "${ACTION[$c]:-}" = refuse ]; then refused="$refused $c"; fi
  done
  if [ "$RESTORE_DRY" = 1 ]; then
    echo
    echo "Dry run — nothing was changed."
    return
  fi
  [ -z "$refused" ] || die "refusing:$refused (see above)"

  # ---- apply
  APPLY_STARTED=1
  : > "$UNDO_FILE"
  # A drill restore of the secrets alone (e.g. turning a running copy into a
  # drill) changes the VAPID key pair and the mail settings under running
  # services: the api holds the key pair in memory, every container its
  # environment. They are stopped first; `up` starts them with the new ones
  # (and recreates those whose settings changed). With other components the
  # stack is stopped below anyway.
  if drill_mode && [ ${#rest[@]} -eq 0 ] && [ -f .env.selfhost ] \
      && [ -n "$(sh_compose ps -q --status running)" ]; then
    CURRENT_STEP="stopping the stack"
    log "drill: stopping every service, so none keeps running with the previous key pair or mail settings"
    STACK_STOPPED=1
    sh_compose_q stop >/dev/null
  fi
  if [[ " ${todo[*]} " == *" secrets "* ]]; then
    CURRENT_STEP="restoring the secrets"
    apply_secrets
    if [ -f .env.selfhost ]; then
      if drill_mode; then apply_drill_env "$source_repo"; fi
      # pick up the restored settings, but keep where this run reads from
      local keep_dir="$CG_BACKUP_DIR" keep_pw="$CG_BACKUP_PASSWORD"
      load_settings
      CG_BACKUP_DIR="$keep_dir"; CG_BACKUP_PASSWORD="$keep_pw"
      if drill_mode; then CG_BACKUP_DRILL_SOURCE="$source_repo"; else CG_BACKUP_REPOSITORY="$source_repo"; fi
      # passwords follow a restored .env.selfhost even when the database
      # itself is not restored in this run
      if [ "${SECRETS_ENV_CHANGED:-0}" = 1 ] && [[ " ${rest[*]} " != *" db "* ]] \
          && volume_exists "$(volume_name pgdata)"; then
        CURRENT_STEP="setting the database role passwords from the restored .env.selfhost"
        log "db: setting the role passwords from the restored .env.selfhost"
        start_db
        ensure_roles
        undo_record roles set
      fi
    fi
  fi
  if [ "$RESTORE_DRILL" = 1 ] && [[ " ${todo[*]} " != *" secrets "* ]] && [ -f .env.selfhost ]; then
    CURRENT_STEP="switching this instance to drill mode"
    apply_drill_env "$source_repo"
    load_settings
  fi
  # a new key pair without a database restore: the subscriptions in the
  # existing database belong to the previous one (a database restore in this
  # run removes them itself)
  if drill_mode && [ "$VAPID_REPLACED" = 1 ] && [[ " ${rest[*]} " != *" db "* ]]; then
    CURRENT_STEP="removing the web-push subscriptions"
    drill_clear_existing_db
  fi
  if [ ${#rest[@]} -eq 0 ]; then
    finalize_restore
    log "done"
    if [ "$STACK_STOPPED" = 1 ]; then
      log "the stack is stopped (db may be running). Start it with: ./selfhost/selfhost.sh up"
      drill_note "services: stopped before the change; ./selfhost/selfhost.sh up starts them with the new key pair and settings"
    fi
    drill_summary
    return
  fi
  [ -f .env.selfhost ] || die "no .env.selfhost"

  CURRENT_STEP="stopping the stack"
  log "stopping every service"
  STACK_STOPPED=1
  sh_compose_q stop >/dev/null
  for c in "${rest[@]}"; do
    [ "${ACTION[$c]}" != keep ] || continue
    case "$c" in
      db) CURRENT_STEP="restoring the database"
          apply_db "$CG_BACKUP_DIR/$RESTORE_TMP/db/cryptogram.pgc" "$CG_BACKUP_DIR/$RESTORE_TMP/db/rowcounts.txt" ;;
      media) CURRENT_STEP="restoring the media"; apply_volume media seaweedfs-data /cg/media ;;
      caddy) CURRENT_STEP="restoring caddy-data"; apply_volume caddy caddy-data /cg/caddy ;;
      mail) CURRENT_STEP="restoring the DKIM key"; apply_mail ;;
    esac
  done
  CURRENT_STEP="removing the pre-restore copies"
  finalize_restore
  echo
  log "restore finished. Start the instance with: ./selfhost/selfhost.sh up"
  log "(migrate-db applies the migrations of this checkout that the backup lacks)"
  drill_summary
}

# warns when the backup's newest migration is not in this checkout (the code
# is older than the database it is about to run on)
warn_newer_migration() {
  local name="$1" ts
  [ -d ../srv/migrations ] || return 0
  ts="$(sed -n 's/.*[^0-9]\([0-9]\{13\}\)$/\1/p' <<< "$name")"
  [ -n "$ts" ] || return 0
  if ! compgen -G "../srv/migrations/$ts-*" >/dev/null; then
    echo "  WARNING: the backup's newest migration ($name) is not in this checkout —"
    echo "           the code is older than the backup. Update the checkout (git pull)"
    echo "           before starting the instance."
  fi
}

# Drill: the restored .env.selfhost is production's. Point it away from
# everything that reaches the real world or the real backups.
apply_drill_env() {
  local source="$1"
  log "drill: switching off mail, Caddy to its local CA, the source repository read-only for this server"
  env_set CG_BACKUP_DRILL true
  env_set CG_BACKUP_DRILL_SOURCE "$source"
  env_set CG_BACKUP_REPOSITORY ""
  env_set CG_BACKUP_HOST "drill-$(hostname -s 2>/dev/null || hostname)"
  env_set CG_ENABLE_MAIL false
  env_set SMTP_HOST ""
  # certificates from Caddy's local CA, never from production's ACME account
  env_set CG_TLS_MODE internal
  CG_BACKUP_DRILL=true
  drill_note ".env.selfhost rewritten: CG_BACKUP_DRILL=true, CG_BACKUP_DRILL_SOURCE, CG_BACKUP_REPOSITORY='', CG_BACKUP_HOST, CG_ENABLE_MAIL=false, SMTP_HOST='', CG_TLS_MODE=internal"
}

# prints what this restore changed because it is a drill, and the drill
# settings now in effect (read from .env.selfhost, never a secret)
drill_summary() {
  drill_mode || return 0
  echo
  log "DRILL INSTANCE — what keeps it away from the source's users and backups:"
  local n
  for n in "${DRILL_NOTES[@]}"; do
    echo "  - $n"
  done
  if [ "$CG_BACKUP_DRILL" != true ]; then
    echo "  - WARNING: .env.selfhost does not mark this instance as a drill (CG_BACKUP_DRILL=true is"
    echo "    missing), so selfhost.sh does not keep mail off — run the restore again with --drill"
  elif [ "${CG_ENABLE_MAIL:-false}" != true ] && [ -z "${SMTP_HOST:-}" ]; then
    echo "  - mail: off (CG_ENABLE_MAIL=false, SMTP_HOST empty; selfhost.sh keeps it off on a drill) —"
    echo "    no relay, no outgoing mail, no bounce receiver"
  else
    echo "  - mail: off — selfhost.sh ignores the mail settings .env.selfhost switches on (CG_ENABLE_MAIL /"
    echo "    SMTP_HOST) on a drill instance; set CG_ENABLE_MAIL=false and SMTP_HOST= there"
  fi
  echo "  - TLS: CG_TLS_MODE=${CG_TLS_MODE:-acme} (internal: Caddy's local CA, not the source's ACME account)"
  echo "  - backups: local only (host $CG_BACKUP_HOST); the source repository is only read; install-timer is refused"
  echo "  - DKIM key: never restored"
}

plan_secrets() {
  log "secrets: reading the bundle"
  restore_to_dir "$RESTORE_FROM" /cg/secrets "$RESTORE_TMP/secrets" keep
  SECRETS_PLAN="$(secrets_script plan)"
  echo "secrets:"
  printf '%s\n' "$SECRETS_PLAN"
  if grep -q '^  DIFFERS ' <<< "$SECRETS_PLAN"; then
    ACTION[secrets]=refuse
    echo "         Files marked DIFFERS would replace this instance's credentials, which"
    echo "         needs --force (the current files are then kept as *.pre-restore-$STAMP)."
  elif grep -q '^  kept ' <<< "$SECRETS_PLAN"; then
    echo "         Differing secrets are kept: the database role passwords are set from the"
    echo "         current .env.selfhost; --with-secrets --force replaces them."
  fi
}

# compares (plan) or copies (apply) every bundle path into docker/.
# .env.selfhost and backup/ belong to the owner of the checkout, everything
# else keeps the owner and mode it had when it was backed up (seaweed reads
# s3.selfhost.json as uid 1000) — also when the restore runs as root. A path
# that differs is kept unless secrets were asked for (--with-secrets / --only
# secrets); then it needs --force. An existing backup/ (the SSH access that
# just reached the repository) is always kept.
# On a drill, vapid_keys.json is never the backup's: the stored push
# subscriptions belong to that key pair, and with it a drill could send push
# notifications to the source's users. A missing one is generated fresh, one
# identical to the backup's (from an earlier copy) is replaced by a fresh one,
# the drill's own is kept.
secrets_script() {
  local script='
set -eu
mode=$1 with=$2 force=$3 stamp=$4 uid=$5 gid=$6 drill=$7
shift 7
# writes a fresh web-push (VAPID) key pair to $1 in the format of
# `web-push generate-vapid-keys --json` (what selfhost.sh build runs): the
# uncompressed P-256 public key (65 bytes) and the private scalar (32 bytes),
# base64url without padding. ssh-keygen -m PEM writes the SEC1 DER key, whose
# layout for P-256 is fixed: 121 bytes, starting 30 77 02 01 01 04 20, then
# the scalar, the curve, and the public point as the last 65 bytes.
vapid_generate() {
  t="$(mktemp -d)"
  ssh-keygen -q -t ecdsa -b 256 -m PEM -N "" -C "" -f "$t/k" >/dev/null
  sed "1d;\$d" "$t/k" | base64 -d > "$t/der"
  if [ "$(wc -c < "$t/der")" -ne 121 ] \
      || [ "$(head -c 7 "$t/der" | od -An -tx1 | tr -d " \n")" != 30770201010420 ] \
      || [ "$(tail -c 65 "$t/der" | head -c 1 | od -An -tx1 | tr -d " \n")" != 04 ]; then
    rm -rf "$t"
    echo "vapid_keys.json: unexpected key format from ssh-keygen" >&2
    exit 1
  fi
  pub="$(tail -c 65 "$t/der" | base64 | tr -d "\n=" | tr "+/" "-_")"
  priv="$(head -c 39 "$t/der" | tail -c 32 | base64 | tr -d "\n=" | tr "+/" "-_")"
  rm -rf "$t"
  (umask 077; printf "{\"publicKey\":\"%s\",\"privateKey\":\"%s\"}\n" "$pub" "$priv" > "$1.new")
  chown "$uid:$gid" "$1.new"
  mv "$1.new" "$1"
}
for p in "$@"; do
  src="/src/$p" dst="/dst/$p"
  [ -e "$src" ] || continue
  if [ "$drill" = 1 ] && [ "$p" = vapid_keys.json ]; then
    if [ ! -e "$dst" ]; then state=generate
    elif diff -r "$src" "$dst" >/dev/null 2>&1; then state=renew
    else state=own
    fi
  elif [ ! -e "$dst" ]; then state=new
  elif diff -r "$src" "$dst" >/dev/null 2>&1; then state=same
  elif [ "$p" = backup ]; then state=inuse
  elif [ "$with" != 1 ]; then state=keep
  elif [ "$force" = 1 ]; then state=replace
  else state=differs
  fi
  if [ "$mode" = plan ]; then
    case $state in
      same) echo "  unchanged  $p" ;;
      new) echo "  restore    $p" ;;
      keep) echo "  kept       $p (differs from the backup)" ;;
      inuse) echo "  in use     $p (the SSH access in place is kept, never replaced)" ;;
      replace) echo "  replace    $p (the current one is kept as $p.pre-restore-$stamp)" ;;
      differs) echo "  DIFFERS    $p" ;;
      generate) echo "  generate   $p (drill: a fresh key pair, not the backup'"'"'s)" ;;
      renew) echo "  renew      $p (drill: it is the backup'"'"'s — replaced by a fresh key pair, the current one kept as $p.pre-restore-$stamp)" ;;
      own) echo "  own        $p (drill: this instance'"'"'s own key pair is kept, never the backup'"'"'s)" ;;
    esac
    continue
  fi
  case $state in
    new)
      d="$(dirname "$dst")"
      if [ ! -d "$d" ]; then mkdir -p "$d"; chown "$uid:$gid" "$d"; chmod 755 "$d"; fi
      cp -a "$src" "$dst"; echo "  restored   $p" ;;
    replace) mv "$dst" "$dst.pre-restore-$stamp"; cp -a "$src" "$dst"
      echo "  replaced   $p (the previous version is $p.pre-restore-$stamp)" ;;
    generate) vapid_generate "$dst"; echo "  generated  $p (a fresh key pair)" ;;
    renew) mv "$dst" "$dst.pre-restore-$stamp"; vapid_generate "$dst"
      echo "  generated  $p (a fresh key pair; the previous one is $p.pre-restore-$stamp)" ;;
    *) continue ;;
  esac
  case $p in
    .env.selfhost) chown "$uid:$gid" "$dst"; chmod 600 "$dst" ;;
    backup) chown -R "$uid:$gid" "$dst" ;;
  esac
done'
  local drill=0
  if drill_mode; then drill=1; fi
  helper -v "$CG_BACKUP_DIR/$RESTORE_TMP/secrets:/src:ro" -v "$DOCKER_DIR:/dst" -- "$script" \
    "$1" "$RESTORE_WITH_SECRETS" "$RESTORE_FORCE" "$STAMP" "$CHECKOUT_UID" "$CHECKOUT_GID" "$drill" "${SECRET_PATHS[@]}"
}

SECRETS_ENV_CHANGED=0
# 1: a drill restore generated or renewed vapid_keys.json
VAPID_REPLACED=0
apply_secrets() {
  local state p
  # record first, so a failure halfway is still undone completely
  while read -r state p _; do
    case "$state" in
      restore|generate) undo_record secret new "$p" ;;
      replace|renew) undo_record secret replace "$p" ;;
    esac
    if [ "$p" = .env.selfhost ] && { [ "$state" = restore ] || [ "$state" = replace ]; }; then
      SECRETS_ENV_CHANGED=1
    fi
    if [ "$p" = vapid_keys.json ]; then
      case "$state" in generate|renew) VAPID_REPLACED=1 ;; esac
      case "$state" in
        generate) drill_note "web push: vapid_keys.json generated fresh, the backup's key pair is not restored" ;;
        renew) drill_note "web push: vapid_keys.json was the backup's — replaced by a fresh key pair (the previous file: vapid_keys.json.pre-restore-$STAMP)" ;;
        own) drill_note "web push: this instance's own vapid_keys.json is kept, not the backup's" ;;
      esac
    fi
  done <<< "$SECRETS_PLAN"
  if ! grep -qE '^  (restore|replace|generate|renew) ' <<< "$SECRETS_PLAN"; then
    return 0
  fi
  echo "secrets:"
  secrets_script apply
  if [ "$SECRETS_ENV_CHANGED" = 1 ]; then
    log "secrets: .env.selfhost was restored — the services pick it up when they start"
  fi
}

# name of the image the db service runs (built by selfhost.sh build)
db_image() {
  awk '/^  db:/{f=1; next} f && /^  [a-z]/{exit} f && /^    image:/{print $2; exit}' docker-compose.selfhost.yml
}

# starts db alone (building its image if it is missing) and waits until healthy
start_db() {
  local img; img="$(db_image)"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    log "db: image $img is missing — building it"
    sh_compose build db
  fi
  sh_compose_q up -d --wait --no-deps db >/dev/null
}

# one value from SQL $1 in database $2 (default postgres); callers add
# `|| die`, so a failing query is never taken for an answer
sql_value() {
  printf '%s\n' "$1" | db_psql -d "${2:-postgres}"
}

# yes when the database cryptogram exists
db_exists() {
  local n
  n="$(sql_value "SELECT count(*) FROM pg_database WHERE datname = 'cryptogram';")" \
    || die "cannot query the database server"
  [ "$n" = 1 ]
}

db_is_empty() {
  local n
  db_exists || return 0
  n="$(sql_value "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%';" cryptogram)" \
    || die "cannot query the database cryptogram"
  [ "$n" = 0 ]
}

# names of pre-restore database copies (cryptogram_pre_restore_<stamp>)
db_pre_restore_copies() {
  sql_value "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'cryptogram\_pre\_restore\_%';"
}

# Sets the passwords of postgres, writer, reader and mediasoup from the db
# container's environment (= the current .env.selfhost) and creates missing
# application roles. The passwords are read inside the container (\getenv)
# and are never part of a command line; the session does not log statements.
ensure_roles() {
  local sql
  sql="SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\\getenv su_pw POSTGRES_PASSWORD
ALTER ROLE postgres PASSWORD :'su_pw';
"
  local role var
  for role in writer reader mediasoup; do
    case "$role" in
      writer) var=PG_WRITER_PASSWORD ;;
      reader) var=PG_READER_PASSWORD ;;
      mediasoup) var=PG_MEDIASOUP_PASSWORD ;;
    esac
    if [ -z "${!var:-}" ]; then
      [ "$role" = mediasoup ] && continue
      die "$var is empty in .env.selfhost"
    fi
    sql+="SELECT 'CREATE ROLE $role LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$role') \\gexec
\\getenv pw $var
ALTER ROLE $role PASSWORD :'pw';
"
  done
  printf '%s' "$sql" | db_psql -d postgres
}

# Prints the roles the dump file $1 assigns ownership or privileges to that
# the cluster will not have (postgres and the application roles always
# exist after ensure_roles). Reads the dump with a one-off container of the
# db image, so it works before anything is started or changed.
missing_dump_roles() {
  local file="$1" img r roles running=0 missing=""
  img="$(db_image)"
  local schema
  schema="$(docker run --rm -i --network none --entrypoint pg_restore "$img" --schema-only -f - < "$file")" \
    || die "could not read the dump (pg_restore --schema-only)"
  roles="$({ grep -E '^(ALTER .*OWNER TO|GRANT|REVOKE)' <<< "$schema" || true; } | { grep -oE '(TO|FROM) [^;]+' || true; } \
    | sed -E 's/^(TO|FROM) //; s/ WITH GRANT OPTION//; s/ GRANTED BY .*//' | tr ',' '\n' \
    | sed 's/^ *//; s/"//g' | sort -u)"
  if volume_exists "$(volume_name pgdata)" && [ -f .env.selfhost ] && service_running db; then
    running=1
  fi
  local n
  for r in $roles; do
    case "$r" in PUBLIC|postgres|writer|reader|mediasoup) continue ;; esac
    if [ "$running" = 1 ]; then
      n="$(sql_value "SELECT count(*) FROM pg_roles WHERE rolname = '$r';")" || die "cannot query the roles"
      if [ "$n" = 1 ]; then continue; fi
    fi
    missing="$missing $r"
  done
  printf '%s' "$missing"
}

# decides what happens to the database; may start db (alone) to look inside
plan_db() {
  local pgdata; pgdata="$(volume_name pgdata)"
  if ! volume_exists "$pgdata"; then
    ACTION[db]=restore
    echo "db:      $pgdata does not exist — a fresh cluster is initialized, the dump restored"
  elif [ ! -f .env.selfhost ]; then
    if [ "$RESTORE_FORCE" = 1 ]; then
      ACTION[db]=replace
      echo "db:      $pgdata exists, but without .env.selfhost it cannot be looked into —"
      echo "         its database is replaced (--force)"
    else
      ACTION[db]=refuse
      echo "db:      $pgdata exists, but without .env.selfhost it cannot be looked into — REFUSED"
      echo "         (restore the secrets first: --only secrets; or --force)"
    fi
  else
    if ! service_running db && [ "$RESTORE_DRY" = 0 ]; then
      echo "db:      (starting db alone to look inside)"
      start_db
    fi
    local copies=""
    if service_running db; then
      copies="$(db_pre_restore_copies)" || die "cannot query the database server"
    fi
    if [ -n "$copies" ]; then
      ACTION[db]=refuse
      echo "db:      a pre-restore copy of an earlier restore exists ($copies) — REFUSED;"
      echo "         first --undo or --discard-undo that restore (the stamp is in the name)"
    elif ! service_running db; then
      ACTION[db]=restore
      echo "db:      $pgdata exists but db is not running — whether it is empty is checked at"
      echo "         restore time (non-empty: refused without --force)"
    elif db_is_empty; then
      ACTION[db]=restore
      echo "db:      the database is empty — the dump is restored"
    elif [ "$RESTORE_FORCE" = 1 ]; then
      ACTION[db]=replace
      echo "db:      NOT empty — replaced (--force); the current database is kept as"
      echo "         cryptogram_pre_restore_$STAMP until the restore succeeded"
    else
      ACTION[db]=refuse
      echo "db:      NOT empty — REFUSED (--force replaces it)"
    fi
  fi
  if [ "${ACTION[db]}" != refuse ]; then
    echo "         then: role passwords from .env.selfhost, pg_restore, row counts compared"
    echo "         with the backup, Valkey state removed (everyone logs in again)"
    if drill_mode; then
      echo "         drill: the stored web-push subscriptions are removed"
    fi
  fi
}

# plan phase: fetches the dump and checks it before anything is touched
fetch_dump() {
  local manifest="$1" want got missing
  log "db: reading the dump"
  restore_to_dir "$RESTORE_FROM" /cg/db "$RESTORE_TMP/db"
  want="$(manifest_get "$manifest" db_sha256)"
  got="$(sha256sum "$CG_BACKUP_DIR/$RESTORE_TMP/db/cryptogram.pgc" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "db: checksum mismatch (manifest $want, file $got)"
  log "db: checksum ok ($got)"
  check_dump_roles "$CG_BACKUP_DIR/$RESTORE_TMP/db/cryptogram.pgc"
}

# refuses a dump that needs roles this cluster lacks (when the db image is
# there to read it; otherwise apply_db checks again before touching anything)
DUMP_ROLES_CHECKED=0
check_dump_roles() {
  local file="$1" missing
  docker image inspect "$(db_image)" >/dev/null 2>&1 || return 0
  missing="$(missing_dump_roles "$file")"
  if [ -n "$missing" ]; then
    ACTION[db]=refuse
    echo "db:      the dump needs roles this cluster does not have:$missing — REFUSED"
    echo "         (docs/database/README.md, \"Restoring a PostgreSQL 14 database into 18\")"
    return 0
  fi
  DUMP_ROLES_CHECKED=1
}

# restores the dump file $1 (host path) into the database: the existing
# database is renamed (kept until finalize_restore), a fresh one restored;
# $2 = expected row counts file (optional)
apply_db() {
  local file="$1" counts="${2:-}" missing
  log "db: starting the database"
  start_db
  if [ "$DUMP_ROLES_CHECKED" = 0 ]; then
    missing="$(missing_dump_roles "$file")"
    [ -z "$missing" ] || die "the dump needs roles this cluster does not have:$missing — see docs/database/README.md (\"Restoring a PostgreSQL 14 database into 18\")"
  fi
  log "db: setting the role passwords from .env.selfhost"
  ensure_roles
  undo_record roles set
  if db_exists && ! db_is_empty; then
    [ "$RESTORE_FORCE" = 1 ] || die "db: the database is not empty — refusing to overwrite it (--force replaces it)"
    log "db: keeping the current database as cryptogram_pre_restore_$STAMP"
    undo_record db replace
    db_psql -d postgres <<EOF
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'cryptogram' AND pid <> pg_backend_pid();
ALTER DATABASE cryptogram RENAME TO cryptogram_pre_restore_$STAMP;
CREATE DATABASE cryptogram ENCODING 'utf8';
EOF
  else
    undo_record db restore
    if ! db_exists; then
      echo "CREATE DATABASE cryptogram ENCODING 'utf8';" | db_psql -d postgres
    fi
  fi

  local jobs cid t0
  jobs="$(nproc 2>/dev/null || echo 2)"
  if [ "$jobs" -gt 4 ]; then jobs=4; fi
  cid="$(sh_compose ps -q db)"
  t0=$(date +%s)
  log "db: pg_restore (-j $jobs)"
  # a one-off client in the db container's network namespace, so the dump is
  # read from a bind mount instead of being copied into the container (--rm
  # also removes the anonymous volume the db image declares)
  (
    export PGPASSWORD="$PG_SU_PASSWORD"
    exec docker run --rm --network "container:$cid" -e PGPASSWORD \
      -v "$file:/restore/cryptogram.pgc:ro" --entrypoint pg_restore "$(db_image)" \
      -h 127.0.0.1 -U postgres -d cryptogram --exit-on-error -j "$jobs" /restore/cryptogram.pgc
  )
  log "db: restored in $(( $(date +%s) - t0 ))s; refreshing planner statistics"
  sh_compose exec -T db vacuumdb -U postgres -d cryptogram --analyze-in-stages -q

  if [ -n "$counts" ]; then
    local now
    now="$(printf '%s\n' "$ROWCOUNT_SQL" | db_psql -d cryptogram)"
    if [ "$now" = "$(cat "$counts")" ]; then
      log "db: row counts match the backup ($(wc -l < "$counts") tables, $(awk -F'|' '{s+=$2} END {print s}' "$counts") rows)"
    else
      diff <(cat "$counts") <(printf '%s\n' "$now") | sed 's/^/  /' >&2 || true
      die "db: row counts differ from the backup (< backup, > restored)"
    fi
  fi

  if drill_mode; then
    drill_clear_push_subscriptions
  fi

  # sessions and short-lived state in Valkey belong to the old database
  local vk; vk="$(volume_name valkey-data)"
  if volume_exists "$vk"; then
    log "db: removing the Valkey state ($vk) — everyone logs in again"
    sh_compose_q rm -s -f redis >/dev/null
    docker volume rm "$vk" >/dev/null
    undo_record valkey removed
  fi
}

# Drill: the restored database holds the source's web-push subscriptions
# (devices."webPushSubscription"). They belong to the source's VAPID key pair,
# which a drill never uses, so they could only fail — or, with that key pair,
# reach real browsers. Each one is removed; the devices (login keys) stay.
drill_clear_push_subscriptions() {
  local n
  n="$(printf '%s\n' \
    "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'devices' AND column_name = 'webPushSubscription') AS has_push \\gset" \
    '\if :has_push' \
    'WITH c AS (UPDATE public.devices SET "webPushSubscription" = NULL
       WHERE "webPushSubscription" IS NOT NULL RETURNING 1) SELECT count(*) FROM c;' \
    '\else' "SELECT 0;" '\endif' | db_psql -d cryptogram)" \
    || die "drill: could not remove the web-push subscriptions"
  log "drill: web-push subscriptions removed: $n (devices.\"webPushSubscription\")"
  drill_note "web push: stored push subscriptions removed from the database: $n (the devices stay)"
}

# the same for the database already in place (a drill restore that replaced
# the key pair but restores no database); starts db alone for it
drill_clear_existing_db() {
  if ! volume_exists "$(volume_name pgdata)"; then
    drill_note "web push: no database yet — the database restore removes the stored push subscriptions"
    return 0
  fi
  start_db
  if ! db_exists; then
    drill_note "web push: no database yet — the database restore removes the stored push subscriptions"
    return 0
  fi
  undo_record push cleared
  drill_clear_push_subscriptions
}

restore_db_file_cmd() {
  [ -f "$RESTORE_DB_FILE" ] || die "no such file: $RESTORE_DB_FILE"
  require_env_file
  local file
  file="$(cd "$(dirname "$RESTORE_DB_FILE")" && pwd)/$(basename "$RESTORE_DB_FILE")"
  echo "Restoring the database from $file ($(du -h "$file" | cut -f1), sha256 $(sha256sum "$file" | cut -d' ' -f1))"
  echo "This restore: $STAMP"
  if [ "$RESTORE_DRILL" = 1 ] && [ "$CG_BACKUP_DRILL" != true ]; then
    echo "DRILL: this instance becomes a drill instance (.env.selfhost: mail off, local CA,"
    echo "       its backup repository read-only for it); push subscriptions are removed"
  elif drill_mode; then
    echo "DRILL: the restored database's push subscriptions are removed"
  fi
  declare -gA ACTION=()
  plan_db
  if [ "${ACTION[db]}" != refuse ]; then
    check_dump_roles "$file"
  fi
  local size
  size="$(stat -c %s "$file")"
  space_verdict "$(( size * 3 ))" 0
  if [ "$RESTORE_DRY" = 1 ]; then
    echo
    echo "Dry run — nothing was changed."
    return
  fi
  [ "${ACTION[db]}" != refuse ] || die "refusing to overwrite the database (see above)"
  [ "${ACTION[space]:-}" != refuse ] || die "not enough free disk space (see above; --ignore-space-check overrides)"
  APPLY_STARTED=1
  : > "$UNDO_FILE"
  CURRENT_STEP="stopping the stack"
  log "stopping every service"
  STACK_STOPPED=1
  sh_compose_q stop >/dev/null
  # the same drill settings as a snapshot restore with --drill writes; the
  # repository this instance had becomes the read-only drill source
  if [ "$RESTORE_DRILL" = 1 ]; then
    CURRENT_STEP="switching this instance to drill mode"
    apply_drill_env "$(remote_url)"
    load_settings
  fi
  CURRENT_STEP="restoring the database"
  apply_db "$file" ""
  CURRENT_STEP="removing the pre-restore copies"
  finalize_restore
  log "restore finished. Start the instance with: ./selfhost/selfhost.sh up"
  drill_summary
}

# decides what happens to volume $2 (compose name; $1 = label). $3 = 1: a
# non-empty volume is refused without --force; 0: it is kept
plan_volume() {
  local label="$1" name="$2" strict="$3"
  local vol; vol="$(volume_name "$name")"
  local pad; pad="$(printf '%-8s' "$label:")"
  if ! volume_exists "$vol"; then
    ACTION[$label]=restore
    echo "$pad $vol is created and restored"
  elif volume_empty "$vol"; then
    ACTION[$label]=restore
    echo "$pad $vol is empty — restored"
  elif [ "$RESTORE_FORCE" = 1 ]; then
    ACTION[$label]=replace
    echo "$pad $vol ($(volume_size "$vol")) is replaced (--force); its contents are kept in"
    echo "         .pre-restore-$STAMP/ inside the volume until the restore succeeded"
  elif [ "$strict" = 1 ]; then
    ACTION[$label]=refuse
    echo "$pad $vol is NOT empty ($(volume_size "$vol")) — REFUSED (--force replaces it)"
  else
    ACTION[$label]=keep
    echo "$pad $vol is not empty — kept (--force replaces it with the backup's)"
  fi
}

# restores snapshot path $3 into volume $2 (compose name); $1 = label. The
# current contents move into .pre-restore-<stamp>/ (a rename on the same
# filesystem) and are removed by finalize_restore.
apply_volume() {
  local label="$1" name="$2" path="$3"
  local vol; vol="$(volume_name "$name")"
  ensure_volume "$name"
  if ! volume_empty "$vol"; then
    [ "$RESTORE_FORCE" = 1 ] || die "$label: $vol is not empty"
    log "$label: moving the current contents of $vol into .pre-restore-$STAMP/"
    # "moving" before, "moved" after: an undo after a crash in between only
    # moves entries back and deletes nothing
    undo_record volume moving "$label" "$vol"
    helper -v "$vol:/v" -- '
set -eu
keep="/v/.pre-restore-$1"
mkdir -p "$keep"
for f in /v/* /v/.[!.]* /v/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  [ "$f" = "$keep" ] || mv "$f" "$keep/"
done' "$STAMP"
    undo_record volume moved "$label" "$vol"
  else
    undo_record volume restore "$label" "$vol"
  fi
  local t0; t0=$(date +%s)
  log "$label: restoring into $vol"
  restic_c "$RESTORE_FROM" -v "$vol:/v" -- restore "$SNAP_ID:$path" --target /v --verify >/dev/null
  log "$label: restored and verified ($(( $(date +%s) - t0 ))s)"
}

plan_mail() {
  local vol; vol="$(volume_name mail-data)"
  local dkim=no
  if volume_exists "$vol"; then
    dkim="$(has_dkim_key "$vol")" || die "could not look into $vol"
  fi
  if [ "$dkim" = yes ]; then
    if [ "$RESTORE_FORCE" = 1 ]; then
      ACTION[mail]=replace
      echo "mail:    the DKIM key in $vol is replaced by the backup's (--force)"
    else
      ACTION[mail]=keep
      echo "mail:    $vol already holds a DKIM key — kept (--force replaces it)"
    fi
  else
    ACTION[mail]=restore
    echo "mail:    the DKIM key is restored into $vol"
  fi
}

apply_mail() {
  local vol; vol="$(volume_name mail-data)"
  ensure_volume mail-data
  if [ "${ACTION[mail]}" = replace ]; then
    undo_record mail replace "$vol"
    helper -v "$vol:/v" -- 'mv /v/dkim_keys "/v/dkim_keys.pre-restore-$1"' "$STAMP"
  else
    undo_record mail restore "$vol"
    helper -v "$vol:/v" -- 'rm -rf /v/dkim_keys'
  fi
  helper -v "$vol:/v" -- 'mkdir -p /v/dkim_keys'
  restic_c "$RESTORE_FROM" -v "$vol:/v" -- restore "$SNAP_ID:/cg/mail/dkim_keys" --target /v/dkim_keys --verify >/dev/null
  log "mail: DKIM key restored"
}

# Everything was restored and verified. The record is retired first — the
# commit point: from here the restore counts as done and is never undone —
# then the pre-restore copies of the database and the volumes are dropped
# (the secrets' *.pre-restore-* files stay). A cleanup that fails leaves the
# copies and the retired record for `restore --discard-undo <stamp>`.
RESTORE_COMMITTED=0
finalize_restore() {
  local kind a b c left="" done_file="$UNDO_FILE.done"
  [ -f "$UNDO_FILE" ] || return 0
  mv -f "$UNDO_FILE" "$done_file"
  RESTORE_COMMITTED=1
  while read -r kind a b c; do
    case "$kind $a" in
      "db replace")
        log "db: dropping the previous database cryptogram_pre_restore_$STAMP"
        sql_value "DROP DATABASE IF EXISTS cryptogram_pre_restore_$STAMP WITH (FORCE);" >/dev/null \
          || left="$left database cryptogram_pre_restore_$STAMP;" ;;
      "volume moved")
        log "$b: removing the previous contents (.pre-restore-$STAMP/ in $c)"
        helper -v "$c:/v" -- 'rm -rf "/v/.pre-restore-$1"' "$STAMP" \
          || left="$left .pre-restore-$STAMP/ in volume $c;" ;;
      "mail replace")
        helper -v "$b:/v" -- 'rm -rf "/v/dkim_keys.pre-restore-$1"' "$STAMP" \
          || left="$left dkim_keys.pre-restore-$STAMP in volume $b;" ;;
    esac
  done < "$done_file"
  if grep -q '^secret replace ' "$done_file"; then
    log "the replaced secrets are kept as <file>.pre-restore-$STAMP — delete them once all is well"
  fi
  if [ -n "$left" ]; then
    log "the restore SUCCEEDED, but these pre-restore copies could not be removed:$left"
    log "remove them with: ./selfhost/selfhost.sh restore --discard-undo $STAMP"
  else
    rm -f "$done_file"
  fi
}

# Refuses to start a restore while an earlier one is unfinished (undo record)
# or left pre-restore copies behind: a second restore would mix their states.
check_no_unfinished() {
  local f stamp vol out
  for f in "$DOCKER_DIR"/restore-undo.pre-restore-*; do
    [ -e "$f" ] || continue
    stamp="${f##*pre-restore-}"
    case "$f" in
      *.done) die "restore ${stamp%.done} left pre-restore copies behind — remove them first: ./selfhost/selfhost.sh restore --discard-undo ${stamp%.done}" ;;
      *) die "restore $stamp did not finish — first go back (./selfhost/selfhost.sh restore --undo $stamp) or keep its state (./selfhost/selfhost.sh restore --discard-undo $stamp --force)" ;;
    esac
  done
  for vol in "$(volume_name seaweedfs-data)" "$(volume_name caddy-data)" "$(volume_name mail-data)"; do
    volume_exists "$vol" || continue
    out="$(helper -v "$vol:/v:ro" -- 'ls -A /v | grep -o "pre-restore-[0-9]*" | sort -u | tr "\n" " " || true')" \
      || die "could not look into $vol"
    if [ -n "$out" ]; then
      die "volume $vol still holds copies of an earlier restore (${out% }) — remove them: ./selfhost/selfhost.sh restore --discard-undo <stamp>"
    fi
  done
}

# keeps the current state and removes the pre-restore copies of restore $1
cmd_discard() {
  STAMP="$1"
  [[ "$STAMP" =~ ^[0-9]{14}$ ]] || die "--discard-undo needs the 14-digit stamp of a restore"
  local rec="$DOCKER_DIR/restore-undo.pre-restore-$STAMP" vol n
  if [ -f "$rec" ]; then
    echo "Restore $STAMP did not finish:"
    UNDO_FILE="$rec"; describe_undo
    [ "$RESTORE_FORCE" = 1 ] || die "discarding keeps this half-restored state — use --undo $STAMP, or add --force to discard anyway"
  fi
  if [ "$RESTORE_DRY" = 1 ]; then
    echo "Dry run: would remove cryptogram_pre_restore_$STAMP, .pre-restore-$STAMP/ and dkim_keys.pre-restore-$STAMP in the volumes, and the record."
    return
  fi
  if volume_exists "$(volume_name pgdata)"; then
    require_env_file
    start_db
    n="$(sql_value "SELECT count(*) FROM pg_database WHERE datname = 'cryptogram_pre_restore_$STAMP';")" \
      || die "cannot query the database server"
    if [ "$n" = 1 ]; then
      log "db: dropping cryptogram_pre_restore_$STAMP"
      sql_value "DROP DATABASE cryptogram_pre_restore_$STAMP WITH (FORCE);" >/dev/null || die "could not drop it"
    fi
  fi
  for vol in "$(volume_name seaweedfs-data)" "$(volume_name caddy-data)" "$(volume_name mail-data)"; do
    volume_exists "$vol" || continue
    helper -v "$vol:/v" -- 'rm -rf "/v/.pre-restore-$1" "/v/dkim_keys.pre-restore-$1"' "$STAMP" \
      || die "could not clean $vol"
  done
  rm -f "$rec" "$rec.done"
  log "pre-restore copies of $STAMP removed (secrets moved aside as <file>.pre-restore-$STAMP stay)"
}

# bytes of the files below path $1 in the snapshot
snapshot_bytes() {
  restic_c "$RESTORE_FROM" -- ls --json --recursive "$SNAP_ID" "$1" \
    | jq_c -s '[.[] | select(.type == "file") | .size // 0] | add // 0'
}

# free bytes on the filesystem behind Docker's volumes / behind CG_BACKUP_DIR
free_docker() {
  docker run --rm --network none -v /v --entrypoint df "$RESTIC_IMAGE" -Pk /v | awk 'NR == 2 {print $4 * 1024}'
}
free_backup_dir() {
  helper -v "$CG_BACKUP_DIR:/backup" -- 'df -Pk /backup' | awk 'NR == 2 {print $4 * 1024}'
}

human() {
  if [ "$1" -ge 1073741824 ]; then echo "$(( $1 / 1073741824 )) GiB"
  elif [ "$1" -ge 1048576 ]; then echo "$(( $1 / 1048576 )) MiB"
  else echo "$(( $1 / 1024 )) KiB"; fi
}

# $1 = bytes needed on Docker storage, $2 = bytes needed in CG_BACKUP_DIR;
# sets ACTION[space]=refuse when either does not fit
space_verdict() {
  local need_d="$1" need_b="$2" free_d free_b ok=1
  free_d="$(free_docker)" || die "could not measure the free space of Docker's storage"
  echo "space:   Docker storage needs ~$(human "$need_d"), $(human "$free_d") free"
  if [ "$need_d" -gt "$free_d" ]; then ok=0; fi
  if [ "$need_b" -gt 0 ]; then
    free_b="$(free_backup_dir)" || die "could not measure the free space of $CG_BACKUP_DIR"
    echo "         $CG_BACKUP_DIR needs ~$(human "$need_b"), $(human "$free_b") free"
    if [ "$need_b" -gt "$free_b" ]; then ok=0; fi
  fi
  if [ "$ok" = 0 ]; then
    if [ "$RESTORE_IGNORE_SPACE" = 1 ]; then
      echo "         NOT ENOUGH — going on anyway (--ignore-space-check)"
    else
      ACTION[space]=refuse
      echo "         NOT ENOUGH free space — REFUSED (--ignore-space-check overrides)"
    fi
  fi
}

# Free space for this restore: the dump (in CG_BACKUP_DIR) and a database of
# ~3x its size (tables + indexes) next to the old one, plus a second copy of
# the media and caddy-data (the old contents stay until the end). If Docker
# and CG_BACKUP_DIR share a filesystem, both amounts come from the same space.
check_space() {
  local c dump=0 docker_need=0 n
  for c in "$@"; do
    case "${ACTION[$c]:-}" in refuse|keep) continue ;; esac
    case "$c" in
      db) dump="$(snapshot_bytes /cg/db)" || die "could not size the dump"
          docker_need=$(( docker_need + dump * 3 )) ;;
      media) n="$(snapshot_bytes /cg/media)" || die "could not size the media"
          docker_need=$(( docker_need + n )) ;;
      caddy) n="$(snapshot_bytes /cg/caddy)" || die "could not size caddy-data"
          docker_need=$(( docker_need + n )) ;;
    esac
  done
  if [ "$docker_need" -gt 0 ] || [ "$dump" -gt 0 ]; then
    space_verdict "$docker_need" "$dump"
  fi
}

# ------------------------------------------------------------------ undo --

# goes back to the state before restore <stamp>, from its undo record
cmd_undo() {
  STAMP="$1"
  [[ "$STAMP" =~ ^[0-9]{14}$ ]] || die "--undo needs the 14-digit stamp a restore printed"
  UNDO_FILE="$DOCKER_DIR/restore-undo.pre-restore-$STAMP"
  if [ ! -f "$UNDO_FILE" ]; then
    if [ -f "$UNDO_FILE.done" ]; then
      die "restore $STAMP finished — it cannot be undone; its leftover copies go with: ./selfhost/selfhost.sh restore --discard-undo $STAMP"
    fi
    die "nothing to undo for $STAMP (no $UNDO_FILE)"
  fi
  echo "Undoing restore $STAMP:"
  describe_undo
  # services other than db started after the last restore step: the instance
  # has run on the restored data, and an undo throws away what it wrote
  local started="" cid svc st t rec_time
  rec_time="$(stat -c %Y "$UNDO_FILE")"
  for cid in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
    [ "$svc" != db ] || continue
    st="$(docker inspect -f '{{.State.StartedAt}}' "$cid")"
    t="$(date -d "$st" +%s)"
    if [ "$t" -gt "$rec_time" ]; then started="$started $svc"; fi
  done
  if [ -n "$started" ]; then
    echo "WARNING: these services started after the restore stopped:$started"
    echo "         The instance has run on the restored data; the undo discards whatever was written since."
    [ "$RESTORE_FORCE" = 1 ] || [ "$RESTORE_DRY" = 1 ] || die "add --force to undo anyway"
  fi
  if [ "$RESTORE_DRY" = 1 ]; then
    echo
    echo "Dry run — nothing was changed."
    return
  fi
  APPLY_STARTED=0
  local kind a b c secrets_back=0
  if grep -qE '^(db|volume|mail) ' "$UNDO_FILE"; then
    require_env_file
    log "stopping every service"
    sh_compose_q stop >/dev/null
  fi
  while read -r kind a b c; do
    case "$kind $a" in
      "volume moving")
        if ! grep -q "^volume moved $b " "$UNDO_FILE"; then
          # interrupted while moving: nothing was restored yet, so nothing in
          # the volume is deleted — the moved entries just go back
          log "$b: moving the entries already moved back into $c"
          helper -v "$c:/v" -- '
set -eu
keep="/v/.pre-restore-$1"
if [ ! -d "$keep" ]; then exit 0; fi
for f in "$keep"/* "$keep"/.[!.]* "$keep"/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  mv "$f" /v/
done
rmdir "$keep"' "$STAMP"
          continue
        fi
        log "$b: putting the previous contents back into $c"
        helper -v "$c:/v" -- '
set -eu
keep="/v/.pre-restore-$1"
if [ ! -d "$keep" ]; then echo "  (no $keep in the volume: already undone)"; exit 0; fi
for f in /v/* /v/.[!.]* /v/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  [ "$f" = "$keep" ] || rm -rf "$f"
done
for f in "$keep"/* "$keep"/.[!.]* "$keep"/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  mv "$f" /v/
done
rmdir "$keep"' "$STAMP" ;;
      "volume restore")
        log "$b: emptying $c again"
        helper -v "$c:/v" -- 'find /v -mindepth 1 -delete' ;;
      "mail replace")
        helper -v "$b:/v" -- '[ ! -d "/v/dkim_keys.pre-restore-$1" ] || { rm -rf /v/dkim_keys && mv "/v/dkim_keys.pre-restore-$1" /v/dkim_keys; }' "$STAMP" ;;
      "mail restore")
        helper -v "$b:/v" -- 'rm -rf /v/dkim_keys' ;;
    esac
  done < "$UNDO_FILE"
  if grep -qE '^db ' "$UNDO_FILE"; then
    start_db
    if grep -q '^db replace' "$UNDO_FILE"; then
      log "db: putting the previous database back"
      local n
      n="$(sql_value "SELECT count(*) FROM pg_database WHERE datname = 'cryptogram_pre_restore_$STAMP';")" \
        || die "cannot query the database server"
      # cryptogram is dropped only when the copy to put back exists
      if [ "$n" = 1 ]; then
        db_psql -d postgres <<EOF
DROP DATABASE IF EXISTS cryptogram WITH (FORCE);
ALTER DATABASE cryptogram_pre_restore_$STAMP RENAME TO cryptogram;
EOF
      else
        log "db: cryptogram_pre_restore_$STAMP is gone — already undone"
      fi
    else
      # "db restore": the record says the database was empty before
      log "db: emptying the database again (it was empty before the restore)"
      db_psql -d postgres <<'EOF'
DROP DATABASE IF EXISTS cryptogram WITH (FORCE);
CREATE DATABASE cryptogram ENCODING 'utf8';
EOF
    fi
  fi
  while read -r kind a b c; do
    case "$kind $a" in
      "secret replace")
        log "secrets: $b back"
        helper -v "$DOCKER_DIR:/d" -- '[ ! -e "/d/$1.pre-restore-$2" ] || { rm -rf "/d/$1" && mv "/d/$1.pre-restore-$2" "/d/$1"; }' "$b" "$STAMP"
        secrets_back=1 ;;
      "secret new")
        log "secrets: removing $b"
        helper -v "$DOCKER_DIR:/d" -- 'rm -rf "/d/$1"' "$b"
        secrets_back=1 ;;
    esac
  done < "$UNDO_FILE"
  # the role passwords were set from the restored .env.selfhost
  if grep -q '^roles set' "$UNDO_FILE" && [ -f .env.selfhost ] && volume_exists "$(volume_name pgdata)"; then
    load_settings
    log "db: setting the role passwords from the current .env.selfhost again"
    start_db
    ensure_roles
  fi
  rm -f "$UNDO_FILE"
  [ "$secrets_back" = 0 ] || log "secrets: back to their state before the restore"
  log "undone. Start the instance with: ./selfhost/selfhost.sh up"
}

# ---------------------------------------------------------------- verify --

VERIFY_CONTAINER=""
verify_cleanup() {
  local rc=$?
  # -v: the db image declares a volume; without it every run would leave an
  # anonymous volume holding a plaintext copy of the database
  if [ -n "$VERIFY_CONTAINER" ]; then docker rm -fv "$VERIFY_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$RESTORE_TMP" ]; then
    helper -v "$CG_BACKUP_DIR:/backup" -- 'rm -rf "/backup/$1"' "$RESTORE_TMP" || true
  fi
  if [ "$rc" != 0 ]; then
    log "verify FAILED (exit $rc)"
    run_hook "${CG_BACKUP_ON_FAILURE:-}" failure "$rc"
  fi
  exit "$rc"
}

# restore drill without touching the instance: the dump of a snapshot is
# restored into a throwaway PostgreSQL container and its row counts compared
cmd_backup_verify() {
  CURRENT_COMMAND="backup verify"
  local snapshot=latest
  while [ $# -gt 0 ]; do
    case "$1" in
      --remote) RESTORE_FROM=remote; shift ;;
      *) snapshot="$1"; shift ;;
    esac
  done
  RESTORE_FROM="${RESTORE_FROM:-local}"
  require_env_file
  require_password
  take_lock
  trap verify_cleanup EXIT
  HOOK_ON_DIE=0
  local t0; t0=$(date +%s)
  resolve_snapshot "$RESTORE_FROM" "$snapshot"
  log "verifying snapshot ${SNAP_ID:0:8} ($SNAP_TIME) from the $RESTORE_FROM repository"
  local manifest
  manifest="$(restic_c "$RESTORE_FROM" -- dump "$SNAP_ID" /cg/MANIFEST)"
  RESTORE_TMP="verify-$STAMP"
  restore_to_dir "$RESTORE_FROM" /cg/db "$RESTORE_TMP"
  local dir="$CG_BACKUP_DIR/$RESTORE_TMP" want got
  want="$(manifest_get "$manifest" db_sha256)"
  got="$(sha256sum "$dir/cryptogram.pgc" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "checksum mismatch (manifest $want, file $got)"
  log "dump checksum ok"

  local img; img="$(db_image)"
  docker image inspect "$img" >/dev/null 2>&1 || sh_compose build db
  VERIFY_CONTAINER="cg-backup-verify-$PROJECT-$STAMP"
  (
    POSTGRES_PASSWORD="$(openssl rand -hex 16)"
    PG_WRITER_PASSWORD="$(openssl rand -hex 16)"
    PG_READER_PASSWORD="$(openssl rand -hex 16)"
    PG_MEDIASOUP_PASSWORD="$(openssl rand -hex 16)"
    export POSTGRES_PASSWORD PG_WRITER_PASSWORD PG_READER_PASSWORD PG_MEDIASOUP_PASSWORD
    exec docker run -d --name "$VERIFY_CONTAINER" --network none --shm-size 256m \
      -e POSTGRES_PASSWORD -e PG_WRITER_PASSWORD -e PG_READER_PASSWORD -e PG_MEDIASOUP_PASSWORD \
      -v "$dir:/restore:ro" "$img" >/dev/null
  )
  # the entrypoint's init phase only listens on the socket; TCP means the
  # final server, after init.sh created the database and the roles
  local i
  for i in $(seq 1 120); do
    if docker exec "$VERIFY_CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then break; fi
    [ "$i" != 120 ] || die "the throwaway database did not start"
    sleep 1
  done
  log "restoring the dump into a throwaway database"
  docker exec "$VERIFY_CONTAINER" pg_restore -U postgres -d cryptogram --exit-on-error -j 2 /restore/cryptogram.pgc
  local now
  now="$(printf '%s\n' "$ROWCOUNT_SQL" | docker exec -i "$VERIFY_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d cryptogram)"
  if [ "$now" != "$(cat "$dir/rowcounts.txt")" ]; then
    diff "$dir/rowcounts.txt" <(printf '%s\n' "$now") | sed 's/^/  /' >&2 || true
    die "row counts differ (< backup, > restored)"
  fi
  log "row counts match ($(wc -l < "$dir/rowcounts.txt") tables, $(awk -F'|' '{s+=$2} END {print s}' "$dir/rowcounts.txt") rows)"
  log "verify passed in $(( $(date +%s) - t0 ))s (media: covered by ./selfhost/selfhost.sh backup check)"
}

# ------------------------------------------------------------- the timer --

UNIT=cg-backup
UNIT_DIR=/etc/systemd/system
cmd_install_timer() {
  [ "$(id -u)" = 0 ] || die "installing systemd units needs root: sudo ./selfhost/selfhost.sh backup install-timer"
  command -v systemctl >/dev/null || die "systemctl not found — schedule ./selfhost/selfhost.sh backup run with your own scheduler"
  require_env_file
  if drill_mode; then
    die "this is a drill instance (CG_BACKUP_DRILL=true): no scheduled backups here"
  fi
  # The units run as the owner of the checkout, who must be able to use
  # Docker (docker group) — nothing in a backup needs root itself.
  local owner group schedule check_schedule timeout script
  owner="$(stat -c %U "$DOCKER_DIR")"
  group="$(stat -c %G "$DOCKER_DIR")"
  if [ "$owner" != root ]; then
    runuser -u "$owner" -- test -r "$DOCKER_DIR/.env.selfhost" \
      || die "$owner (owner of $DOCKER_DIR) cannot read .env.selfhost — chown it to $owner"
    runuser -u "$owner" -- docker version >/dev/null 2>&1 \
      || die "$owner (owner of $DOCKER_DIR) cannot use Docker — add it to the docker group (usermod -aG docker $owner)"
  fi
  schedule="${CG_BACKUP_SCHEDULE:-*-*-* 03:30:00}"
  check_schedule="${CG_BACKUP_CHECK_SCHEDULE:-Sun *-*-* 05:00:00}"
  timeout="${CG_BACKUP_TIMEOUT:-4h}"
  script="$DOCKER_DIR/selfhost/selfhost.sh"
  # the local repository's top directory belongs to the unit's user (restic
  # itself writes inside it as root, from its container)
  # only a directory that is ours: missing, empty, or holding nothing but
  # what backup.sh puts there — never a shared one like /var/backups itself
  if [ ! -d "$CG_BACKUP_DIR" ]; then
    install -d -m 700 -o "$owner" -g "$group" "$CG_BACKUP_DIR"
  elif [ -z "$(find "$CG_BACKUP_DIR" -mindepth 1 -maxdepth 1 \
      ! -name repo ! -name cache ! -name staging ! -name 'restore-*' ! -name 'verify-*' \
      ! -name 'copied-*' ! -name 'guard-*' -print -quit)" ]; then
    chown "$owner:$group" "$CG_BACKUP_DIR"
    chmod 700 "$CG_BACKUP_DIR"
  else
    log "WARNING: $CG_BACKUP_DIR holds other files — not taking it over; make sure $owner can enter it (or point CG_BACKUP_DIR at a directory of its own)"
  fi
  local name cmd desc
  for name in "$UNIT" "$UNIT-check"; do
    if [ "$name" = "$UNIT" ]; then
      cmd="backup run"; desc="Common Ground backup"
    else
      cmd="backup check"; desc="Common Ground backup repository check"
    fi
    cat > "$UNIT_DIR/$name.service" <<EOF
# Written by selfhost.sh backup install-timer — docker/SELFHOST.md, "Backup and restore"
[Unit]
Description=$desc ($DOCKER_DIR)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$owner
Group=$group
ExecStart="$script" $cmd
# a backup killed while seaweed was frozen (timeout, OOM, SIGKILL) must not
# leave the media store paused
ExecStopPost=-"$script" backup resume
TimeoutStartSec=$timeout
NoNewPrivileges=yes
PrivateTmp=yes
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF
  done
  cat > "$UNIT_DIR/$UNIT.timer" <<EOF
# Written by selfhost.sh backup install-timer
[Unit]
Description=Daily Common Ground backup

[Timer]
OnCalendar=$schedule
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  cat > "$UNIT_DIR/$UNIT-check.timer" <<EOF
# Written by selfhost.sh backup install-timer
[Unit]
Description=Weekly Common Ground backup repository check

[Timer]
OnCalendar=$check_schedule
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  chmod 644 "$UNIT_DIR/$UNIT.service" "$UNIT_DIR/$UNIT.timer" \
    "$UNIT_DIR/$UNIT-check.service" "$UNIT_DIR/$UNIT-check.timer"
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" "$UNIT-check.timer"
  systemctl list-timers "$UNIT*" --no-pager
  echo
  echo "The units run as $owner. Logs: journalctl -u $UNIT -u $UNIT-check    Run now: systemctl start $UNIT"
}

cmd_uninstall_timer() {
  [ "$(id -u)" = 0 ] || die "needs root: sudo ./selfhost/selfhost.sh backup uninstall-timer"
  systemctl disable --now "$UNIT.timer" "$UNIT-check.timer" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT.service" "$UNIT_DIR/$UNIT.timer" \
    "$UNIT_DIR/$UNIT-check.service" "$UNIT_DIR/$UNIT-check.timer" \
    "/var/lib/systemd/timers/stamp-$UNIT.timer" "/var/lib/systemd/timers/stamp-$UNIT-check.timer"
  systemctl daemon-reload
  echo "Backup timers removed (the repositories are untouched)."
}

# ------------------------------------------------------------------ main --

backup_usage() {
  cat <<'EOF'
Usage: ./selfhost/selfhost.sh backup <command>

  init             create the backup password (if missing) and the repositories;
                   for an sftp: repository also the SSH key
  run [--take-over]  take a backup now: database dump, secrets, media (seaweed
                   is frozen while the changed media is read), caddy-data,
                   DKIM key; retention; copy to the off-server repository.
                   --take-over: this server replaced the one that made the
                   newest backup of this host name
  list [--remote]  list the snapshots
  check [--read-data]  check the repositories (reads CG_BACKUP_CHECK_SUBSET of
                   the data, default 5%; --read-data: all of it)
  verify [--remote] [snapshot]  restore the database of a snapshot (default:
                   latest) into a throwaway container and compare row counts
  resume           resume seaweed if an interrupted backup left it frozen
  install-timer    (root) daily backup + weekly check as systemd timers
  uninstall-timer  (root) remove them

Restore: ./selfhost/selfhost.sh restore --help
EOF
  exit "${1:-1}"
}

case "${1:-} ${2:-}" in
  "backup run"|"backup check"|"backup verify") CURRENT_COMMAND="$1 $2"; HOOK_ON_DIE=1 ;;
esac
load_settings
# HOOK_ON_DIE stays set until the command has installed its EXIT trap
# the first restic call on a fresh server would otherwise stream docker's
# pull progress (with terminal codes) into the output
case "${1:-} ${2:-}" in
  "backup "|"backup help"|"backup -h"|"backup --help"|"restore -h"*|"restore --help"*) ;;
  backup*|restore*)
    if ! docker image inspect "$RESTIC_IMAGE" >/dev/null 2>&1; then
      log "pulling $RESTIC_IMAGE"
      docker pull -q "$RESTIC_IMAGE" >/dev/null || die "could not pull $RESTIC_IMAGE"
    fi ;;
esac
case "${1:-}" in
  backup)
    case "${2:-}" in
      init) cmd_backup_init ;;
      run) cmd_backup_run "${@:3}" ;;
      list) cmd_backup_list "${@:3}" ;;
      check) cmd_backup_check "${@:3}" ;;
      verify) cmd_backup_verify "${@:3}" ;;
      resume) cmd_backup_resume ;;
      install-timer) cmd_install_timer ;;
      uninstall-timer) cmd_uninstall_timer ;;
      help|-h|--help) backup_usage 0 ;;
      *) backup_usage ;;
    esac
    ;;
  restore)
    cmd_restore "${@:2}"
    ;;
  *)
    backup_usage
    ;;
esac
