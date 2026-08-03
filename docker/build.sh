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
docker_compose down --remove-orphans
docker_compose build cg-builder

if [ ! -d ../.yarn ]
then
  printf "\n---\n--- Missing .yarn directory, setting yarn to version 4.1.0 \n---\n"
  docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' .yarnrc.yml && yarn set version 4.1.0"
  checkError
fi

if [ ! -d ../srv/.yarn ]
then
  printf "\n---\n--- Missing srv/.yarn directory, setting yarn to version 4.1.0 \n---\n"
  docker_compose run --rm cg-builder bash -c "sed -i 's/yarnPath: .*//g' srv/.yarnrc.yml && cd srv && yarn set version 4.1.0"
  checkError
fi

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
  printf "Local ip did not change, skipping..."
fi

printf "\n---\n--- Building frontend and nginx image\n---\n"
rm -rf backend/dist/* && \
rm -rf nginx/dist/* && \
docker_compose run --rm cg-builder yarn
checkError

buildId=$(dd if=/dev/random bs=1 count=10 status=none | base64)

if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
else
  sed -i 's#^const buildId =.*$#const buildId = "'$buildId'";#' ../src/common/random_build_id.ts
fi
checkError

docker_compose run --rm -e NODE_OPTIONS="--max-old-space-size=8192" -e DEPLOYMENT=prod -e GENERATE_SOURCEMAP=true -e IMAGE_INLINE_SIZE_LIMIT=5000 cg-builder yarn craco --openssl-legacy-provider build && \
rsync -a ../build/* nginx/dist/
checkError

for f in nginx/dist/static/media/*.svg
do
  # Since the SVG imports were codemodded to svgr's `?react` form, no build
  # stack emits standalone `static/media/*.svg` any more and the glob stays
  # unexpanded — skip the literal pattern instead of running `wc` on it.
  # (This whole loop goes away with the CRA build in Phase 3.)
  [ -e "$f" ] || continue
  size=$(wc -c "$f" | awk '{print $1}')
  if [ "$size" -le "5000" ]
  then
    # this only happens in local development environment,
    # to make sure files which should be inline cannot be
    # loaded in another way
    printf "Deleting small svg file with size $size: $f\n"
    rm "$f"
  fi
done

docker_compose build --no-cache nginx
checkError

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
docker_compose run --rm -T cg-builder bash -c "cd contracts && yarn && npx hardhat run --network cgstack scripts/deploy.ts"

./logs.sh
