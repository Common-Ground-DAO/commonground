# Pinned by version + multi-arch index digest, >= 7 days old
# (docs/infrastructure/UPDATE-POLICY.md).
FROM nginx:1.31.7-trixie@sha256:8632b3314d74c61f0e27f59055bab13f7793b988c94c090154d867bc29e0f39b
ARG SERVER_NAME
ARG CGID_SERVER_NAME
SHELL ["/bin/bash", "-c"]
COPY ./nginx.conf /etc/nginx/
ADD ./dist /www/
RUN chown -R www-data:www-data /www
RUN sed -i -e "s/{SERVER_NAME}/$SERVER_NAME/g" /etc/nginx/nginx.conf
RUN sed -i -e "s/{CGID_SERVER_NAME}/$CGID_SERVER_NAME/g" /etc/nginx/nginx.conf
RUN printf "Sitemap: https://$SERVER_NAME/sitemap.xml\n" >> /www/robots.txt