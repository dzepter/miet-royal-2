#!/bin/bash
# Startet alle Dienste (launchd: bootstrap + kickstart; Linux-Test: Hintergrundprozesse).
set -u
. "$(dirname "$0")/lib.sh"
rm -f "$MR_RUN_DIR/maintenance"
for s in ${1:-$MR_SERVICES}; do
  if [ "$s" = caddy ] && [ ! -f "$MR_RUN_DIR/caddy-enabled" ]; then log "caddy nicht freigegeben (caddy-enable.sh) – übersprungen"; continue; fi
  svc_start "$s"; log "gestartet: $s"
done
