# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md). Postgres 18 keeps its data in a
# major-version subdirectory (PGDATA=/var/lib/postgresql/18/docker), so the
# compose files mount the volume at /var/lib/postgresql — see
# docs/infrastructure/README.md ("Postgres major upgrades").
FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
RUN mkdir /dockerscripts
COPY ./init.sh /docker-entrypoint-initdb.d
RUN chmod +x /docker-entrypoint-initdb.d/init.sh
WORKDIR /dockerscripts
