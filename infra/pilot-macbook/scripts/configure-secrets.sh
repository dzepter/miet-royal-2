#!/bin/bash
# Sichere, interaktive Einrichtung der Secrets (Eingabe ohne Echo, umask 077, Dateien 600). Keine Secrets als
# Argumente, keine Ausgabe von Werten. Bereiche: keys | db | mail | dyndns | offsite | backup-key | all (Default).
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
umask 077
mkdir -p "$MR_SECRETS_DIR" "$MR_CONFIG_DIR" "$MR_RUN_DIR"; chmod 700 "$MR_SECRETS_DIR"
[ -f "$MR_SECRETS_FILE" ] || { : > "$MR_SECRETS_FILE"; chmod 600 "$MR_SECRETS_FILE"; }
[ -t 0 ] || die "configure-secrets.sh braucht ein interaktives Terminal (keine Secrets über Pipes/Argumente)"
trap 'rm -f "$MR_RUN_DIR/.cfg-netrc"' EXIT INT TERM

# KEY=VALUE in einer env-Datei setzen/ersetzen (Datei bleibt 600 bzw. behält ihren Modus).
set_kv() { # file key value [mode]  – Secrets-Datei 600, Konfiguration 640
  local f="$1" k="$2" v="$3" mode="${4:-}" tmp="$1.tmp.$$"
  [ -n "$mode" ] || { case "$f" in "$MR_SECRETS_FILE"|"$MR_SECRETS_DIR"/*) mode=600 ;; *) mode=640 ;; esac; }
  { [ -f "$f" ] && grep -vE "^$k=" "$f" || true; printf '%s=%s\n' "$k" "$v"; } > "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$f"
}
ask_hidden() { # prompt -> REPLY (ohne Echo)
  printf '%s' "$1" >&2; IFS= read -r -s REPLY; printf '\n' >&2
}
ask() { printf '%s' "$1" >&2; IFS= read -r REPLY; }
have_secret() { [ -n "$(env_value "$MR_SECRETS_FILE" "$1" 2>/dev/null || true)" ]; }

do_keys() {
  for k in AUTH_SECRET_KEY COMMUNICATION_PAYLOAD_KEY; do
    if have_secret "$k"; then log "$k vorhanden (unverändert)"; else
      set_kv "$MR_SECRETS_FILE" "$k" "$(openssl rand -hex 32)"; log "$k erzeugt (64 Hex-Zeichen)"
    fi
  done
}
do_db() {
  if have_secret DATABASE_URL; then log "DATABASE_URL vorhanden (setup-postgres.sh verwaltet sie)"; else
    warn "DATABASE_URL fehlt – setup-postgres.sh ausführen (erzeugt Rolle, Datenbank und Passwort)"
  fi
}
do_mail() {
  echo "STRATO-Postfach für den Pilot (smtp.strato.de:465 / imap.strato.de:993)."
  ask "Postfachadresse (Absender, z. B. pilot@miet-royal.de): "; addr="$REPLY"
  [ -n "$addr" ] || { warn "übersprungen"; return 0; }
  ask_hidden "Passwort des Postfachs (keine Anzeige): "; pw="$REPLY"
  [ -n "$pw" ] || { warn "kein Passwort – übersprungen"; return 0; }
  ask "Antwortadresse (Enter = Postfachadresse): "; reply="${REPLY:-$addr}"
  set_kv "$MR_SECRETS_FILE" MAIL_SMTP_USER "$addr"; set_kv "$MR_SECRETS_FILE" MAIL_SMTP_PASSWORD "$pw"
  set_kv "$MR_SECRETS_FILE" MAIL_IMAP_USER "$addr"; set_kv "$MR_SECRETS_FILE" MAIL_IMAP_PASSWORD "$pw"
  set_kv "$MR_CONFIG_FILE" MAIL_FROM_ADDRESS "$addr"; set_kv "$MR_CONFIG_FILE" MAIL_REPLY_ADDRESS "$reply"
  set_kv "$MR_CONFIG_FILE" MAIL_ENABLED true; set_kv "$MR_CONFIG_FILE" MAIL_IMAP_ENABLED true
  pw=""
  # Verbindungsprüfung ohne Ausgabe von Zugangsdaten (TLS-Handshake + AUTH über netrc).
  NETRC="$MR_RUN_DIR/.cfg-netrc"; printf 'machine smtp.strato.de login %s password %s\n' "$addr" "$(env_value "$MR_SECRETS_FILE" MAIL_SMTP_PASSWORD)" > "$NETRC"
  if curl -s --ssl-reqd --netrc-file "$NETRC" --url "smtps://smtp.strato.de:465" --max-time 20 -o /dev/null 2>/dev/null; then log "SMTP-Anmeldung erfolgreich (smtp.strato.de:465)"; else warn "SMTP-Anmeldung fehlgeschlagen – Zugangsdaten/Postfach prüfen"; fi
  printf 'machine imap.strato.de login %s password %s\n' "$addr" "$(env_value "$MR_SECRETS_FILE" MAIL_IMAP_PASSWORD)" > "$NETRC"
  if curl -s --netrc-file "$NETRC" --url "imaps://imap.strato.de:993/INBOX" -X 'EXAMINE INBOX' --max-time 20 -o /dev/null 2>/dev/null; then log "IMAP-Anmeldung erfolgreich (imap.strato.de:993)"; else warn "IMAP-Anmeldung fehlgeschlagen – Zugangsdaten prüfen"; fi
  rm -f "$NETRC"
  log "Credential gespeichert. Dienste neu starten: restart.sh api worker; Test: mail-smoke.sh <freigegebene Adresse>"
}
do_dyndns() {
  echo "STRATO DynDNS (nur wenn der Router kein STRATO-DynDNS übernimmt)."
  ask "Aktivieren? (j/N): "; case "$REPLY" in j|J|y|Y) ;; *) set_kv "$MR_CONFIG_DIR/dyndns.conf" DYNDNS_ENABLED false; log "DynDNS bleibt aus"; return 0 ;; esac
  ask_hidden "DynDNS-Passwort aus dem STRATO-Kundenlogin (keine Anzeige): "; pw="$REPLY"
  [ -n "$pw" ] || { warn "kein Passwort – übersprungen"; return 0; }
  printf '%s\n' "$pw" > "$MR_SECRETS_DIR/dyndns.secret"; chmod 600 "$MR_SECRETS_DIR/dyndns.secret"; pw=""
  rm -f "$MR_RUN_DIR/dyndns-fatal" "$MR_RUN_DIR/dyndns-backoff" "$MR_RUN_DIR/dyndns-last-ip"
  set_kv "$MR_CONFIG_DIR/dyndns.conf" DYNDNS_ENABLED true
  # Ein echtes Probe-Update: bei badauth & Co. bleibt DynDNS AUS (sonst würde der Agent alle 5 min erneut scheitern).
  if "$MR_SCRIPTS_DIR/dyndns-update.sh"; then log "DynDNS-Probe erfolgreich (good/nochg) – Agent: install-launchd.sh"
  else set_kv "$MR_CONFIG_DIR/dyndns.conf" DYNDNS_ENABLED false; warn "DynDNS-Probe fehlgeschlagen (logs/dyndns.log bzw. Ausgabe oben) – DynDNS bleibt AUS; Passwort/Hosts prüfen und erneut configure-secrets.sh dyndns"; fi
}
do_offsite() {
  echo "Off-site-Backup per SFTP (STRATO). Es wird ein Ed25519-Schlüssel erzeugt, dessen öffentlicher Teil bei STRATO hinterlegt wird."
  KEY="$MR_SECRETS_DIR/offsite_ed25519"
  [ -f "$KEY" ] || { ssh-keygen -q -t ed25519 -N '' -C 'mietroyal-pilot-backup' -f "$KEY"; chmod 600 "$KEY"; log "SFTP-Schlüssel erzeugt"; }
  echo "Öffentlicher Schlüssel (bei STRATO für den Backup-SFTP-Benutzer hinterlegen):"; cat "$KEY.pub"
  ask "SFTP-Host (Enter = später): "; host="$REPLY"; [ -n "$host" ] || { set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_ENABLED false; return 0; }
  ask "SFTP-Benutzer: "; user="$REPLY"
  ask "Zielverzeichnis (nicht öffentlich, Enter = backups/mietroyal-pilot): "; dir="${REPLY:-backups/mietroyal-pilot}"
  ask "Port (Enter = 22): "; port="${REPLY:-22}"
  set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_HOST "$host"; set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_USER "$user"
  set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_DIR "$dir"; set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_PORT "$port"
  KH="$MR_CONFIG_DIR/offsite_known_hosts"
  ssh-keyscan -p "$port" -t ed25519,rsa "$host" 2>/dev/null > "$KH.tmp" || true
  if [ -s "$KH.tmp" ]; then
    echo "Host-Key-Fingerabdrücke (mit den von STRATO veröffentlichten vergleichen):"; ssh-keygen -lf "$KH.tmp"
    ask "Fingerabdruck korrekt und pinnen? (j/N): "; case "$REPLY" in j|J|y|Y) mv -f "$KH.tmp" "$KH"; chmod 644 "$KH"; set_kv "$MR_CONFIG_DIR/offsite.conf" OFFSITE_ENABLED true; log "Host-Key gepinnt, Off-site aktiv" ;; *) rm -f "$KH.tmp"; warn "nicht gepinnt – Off-site bleibt aus" ;; esac
  else warn "Host-Key nicht abrufbar ($host:$port)"; fi
}
do_backup_key() {
  ID="$MR_SECRETS_DIR/backup-age.key"; REC="$MR_CONFIG_DIR/backup-recipients.txt"
  require_cmd age-keygen age
  if [ ! -f "$ID" ]; then age-keygen -o "$ID" 2>/dev/null; chmod 600 "$ID"; log "age-Identität für Backups erzeugt"; fi
  PUB="$(age-keygen -y "$ID")"
  touch "$REC"; grep -qxF "$PUB" "$REC" || echo "$PUB" >> "$REC"; chmod 644 "$REC"
  echo "Backups werden an diese Empfänger verschlüsselt (öffentliche Schlüssel): "; cat "$REC"
  ask "Zusätzlichen Offline-Empfänger (age-Public-Key von Dennis, Enter = keiner): "
  if [ -n "$REPLY" ]; then case "$REPLY" in age1[0-9a-z]*) grep -qxF "$REPLY" "$REC" || echo "$REPLY" >> "$REC" ;; *) warn "kein gültiger age-Public-Key (age1…) – nicht übernommen" ;; esac; fi
  echo "WICHTIG: Ohne die Identität $ID sind Backups unlesbar. Dennis bewahrt eine Kopie AUSSERHALB des MacBooks auf"
  echo "(Passwortmanager/Tresor), zusammen mit AUTH_SECRET_KEY und COMMUNICATION_PAYLOAD_KEY (liegen verschlüsselt im Backup)."
  ask "Identität jetzt EINMALIG anzeigen zum Abschreiben/Kopieren? (j/N): "; case "$REPLY" in j|J|y|Y) grep '^AGE-SECRET-KEY' "$ID"; echo "(Bildschirm danach leeren: clear)" ;; esac
}
AREA="${1:-all}"
case "$AREA" in
  keys) do_keys ;; db) do_db ;; mail) do_mail ;; dyndns) do_dyndns ;; offsite) do_offsite ;; backup-key) do_backup_key ;;
  all) do_keys; do_db; do_backup_key; do_mail; do_dyndns; do_offsite ;;
  *) die "Bereich unbekannt: $AREA (keys|db|mail|dyndns|offsite|backup-key|all)" ;;
esac
chmod 600 "$MR_SECRETS_FILE"
"$MR_SCRIPTS_DIR/secret-scan.sh" || warn "Secret-Scan meldet Treffer"
