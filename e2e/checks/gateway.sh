#!/bin/bash
# Server-side checks of the gateway of a moved instance (docs/auth-identity
# §12) against the disposable e2e instance started with a gateway:
#
#   E2E_GATEWAY=1 e2e/instance.sh up
#   e2e/run.sh --instance --flow gateway     # its account is used here
#   e2e/checks/gateway.sh
#
# 1. the gateway allowlist spec (srv/tests/gatewayAllowlist.spec.ts) runs in
#    the instance's backend image and writes the complete route list of the
#    deployed code with the gateway's decision per route;
# 2. gateway-check.mjs (in the backend image, on the instance's network)
#    sends every route of that list to the live gateway api, every socket
#    event of the deployed wsapi to the live gateway wsapi, checks the origin
#    rules of both instances, signs in on the gateway with a wallet and with
#    a CG ID passkey (a credential inserted here for the gateway's CG ID
#    domain), and redeems a transfer link on the instance;
# 3. the Valkey keys of the two instances are disjoint;
# 4. startup refusals: the singleton processes in gateway mode, a missing
#    session secret, a bad pool size, a gateway api without the shared
#    mail-limit secret or with a transfer target under its own domain.
#
# Uses the instance's compose project (E2E_PROJECT, default cg-e2e) only — it
# inserts a wallet and a passkey into its database. Never run it against the
# dev stack or a real instance. Output in $CHECK_OUT (default
# e2e/results/gateway-<timestamp>/). Exit code: 0 all passed, 1 a check
# failed, 2 the check could not start.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "$0")/.." && pwd)"
P="${E2E_PROJECT:-cg-e2e}"
PREFIX="${E2E_IMAGE_PREFIX:-cg-e2e}"
DOMAIN="${E2E_DOMAIN:-cg-e2e.test}"
ENV_FILE="$E2E_DIR/.instance/env"
if [ "$P" = "docker" ] || [ "$P" = "cg-selfhost" ]; then
  echo "E2E_PROJECT=$P is the dev stack or a real self-host instance; this check only runs against a disposable e2e instance." >&2
  exit 2
fi
for service in db redis api wsapi gateway-api gateway-wsapi; do
  if [ -z "$(docker ps -q --filter "name=^${P}-${service}-1\$")" ]; then
    echo "container ${P}-${service}-1 is not running — start the instance with E2E_GATEWAY=1 e2e/instance.sh up" >&2
    exit 2
  fi
done
GW_DOMAIN="$(sed -n 's/^CG_GATEWAY_DOMAIN=//p' "$ENV_FILE")"
GW_ID_DOMAIN="$(sed -n 's/^CG_GATEWAY_ID_DOMAIN=//p' "$ENV_FILE")"
OUT="${CHECK_OUT:-$E2E_DIR/results/gateway-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
LOG="$OUT/gateway.log"
: > "$LOG"
FAILS=0
NETWORK="${P}_cryptogram"
IMAGE="$PREFIX/backend"

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }
ok() { log "OK   $*"; }
bad() { log "FAIL $*"; FAILS=$((FAILS + 1)); }
sql() { docker exec -i "$P-db-1" psql -U postgres -d cryptogram -v ON_ERROR_STOP=1 -qAt -c "$1"; }
in_image() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp "$@"; }

# --- 1. the complete route list of the deployed code --------------------------
log "route list: the allowlist spec in $IMAGE"
if in_image -e GATEWAY_ROUTE_LIST_OUT=/out/routes.tsv -v "$OUT:/out" -w /dist "$IMAGE" \
     node node_modules/jest/bin/jest.js tests/gatewayAllowlist.spec.ts > "$OUT/allowlist-spec.log" 2>&1; then
  ok "allowlist spec passes in the deployed image ($(wc -l < "$OUT/routes.tsv") routes, $(grep -c '^ALLOW' "$OUT/routes.tsv") allowlisted)"
else
  bad "allowlist spec in the deployed image (see allowlist-spec.log)"
fi

# --- fixtures: the gateway flow's account, a wallet and a CG ID passkey -------
USER_ID="$(sql "SELECT id FROM users WHERE email LIKE 'gwuser\\_%@example.org' ORDER BY \"createdAt\" DESC LIMIT 1")"
if [ -z "$USER_ID" ]; then
  echo "no account of the gateway flow — run e2e/run.sh --instance --flow gateway first" >&2
  exit 2
