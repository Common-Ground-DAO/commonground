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

cd ../docker
docker_compose run --rm -T cg-builder bash -C <<EOF
source docker/.env &&
cd srv &&
yarn install --immutable &&
yarn tsc --outDir __tmp --target es2021 --module commonjs --types node,jest --esModuleInterop true --experimentalDecorators true --emitDecoratorMetadata true --skipLibCheck true migrations/*.ts util/datasource.ts entities/*.ts common/types/models/*.d.ts common/types/api/*.d.ts common/types/events/*.d.ts common/types/common.d.ts types/*.d.ts > /dev/null &&
PG_SU_NAME=postgres DB_HOST=db PG_SU_PASSWORD=\$PG_SU_PASSWORD yarn tests
rm -rf ./__tmp
EOF