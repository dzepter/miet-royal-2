#!/bin/bash
# Restore-Test (ein Backup ist erst gültig, wenn der Restore geprüft wurde): neuestes Backup entschlüsseln, in NEUE
# Wegwerf-Datenbank + NEUES Verzeichnis zurückspielen, Migration (No-op), Zählstände gegen das Manifest, jede
# gesicherte Storage-Datei und jede Datei-Referenz der Datenbank byteidentisch (SHA-256/Bytes), API gegen den
# Restore starten (health/ready), dann aufräumen. Ergebnis IMMER in run/restore-test-last (auch bei Abbruch: FAIL).
# Berührt NIE die Pilotdatenbank oder den Pilot-Storage. Aufruf: restore-test.sh [backup-verzeichnis]
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_pilot_env
require_cmd age pg_restore psql jq tar curl
DIR="${1:-}"
if [ -z "$DIR" ]; then DIR="$(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | while read -r d; do [ -f "$d/.completed" ] && echo "${d%/}"; done | sort | tail -n 1)"; fi
[ -n "$DIR" ] && [ -f "$DIR/.completed" ] || die "Kein abgeschlossenes Backup"
ID="$MR_SECRETS_DIR/backup-age.key"; [ -f "$ID" ] || die "age-Identität fehlt"
acquire_lock restore-test 0 || die "Restore-Test läuft bereits"
TS="$(date '+%Y%m%d%H%M%S')"; RT_DB="mietroyal_pilot_rt_$TS"; WORK="$MR_TMP_DIR/restore-$TS"; RT_PORT="${MR_RESTORE_TEST_PORT:-3101}"
STATUS="$MR_RUN_DIR/restore-test-last"; RESULT_WRITTEN=0
cleanup() {
  [ "$RESULT_WRITTEN" = 1 ] || echo "FAIL $(date '+%Y-%m-%dT%H:%M:%S%z') ${DIR:-?} abgebrochen (siehe logs/restore-test.log)" > "$STATUS"
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  psql -X -q -c "DROP DATABASE IF EXISTS \"$RT_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"; release_lock
}
trap cleanup EXIT
mkdir -p "$WORK/storage"; chmod 700 "$WORK"
"$MR_SCRIPTS_DIR/backup-verify.sh" "$DIR" >/dev/null || die "Backup ungültig"
age -d -i "$ID" -o "$WORK/db.dump" "$DIR/db.dump.age"
age -d -i "$ID" -o "$WORK/storage.tar.gz" "$DIR/storage.tar.gz.age"
tar -C "$WORK/storage" -xzf "$WORK/storage.tar.gz"
# Wegwerf-DB: gleicher Host/Benutzer (PG*-Umgebung aus DATABASE_URL), anderer Datenbankname; Passwort nie in Argumenten.
[ -n "${PGDATABASE:-}" ] || die "DATABASE_URL unlesbar"
RT_URL="$(echo "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$RT_DB\1#")"   # nur für die Test-API (Umgebungsvariable)
rt_psql() { PGDATABASE="$RT_DB" psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
[ "$RT_URL" != "$DATABASE_URL" ] || die "RT_URL identisch mit DATABASE_URL (DATABASE_URL ohne Datenbanknamen?) – Abbruch"
case "$RT_URL" in */"$RT_DB"|*/"$RT_DB"\?*) ;; *) die "RT_URL zeigt nicht auf $RT_DB – Abbruch" ;; esac
[ "$RT_DB" != "$PGDATABASE" ] || die "Wegwerf-DB hieße wie die Pilot-DB – Abbruch"
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$RT_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null || die "CREATE DATABASE fehlgeschlagen (Rolle braucht CREATEDB)"
[ "$(rt_psql -c 'select current_database()' | tr -d ' ')" = "$RT_DB" ] || die "Verbindung zeigt nicht auf $RT_DB – Abbruch"
pg_restore --no-owner --no-privileges --exit-on-error -d "$RT_DB" "$WORK/db.dump" || die "pg_restore fehlgeschlagen"
# Zählstände gegen Manifest
fail=0
for t in customers processes bookings documents settlements integration_jobs mail_deliveries; do
  want="$(jq -r ".counts.$t" "$DIR/manifest.json")"; have="$(rt_psql -c "select count(*) from $t" | tr -d ' ')"
  [ "$want" = "$have" ] || { warn "Zählstand $t: Manifest $want, Restore $have"; fail=1; }
