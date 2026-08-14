#!/usr/bin/env bash
# Deploy the self-hosted resolver to a Raspberry Pi over SSH.
#
# Rsyncs this stack to the Pi, then builds and starts the containers there.
# On first run — when no cert exists yet — it runs the Let's Encrypt bootstrap
# automatically.
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
#   ./deploy.sh you@192.168.1.123            # override target ad-hoc
#   ./deploy.sh you@192.168.1.123 --init     # force re-run the cert bootstrap
#
# Prereqs: ssh + rsync locally; docker + docker compose on the Pi; a filled-in
# .env here (DOMAIN, LETSENCRYPT_EMAIL, GP_PUBLIC_KEY, …).

set -euo pipefail
cd "$(dirname "$0")"

usage() { echo "Usage: $0 [user@host] [remote-dir] [--init] [--staging]   (or set PI_SSH_TARGET in deploy.env)" >&2; exit 1; }

# ── Config: load deploy.env (git-ignored), CLI args override ────────────────
[ -f deploy.env ] && { set -a; . ./deploy.env; set +a; }

POSITIONAL=(); FORCE_INIT=false; STAGING=""
for a in "$@"; do
  case "$a" in
    --init)    FORCE_INIT=true ;;
    --staging) FORCE_INIT=true; STAGING="--staging" ;;   # LE staging: untrusted cert, generous rate limits
    -*)        echo "unknown flag: $a" >&2; usage ;;
    *)         POSITIONAL+=("$a") ;;
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

# ── One shared SSH connection so you authenticate ONCE, not per command ──────
# Without this, each ssh/rsync opens its own session → a password prompt each.
# ControlMaster reuses a single connection for every call below.
SSH_CTRL="${TMPDIR:-/tmp}/gp-deploy-$(printf '%s' "$TARGET" | tr -c 'A-Za-z0-9' _).sock"
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$SSH_CTRL" -o ControlPersist=120)
RSYNC_SSH="ssh -o ControlMaster=auto -o ControlPath=$SSH_CTRL -o ControlPersist=120"
trap 'ssh -o ControlPath="$SSH_CTRL" -O exit "$TARGET" 2>/dev/null || true' EXIT
echo "→ Opening SSH connection (enter your password/passphrase once if prompted)…"
ssh "${SSH_OPTS[@]}" "$TARGET" true

echo "→ Target:     $TARGET"
echo "→ Remote dir: $REMOTE_DIR"
echo "→ Domain:     $DOMAIN"

# ── Sync ────────────────────────────────────────────────────────────────────
echo "→ Syncing files…"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR/resolver'"

# --delete keeps the remote in sync, but 'data/' (cache + certs) is excluded so
# it is neither transferred nor deleted. deploy.env is deploy-only (holds the
# SSH target) and must not land on the Pi.
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude 'data/' --exclude '.git' --exclude 'deploy.env' \
  ./ "$TARGET:$REMOTE_DIR/resolver/"

REMOTE_PI="$REMOTE_DIR/resolver"

# ── First-time cert bootstrap ───────────────────────────────────────────────
NEED_INIT=$FORCE_INIT
if ! $FORCE_INIT; then
  if ssh "${SSH_OPTS[@]}" "$TARGET" "[ ! -f '$REMOTE_PI/data/certbot/conf/live/$DOMAIN/fullchain.pem' ]"; then
    NEED_INIT=true
  fi
fi

if $NEED_INIT; then
  echo "→ No cert for $DOMAIN yet — running init-letsencrypt.sh on the Pi…"
  echo "   (needs ports 80+443 forwarded to the Pi and DNS A record $DOMAIN → your public IP)"
  ssh "${SSH_OPTS[@]}" -t "$TARGET" "cd '$REMOTE_PI' && chmod +x init-letsencrypt.sh && ./init-letsencrypt.sh $STAGING"
fi

# ── Build + start ───────────────────────────────────────────────────────────
echo "→ Building, starting, and health-checking on the Pi…"
ssh "${SSH_OPTS[@]}" "$TARGET" "set -e; cd '$REMOTE_PI' \
  && docker compose up -d --build \
  && echo '--- status ---' && docker compose ps \
  && echo '--- health ---' && (curl -fsS -k -H 'Host: $DOMAIN' https://localhost:$HTTPS_PORT/healthz && echo \
       || echo '  (local check failed — verify externally: curl https://$DOMAIN/healthz)')"

echo
echo "✓ Deployed to $TARGET. Point the PWA ODESLI_BASE at https://$DOMAIN if you haven't."
