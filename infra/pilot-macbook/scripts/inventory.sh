#!/bin/bash
# Inventar des MacBooks als Markdown (ohne Seriennummern, UUIDs, Passwörter, Tokens; öffentliche IPs maskiert).
# Aufruf: inventory.sh [ausgabedatei]   – nur lesend, verändert nichts.
set -u
. "$(dirname "$0")/lib.sh"
mr_setup_path
OUT="${1:-}"
sect() { printf '\n## %s\n\n' "$1"; }
kv() { printf -- '- **%s:** %s\n' "$1" "$2"; }
mask4() { echo "$1" | awk -F. 'NF==4{print $1"."$2".x.x"} NF!=4{print "-"}'; }
mask6() { echo "$1" | awk -F: '{ if (NF>=4) print $1":"$2":"$3":"$4":…"; else print "-" }'; }
ver() { command -v "$1" >/dev/null 2>&1 && "$@" 2>/dev/null | head -n 1 || echo "nicht installiert"; }
gen() {
  echo "# Pilot-MacBook – Inventar"
  echo
  echo "Erzeugt am $(date '+%Y-%m-%d %H:%M %Z') mit infra/pilot-macbook/scripts/inventory.sh (nur lesend; keine Seriennummern, UUIDs oder Secrets)."
  if mr_is_macos; then
    sect "Hardware / Betriebssystem"
    HW="$(system_profiler SPHardwareDataType 2>/dev/null | grep -vEi 'Serial|UUID|UDID')"
    kv "Modell" "$(echo "$HW" | awk -F': ' '/Model Name/{print $2}') ($(echo "$HW" | awk -F': ' '/Model Identifier/{print $2}'))"
    kv "Architektur" "$(uname -m) ($( [ "$(uname -m)" = arm64 ] && echo 'Apple Silicon' || echo 'Intel'))"
    kv "CPU" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '-') – $(sysctl -n hw.ncpu) Kerne"
    kv "RAM" "$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) GB"
    kv "macOS" "$(sw_vers -productName) $(sw_vers -productVersion) (Build $(sw_vers -buildVersion))"
    kv "Hostname" "(nicht erfasst – Gerätename kann den Namen des Inhabers enthalten)"
    sect "Speicher / Sicherheit"
    kv "Dateisystem /" "$(diskutil info / 2>/dev/null | awk -F': *' '/File System Personality/{print $2}')"
    kv "SSD gesamt / frei" "$(df -h / | awk 'NR==2{print $2" / "$4" ("100-$5"% frei)"}' | sed 's/%% frei/% frei/')"
    kv "FileVault" "$(fdesetup status 2>/dev/null || echo 'unbekannt')"
    kv "Firewall (Application Firewall)" "$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || echo 'unbekannt')"
    kv "Stealth Mode" "$(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>/dev/null || echo 'unbekannt')"
    kv "Remote Login (SSH)" "$(launchctl print system/com.openssh.sshd >/dev/null 2>&1 && echo 'aktiv' || echo 'nicht aktiv (oder nicht lesbar)')"
    kv "Screen Sharing" "$(launchctl print system/com.apple.screensharing >/dev/null 2>&1 && echo 'aktiv' || echo 'nicht aktiv (oder nicht lesbar)')"
    kv "File Sharing (smbd)" "$(launchctl print system/com.apple.smbd >/dev/null 2>&1 && echo 'aktiv' || echo 'nicht aktiv (oder nicht lesbar)')"
    kv "AirPlay Receiver" "$(defaults -currentHost read com.apple.controlcenter AirplayRecieverEnabled 2>/dev/null || echo 'unbekannt')"
    kv "Energie (pmset -g custom, Netzbetrieb)" "$(pmset -g custom 2>/dev/null | awk '/AC Power/{f=1;next} /Battery Power/{f=0} f && /sleep|displaysleep|autorestart/ {printf "%s=%s ", $1, $2}')"
    kv "Deckel (AppleClamshellState; Yes = geschlossen ⇒ Schlaf trotz pmset)" "$(ioreg -r -k AppleClamshellState -d 4 2>/dev/null | awk -F'= ' '/AppleClamshellState/ {print $2; exit}')"
    sect "Netzwerk"
    IF="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
    kv "Default-Interface" "${IF:-?} ($(networksetup -listallhardwareports 2>/dev/null | grep -B1 "Device: ${IF:-none}" | awk -F': ' '/Hardware Port/{print $2}'))"
    kv "Lokale IPv4" "$(ipconfig getifaddr "${IF:-en0}" 2>/dev/null || echo '-')"
    kv "Default Gateway" "(nicht erfasst)"
    G6="$(ifconfig "${IF:-en0}" 2>/dev/null | awk '/inet6/ && !/fe80/ && !/temporary/ {print $2}' | head -n 1)"
    kv "Globale IPv6 am Interface" "$( [ -n "$G6" ] && mask6 "$G6" || echo 'keine')"
  else
    sect "System (Linux-Testlauf)"
    kv "Kernel" "$(uname -sr)"; kv "CPU" "$(nproc) Kerne"; kv "RAM" "$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024 )) GB"
    kv "Frei /" "$(df -h / | awk 'NR==2{print $4}')"
  fi
  P4="$(curl -4 -s --max-time 6 https://api.ipify.org 2>/dev/null || true)"; P6="$(curl -6 -s --max-time 6 https://api6.ipify.org 2>/dev/null || true)"
  kv "Öffentliche IPv4 (maskiert)" "$( [ -n "$P4" ] && mask4 "$P4" || echo 'nicht ermittelbar')"
  case "$P4" in 100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) kv "CGNAT-Indiz" "JA – öffentliche IPv4 liegt in 100.64.0.0/10 (DS-Lite/CGNAT: eingehende IPv4 nicht möglich)" ;; '') ;; *) kv "CGNAT-Indiz" "nein (IPv4 außerhalb 100.64.0.0/10; Router-WAN-IP zusätzlich prüfen)" ;; esac
  kv "Öffentliche IPv6 (maskiert)" "$( [ -n "$P6" ] && mask6 "$P6" || echo 'keine/nicht ermittelbar')"
  kv "Eingehend 80/443" "erst nach Routerfreigabe von einem EXTERNEN Netz testbar (pilot-check.sh, Mobilfunk)"
  sect "Software"
  kv "Homebrew" "$(ver brew --version)"; kv "Node" "$(ver node --version)"; kv "pnpm" "$(ver pnpm --version)"
  kv "PostgreSQL (psql)" "$(ver psql --version)"; kv "Caddy" "$(ver caddy version)"; kv "Git" "$(ver git --version)"
  kv "age" "$(ver age --version)"; kv "jq" "$(ver jq --version)"
  kv "Docker/Colima/OrbStack" "$( (command -v docker >/dev/null && echo docker) ; (command -v colima >/dev/null && echo colima); [ -d /Applications/OrbStack.app ] && echo OrbStack; true ) | tr '\n' ' '"
  kv "nginx" "$(ver nginx -v)"
  sect "Laufende Dienste / Ports"
  echo '```'
  # Nur Pilot-relevante Ports mit Prozessnamen; alle übrigen nur als Anzahl (kein Port-Inventar im Repo).
  if mr_is_macos; then L="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/LISTEN/ {print $1, $9}' | sort -u)"; else L="$(ss -ltnpH 2>/dev/null | awk '{print $6, $4}' | sort -u)"; fi
  echo "$L" | grep -E ':(80|443|2019|3000|3001|3002|5432)$' || echo "(keine Pilot-Ports offen)"
  echo "weitere lauschende TCP-Ports (nicht aufgeführt): $(echo "$L" | grep -vcE ':(80|443|2019|3000|3001|3002|5432)$' || true)"
  echo '```'
  kv "Miet-Royal-Prozesse" "$(pgrep -fl 'tsx src/server.ts|tsx src/main.ts|next start|caddy run' 2>/dev/null | wc -l | tr -d ' ') gefunden"
  if mr_is_macos; then
    kv "LaunchAgents (Benutzer)" "$(ls "$HOME/Library/LaunchAgents" 2>/dev/null | wc -l | tr -d ' ') Dateien, davon Miet-Royal: $(ls "$HOME/Library/LaunchAgents" 2>/dev/null | grep -c mietroyal)"
    kv "LaunchDaemons (System, Fremd)" "$(ls /Library/LaunchDaemons 2>/dev/null | wc -l | tr -d ' ') Dateien"
  fi
  sect "Miet-Royal Basisverzeichnis"
  kv "MR_BASE" "$MR_BASE $( [ -d "$MR_BASE/releases" ] && echo '(eingerichtet)' || echo '(noch nicht eingerichtet)')"
  kv "Aktives Release" "$(current_release_sha 2>/dev/null || echo '-')"
}
if [ -n "$OUT" ]; then gen > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT" && log "Inventar geschrieben: $OUT"; else gen; fi
