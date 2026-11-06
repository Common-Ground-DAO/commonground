# Single-stage backend image used by the legacy Azure pipelines
# (pipelines/build-*.yml). The dev stack and self-host build the same thing in
# two stages (Dockerfile_dev_stage_0 + Dockerfile_dev_stage_1) — keep both in
# step. Base pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md).
FROM node:26.12.0-trixie@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e
# apt from a dated snapshot.debian.org archive: the timestamp debuerreotype
# recorded (as a comment in debian.sources) when it built the Debian rootfs
# underneath the pinned node image. The package set is therefore fixed by the
# digest above and moves with it. (The node image's own layers may hold
# slightly newer packages from the live mirror; apt never downgrades them.)
# Snapshot Release files carry an expired Valid-Until; signatures are still
# checked. snapshot.debian.org is rate-limited, hence the retries.
RUN set -eu; f=/etc/apt/sources.list.d/debian.sources; \
    ts="$(sed -n 's|^# http://snapshot.debian.org/archive/debian/\([0-9]\{8\}T[0-9]\{6\}Z\)$|\1|p' "$f" | head -n1)"; \
    if [ -z "$ts" ]; then echo "apt snapshot: no '# http://snapshot.debian.org/archive/debian/<timestamp>' comment in $f — the base image layout changed; see docs/infrastructure/UPDATE-POLICY.md#apt-debian" >&2; exit 1; fi; \
    sed -i -e "s|^URIs: http://deb.debian.org/debian\$|URIs: http://snapshot.debian.org/archive/debian/$ts|" \
           -e "s|^URIs: http://deb.debian.org/debian-security\$|URIs: http://snapshot.debian.org/archive/debian-security/$ts|" "$f"; \
    if grep -q '^URIs: http://deb.debian.org' "$f"; then echo "apt snapshot: a deb.debian.org source in $f was not rewritten — the base image layout changed" >&2; exit 1; fi; \
    printf '%s\n' 'Acquire::Check-Valid-Until "false";' 'Acquire::Retries "3";' > /etc/apt/apt.conf.d/99snapshot; \
    echo "apt snapshot: $ts"
# Chrome for Testing for puppeteer, sha256-verified, plus its runtime
# libraries via apt (see the script). x86_64 only: elsewhere the script skips
# it and social preview images do not work.
COPY fetch_chrome.sh /tmp/fetch_chrome.sh
RUN sh /tmp/fetch_chrome.sh /opt/chrome && rm /tmp/fetch_chrome.sh
# NSFW classification model, pinned revision + sha256-verified (the runtime
# loads it from /models/nsfw and never touches the network). Early layers on
# purpose: they depend on nothing but the scripts, so source changes don't
# re-download them on every build.
COPY download_model.sh /tmp/download_model.sh
RUN sh /tmp/download_model.sh /models/nsfw && rm /tmp/download_model.sh
# mediasoup-worker prebuilt binary, sha256-verified (see the script).
COPY fetch_mediasoup_worker.sh /tmp/fetch_mediasoup_worker.sh
RUN sh /tmp/fetch_mediasoup_worker.sh /opt/mediasoup && rm /tmp/fetch_mediasoup_worker.sh
# Corepack is not bundled with Node >= 25: installed from the npm tarball,
# verified against a pinned sha512 (keep in step with docker/node/Dockerfile).
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA512=4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff
RUN curl -fsSL --retry 3 -o /tmp/corepack.tgz "https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz" && \
    echo "${COREPACK_SHA512}  /tmp/corepack.tgz" | sha512sum -c - && \
    npm install -g --no-audit --no-fund /tmp/corepack.tgz && \
    rm /tmp/corepack.tgz && \
    corepack enable
ENV MEDIASOUP_WORKER_BIN=/opt/mediasoup/mediasoup-worker \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/opt/chrome/chrome-linux64/chrome
COPY check_pinned_binaries.sh /tmp/check_pinned_binaries.sh
COPY ./dist /dist
WORKDIR /dist
RUN sed -i 's/yarnPath: .*//g' /dist/.yarnrc.yml && \
    npm_config_build_from_source=bcrypt npm_config_nodedir=/usr/local \
      yarn install --immutable && \
    sh /tmp/check_pinned_binaries.sh && \
    yarn tsc && \
    rm /dist/.yarnrc.yml /tmp/check_pinned_binaries.sh && \
    # onnxruntime-node ships all platforms' prebuilt binaries and the
    # transformers dependency tree includes the browser-only onnxruntime-web —
    # drop the ~290 MB that can never run in this linux node image (verified:
    # classification works without onnxruntime-web in the node runtime)
    rm -rf /dist/node_modules/onnxruntime-node/bin/napi-v6/darwin \
           /dist/node_modules/onnxruntime-node/bin/napi-v6/win32 \
           /dist/node_modules/onnxruntime-web
# The build ID of the frontend built together with this image (vite/buildId.ts,
# src/common/buildId.ts); the pipelines pass the one they built with.
ARG CG_BUILD_ID=
ENV CG_BUILD_ID=${CG_BUILD_ID}
# healthy while the process's own report is "ok" and fresh (srv/healthcheck.ts,
# srv/healthcheck/healthcheck.sh); the start period covers the time until the
# first report (no --start-interval: older engines' builders reject it)
HEALTHCHECK --interval=20s --timeout=5s --start-period=1m CMD bash /dist/healthcheck/healthcheck.sh
