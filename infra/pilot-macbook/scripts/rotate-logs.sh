#!/bin/bash
# Log-Rotation ohne sudo (launchd hält die Logdateien offen ⇒ copytruncate): logs/*.log > 5 MiB oder täglich,
# komprimiert als name.YYYYMMDD-HHMMSS.gz, höchstens 14 Archive je Log. Caddy rotiert sein Access-Log selbst.
set -u
. "$(dirname "$0")/lib.sh"
KEEP=14; MIN_KB=${MR_LOG_ROTATE_MIN_KB:-1024}
for f in "$MR_LOGS_DIR"/*.log; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in caddy-access.log) continue ;; esac
  size_kb=$(( $(file_size "$f") / 1024 ))
  [ "$size_kb" -ge "$MIN_KB" ] || continue
  stamp="$(date '+%Y%m%d-%H%M%S')"
  cp "$f" "$f.$stamp" && : > "$f" && gzip -f "$f.$stamp" && log "rotiert: $(basename "$f") (${size_kb} KiB)"
  ls -1t "$f".*.gz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do rm -f "$old"; done
done
