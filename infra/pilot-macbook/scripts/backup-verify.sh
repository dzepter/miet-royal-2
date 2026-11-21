#!/bin/bash
# Prüft ein Backup (Default: das neueste abgeschlossene): Prüfsummen, Entschlüsselbarkeit (age-Identität der
# Automation), Manifest. Exit 0 = gültig. Aufruf: backup-verify.sh [backup-verzeichnis]
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
require_cmd age jq
DIR="${1:-}"
if [ -z "$DIR" ]; then DIR="$(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | while read -r d; do [ -f "$d/.completed" ] && echo "${d%/}"; done | sort | tail -n 1)"; fi
[ -n "$DIR" ] && [ -d "$DIR" ] || die "Kein Backup gefunden"
[ -f "$DIR/.completed" ] || die "Backup nicht abgeschlossen (.completed fehlt): $DIR"
ID="$MR_SECRETS_DIR/backup-age.key"; [ -f "$ID" ] || die "age-Identität fehlt: $ID"
( cd "$DIR" && while read -r sum name; do [ "$(sha256_file "$name")" = "$sum" ] || { echo "PRÜFSUMME FALSCH: $name"; exit 1; }; done < backup.sha256 ) || die "Prüfsummen fehlerhaft in $DIR"
for f in db.dump.age storage.tar.gz.age secrets.tar.gz.age; do
  age -d -i "$ID" "$DIR/$f" > /dev/null || die "Entschlüsselung fehlgeschlagen: $f"
done
jq -e '.timestamp and .git_sha and .migrations and .counts' "$DIR/manifest.json" >/dev/null || die "Manifest unvollständig"
if jq -e '.storage_files' "$DIR/manifest.json" >/dev/null 2>&1; then
  [ "$(wc -l < "$DIR/storage-files.sha256" | tr -d ' ')" = "$(jq -r .storage_files "$DIR/manifest.json")" ] || die "Storage-Dateiliste passt nicht zum Manifest"
fi
log "BACKUP GÜLTIG: $DIR (git $(jq -r .git_sha "$DIR/manifest.json"), Migrationen $(jq -r .migrations "$DIR/manifest.json"))"
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $DIR" > "$MR_RUN_DIR/backup-verify-last"
