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
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN if [ ! "$BUILDER_GID" = "1000" ]; then groupadd --gid $BUILDER_GID cg_env; fi
RUN if [ ! "$BUILDER_UID" = "1000" ]; then useradd --uid $BUILDER_UID --gid $BUILDER_GID --create-home cg_env; fi
RUN chown -R $BUILDER_UID:$BUILDER_GID /cg /builder-cache