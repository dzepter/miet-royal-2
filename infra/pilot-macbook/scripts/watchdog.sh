#!/bin/bash
# Lokaler Health-Watchdog (launchd alle 120 s): API health/ready, Web, Staff, Caddy, Worker (Prozess + fällige Jobs
# warten < 5 min), DB, freier Speicher, Backup-Alter, dead-Jobs. Bei Ausfall eines Dienstes: Neustart mit Backoff
# (höchstens 3 Neustarts je Dienst und Stunde, danach CRIT ohne weitere Versuche). Status: run/watchdog-status.txt.
# Optionaler Alarm per Mail (nur Statuswechsel, höchstens alle 6 h) an MR_ALERT_MAIL_TO, wenn Mail konfiguriert ist.
set -u
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_env_file "$MR_CONFIG_FILE" || exit 0
load_env_file "$MR_SECRETS_FILE" 2>/dev/null || true
mkdir -p "$MR_RUN_DIR" "$MR_LOGS_DIR"
STAMP0="$(date '+%Y-%m-%dT%H:%M:%S%z')"
if [ -f "$MR_RUN_DIR/maintenance" ]; then
  echo "MAINT $STAMP0 | Wartungsmodus (stop.sh) – Watchdog greift nicht ein; start.sh/deploy.sh beenden ihn" > "$MR_RUN_DIR/watchdog-status.txt"; exit 0
fi
if [ -d "$MR_RUN_DIR/lock-deploy.d" ]; then
  echo "INFO $STAMP0 | Deployment läuft – Watchdog wartet" > "$MR_RUN_DIR/watchdog-status.txt"; exit 0
fi
acquire_lock watchdog 0 || { echo "WARN $STAMP0 | Watchdog-Lock belegt (run/lock-watchdog.d)" > "$MR_RUN_DIR/watchdog-status.txt"; exit 0; }
NETRC=""; BODY=""
trap 'rm -f "${NETRC:-}" "${BODY:-}"; release_lock' EXIT INT TERM
API="http://127.0.0.1:$(mr_api_port)"
NOW="$(now_epoch)"; LEVEL=OK; MSG=""
note() { LEVEL="$1"; MSG="$MSG | $2"; }
worse() { case "$1:$2" in CRIT:*) echo CRIT ;; *:CRIT) echo CRIT ;; WARN:*) echo WARN ;; *:WARN) echo WARN ;; *) echo OK ;; esac; }
set_level() { LEVEL="$(worse "$LEVEL" "$1")"; MSG="$MSG | $2"; }

# Neustart mit Backoff: höchstens 3 je Stunde.
try_restart() {
  local s="$1" f="$MR_RUN_DIR/watchdog-restarts-$1" n
  touch "$f"; awk -v now="$NOW" '$1 > now-3600' "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"
  n="$(wc -l < "$f" | tr -d ' ')"
  if [ "$n" -ge 3 ]; then set_level CRIT "$s: 3 Neustarts/Stunde erreicht – kein weiterer Versuch"; return 1; fi
  echo "$NOW" >> "$f"; svc_restart "$s"; set_level WARN "$s neu gestartet ($((n+1))/3 in dieser Stunde)"
}

# Dienste
if [ "$(http_code "$API/health" 5)" != "200" ]; then try_restart api; else
  [ "$(http_code "$API/ready" 5)" = "200" ] || set_level CRIT "API /ready != 200 (Datenbank?)"
