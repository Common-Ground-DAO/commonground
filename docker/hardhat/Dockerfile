# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md). Same base as docker/node/Dockerfile.
FROM node:26.12.0-trixie@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e
USER root
RUN mkdir /home/hardhat
# `./node/` (the directory), not `./node/*` — the glob would not reliably carry
# the `.yarnrc.yml` that configures the hardened install below.
COPY ./node/ /home/hardhat/
RUN adduser --home /home/hardhat --disabled-password --gecos "" --shell /bin/false hardhat &&\
    chown -R hardhat:root /home/hardhat
# Corepack is not bundled with Node >= 25: installed from the npm tarball,
# verified against a pinned sha512 (keep in step with docker/node/Dockerfile).
# It honours the `packageManager` pin (version + hash) in node/package.json, so
# the install runs under Yarn 4 and node/.yarnrc.yml applies — install scripts
# disabled, one-week package cooldown. Until 2026-08-04 this was a bare `yarn`
# (the base image's Yarn 1.22, no lockfile, scripts on); since 2026-10-31 the
# directory has its own yarn.lock and the install is --immutable.
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA512=4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff
RUN curl -fsSL --retry 3 -o /tmp/corepack.tgz "https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz" && \
    echo "${COREPACK_SHA512}  /tmp/corepack.tgz" | sha512sum -c - && \
    npm install -g --no-audit --no-fund /tmp/corepack.tgz && \
    rm /tmp/corepack.tgz && \
    corepack enable
WORKDIR /home/hardhat
USER hardhat
RUN yarn install --immutable
