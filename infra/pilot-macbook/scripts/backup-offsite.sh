#!/bin/bash
# Off-site-Kopie fertiger, verschlüsselter Backups per SFTP (STRATO). Nur Archive mit .completed; Host-Key gepinnt;
# Schlüssel secrets/offsite_ed25519 (600); Größenvergleich nach dem Upload; Fehler ⇒ Exit != 0 (keine stillen Fehler).
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
CONF="$MR_CONFIG_DIR/offsite.conf"; load_env_file "$CONF" || die "offsite.conf fehlt"
if [ "${OFFSITE_ENABLED:-false}" != "true" ]; then log "Off-site deaktiviert (OFFSITE_ENABLED=false)"; exit 0; fi
require_cmd sftp age tar
RECIPIENTS="$MR_CONFIG_DIR/backup-recipients.txt"; [ -s "$RECIPIENTS" ] || die "age-Empfänger fehlen: $RECIPIENTS"
UPLOAD_FILES="db.dump.age storage.tar.gz.age secrets.tar.gz.age meta.tar.gz.age"
KEY="$MR_SECRETS_DIR/offsite_ed25519"; KH="$MR_CONFIG_DIR/offsite_known_hosts"
[ -f "$KEY" ] || die "SFTP-Schlüssel fehlt: $KEY"
[ -s "$KH" ] || die "Gepinnter Host-Key fehlt: $KH (Runbook „Off-site“: ssh-keyscan + Fingerprint prüfen)"
acquire_lock offsite 0 || die "Off-site-Lauf aktiv"
trap 'release_lock' EXIT
SSH_OPTS="-i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KH -o BatchMode=yes -o ConnectTimeout=20 -P ${OFFSITE_PORT:-22}"
TARGET="${OFFSITE_USER:?}@${OFFSITE_HOST:?}"
fail=0
for d in $(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | sort); do
  d="${d%/}"; b="$(basename "$d")"
  [ -f "$d/.completed" ] || continue
  [ -f "$d/.offsite-done" ] && continue
  # Metadaten (Manifest, Konfiguration ohne Secrets, Prüfsummen) nur verschlüsselt zum Fremdanbieter.
  if [ ! -f "$d/meta.tar.gz.age" ]; then
    ( cd "$d" && tar -czf - manifest.json pilot.env backup.sha256 $( [ -f storage-files.sha256 ] && echo storage-files.sha256 ) ) | age -R "$RECIPIENTS" -o "$d/meta.tar.gz.age.tmp" && mv -f "$d/meta.tar.gz.age.tmp" "$d/meta.tar.gz.age" || { warn "Metadaten-Archiv für $b fehlgeschlagen"; fail=1; continue; }
    chmod 600 "$d/meta.tar.gz.age"
  fi
  BATCH="$MR_TMP_DIR/offsite-$b.batch"; mkdir -p "$MR_TMP_DIR"
  {
    acc=""; for p in $(echo "${OFFSITE_DIR:?}" | tr '/' ' '); do acc="${acc:+$acc/}$p"; echo "-mkdir $acc"; done   # Pfad komponentenweise anlegen
    echo "-mkdir $OFFSITE_DIR/$b"
    for f in $UPLOAD_FILES; do [ -f "$d/$f" ] && echo "put $d/$f $OFFSITE_DIR/$b/$f"; done
    echo "ls -l $OFFSITE_DIR/$b"
  } > "$BATCH"
  # Ausgabe nur Dateinamen/Größen; keine Secrets (Dateien sind verschlüsselt).
  if OUT="$(sftp $SSH_OPTS -b "$BATCH" "$TARGET" 2>&1)"; then
    ok=1
    for f in $UPLOAD_FILES; do
      local_size="$(file_size "$d/$f")"
      # Namensspalte kann Basisname oder Pfad sein (sftp-Variante) – auf den Basisnamen reduzieren
      echo "$OUT" | awk -v f="$f" '{n=$NF; sub(/.*\//,"",n); if (n==f) print $5}' | grep -qx "$local_size" || { warn "Größe weicht ab nach Upload: $b/$f"; ok=0; }
    done
    if [ $ok = 1 ]; then date '+%Y-%m-%dT%H:%M:%S%z' > "$d/.offsite-done"; log "Off-site ok: $b"; else fail=1; fi
  else
    warn "SFTP fehlgeschlagen für $b: $(echo "$OUT" | tail -n 2 | tr '\n' ' ')"; fail=1
  fi
  rm -f "$BATCH"
done
# Entfernte Retention: nur Verzeichnisse dieses Namensschemas, älteste zuerst, OFFSITE_KEEP behalten.
LIST="$(echo "ls -1 $OFFSITE_DIR" | sftp $SSH_OPTS -b - "$TARGET" 2>/dev/null | sed 's#.*/##' | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[A-Za-z0-9_-]+$' | sort -u || true)"
N="$(echo "$LIST" | grep -c . || true)"; KEEP="${OFFSITE_KEEP:-14}"
if [ "$N" -gt "$KEEP" ]; then
  echo "$LIST" | head -n $(( N - KEEP )) | while read -r old; do
    [ -n "$old" ] || continue
    { for f in $UPLOAD_FILES storage-files.sha256 manifest.json backup.sha256 pilot.env; do echo "-rm $OFFSITE_DIR/$old/$f"; done; echo "-rmdir $OFFSITE_DIR/$old"; } | sftp $SSH_OPTS -b - "$TARGET" >/dev/null 2>&1 && log "Off-site Retention: $old entfernt" || warn "Off-site Retention: $old konnte nicht entfernt werden"
  done
fi
[ $fail = 0 ] || die "Off-site mit Fehlern (siehe oben)"
date '+%Y-%m-%dT%H:%M:%S%z' > "$MR_RUN_DIR/offsite-last-success"