fi
[ "$(http_code "http://127.0.0.1:$(mr_web_port)/robots.txt" 8)" = "200" ] || try_restart web
[ "$(http_code "http://127.0.0.1:$(mr_staff_port)/login" 8)" = "200" ] || try_restart staff
if [ -f "$MR_RUN_DIR/caddy-enabled" ]; then
  if svc_is_running caddy; then
    WH="${MR_PUBLIC_WEB_HOST:-}"
    if [ -n "$WH" ]; then
      tcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$WH:443:127.0.0.1" "https://$WH/robots.txt" 2>/dev/null || true)"; tcode="${tcode:-000}"; tcode="${tcode:0:3}"
      if [ "$tcode" != "200" ]; then set_level CRIT "HTTPS über Caddy liefert $tcode für $WH (Zertifikat/Config?)"
      elif ! echo | openssl s_client -servername "$WH" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -checkend $((14*86400)) >/dev/null 2>&1; then set_level WARN "Zertifikat $WH läuft in < 14 Tagen ab – Erneuerung prüfen"; fi
    fi
  else try_restart caddy; fi
else set_level WARN "Caddy nicht freigegeben (caddy-enable.sh nach DNS/Router)"; fi
[ -f "$MR_RUN_DIR/dyndns-fatal" ] && set_level WARN "DynDNS gestoppt ($(cut -c1-30 "$MR_RUN_DIR/dyndns-fatal")) – run/dyndns-fatal nach Behebung löschen"
svc_is_running worker || try_restart worker

# Catch-up: launchd holt Kalendertermine nur nach dem Schlaf nach, nicht nach „aus“/Neustart. Überfällige Läufe
# werden hier angestoßen (die mkdir-Locks der Skripte verhindern Doppelläufe).
catch_up() { # name script maxage_s statusfile
  local f="$4"
  [ -L "$MR_CURRENT" ] || return 0
  if [ ! -f "$f" ] || [ $(( NOW - $(file_mtime_epoch "$f") )) -gt "$3" ]; then
    if [ ! -d "$MR_RUN_DIR/lock-$1.d" ]; then
      log "Catch-up: $1 überfällig – wird gestartet"
      nohup "$MR_SCRIPTS_DIR/$2" >> "$MR_LOGS_DIR/$1.log" 2>&1 &
    fi
  fi
}
catch_up backup backup.sh 90000 "$MR_RUN_DIR/backup-last-success"
[ "$(env_value "$MR_CONFIG_DIR/offsite.conf" OFFSITE_ENABLED 2>/dev/null)" = true ] && catch_up backup-offsite backup-offsite.sh 90000 "$MR_RUN_DIR/offsite-last-success"
[ -f "$MR_RUN_DIR/backup-last-success" ] && catch_up restore-test restore-test.sh 93600 "$MR_RUN_DIR/restore-test-last"

# Datenbank + Jobs
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  if JOBS="$(mr_psql -c "select count(*) filter (where status='dead')||' '||count(*) filter (where status='pending' and run_at <= now() - interval '5 minutes')||' '||coalesce(extract(epoch from now()-max(updated_at) filter (where status='succeeded')),0)::bigint from integration_jobs" 2>/dev/null)"; then
    dead="$(echo "$JOBS" | awk '{print $1}')"; stalled="$(echo "$JOBS" | awk '{print $2}')"
    [ "${dead:-0}" = "0" ] || set_level WARN "dead-Jobs: $dead (Einstellungen → System)"
    if [ "${stalled:-0}" != "0" ]; then set_level CRIT "Worker verarbeitet nicht: $stalled fällige Jobs warten > 5 min"; try_restart worker; fi
  elif mr_psql -c 'select 1' >/dev/null 2>&1; then
    set_level WARN "Job-Abfrage fehlgeschlagen (Schema?)"
  else
    set_level CRIT "PostgreSQL nicht erreichbar"
  fi
fi

# Speicher
FREEP="$(disk_free_percent "$MR_BASE")"
CRIT_P="$(int_or "${MR_DISK_CRIT_PERCENT:-}" 10)"; WARN_P="$(int_or "${MR_DISK_WARN_PERCENT:-}" 20)"
if [ "$FREEP" -le "$CRIT_P" ]; then set_level CRIT "Speicher kritisch: ${FREEP}% frei (nichts gelöscht – Retention prüfen)"
elif [ "$FREEP" -le "$WARN_P" ]; then set_level WARN "Speicher knapp: ${FREEP}% frei"; fi

# Backup-Alter (< 36 h) und Restore-Test
LAST="$(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | while read -r d; do [ -f "$d/.completed" ] && echo "${d%/}"; done | sort | tail -n 1)"
if [ -z "$LAST" ]; then set_level WARN "kein abgeschlossenes Backup"; else
  age_h=$(( (NOW - $(file_mtime_epoch "$LAST/.completed")) / 3600 )); [ "$age_h" -le 36 ] || set_level WARN "letztes Backup ist ${age_h} h alt"
fi
[ -f "$MR_RUN_DIR/restore-test-last" ] && grep -q '^FAIL' "$MR_RUN_DIR/restore-test-last" && set_level WARN "letzter Restore-Test FAIL"

STAMP="$(date '+%Y-%m-%dT%H:%M:%S%z')"
{ echo "$LEVEL $STAMP${MSG:- | alles in Ordnung}"; } > "$MR_RUN_DIR/watchdog-status.txt.tmp" && mv -f "$MR_RUN_DIR/watchdog-status.txt.tmp" "$MR_RUN_DIR/watchdog-status.txt"
[ "$LEVEL" = OK ] || log "$LEVEL${MSG}"

# Alarmmail (optional): nur bei Statuswechsel, höchstens alle 6 h; Zugangsdaten über netrc-Datei (nie in Argumenten).
if [ -n "${MR_ALERT_MAIL_TO:-}" ] && [ "${MAIL_ENABLED:-false}" = "true" ] && [ -n "${MAIL_SMTP_USER:-}" ] && [ -n "${MAIL_SMTP_PASSWORD:-}" ]; then
  PREV="$(head -c 4 "$MR_RUN_DIR/watchdog-alert-level" 2>/dev/null | tr -d ' \n' || echo OK)"; LASTSENT="$(cat "$MR_RUN_DIR/watchdog-alert-sent" 2>/dev/null || echo 0)"
  if [ "$LEVEL" != "OK" ] && { [ "$LEVEL" != "$PREV" ] || [ $((NOW - LASTSENT)) -gt 21600 ]; }; then
    NETRC="$MR_RUN_DIR/.alert-netrc"; umask 077
    printf 'machine %s login %s password %s\n' "${MAIL_SMTP_HOST:-smtp.strato.de}" "$MAIL_SMTP_USER" "$MAIL_SMTP_PASSWORD" > "$NETRC"
    BODY="$MR_RUN_DIR/.alert-body"
    printf 'From: %s\r\nTo: %s\r\nSubject: [Miet-Royal Pilot] Watchdog %s\r\n\r\n%s\r\n' "${MAIL_FROM_ADDRESS:-$MAIL_SMTP_USER}" "$MR_ALERT_MAIL_TO" "$LEVEL" "$LEVEL $STAMP$MSG" > "$BODY"
    if curl -s --ssl-reqd --netrc-file "$NETRC" --url "smtps://${MAIL_SMTP_HOST:-smtp.strato.de}:${MAIL_SMTP_PORT:-465}" --mail-from "${MAIL_FROM_ADDRESS:-$MAIL_SMTP_USER}" --mail-rcpt "$MR_ALERT_MAIL_TO" -T "$BODY" >/dev/null 2>&1; then
      echo "$NOW" > "$MR_RUN_DIR/watchdog-alert-sent"; log "Alarmmail gesendet ($LEVEL)"
    else log "Alarmmail fehlgeschlagen"; fi
    rm -f "$NETRC" "$BODY"; NETRC=""; BODY=""
  fi
  echo "$LEVEL" > "$MR_RUN_DIR/watchdog-alert-level"
fi
exit 0
