#!/bin/bash
# Lädt den Caddy-Agent erst, wenn alle Pilot-Hosts per DNS auf die eigene öffentliche IPv4 zeigen – so werden keine
# ACME-Zertifikate ins Leere angefordert (Rate-Limits). Aufruf: caddy-enable.sh [--force]
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt"
load_env_file "$MR_CONFIG_DIR/dyndns.conf" 2>/dev/null || true
FORCE="${1:-}"
PUBIP="$(curl -4 -s --max-time 8 "${DYNDNS_IP_URL:-https://api.ipify.org}" | tr -d ' \n')"
bad=0
for h in "${MR_PUBLIC_WEB_HOST:?}" "${MR_PUBLIC_STAFF_HOST:?}" "${MR_PUBLIC_API_HOST:?}"; do
  ip="$(dig +short A "$h" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n 1 || true)"   # nur Adressen (keine CNAME-Kette)
  if [ -n "$ip" ] && [ "$ip" = "$PUBIP" ]; then log "DNS ok: $h ⇒ eigene IP"; else warn "DNS: $h ⇒ ${ip:-kein A-Record} (eigene IP: ${PUBIP:-?})"; bad=1; fi
done
if [ $bad = 1 ] && [ "$FORCE" != "--force" ]; then die "DNS zeigt noch nicht auf diesen Anschluss – STRATO DynDNS/Router prüfen; Caddy nicht gestartet (mit --force erzwingen)"; fi
"$MR_SCRIPTS_DIR/render-caddyfile.sh" "$MR_CONFIG_DIR/caddy/Caddyfile.template"
# macOS-Anwendungsfirewall: das (ad-hoc signierte) Homebrew-Binary freigeben, sonst blockiert ein GUI-Dialog eingehende
# Verbindungen; nach „brew upgrade caddy“ erneut nötig (anderes Binary) – caddy-enable.sh einfach wiederholen.
if mr_is_macos && [ -x /usr/libexec/ApplicationFirewall/socketfilterfw ]; then
  # Homebrew-Symlinks sind relativ (../Cellar/...): Kette relativ zum jeweiligen Linkverzeichnis auflösen.
  p="$(command -v caddy)"; i=0
  while [ -L "$p" ] && [ $i -lt 10 ]; do t="$(readlink "$p")"; case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac; i=$((i+1)); done
  CADDY_BIN="$(cd "$(dirname "$p")" 2>/dev/null && pwd)/$(basename "$p")"
  [ -x "$CADDY_BIN" ] || CADDY_BIN="$(command -v caddy)"
  if sudo -n true 2>/dev/null || sudo -v; then
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$CADDY_BIN" >/dev/null 2>&1 || true
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$CADDY_BIN" >/dev/null 2>&1 || true
    if /usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked "$CADDY_BIN" 2>/dev/null | grep -qi "not blocked\|permitted"; then log "Firewall: eingehende Verbindungen für caddy erlaubt ($CADDY_BIN)"; else warn "Firewall-Freigabe für caddy nicht bestätigt – Dialog „caddy eingehende Verbindungen erlauben?“ mit „Erlauben“ beantworten"; fi
  else
    warn "Kein sudo: Firewall-Dialog für caddy beim ersten Start mit „Erlauben“ beantworten (Runbook §9)"
  fi
fi
mkdir -p "$MR_RUN_DIR"; date '+%Y-%m-%dT%H:%M:%S%z' > "$MR_RUN_DIR/caddy-enabled"
svc_restart caddy || svc_start caddy
sleep 3
svc_is_running caddy && log "Caddy läuft – Zertifikate werden bei erreichbarem Port 80/443 automatisch bezogen (logs/caddy.log)" || { rm -f "$MR_RUN_DIR/caddy-enabled"; die "Caddy startet nicht (logs/caddy.log) – Freigabemarke wieder entfernt"; }
