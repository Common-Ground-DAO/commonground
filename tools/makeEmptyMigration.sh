#!/bin/bash
cd ${0%/*}
# docker/.env is sourced inside the container below
../docker/ensureEnv.sh || exit 1

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

if [ "$1" = "" ]
then
  printf "Error: migration name missing\n"
  exit 1
fi

cd ../docker
docker_compose run --rm -T cg-builder bash -C <<EOF
source ./docker/.env && \
cd srv && \
yarn typeorm migration:create "migrations/$1"
EOF
