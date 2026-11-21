#!/bin/bash
# launchd-Wrapper: Website/Portal (next start, nur 127.0.0.1). Build liegt im Release (.next).
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
[ -L "$MR_CURRENT" ] || { log "kein aktives Release – Dienst wartet auf deploy.sh (Exit 0, kein Neustart durch launchd)"; exit 0; }
load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt"
export NODE_ENV=production
cd "$MR_CURRENT/apps/web" || die "kein aktives Release"
exec ./node_modules/.bin/next start --hostname 127.0.0.1 --port "$(mr_web_port)" --keepAliveTimeout 70000
