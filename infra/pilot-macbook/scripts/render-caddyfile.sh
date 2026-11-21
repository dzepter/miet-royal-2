#!/bin/bash
# Erzeugt MR_BASE/config/caddy/Caddyfile aus der Vorlage mit den Werten aus pilot.env (keine Secrets).
set -eu
. "$(dirname "$0")/lib.sh"
load_env_file "$MR_CONFIG_FILE" || die "Konfiguration fehlt: $MR_CONFIG_FILE"
TEMPLATE="${1:-$MR_CONFIG_DIR/caddy/Caddyfile.template}"
OUT="$MR_CONFIG_DIR/caddy/Caddyfile"
[ -f "$TEMPLATE" ] || die "Caddyfile-Vorlage fehlt: $TEMPLATE"
mkdir -p "$MR_CONFIG_DIR/caddy" "$MR_LOGS_DIR"
ACME="${MR_ACME_EMAIL:-}"
[ -n "$ACME" ] || warn "MR_ACME_EMAIL leer: Caddy nutzt dann nur Let's Encrypt (ohne E-Mail kein ZeroSSL-Fallback-Aussteller) – Betreiberadresse in pilot.env empfohlen"
sed -e "s|__WEB_HOST__|${MR_PUBLIC_WEB_HOST:?}|g" \
    -e "s|__STAFF_HOST__|${MR_PUBLIC_STAFF_HOST:?}|g" \
    -e "s|__API_HOST__|${MR_PUBLIC_API_HOST:?}|g" \
    -e "s|__WEB_PORT__|$(mr_web_port)|g" \
    -e "s|__STAFF_PORT__|$(mr_staff_port)|g" \
    -e "s|__API_PORT__|$(mr_api_port)|g" \
    -e "s|__LOGS_DIR__|$MR_LOGS_DIR|g" \
    "$TEMPLATE" > "$OUT.tmp"
if [ -n "$ACME" ]; then
  sed -e "s|__ACME_EMAIL__|$ACME|g" "$OUT.tmp" > "$OUT.tmp2"
else
  # Ohne ACME-Adresse die email-Zeile entfernen (Let's Encrypt erlaubt anonyme Konten).
  grep -v '__ACME_EMAIL__' "$OUT.tmp" > "$OUT.tmp2"
fi
rm -f "$OUT.tmp"; chmod 644 "$OUT.tmp2"
if command -v caddy >/dev/null 2>&1; then
  if caddy validate --config "$OUT.tmp2" --adapter caddyfile >/dev/null 2>"$OUT.validate.log"; then
    rm -f "$OUT.validate.log"
  else
    cat "$OUT.validate.log" >&2; rm -f "$OUT.tmp2" "$OUT.validate.log"; die "Neue Caddyfile ungültig – bestehende Datei unverändert: $OUT"
  fi
  if [ -f "$OUT" ] && cmp -s "$OUT.tmp2" "$OUT"; then rm -f "$OUT.tmp2"; log "Caddyfile unverändert: $OUT"; exit 0; fi
  [ -f "$OUT" ] && cp -p "$OUT" "$OUT.bak"
  mv -f "$OUT.tmp2" "$OUT"; log "Caddyfile gültig und aktualisiert: $OUT"
  # Laufendes Caddy übernimmt die neue Konfiguration sofort (Admin-API nur auf localhost:2019).
  if svc_is_running caddy; then
    caddy reload --config "$OUT" --adapter caddyfile >/dev/null 2>&1 && log "Caddy neu geladen" || warn "caddy reload fehlgeschlagen – alte Konfiguration bleibt aktiv ($OUT.bak); restart.sh caddy prüfen"
  fi
else
  if [ -f "$OUT" ]; then rm -f "$OUT.tmp2"; die "caddy nicht installiert – bestehende Caddyfile bleibt unverändert (keine Validierung möglich)"; fi
  mv -f "$OUT.tmp2" "$OUT"; warn "caddy nicht installiert – Caddyfile geschrieben, aber nicht validiert: $OUT"
fi
