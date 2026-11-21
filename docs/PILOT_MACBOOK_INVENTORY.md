# Pilot-MacBook – Inventar

**Stand: NOCH NICHT ERHOBEN.** Dieses Dokument wird auf dem MacBook von
`infra/pilot-macbook/scripts/inventory.sh docs/PILOT_MACBOOK_INVENTORY.md` erzeugt (Teil von
`bootstrap.sh`). Die Cloud-Sitzung vom 2026-11-21 hatte keinen Zugriff auf das MacBook (kein per
Remote Control freigegebener Ordner, keine erreichbare Claude-Sitzung auf dem Gerät); erfundene
Werte werden hier nicht eingetragen.

Erhoben werden (nur lesend, ohne Seriennummern, UUIDs, Passwörter, Tokens; öffentliche IPs
maskiert):

- Modell, Architektur (Apple Silicon/Intel), macOS-Version, CPU, RAM, SSD gesamt/frei, Dateisystem
- FileVault, Application Firewall, Stealth Mode, Remote Login, Screen Sharing, File Sharing,
  AirPlay Receiver, Energieeinstellungen (Netzbetrieb), Deckelzustand (geschlossener Deckel ⇒
  Schlaf trotz `pmset`)
- Default-Interface, lokale IPv4 (für die Router-Reservierung), globale IPv6 (maskiert),
  öffentliche IPv4/IPv6 (maskiert), CGNAT-/DS-Lite-Indiz (IPv4 in 100.64.0.0/10), Hinweis zur
  externen Prüfung von 80/443 – kein Gerätename (kann den Namen des Inhabers enthalten), kein
  Gateway
- Homebrew, Node, pnpm, PostgreSQL, Caddy, Git, age, jq, Docker/Colima/OrbStack, nginx
- lauschende TCP-Ports nur für die Pilot-Ports (80/443/2019/3000–3002/5432), übrige nur als
  Anzahl; vorhandene Miet-Royal-Prozesse; Anzahl LaunchAgents/LaunchDaemons
- Basisverzeichnis `MR_BASE` und aktives Release

Nach dem ersten Lauf ersetzt die erzeugte Datei diesen Platzhalter; bei Änderungen am Gerät
(macOS-Update, neue Hardware) erneut ausführen.
