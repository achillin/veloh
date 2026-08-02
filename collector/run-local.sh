#!/usr/bin/env bash
# Runs the vel'OH collector in a 60 s loop, tagged 'local'.
# flock guarantees a single instance no matter how often this is invoked.
cd "$(dirname "$0")/.." || exit 1
# machine-local secrets (JCDECAUX_API_KEY etc.) — gitignored
[ -f .env.local ] && . ./.env.local
exec flock -n /tmp/veloh-collect.lock node collector/collect.mjs --loop 60 --tag local
