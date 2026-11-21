#!/bin/bash
# Stoppt Dienste (ohne Argument alle; Reihenfolge: caddy zuerst, Worker zuletzt).
set -u
. "$(dirname "$0")/lib.sh"
ORDER="${1:-caddy web staff api worker}"
# Ohne Argument (alle Dienste): Wartungsmarke setzen, damit der Watchdog nichts neu startet (start.sh/deploy.sh heben sie auf).
[ -n "${1:-}" ] || { mkdir -p "$MR_RUN_DIR"; date '+%Y-%m-%dT%H:%M:%S%z' > "$MR_RUN_DIR/maintenance"; log "Wartungsmodus gesetzt (run/maintenance)"; }
for s in $ORDER; do svc_stop "$s"; log "gestoppt: $s"; done
