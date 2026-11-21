#!/bin/bash
# Tägliches Backup (docs/DEPLOYMENT_NOTES.md „Backup & Restore“): pg_dump -Fc + Storage-Tar + Secrets-Tar,
# alles age-verschlüsselt an die Empfänger aus config/backup-recipients.txt; Manifest mit Git-SHA, Migrationsstand,
# Zählständen, Größen und SHA-256; atomarer Abschluss über .completed; Retention 7 täglich / 4 wöchentlich.
# Aufruf: backup.sh [label]   (z. B. pre-deploy). Keine unverschlüsselten Secrets im Manifest.
set -eu
set -o pipefail
umask 077
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_pilot_env
require_cmd pg_dump tar age jq
LABEL="${1:-daily}"
case "$LABEL" in *[!A-Za-z0-9_-]*|'') die "Label: nur [A-Za-z0-9_-]" ;; esac
RECIPIENTS="$MR_CONFIG_DIR/backup-recipients.txt"
[ -s "$RECIPIENTS" ] || die "age-Empfänger fehlen: $RECIPIENTS (configure-secrets.sh)"
grep -vE '^(#.*|[[:space:]]*|age1[0-9a-z]+)$' "$RECIPIENTS" >/dev/null 2>&1 && die "Ungültige Zeile in $RECIPIENTS (nur age1…-Empfänger)"
acquire_lock backup 600 || die "Backup läuft bereits"
WORK=""
cleanup_partial() { # unvollständige Arbeitsverzeichnisse nie liegen lassen (enthalten ggf. Teilarchive)
  case "${WORK:-}" in "$MR_BACKUPS_DIR"/*.partial) [ -d "$WORK" ] && rm -rf "$WORK" ;; esac
  return 0
}
trap 'rc=$?; cleanup_partial; release_lock; exit $rc' EXIT
mkdir -p "$MR_BACKUPS_DIR"; chmod 700 "$MR_BACKUPS_DIR"
# Reste abgebrochener Läufe entfernen (nur *.partial, nie abgeschlossene Backups)
for p in "$MR_BACKUPS_DIR"/*.partial; do [ -d "$p" ] && { warn "Rest eines abgebrochenen Backups entfernt: $(basename "$p")"; rm -rf "$p"; }; done
TS="$(ts_compact)"; DIR="$MR_BACKUPS_DIR/${TS}_$LABEL"; WORK="$DIR.partial"
mkdir -p "$WORK"; chmod 700 "$WORK"

# Platzprüfung: grob 2× (DB + Storage) frei, sonst Abbruch ohne Löschen.
DB_KB="$(mr_psql -c "select pg_database_size(current_database())/1024" | tr -d ' ')"
ST_KB=0; [ -d "${STORAGE_FS_ROOT:-/nonexistent}" ] && ST_KB="$(du -sk "$STORAGE_FS_ROOT" | awk '{print $1}')"
NEED_KB=$(( (DB_KB + ST_KB) * 2 + 51200 )); FREE_KB="$(disk_free_kib "$MR_BASE")"
[ "$FREE_KB" -gt "$NEED_KB" ] || die "Zu wenig Speicher für ein Backup (frei ${FREE_KB} KiB, benötigt ~${NEED_KB} KiB) – Retention prüfen, nichts gelöscht"

log "Backup $LABEL ⇒ $DIR"
[ -n "${PGDATABASE:-}" ] || die "DATABASE_URL unlesbar"
# Konsistenter Datenbank-Snapshot: eine psql-Sitzung hält eine REPEATABLE-READ-Transaktion offen, exportiert den
# Snapshot, liefert daraus die Zählstände und den Migrationsstand; pg_dump liest denselben Snapshot (--snapshot).
# So beschreiben Manifest und Dump exakt denselben Zeitpunkt, obwohl API und Worker weiterlaufen.
SNAP_IN="$WORK/.snap.in"; SNAP_OUT="$WORK/.snap.out"; mkfifo "$SNAP_IN"
psql -X -q -A -t -v ON_ERROR_STOP=1 < "$SNAP_IN" > "$SNAP_OUT" 2>"$WORK/.snap.err" &
SNAP_PID=$!
exec 7> "$SNAP_IN"
snap_query() { # SQL -> erste Ergebniszeile. Zustandslos (läuft in $(...)-Subshells): Sentinel-Anzahl vor dem Senden zählen.
  local i=0 n before
  before="$(grep -c '^__END__$' "$SNAP_OUT" 2>/dev/null || true)"; before="${before:-0}"
  printf '%s;\n\\echo __END__\n' "$1" >&7
  while :; do
    n="$(grep -c '^__END__$' "$SNAP_OUT" 2>/dev/null || true)"; n="${n:-0}"   # grep -c liefert Exit 1 bei 0 Treffern (set -e!)
    [ "$n" -gt "$before" ] && break
    kill -0 "$SNAP_PID" 2>/dev/null || die "Snapshot-Sitzung beendet: $(tail -n 2 "$WORK/.snap.err" 2>/dev/null | tr '\n' ' ')"
    sleep 0.2; i=$((i+1)); [ $i -lt 1500 ] || die "Snapshot-Abfrage ohne Antwort"
  done
  awk -v n="$before" '/^__END__$/{c++; next} c==n' "$SNAP_OUT" | head -n 1
}
snap_query "BEGIN ISOLATION LEVEL REPEATABLE READ" >/dev/null
SNAP_ID="$(snap_query "select pg_export_snapshot()" | tr -d ' ')"
[ -n "$SNAP_ID" ] || die "Snapshot konnte nicht exportiert werden"
MIG="$(snap_query 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')"
COUNTS="$(snap_query "select json_build_object('customers',(select count(*) from customers),'processes',(select count(*) from processes),'bookings',(select count(*) from bookings),'documents',(select count(*) from documents),'settlements',(select count(*) from settlements),'integration_jobs',(select count(*) from integration_jobs),'mail_deliveries',(select count(*) from mail_deliveries))")"
echo "$COUNTS" | jq -e . >/dev/null 2>&1 || die "Zählstände unlesbar"
# Alles wird direkt in age verschlüsselt (Stream) – kein Klartext-Dump/-Tar berührt die Platte.
pg_dump -Fc --no-owner --no-privileges --snapshot="$SNAP_ID" | age -R "$RECIPIENTS" -o "$WORK/db.dump.age" || die "pg_dump/Verschlüsselung fehlgeschlagen"
snap_query "COMMIT" >/dev/null; exec 7>&-; wait "$SNAP_PID" 2>/dev/null || true; rm -f "$SNAP_IN" "$SNAP_OUT" "$WORK/.snap.err"
if [ "${STORAGE_DRIVER:-fs}" = "fs" ]; then
  [ -d "${STORAGE_FS_ROOT:-}" ] || die "STORAGE_FS_ROOT fehlt: ${STORAGE_FS_ROOT:-?}"
  # Prüfsummenliste ZUERST (Pfad relativ, SHA-256, Bytes), dann das Archiv: jede gelistete Datei ist im Tar;
  # Dateien, die währenddessen hinzukommen, sind höchstens zusätzlich enthalten (Restore-Test: >=).
  ( cd "$STORAGE_FS_ROOT" && find . -type f ! -name '.check' | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s  %s  %s\n' "$(sha256_file "$f")" "$(file_size "$f")" "${f#./}"; done ) > "$WORK/storage-files.sha256" || die "Storage-Prüfsummen fehlgeschlagen"
  tar -C "$STORAGE_FS_ROOT" -czf - . | age -R "$RECIPIENTS" -o "$WORK/storage.tar.gz.age" || die "Storage-Tar/Verschlüsselung fehlgeschlagen"
else
  : > "$WORK/storage-files.sha256"
  warn "STORAGE_DRIVER=$STORAGE_DRIVER – Storage-Export außerhalb dieses Skripts (S3-Variante, Runbook)"
  printf '' | age -R "$RECIPIENTS" -o "$WORK/storage.tar.gz.age" || die "Verschlüsselung fehlgeschlagen"
fi
# Schlüssel/Secrets gehören in dieselbe Sicherung – nur verschlüsselt.
tar -C "$MR_SECRETS_DIR" -czf - . | age -R "$RECIPIENTS" -o "$WORK/secrets.tar.gz.age" || die "Secrets-Tar/Verschlüsselung fehlgeschlagen"
cp "$MR_CONFIG_FILE" "$WORK/pilot.env"   # ohne Secrets

jq -n --arg ts "$TS" --arg label "$LABEL" --arg sha "$(current_release_sha 2>/dev/null || echo unknown)" \
  --arg mig "$MIG" --argjson counts "$COUNTS" --arg appenv "${APP_ENV:-}" \
  --arg db "$(file_size "$WORK/db.dump.age")" --arg st "$(file_size "$WORK/storage.tar.gz.age")" \
  --arg sf "$(wc -l < "$WORK/storage-files.sha256" | tr -d ' ')" \
  '{timestamp:$ts,label:$label,git_sha:$sha,app_env:$appenv,migrations:($mig|tonumber),counts:$counts,storage_files:($sf|tonumber),bytes:{db_dump_age:($db|tonumber),storage_tar_age:($st|tonumber)},format:"pg_dump -Fc | tar.gz | age"}' > "$WORK/manifest.json"
( cd "$WORK" && for f in db.dump.age storage.tar.gz.age secrets.tar.gz.age storage-files.sha256 manifest.json pilot.env; do printf '%s  %s\n' "$(sha256_file "$f")" "$f"; done ) > "$WORK/backup.sha256"
chmod 600 "$WORK"/*
mv "$WORK" "$DIR" && WORK="" && date '+%Y-%m-%dT%H:%M:%S%z' > "$DIR/.completed"
log "Backup abgeschlossen: $DIR ($(du -sh "$DIR" | cut -f1); DB $(( $(file_size "$DIR/db.dump.age") / 1024 )) KiB, Storage $(( $(file_size "$DIR/storage.tar.gz.age") / 1024 )) KiB in $(wc -l < "$DIR/storage-files.sha256" | tr -d ' ') Datei(en), Migrationen $MIG)"

# Retention: täglich KEEP_DAILY Tage komplett; danach je Kalenderwoche das erste Backup bis KEEP_WEEKLY Wochen.
KEEP_D="${MR_BACKUP_KEEP_DAILY:-7}"; KEEP_W="${MR_BACKUP_KEEP_WEEKLY:-4}"
# Retention nur mit geprüften Ganzzahlen – sonst wird NICHTS gelöscht (fail-closed).
if ! is_int "$KEEP_D" || ! is_int "$KEEP_W" || [ "$KEEP_D" -lt 1 ] || [ "$KEEP_W" -lt 1 ]; then
  warn "MR_BACKUP_KEEP_DAILY/MR_BACKUP_KEEP_WEEKLY müssen Ganzzahlen ≥ 1 sein – Retention übersprungen, nichts gelöscht"
  echo "$DIR" > "$MR_RUN_DIR/backup-last-success"; exit 0
fi
NOW="$(now_epoch)"
day_epoch() { # YYYY-MM-DD -> epoch (Mitternacht lokal)
  if mr_is_macos; then date -j -f '%Y-%m-%d' "$1" '+%s'; else date -d "$1" '+%s'; fi
}
week_key() { if mr_is_macos; then date -j -f '%Y-%m-%d' "$1" '+%G-%V'; else date -d "$1" '+%G-%V'; fi; }
SEEN_WEEKS=" "
for d in $(ls -1d "$MR_BACKUPS_DIR"/*/ 2>/dev/null | sort); do
  d="${d%/}"; b="$(basename "$d")"
  [ -f "$d/.completed" ] || continue
  case "$b" in *pre-deploy*) continue ;; esac   # Vor-Deployment-Backups nur manuell entfernen
  day="${b%%_*}"; e="$(day_epoch "$day" 2>/dev/null || true)"
  is_int "$e" || continue   # unlesbarer Verzeichnisname: nie löschen
  age_days=$(( (NOW - e) / 86400 ))
  if [ "$age_days" -le "$KEEP_D" ]; then continue; fi
  wk="$(week_key "$day")"
  if [ "$age_days" -le $(( KEEP_W * 7 )) ]; then
    case "$SEEN_WEEKS" in *" $wk "*) log "Retention: entferne $b (Woche $wk bereits gesichert)"; rm -rf "$d" ;; *) SEEN_WEEKS="$SEEN_WEEKS$wk " ;; esac
  else
    log "Retention: entferne $b (älter als $KEEP_W Wochen)"; rm -rf "$d"
  fi
done
echo "$DIR" > "$MR_RUN_DIR/backup-last-success"
