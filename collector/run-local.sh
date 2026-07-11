#!/usr/bin/env bash
# Runs the vel'OH collector in a 60 s loop, tagged 'local'.
# flock guarantees a single instance no matter how often this is invoked.
cd "$(dirname "$0")/.." || exit 1
exec flock -n /tmp/veloh-collect.lock node collector/collect.mjs --loop 60 --tag local
