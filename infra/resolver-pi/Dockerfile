# Groovepede resolver — self-hosted arm64 image.
# Build context is infra/ (see docker-compose.yml) so the shared core and the
# server keep the same relative layout as the repo, and the ../resolver import
# resolves both locally and in the container.
FROM node:22-alpine

WORKDIR /app
COPY resolver/resolver-core.mjs   ./resolver/resolver-core.mjs
COPY resolver-pi/server.mjs       ./resolver-pi/server.mjs

# SQLite cache lives on a mounted volume.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
WORKDIR /app/resolver-pi
EXPOSE 8787

# node:sqlite is behind a flag in Node 22.
CMD ["node", "--experimental-sqlite", "server.mjs"]
