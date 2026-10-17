# PRE_START_CHECKLIST — Noch nicht alles sofort nötig

## Für Phase 0
Benötigt:
- Rechner für lokale Entwicklung
- Git
- aktuelle Node.js-LTS-Version
- pnpm oder durch Phase-0-Setup definierter Package Manager
- Docker Desktop / Docker Engine, falls Phase 0 dies verwendet
- Claude Code
- leeres Projektverzeichnis
- dieses Spezifikationspaket

Nicht benötigt:
- Lexware API
- WhatsApp Zugang
- finale Bilder
- neue Website-Domain
- echte Kundendaten

## Für spätere Phasen
Die jeweils benötigten Zugangsdaten/Stammdaten stehen in `OPEN_ITEMS.md`.

## Staging/Production (ab Phase 8)
- `STAFF_OFFLINE_LEASE_VERIFICATION_KEY` beim Staff-Server gesetzt (Pflicht,
  fail-closed; Wert aus `pnpm offline:lease-key` der API-Umgebung; kein
  Secret, aber nie ins Repository committen).

## Sicherheitsregel
Echte Zugangsdaten nie in Chat-Prompts oder Git-Dateien kopieren, wenn sie als
Secrets/Environment-Variablen auf dem Zielsystem gesetzt werden können.
