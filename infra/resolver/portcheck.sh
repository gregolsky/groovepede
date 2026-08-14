#!/usr/bin/env bash
# Isolate port-forwarding from the app: serve a known file on an internal port,
# so an external party can fetch it through your router and confirm the path
#   public :80  →  router  →  Pi:<internal-port>
# works before blaming (or fixing) nginx/certbot.
#
# Usage:
#   ./portcheck.sh [internal-port]      # default 8080
#
# 1. Free the port first if the stack is up:  docker compose down
# 2. Run this on the Pi with the port your router forwards public 80 -> .
# 3. From OUTSIDE your LAN (phone on cellular, or ask the assistant) fetch:
#      http://<your-domain>/.well-known/acme-challenge/gp-portcheck
#    Expect the body:  gp-portcheck-ok
#
# If that succeeds, forwarding is fine and the problem is in the app stack.
# If it refuses/times out, it's the router (forwarding / double-NAT / port hog).

set -euo pipefail
PORT="${1:-8080}"

DIR="$(mktemp -d)"
mkdir -p "$DIR/.well-known/acme-challenge"
printf 'gp-portcheck-ok\n' > "$DIR/.well-known/acme-challenge/gp-portcheck"

echo "Serving $DIR on 0.0.0.0:$PORT"
echo "Local test  :  curl -s http://localhost:$PORT/.well-known/acme-challenge/gp-portcheck"
echo "External test:  curl -s http://<your-domain>/.well-known/acme-challenge/gp-portcheck   (expect: gp-portcheck-ok)"
echo "Ctrl-C to stop."
cd "$DIR"
exec python3 -m http.server "$PORT" --bind 0.0.0.0
