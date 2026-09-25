# Groovepede resolver — self-hosted arm64 image.
FROM node:22-alpine

WORKDIR /app

# package*.json copied and installed BEFORE the source files, so editing the
# sources (i.e. every commit) doesn't bust this layer's cache — only a
# dependency change does.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Every source module, by glob rather than by name: a per-file list silently
# ships an image that crashes on startup the first time a new module is added
# and not listed here. Tests are kept out of the build context by .dockerignore.
COPY *.mjs ./

# SQLite cache lives on a mounted volume. Pinned to a fixed uid:gid (PUID/PGID,
# default 10001) rather than the image's built-in `node` user (uid 1000) —
# 1000 is also the typical first real user on the host (e.g. Raspberry Pi OS)
# — and this stack's nginx/certbot containers share the same id so all three
# agree on file ownership. Kept above 10000 so it can't collide with a
# dynamically-allocated system account on the host (see .env.example).
ARG PUID=10001
ARG PGID=10001
RUN mkdir -p /data && chown -R ${PUID}:${PGID} /data /app

# Surfaced by /healthz so a deploy can verify THIS build went live, rather than
# just that some server answered. Last layer on purpose — it changes every
# commit, so everything above it stays cached.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER ${PUID}:${PGID}
EXPOSE 8787

# node:sqlite is behind a flag in Node 22.
CMD ["node", "--experimental-sqlite", "server.mjs"]
