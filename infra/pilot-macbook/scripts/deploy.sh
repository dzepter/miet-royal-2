#!/bin/bash
# Deployment eines Git-Commits als neues Release (docs/DEPLOYMENT_NOTES.md „Release-Ablauf“):
#  1 Commit prüfen (Bare-Mirror von origin)  2 Release-Ordner aus `git archive`  3 pnpm install --frozen-lockfile
#  4 Builds Web/Staff mit den Origins aus pilot.env  5 Preflight (Konfiguration, DB, Speicher, Lease-Schlüssel)
#  6 Backup vor der Migration  7 pnpm db:migrate  8 current-Symlink atomar umschalten  9 Dienste neu starten
# 10 Health/Ready/Smoke  – bei Fehler automatisch zurück auf das vorige Release (Datenbank wird NIE zurückgerollt).
# Aufruf: deploy.sh <git-sha|branch|tag> [--no-backup] [--skip-build]   (keine Secrets in Argumenten)
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
REF="${1:-}"; [ -n "$REF" ] || die "Aufruf: deploy.sh <git-sha|branch|tag> [--no-backup] [--skip-build]"
shift || true
DO_BACKUP=1; DO_BUILD=1
for a in "$@"; do case "$a" in --no-backup) DO_BACKUP=0 ;; --skip-build) DO_BUILD=0 ;; *) die "unbekannte Option $a" ;; esac; done
load_pilot_env
require_cmd git node pnpm psql curl tar
case "${MR_GIT_REMOTE:-}" in *://*@*) die "MR_GIT_REMOTE enthält Zugangsdaten – nicht erlaubt (öffentliches Repo oder SSH-Deploy-Key verwenden)" ;; esac
acquire_lock deploy 0 || die "Ein Deployment läuft bereits (run/lock-deploy.d)"
trap 'release_lock' EXIT
mkdir -p "$MR_RELEASES_DIR" "$MR_RUN_DIR" "$MR_LOGS_DIR" "$MR_TMP_DIR"

# 1 Commit prüfen
if [ ! -d "$MR_REPO_MIRROR" ]; then
  log "Bare-Mirror anlegen: $MR_REPO_MIRROR"
  git clone --quiet --mirror "${MR_GIT_REMOTE:?MR_GIT_REMOTE fehlt}" "$MR_REPO_MIRROR"
else
  git -C "$MR_REPO_MIRROR" fetch --quiet --prune origin || die "git fetch fehlgeschlagen"
fi
SHA="$(git -C "$MR_REPO_MIRROR" rev-parse --verify --quiet "$REF^{commit}" || true)"
[ -n "$SHA" ] || die "Commit nicht gefunden: $REF"
REMOTE_MAIN="$(git -C "$MR_REPO_MIRROR" rev-parse --verify --quiet refs/heads/main || true)"
log "Deployment $REF ⇒ $SHA (origin/main = ${REMOTE_MAIN:-?})"
if ! git -C "$MR_REPO_MIRROR" merge-base --is-ancestor "$SHA" "$REMOTE_MAIN" 2>/dev/null; then
  warn "Commit $SHA ist NICHT Teil von origin/main – nur mit Absicht deployen"
fi

