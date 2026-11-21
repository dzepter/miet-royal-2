#!/bin/bash
# Miet-Royal Pilot-Kit – gemeinsame Funktionen (macOS /bin/bash 3.2 kompatibel, läuft auch unter Linux).
# Wird von allen Skripten mit `. "$(dirname "$0")/lib.sh"` geladen. Keine Secrets ausgeben.

set -u

MR_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Basisverzeichnis: Umgebungsvariable MR_BASE, sonst das Elternverzeichnis von scripts/.
MR_BASE="${MR_BASE:-$(cd "$MR_SCRIPTS_DIR/.." && pwd)}"
MR_CONFIG_DIR="$MR_BASE/config"
MR_SECRETS_DIR="$MR_BASE/secrets"
MR_RELEASES_DIR="$MR_BASE/releases"
MR_CURRENT="$MR_BASE/current"
MR_PREVIOUS="$MR_BASE/previous"
MR_STORAGE_DIR="$MR_BASE/storage"
MR_BACKUPS_DIR="$MR_BASE/backups"
MR_LOGS_DIR="$MR_BASE/logs"
MR_RUN_DIR="$MR_BASE/run"
MR_TMP_DIR="$MR_BASE/tmp"
MR_REPO_MIRROR="$MR_BASE/repo.git"
MR_CONFIG_FILE="$MR_CONFIG_DIR/pilot.env"
MR_SECRETS_FILE="$MR_SECRETS_DIR/pilot.secrets.env"
MR_LAUNCHD_PREFIX="de.mietroyal.pilot"
MR_SERVICES="api worker web staff caddy"
MR_TIMERS="watchdog backup backup-offsite restore-test rotate-logs dyndns"

mr_os() { uname -s; }
mr_is_macos() { [ "$(uname -s)" = "Darwin" ]; }

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
warn() { log "WARN $*" >&2; }
die() { log "FEHLER $*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Kommando fehlt: $c"
  done
}

# Homebrew-Präfix (Apple Silicon /opt/homebrew, Intel /usr/local); leer, wenn kein brew.
mr_brew_prefix() {
  if command -v brew >/dev/null 2>&1; then brew --prefix 2>/dev/null; return; fi
  if [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew; return; fi
  if [ -x /usr/local/bin/brew ]; then echo /usr/local; return; fi
  echo ""
}

# PATH für launchd-Kontexte (dort ist PATH minimal): Homebrew, PostgreSQL 18, Node 22.
mr_setup_path() {
  local p; p="$(mr_brew_prefix)"
  if [ -n "$p" ]; then
    PATH="$p/opt/postgresql@18/bin:$p/opt/node@22/bin:$p/bin:$p/sbin:$PATH"
  fi
  PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export PATH
}

# SHA-256 einer Datei (macOS: shasum, Linux: sha256sum) – nur der Hex-Wert.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

file_size() {
  if mr_is_macos; then stat -f %z "$1"; else stat -c %s "$1"; fi
}

# Freier Speicher in KiB und Prozent frei auf dem Dateisystem eines Pfads.
disk_free_kib() { df -k "$1" | awk 'NR==2 {print $4}'; }
disk_free_percent() { df -k "$1" | awk 'NR==2 {gsub("%","",$5); print 100-$5}'; }

# Epoch-Sekunden einer Datei (mtime).
file_mtime_epoch() {
  if mr_is_macos; then stat -f %m "$1"; else stat -c %Y "$1"; fi
}

now_epoch() { date +%s; }
ts_compact() { date '+%Y-%m-%d_%H%M%S'; }

# Umgebungsdatei (KEY=VALUE, # Kommentare) exportieren – ohne eval, ohne Echo der Werte.
load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    # umschließende, zueinander passende Anführungszeichen entfernen (dotenv-Stil: KEY="wert")
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done < "$file"
}

# Ganzzahl-Prüfung (für Schwellen/Retention: niemals mit ungeprüften Werten löschen oder vergleichen).
is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
int_or() { if is_int "${1:-}"; then echo "$1"; else echo "$2"; fi; }

