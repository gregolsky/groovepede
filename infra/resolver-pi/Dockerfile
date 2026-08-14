# Groovepede resolver — self-hosted arm64 image.
# Build context is infra/ (see docker-compose.yml) so the shared core and the
# server keep the same relative layout as the repo, and the ../resolver import
# resolves both locally and in the container.
FROM node:22-alpine

WORKDIR /app
COPY resolver/resolver-core.mjs   ./resolver/resolver-core.mjs
COPY resolver-pi/server.mjs       ./resolver-pi/server.mjs

# SQLite cache lives on a mounted volume. Pinned to a fixed uid:gid (PUID/PGID,
# default 10001) rather than the image's built-in `node` user (uid 1000) —
# 1000 is also the typical first real user on the host (e.g. Raspberry Pi OS)
# — and this stack's nginx/certbot containers share the same id so all three
# agree on file ownership. Kept above 10000 so it can't collide with a
# dynamically-allocated system account on the host (see .env.example).
ARG PUID=10001
ARG PGID=10001
RUN mkdir -p /data && chown -R ${PUID}:${PGID} /data /app

USER ${PUID}:${PGID}
WORKDIR /app/resolver-pi
EXPOSE 8787

# node:sqlite is behind a flag in Node 22.
CMD ["node", "--experimental-sqlite", "server.mjs"]
