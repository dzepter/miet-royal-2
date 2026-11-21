#!/bin/bash
# Secret-Scan: sucht die tatsächlichen Secret-Werte (aus secrets/pilot.secrets.env) und typische Schlüsselmuster in
# Release-Baum, Konfiguration, Logs und optional einem Repo-Checkout. Ausgabe nur Trefferzahlen/Pfade – nie Werte.
set -u
. "$(dirname "$0")/lib.sh"
EXTRA="${1:-}"
hits=0
# Tatsächliche Secret-WERTE werden überall gesucht (auch im Quellbaum des Releases); Schlüssel-MUSTER nur in
# Konfiguration, Logs, Laufzeitdaten, Doku und Infra (Test-Fixtures im Quellcode enthalten absichtlich Beispiel-URLs).
TARGETS="$MR_CONFIG_DIR $MR_LOGS_DIR $MR_RUN_DIR"
PATTERN_TARGETS="$TARGETS"
[ -L "$MR_CURRENT" ] && { TARGETS="$TARGETS $MR_CURRENT/apps $MR_CURRENT/packages $MR_CURRENT/docs $MR_CURRENT/infra"; PATTERN_TARGETS="$PATTERN_TARGETS $MR_CURRENT/docs $MR_CURRENT/infra"; }
[ -n "$EXTRA" ] && { TARGETS="$TARGETS $EXTRA"; PATTERN_TARGETS="$PATTERN_TARGETS $EXTRA"; }
umask 077
PF="$MR_TMP_DIR/.secret-scan.$$"; mkdir -p "$MR_TMP_DIR"; trap 'rm -f "$PF"' EXIT
scan_value() { # name value – der Wert wandert in eine 600-Datei (grep -f), nie in Prozessargumente
  [ -n "$2" ] || return 0
  [ ${#2} -ge 8 ] || return 0
  printf '%s\n' "$2" > "$PF"
  found="$(grep -rIlF --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=secrets --exclude-dir=.git -f "$PF" $TARGETS 2>/dev/null | grep -v "/secrets/" || true)"
  rm -f "$PF"
  n="$(printf '%s' "$found" | grep -c . || true)"
  if [ "$n" != 0 ]; then echo "TREFFER: Wert von $1 in $n Datei(en):"; printf '%s\n' "$found" | head -n 5; hits=$((hits+n)); fi
}
if [ -f "$MR_SECRETS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in DATABASE_URL) v="${v#*://*:}"; v="${v%%@*}" ;; esac   # nur das Passwort aus der URL
    scan_value "$k" "$v"
  done < "$MR_SECRETS_FILE"
fi
[ -s "$MR_SECRETS_DIR/dyndns.secret" ] && scan_value DYNDNS "$(tr -d '\r\n' < "$MR_SECRETS_DIR/dyndns.secret")"
pat="$(grep -rIlE --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=secrets --exclude-dir=.git --exclude=secret-scan.sh -e 'AGE-SECRET-KEY-1[A-Z0-9]{20,}' -e '-----BEGIN (OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY' -e 'https?://[^/@[:space:]:]+:[^/@[:space:]]{8,}@' -e 'ghp_[A-Za-z0-9]{20,}' -e 'github_pat_[A-Za-z0-9_]{20,}' $PATTERN_TARGETS 2>/dev/null | grep -v '/secrets/' || true)"
[ -z "$pat" ] || { echo "TREFFER Schlüsselmuster:"; echo "$pat" | head -n 5; hits=$((hits+1)); }
if [ $hits = 0 ]; then echo "SECRET-SCAN: 0 Treffer"; exit 0; fi
echo "SECRET-SCAN: $hits Treffer – bereinigen!"; exit 1