# PG*-Umgebung aus DATABASE_URL ableiten, damit psql/pg_dump/pg_restore OHNE URL (und damit ohne Passwort in
# Prozessargumenten) aufgerufen werden können. Form: postgresql://user:pass@host:port/db[?...]
mr_pg_env() {
  local url="${DATABASE_URL:-}" rest auth hostpart hp
  [ -n "$url" ] || return 1
  rest="${url#*://}"; rest="${rest%%\?*}"
  case "$rest" in *@*) auth="${rest%@*}"; hostpart="${rest##*@}" ;; *) auth=""; hostpart="$rest" ;; esac
  PGDATABASE="${hostpart#*/}"; hp="${hostpart%%/*}"
  case "$hp" in *:*) PGHOST="${hp%:*}"; PGPORT="${hp##*:}" ;; *) PGHOST="$hp"; PGPORT=5432 ;; esac
  case "$auth" in *:*) PGUSER="${auth%%:*}"; PGPASSWORD="${auth#*:}" ;; *) PGUSER="$auth"; PGPASSWORD="" ;; esac
  # %xx-Dekodierung (URL-Encoding) für Benutzer/Passwort
  PGUSER="$(printf '%b' "$(printf '%s' "$PGUSER" | sed 's/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')")"
  PGPASSWORD="$(printf '%b' "$(printf '%s' "$PGPASSWORD" | sed 's/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')")"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
}

load_pilot_env() {
  load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt: $MR_CONFIG_FILE (bootstrap.sh)"
  load_env_file "$MR_SECRETS_FILE" || die "Secrets fehlen: $MR_SECRETS_FILE (configure-secrets.sh)"
  mr_pg_env || true
  export MR_BASE
}

# Wert einer Variablen aus einer env-Datei lesen, ohne alles zu exportieren.
env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

# Exklusives Lock über mkdir (macOS hat kein flock). Freigabe über trap im Aufrufer.
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //'; }
lock_is_stale() { # Lock-Verzeichnis: Halter tot ODER PID nach Neustart wiederverwendet (andere Startzeit)
  local d="$1" pid st
  pid="$(cat "$d/pid" 2>/dev/null || true)"; [ -n "$pid" ] || { [ -d "$d" ] && [ -z "$(find "$d" -mmin -2 2>/dev/null)" ]; return; }
  kill -0 "$pid" 2>/dev/null || return 0
  st="$(cat "$d/start" 2>/dev/null || true)"
  [ -n "$st" ] && [ "$(proc_start "$pid")" != "$st" ]
}
acquire_lock() {
  local name="$1" dir="$MR_RUN_DIR/lock-$1.d" waited=0 max="${2:-0}" pid
  mkdir -p "$MR_RUN_DIR"
  while ! mkdir "$dir" 2>/dev/null; do
    if lock_is_stale "$dir"; then
      pid="$(cat "$dir/pid" 2>/dev/null || true)"
      # Race: nur entfernen, wenn der Inhalt unverändert ist
      [ "$(cat "$dir/pid" 2>/dev/null || true)" = "$pid" ] && rm -rf "$dir"
      continue
    fi
    if [ "$waited" -ge "$max" ]; then return 1; fi
    sleep 1; waited=$((waited+1))
  done
  echo $$ > "$dir/pid"; proc_start $$ > "$dir/start"
  MR_LOCK_DIR="$dir"
  return 0
}
release_lock() { [ -n "${MR_LOCK_DIR:-}" ] && rm -rf "$MR_LOCK_DIR"; MR_LOCK_DIR=""; }

# HTTP-Statuscode (curl), 000 bei Verbindungsfehler. Nie Body ausgeben.
http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null)" || true
  code="${code:-000}"; echo "${code:0:3}"
}
http_body() { curl -s --max-time "${2:-5}" "$1" 2>/dev/null; }

# ---- Dienststeuerung: launchd (macOS) oder Fallback-Prozesse (Linux-Test) ----
svc_label() { echo "$MR_LAUNCHD_PREFIX.$1"; }
svc_plist() { echo "$HOME/Library/LaunchAgents/$(svc_label "$1").plist"; }
svc_domain() { echo "gui/$(id -u)"; }

