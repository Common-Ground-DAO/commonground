# Edge image for the dev stack and the self-host profile: Caddy plus the built
# frontend (docs/infrastructure/README.md, "Caddy").
#
# One image for every domain: nothing instance-specific is baked in. The
# compose file picks the config (Caddyfile.dev, Caddyfile.selfhost) via
# `command`, and everything that depends on the instance (domain, TLS mode,
# the instance config served as /instance-config.js) comes from the
# container environment at runtime. Caddyfile.vite and the test-only
# Caddyfile.conformance are bind-mounted by their compose files instead.
#
# Stock Caddy, no plugins: a custom build would pull third-party Go modules
# outside the update policy's review (docs/infrastructure/UPDATE-POLICY.md).
#
# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md).
FROM caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9

COPY common.caddy Caddyfile.dev Caddyfile.selfhost /etc/caddy/
# rendered per request by Caddy's templates handler (common.caddy)
COPY instance-config.js /etc/caddy/templates/instance-config.js
COPY dist /srv
# robots.txt points crawlers at the API's sitemap on whatever host serves it;
# the line is a Caddy template, rendered per request (common.caddy)
RUN printf 'Sitemap: {{placeholder "http.request.scheme"}}://{{placeholder "http.request.hostport"}}/sitemap.xml\n' >> /srv/robots.txt

# the stock image's own /etc/caddy/Caddyfile is an unrelated example config;
# default to the self-host one (compose files set `command` anyway)
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile.selfhost", "--adapter", "caddyfile"]
