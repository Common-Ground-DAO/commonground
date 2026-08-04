#!/bin/bash
cd ${0%/*}
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
docker_compose stop wsapi api onchain nginx mediasoup memberlist hardhat job-runner
docker_compose rm -f
docker_compose build cg-builder

if [ ! -d ../srv/.yarn ]
then
  printf "\n---\n--- Missing srv/.yarn directory, setting yarn to version 4.17.1 \n---\n"
  docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' srv/.yarnrc.yml && cd srv && yarn set version 4.17.1"
  checkError
fi

docker_compose build --no-cache nginx
checkError

printf "\n---\n--- Generating certificates\n---\n"
if [ -f nginx/certs/nginx_certs/certificate_ip ]
then
  CERT_IP=$(cat nginx/certs/nginx_certs/certificate_ip)
else
  CERT_IP="different than LOCAL_CERTIFICATE_IP"
fi

if [ "$LOCAL_CERTIFICATE_IP" != "$CERT_IP" ]
then
  nginx/certs/recreate_root_cert.sh &&
  nginx/certs/recreate_server_certs.sh
  checkError
  printf "$LOCAL_CERTIFICATE_IP" > nginx/certs/nginx_certs/certificate_ip
else
  printf "Local ip did not change, skipping...\n"
fi

if [ ! -f vapid_keys.json ];
then
  printf "Generating vapid_keys.json for web push...\n"
  if [ ! -d srv/node_modules/web-push ]
  then
    docker_compose run --rm -T cg-builder bash -c "cd srv && yarn"
  fi
  docker_compose run --rm -T cg-builder bash -c "cd srv && npx web-push generate-vapid-keys --json > ../docker/vapid_keys.json"
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

docker build --tag commonground/backend_stage_0 -f backend/Dockerfile_dev_stage_0 ./backend/ && \
docker_compose build --no-cache api
checkError

printf "\n---\n--- Build finished, starting server\n---\n"
docker_compose up -d --remove-orphans
checkError

cd ../docker

printf "\n---\n--- Deploying contracts\n---\n"
sleep 3
docker_compose run --rm -T cg-builder bash -c "cd contracts && yarn && npx hardhat run --network cgstack scripts/deploy.ts"

./logs.sh
