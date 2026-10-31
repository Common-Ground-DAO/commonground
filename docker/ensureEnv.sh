#!/bin/bash
# Makes sure the dev stack configuration exists before anything reads it:
#   - docker/.env missing: created from docker/.env.example, every
#     "generated-on-first-run" value replaced with a fresh random secret and
#     BUILDER_UID/BUILDER_GID set to the current user
#   - docker/s3_config/s3.json missing: generated with the S3_SECRET from
#     docker/.env (SeaweedFS and the backend must agree on it)
#   - warns (never fails) when docker/.env lacks variables that
#     docker/.env.example defines, still holds placeholder secrets, or when
#     s3.json's secret does not match S3_SECRET
# An existing docker/.env or s3.json is never modified.
#
# Called by run.sh, docker/build.sh, docker/updateBackend.sh, the tools/*.sh
# migration/test scripts and docker/nginx/certs/recreate_server_certs.sh.
# Safe to run any number of times.
set -euo pipefail

# run.sh runs this first and exports the marker, so the scripts it calls
# don't repeat the checks and warnings
if [ "${CG_ENV_ENSURED:-}" = "1" ]; then
  exit 0
fi

DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DOCKER_DIR/.env"
EXAMPLE_FILE="$DOCKER_DIR/.env.example"
S3_CONFIG="$DOCKER_DIR/s3_config/s3.json"
PLACEHOLDER="generated-on-first-run"

warn() { printf '\e[33mWarning:\e[0m %s\n' "$*" >&2; }
die() { printf '\e[31mError:\e[0m %s\n' "$*" >&2; exit 1; }

# names of the variables an env file assigns (commented-out lines don't count)
env_vars() {
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$1" | LC_ALL=C sort -u
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

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$EXAMPLE_FILE" ] || die "docker/.env.example not found — is this a complete checkout?"
  command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate docker/.env"

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
        printf '%s=%s\n' "$name" "$(secret_for "$name")"
      elif [[ "$line" == BUILDER_UID=* ]]; then
        printf 'BUILDER_UID=%s\n' "$(id -u)"
      elif [[ "$line" == BUILDER_GID=* ]]; then
        printf 'BUILDER_GID=%s\n' "$(id -g)"
      else
        printf '%s\n' "$line"
      fi
    done < "$EXAMPLE_FILE"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  trap - EXIT
  printf 'Created docker/.env from docker/.env.example with fresh random secrets.\n' >&2

  # postgres applies the passwords only when its data volume is initialized:
  # an existing dev database (an earlier checkout, or a docker/.env that a
  # pull deleted) still expects the old ones. Best effort — skipped silently
  # when docker isn't reachable.
  project="${COMPOSE_PROJECT_NAME:-$(basename "$DOCKER_DIR")}"
  if command -v docker >/dev/null 2>&1 && docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
    warn "a dev database volume (${project}_pgdata) already exists, but its passwords are not the
  ones just generated, so the backend will fail to log in. Either put your previous docker/.env
  back (before it was untracked, the committed one can be restored with
    git show \"\$(git log -1 --format=%H --diff-filter=D -- docker/.env)^:docker/.env\" > docker/.env
  if you never changed it), or delete the dev data with
    ./run.sh down && docker volume rm ${project}_pgdata"
  fi
fi

missing="$(LC_ALL=C comm -23 <(env_vars "$EXAMPLE_FILE") <(env_vars "$ENV_FILE"))"
if [ -n "$missing" ]; then
  warn "docker/.env lacks variables that docker/.env.example defines:"
  printf '    %s\n' $missing >&2
  printf '  Copy them (with their comments) from docker/.env.example — docker/.env is never changed automatically.\n' >&2
fi

if grep -qE "^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=${PLACEHOLDER}[[:space:]]*\$" "$ENV_FILE"; then
  warn "docker/.env still contains '${PLACEHOLDER}' placeholders (copied by hand?).
  Replace each with a random value (openssl rand -hex 24) before the stack is first started,
  or delete docker/.env and let ./run.sh generate it."
fi

# same view of the file that run.sh gets by sourcing it
s3_secret="$(set +eu; set -a; . "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${S3_SECRET:-}")"

if [ ! -f "$S3_CONFIG" ]; then
  if [ -z "$s3_secret" ] || [ "$s3_secret" = "$PLACEHOLDER" ]; then
    die "S3_SECRET is not set in docker/.env, so docker/s3_config/s3.json cannot be generated"
  fi
  case "$s3_secret" in
    *'"'* | *'\'*) die "S3_SECRET in docker/.env must not contain quotes or backslashes" ;;
  esac
  mkdir -p "$(dirname "$S3_CONFIG")"
  # the anonymous identity makes uploaded media publicly readable; cgadmin is
  # the key the backend (srv/repositories/files.ts) signs with
  cat > "$S3_CONFIG" <<EOF
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
  chmod 600 "$S3_CONFIG"
  printf 'Created docker/s3_config/s3.json with the S3_SECRET from docker/.env.\n' >&2
else
  s3_config_secret="$(grep -oE '"secretKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$S3_CONFIG" | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
  if [ "$s3_config_secret" != "$s3_secret" ]; then
    warn "the secretKey in docker/s3_config/s3.json differs from S3_SECRET in docker/.env —
  media uploads will fail. Make them match (or delete s3.json to regenerate it from docker/.env)."
  fi
fi
