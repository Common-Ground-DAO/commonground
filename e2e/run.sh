#!/bin/bash
# Runs the end-to-end browser suite in a container — nobody needs a local
# Chrome: the backend image ships a pinned Chrome for Testing and puppeteer
# (docker/backend/fetch_chrome.sh), and the suite has no dependencies of its
# own. See e2e/README.md.
#
#   e2e/run.sh --instance [suite options]          the disposable instance (e2e/instance.sh up)
#   e2e/run.sh --url https://cg.test --ca /abs/path/root.crt [--add-host cg.test:192.0.2.10] [suite options]
#
# Runner options (everything else goes to the suite, see --help):
#   --instance            target the disposable instance: its URL, CA, network and mailpit
#   --url <url>           instance under test
#   --ca <file>           PEM root CA of the instance's certificate (self-host "tls internal")
#   --network <name>      docker network for the runner container (default: bridge)
#   --add-host <host:ip>  /etc/hosts entry in the runner (e.g. a LAN test instance); repeatable
#   --image <image>       runner image (default: $E2E_IMAGE, else cg-e2e/backend, else cryptogram/backend)
#   --out <dir>           results directory on the host (default: e2e/results/<timestamp>)
#
# Exit code: that of the suite (0 pass, 1 a flow failed, 2 setup error).
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${E2E_PROJECT:-cg-e2e}"
PREFIX="${E2E_IMAGE_PREFIX:-cg-e2e}"
DOMAIN="${E2E_DOMAIN:-cg-e2e.test}"

image="${E2E_IMAGE:-}"
network=""
ca=""
out=""
docker_args=()
suite_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --instance)
      network="${PROJECT}_cryptogram"
      "$E2E_DIR/instance.sh" ca >/dev/null
      ca="$E2E_DIR/.instance/root.crt"
      suite_args+=(--url "https://${DOMAIN}" --mailpit "http://mailpit:8025")
      # the instance's gateway, if it runs one (E2E_GATEWAY=1 e2e/instance.sh up)
      if grep -q '^CG_ENABLE_GATEWAY=true$' "$E2E_DIR/.instance/env"; then
        suite_args+=(--gateway-url "https://app.${DOMAIN}")
      fi
      # the session store, for the reload flow's session-expired mode; passed
      # through the environment (docker run -e NAME, no value on any command
      # line), so the password never shows up in a process list
      redis_password="$(grep '^REDIS_PASSWORD=' "$E2E_DIR/.instance/env" | cut -d= -f2)"
      export E2E_REDIS_URL="redis://:${redis_password}@redis:6379"
      docker_args+=(-e E2E_REDIS_URL)
      shift ;;
    --ca) ca="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --network) network="$2"; shift 2 ;;
    --add-host) docker_args+=(--add-host "$2"); shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --out) mkdir -p "$2"; out="$(cd "$2" && pwd)"; shift 2 ;;
    *) suite_args+=("$1"); shift ;;
  esac
done

if [ -z "$image" ]; then
  if docker image inspect "$PREFIX/backend" >/dev/null 2>&1; then
    image="$PREFIX/backend"
  else
    image="cryptogram/backend"
  fi
fi
listing=false
for arg in "${suite_args[@]}"; do
  case "$arg" in --list|--help|-h) listing=true ;; esac
done
if [ -z "$out" ] && [ "$listing" = true ]; then
  out="$(mktemp -d)"
  trap 'rm -rf "$out"' EXIT
elif [ -z "$out" ]; then
  out="$E2E_DIR/results/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out"
  ln -sfn "$(basename "$out")" "$E2E_DIR/results/latest"
fi
if [ -n "$ca" ]; then
  [ -f "$ca" ] || { echo "CA file $ca not found" >&2; exit 2; }
  docker_args+=(-v "$ca:/run/e2e/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/run/e2e/ca.crt)
  suite_args+=(--ca /run/e2e/ca.crt)
fi
if [ -n "$network" ]; then
  docker_args+=(--network "$network")
fi

# /dist/e2e: inside /dist, so the suite resolves puppeteer from the image's
# /dist/node_modules. Runs as the calling user, so results stay owned by them.
[ "$listing" = true ] || echo "results: $out"
docker run --rm --init \
  --name "e2e-runner-$$" \
  --shm-size=1g \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$E2E_DIR:/dist/e2e:ro" \
  -v "$out:/results" \
  -w /dist/e2e \
  "${docker_args[@]}" \
  "$image" node /dist/e2e/src/main.ts --out /results "${suite_args[@]}"
