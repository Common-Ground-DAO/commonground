FROM node:24.18-bookworm
RUN mkdir /cg
RUN mkdir /builder-cache
WORKDIR /cg
RUN apt update && \
    apt -y upgrade && \
    apt install -y python3 python3-pip gosu
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENTRYPOINT [ "/entrypoint.sh" ]
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN if [ ! "$BUILDER_GID" = "1000" ]; then groupadd --gid $BUILDER_GID cg_env; fi
RUN if [ ! "$BUILDER_UID" = "1000" ]; then useradd --uid $BUILDER_UID --gid $BUILDER_GID --create-home cg_env; fi
RUN chown -R $BUILDER_UID:$BUILDER_GID /cg /builder-cache