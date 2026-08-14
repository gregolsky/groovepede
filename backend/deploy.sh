#!/usr/bin/env bash
# Deploy the self-hosted resolver to a Raspberry Pi over SSH.
#
# Rsyncs this stack to the Pi, then builds and starts the containers there.
# Every run first backs up the Let's Encrypt cert (see BACKUP below). First-time
# cert issuance is NOT automatic — pass --init explicitly (see below); Let's
# Encrypt allows only 5 duplicate certs per domain per 7 days, so bootstrapping
# is opt-in, never inferred.
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
#   ./deploy.sh you@192.168.1.123 --init     # first-time: run the cert bootstrap
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
PUID=$(envval PUID); PUID="${PUID:-10001}"
PGID=$(envval PGID); PGID="${PGID:-10001}"
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

# ── Cert backup (insurance) ──────────────────────────────────────────────────
# Unconditional, before anything else touches data/certbot. The SSH user can't
# read archive/ (0700, owned by PUID:PGID — see init-letsencrypt.sh), so the
# tar runs inside the certbot image as that uid. Backs up live/ + archive/ +
# renewal/ + accounts/: live/ alone is dangling symlinks without archive/, and
# without renewal/ certbot can't renew a restored cert. Skips quietly if
# data/certbot doesn't exist yet (legitimate first-run state).
echo "→ Backing up Let's Encrypt cert…"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="gp-cert-$DOMAIN-$STAMP.tar.gz"
if ssh "${SSH_OPTS[@]}" "$TARGET" "[ -d '$REMOTE_PI/data/certbot/conf' ]"; then
  ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$REMOTE_PI' && docker run --rm -u $PUID:$PGID \
    -v \"\$PWD/data/certbot/conf:/etc/letsencrypt:ro\" -v /tmp:/backup \
    --entrypoint tar certbot/certbot -czf /backup/$BACKUP_NAME -C /etc/letsencrypt . \
    && ls -1t /tmp/gp-cert-$DOMAIN-*.tar.gz | tail -n +11 | xargs -r rm -f"
  echo "   Pi:  $TARGET:/tmp/$BACKUP_NAME"
  scp -o ControlMaster=auto -o ControlPath="$SSH_CTRL" -o ControlPersist=120 \
    "$TARGET:/tmp/$BACKUP_NAME" "${TMPDIR:-/tmp}/$BACKUP_NAME"
  echo "   Dev: ${TMPDIR:-/tmp}/$BACKUP_NAME"
else
  echo "   (no data/certbot on the Pi yet — nothing to back up)"
fi

# ── Cert presence check ──────────────────────────────────────────────────────
# live/$DOMAIN is 0755 and renewal/$DOMAIN.conf is 0644 in a traversable dir —
# both readable by the SSH user without needing to descend into archive/
# (0700, see above). Do NOT stat fullchain.pem directly: it's a symlink into
# archive/, so a plain `-f` on it silently reports "missing" even when the
# cert is right there — that bug is what caused this file to exist.
HAVE_CERT=false
if ssh "${SSH_OPTS[@]}" "$TARGET" "[ -d '$REMOTE_PI/data/certbot/conf/live/$DOMAIN' ] || [ -f '$REMOTE_PI/data/certbot/conf/renewal/$DOMAIN.conf' ]"; then
  HAVE_CERT=true
fi

# ── First-time cert bootstrap — opt-in only, never inferred ────────────────
# Issuing a cert costs one of Let's Encrypt's 5-per-7-days duplicate-cert
# quota. A missing cert must never trigger issuance automatically — only an
# explicit --init/--staging does that.
if $FORCE_INIT; then
  echo "→ Running init-letsencrypt.sh on the Pi ($([ -n "$STAGING" ] && echo staging || echo real) cert)…"
  echo "   (needs ports 80+443 forwarded to the Pi and DNS A record $DOMAIN → your public IP)"
  ssh "${SSH_OPTS[@]}" -t "$TARGET" "cd '$REMOTE_PI' && chmod +x init-letsencrypt.sh && ./init-letsencrypt.sh $STAGING"
elif ! $HAVE_CERT; then
  echo "ERROR: no cert found for $DOMAIN on $TARGET." >&2
  echo "       First-time setup? Run:  ./deploy.sh $TARGET --init" >&2
  echo "       (or --staging first). Not doing it automatically — each run" >&2
  echo "       consumes a Let's Encrypt issuance, and the duplicate-cert limit" >&2
  echo "       is 5 per 7 days." >&2
  exit 1
fi

# ── Build + start ───────────────────────────────────────────────────────────
echo "→ Building, starting, and health-checking on the Pi…"
ssh "${SSH_OPTS[@]}" "$TARGET" "set -e; cd '$REMOTE_PI' \
  && docker compose up -d --build \
  && echo '--- status ---' && docker compose ps \
  && echo '--- health ---' \
  && ok=false \
  && for i in \$(seq 1 15); do \
       if curl -fsS -k -H 'Host: $DOMAIN' https://localhost:$HTTPS_PORT/healthz; then echo; ok=true; break; fi; \
       sleep 2; \
     done \
  && if ! \$ok; then \
       echo 'ERROR: health check never passed after deploy' >&2; \
       docker compose ps >&2; \
       docker compose logs --tail=30 nginx >&2; \
       exit 1; \
     fi \
  && if docker compose ps --format '{{.Names}} {{.State}}' | grep -qi restarting; then \
       echo 'ERROR: a container is stuck restarting' >&2; \
       docker compose ps >&2; \
       exit 1; \
     fi"

echo
echo "✓ Deployed to $TARGET. Point the PWA ODESLI_BASE at https://$DOMAIN if you haven't."
