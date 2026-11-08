# Base images are pinned by version + multi-arch index digest and must be at
# least 7 days old (docs/infrastructure/UPDATE-POLICY.md); Renovate proposes
# digest/version bumps.
FROM node:26.12.0-trixie@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e
RUN mkdir /cg
RUN mkdir /builder-cache
WORKDIR /cg
# No apt packages: python3 (node-gyp) and the compilers come with the
# node:*-trixie base. (python3-pip and gosu were installed here until
# 2026-10-31; pip only served mediasoup's from-source worker build, which no
# install path uses any more, and nothing referenced gosu.)

# Corepack is no longer bundled with Node >= 25, so it is installed from the
# npm tarball, verified against a pinned sha512 (the registry's `integrity`
# value, hex-encoded). Corepack has no dependencies, so this is the only file
# fetched.
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA512=4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff
RUN curl -fsSL --retry 3 -o /tmp/corepack.tgz "https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz" && \
    echo "${COREPACK_SHA512}  /tmp/corepack.tgz" | sha512sum -c - && \
    npm install -g --no-audit --no-fund /tmp/corepack.tgz && \
    rm /tmp/corepack.tgz
# Yarn 4 via corepack. The release is pre-fetched into a world-readable
# COREPACK_HOME so the non-root builder user (uid from BUILDER_UID) can run it
# without network access or a writable per-user cache. Keep this in step with
# the `packageManager` field (version + hash) of the root package.json;
# corepack verifies the download against the hash.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && \
    corepack install -g yarn@4.18.1+sha512.b2e1e7524f654f2749d32b4ebcb4622473cb5bcbc485df2007e12a154e50162a4d795526768bc5f5b8f81717bfd79deb2472813d86fb5ae2eb551fa9c872b08f && \
    chmod -R a+rX "$COREPACK_HOME"
# Install-time binary downloads that are neither needed nor verifiable here:
# the builder never launches a browser or a call worker. The backend image
# installs both from sha256-verified downloads instead (Chrome for Testing and
# the mediasoup worker — see docker/backend/fetch_*.sh). A path that does not
# exist makes an accidental mediasoup.createWorker() in the builder fail loudly.
# bcrypt's node-pre-gyp would otherwise fetch an unverified prebuilt binary
# from GitHub; it is compiled from the (lockfile-checksummed) npm sources
# instead, against the headers shipped in this image (nodedir), so node-gyp
# downloads nothing either.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    MEDIASOUP_WORKER_BIN=/nonexistent/mediasoup-worker-not-in-builder \
    npm_config_build_from_source=bcrypt \
    npm_config_nodedir=/usr/local
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENTRYPOINT [ "/entrypoint.sh" ]
# The builder runs as the host user that owns the checkout (BUILDER_UID/GID,
# written by init.sh / set in docker/.env), so files it writes into the
# bind-mounted repo keep the right owner. Only create the group/user when the
# image does not already have one with that id: 1000 is the base image's
# `node` user, 0 is root (operator running the self-host build as root), and
# other low ids collide with Debian system groups (e.g. macOS' gid 20).
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN if ! getent group "$BUILDER_GID" >/dev/null; then groupadd --gid "$BUILDER_GID" cg_env; fi
RUN if ! getent passwd "$BUILDER_UID" >/dev/null; then useradd --uid "$BUILDER_UID" --gid "$BUILDER_GID" --create-home cg_env; fi
RUN chown -R "$BUILDER_UID:$BUILDER_GID" /cg /builder-cache