fi
FIXTURES="$(in_image -v "$E2E_DIR:/dist/e2e:ro" -w /dist "$IMAGE" node /dist/e2e/checks/gateway-fixtures.mjs)" || { echo "fixtures failed" >&2; exit 2; }
fx() { printf '%s' "$FIXTURES" | node_json "$1"; }
node_json() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
WALLET_KEY="$(fx walletKey)"
WALLET_ADDRESS="$(fx walletAddress)"
sql "INSERT INTO wallets (\"userId\", type, \"walletIdentifier\", \"loginEnabled\", \"signatureData\")
     VALUES ('$USER_ID', 'evm', '$WALLET_ADDRESS', true, '{}'::jsonb)" >/dev/null && ok "fixture: sign-in wallet $WALLET_ADDRESS"
sql "INSERT INTO passkeys (\"userId\", \"rpId\", origin, name, data, counter)
     VALUES ('$USER_ID', '$GW_ID_DOMAIN', 'https://$GW_ID_DOMAIN', 'gateway check', '$(fx passkeyData)'::jsonb, 0)" >/dev/null \
  && ok "fixture: CG ID passkey for rpId $GW_ID_DOMAIN"

# --- 2. the live checks ---------------------------------------------------------
log "live checks (gateway-check.mjs)"
in_image --network "$NETWORK" -v "$E2E_DIR:/dist/e2e:ro" -v "$OUT:/out:ro" -w /dist \
  -e GW_DOMAIN="$GW_DOMAIN" -e GW_ID_DOMAIN="$GW_ID_DOMAIN" -e MAIN_DOMAIN="$DOMAIN" \
  -e ROUTE_LIST=/out/routes.tsv -e USER_ID="$USER_ID" -e WALLET_KEY="$WALLET_KEY" \
  -e PASSKEY_KEY_PEM="$(fx passkeyKeyPem)" -e PASSKEY_CREDENTIAL_ID="$(fx passkeyCredentialId)" -e PASSKEY_USER_HANDLE="$(fx passkeyUserHandle)" \
  "$IMAGE" node /dist/e2e/checks/gateway-check.mjs 2>&1 | tee "$OUT/live.log" | tee -a "$LOG" >/dev/null
LIVE_FAILS="$(grep -c '^FAIL' "$OUT/live.log")"
if grep -q '^ALL CHECKS PASSED' "$OUT/live.log"; then
  ok "live checks: $(grep -c '^OK' "$OUT/live.log") passed"
else
  bad "live checks: $LIVE_FAILS failed (live.log)"
fi

# --- LUKSO / blockchain: the gateway api follows the instance's setting ---------
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$P-$1-1" | sed -n "s/^$2=//p"; }
if [ "$(env_of api CG_ENABLE_BLOCKCHAIN)" = "$(env_of gateway-api CG_ENABLE_BLOCKCHAIN)" ]; then
  ok "blockchain: gateway-api CG_ENABLE_BLOCKCHAIN=$(env_of gateway-api CG_ENABLE_BLOCKCHAIN), as the instance's api"
else
  bad "blockchain: gateway-api CG_ENABLE_BLOCKCHAIN=$(env_of gateway-api CG_ENABLE_BLOCKCHAIN), api $(env_of api CG_ENABLE_BLOCKCHAIN)"
fi
if [ -n "$(env_of api CG_MAIL_LIMIT_SECRET)" ] && [ "$(env_of api CG_MAIL_LIMIT_SECRET)" = "$(env_of gateway-api CG_MAIL_LIMIT_SECRET)" ] \
   && [ "$(env_of api REDIS_SECRET)" != "$(env_of gateway-api REDIS_SECRET)" ]; then
  ok "mail limits: api and gateway-api share CG_MAIL_LIMIT_SECRET, their session secrets differ"
else
  bad "mail limits: CG_MAIL_LIMIT_SECRET not shared (or the session secrets are equal)"
fi

# --- 3. Valkey keys ---------------------------------------------------------------
keys() { docker exec "$P-redis-1" sh -c "valkey-cli -a \"\$REDISCLI_AUTH\" --no-auth-warning --scan --pattern '$1'" 2>/dev/null; }
keys 'gateway:*' | sed -E 's/^(gateway:[a-z0-9-]+)[:#].*/\1/; s/^(gateway:sess-gen-copied)$/\1/' | sort | uniq -c > "$OUT/gateway-key-families.txt"
keys '*' | grep -v '^gateway:' | sed -E 's/^([a-z0-9-]+)[:#].*/\1/' | sort | uniq -c > "$OUT/main-key-families.txt"
if grep -q 'gateway:sess$' "$OUT/gateway-key-families.txt" && grep -q 'gateway:sess-user$' "$OUT/gateway-key-families.txt"; then
  ok "valkey: the gateway's sessions and session index live under gateway: ($(tr -s ' ' < "$OUT/gateway-key-families.txt" | paste -sd ','))"
else
  bad "valkey: no gateway:sess / gateway:sess-user keys"
