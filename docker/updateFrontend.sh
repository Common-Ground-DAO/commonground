#!/bin/bash
cd ${0%/*}

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

printf "\n---\n--- Building frontend and nginx image\n---\n"
rm -rf nginx/dist/* && \
cd ../docker && \
docker_compose build cg-builder
checkError

if [ ! -d ../.yarn ]
then
  printf "\n---\n--- Missing .yarn directory, setting yarn to version 4.1.0 \n---\n"
  docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' .yarnrc.yml && yarn set version 4.1.0"
  checkError
fi

docker_compose run --rm cg-builder yarn && \
buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64) && \
sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts && \
docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod -e GENERATE_SOURCEMAP=true -e IMAGE_INLINE_SIZE_LIMIT=5000 cg-builder yarn craco --openssl-legacy-provider build && \
rsync -a ../build/* nginx/dist/ && \
docker_compose up -d --no-deps --build nginx
checkError

printf "\n---\n--- Build finished, restarting\n---\n"
docker_compose start nginx
checkError
