# Groovepede resolver — self-hosted arm64 image.
FROM node:22-alpine

WORKDIR /app
COPY resolver-core.mjs   ./resolver-core.mjs
COPY server.mjs          ./server.mjs

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
EXPOSE 8787

# node:sqlite is behind a flag in Node 22.
CMD ["node", "--experimental-sqlite", "server.mjs"]
