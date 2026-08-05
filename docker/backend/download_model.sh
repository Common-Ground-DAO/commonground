#!/bin/sh
# Downloads the server-side NSFW classification model into the backend image
# at build time (srv/moderation/imageFilter.ts loads it from /models/nsfw;
# override via IMAGE_MODERATION_MODEL_PATH). The revision is a pinned,
# immutable HuggingFace commit and every file is verified by sha256, so the
# build either produces exactly these weights or fails — the runtime never
# touches the network (env.allowRemoteModels = false).
#
# Model: onnx-community/nsfw_image_detection-ONNX (Apache-2.0), the ONNX
# export of Falconsai/nsfw_image_detection (ViT-base 224px), int8 variant.
set -e

REPO="onnx-community/nsfw_image_detection-ONNX"
REV="1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5"
DEST="${1:-/models/nsfw}"

mkdir -p "$DEST/onnx"

fetch() {
  # $1 = file path inside the repo, $2 = expected sha256
  url="https://huggingface.co/$REPO/resolve/$REV/$1"
  out="$DEST/$1"
  echo "download_model: fetching $1"
  if command -v curl >/dev/null 2>&1; then
    # timeouts so a stalled connection fails the build instead of hanging it
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 600 "$url" -o "$out"
  else
    wget -q --timeout=15 --tries=3 "$url" -O "$out"
  fi
  echo "$2  $out" | sha256sum -c - >/dev/null || {
    echo "download_model: sha256 mismatch for $1" >&2
    exit 1
  }
}

fetch config.json               0e01783cf842a0acaa6b3b6594b941bee4d39a1918756b27d23f503878889696
fetch preprocessor_config.json  ae9bb157b9629887cc74913a4e7c12c9308f374f0930e8072320e8f2e1583c5e
fetch onnx/model_quantized.onnx d9afb1e057104e6cc8616d174f0f6a8b8b0389c839eea7d5efa4bdf1a77efd27

echo "download_model: verified $REPO@$REV at $DEST"