fi
GW_SIDS="$(keys 'gateway:sess:*' | sed 's/^gateway:sess://')"
OVERLAP=0
for sid in $GW_SIDS; do
  if [ -n "$(keys "sess:$sid")" ]; then OVERLAP=$((OVERLAP + 1)); fi
done
[ "$OVERLAP" = 0 ] && ok "valkey: no gateway session id exists in the instance's store" || bad "valkey: $OVERLAP gateway session ids also in sess:"

# --- 4. startup refusals ----------------------------------------------------------
startup() { # <expected text> <command...>: the process must exit non-zero with the text (BASE_URL: $BASE, default the instance's)
  local expect="$1"; shift
  local output
  output="$(timeout 90 docker run --rm --network "$NETWORK" -e BASE_URL="${BASE:-https://$DOMAIN}" -e DEPLOYMENT=prod \
    -e REDIS_PASSWORD="$(sed -n 's/^REDIS_PASSWORD=//p' "$ENV_FILE")" "$@" 2>&1)"
  local code=$?
  if [ "$code" != 0 ] && [ "$code" != 124 ] && printf '%s' "$output" | grep -q "$expect"; then
    ok "startup: exits ($code) with \"$expect\": $*"
  else
    bad "startup: expected an exit with \"$expect\" (exit $code): $* — $(printf '%s' "$output" | tail -2 | tr '\n' ' ')"
  fi
}
for process in jobs onchain memberlist mediasoup migrateDb; do
  startup "runs only for the main instance" -e CG_GATEWAY=true -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 "$IMAGE" node "/dist/$process.js"
done
startup "REDIS_SECRET" -e REDIS_SECRET= "$IMAGE" node /dist/api.js
startup "REDIS_SECRET" -e REDIS_SECRET= "$IMAGE" node /dist/wsapi.js
startup "REDIS_SECRET" -e REDIS_SECRET= "$IMAGE" node /dist/jobs.js
startup "PG_POOL_MAX" -e REDIS_SECRET=a-long-enough-secret-123 -e PG_POOL_MAX=0 "$IMAGE" node /dist/api.js
startup "CG_LEGACY_CGID=true" -e CG_GATEWAY=true -e REDIS_SECRET=a-long-enough-secret-123 -e TRANSFER_TARGET_URL="https://$DOMAIN" "$IMAGE" node /dist/api.js
BASE="https://$GW_DOMAIN" startup "CG_MAIL_LIMIT_SECRET" -e CG_GATEWAY=true -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 -e TRANSFER_TARGET_URL="https://$DOMAIN" -e CGID_URL="https://$GW_ID_DOMAIN" "$IMAGE" node /dist/api.js
startup "CG_LEGACY_CGID=true" -e CG_GATEWAY=true -e REDIS_SECRET=a-long-enough-secret-123 "$IMAGE" node /dist/wsapi.js
# a gateway never runs as a dev stack; the gateway's settings without CG_GATEWAY=true are refused (api and wsapi)
BASE="https://$GW_DOMAIN" startup "DEPLOYMENT=dev" -e DEPLOYMENT=dev -e CG_GATEWAY=true -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 -e CG_MAIL_LIMIT_SECRET=a-shared-mail-limit-secret -e TRANSFER_TARGET_URL="https://$DOMAIN" -e CGID_URL="https://$GW_ID_DOMAIN" "$IMAGE" node /dist/api.js
BASE="https://$GW_DOMAIN" startup "CG_LEGACY_CGID=true is for a gateway only" -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 -e CGID_URL="https://$GW_ID_DOMAIN" "$IMAGE" node /dist/wsapi.js
BASE="https://$GW_DOMAIN" startup "CG_LEGACY_CGID=true is for a gateway only" -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 -e TRANSFER_TARGET_URL="https://$DOMAIN" -e CGID_URL="https://$GW_ID_DOMAIN" "$IMAGE" node /dist/api.js
startup "TRANSFER_TARGET_URL is for a gateway only" -e REDIS_SECRET=a-long-enough-secret-123 -e TRANSFER_TARGET_URL="https://$DOMAIN" "$IMAGE" node /dist/api.js
# the old domain's cookies (connect.sid of the old instance too) reach every host under it: no instance on or under it
BASE="https://$GW_DOMAIN" startup "must not be the gateway's domain or lie under it" -e CG_GATEWAY=true -e CG_LEGACY_CGID=true -e REDIS_SECRET=a-long-enough-secret-123 -e CG_MAIL_LIMIT_SECRET=a-shared-mail-limit-secret -e TRANSFER_TARGET_URL="https://new.$GW_DOMAIN" -e CGID_URL="https://$GW_ID_DOMAIN" "$IMAGE" node /dist/api.js

log "done: $FAILS failed"
[ "$FAILS" = 0 ] && exit 0 || exit 1
