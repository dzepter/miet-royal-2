#!/bin/bash
# launchd-Wrapper: Staff-App (next start, nur 127.0.0.1) mit Offline-Lease-Verifikationsschlüssel
# (öffentlich, von deploy.sh in run/offline-lease-key abgelegt; ohne Schlüssel bleibt Offline fail-closed).
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
[ -L "$MR_CURRENT" ] || { log "kein aktives Release – Dienst wartet auf deploy.sh (Exit 0, kein Neustart durch launchd)"; exit 0; }
load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt"
if [ -s "$MR_RUN_DIR/offline-lease-key" ]; then
  STAFF_OFFLINE_LEASE_VERIFICATION_KEY="$(tr -d '\r\n' < "$MR_RUN_DIR/offline-lease-key")"
  export STAFF_OFFLINE_LEASE_VERIFICATION_KEY
else
  warn "run/offline-lease-key fehlt – Offline-Lease bleibt fail-closed (deploy.sh erzeugt die Datei)"
fi
export NODE_ENV=production
cd "$MR_CURRENT/apps/staff" || die "kein aktives Release"
exec ./node_modules/.bin/next start --hostname 127.0.0.1 --port "$(mr_staff_port)" --keepAliveTimeout 70000