done
MIG_WANT="$(jq -r .migrations "$DIR/manifest.json")"
MIG_HAVE="$(rt_psql -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')"
[ "$MIG_WANT" = "$MIG_HAVE" ] || { warn "Migrationsstand: Manifest $MIG_WANT, Restore $MIG_HAVE"; fail=1; }
# db:migrate gegen Restore = No-op
(cd "$MR_CURRENT" && DATABASE_URL="$RT_URL" pnpm --silent db:migrate >/dev/null 2>&1) || { warn "db:migrate gegen Restore fehlgeschlagen"; fail=1; }
MIG_AFTER="$(rt_psql -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')"
[ "$MIG_AFTER" = "$MIG_HAVE" ] || { warn "db:migrate war kein No-op ($MIG_HAVE ⇒ $MIG_AFTER)"; fail=1; }
# Storage-Dateien ↔ Prüfsummenliste des Backups: jede gesicherte Datei muss byteidentisch zurückkommen.
files_total=0; files_ok=0
if [ -f "$DIR/storage-files.sha256" ]; then
  while read -r sha bytes key; do
    [ -n "$key" ] || continue
    files_total=$((files_total+1))
    f="$WORK/storage/$key"
    if [ -f "$f" ] && [ "$(sha256_file "$f")" = "$sha" ] && [ "$(file_size "$f")" = "$bytes" ]; then files_ok=$((files_ok+1)); fi
  done < "$DIR/storage-files.sha256"
  [ "$files_total" = "$files_ok" ] || { warn "Storage-Dateien: $files_ok/$files_total byteidentisch"; fail=1; }
  restored_files="$(find "$WORK/storage" -type f | wc -l | tr -d ' ')"
  [ "$restored_files" -ge "$files_total" ] || { warn "Storage-Dateien: Liste $files_total, entpackt $restored_files"; fail=1; }
fi
# Storage ↔ Dokumente/Fotos/Unterschriften (SHA-256, Bytes) – jede Datei-Referenz des Restores muss als Datei vorliegen.
docs_total=0; docs_ok=0
while IFS='|' read -r key sha bytes; do
  [ -n "$key" ] || continue
  docs_total=$((docs_total+1))
  f="$WORK/storage/$key"
  if [ -f "$f" ] && { [ -z "$sha" ] || [ "$(sha256_file "$f")" = "$sha" ]; } && [ "$(file_size "$f")" = "$bytes" ]; then docs_ok=$((docs_ok+1)); fi
done <<EOT
$(rt_psql -F '|' -c "select storage_key, sha256, byte_size from documents
  union all select storage_key, sha256, byte_size from handover_photos
  union all select storage_key, sha256, byte_size from handover_signatures
  union all select storage_key, sha256, byte_size from message_photos
  union all select storage_key, sha256, byte_size from return_photos
  union all select storage_key, sha256, byte_size from damage_photos
  union all select storage_key, sha256, byte_size from return_signatures
  union all select photo_storage_key, coalesce(photo_sha256,''), photo_byte_size from technical_defects where photo_storage_key is not null
  union all select storage_key, '', byte_size from cms_media_variants")
EOT
[ "$docs_total" = "$docs_ok" ] || { warn "Dokumente ↔ Storage: $docs_ok/$docs_total identisch"; fail=1; }
# API gegen den Restore (eigener Port, gleiche Schlüssel). exec: $! ist der API-Prozess selbst (kein Subshell-Waisenkind).
if [ "$(http_code "http://127.0.0.1:$RT_PORT/health" 2)" != "000" ]; then
  warn "Port $RT_PORT ist belegt (alter Restore-Test? MR_RESTORE_TEST_PORT ändern)"; fail=1
else
  ( cd "$MR_CURRENT/apps/api" && exec env DATABASE_URL="$RT_URL" STORAGE_FS_ROOT="$WORK/storage" API_PORT="$RT_PORT" LOG_LEVEL=warn ./node_modules/.bin/tsx src/server.ts >"$WORK/api.log" 2>&1 ) &
  API_PID=$!
  if wait_http "http://127.0.0.1:$RT_PORT/health" 200 60 && wait_http "http://127.0.0.1:$RT_PORT/ready" 200 30; then
    log "Restore-API: health/ready 200"
  else
    warn "Restore-API ohne health/ready (Log: $MR_LOGS_DIR/restore-test-api.log)"; cp "$WORK/api.log" "$MR_LOGS_DIR/restore-test-api.log" 2>/dev/null || true; fail=1
  fi
  kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; API_PID=""
  i=0; while [ $i -lt 20 ] && [ "$(http_code "http://127.0.0.1:$RT_PORT/health" 2)" != "000" ]; do sleep 1; i=$((i+1)); done
  [ "$(http_code "http://127.0.0.1:$RT_PORT/health" 2)" = "000" ] || warn "Restore-API läuft nach dem Beenden weiter (Port $RT_PORT)"
fi
if [ $fail = 0 ]; then
  echo "PASS $(date '+%Y-%m-%dT%H:%M:%S%z') $DIR files=$files_ok/$files_total docs=$docs_ok/$docs_total migrations=$MIG_HAVE" > "$STATUS"; RESULT_WRITTEN=1
  log "RESTORE-TEST PASS ($DIR): Zählstände identisch, Migration No-op, Storage-Dateien $files_ok/$files_total, Dokumente $docs_ok/$docs_total, API ok"
else
  echo "FAIL $(date '+%Y-%m-%dT%H:%M:%S%z') $DIR" > "$STATUS"; RESULT_WRITTEN=1
  die "RESTORE-TEST FAIL ($DIR) – siehe Warnungen"
fi
