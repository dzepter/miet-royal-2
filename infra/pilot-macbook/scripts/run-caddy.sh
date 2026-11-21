#!/bin/bash
# launchd-Wrapper: Caddy mit der gerenderten Konfiguration (öffentlich 80/443).
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
# Caddy läuft erst nach der DNS-Freigabe durch caddy-enable.sh (Marke run/caddy-enabled) – vorher Exit 0, damit launchd
# nicht alle 30 s neu startet und keine ACME-Anfragen ins Leere gehen.
[ -f "$MR_RUN_DIR/caddy-enabled" ] || { log "Caddy nicht freigegeben (caddy-enable.sh nach DNS/Router) – Exit 0"; exit 0; }
[ -f "$MR_CONFIG_DIR/caddy/Caddyfile" ] || { log "Caddyfile fehlt (render-caddyfile.sh) – Exit 0"; exit 0; }
export XDG_DATA_HOME="$MR_BASE/run/caddy-data" XDG_CONFIG_HOME="$MR_BASE/run/caddy-config"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
exec caddy run --config "$MR_CONFIG_DIR/caddy/Caddyfile" --adapter caddyfile
