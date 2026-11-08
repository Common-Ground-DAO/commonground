#!/bin/bash
# Makes sure the dev stack configuration exists before anything reads it:
#   - docker/.env missing:
#       * in a linked git worktree whose main worktree has one: copied from
#         there (every checkout on a machine shares the same dev database
#         volume, so they must share its passwords)
#       * if a dev database volume already exists: stops with the ways to get
#         the matching docker/.env back (fresh secrets would lock the stack
#         out of that database)
#       * otherwise: created from docker/.env.example, every
#         "generated-on-first-run" value replaced with a fresh random secret
#         and BUILDER_UID/BUILDER_GID set to the current user
#   - docker/s3_config/s3.json missing: generated with the S3_SECRET from
#     docker/.env (SeaweedFS and the backend must agree on it)
#   - warns (never fails) when docker/.env lacks variables that
#     docker/.env.example defines, still holds placeholder secrets, selects
#     reCAPTCHA only implicitly, or when s3.json's secret does not match
#     S3_SECRET
# An existing docker/.env or s3.json is never modified.
#
# Called by run.sh, docker/build.sh, docker/updateBackend.sh,
# docker/updateFrontend.sh and the tools/*.sh migration/test scripts. Safe to
# run any number of times.
set -euo pipefail

# the calling script exports this marker after the first run, so the scripts
# it calls don't repeat the checks and warnings
if [ "${CG_ENV_ENSURED:-}" = "1" ]; then
  exit 0
fi

DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DOCKER_DIR/.env"
EXAMPLE_FILE="$DOCKER_DIR/.env.example"
S3_DIR="$DOCKER_DIR/s3_config"
S3_CONFIG="$S3_DIR/s3.json"
PLACEHOLDER="generated-on-first-run"
# docker compose names the project after the directory of the compose file
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$DOCKER_DIR")}"
PGDATA_VOLUME="${PROJECT}_pgdata"
RESTORE_CMD='git show "$(git log -1 --format=%H --diff-filter=D -- docker/.env)^:docker/.env" > docker/.env'

warn() { printf '\e[33mWarning:\e[0m %s\n' "$*" >&2; }
note() { printf '%s\n' "$*" >&2; }
die() { printf '\e[31mError:\e[0m %s\n' "$*" >&2; exit 1; }

# names of the variables an env file assigns (commented-out lines don't count)
env_vars() {
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$1" | LC_ALL=C sort -u
}

# a variable's value as run.sh sees it (it sources the file)
env_get() {
  (set +eu; set -a; . "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${!1:-}")
}

# random hex secret per variable (lengths as in docker/selfhost/init.sh);
# hex keeps every value safe in SQL literals, the redis command line and JSON
secret_for() {
  case "$1" in
    S3_SECRET) openssl rand -hex 48 ;;
    ALTCHA_HMAC_KEY) openssl rand -hex 32 ;;
    *) openssl rand -hex 24 ;;
  esac
}

# root of the main worktree when this checkout is a linked `git worktree`
main_worktree() {
  local common gitdir
  common="$(cd "$DOCKER_DIR" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)" || return 1
  gitdir="$(cd "$DOCKER_DIR" && cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P)" || return 1
  [ "$common" != "$gitdir" ] && [ "$(basename "$common")" = ".git" ] || return 1
  dirname "$common"
}

# docker created a directory here when a container bind-mounted the path
# while the file was missing; neither compose nor this script can fix that
if [ -d "$S3_CONFIG" ]; then
  die "$S3_CONFIG is a directory, not a file — docker created it when seaweed
  was started while the file was missing. Remove it (it is empty but owned by root):
    sudo rmdir '$S3_CONFIG'
  then run this command again; s3.json is regenerated from docker/.env."
fi

if [ ! -f "$ENV_FILE" ]; then
  main_root="$(main_worktree || true)"
  if [ -n "$main_root" ] && [ -f "$main_root/docker/.env" ]; then
    # linked worktree: same machine, same dev database volume, same passwords
    cp "$main_root/docker/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    note "Copied docker/.env from the main worktree ($main_root)."
    if [ ! -e "$S3_CONFIG" ] && [ -f "$main_root/docker/s3_config/s3.json" ]; then
      mkdir -p "$S3_DIR"
      cp "$main_root/docker/s3_config/s3.json" "$S3_CONFIG"
      chmod 644 "$S3_CONFIG"
      note "Copied docker/s3_config/s3.json from the main worktree."
    fi

  elif command -v docker >/dev/null 2>&1 && docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then
    # postgres applies its passwords only when the volume is initialized, so
    # fresh secrets would lock every backend service out of this database.
    # The volume belongs to every checkout on this machine (compose project
    # "$PROJECT"), not only to this one.
    die "docker/.env is missing, but the dev database volume $PGDATA_VOLUME already exists.
  It only accepts the passwords it was created with, so no new docker/.env is generated.
  Get the matching docker/.env back, one of:
    - copy it from another checkout on this machine (they all share this volume)
    - restore the version that was tracked in git (if you never changed its passwords):
        $RESTORE_CMD
      If docker/s3_config/s3.json was generated from a different docker/.env in the
      meantime, delete it too — the next run regenerates it from the restored file.
    - or start over WITHOUT the existing dev data — this deletes the database of
      every checkout on this machine:
        ./run.sh down && docker volume rm $PGDATA_VOLUME"

  else
    [ -f "$EXAMPLE_FILE" ] || die "docker/.env.example not found — is this a complete checkout?"
    command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate docker/.env"
    uid="$(id -u)"
    gid="$(id -g)"

    tmp="$(mktemp "$DOCKER_DIR/.env.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    {
      printf '# Local dev stack configuration, generated from .env.example by\n'
      printf '# docker/ensureEnv.sh on %s. Never commit this file.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      in_header=1
      while IFS= read -r line || [ -n "$line" ]; do
        # the template's leading comment block describes the template itself
        if [ "$in_header" = 1 ]; then
          case "$line" in
            '#'*) continue ;;
            *) in_header=0 ;;
          esac
        fi
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=${PLACEHOLDER}$ ]]; then
          name="${BASH_REMATCH[1]}"
          # a separate assignment, so a failing openssl can't slip through
          value="$(secret_for "$name")" || die "openssl failed to generate a value for $name"
          [ -n "$value" ] || die "openssl generated an empty value for $name"
          printf '%s=%s\n' "$name" "$value"
        elif [[ "$line" == BUILDER_UID=* ]]; then
          printf 'BUILDER_UID=%s\n' "$uid"
        elif [[ "$line" == BUILDER_GID=* ]]; then
          printf 'BUILDER_GID=%s\n' "$gid"
        else
          printf '%s\n' "$line"
        fi
      done < "$EXAMPLE_FILE"
    } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
    trap - EXIT
    note "Created docker/.env from docker/.env.example with fresh random secrets."
  fi
