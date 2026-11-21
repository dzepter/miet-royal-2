#!/bin/bash
# Erzeugt und lädt die LaunchAgents (Benutzerkontext) für alle Dienste und Timer. Idempotent: unveränderte
# plists werden NICHT neu geladen (kein Neustart laufender Dienste); geänderte werden ausgetauscht (bootout,
# warten bis entladen, bootstrap mit Wiederholung). Dienste: api worker web staff caddy (KeepAlive nur bei
# echtem Absturz, ThrottleInterval 30 s; caddy startet nur mit Freigabemarke run/caddy-enabled aus caddy-enable.sh).
# Timer: watchdog (alle 2 min), backup (täglich 03:17), backup-offsite (03:50), restore-test (04:20),
# rotate-logs (05:05), dyndns (alle 5 min, nur wenn DYNDNS_ENABLED=true). Verpasste Kalendertermine holt
# launchd nur nach dem Schlaf nach, nicht nach „aus“ – dafür stößt der Watchdog überfällige Läufe an.
set -eu
. "$(dirname "$0")/lib.sh"
mr_is_macos || die "install-launchd.sh läuft nur unter macOS (launchd)"
AGENTS="$HOME/Library/LaunchAgents"; mkdir -p "$AGENTS" "$MR_LOGS_DIR"
DOMAIN="$(svc_domain)"

write_plist() { # name program [RunAtLoad-keepalive|interval SECONDS|calendar HOUR MINUTE]
  local name="$1" program="$2" mode="$3" a="${4:-}" b="${5:-}" label plist
  label="$(svc_label "$name")"; plist="$AGENTS/$label.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$program</string></array>"
    echo "  <key>WorkingDirectory</key><string>$MR_BASE</string>"
    echo "  <key>StandardOutPath</key><string>$MR_LOGS_DIR/$name.log</string>"
    echo "  <key>StandardErrorPath</key><string>$MR_LOGS_DIR/$name.log</string>"
    echo "  <key>EnvironmentVariables</key><dict><key>MR_BASE</key><string>$MR_BASE</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>"
    case "$mode" in service) echo "  <key>ProcessType</key><string>Interactive</string>" ;; *) echo "  <key>ProcessType</key><string>Background</string>" ;; esac
    case "$mode" in
      service)
        echo "  <key>RunAtLoad</key><true/>"
        echo "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"
        echo "  <key>ThrottleInterval</key><integer>30</integer>"
        echo "  <key>ExitTimeOut</key><integer>60</integer>" ;;
      interval)
        echo "  <key>RunAtLoad</key><true/>"
        echo "  <key>StartInterval</key><integer>$a</integer>" ;;
      calendar)
        # Verpasste Termine holt launchd nur nach dem Schlaf nach (nicht nach „aus“) – Catch-up im Watchdog.
        echo "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$a</integer><key>Minute</key><integer>$b</integer></dict>" ;;
    esac
    echo '</dict></plist>'
  } > "$plist.tmp"
  plutil -lint "$plist.tmp" >/dev/null || { rm -f "$plist.tmp"; die "plist ungültig: $label"; }
  chmod 644 "$plist.tmp"
  if [ -f "$plist" ] && cmp -s "$plist.tmp" "$plist"; then
    rm -f "$plist.tmp"
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then log "LaunchAgent unverändert, bleibt geladen: $label"
    else launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null || true; log "LaunchAgent geladen: $label ($mode)"; fi
    return 0
  fi
  mv -f "$plist.tmp" "$plist"
  # Geändert: entladen, warten bis launchd den Job wirklich entfernt hat, dann laden (bootstrap kann kurz EIO melden).
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    i=0; while launchctl print "$DOMAIN/$label" >/dev/null 2>&1 && [ $i -lt 70 ]; do sleep 1; i=$((i+1)); done
  fi
  i=0; until launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null; do i=$((i+1)); [ $i -lt 5 ] || { FAILED="$FAILED $label"; warn "LaunchAgent konnte nicht geladen werden: $label"; return 0; }; sleep 2; done
  log "LaunchAgent (neu) geladen: $label ($mode)"
}
FAILED=""

for s in api worker web staff caddy; do write_plist "$s" "$MR_SCRIPTS_DIR/run-$s.sh" service; done
write_plist watchdog "$MR_SCRIPTS_DIR/watchdog.sh" interval 120
write_plist backup "$MR_SCRIPTS_DIR/backup.sh" calendar 3 17
write_plist backup-offsite "$MR_SCRIPTS_DIR/backup-offsite.sh" calendar 3 50
write_plist restore-test "$MR_SCRIPTS_DIR/restore-test.sh" calendar 4 20
write_plist rotate-logs "$MR_SCRIPTS_DIR/rotate-logs.sh" calendar 5 5
if [ "$(env_value "$MR_CONFIG_DIR/dyndns.conf" DYNDNS_ENABLED 2>/dev/null)" = "true" ]; then
  write_plist dyndns "$MR_SCRIPTS_DIR/dyndns-update.sh" interval 300
else
  launchctl bootout "$DOMAIN/$(svc_label dyndns)" 2>/dev/null || true
  log "DynDNS-Agent nicht geladen (DYNDNS_ENABLED != true)"
fi
[ -z "$FAILED" ] || die "Nicht geladen:$FAILED – launchctl print $DOMAIN/<label> prüfen"
log "launchd fertig – Status: $MR_SCRIPTS_DIR/status.sh"
