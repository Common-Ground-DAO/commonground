#!/bin/bash
cd ${0%/*}
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
  # DEPLOYMENT=dev craco start
  docker_compose run --rm -p $EXTERNAL_LISTEN_IP:3000:3000 -e DEPLOYMENT=dev -e HOST=0.0.0.0 -e PORT=3000 cg-builder yarn craco --openssl-legacy-provider start

elif [ "$1" = "start_https" ]
then
  # DEPLOYMENT=dev HTTPS=true SSL_CRT_FILE=docker/nginx/nginx-selfsigned.crt SSL_KEY_FILE=docker/nginx/nginx-selfsigned.key craco start
  docker_compose run --rm -p $EXTERNAL_LISTEN_IP:3000:3000 -e DEPLOYMENT=dev -e HOST=0.0.0.0 -e PORT=3000 -e HTTPS=true -e SSL_CRT_FILE=docker/nginx/certs/nginx_certs/server.crt -e SSL_KEY_FILE=docker/nginx/certs/nginx_certs/server.key cg-builder yarn craco --openssl-legacy-provider start

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
  docker_compose up -d && docker_compose logs -f

elif [ "$1" = "down" ]
then
  docker_compose down

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
  printf "\e[1mstart_https\e[0m\nStart the development server on https://localhost:3000\n\n"
  printf "\e[1mbuild_full\e[0m\nBuild the stack including backend and frontend. Will start the stack afterwards.\n\n"
  printf "\e[1mupdate_backend\e[0m\nUpdate the backend only and rebuild the stack. Will update the stack afterwards.\n\n"
  printf "\e[1mupdate_frontend\e[0m\nUpdate the frontend only and rebuild the stack. Will update the stack afterwards.\n\n"
  printf "\e[1mup\e[0m\nStart the stack in detached mode and show logs.\n\n"
  printf "\e[1mdown\e[0m\nStop the stack.\n\n"
  printf "\e[1mcompose <arg_1> <arg_2> ...\e[0m\nRun docker compose commands. For example, to run 'docker compose ps', use './run.sh compose ps'.\n\n"
  printf "\e[1mshell\e[0m\nStart a shell in the cg-builder container (node20) and mount the project directory into it. It can then be used to run yarn commands.\n\n"
  printf "\e[1mmake_migration <migration_name>\e[0m\nCreate a new migration with the given name.\n\n"
  printf "\e[1mmake_empty_migration <migration_name>\e[0m\nCreate a new empty migration with the given name.\n\n\n"

  exit 1
fi