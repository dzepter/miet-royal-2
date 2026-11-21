#!/bin/bash
# launchd-Wrapper: API aus dem aktiven Release (tsx, dokumentierte Produktionsmethode). Nur 127.0.0.1.
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
[ -L "$MR_CURRENT" ] || { log "kein aktives Release – Dienst wartet auf deploy.sh (Exit 0, kein Neustart durch launchd)"; exit 0; }
load_pilot_env
cd "$MR_CURRENT/apps/api" || die "kein aktives Release"
exec ./node_modules/.bin/tsx src/server.ts
