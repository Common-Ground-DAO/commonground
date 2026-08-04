FROM node:24.18-bookworm
USER root
RUN mkdir /home/hardhat
# `./node/` (the directory), not `./node/*` — the glob would not reliably carry
# the `.yarnrc.yml` that configures the hardened install below.
COPY ./node/ /home/hardhat/
RUN adduser --home /home/hardhat --disabled-password --gecos "" --shell /bin/false hardhat &&\
    chown -R hardhat:root /home/hardhat
# corepack, so the install honours the `packageManager` pin in node/package.json
# and runs under Yarn 4 rather than the base image's bundled Yarn 1.22. That is
# what makes node/.yarnrc.yml apply — install scripts disabled, one-week package
# cooldown. Until 2026-08-04 this was a bare `yarn`: no lockfile, no cooldown,
# lifecycle scripts on, i.e. the most exposed install path in the repository.
RUN corepack enable
WORKDIR /home/hardhat
USER hardhat
RUN yarn
