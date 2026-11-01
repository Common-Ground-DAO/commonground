#!/bin/bash
cd ${0%/*}
# creates docker/.env from docker/.env.example on first use, warns about
# variables the local file lacks; the marker spares the scripts called below
# from repeating that
./docker/ensureEnv.sh || exit 1
export CG_ENV_ENSURED=1
source ./docker/.env

# This script is only meant to be used in dev environment, since it
# will generate sourcemaps in the build.

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

cd docker

if [ "$1" = "start" ]
then
  # Vite dev server. Host and port come from vite.config.ts, not from env:
  # port 3000 is load-bearing, because the service-worker registration manager
  # disables itself on that port (src/data/appstate/serviceWorker.ts).
  docker_compose run --rm -p $EXTERNAL_LISTEN_IP:3000:3000 -e DEPLOYMENT=dev cg-builder yarn dev

elif [ "$1" = "start_https" ]
then
  # Voice/video calls need a secure context, which is the whole point of this
  # target. Vite serves plain HTTP inside the stack network; the vite-tls
  # service (Caddy, docker/caddy/Caddyfile.vite) terminates TLS on port 3000
  # with a certificate from the dev stack's local CA — the same CA as the
  # caddy service on :8001/:4443 (trust it once: ./run.sh export_ca). The
  # browser still sees port 3000, which the service-worker manager relies on.
  # vite-tls waits for a healthy caddy (CA created), starting the stack if
  # it is not up yet.
  docker_compose --profile vite-tls up -d vite-tls || exit 1
  trap 'docker_compose --profile vite-tls rm -sf vite-tls >/dev/null 2>&1' EXIT
  # --use-aliases: vite-tls reaches the dev server as cg-builder:3000
  docker_compose run --rm --use-aliases -e DEPLOYMENT=dev cg-builder yarn dev

elif [ "$1" = "export_ca" ]
then
  # The root certificate of caddy's local CA (in the caddy-data volume, made
  # on caddy's first start). Import it into your browser / OS trust store as
  # a certificate authority to get rid of the warnings on https://localhost:8001,
  # :4443 and :3000 (start_https). Only the certificate — the CA key stays in
  # the volume. (Read through the stock-image vite-tls service, which mounts
  # the same volume, so this works before the caddy image was ever built.)
  docker_compose --profile vite-tls run --rm --no-deps -T --entrypoint cat vite-tls /data/caddy/pki/authorities/local/root.crt > caddy-local-root.crt.tmp 2>/dev/null
  if [ $? -ne 0 ] || [ ! -s caddy-local-root.crt.tmp ]; then
    rm -f caddy-local-root.crt.tmp
    printf "\nNo local CA yet — start the stack once (./run.sh up), then run this again.\n"
    exit 1
  fi
  mv caddy-local-root.crt.tmp caddy-local-root.crt
  printf "Wrote docker/caddy-local-root.crt — import it as a trusted certificate authority.\n"

elif [ "$1" = "build_full" ]
then
  ./build.sh

elif [ "$1" = "update_backend" ]
then
  ./updateBackend.sh

elif [ "$1" = "update_frontend" ]
then
  ./updateFrontend.sh

elif [ "$1" = "up" ]
then
  # --remove-orphans cleans up containers of services that are no longer part
  # of the stack — e.g. after the three seaweedfs containers were merged into
  # the single `seaweed` service
  mediasoup/ensureInternalCert.sh || exit 1
  docker_compose up -d --remove-orphans && docker_compose logs -f

elif [ "$1" = "down" ]
then
  docker_compose down --remove-orphans

elif [ "$1" = "compose" ]
then
  docker_compose "${@:2}"

elif [ "$1" = "shell" ]
then
  docker_compose run --rm cg-builder bash

elif [ "$1" = "make_migration" ]
then
  ../tools/makeMigration.sh $2

elif [ "$1" = "make_empty_migration" ]
then
  ../tools/makeEmptyMigration.sh $2

else
  printf "Usage: \e[1m./run.sh <command>\e[0m\nList of available commands:\n\n"
  printf "\e[1mstart\e[0m\nStart the development server on http://localhost:3000\n\n"
  printf "\e[1mstart_https\e[0m\nStart the development server on https://localhost:3000 (TLS from the stack's local CA)\n\n"
  printf "\e[1mexport_ca\e[0m\nWrite the root certificate of the stack's local CA to docker/caddy-local-root.crt, for importing into a browser.\n\n"
  printf "\e[1mbuild_full\e[0m\nBuild the stack including backend and frontend. Will start the stack afterwards.\n\n"
  printf "\e[1mupdate_backend\e[0m\nUpdate the backend only and rebuild the stack. Will update the stack afterwards.\n\n"
  printf "\e[1mupdate_frontend\e[0m\nUpdate the frontend only and rebuild the stack. Will update the stack afterwards.\n\n"
  printf "\e[1mup\e[0m\nStart the stack in detached mode and show logs.\n\n"
  printf "\e[1mdown\e[0m\nStop the stack.\n\n"
  printf "\e[1mcompose <arg_1> <arg_2> ...\e[0m\nRun docker compose commands. For example, to run 'docker compose ps', use './run.sh compose ps'.\n\n"
  printf "\e[1mshell\e[0m\nStart a shell in the cg-builder container (node) and mount the project directory into it. It can then be used to run yarn commands.\n\n"
  printf "\e[1mmake_migration <migration_name>\e[0m\nCreate a new migration with the given name.\n\n"
  printf "\e[1mmake_empty_migration <migration_name>\e[0m\nCreate a new empty migration with the given name.\n\n\n"

  exit 1
fi