#!/usr/bin/env bash
# Deploy the self-hosted resolver to a Raspberry Pi over SSH.
#
# Rsyncs this stack + the shared resolver-core.mjs to the Pi (preserving the
# infra/ build-context layout the Dockerfile expects), then builds and starts
# the containers there. On first run — when no cert exists yet — it runs the
# Let's Encrypt bootstrap automatically.
#
# Config is read from a git-ignored deploy.env (copy deploy.env.example), and
# any CLI arg overrides it. So you can just run `./deploy.sh` once configured.
#
# Usage:
#   ./deploy.sh [user@host] [remote-dir] [--init]
#
# Examples:
#   cp deploy.env.example deploy.env   # set PI_SSH_TARGET, then:
#   ./deploy.sh
#   ./deploy.sh gregolsky@192.168.1.123            # override target ad-hoc
#   ./deploy.sh gregolsky@192.168.1.123 --init     # force re-run the cert bootstrap
#
# Prereqs: ssh + rsync locally; docker + docker compose on the Pi; a filled-in
# .env here (DOMAIN, LETSENCRYPT_EMAIL, GP_PUBLIC_KEY, …).

set -euo pipefail
cd "$(dirname "$0")"

usage() { echo "Usage: $0 [user@host] [remote-dir] [--init]   (or set PI_SSH_TARGET in deploy.env)" >&2; exit 1; }

# ── Config: load deploy.env (git-ignored), CLI args override ────────────────
[ -f deploy.env ] && { set -a; . ./deploy.env; set +a; }

POSITIONAL=(); FORCE_INIT=false
for a in "$@"; do
  case "$a" in
    --init) FORCE_INIT=true ;;
    -*)     echo "unknown flag: $a" >&2; usage ;;
    *)      POSITIONAL+=("$a") ;;
  esac
done
TARGET="${POSITIONAL[0]:-${PI_SSH_TARGET:-}}"
REMOTE_DIR="${POSITIONAL[1]:-${PI_REMOTE_DIR:-groovepede-resolver}}"
[ -n "$TARGET" ] || { echo "ERROR: no SSH target — set PI_SSH_TARGET in deploy.env or pass user@host" >&2; usage; }

# ── Preconditions ───────────────────────────────────────────────────────────
command -v rsync >/dev/null || { echo "ERROR: rsync not found locally" >&2; exit 1; }
[ -f .env ] || { echo "ERROR: .env not found — cp .env.example .env and fill it in" >&2; exit 1; }

envval() { grep "^$1=" .env | head -1 | sed -E "s/^$1=//; s/[\" \r]//g"; }
DOMAIN=$(envval DOMAIN)
HTTPS_PORT=$(envval HTTPS_PORT); HTTPS_PORT="${HTTPS_PORT:-443}"
[ -n "$DOMAIN" ] || { echo "ERROR: DOMAIN is empty in .env" >&2; exit 1; }

echo "→ Target:     $TARGET"
echo "→ Remote dir: $REMOTE_DIR"
echo "→ Domain:     $DOMAIN"

# ── Sync ────────────────────────────────────────────────────────────────────
# Layout on the Pi must mirror the repo so `context: ..` finds resolver-core:
#   $REMOTE_DIR/resolver/resolver-core.mjs
#   $REMOTE_DIR/resolver-pi/*
echo "→ Syncing files…"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR/resolver' '$REMOTE_DIR/resolver-pi'"

rsync -az ../resolver/resolver-core.mjs "$TARGET:$REMOTE_DIR/resolver/resolver-core.mjs"

# --delete keeps the remote in sync, but 'data/' (cache + certs) is excluded so
# it is neither transferred nor deleted. deploy.env is deploy-only (holds the
# SSH target) and must not land on the Pi.
rsync -az --delete \
  --exclude 'data/' --exclude '.git' --exclude 'deploy.env' \
  ./ "$TARGET:$REMOTE_DIR/resolver-pi/"

REMOTE_PI="$REMOTE_DIR/resolver-pi"

# ── First-time cert bootstrap ───────────────────────────────────────────────
NEED_INIT=$FORCE_INIT
if ! $FORCE_INIT; then
  if ssh "$TARGET" "[ ! -f '$REMOTE_PI/data/certbot/conf/live/$DOMAIN/fullchain.pem' ]"; then
    NEED_INIT=true
  fi
fi

if $NEED_INIT; then
  echo "→ No cert for $DOMAIN yet — running init-letsencrypt.sh on the Pi…"
  echo "   (needs ports 80+443 forwarded to the Pi and DNS A record $DOMAIN → your public IP)"
  ssh -t "$TARGET" "cd '$REMOTE_PI' && chmod +x init-letsencrypt.sh && ./init-letsencrypt.sh"
fi

# ── Build + start ───────────────────────────────────────────────────────────
echo "→ Building and starting containers on the Pi…"
ssh "$TARGET" "cd '$REMOTE_PI' && docker compose up -d --build"

echo "→ Container status:"
ssh "$TARGET" "cd '$REMOTE_PI' && docker compose ps"

echo "→ Health check (from the Pi, via nginx on :$HTTPS_PORT):"
ssh "$TARGET" "curl -fsS -k -H 'Host: $DOMAIN' https://localhost:$HTTPS_PORT/healthz && echo || echo '  (local check failed — verify externally: curl https://$DOMAIN/healthz)'"

echo
echo "✓ Deployed to $TARGET. Point the PWA ODESLI_BASE at https://$DOMAIN if you haven't."
