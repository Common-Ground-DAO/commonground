FROM node:24.18-bookworm
RUN mkdir /cg
RUN mkdir /builder-cache
WORKDIR /cg
RUN apt update && \
    apt -y upgrade && \
    apt install -y python3 python3-pip gosu
# Yarn 4 via corepack (package.json "packageManager" pins the exact version).
# The release is pre-fetched into a world-readable COREPACK_HOME so the
# non-root builder user (uid from BUILDER_UID) can run it without network
# access or a writable per-user cache.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && \
    corepack install -g yarn@4.17.1 && \
    chmod -R a+rX "$COREPACK_HOME"
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