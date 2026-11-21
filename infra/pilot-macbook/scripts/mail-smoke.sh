#!/bin/bash
# Genau EINE Testmail an eine von Dennis freigegebene Adresse über die konfigurierten STRATO-SMTP-Daten.
# Der Repo-Smoke (pnpm mail:smoke) verweigert production; deshalb läuft er hier mit APP_ENV=staging und sonst
# identischer Konfiguration (keine Outbox-Zeile, keine Kundendaten). Aufruf: mail-smoke.sh <empfänger>
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_pilot_env
TO="${1:-}"; [ -n "$TO" ] || die "Aufruf: mail-smoke.sh <freigegebene-adresse>"
[ "${MAIL_ENABLED:-false}" = true ] || die "MAIL_ENABLED=false – zuerst configure-secrets.sh mail"
cd "$MR_CURRENT" || die "kein aktives Release"
APP_ENV=staging MAIL_SMOKE=true MAIL_SMOKE_TO="$TO" pnpm --silent mail:smoke
