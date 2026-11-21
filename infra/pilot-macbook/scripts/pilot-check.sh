#!/bin/bash
# PASS/FAIL-Prüfliste des Piloten (keine Secrets): DNS, HTTPS/Zertifikate, Caddy, Web, Staff, API, Worker, DB,
# Storage, Backup, Off-site, Mail, dead-Jobs, Speicher, noindex, Environment-Isolation, Git-SHA. Exit 1 bei FAIL.
set -u
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt"
load_env_file "$MR_SECRETS_FILE" 2>/dev/null || true
load_env_file "$MR_CONFIG_DIR/offsite.conf" 2>/dev/null || true
load_env_file "$MR_CONFIG_DIR/dyndns.conf" 2>/dev/null || true
FAILS=0
res() { printf '%-5s %-22s %s\n' "$1" "$2" "$3"; if [ "$1" = FAIL ]; then FAILS=$((FAILS+1)); fi; return 0; }
API="http://127.0.0.1:$(mr_api_port)"
PUBIP="$(curl -4 -s --max-time 6 "${DYNDNS_IP_URL:-https://api.ipify.org}" 2>/dev/null || true)"
resolve_a() { if command -v dig >/dev/null 2>&1; then dig +short A "$1" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n 1; else getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'; fi; }
for h in ${MR_PUBLIC_WEB_HOST:-} ${MR_PUBLIC_STAFF_HOST:-} ${MR_PUBLIC_API_HOST:-}; do
  ip="$(resolve_a "$h")"
  if [ -z "$ip" ]; then res FAIL "DNS $h" "kein A-Record"
  elif [ -n "$PUBIP" ] && [ "$ip" = "$PUBIP" ]; then res PASS "DNS $h" "zeigt auf die eigene öffentliche IPv4"
  elif [ -n "$PUBIP" ]; then res FAIL "DNS $h" "A-Record ≠ eigene öffentliche IP (DynDNS?)"
  else res INFO "DNS $h" "A-Record vorhanden; eigene öffentliche IP nicht ermittelbar"; fi
done
for h in ${MR_PUBLIC_WEB_HOST:-} ${MR_PUBLIC_STAFF_HOST:-} ${MR_PUBLIC_API_HOST:-}; do
  path="/health"; [ "$h" = "${MR_PUBLIC_WEB_HOST:-}" ] && path="/robots.txt"; [ "$h" = "${MR_PUBLIC_STAFF_HOST:-}" ] && path="/login"
  # Lokal über Caddy (Host ⇒ 127.0.0.1): prüft vHost-Routing und das echte Zertifikat unabhängig von NAT-Loopback.
  lcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$h:443:127.0.0.1" "https://$h$path" 2>/dev/null || true)"; lcode="${lcode:-000}"; lcode="${lcode:0:3}"
  code="$(http_code "https://$h$path" 8)"
  if [ "$lcode" = "200" ]; then
    pem="$(echo | openssl s_client -servername "$h" -connect "127.0.0.1:443" 2>/dev/null | openssl x509 2>/dev/null)"
    end="$(printf '%s' "$pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if printf '%s' "$pem" | openssl x509 -noout -checkend $((14*86400)) >/dev/null 2>&1; then res PASS "HTTPS $h" "200 über Caddy; Zertifikat gültig bis ${end:-?}"
    else res FAIL "HTTPS $h" "Zertifikat läuft in < 14 Tagen ab (${end:-?}) – Erneuerung prüfen (logs/caddy.log, Port 80/443 von außen)"; fi
    if [ "$code" = "200" ]; then res PASS "Extern $h" "200 über die öffentliche Adresse"
    else res INFO "Extern $h" "von innen Status $code (Router ohne NAT-Loopback?) – Prüfung aus dem Mobilfunknetz maßgeblich"; fi
  elif [ "$code" = "200" ]; then res PASS "HTTPS $h" "200 über die öffentliche Adresse (lokal $lcode)"
  else res FAIL "HTTPS $h" "Status $code (lokal $lcode: DNS/Router/Caddy/Zertifikat)"; fi
  rcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 --resolve "$h:80:127.0.0.1" "http://$h/" 2>/dev/null || true)"; rcode="${rcode:-000}"; rcode="${rcode:0:3}"
  case "$rcode" in 301|308) res PASS "HTTP→HTTPS $h" "$rcode" ;; *) res FAIL "HTTP→HTTPS $h" "Status $rcode" ;; esac