svc_is_running() {
  local name="$1"
  if mr_is_macos && command -v launchctl >/dev/null 2>&1; then
    launchctl print "$(svc_domain)/$(svc_label "$name")" 2>/dev/null | grep -q 'state = running'
  else
    local pidfile="$MR_RUN_DIR/$name.pid"
    [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
  fi
}

svc_start() {
  local name="$1"
  if mr_is_macos && command -v launchctl >/dev/null 2>&1; then
    launchctl bootstrap "$(svc_domain)" "$(svc_plist "$name")" 2>/dev/null || true
    launchctl kickstart "$(svc_domain)/$(svc_label "$name")" 2>/dev/null || true
  else
    svc_is_running "$name" && return 0
    mkdir -p "$MR_RUN_DIR" "$MR_LOGS_DIR"
    nohup "$MR_SCRIPTS_DIR/run-$name.sh" >> "$MR_LOGS_DIR/$name.log" 2>&1 &
    echo $! > "$MR_RUN_DIR/$name.pid"
  fi
}

svc_stop() {
  local name="$1"
  if mr_is_macos && command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "$(svc_domain)/$(svc_label "$name")" 2>/dev/null || true
  else
    local pidfile="$MR_RUN_DIR/$name.pid" pid
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile")"
      kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      local i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
      kill -KILL "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  fi
}

# Neustart: launchd kickstart -k (beendet und startet), Fallback stop+start.
svc_restart() {
  local name="$1"
  if mr_is_macos && command -v launchctl >/dev/null 2>&1; then
    if launchctl print "$(svc_domain)/$(svc_label "$name")" >/dev/null 2>&1; then
      launchctl kickstart -k "$(svc_domain)/$(svc_label "$name")" 2>/dev/null || svc_start "$name"
    else
      svc_start "$name"
    fi
  else
    svc_stop "$name"; svc_start "$name"
  fi
}

# Warten bis URL den Status liefert (Sekunden). Rückgabe 0 bei Erfolg.
wait_http() {
  local url="$1" want="${2:-200}" max="${3:-60}" i=0 code
  while [ $i -lt "$max" ]; do
    code="$(http_code "$url" 3)"
    [ "$code" = "$want" ] && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

# Aktuelles Release (SHA) aus dem current-Symlink.
current_release_sha() {
  [ -L "$MR_CURRENT" ] || return 1
  basename "$(readlink "$MR_CURRENT")"
}
previous_release_sha() {
  [ -L "$MR_PREVIOUS" ] || return 1
  basename "$(readlink "$MR_PREVIOUS")"
}

# Symlink atomar ersetzen (rename eines temporären Symlinks).
set_symlink() {
  # Atomarer Symlink-Wechsel. "mv tmp link" würde tmp IN das Zielverzeichnis verschieben, wenn link bereits ein
  # Symlink auf ein Verzeichnis ist (GNU wie BSD). Daher: gleichnamiger Symlink in einem Hilfsverzeichnis, dann
  # mv in das Elternverzeichnis des Links – das ist ein rename(2) und ersetzt den alten Link atomar.
  local target="$1" link="$2" linkdir linkname tmpdir
  linkdir="$(dirname "$link")"; linkname="$(basename "$link")"
  tmpdir="${MR_TMP_DIR:-$linkdir}/.symlink.$$.$RANDOM"
  mkdir -p "$tmpdir" || return 1
  ln -s "$target" "$tmpdir/$linkname" || { rmdir "$tmpdir" 2>/dev/null; return 1; }
  mv -f "$tmpdir/$linkname" "$linkdir/" || { rm -f "$tmpdir/$linkname"; rmdir "$tmpdir" 2>/dev/null; return 1; }
  rmdir "$tmpdir" 2>/dev/null || true
  [ "$(readlink "$link")" = "$target" ]
}

# psql über die PG*-Umgebung aus DATABASE_URL (mr_pg_env) – das Passwort erscheint nie in Prozessargumenten.
mr_psql() { [ -n "${PGDATABASE:-}" ] || mr_pg_env || return 1; psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

# Ports aus der Konfiguration (Defaults wie im Repo).
mr_api_port() { echo "${API_PORT:-3001}"; }
mr_web_port() { echo "${WEB_PORT:-3000}"; }
mr_staff_port() { echo "${STAFF_PORT:-3002}"; }

# Verifizierten Offline-Lease-Schlüssel ermitteln (öffentlich, aus AUTH_SECRET_KEY abgeleitet).
mr_offline_lease_key() {
  local release="${1:-$MR_CURRENT}"
  (cd "$release/apps/api" && ./node_modules/.bin/tsx scripts/print-offline-lease-key.ts) | tail -n 1 | tr -d '\r'
}
