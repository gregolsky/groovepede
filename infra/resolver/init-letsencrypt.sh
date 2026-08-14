#!/usr/bin/env bash
# One-time Let's Encrypt bootstrap for the self-hosted resolver.
#
# nginx can't start without a cert, and certbot's HTTP-01 challenge needs nginx
# running to serve /.well-known/acme-challenge/. This breaks the chicken/egg:
#   1. write a throwaway self-signed cert so nginx starts
#   2. bring nginx up
#   3. delete the dummy and request the real cert via the webroot (HTTP-01)
#   4. reload nginx with the real cert
#
# Prereqs: a public DNS A record for $DOMAIN → this host's public IP, and
# ports 80 + 443 forwarded to this machine. Run once; renewals are automatic.
#
# Usage:  ./init-letsencrypt.sh            (real Let's Encrypt cert)
#         ./init-letsencrypt.sh --staging  (LE staging — untrusted, avoids rate limits while testing)

set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "ERROR: .env not found (copy .env.example → .env and fill it in)"; exit 1; }
set -a; . ./.env; set +a
: "${DOMAIN:?set DOMAIN in .env}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL in .env}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "ERROR: DOMAIN has unexpected characters"; exit 1; }
PUID="${PUID:-10001}"; PGID="${PGID:-10001}"

STAGING_ARG=""
[ "${1:-}" = "--staging" ] && STAGING_ARG="--staging" && echo "### Using Let's Encrypt STAGING (cert will be untrusted)"

CONF=./data/certbot/conf
WWW=./data/certbot/www
LIVE="$CONF/live/$DOMAIN"

# nginx/certbot in docker-compose.yml run as a fixed uid:gid PUID:PGID, not
# root and not you — so everything under ./data/certbot must be owned by that
# id, and writing into it from the host (this script) needs sudo to act as it.
command -v sudo >/dev/null || { echo "ERROR: sudo not found on this host (needed to write cert files as uid $PUID)"; exit 1; }
sudo install -d -o "$PUID" -g "$PGID" -m 0755 "$LIVE" "$WWW"

# nginx writes its access log here for fail2ban to tail, so it must be
# writable by the same uid. (./data/fail2ban is fail2ban's own ban database;
# that container runs as root, but pre-creating it keeps ./data consistent.)
sudo install -d -o "$PUID" -g "$PGID" -m 0755 ./data/nginx-logs
sudo install -d -m 0755 ./data/fail2ban

echo "### [1/4] Writing a temporary self-signed cert so nginx can start..."
command -v openssl >/dev/null || { echo "ERROR: openssl not found on this host (apt install openssl)"; exit 1; }
# Write as root (some sudo builds don't support the `-u '#uid'` numeric-target
# syntax — seen failing with "sudo: unknown user #999") then hand ownership to
# PUID:PGID directly, rather than trying to run openssl itself as that uid.
if ! err=$(sudo openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "$LIVE/privkey.pem" \
  -out    "$LIVE/fullchain.pem" \
  -subj   "/CN=$DOMAIN" 2>&1 >/dev/null); then
  echo "ERROR: openssl failed to write the dummy cert:" >&2
  echo "$err" >&2
  exit 1
fi
sudo chown "$PUID:$PGID" "$LIVE/privkey.pem" "$LIVE/fullchain.pem"
sudo chmod 600 "$LIVE/privkey.pem"

echo "### [2/4] Starting nginx..."
docker compose up -d nginx
sleep 3

echo "### [3/4] Removing dummy cert and requesting the real one via HTTP-01..."
sudo rm -rf "$LIVE" "$CONF/archive/$DOMAIN" "$CONF/renewal/$DOMAIN.conf"
docker compose run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --no-eff-email --non-interactive $STAGING_ARG

echo "### [4/4] Reloading nginx with the real cert..."
docker compose exec nginx nginx -s reload

echo
echo "### Done. Bring up the full stack with:"
echo "    docker compose up -d"
echo "### Verify:  curl https://$DOMAIN/healthz"
