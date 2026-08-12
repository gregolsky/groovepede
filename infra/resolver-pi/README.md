# Groovepede Resolver — self-hosted (Raspberry Pi / arm64)

A small Docker Compose alternative to the AWS edge stack. Same job: a server-side
Odesli proxy that fixes the browser CORS block, so the PWA can resolve album links.
Runs on a home Raspberry Pi (arm64) with a free Let's Encrypt certificate.

It reuses the **exact same resolver core** as the AWS Lambda
(`../resolver/resolver-core.mjs`) — identical ECDSA token verification, CORS,
host allowlist, and Odesli call — so the PWA's existing signed tokens work against
either backend with the same key pair.

## Architecture

```
Browser (HTTPS, signed x-gp-token)
  → nginx  (:443 TLS via Let's Encrypt · :80 ACME challenge + redirect)
      · per-IP rate limiting (limit_req)  ← replaces AWS WAF's rate rule
  → resolver  (node:http, internal-only :8787)
      · ECDSA token verify · host allowlist · CORS
      · SQLite cache (node:sqlite, /data/cache.db)
  → Odesli API
certbot  → obtains + auto-renews the cert (HTTP-01 webroot)
```

Three containers: `resolver` (Node 22), `nginx`, `certbot`. The resolver is not
published to the host — only nginx exposes ports (80/443).

## Prerequisites

- A Raspberry Pi (or any arm64/amd64 host) with **Docker** + **Docker Compose v2**.
- A **public DNS A record** for your chosen `DOMAIN` pointing at your home's public IP.
  - This must be a **new hostname** (e.g. `pi.groovepede.gregolsky.pl`), *not*
    `api.groovepede.gregolsky.pl` (that's the AWS CloudFront edge).
  - If your home IP is dynamic, use a DDNS updater to keep the A record current.
- **Ports 80 and 443 forwarded** on your router to the Pi. Port 80 must be reachable
  from the internet on `DOMAIN` — Let's Encrypt's HTTP-01 challenge validates there.
- The **`GP_PUBLIC_KEY`** from your existing key pair (`cd ../resolver && make keygen`).

## Setup

```bash
cd infra/resolver-pi
cp .env.example .env
#   edit .env: DOMAIN, LETSENCRYPT_EMAIL, GP_PUBLIC_KEY (+ optional ODESLI_KEY, rate limit)

# One-time: obtain the Let's Encrypt cert (bootstraps nginx, runs HTTP-01).
# Test first with --staging to avoid LE rate limits if you're unsure of DNS/ports:
./init-letsencrypt.sh --staging      # untrusted staging cert
./init-letsencrypt.sh                # real cert once staging works

# Bring up the full stack:
docker compose up -d

# Verify:
curl https://$DOMAIN/healthz          # → {"ok":true} with a valid cert
```

## Deploy to the Pi

`deploy.sh` rsyncs this stack (plus the shared `resolver-core.mjs`) to the Pi and
builds/starts the containers over SSH. On first run — when no cert exists yet — it
runs the Let's Encrypt bootstrap automatically.

```bash
cp deploy.env.example deploy.env      # set PI_SSH_TARGET (e.g. gregolsky@192.168.1.123)
./deploy.sh                           # deploys to ~/groovepede-resolver on the Pi
```

- Config (`PI_SSH_TARGET`, `PI_REMOTE_DIR`) is read from the git-ignored `deploy.env`;
  a CLI arg overrides it: `./deploy.sh pi@10.0.0.5`.
- `./deploy.sh --init` forces re-running the cert bootstrap.
- The Pi's `./data/` (SQLite cache + certs) is never overwritten by a redeploy.

Prereqs on the Pi: Docker + Docker Compose, ports 80+443 forwarded, and the DNS A
record for `$DOMAIN` pointing at your public IP (as in Prerequisites above). The
resolver `.env` is synced to the Pi; `deploy.env` is not.

## Point the PWA at your Pi

Build the PWA with `ODESLI_BASE` set to your Pi's hostname instead of the AWS edge.
In `src/js/config.js` (or via a build-time override):

```js
export const ODESLI_BASE = 'https://pi.groovepede.gregolsky.pl';
```

The path (`/v1/resolve`) and the signed `x-gp-token` header are unchanged, and the
private key stays the same (`VITE_GP_PRIVATE_KEY`) — the Pi verifies with the matching
`GP_PUBLIC_KEY`.

## Certificates & renewal

- `init-letsencrypt.sh` handles first issuance (self-signed bootstrap → real cert).
- The `certbot` container runs `certbot renew` every 12h; nginx reloads every 6h to
  pick up a renewed cert. No manual steps after setup.
- **CAA note:** unlike the AWS/ACM path (where `groovepede.gregolsky.pl`'s CNAME to
  `gregolsky.github.io` inherits GitHub's CAA that excludes Amazon), Let's Encrypt is
  **authorized** by that same GitHub CAA (`letsencrypt.org`), and a plain A-record host
  resolves its CAA to a permissive level — so LE issuance is not blocked.

## Security posture

Self-hosting drops CloudFront/WAF/OAC. Compensating controls:

- **ECDSA token verification** (primary gate) — identical to AWS; 5-min replay window,
  URL-bound. The private key ships in the public PWA bundle, so it's a strong deterrent,
  not airtight auth (same honest caveat as the AWS deployment).
- **nginx per-IP rate limiting** (`RATE_LIMIT` / `RATE_LIMIT_BURST`) → 429 on abuse.
- **Host allowlist** in the resolver (SSRF hygiene) — only known music-service hosts
  are proxied to Odesli.
- The resolver has **no published host port**; it's reachable only via nginx.

Consider adding your own extra protections (fail2ban, a Cloudflare proxy in front, etc.)
if the endpoint sees abuse.

## Operations

```bash
docker compose logs -f resolver         # app logs
docker compose logs -f nginx            # access / TLS
docker compose restart resolver         # after editing .env
docker compose down                     # stop (keeps ./data cache + certs)
```

The SQLite cache and certs live under `./data/` (git-ignored). Deleting
`./data/cache.db` just forces re-fetches from Odesli; deleting `./data/certbot`
means re-running `init-letsencrypt.sh`.

## Local test (no TLS / no DNS)

```bash
# Run just the resolver, published locally:
docker compose run --rm -p 8787:8787 -e DB_PATH=/tmp/cache.db resolver
curl localhost:8787/healthz             # → {"ok":true}
# Signed-request smoke: reuse ../resolver Makefile's token generation against
# http://localhost:8787/v1/resolve?url=...&userCountry=US with Origin: http://localhost:5173
```
