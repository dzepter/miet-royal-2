#!/bin/bash
# Rollback auf das vorige (oder ein angegebenes) Release: nur Anwendungsversion + Neustart + Health.
# Nie Down-Migrationen, nie Dokumente/Pilotdaten löschen. Datenbank-Restore ist ein separater manueller Vorgang
# (Runbook „Restore“). Aufruf: rollback.sh [git-sha]
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_pilot_env
acquire_lock deploy 0 || die "Ein Deployment/Rollback läuft bereits"
trap 'release_lock' EXIT
CUR="$(current_release_sha 2>/dev/null || true)"
TARGET="${1:-$(previous_release_sha 2>/dev/null || true)}"
[ -n "$TARGET" ] || die "Kein Rollback-Ziel (previous fehlt); Aufruf: rollback.sh <git-sha>"
REL="$MR_RELEASES_DIR/$TARGET"
[ -f "$REL/.release-complete" ] || die "Release-Baum unvollständig oder fehlt: $REL"
[ "$TARGET" != "$CUR" ] || die "Ziel $TARGET ist bereits aktiv"
log "Rollback: current $CUR ⇒ $TARGET (Datenbankschema bleibt auf dem neuesten Stand – Migrationen sind additiv)"
[ -n "$CUR" ] && set_symlink "$MR_RELEASES_DIR/$CUR" "$MR_PREVIOUS"
set_symlink "$REL" "$MR_CURRENT"
for s in api worker web staff; do svc_restart "$s"; done
API="http://127.0.0.1:$(mr_api_port)"
if wait_http "$API/health" 200 90 && wait_http "$API/ready" 200 60 && wait_http "http://127.0.0.1:$(mr_web_port)/robots.txt" 200 120 && wait_http "http://127.0.0.1:$(mr_staff_port)/login" 200 120; then
  log "ROLLBACK OK: $TARGET aktiv (previous: $CUR)"; exit 0
fi
die "Rollback auf $TARGET ohne vollständige Health – status.sh/logs prüfen; kein automatischer weiterer Wechsel"
