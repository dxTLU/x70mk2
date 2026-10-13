# The proxy app. Zero npm dependencies, so there is nothing to install.
#
#   docker build -t x70mk2-proxy .
#   docker run --rm -p 8080:8080 -e BASIC_AUTH=me:secret x70mk2-proxy
#
# docker-compose.yml runs it behind Varnish.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_FILE=/data/sessions.json

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts/urls.js ./scripts/urls.js

# Cookie jars persist in a volume, owned by the unprivileged "node" user of the base image.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT,path:'/__proxy/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# server.js saves the cookie jars and lets open streams finish on SIGTERM. Proxied URLs embed
# whole target URLs, hence the larger header limit.
STOPSIGNAL SIGTERM
CMD ["node", "--max-http-header-size=65536", "server.js"]