done
[ -f "$MR_RUN_DIR/dyndns-fatal" ] && res FAIL "DynDNS" "gestoppt: $(cut -c1-40 "$MR_RUN_DIR/dyndns-fatal") – Zugang/Hosts prüfen, dann run/dyndns-fatal löschen"
if svc_is_running caddy; then res PASS Caddy "läuft"; elif [ -f "$MR_RUN_DIR/caddy-enabled" ]; then res FAIL Caddy "freigegeben, aber nicht aktiv (logs/caddy.log)"; else res FAIL Caddy "nicht freigegeben (caddy-enable.sh nach DNS/Router)"; fi
[ "$(http_code "http://127.0.0.1:$(mr_web_port)/robots.txt")" = 200 ] && res PASS Web "127.0.0.1:$(mr_web_port)" || res FAIL Web "lokal nicht erreichbar"
[ "$(http_code "http://127.0.0.1:$(mr_staff_port)/login")" = 200 ] && res PASS Staff "127.0.0.1:$(mr_staff_port)" || res FAIL Staff "lokal nicht erreichbar"
h="$(http_code "$API/health")"; r="$(http_code "$API/ready")"
if [ "$h" = 200 ] && [ "$r" = 200 ]; then
  env_r="$(http_body "$API/health" | sed -n 's/.*"environment":"\([a-z]*\)".*/\1/p')"
  [ "$env_r" = "${APP_ENV:-production}" ] && res PASS API "health/ready 200, environment=$env_r" || res FAIL API "environment=$env_r ≠ ${APP_ENV:-production}"
else res FAIL API "health=$h ready=$r"; fi
if [ -n "${DATABASE_URL:-}" ] && mr_psql -c 'select 1' >/dev/null 2>&1; then
  res PASS DB "erreichbar ($(mr_psql -c "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' ') Tabellen, $(mr_psql -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ') Migrationen)"
  dead="$(mr_psql -c "select count(*) from integration_jobs where status='dead'" | tr -d ' ')"; [ "$dead" = 0 ] && res PASS "dead-Jobs" "0" || res FAIL "dead-Jobs" "$dead (Einstellungen → System)"
  stalled="$(mr_psql -c "select count(*) from integration_jobs where status='pending' and run_at <= now() - interval '5 minutes'" | tr -d ' ')"
  if svc_is_running worker && [ "$stalled" = 0 ]; then res PASS Worker "läuft, keine überfälligen Jobs"; else res FAIL Worker "running=$(svc_is_running worker && echo ja || echo nein), überfällig=$stalled"; fi
else res FAIL DB "nicht erreichbar"; res INFO Worker "ohne DB nicht prüfbar"; fi
if [ "${STORAGE_DRIVER:-fs}" = fs ]; then
  if [ -d "${STORAGE_FS_ROOT:-}" ] && touch "$STORAGE_FS_ROOT/.check" 2>/dev/null; then rm -f "$STORAGE_FS_ROOT/.check"
    perm="$(if mr_is_macos; then stat -f %Lp "$STORAGE_FS_ROOT"; else stat -c %a "$STORAGE_FS_ROOT"; fi)"
    [ "$perm" = 700 ] && res PASS Storage "$STORAGE_FS_ROOT beschreibbar, Modus 700" || res FAIL Storage "Modus $perm (erwartet 700)"
  else res FAIL Storage "nicht beschreibbar: ${STORAGE_FS_ROOT:-?}"; fi
else res INFO Storage "STORAGE_DRIVER=$STORAGE_DRIVER"; fi
LAST="$(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | while read -r d; do [ -f "$d/.completed" ] && echo "${d%/}"; done | sort | tail -n 1)"
if [ -n "$LAST" ]; then age_h=$(( ($(now_epoch) - $(file_mtime_epoch "$LAST/.completed")) / 3600 )); [ "$age_h" -le 36 ] && res PASS Backup "$(basename "$LAST") (${age_h} h)" || res FAIL Backup "letztes vor ${age_h} h"; else res FAIL Backup "keines"; fi
if [ -f "$MR_RUN_DIR/restore-test-last" ]; then
  rt_age_h=$(( ($(now_epoch) - $(file_mtime_epoch "$MR_RUN_DIR/restore-test-last")) / 3600 ))
  if ! grep -q '^PASS' "$MR_RUN_DIR/restore-test-last"; then res FAIL "Restore-Test" "$(cut -c1-60 "$MR_RUN_DIR/restore-test-last")"
  elif [ "$rt_age_h" -gt 36 ]; then res FAIL "Restore-Test" "letzter PASS vor ${rt_age_h} h (Timer 04:20 prüfen)"
  else res PASS "Restore-Test" "$(cut -c1-60 "$MR_RUN_DIR/restore-test-last")"; fi
else res FAIL "Restore-Test" "noch nie gelaufen"; fi
if [ "${OFFSITE_ENABLED:-false}" = true ]; then
  if [ -f "$MR_RUN_DIR/offsite-last-success" ]; then age_h=$(( ($(now_epoch) - $(file_mtime_epoch "$MR_RUN_DIR/offsite-last-success")) / 3600 )); [ "$age_h" -le 48 ] && res PASS "Off-site" "vor ${age_h} h" || res FAIL "Off-site" "letzter Erfolg vor ${age_h} h"; else res FAIL "Off-site" "noch kein Erfolg"; fi
else res INFO "Off-site" "nicht konfiguriert (OFFSITE_ENABLED=false)"; fi
if [ "${MAIL_ENABLED:-false}" = true ]; then
  if echo | openssl s_client -connect "${MAIL_SMTP_HOST}:${MAIL_SMTP_PORT:-465}" -servername "$MAIL_SMTP_HOST" 2>/dev/null | grep -q 'Verify return code: 0'; then res PASS Mail "SMTP-TLS ${MAIL_SMTP_HOST}:${MAIL_SMTP_PORT:-465} ok (Zugang: mail-smoke.sh)"; else res FAIL Mail "SMTP-TLS zu ${MAIL_SMTP_HOST} fehlgeschlagen"; fi
else res INFO Mail "MAIL_ENABLED=false (Postfach ausstehend)"; fi
FREEP="$(disk_free_percent "$MR_BASE")"; [ "$FREEP" -gt "$(int_or "${MR_DISK_WARN_PERCENT:-}" 20)" ] && res PASS Speicher "${FREEP}% frei" || res FAIL Speicher "${FREEP}% frei"
[ "${WEB_INDEXING_ENABLED:-false}" != true ] && res PASS "WEB_INDEXING" "nicht gesetzt/false" || res FAIL "WEB_INDEXING" "true – im Pilot verboten"
robots="$(http_body "http://127.0.0.1:$(mr_web_port)/robots.txt")"; home="$(http_body "http://127.0.0.1:$(mr_web_port)/" 10)"
if echo "$robots" | grep -q 'Sitemap:'; then res FAIL noindex "robots.txt enthält Sitemap"; elif echo "$home" | grep -q 'noindex'; then res PASS noindex "meta robots noindex, keine Sitemap-Zeile"; else res FAIL noindex "kein noindex im HTML"; fi
echo "$home" | grep -q 'rel="canonical"' && res FAIL Canonical "Canonical vorhanden" || res PASS Canonical "kein Canonical"
if [ -f "$MR_CONFIG_DIR/demo.env" ] && [ -L "$MR_CURRENT" ]; then
  (cd "$MR_CURRENT" && pnpm --silent check:env-isolation "$MR_CONFIG_FILE" "$MR_CONFIG_DIR/demo.env" >/dev/null 2>&1) && res PASS "Env-Isolation" "pilot ↔ demo isoliert" || res FAIL "Env-Isolation" "Kollision"
else res INFO "Env-Isolation" "nur eine Umgebung auf diesem Rechner"; fi
CUR="$(current_release_sha 2>/dev/null || true)"; [ -n "$CUR" ] && [ -f "$MR_RELEASES_DIR/$CUR/.release-complete" ] && res PASS "Git-SHA" "$CUR (previous: $(previous_release_sha 2>/dev/null || echo -))" || res FAIL "Git-SHA" "kein vollständiges aktives Release"
res INFO "Externe Ports" "von außen prüfen (Mobilfunk): 443 offen, 80 nur Redirect, 22/5432/3000–3002 geschlossen"
echo "---"; [ $FAILS = 0 ] && echo "PILOT-CHECK: PASS" || echo "PILOT-CHECK: $FAILS FAIL"
[ $FAILS = 0 ]
