#!/bin/bash
# Einmaliger Aufbau des Pilot-Zielsystems auf dem MacBook – im Terminal aus dem Repo-Checkout ausführen:
#   bash infra/pilot-macbook/bootstrap.sh [git-sha]     (Default: HEAD des Checkouts)
# Schritte: Inventar → Homebrew-Pakete → Basisverzeichnis → Konfiguration (ohne Secrets) → PostgreSQL →
# Schlüssel/age-Identität → erstes Release (deploy.sh) → Migrationsprüfung → LaunchAgents → Netzbetrieb (pmset) →
# Caddy nur, wenn DNS bereits auf diesen Anschluss zeigt (sonst caddy-enable.sh später). Idempotent; nichts wird überschrieben.
set -eu
KIT="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$KIT/../.." && pwd)"
. "$KIT/scripts/lib.sh"
[ "$(uname -s)" = Darwin ] || { echo "bootstrap.sh ist für macOS; unter Linux nur zum Lesen."; exit 2; }
SHA="${1:-$(git -C "$REPO" rev-parse HEAD)}"
echo "== Miet-Royal Pilot-Bootstrap (Commit $SHA) =="

# Basisverzeichnis: /opt/mietroyal (sudo einmalig), sonst ~/mietroyal.
BASE="${MR_BASE:-/opt/mietroyal}"
if [ ! -d "$BASE" ]; then
  if sudo -n true 2>/dev/null || sudo -v; then sudo mkdir -p "$BASE" && sudo chown "$(id -un):$(id -gn)" "$BASE" && chmod 750 "$BASE"; else BASE="$HOME/mietroyal"; mkdir -p "$BASE"; fi
fi
[ -w "$BASE" ] || { BASE="$HOME/mietroyal"; mkdir -p "$BASE"; }
export MR_BASE="$BASE"; . "$KIT/scripts/lib.sh"
echo "Basisverzeichnis: $MR_BASE"
mkdir -p "$MR_RELEASES_DIR" "$MR_CONFIG_DIR/caddy" "$MR_SECRETS_DIR" "$MR_STORAGE_DIR" "$MR_BACKUPS_DIR" "$MR_LOGS_DIR" "$MR_RUN_DIR" "$MR_TMP_DIR" "$MR_BASE/scripts"
chmod 700 "$MR_SECRETS_DIR" "$MR_STORAGE_DIR" "$MR_BACKUPS_DIR"; chmod 750 "$MR_CONFIG_DIR" "$MR_LOGS_DIR" "$MR_RUN_DIR" "$MR_TMP_DIR"
for f in "$KIT"/scripts/*.sh; do b="$(basename "$f")"; cp "$f" "$MR_BASE/scripts/.$b.tmp" && chmod 755 "$MR_BASE/scripts/.$b.tmp" && mv -f "$MR_BASE/scripts/.$b.tmp" "$MR_BASE/scripts/$b"; done   # atomar: laufende Skripte behalten ihre alte Datei
cp "$KIT/caddy/Caddyfile.template" "$MR_CONFIG_DIR/caddy/Caddyfile.template"
for t in offsite.conf dyndns.conf; do [ -f "$MR_CONFIG_DIR/$t" ] || cp "$KIT/config/$t.template" "$MR_CONFIG_DIR/$t"; done
if [ ! -f "$MR_CONFIG_FILE" ]; then sed "s|__MR_BASE__|$MR_BASE|g" "$KIT/config/pilot.env.template" > "$MR_CONFIG_FILE"; chmod 640 "$MR_CONFIG_FILE"; echo "Konfiguration angelegt: $MR_CONFIG_FILE"; fi

# Homebrew-Pakete (Versionen aus Projektanforderung: Node 22, PostgreSQL 18).
if ! command -v brew >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/brew ] && [ ! -x /usr/local/bin/brew ]; then
  echo "Homebrew fehlt – Installation gemäß https://brew.sh (benötigt Admin-Passwort):"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
mr_setup_path
brew install node@22 postgresql@18 caddy age jq git >/dev/null 2>&1 || brew install node@22 postgresql@18 caddy age jq git
brew link --overwrite --force node@22 >/dev/null 2>&1 || true
corepack enable >/dev/null 2>&1 || true
PNPM_VER="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO/package.json")"
corepack prepare "pnpm@${PNPM_VER:-10}" --activate >/dev/null 2>&1 || true
echo "Runtime: node $(node --version), pnpm $(pnpm --version), $(psql --version | head -n 1), $(caddy version | head -n 1)"

# Inventar in den Checkout (ohne Seriennummern).
"$MR_BASE/scripts/inventory.sh" "$REPO/docs/PILOT_MACBOOK_INVENTORY.md"

# PostgreSQL + Secrets
"$MR_BASE/scripts/setup-postgres.sh"
"$MR_BASE/scripts/configure-secrets.sh" keys
"$MR_BASE/scripts/configure-secrets.sh" backup-key

# LaunchAgents VOR dem ersten Deployment (deploy.sh startet Dienste über launchd; ohne Release beenden sich die
# Wrapper mit Exit 0 und warten auf den kickstart durch deploy.sh).
"$MR_BASE/scripts/install-launchd.sh"
# Erstes Release (ohne Backup nur bei Erstinstallation; danach normales Deployment mit Pre-Deploy-Backup)
if [ -L "$MR_CURRENT" ]; then "$MR_BASE/scripts/deploy.sh" "$SHA"; else "$MR_BASE/scripts/deploy.sh" "$SHA" --no-backup; fi
# Migrationsprüfung: zweiter Lauf idempotent, Zahlen konsistent.
load_pilot_env
N1="$(mr_psql -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')"
(cd "$MR_CURRENT" && pnpm --silent db:migrate >/dev/null)
N2="$(mr_psql -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')"
J="$(python3 -c "import json;print(len(json.load(open('$MR_CURRENT/packages/database/migrations/meta/_journal.json'))['entries']))" 2>/dev/null || echo '?')"
T="$(mr_psql -c "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' ')"
echo "Migrationen: Lauf1=$N1 Lauf2=$N2 Journal=$J Tabellen=$T"; [ "$N1" = "$N2" ] || { echo "FEHLER: Migration nicht idempotent"; exit 1; }

# Netzbetrieb
[ -f "$MR_CONFIG_DIR/pmset-before.txt" ] || pmset -g custom > "$MR_CONFIG_DIR/pmset-before.txt" 2>/dev/null || true   # Originalwerte nur einmal sichern
if sudo -n true 2>/dev/null || sudo -v; then sudo pmset -c sleep 0 disksleep 0 displaysleep 15 autorestart 1 && echo "Netzbetrieb: kein Leerlauf-Schlaf am Netzteil, Display schläft nach 15 min, Neustart nach Stromausfall"; else echo "pmset nicht gesetzt (kein sudo) – Runbook „Netzbetrieb“"; fi
echo "WICHTIG: Deckel offen lassen (oder Clamshell-Betrieb mit externem Display + Netzteil) – bei geschlossenem Deckel schläft ein MacBook trotz pmset. Bildschirm nur sperren, nie abmelden."

# Caddy nur, wenn DNS stimmt.
"$MR_BASE/scripts/caddy-enable.sh" || echo "Caddy später aktivieren: $MR_BASE/scripts/caddy-enable.sh (nach STRATO-DynDNS und Routerfreigabe)"
"$MR_BASE/scripts/backup.sh" initial || true
"$MR_BASE/scripts/status.sh"
echo "== Bootstrap fertig. Nächste Schritte: configure-secrets.sh mail|dyndns|offsite, pilot-check.sh =="
