#!/bin/bash
# Merge the two pre-consolidation SeaweedFS volumes into the single one the
# collapsed `seaweed` service expects.
#
# Before: seaweedfs-volume holds the volume blobs (.dat/.idx/.vif) and
#         seaweedfs-buckets holds the filer leveldb under filerldb2/.
# After:  seaweedfs-data holds both — blobs at the root, filer at filerldb2/ —
#         because `weed server -dir=/data` wires the filer's default store dir
#         to -dir. Master raft/sequence state was ephemeral before (nothing was
#         mounted at the master's -mdir) and now persists under /data for free.
#
# Run this ONCE, with the stack stopped, when upgrading an instance that was
# created before the 3-to-1 consolidation. A fresh install needs nothing.
# The copy needs free disk at least the size of the current media store.
#
#   cd docker
#   ./selfhost/selfhost.sh down
#   ./selfhost/migrate_seaweed_volumes.sh
#   ./selfhost/selfhost.sh up
#
# Dev stack: ./run.sh down (repo root), then pass the dev project prefix:
#   ./selfhost/migrate_seaweed_volumes.sh docker
#
# The source volumes are left untouched; delete them yourself once the new
# stack has proven healthy:
#
#   docker volume rm <prefix>_seaweedfs-volume <prefix>_seaweedfs-buckets
#
# Usage: migrate_seaweed_volumes.sh [compose-project-prefix]
#   default prefix: cg-selfhost   (the dev stack's prefix is "docker")
set -euo pipefail

PREFIX="${1:-cg-selfhost}"
SRC_VOLUME="${PREFIX}_seaweedfs-volume"
SRC_BUCKETS="${PREFIX}_seaweedfs-buckets"
DST="${PREFIX}_seaweedfs-data"
HELPER_IMAGE="alpine:3.20"

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

echo "SeaweedFS volume merge for compose project '${PREFIX}'"
echo "  ${SRC_VOLUME}  -> ${DST}/"
echo "  ${SRC_BUCKETS}/filerldb2 -> ${DST}/filerldb2"
echo

if ! volume_exists "$SRC_VOLUME" && ! volume_exists "$SRC_BUCKETS"; then
  echo "Neither source volume exists — nothing to migrate."
  echo "A fresh (or already cleaned-up) install starts with an empty ${DST}."
  exit 0
fi
for vol in "$SRC_VOLUME" "$SRC_BUCKETS"; do
  if ! volume_exists "$vol"; then
    echo "ERROR: source volume '${vol}' is missing while its sibling exists."
    echo "That is not a state this script can migrate — a pre-consolidation"
    echo "instance always has both. Investigate before proceeding."
    exit 1
  fi
done

# Never copy from volumes a container is still using — a live filer/volume
# server would produce a torn copy.
for vol in "$SRC_VOLUME" "$SRC_BUCKETS"; do
  users="$(docker ps -q --filter volume="$vol")"
  if [ -n "$users" ]; then
    echo "ERROR: volume '${vol}' is still in use by running container(s):"
    docker ps --filter volume="$vol" --format '  {{.Names}}'
    echo "Stop the stack first."
    exit 1
  fi
done

# The filer leveldb is the index for every uploaded object — without it the
# blobs are unreadable. Check BEFORE touching the target so a bad source
# never leaves a half-migrated seaweedfs-data behind.
if ! docker run --rm -v "${SRC_BUCKETS}:/src:ro" "$HELPER_IMAGE" \
    sh -c '[ -d /src/filerldb2 ]'; then
  echo "ERROR: '${SRC_BUCKETS}' contains no filerldb2/ directory."
  echo "This volume does not look like a pre-consolidation filer store;"
  echo "refusing to migrate. Nothing was copied."
  exit 1
fi
extra="$(docker run --rm -v "${SRC_BUCKETS}:/src:ro" "$HELPER_IMAGE" \
  sh -c 'ls -A /src | grep -v "^filerldb2$" || true')"
if [ -n "$extra" ]; then
  echo "NOTE: '${SRC_BUCKETS}' holds entries besides filerldb2/ that will NOT"
  echo "be copied (the old volume stays untouched):"
  echo "$extra" | sed 's/^/  /'
fi

# Idempotence: never merge into a target that already holds data. Re-running
# after a successful merge (or against an already-migrated instance) must not
# silently overwrite a live store.
if volume_exists "$DST"; then
  contents="$(docker run --rm -v "${DST}:/dst" "$HELPER_IMAGE" \
    sh -c 'ls -A /dst 2>/dev/null | head -1')"
  if [ -n "$contents" ]; then
    echo "Target volume '${DST}' already exists and is not empty."
    echo "Refusing to touch it. If this is a failed earlier attempt, remove it"
    echo "with 'docker volume rm ${DST}' and run this script again."
    exit 1
  fi
  echo "Target volume '${DST}' exists but is empty — reusing it."
else
  echo "Creating target volume '${DST}'..."
  # compose labels, so `up` does not warn that the volume "was not created
  # by Docker Compose"
  docker volume create \
    --label "com.docker.compose.project=${PREFIX}" \
    --label "com.docker.compose.volume=seaweedfs-data" \
    "$DST" >/dev/null
fi

echo "Copying volume blobs..."
docker run --rm \
  -v "${SRC_VOLUME}:/src:ro" \
  -v "${DST}:/dst" \
  "$HELPER_IMAGE" \
  sh -c 'cp -a /src/. /dst/'

echo "Copying filer metadata (filerldb2)..."
docker run --rm \
  -v "${SRC_BUCKETS}:/src:ro" \
  -v "${DST}:/dst" \
  "$HELPER_IMAGE" \
  sh -c 'mkdir -p /dst/filerldb2 && cp -a /src/filerldb2/. /dst/filerldb2/'

echo
echo "Done. '${DST}' now holds:"
docker run --rm -v "${DST}:/dst" "$HELPER_IMAGE" sh -c 'ls -la /dst'
echo
echo "Next: start the stack. On the first start the container entrypoint may"
echo "chown -R /data (the image runs as uid 1000 since 4.00) — on a large store"
echo "that takes a while and looks like a hang. Let it finish."
echo
echo "The old volumes are untouched. Once the new stack is healthy:"
echo "  docker volume rm ${SRC_VOLUME} ${SRC_BUCKETS}"
