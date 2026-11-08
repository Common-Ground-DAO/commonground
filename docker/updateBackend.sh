#!/bin/bash
cd ${0%/*}
./ensureEnv.sh || exit 1
export CG_ENV_ENSURED=1
source .env

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.yml "$@"
  elif docker-compose version >/dev/null 2>&1; then
    docker-compose -f docker-compose.yml "$@"
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

printf "\n---\n--- Stopping containers & cleaning build environment\n---\n"
# caddy keeps running: it resolves the backend containers per request
docker_compose stop wsapi api onchain mediasoup memberlist hardhat job-runner
docker_compose rm -f
docker_compose build cg-builder

# the internal caddy->mediasoup certificate (browser-facing ones come from
# caddy's local CA)
mediasoup/ensureInternalCert.sh
checkError

if [ ! -f vapid_keys.json ];
then
  printf "Generating vapid_keys.json for web push...\n"
  if [ ! -d srv/node_modules/web-push ]
  then
    docker_compose run --rm -T cg-builder bash -c "cd srv && yarn install --immutable"
  fi
  docker_compose run --rm -T cg-builder bash -c "cd srv && npx --no web-push generate-vapid-keys --json > ../docker/vapid_keys.json"
fi

printf "\n---\n--- Building backend\n---\n"
rm -rf backend/dist/{*,.??*} && \
rsync -aL --exclude=node_modules --exclude=.yarn ../srv/ backend/dist/
checkError

if [ -f ../build/index.html ]
then
  cp ../build/index.html backend/dist/
  checkError
fi

# the backend carries the build ID of the frontend Caddy serves
# (vite/buildId.ts), so the two stay equal
buildId=dev
if [ -f caddy/dist/build-id.txt ]
then
  buildId="$(cat caddy/dist/build-id.txt)"
fi

docker build --tag commonground/backend_stage_0 -f backend/Dockerfile_dev_stage_0 ./backend/ && \
docker_compose build --no-cache --build-arg CG_BUILD_ID="$buildId" api
checkError

printf "\n---\n--- Build finished, starting server\n---\n"
docker_compose up -d --remove-orphans
checkError

cd ../docker

printf "\n---\n--- Deploying contracts\n---\n"
sleep 3
docker_compose run --rm -T cg-builder bash -c "cd contracts && yarn install --immutable && npx --no hardhat run --network cgstack scripts/deploy.ts"

./logs.sh