# 2–4 Release-Baum (Reste abgebrochener Builds anderer Commits entfernen – nie current/previous)
for p in "$MR_RELEASES_DIR"/*.partial; do
  [ -d "$p" ] || continue
  case "$p" in "$MR_RELEASES_DIR"/*.partial) [ "$p" = "$MR_RELEASES_DIR/$SHA.partial" ] || { log "Rest eines abgebrochenen Builds entfernt: $(basename "$p")"; rm -rf "$p"; } ;; esac
done
REL="$MR_RELEASES_DIR/$SHA"
if [ -f "$REL/.release-complete" ]; then
  log "Release-Baum vorhanden: $REL"
else
  rm -rf "$REL.partial"; mkdir -p "$REL.partial"
  git -C "$MR_REPO_MIRROR" archive --format=tar "$SHA" | tar -x -C "$REL.partial"
  echo "$SHA" > "$REL.partial/.git-sha"
  log "Quellcode bereitgestellt; pnpm install --frozen-lockfile"
  (cd "$REL.partial" && pnpm install --frozen-lockfile --silent) || die "pnpm install fehlgeschlagen"
  if [ "$DO_BUILD" = 1 ]; then
    log "Build Web (WEB_API_ORIGIN=${WEB_API_ORIGIN:?}, WEB_APP_ENV=${WEB_APP_ENV:?})"
    (cd "$REL.partial" && WEB_API_ORIGIN="$WEB_API_ORIGIN" WEB_APP_ENV="$WEB_APP_ENV" pnpm --filter @mietroyal/web build >"$MR_LOGS_DIR/build-web.log" 2>&1) || die "Web-Build fehlgeschlagen (logs/build-web.log)"
    log "Build Staff (STAFF_API_ORIGIN=${STAFF_API_ORIGIN:?})"
    (cd "$REL.partial" && STAFF_API_ORIGIN="$STAFF_API_ORIGIN" pnpm --filter @mietroyal/staff build >"$MR_LOGS_DIR/build-staff.log" 2>&1) || die "Staff-Build fehlgeschlagen (logs/build-staff.log)"
  fi
  if [ -e "$REL" ]; then case "$REL" in "$MR_RELEASES_DIR"/*) log "Unvollständiger Release-Baum wird ersetzt: $REL"; rm -rf "$REL" ;; esac; fi
  touch "$REL.partial/.release-complete"; mv "$REL.partial" "$REL"
  log "Release gebaut: $REL"
fi

# 5 Preflight
preflight() {
  local v missing=""
  for v in APP_ENV DATABASE_URL STORAGE_DRIVER AUTH_SECRET_KEY COMMUNICATION_PAYLOAD_KEY MAIL_PUBLIC_WEB_BASE_URL WEB_APP_ENV WEB_API_ORIGIN STAFF_API_ORIGIN; do
    eval "val=\${$v:-}"; [ -n "$val" ] || missing="$missing $v"
  done
  [ -z "$missing" ] || die "Preflight: Pflichtvariablen fehlen:$missing"
  case ",${AUTH_ALLOWED_ORIGINS:-}," in
    *",https://${MR_PUBLIC_STAFF_HOST:-staff-pilot.miet-royal.de},"*) case ",${AUTH_ALLOWED_ORIGINS:-}," in *",https://${MR_PUBLIC_WEB_HOST:-pilot.miet-royal.de},"*) ;; *) warn "Preflight: AUTH_ALLOWED_ORIGINS ohne https://${MR_PUBLIC_WEB_HOST:-pilot.miet-royal.de}" ;; esac ;;
    *) warn "Preflight: AUTH_ALLOWED_ORIGINS enthält nicht https://${MR_PUBLIC_STAFF_HOST:-staff-pilot.miet-royal.de} – ältere Browser ohne Sec-Fetch-Site könnten abgelehnt werden" ;;
  esac
  [ "$APP_ENV" = "production" ] || warn "Preflight: APP_ENV=$APP_ENV (Pilot-Vorgabe: production)"
  case "$MAIL_PUBLIC_WEB_BASE_URL" in https://*) ;; *) die "Preflight: MAIL_PUBLIC_WEB_BASE_URL muss https sein" ;; esac
  case "$MAIL_PUBLIC_WEB_BASE_URL" in *www.miet-royal.de*|*localhost*|*127.0.0.1*) die "Preflight: MAIL_PUBLIC_WEB_BASE_URL darf nicht auf www/localhost zeigen (Pilot-Host!)" ;; esac
  [ "${WEB_INDEXING_ENABLED:-false}" != "true" ] || die "Preflight: WEB_INDEXING_ENABLED=true ist im Pilot verboten"
  [ "${LEXWARE_ENABLED:-false}" != "true" ] || warn "Preflight: LEXWARE_ENABLED=true – nur mit dokumentierter Freigabe"
  if [ "$STORAGE_DRIVER" = "fs" ]; then
    [ -n "${STORAGE_FS_ROOT:-}" ] || die "Preflight: STORAGE_FS_ROOT fehlt"
    mkdir -p "$STORAGE_FS_ROOT"; chmod 700 "$STORAGE_FS_ROOT" 2>/dev/null || true
    touch "$STORAGE_FS_ROOT/.write-test" && rm -f "$STORAGE_FS_ROOT/.write-test" || die "Preflight: Storage nicht beschreibbar"
  fi
  local nodev; nodev="$(node -p 'process.versions.node')"
  case "$nodev" in 22.*|23.*|24.*) ;; *) die "Preflight: Node $nodev – benötigt >= 22.12" ;; esac
  mr_psql -c 'select 1' >/dev/null || die "Preflight: PostgreSQL nicht erreichbar"
  local freep; freep="$(disk_free_percent "$MR_BASE")"
  [ "$freep" -gt "${MR_DISK_CRIT_PERCENT:-10}" ] || die "Preflight: nur ${freep}% Speicher frei"
  local key; key="$(mr_offline_lease_key "$REL")" || die "Preflight: Offline-Lease-Schlüssel nicht ableitbar (AUTH_SECRET_KEY?)"
  [ -n "$key" ] || die "Preflight: leerer Lease-Schlüssel"
  umask 022; printf '%s\n' "$key" > "$MR_RUN_DIR/offline-lease-key.tmp" && mv -f "$MR_RUN_DIR/offline-lease-key.tmp" "$MR_RUN_DIR/offline-lease-key"
  log "Preflight ok (Node $nodev, Speicher ${freep}% frei, Lease-Schlüssel hinterlegt)"
}
preflight

# 6 Backup vor der Migration
if [ "$DO_BACKUP" = 1 ] && [ -L "$MR_CURRENT" ]; then
  "$MR_SCRIPTS_DIR/backup.sh" pre-deploy || die "Backup vor dem Deployment fehlgeschlagen – Abbruch"
fi

# 7 Migration (additiv, idempotent; wird nie zurückgerollt)
log "Migrationen anwenden"
(cd "$REL" && pnpm --silent db:migrate) || die "Migration fehlgeschlagen – current bleibt unverändert"

# 8 Umschalten
OLD_SHA="$(current_release_sha 2>/dev/null || true)"
PREV_BEFORE="$(previous_release_sha 2>/dev/null || true)"
if [ -n "$OLD_SHA" ] && [ "$OLD_SHA" != "$SHA" ]; then set_symlink "$MR_RELEASES_DIR/$OLD_SHA" "$MR_PREVIOUS" || die "previous-Symlink konnte nicht gesetzt werden"; fi
set_symlink "$REL" "$MR_CURRENT" || die "current-Symlink konnte nicht gesetzt werden – Dienste unverändert"
log "current ⇒ $SHA (previous: ${OLD_SHA:--})"

# 9 Dienste neu starten (Caddy bleibt; Konfiguration unverändert); Wartungsmarke aufheben
rm -f "$MR_RUN_DIR/maintenance"
for s in api worker web staff; do svc_restart "$s" || warn "Neustart $s meldete einen Fehler"; done

# 10 Health / Ready / Smoke
API="http://127.0.0.1:$(mr_api_port)"
ok=1
wait_http "$API/health" 200 90 || { warn "API /health nicht 200"; ok=0; }
[ $ok = 1 ] && { wait_http "$API/ready" 200 60 || { warn "API /ready nicht 200"; ok=0; }; }
[ $ok = 1 ] && { wait_http "http://127.0.0.1:$(mr_web_port)/robots.txt" 200 120 || { warn "Web nicht erreichbar"; ok=0; }; }
[ $ok = 1 ] && { wait_http "http://127.0.0.1:$(mr_staff_port)/login" 200 120 || { warn "Staff nicht erreichbar"; ok=0; }; }
if [ $ok = 1 ]; then
  env_reported="$(http_body "$API/health" | sed -n 's/.*"environment":"\([a-z]*\)".*/\1/p')"
  [ "$env_reported" = "$APP_ENV" ] || { warn "Smoke: /health meldet environment=$env_reported (erwartet $APP_ENV)"; ok=0; }
  robots="$(http_body "http://127.0.0.1:$(mr_web_port)/robots.txt")"
  case "$robots" in *Sitemap:*) warn "Smoke: robots.txt enthält eine Sitemap-Zeile – Indexierung aktiv?"; ok=0 ;; esac
