#!/bin/bash
# PostgreSQL 18 (Homebrew) für den Pilot: nur localhost, scram-sha-256 statt trust für Netzwerkclients, eigene Rolle
# mit zufälligem Passwort (CREATEDB nur für Restore-Tests), eigene Datenbank UTF-8. Schreibt DATABASE_URL in die
# Secrets (600). Idempotent; vorhandene Rolle/Datenbank bleiben unverändert.
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
umask 077
ROLE="${MR_DB_ROLE:-mietroyal_pilot}"; DB="${MR_DB_NAME:-mietroyal_pilot}"
case "$ROLE$DB" in *[!A-Za-z0-9_]*) die "MR_DB_ROLE/MR_DB_NAME: nur [A-Za-z0-9_]" ;; esac
require_cmd node openssl
# SCRAM-SHA-256-Verifier clientseitig berechnen (Passwort nur über die Umgebung an node, nie als Argument,
# nie im SQL-Text/Serverlog). PostgreSQL speichert einen fertigen Verifier unverändert.
scram_verifier() {
  MR_PW="$1" node -e '
const c=require("crypto"); const pw=process.env.MR_PW; const iter=4096; const salt=c.randomBytes(16);
const salted=c.pbkdf2Sync(pw,salt,iter,32,"sha256");
const clientKey=c.createHmac("sha256",salted).update("Client Key").digest();
const storedKey=c.createHash("sha256").update(clientKey).digest();
const serverKey=c.createHmac("sha256",salted).update("Server Key").digest();
process.stdout.write("SCRAM-SHA-256$"+iter+":"+salt.toString("base64")+"$"+storedKey.toString("base64")+":"+serverKey.toString("base64"));'
}
PREFIX="$(mr_brew_prefix)"; [ -n "$PREFIX" ] || die "Homebrew fehlt"
PGBIN="$PREFIX/opt/postgresql@18/bin"; [ -x "$PGBIN/psql" ] || die "postgresql@18 nicht installiert (brew install postgresql@18)"
PGDATA="$PREFIX/var/postgresql@18"
export PATH="$PGBIN:$PATH"
if mr_is_macos; then brew services start postgresql@18 >/dev/null 2>&1 || true; fi
i=0; until pg_isready -q 2>/dev/null; do i=$((i+1)); [ $i -lt 60 ] || die "PostgreSQL startet nicht"; sleep 1; done
# Härtung: listen_addresses lokal, scram, pg_hba ohne trust für host-Verbindungen.
CONF="$PGDATA/postgresql.conf"; HBA="$PGDATA/pg_hba.conf"
if [ -w "$CONF" ]; then
  grep -qE "^listen_addresses *= *'(localhost|127.0.0.1)'" "$CONF" || { sed -i.bak -E "s/^#?listen_addresses *=.*/listen_addresses = 'localhost'/" "$CONF"; log "listen_addresses = localhost"; }
  grep -qE "^password_encryption *= *'?scram-sha-256" "$CONF" || { sed -i.bak -E "s/^#?password_encryption *=.*/password_encryption = 'scram-sha-256'/" "$CONF"; log "password_encryption = scram-sha-256"; }
fi
if [ -w "$HBA" ]; then
  if grep -E '^host' "$HBA" | grep -q 'trust'; then
    cp "$HBA" "$HBA.bak.$(date +%s)"
    awk '$1=="host" && $NF=="trust" {$NF="scram-sha-256"} {print}' "$HBA" > "$HBA.tmp" && mv -f "$HBA.tmp" "$HBA"
    log "pg_hba.conf: host-Zeilen trust ⇒ scram-sha-256"
  fi
fi
psql -d postgres -X -q -c "select pg_reload_conf()" >/dev/null 2>&1 || true
# Rolle/Datenbank
PW="$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-40)"
if psql -d postgres -X -q -A -t -c "select 1 from pg_roles where rolname='$ROLE'" | grep -q 1; then
  log "Rolle $ROLE vorhanden – Passwort bleibt (DATABASE_URL in den Secrets gilt weiter)"
  EXISTING="$(env_value "$MR_SECRETS_FILE" DATABASE_URL 2>/dev/null || true)"
  [ -n "$EXISTING" ] || warn "DATABASE_URL fehlt in den Secrets, Rolle existiert aber: Passwort mit psql neu setzen (ALTER ROLE) und configure-secrets.sh"
else
  VERIFIER="$(scram_verifier "$PW")"; [ -n "$VERIFIER" ] || die "SCRAM-Verifier konnte nicht berechnet werden"
  psql -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
CREATE ROLE "$ROLE" LOGIN CREATEDB PASSWORD '$VERIFIER';
SQL
  VERIFIER=""
  log "Rolle $ROLE angelegt (LOGIN, CREATEDB für Restore-Tests)"
  URL="postgresql://$ROLE:$PW@127.0.0.1:5432/$DB"
  mkdir -p "$MR_SECRETS_DIR"; chmod 700 "$MR_SECRETS_DIR"; [ -f "$MR_SECRETS_FILE" ] || { : > "$MR_SECRETS_FILE"; chmod 600 "$MR_SECRETS_FILE"; }
  { grep -vE '^DATABASE_URL=' "$MR_SECRETS_FILE" || true; printf 'DATABASE_URL=%s\n' "$URL"; } > "$MR_SECRETS_FILE.tmp" && mv -f "$MR_SECRETS_FILE.tmp" "$MR_SECRETS_FILE"; chmod 600 "$MR_SECRETS_FILE"
  log "DATABASE_URL in den Secrets hinterlegt"
fi
PW=""
if psql -d postgres -X -q -A -t -c "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  log "Datenbank $DB vorhanden"
else
  psql -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\" OWNER \"$ROLE\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
  log "Datenbank $DB angelegt (UTF8, Owner $ROLE)"
fi
# Verbindungstest über TCP mit Passwort (scram) – aus den Secrets über die PG*-Umgebung, nie als Argument.
DATABASE_URL="$(env_value "$MR_SECRETS_FILE" DATABASE_URL)"; export DATABASE_URL
mr_pg_env || die "DATABASE_URL unlesbar"
psql -X -q -A -t -c "select current_user||' @ '||current_database()||' enc='||pg_encoding_to_char(encoding) from pg_database where datname=current_database()" || die "Verbindung mit Passwort fehlgeschlagen"
unset PGPASSWORD
psql -d postgres -X -q -A -t -c "select 'listen='||setting from pg_settings where name='listen_addresses'"
log "PostgreSQL bereit. Nur localhost; keine Routerfreigabe für 5432."
