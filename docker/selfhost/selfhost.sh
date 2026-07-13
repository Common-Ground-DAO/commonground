#!/bin/bash
# Build and operate a self-hosted Common Ground instance.
# Run docker/selfhost/init.sh once first — see docker/SELFHOST.md.
set -euo pipefail
cd "${0%/*}/.."   # docker/

if [ ! -f .env.selfhost ]; then
  echo "No .env.selfhost found. Run ./selfhost/init.sh <domain> <acme-email> first."
  exit 1
fi
source .env.selfhost

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml "$@"
  elif docker-compose version >/dev/null 2>&1; then
    docker-compose --env-file .env.selfhost -f docker-compose.selfhost.yml "$@"
  else
    echo "Neither docker compose nor docker-compose is available."
    exit 1
  fi
}

checkError() {
  if [ ! $? -eq 0 ]; then
    printf "\n\nAn error occurred in the current step\nExiting...\n"
    exit 1
  fi
}

build() {
  printf "\n---\n--- Building builder image\n---\n"
  docker_compose build cg-builder
  checkError

  if [ ! -d ../.yarn ]; then
    printf "\n---\n--- Missing .yarn directory, setting yarn to version 4.1.0\n---\n"
    docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' .yarnrc.yml && yarn set version 4.1.0"
    checkError
  fi

  if [ ! -d ../srv/.yarn ]; then
    printf "\n---\n--- Missing srv/.yarn directory, setting yarn to version 4.1.0\n---\n"
    docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' srv/.yarnrc.yml && cd srv && yarn set version 4.1.0"
    checkError
  fi

  printf "\n---\n--- Installing frontend dependencies\n---\n"
  docker_compose run --rm cg-builder yarn
  checkError

  buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
  else
    sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
  fi

  printf "\n---\n--- Building frontend (prod, no sourcemaps)\n---\n"
  docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod -e GENERATE_SOURCEMAP=false -e IMAGE_INLINE_SIZE_LIMIT=5000 cg-builder yarn craco --openssl-legacy-provider build
  checkError
  rm -rf nginx/dist/* && rsync -a ../build/* nginx/dist/
  checkError

  for f in nginx/dist/static/media/*.svg; do
    size=$(wc -c "$f" | awk '{print $1}')
    if [ "$size" -le "5000" ]; then
      rm "$f"
    fi
  done

  printf "\n---\n--- Building nginx image\n---\n"
  docker_compose build --no-cache nginx
  checkError

  if [ ! -f vapid_keys.json ]; then
    printf "\n---\n--- Generating vapid_keys.json for web push\n---\n"
    if [ ! -d ../srv/node_modules/web-push ]; then
      docker_compose run --rm -T cg-builder bash -c "cd srv && yarn"
    fi
    docker_compose run --rm -T cg-builder bash -c "cd srv && npx web-push generate-vapid-keys --json > ../docker/vapid_keys.json"
    checkError
  fi

  printf "\n---\n--- Building backend\n---\n"
  rm -rf backend/dist/{*,.??*} || true
  rsync -aL --exclude=node_modules --exclude=.yarn ../srv/ backend/dist/
  cp ../build/index.html backend/dist/
  docker build --tag commonground/backend_stage_0 -f backend/Dockerfile_dev_stage_0 ./backend/
  checkError
  docker_compose build --no-cache api
  checkError

  printf "\n---\n--- Building database image\n---\n"
  docker_compose build --no-cache db
  checkError

  printf "\n---\n--- Build finished. Start your instance with: ./selfhost/selfhost.sh up\n---\n"
}

case "${1:-}" in
  build)
    build
    ;;
  up)
    docker_compose up -d
    docker_compose ps
    ;;
  down)
    docker_compose down
    ;;
  logs)
    docker_compose logs -f "${@:2}"
    ;;
  ps)
    docker_compose ps
    ;;
  stats)
    docker stats --no-stream
    ;;
  compose)
    docker_compose "${@:2}"
    ;;
  update)
    git pull
    build
    docker_compose up -d
    ;;
  *)
    printf "Usage: ./selfhost.sh <command>\n\n"
    printf "  build    Build frontend, backend, nginx and db images\n"
    printf "  up       Start the instance (detached)\n"
    printf "  down     Stop the instance\n"
    printf "  logs     Follow logs (optionally: logs <service>)\n"
    printf "  ps       Show container status\n"
    printf "  stats    Show container resource usage\n"
    printf "  compose  Pass arguments to docker compose\n"
    printf "  update   git pull + rebuild + restart\n"
    exit 1
    ;;
esac
