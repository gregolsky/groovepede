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

STAGING_ARG=""
[ "${1:-}" = "--staging" ] && STAGING_ARG="--staging" && echo "### Using Let's Encrypt STAGING (cert will be untrusted)"

CONF=./data/certbot/conf
WWW=./data/certbot/www
LIVE="$CONF/live/$DOMAIN"
mkdir -p "$LIVE" "$WWW"

echo "### [1/4] Writing a temporary self-signed cert so nginx can start..."
docker run --rm -v "$PWD/$CONF:/etc/letsencrypt" certbot/certbot \
  sh -c "openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '/etc/letsencrypt/live/$DOMAIN/privkey.pem' \
    -out    '/etc/letsencrypt/live/$DOMAIN/fullchain.pem' \
    -subj   '/CN=$DOMAIN'"

echo "### [2/4] Starting nginx..."
docker compose up -d nginx
sleep 3

echo "### [3/4] Removing dummy cert and requesting the real one via HTTP-01..."
rm -rf "$LIVE" "$CONF/archive/$DOMAIN" "$CONF/renewal/$DOMAIN.conf"
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