fi

if [ -f "$EXAMPLE_FILE" ]; then
  missing="$(LC_ALL=C comm -23 <(env_vars "$EXAMPLE_FILE") <(env_vars "$ENV_FILE"))"
  if [ -n "$missing" ]; then
    warn "docker/.env lacks variables that docker/.env.example defines:"
    printf '    %s\n' $missing >&2
    note "  Copy them (with their comments) from docker/.env.example — docker/.env is never changed automatically."
  fi
else
  warn "docker/.env.example not found, so docker/.env cannot be checked for missing variables."
fi

if grep -qE "^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=${PLACEHOLDER}[[:space:]]*\$" "$ENV_FILE"; then
  warn "docker/.env still contains '${PLACEHOLDER}' placeholders (copied by hand?).
  Replace each with a random value (openssl rand -hex 24) before the stack is first started,
  or delete docker/.env and let ./run.sh generate it."
fi

# srv/util/captcha.ts: with CAPTCHA_PROVIDER empty, ANY reCAPTCHA secret
# selects reCAPTCHA — a placeholder one makes every signup fail
captcha_provider="$(env_get CAPTCHA_PROVIDER | tr -d '[:space:]')"
recaptcha_key="$(env_get GOOGLE_RECAPTCHA_SECRET_KEY)"
if [ -z "$captcha_provider" ] && [ -n "$recaptcha_key" ]; then
  case "$recaptcha_key" in
    your-key | placeholder)
      warn "GOOGLE_RECAPTCHA_SECRET_KEY is the placeholder '$recaptcha_key' and CAPTCHA_PROVIDER is empty,
  so the backend selects reCAPTCHA with a bogus key and every signup fails.
  Set CAPTCHA_PROVIDER=altcha (self-hosted captcha, no key needed) or empty the key." ;;
    *)
      warn "CAPTCHA_PROVIDER is empty, so the GOOGLE_RECAPTCHA_SECRET_KEY in docker/.env selects reCAPTCHA.
  Set CAPTCHA_PROVIDER=recaptcha to make that explicit (silences this), or CAPTCHA_PROVIDER=altcha." ;;
  esac
fi

s3_secret="$(env_get S3_SECRET)"

if [ ! -f "$S3_CONFIG" ]; then
  if [ -z "$s3_secret" ] || [ "$s3_secret" = "$PLACEHOLDER" ]; then
    die "S3_SECRET is not set in docker/.env, so docker/s3_config/s3.json cannot be generated"
  fi
  case "$s3_secret" in
    *'"'* | *'\'*) die "S3_SECRET in docker/.env must not contain quotes or backslashes" ;;
  esac
  mkdir -p "$S3_DIR"
  s3_tmp="$(mktemp "$S3_DIR/.s3.json.XXXXXX")"
  trap 'rm -f "$s3_tmp"' EXIT
  # the anonymous identity makes uploaded media publicly readable; cgadmin is
  # the key the backend (srv/repositories/files.ts) signs with
  cat > "$s3_tmp" <<EOF
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
          "secretKey": "${s3_secret}"
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
  # world-readable on purpose: seaweed reads the bind-mounted file as its own
  # uid 1000, which need not be the owner (another host user, rootless docker,
  # podman). Dev-only secret of a service no port is published for.
  chmod 644 "$s3_tmp"
  mv "$s3_tmp" "$S3_CONFIG"
  trap - EXIT
  note "Created docker/s3_config/s3.json with the S3_SECRET from docker/.env."
else
  s3_config_secret="$({ grep -oE '"secretKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$S3_CONFIG" || true; } | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
  if [ -z "$s3_config_secret" ]; then
    warn "docker/s3_config/s3.json has no secretKey (empty or truncated?) — seaweed will reject
  every upload. Delete it and run this command again to regenerate it from docker/.env."
  elif [ "$s3_config_secret" != "$s3_secret" ]; then
    warn "the secretKey in docker/s3_config/s3.json differs from S3_SECRET in docker/.env —
  media uploads will fail. If you just put an older docker/.env back, delete s3.json and run
  this command again to regenerate it from docker/.env; otherwise make the two match."
  fi
fi
