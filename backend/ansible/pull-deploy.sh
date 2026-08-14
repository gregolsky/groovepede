#!/usr/bin/env bash
# Pull-deploy entrypoint, run ON the Pi. Triggered by the ntfy client when CI
# publishes to the deploy topic (see .github/workflows/deploy-backend.yml), or
# runnable by hand for a dry run.
#
# This is the ONLY thing the ntfy client invokes, and it takes no arguments —
# nothing from the notification is ever interpolated into a command. A spoofed
# message on a leaked topic can therefore only re-trigger a legitimate pull of
# main; it cannot inject shell.
#
# Usage:  ./pull-deploy.sh        (or: curl -fsS <raw url> | bash)

set -euo pipefail

# Raspberry Pi OS has no en_US locale generated, and ansible aborts outright
# with "could not initialize the preferred locale" under the systemd unit's
# minimal environment. C.UTF-8 always exists.
export LC_ALL=${LC_ALL:-C.UTF-8}
export LANG=${LANG:-C.UTF-8}

REPO=${GP_REPO:-https://github.com/gregolsky/groovepede.git}
BRANCH=${GP_BRANCH:-main}
CHECKOUT=${GP_CHECKOUT:-$HOME/.ansible-pull/groovepede}

# The checkout is deliberately NOT the runtime directory. ansible-pull resets
# its checkout to a clean state on every run — if .env, data/certbot and the
# SQLite cache lived inside it, a routine pull would wipe the live certificate.
# site.yml only ever rsyncs OUT of here and into the runtime dir.
mkdir -p "$(dirname "$CHECKOUT")"

exec ansible-pull \
  --url "$REPO" \
  --checkout "$BRANCH" \
  --directory "$CHECKOUT" \
  --inventory localhost, \
  --connection local \
  backend/ansible/site.yml
