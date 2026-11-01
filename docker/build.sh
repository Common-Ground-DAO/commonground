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
docker_compose down --remove-orphans
docker_compose build cg-builder

# Browser-facing certificates come from caddy's local CA (created on its
# first start); only the internal caddy->mediasoup hop needs one of its own
mediasoup/ensureInternalCert.sh
checkError

printf "\n---\n--- Building frontend and caddy image\n---\n"
rm -rf backend/dist/* && \
mkdir -p caddy/dist && rm -rf caddy/dist/* && \
docker_compose run --rm cg-builder yarn install --immutable
checkError

buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64)

if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
else
  sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
fi
checkError

# Type-check and lint are separate steps now: the webpack build used to run
# ForkTsChecker + ESLintPlugin inline, and a Vite build does neither, so
# without these two a type or lint error would ship silently.
# `--max-old-space-size` is still needed — a plain `vite build` OOMs at 2048 MB
# and peaks at ~4 GB container RSS (≈3.9 GiB docker stats, ≈4.1 GiB cgroup peak;
# Node 24 + Vite 7); 4096 caps only the V8 heap and is the measured floor with
# thin headroom.
docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod cg-builder \
  bash -c "yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite" && \
rsync -a ../build/* caddy/dist/
checkError

docker_compose build --no-cache caddy
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
rsync -aL --exclude=node_modules --exclude=.yarn ../srv/ backend/dist/ && \
cp ../build/index.html backend/dist/ && \
docker build --tag commonground/backend_stage_0 -f backend/Dockerfile_dev_stage_0 ./backend/ && \
docker_compose build --no-cache api
checkError

printf "\n---\n--- Setting up database\n---\n"
docker_compose build --no-cache db && \
docker_compose up -d db && \
sleep 5
checkError

printf "\n---\n--- Build finished, starting server\n---\n"
docker_compose up -d
checkError

printf "\n---\n--- Deploying contracts\n---\n"
sleep 3
docker_compose run --rm -T cg-builder bash -c "cd contracts && yarn install --immutable && npx --no hardhat run --network cgstack scripts/deploy.ts"

./logs.sh
