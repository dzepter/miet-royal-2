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
- Verbindliche Go-Live-Blocker Buchhaltung (Preisbasis brutto/netto,
  Steuerbehandlung je Kategorie, Anzahlung, angewendete Kaution, manueller
  Testaccount-Smoke): siehe `docs/OPEN_ITEMS.md` → „GO-LIVE-BLOCKER
  Buchhaltung“.

## Production mit Routing/GraphHopper (ab Phase 13)
- **GO-LIVE-BLOCKER Routing (vertraglich, Phase 13 Final §5):** Vor dem
  Setzen eines `GRAPHHOPPER_API_KEY` in production mit GraphHopper (Vertrag/
  Paket, ggf. Custom-Vertrag) klären, ob die implementierte serverseitige
  Zwischenspeicherung erlaubt ist: `geocoding_cache` mit Kandidaten,
  Koordinaten und OSM-Referenzen (TTL 90 Tage resolved / 30 Tage review bzw.
  kein Treffer) sowie die persistierten minimalen Distanz-/Fahrzeitwerte je
  Tour/Stopp. Die ToS regeln ausdrücklich nur temporäres clientseitiges
  Caching; eine dauerhafte serverseitige Speicherung ist nicht ausdrücklich
  geregelt (`docs/ROUTING_API_NOTES.md`). Ergebnis negativ ⇒ Caching/
  Persistenz vor dem Go-live reduzieren/umbauen, nicht den Schalter setzen.
- Erst nach positiver Prüfung `ROUTING_PROVIDER_TERMS_CONFIRMED=true` bei API
  und Worker setzen (kein Secret, kein Default) – ohne diesen Wert startet
  production mit gesetztem Key nicht (fail-closed, Konfigurationsfehler).
  Alternative bis zur Klärung: `ROUTING_PROVIDER=disabled` (Touren
  organisatorisch nutzbar, keine Routen/Prognosen).
- Bezahlter GraphHopper-Plan (Basic oder höher) und Kontoinhaber; Key nur als
  Secret der Produktionsumgebung (`GRAPHHOPPER_API_KEY`), nie im Repo; ein
  Key gilt nur in einer Umgebung (Isolationsprüfung).
- Verzeichnis der Verarbeitungstätigkeiten um GraphHopper (Request-Retention
  bis 5 Wochen, Subprozessoren Geocoding) ergänzen; Depotadresse
  (`pickup_exact_address`) vollständig hinterlegen.

## Sicherheitsregel
Echte Zugangsdaten nie in Chat-Prompts oder Git-Dateien kopieren, wenn sie als
Secrets/Environment-Variablen auf dem Zielsystem gesetzt werden können.
