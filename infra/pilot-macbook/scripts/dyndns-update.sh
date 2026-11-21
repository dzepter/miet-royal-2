#!/bin/bash
# STRATO Dynamic DNS (dyndns2) für die Pilot-Hosts – nur wenn der Router kein DynDNS übernimmt (DYNDNS_ENABLED=true).
# Passwort aus secrets/dyndns.secret (600) über eine temporäre netrc-Datei (nie in Argumenten/ps/Logs).
# Update nur bei IP-Wechsel oder spätestens alle 24 h; Antworten good/nochg = Erfolg.
set -u
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_env_file "$MR_CONFIG_DIR/dyndns.conf" || exit 0
[ "${DYNDNS_ENABLED:-false}" = true ] || exit 0
load_env_file "$MR_CONFIG_FILE" || { log "dyndns: pilot.env fehlt"; exit 1; }
SECRET="$MR_SECRETS_DIR/dyndns.secret"; [ -s "$SECRET" ] || { log "dyndns: Passwortdatei fehlt ($SECRET)"; exit 1; }
mkdir -p "$MR_RUN_DIR"
# Fatale Antworten des dyndns2-Protokolls (badauth/abuse/nohost/notfqdn/badagent) stoppen alle weiteren Updates,
# bis ein Mensch die Ursache behoben und run/dyndns-fatal entfernt hat (Provider sperren hartnäckige Clients).
if [ -f "$MR_RUN_DIR/dyndns-fatal" ]; then log "dyndns: gestoppt wegen fataler Antwort ($(cat "$MR_RUN_DIR/dyndns-fatal")) – Ursache beheben, dann run/dyndns-fatal löschen"; exit 1; fi
if [ -f "$MR_RUN_DIR/dyndns-backoff" ] && [ $(( $(now_epoch) - $(cat "$MR_RUN_DIR/dyndns-backoff" 2>/dev/null || echo 0) )) -lt 1800 ]; then exit 0; fi
# Allowlist: ausschließlich die drei Pilot-Hosts aus pilot.env – niemals www, Apex, MX oder sonstige Namen.
ALLOWED=" $(printf '%s' "${MR_PUBLIC_WEB_HOST:-}" | tr 'A-Z' 'a-z') $(printf '%s' "${MR_PUBLIC_STAFF_HOST:-}" | tr 'A-Z' 'a-z') $(printf '%s' "${MR_PUBLIC_API_HOST:-}" | tr 'A-Z' 'a-z') "
HOSTS=""
for h in $(echo "${DYNDNS_HOSTS:?}" | tr ',' ' '); do
  h="$(printf '%s' "$h" | tr 'A-Z' 'a-z')"; h="${h%.}"
  case "$h" in *[!a-z0-9.-]*|'') log "dyndns: ungültiger Hostname in DYNDNS_HOSTS – kein Update"; exit 1 ;; esac
  case "$h" in *.*) ;; *) h="$h.miet-royal.de" ;; esac   # Kurzform (pilot) ⇒ FQDN
  case "$ALLOWED" in *" $h "*) HOSTS="$HOSTS $h" ;; *) log "dyndns: $h ist kein Pilot-Host (erlaubt nur die MR_PUBLIC_*_HOST-Werte) – kein Update"; exit 1 ;; esac
done
[ -n "$HOSTS" ] || { log "dyndns: keine Hosts"; exit 1; }
IP="$(curl -4 -s --max-time 10 "${DYNDNS_IP_URL:-https://api.ipify.org}" | tr -d ' \n')"
case "$IP" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;; *) log "dyndns: öffentliche IPv4 nicht ermittelbar"; exit 1 ;; esac
LAST_IP="$(cat "$MR_RUN_DIR/dyndns-last-ip" 2>/dev/null || true)"; LAST_TS="$(cat "$MR_RUN_DIR/dyndns-last-update" 2>/dev/null || echo 0)"
if [ "$IP" = "$LAST_IP" ] && [ $(( $(now_epoch) - LAST_TS )) -lt 86400 ]; then exit 0; fi
HOST_OF_URL="$(echo "${DYNDNS_UPDATE_URL:?}" | sed -E 's#https?://([^/]+).*#\1#')"
NETRC="$MR_RUN_DIR/.dyndns-netrc"; umask 077; trap 'rm -f "$NETRC"' EXIT INT TERM
printf 'machine %s login %s password %s\n' "$HOST_OF_URL" "${DYNDNS_USER:?}" "$(tr -d '\r\n' < "$SECRET")" > "$NETRC"
ok=1
for h in $HOSTS; do
  resp="$(curl -s -G --max-time 20 --netrc-file "$NETRC" --data-urlencode "hostname=$h" --data-urlencode "myip=$IP" "$DYNDNS_UPDATE_URL" 2>/dev/null | tr -d '\r\n' | cut -c1-60)"
  case "$resp" in
    good*|nochg*) log "dyndns: $h ⇒ $resp" ;;
    badauth*|abuse*|nohost*|notfqdn*|badagent*) log "dyndns: $h FATAL: $resp – Updates gestoppt (run/dyndns-fatal)"; echo "$resp $h $(date '+%Y-%m-%dT%H:%M:%S%z')" > "$MR_RUN_DIR/dyndns-fatal"; ok=0; break ;;
    911*|dnserr*) log "dyndns: $h Provider-Fehler $resp – 30 min Pause"; now_epoch > "$MR_RUN_DIR/dyndns-backoff"; ok=0; break ;;
    *) log "dyndns: $h FEHLER: ${resp:-keine Antwort}"; ok=0 ;;
  esac
done
rm -f "$NETRC"
if [ $ok = 1 ]; then echo "$IP" > "$MR_RUN_DIR/dyndns-last-ip"; now_epoch > "$MR_RUN_DIR/dyndns-last-update"; exit 0; fi
exit 1
