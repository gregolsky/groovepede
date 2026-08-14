#!/usr/bin/env bash
# The on-Pi half of a deploy. Runs IN the stable runtime directory (the one
# holding .env and data/), never in a git checkout.
#
# Shared deliberately by both deploy paths so the cert-safety rules can't drift
# between them:
#   - deploy.sh          — push from a dev machine over SSH
#   - ansible/site.yml   — pull, triggered by ntfy (see ansible/pull-deploy.sh)
#
# Everything here is idempotent and never issues a certificate. Bootstrapping a
# new cert is init-letsencrypt.sh's job and stays explicitly opt-in — Let's
# Encrypt allows only 5 duplicate certs per domain per 7 days, and a deploy
# silently burning that quota is the exact bug this split was written after.
#
# Usage:  ./deploy-local.sh

set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "ERROR: .env not found in $(pwd)" >&2; exit 1; }

envval() { grep "^$1=" .env | head -1 | sed -E "s/^$1=//; s/[\" \r]//g"; }
DOMAIN=$(envval DOMAIN)
HTTPS_PORT=$(envval HTTPS_PORT); HTTPS_PORT="${HTTPS_PORT:-443}"
PUID=$(envval PUID); PUID="${PUID:-10001}"
PGID=$(envval PGID); PGID="${PGID:-10001}"
[ -n "$DOMAIN" ] || { echo "ERROR: DOMAIN is empty in .env" >&2; exit 1; }

# ── Cert backup (insurance) ──────────────────────────────────────────────────
# Unconditional, before anything else runs. The invoking user can't read
# archive/ (0700, owned by PUID:PGID), so the tar runs inside the certbot image
# as that uid. Backs up live/ + archive/ + renewal/ + accounts/: live/ alone is
# dangling symlinks without archive/, and without renewal/ certbot can't renew
# a restored cert.
echo "→ Backing up Let's Encrypt cert…"
if [ -d data/certbot/conf ]; then
  BACKUP_NAME="gp-cert-$DOMAIN-$(date +%Y%m%d-%H%M%S).tar.gz"
  docker run --rm -u "$PUID:$PGID" \
    -v "$PWD/data/certbot/conf:/etc/letsencrypt:ro" -v /tmp:/backup \
    --entrypoint tar certbot/certbot -czf "/backup/$BACKUP_NAME" -C /etc/letsencrypt .
  # Keep the 10 most recent so this can't fill the SD card.
  ls -1t /tmp/gp-cert-"$DOMAIN"-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  echo "   /tmp/$BACKUP_NAME"
else
  echo "   (no data/certbot yet — nothing to back up)"
fi

# ── Cert presence check ──────────────────────────────────────────────────────
# live/$DOMAIN is 0755 and renewal/$DOMAIN.conf is 0644 in a traversable dir.
# Do NOT stat fullchain.pem directly: it's a symlink into archive/ (0700), so a
# plain `-f` on it reports "missing" even when the cert is right there.
if [ ! -d "data/certbot/conf/live/$DOMAIN" ] && [ ! -f "data/certbot/conf/renewal/$DOMAIN.conf" ]; then
  echo "ERROR: no cert found for $DOMAIN." >&2
  echo "       First-time setup? Run ./init-letsencrypt.sh here (or deploy.sh --init" >&2
  echo "       from a dev machine). Not doing it automatically — each issuance" >&2
  echo "       consumes Let's Encrypt quota (5 duplicates per 7 days)." >&2
  exit 1
fi

# ── Build + start ───────────────────────────────────────────────────────────
echo "→ Building and starting…"
# GIT_SHA surfaces in /healthz so a deploy can confirm THIS build went live,
# rather than just that some server answered.
GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
export GIT_SHA
docker compose up -d --build

echo "--- status ---"
docker compose ps

echo "--- health ---"
ok=false
for _ in $(seq 1 15); do
  if curl -fsS -k -H "Host: $DOMAIN" "https://localhost:$HTTPS_PORT/healthz"; then
    echo; ok=true; break
  fi
  sleep 2
done

if ! $ok; then
  echo "ERROR: health check never passed after deploy" >&2
  docker compose ps >&2
  docker compose logs --tail=30 nginx >&2
  exit 1
fi

if docker compose ps --format '{{.Names}} {{.State}}' | grep -qi restarting; then
  echo "ERROR: a container is stuck restarting" >&2
  docker compose ps >&2
  exit 1
fi

echo "✓ Deploy complete (commit ${GIT_SHA})."
