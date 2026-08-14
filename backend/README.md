# Groovepede Resolver — self-hosted (Raspberry Pi / arm64)

A small Docker Compose stack: a server-side Odesli proxy that fixes the browser
CORS block, so the PWA can resolve album links. Runs on a home Raspberry Pi
(arm64) with a free Let's Encrypt certificate.

`resolver-core.mjs` owns ECDSA token verification, CORS, host allowlist, and
the Odesli call; `server.mjs` is the node:http + node:sqlite adapter around it.

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
  - This must be a **new hostname** (e.g. `pi.example.com`) distinct from your
    existing AWS CloudFront edge hostname.
  - If your home IP is dynamic, use a DDNS updater to keep the A record current.
- **Ports 80 and 443 forwarded** on your router to the Pi. Port 80 must be reachable
  from the internet on `DOMAIN` — Let's Encrypt's HTTP-01 challenge validates there.
- The **`GP_PUBLIC_KEY`** from your key pair (`make keygen`).

## Setup

```bash
cd backend
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

Two paths, both ending in the same script:

| Path | Trigger | Use |
|---|---|---|
| **push** — `deploy.sh` | you, over SSH | first-time `--init`, emergencies, working offline from CI |
| **pull** — `ansible/pull-deploy.sh` | CI → ntfy.sh → the Pi | routine deploys of `backend/**` |

Both rsync sources into the runtime directory and then run **`deploy-local.sh`**,
which owns everything that touches live state: the cert backup, the
never-auto-issue guard, `docker compose up -d --build`, and the health check.
That logic lives in exactly one file on purpose — a second copy of it in Ansible
YAML is how it would silently drift, and drift in this specific area already
destroyed the production certificate once.

### Push deploy

`deploy.sh` rsyncs this stack (plus the shared `resolver-core.mjs`) to the Pi and
builds/starts the containers over SSH.

```bash
cp deploy.env.example deploy.env      # set PI_SSH_TARGET (e.g. you@192.168.1.123)
./deploy.sh --init                    # first deploy only: bootstraps the LE cert
./deploy.sh                           # every deploy after: deploys to ~/groovepede-resolver
```

- Config (`PI_SSH_TARGET`, `PI_REMOTE_DIR`) is read from the git-ignored `deploy.env`;
  a CLI arg overrides it: `./deploy.sh pi@10.0.0.5`.
- **`--init` is required for the first deploy** (or `--staging` to test against
  Let's Encrypt's staging environment first). A plain `./deploy.sh` never
  bootstraps a cert on its own — Let's Encrypt allows only 5 duplicate certs
  per domain per 7 days, so issuance is opt-in, never inferred from "no cert
  found." If you forget `--init` on a fresh Pi, `deploy.sh` exits with an
  error telling you to add it, rather than guessing.
- **Every deploy backs up the cert first**, to `/tmp/gp-cert-$DOMAIN-<timestamp>.tar.gz`
  on both the Pi and your dev machine (last 10 kept on the Pi). This is
  short-term insurance against a bad deploy, not a real archive — restore:
  ```bash
  cd ~/groovepede-resolver/resolver
  docker run --rm -u 10001:10001 -v "$PWD/data/certbot/conf:/etc/letsencrypt" \
    -v /tmp:/backup --entrypoint tar certbot/certbot \
    -xzf /backup/gp-cert-<domain>-<timestamp>.tar.gz -C /etc/letsencrypt
  docker compose up -d --force-recreate nginx
  ```
- The Pi's `./data/` (SQLite cache + certs) is never overwritten by a redeploy.

> **Upgrading an existing Pi deployment:** two changes need a one-time manual
> step on the Pi if you deployed before this update.
>
> 1. Containers now run as fixed `PUID:PGID` (default `10001:10001`, see
>    `.env.example`) instead of uid 999. `./data` from before this change is
>    owned by root or 999.
> 2. The remote directory is now `resolver` instead of `resolver-pi` — a plain
>    `./deploy.sh` will sync into a fresh `resolver/` next to the old one,
>    leaving the old `resolver-pi/data` (cache + certs) behind.
>
> Fix both in one move — on the Pi:
> ```bash
> mv ~/groovepede-resolver/resolver-pi/data ~/groovepede-resolver/resolver-tmp-data
> rm -rf ~/groovepede-resolver/resolver-pi
> # after your next ./deploy.sh creates ~/groovepede-resolver/resolver/:
> mv ~/groovepede-resolver/resolver-tmp-data ~/groovepede-resolver/resolver/data
> sudo chown -R 10001:10001 ~/groovepede-resolver/resolver/data
> ```
>
> `./data/nginx-logs` (fail2ban's log source) and `./data/fail2ban` are created
> by `init-letsencrypt.sh`; if you're not re-running it, create them yourself:
> ```bash
> sudo install -d -o 10001 -g 10001 ~/groovepede-resolver/resolver/data/nginx-logs
> sudo install -d ~/groovepede-resolver/resolver/data/fail2ban
> ```

Prereqs on the Pi: Docker + Docker Compose, ports 80+443 forwarded, and the DNS A
record for `$DOMAIN` pointing at your public IP (as in Prerequisites above). The
resolver `.env` is synced to the Pi; `deploy.env` is not.

### Custom host ports

Set `HTTP_PORT` / `HTTPS_PORT` in `.env` to publish on non-default ports (nginx still
listens on 80/443 inside the container):

```
HTTP_PORT=8080
HTTPS_PORT=4433
```

Because Let's Encrypt HTTP-01 validates on public **:80** and browsers expect **:443**,
your router must forward public `80 → HTTP_PORT` and `443 → HTTPS_PORT`. (The PWA's
`ODESLI_BASE` stays `https://$DOMAIN` with no port — the router handles the mapping.)

## Point the PWA at your Pi

Build the PWA with `ODESLI_BASE` set to your Pi's hostname instead of the AWS edge.
In `src/js/config.js` (or via a build-time override):

```js
export const ODESLI_BASE = 'https://pi.example.com';
```

The path (`/v1/resolve`) and the signed `x-gp-token` header are unchanged, and the
private key stays the same (`VITE_GP_PRIVATE_KEY`) — the Pi verifies with the matching
`GP_PUBLIC_KEY`.

### Pull deploys (ntfy.sh + ansible-pull)

The Pi sits behind a home router with no inbound SSH, so CI can't push to it.
Instead, a push to `main` touching `backend/**` runs
`.github/workflows/deploy-backend.yml`, which publishes to a **secret ntfy.sh
topic**. An `ntfy` client on the Pi reacts by running
`backend/ansible/pull-deploy.sh`, which `ansible-pull`s this repo and applies
`backend/ansible/site.yml`. CI then polls `/healthz` until it reports the
commit it just pushed — a plain `{"ok":true}` would also come back from the
*old* build, so matching `commit` is what actually proves the deploy landed.

**The checkout is deliberately not the runtime directory.** `ansible-pull`
resets its checkout on every run; if `.env`, `data/certbot` and the SQLite cache
lived inside it, a routine pull would wipe the live certificate. So the checkout
goes to `~/.ansible-pull/groovepede` and the playbook only ever rsyncs *out of*
it into `~/groovepede-resolver/resolver`, excluding `data/` and `.env`.

One-time setup on the Pi (already done on the live one):

```bash
sudo apt install ansible ntfy
sudo install -d -m 0755 /etc/ntfy
sudo tee /etc/ntfy/client.yml >/dev/null <<'YAML'
default-host: https://ntfy.sh
subscribe:
  - topic: <the same secret value as the NTFY_DEPLOY_TOPIC repo secret>
    command: 'curl -fsS https://raw.githubusercontent.com/gregolsky/groovepede/main/backend/ansible/pull-deploy.sh | bash'
YAML
sudo chown "$USER:$USER" /etc/ntfy/client.yml
sudo chmod 600 /etc/ntfy/client.yml     # the topic IS the credential

# The packaged unit runs as _ntfy, which has no docker access and the wrong
# HOME, so the deploy would fail. Run it as the account that already does
# push-deploys and already owns the runtime dir — adding _ntfy to the docker
# group would instead create a second root-equivalent account.
sudo install -d -m 0755 /etc/systemd/system/ntfy-client.service.d
sudo tee /etc/systemd/system/ntfy-client.service.d/override.conf >/dev/null <<CONF
[Service]
User=$USER
Group=$USER
CONF
sudo systemctl daemon-reload
sudo systemctl enable --now ntfy-client
```

Security notes, since the topic is the only thing guarding this:

- **The command is a fixed string.** Nothing from the notification (title, body,
  tags) is interpolated into it, so a spoofed publish on a leaked topic can at
  worst re-trigger a legitimate pull of `main` — it cannot inject shell.
- Treat the topic like a password: anyone who learns it can trigger deploys.
  It is `chmod 600` on the Pi and a GitHub Actions secret in CI, never in git.
- ntfy.sh is a public relay. The deploy signal carries only a short commit sha,
  no secrets.

Manual pull (what to run when debugging the unattended path):

```bash
~/.ansible-pull/groovepede/backend/ansible/pull-deploy.sh   # or the curl one-liner above
journalctl -u ntfy-client -n 50                             # did the trigger fire?
curl -s https://api.groovepede.gregolsky.pl/healthz          # {"ok":true,"commit":"<sha>"}
```

**Rollback:** `sudo systemctl disable --now ntfy-client` and use `./deploy.sh`.
The push path is unchanged and always works — that's why it stays.

## Certificates & renewal

- `init-letsencrypt.sh` handles first issuance (self-signed bootstrap → real cert).
  It **refuses to run if a cert for `$DOMAIN` already exists** — printing the
  existing cert's expiry and exiting 0 without contacting Let's Encrypt — since
  issuing is opt-in and the duplicate-cert quota is tight (5 per domain per 7
  days). Pass `--force` if you deliberately want to replace a live cert.
- The `certbot` container runs `certbot renew` every 12h; nginx reloads every 6h to
  pick up a renewed cert. No manual steps after setup.
- `deploy.sh` backs up `data/certbot/conf` on every run (see Deploy to the Pi
  above) — restore from that backup instead of re-issuing if a cert is ever
  lost or corrupted.
- **CAA note:** unlike the AWS/ACM path (where `groovepede.gregolsky.pl`'s CNAME to
  `gregolsky.github.io` inherits GitHub's CAA that excludes Amazon), Let's Encrypt is
  **authorized** by that same GitHub CAA (`letsencrypt.org`), and a plain A-record host
  resolves its CAA to a permissive level — so LE issuance is not blocked.

## Security posture

Self-hosting drops CloudFront/WAF/OAC. Compensating controls:

- **ECDSA token verification** (primary gate) — 5-min replay window, URL-bound.
  The private key ships in the public PWA bundle, so it's a strong deterrent,
  not airtight auth.
- **nginx per-IP rate limiting** (`RATE_LIMIT` / `RATE_LIMIT_BURST`) → 429 on abuse.
- **fail2ban** — bans IPs that probe for nonexistent paths (see below).
- **AI-crawler blocking** — self-identifying training crawlers get `444`.
- **Host allowlist** in the resolver (SSRF hygiene) — only known music-service hosts
  are proxied to Odesli.
- The resolver has **no published host port**; it's reachable only via nginx.

There is **no WAF** (no ModSecurity, no signature matching). The controls above
are the whole story.

### fail2ban

Three jails, configured in `fail2ban/jail.d/gp-nginx.conf`:

| Jail | Catches | maxretry / bantime |
|---|---|---|
| `gp-scanner` | any **404** — path probing | 3 / 24h |
| `gp-ai-crawler` | any **444** — blocked AI crawler that kept knocking | 10 / 24h |
| `nginx-botsearch` | built-in wordpress/phpmyadmin patterns | 3 / 24h |

`gp-scanner` bans on *any* 404 rather than a path blocklist. This server has
exactly two valid paths (`/v1/resolve`, `/healthz`) plus the ACME dir, so
nothing legitimate ever 404s — a far better signal than a blocklist, and it
needs no upkeep as scanners change targets. It deliberately does **not** match
403, since the resolver returns 403 for a failed token check and a real user
can hit that with clock skew.

> The stock `nginx-botsearch` filter alone is **not** sufficient here: it only
> matches wordpress/phpmyadmin/webmail paths, and was verified to miss `/.env`
> and `/.git/config` — two of the most common probes in practice. That's why
> `gp-scanner` exists.

**⚠ Bans target the `DOCKER-USER` iptables chain, not `INPUT`.** Traffic to a
Docker *published* port is DNAT'd in `PREROUTING` and traverses `FORWARD` — it
never touches `INPUT`, so a stock fail2ban config reports IPs as banned while
they keep connecting. The `chain = DOCKER-USER` line in `[DEFAULT]` is what
makes bans real, and it must be its own key: writing
`banaction = iptables-multiport[chain=DOCKER-USER]` looks right but is silently
overridden by fail2ban's `action_` interpolation.

Verify on the Pi:

```bash
docker compose exec fail2ban fail2ban-client status gp-scanner
sudo iptables -L DOCKER-USER -n --line-numbers   # jump rule must be HERE
docker compose exec fail2ban fail2ban-regex /var/log/nginx/access.log /data/filter.d/gp-scanner.conf
```

The fail2ban container runs as **root with `NET_ADMIN` on host networking** —
unavoidable, since it edits the host's iptables. It's the only privileged
container in the stack and listens on nothing.

### AI-crawler blocking

`nginx/app.conf.template` maps ~18 known training crawlers (GPTBot, ClaudeBot,
CCBot, Bytespider, Google-Extended, PerplexityBot, …) to `444`. Applied to the
`:443` server only — the `:80` block must keep serving ACME challenges or cert
renewal breaks.

Be clear-eyed about what this buys: User-Agent is trivially spoofable, so it
only stops crawlers that *choose* to identify themselves. It does nothing about
the l9scan/leakix-style scanners that make up most background noise — that's
`gp-scanner`'s job. Test it with:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -A 'GPTBot' https://$DOMAIN/healthz  # empty reply
curl -sS https://$DOMAIN/healthz                                               # {"ok":true}
```

### Access logs

nginx writes `./data/nginx-logs/access.log` (a real file, not the image's stdout
symlink, so fail2ban can tail it). The 6h maintenance loop caps it at 50MB and
keeps one rotated generation, so scanner noise can't fill the SD card.

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
# Signed-request smoke: sign a token the same way resolver-core.test.mjs does
# (see its makeToken helper) against
# http://localhost:8787/v1/resolve?url=...&userCountry=US with Origin: http://localhost:5173
```
