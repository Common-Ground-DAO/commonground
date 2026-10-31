# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md). Major upgrade: roadmap item F3.
FROM postgres:14.23-alpine@sha256:f1341c01408dc7278e9d365ed4f860cd3f87dd16b4464ac326fc0f422083a579
RUN mkdir /dockerscripts
COPY ./init.sh /docker-entrypoint-initdb.d
RUN chmod +x /docker-entrypoint-initdb.d/init.sh
WORKDIR /dockerscripts