fi
if [ $ok = 1 ]; then
  log "DEPLOYMENT OK: $SHA aktiv"
  # Caddy-Vorlage aus dem Release übernehmen (render-caddyfile.sh validiert vor dem Austausch; laufendes Caddy lädt neu).
  if [ -f "$REL/infra/pilot-macbook/caddy/Caddyfile.template" ] && ! cmp -s "$REL/infra/pilot-macbook/caddy/Caddyfile.template" "$MR_CONFIG_DIR/caddy/Caddyfile.template" 2>/dev/null; then
    mkdir -p "$MR_CONFIG_DIR/caddy"
    cp "$REL/infra/pilot-macbook/caddy/Caddyfile.template" "$MR_CONFIG_DIR/caddy/Caddyfile.template.new" && mv -f "$MR_CONFIG_DIR/caddy/Caddyfile.template.new" "$MR_CONFIG_DIR/caddy/Caddyfile.template"
    log "Caddy-Vorlage aus dem Release aktualisiert"
    if [ -f "$MR_RUN_DIR/caddy-enabled" ]; then "$MR_SCRIPTS_DIR/render-caddyfile.sh" "$MR_CONFIG_DIR/caddy/Caddyfile.template" || warn "Caddyfile aus neuer Vorlage nicht übernommen (alte bleibt aktiv)"; fi
  fi
  # Alte Releases aufräumen: mindestens die letzten 3 behalten; current/previous (Symlink-Ziele) nie löschen.
  KEEP_CUR="$(current_release_sha 2>/dev/null || true)"; KEEP_PREV="$(previous_release_sha 2>/dev/null || true)"
  ls -1dt "$MR_RELEASES_DIR"/*/ 2>/dev/null | grep -v '\.partial/$' | tail -n +4 | while read -r d; do
    d="${d%/}"; b="$(basename "$d")"
    case "$d" in "$MR_RELEASES_DIR"/*) ;; *) continue ;; esac
    case "$b" in *.partial) continue ;; esac
    [ "$b" = "$SHA" ] && continue; [ "$b" = "${OLD_SHA:-}" ] && continue
    [ "$b" = "${KEEP_CUR:-}" ] && continue; [ "$b" = "${KEEP_PREV:-}" ] && continue
    [ -f "$d/.release-complete" ] || continue
    log "Altes Release entfernen: $b"; rm -rf "$d"
  done
  exit 0
fi
warn "Deployment FEHLGESCHLAGEN – Rückfall"
if [ -n "$OLD_SHA" ] && [ -d "$MR_RELEASES_DIR/$OLD_SHA" ]; then
  set_symlink "$MR_RELEASES_DIR/$OLD_SHA" "$MR_CURRENT" || die "Rückfall-Symlink fehlgeschlagen – manuell prüfen (status.sh)"
  # previous wieder auf den Stand vor diesem Deployment, damit rollback.sh weiterhin ein echtes Ziel hat
  if [ -n "$PREV_BEFORE" ] && [ "$PREV_BEFORE" != "$OLD_SHA" ] && [ -d "$MR_RELEASES_DIR/$PREV_BEFORE" ]; then set_symlink "$MR_RELEASES_DIR/$PREV_BEFORE" "$MR_PREVIOUS" || warn "previous-Symlink nicht zurückgesetzt"; fi
  for s in api worker web staff; do svc_restart "$s" || warn "Neustart $s meldete einen Fehler"; done
  if wait_http "$API/health" 200 90 && wait_http "$API/ready" 200 60; then
    die "Deployment von $SHA fehlgeschlagen; voriges Release $OLD_SHA wieder aktiv (Datenbank unverändert, Migrationen bleiben)"
  fi
  die "Deployment von $SHA fehlgeschlagen UND Rückfall auf $OLD_SHA ohne Health – manuell prüfen (status.sh, logs/)"
fi
die "Deployment von $SHA fehlgeschlagen; kein voriges Release vorhanden – Dienste prüfen (status.sh, logs/)"
