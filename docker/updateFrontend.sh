#!/bin/bash
cd ${0%/*}
# docker compose reads docker/.env
./ensureEnv.sh || exit 1
export CG_ENV_ENSURED=1

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif docker-compose version >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Neither docker compose nor docker-compose is available."
    exit 1
  fi
}

function checkError {
  if [ ! $? -eq 0 ]
  then
    printf "\n\nAn error occurred in the current build step\nExiting...\n"
    exit 1
  fi
}

printf "\n---\n--- Building frontend and caddy image\n---\n"
# Keep the build ID of the deployed frontend (read before caddy/dist is
# cleared): the running backend was built with it, and a new ID would make
# every client see a version mismatch until the next update_backend. Clients
# pick the new frontend up through the service worker's own update check.
# Without a deployed ID the build draws a new one (vite/buildId.ts).
buildId=""
if [ -f caddy/dist/build-id.txt ]
then
  buildId="$(cat caddy/dist/build-id.txt)"
fi
mkdir -p caddy/dist && rm -rf caddy/dist/* && \
cd ../docker && \
docker_compose build cg-builder
checkError


docker_compose run --rm cg-builder yarn install --immutable && \
docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod -e CG_BUILD_ID="$buildId" cg-builder \
  bash -c "yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite" && \
rsync -a ../build/* caddy/dist/ && \
docker_compose up -d --no-deps --build caddy
checkError
