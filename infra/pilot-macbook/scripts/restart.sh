#!/bin/bash
# Neustart (ohne Argument alle Dienste).
set -u
. "$(dirname "$0")/lib.sh"
rm -f "$MR_RUN_DIR/maintenance"
for s in ${1:-api worker web staff caddy}; do
  if [ "$s" = caddy ] && [ ! -f "$MR_RUN_DIR/caddy-enabled" ]; then log "caddy nicht freigegeben (caddy-enable.sh) – übersprungen"; continue; fi
  svc_restart "$s" || warn "Neustart $s meldete einen Fehler"; log "neu gestartet: $s"
done
