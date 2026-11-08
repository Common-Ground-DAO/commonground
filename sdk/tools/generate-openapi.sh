#!/bin/bash
# Regenerate docs/api/openapi.json from the server Joi validators, running the
# generator inside the backend image so it reads the compiled validators.
#
#   sdk/tools/generate-openapi.sh          # write docs/api/openapi.json
#   sdk/tools/generate-openapi.sh --check  # fail if the committed file is stale
#
# --check is the CI drift guard: regenerate to a temp file and diff.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
GEN="$REPO_ROOT/sdk/tools/generate-openapi.mjs"
OUT="$REPO_ROOT/docs/api/openapi.json"
IMAGE="${CG_BACKEND_IMAGE:-cryptogram/backend}"

generate() {
  # stderr carries a harmless "Deployment not found" notice; keep only stdout.
  docker run --rm -v "$GEN:/gen.mjs:ro" "$IMAGE" node /gen.mjs 2>/dev/null
}

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  generate > "$tmp"
  if ! diff -u "$OUT" "$tmp"; then
    echo "ERROR: docs/api/openapi.json is stale — run sdk/tools/generate-openapi.sh and commit." >&2
    exit 1
  fi
  echo "openapi.json is up to date."
else
  mkdir -p "$(dirname "$OUT")"
  generate > "$OUT"
  echo "wrote $OUT"
fi
