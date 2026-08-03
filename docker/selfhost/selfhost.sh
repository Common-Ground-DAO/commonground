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

# Optional services live behind compose profiles. Both default to ON, so an
# .env.selfhost written before these switches existed keeps every service.
compose_profiles() {
  local profiles=""
  if [ "${CG_ENABLE_CALLS:-true}" != "false" ]; then
    profiles="calls"
  fi
  if [ "${CG_ENABLE_BLOCKCHAIN:-true}" != "false" ]; then
    profiles="${profiles:+$profiles,}blockchain"
  fi
  echo "$profiles"
}

docker_compose() {
  local profiles
  profiles="$(compose_profiles)"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_PROFILES="$profiles" docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml "$@"
  elif docker-compose version >/dev/null 2>&1; then
    COMPOSE_PROFILES="$profiles" docker-compose --env-file .env.selfhost -f docker-compose.selfhost.yml "$@"
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

  # Type-check and lint are separate steps now: the webpack build ran
  # ForkTsChecker + ESLintPlugin inline and a Vite build does neither.
  # Sourcemaps ship on every path — the app is AGPL, the old no-sourcemap
  # policy dated from the closed-source era.
  printf "\n---\n--- Type-checking, linting and building the frontend\n---\n"
  docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=4096" -e DEPLOYMENT=prod cg-builder \
    bash -c "yarn typecheck && yarn lint && yarn build && yarn check:html-rewrite"
  checkError
  rm -rf nginx/dist/* && rsync -a ../build/* nginx/dist/
  checkError

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
    # --remove-orphans cleans up containers of services that are no longer
    # part of the stack — e.g. after switching a profile off, or after the
    # three redis instances were merged into one
    docker_compose up -d --remove-orphans
    docker_compose ps
    ;;
  down)
    docker_compose down --remove-orphans
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
    docker_compose up -d --remove-orphans
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
    printf "  update   git pull + rebuild + restart\n\n"
    printf "Optional services (set in .env.selfhost, both default to true):\n"
    printf "  CG_ENABLE_CALLS=false       do not run mediasoup (no voice/video calls)\n"
    printf "  CG_ENABLE_BLOCKCHAIN=false  do not run onchain (no token gating/indexing)\n"
    exit 1
    ;;
esac
