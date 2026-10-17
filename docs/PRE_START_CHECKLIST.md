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

## Production mit Buchhaltung (ab Phase 10)
- Lexware-Office-Account mit Public-API-Zugang; API-Key mit den in
  `docs/LEXWARE_API_NOTES.md` genannten Berechtigungen (nur serverseitig auf
  API und Worker: `LEXWARE_API_KEY`, `LEXWARE_ORGANIZATION_ID`,
  `LEXWARE_WEBHOOK_CALLBACK_URL`).
- Öffentliche HTTPS-Adresse der API für Webhooks (`/webhooks/lexware`) mit
  gültigem Zertifikat.
- Steuerkonfiguration (Steuerart und Satz je Abrechnungskategorie) mit
  Buchhaltung/Steuerberatung abgestimmt – ohne sie blockiert production jede
  Rechnung (bewusst, nichts wird erfunden).
- Entscheidung zur Lexware-Abbildung von Anzahlungen/Kautionen (Public API
  bietet keine Abschlagsrechnungen) – bis dahin werden solche Abrechnungen
  blockiert.
- Für demo: KEIN Lexware-Key (Demo bucht nie in Lexware).

## Sicherheitsregel
Echte Zugangsdaten nie in Chat-Prompts oder Git-Dateien kopieren, wenn sie als
Secrets/Environment-Variablen auf dem Zielsystem gesetzt werden können.
