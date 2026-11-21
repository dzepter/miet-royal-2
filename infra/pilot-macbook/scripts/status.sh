#!/bin/bash
# Betriebsstatus auf einen Blick (keine Secrets). Exit 0 auch bei Problemen – pilot-check.sh liefert PASS/FAIL.
set -u
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_env_file "$MR_CONFIG_FILE" 2>/dev/null || true
load_env_file "$MR_SECRETS_FILE" 2>/dev/null || true
API="http://127.0.0.1:$(mr_api_port)"
echo "== Miet-Royal Pilot – Status $(date '+%Y-%m-%d %H:%M:%S') =="
echo "Release: $(current_release_sha 2>/dev/null || echo '-') (previous: $(previous_release_sha 2>/dev/null || echo '-'))"
for s in $MR_SERVICES; do
  if svc_is_running "$s"; then st="RUNNING"; else st="STOPPED"; fi
  printf '%-8s %s\n' "$s" "$st"
done
printf '%-8s health=%s ready=%s\n' "API" "$(http_code "$API/health")" "$(http_code "$API/ready")"
printf '%-8s %s\n' "Web" "$(http_code "http://127.0.0.1:$(mr_web_port)/robots.txt")"
printf '%-8s %s\n' "Staff" "$(http_code "http://127.0.0.1:$(mr_staff_port)/login")"
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  if mr_psql -c 'select 1' >/dev/null 2>&1; then
    echo "PostgreSQL: erreichbar"
    echo "Jobs: $(mr_psql -c "select 'waiting='||count(*) filter (where status='pending' and attempts=0)||' retrying='||count(*) filter (where status='pending' and attempts>0)||' processing='||count(*) filter (where status='processing')||' dead='||count(*) filter (where status='dead') from integration_jobs" 2>/dev/null)"
    echo "Letzter Worker-Erfolg: $(mr_psql -c "select coalesce(to_char(max(updated_at) at time zone 'Europe/Berlin','YYYY-MM-DD HH24:MI:SS'),'-') from integration_jobs where status='succeeded'" 2>/dev/null)"
    echo "Letzter Heartbeat: $(mr_psql -c "select coalesce(to_char(max(updated_at) at time zone 'Europe/Berlin','YYYY-MM-DD HH24:MI:SS'),'-') from integration_jobs where type='system.heartbeat' and status='succeeded'" 2>/dev/null)"
  else
    echo "PostgreSQL: NICHT erreichbar"
  fi
else
  echo "PostgreSQL: nicht konfiguriert (DATABASE_URL/psql)"
fi
echo "Speicher frei: $(disk_free_percent "$MR_BASE")% ($(( $(disk_free_kib "$MR_BASE") / 1024 / 1024 )) GiB) auf $MR_BASE"
LAST_BK="$(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | while read -r d; do [ -f "$d/.completed" ] && echo "$d"; done | sort | tail -n 1)"
if [ -n "$LAST_BK" ]; then echo "Letztes Backup: $(basename "$LAST_BK") ($(du -sh "$LAST_BK" 2>/dev/null | cut -f1))"; else echo "Letztes Backup: KEINES"; fi
OFF="$MR_RUN_DIR/offsite-last-success"; [ -f "$OFF" ] && echo "Letztes Off-site: $(cat "$OFF")" || echo "Letztes Off-site: -"
for h in ${MR_PUBLIC_WEB_HOST:-} ${MR_PUBLIC_STAFF_HOST:-} ${MR_PUBLIC_API_HOST:-}; do
  path="/health"; [ "$h" = "${MR_PUBLIC_WEB_HOST:-}" ] && path="/robots.txt"; [ "$h" = "${MR_PUBLIC_STAFF_HOST:-}" ] && path="/login"
  printf 'öffentlich https://%s%s -> %s\n' "$h" "$path" "$(http_code "https://$h$path" 6)"
done 2>/dev/null
[ -f "$MR_RUN_DIR/watchdog-status.txt" ] && echo "Watchdog: $(head -n 1 "$MR_RUN_DIR/watchdog-status.txt")"
