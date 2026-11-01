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
mkdir -p caddy/dist && rm -rf caddy/dist/* && \
cd ../docker && \
docker_compose build cg-builder
checkError


docker_compose run --rm cg-builder yarn install --immutable && \
buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64) && \
sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts && \
docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod cg-builder \
  bash -c "yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite" && \
rsync -a ../build/* caddy/dist/ && \
docker_compose up -d --no-deps --build caddy
checkError
