#!/bin/bash
# Führt EINEN Befehl mit der Pilot-Umgebung (pilot.env + Secrets) aus, ohne dass Secrets in der interaktiven
# Shell verbleiben. Beispiel: with-env.sh pnpm staff:bootstrap-admin   (im Verzeichnis current/)
set -eu
. "$(dirname "$0")/lib.sh"
mr_setup_path
load_pilot_env
[ $# -gt 0 ] || die "Aufruf: with-env.sh <befehl> [argumente]"
cd "${MR_CURRENT}" 2>/dev/null || true
exec "$@"
