# Runbook: Pilot-Zielsystem auf dem MacBook

Betriebsanleitung für den dauerhaft laufenden MacBook-Pilot (Phase 19, Fortsetzung). Technische
Grundlage: `infra/pilot-macbook/` (Kit, versioniert) und das Basisverzeichnis `MR_BASE`
(`/opt/mietroyal`, sonst `~/mietroyal`) auf dem Mac. Alle Kommandos laufen als der angemeldete
Benutzer im Terminal; `sudo` braucht nur der einmalige Bootstrap (Basisverzeichnis, Homebrew,
`pmset`). Secrets stehen ausschließlich in `MR_BASE/secrets/` (600) und werden nie angezeigt.

Grenzen (gelten immer): bestehende Website/Apex/MX/DNS von `www.miet-royal.de` unangetastet,
`WEB_INDEXING_ENABLED` nie `true`, Lexware/WhatsApp/Reviews nur nach dokumentierter Freigabe,
keine echten Kunden ohne Freigabe, keine Rechtstexte ungeprüft veröffentlichen, FileVault bleibt
an, Router nur TCP 80/443 auf den Mac, kein 22/5432 nach außen, Phase 20 nicht beginnen.

## 1. Einmaliger Aufbau

1. Repo auf dem Mac auschecken (z. B. `~/code/miet-royal-2`), `git checkout main` auf dem
   freigegebenen Commit.
2. `bash infra/pilot-macbook/bootstrap.sh` – fragt das Admin-Passwort für `/opt/mietroyal`,
   Homebrew und `pmset` ab; alles Übrige läuft ohne `sudo`. Ergebnis: Inventar in
   `docs/PILOT_MACBOOK_INVENTORY.md`, PostgreSQL (nur localhost, scram), Konfiguration ohne
   Secrets, Schlüssel (`AUTH_SECRET_KEY`, `COMMUNICATION_PAYLOAD_KEY`, age-Identität), erstes
   Release, Migrationsprüfung, LaunchAgents, Netzbetrieb.
3. `MR_BASE/scripts/configure-secrets.sh mail` (STRATO-Postfach), `… dyndns` (nur ohne Router-
   DynDNS), `… offsite` (STRATO-SFTP) – jeweils interaktiv ohne Echo.
4. Nach STRATO-DynDNS und Routerfreigabe: `MR_BASE/scripts/caddy-enable.sh` (prüft DNS, startet
   Caddy, Zertifikate kommen automatisch).
5. `MR_BASE/scripts/pilot-check.sh` muss PASS liefern; externe Portprüfung aus dem Mobilfunknetz.

Erstes Admin-Konto: `MR_BASE/scripts/with-env.sh pnpm staff:bootstrap-admin` (lädt Konfiguration und
Secrets nur für diesen einen Prozess – nichts bleibt in der Shell; interaktive Prompts, Passwort ohne
Anzeige; funktioniert nur, solange kein Konto existiert).

## 2. Start / Stop / Status

| Aufgabe | Kommando |
| --- | --- |
| Status auf einen Blick | `MR_BASE/scripts/status.sh` |
| PASS/FAIL-Prüfliste | `MR_BASE/scripts/pilot-check.sh` |
| Alle Dienste starten | `MR_BASE/scripts/start.sh` (einzeln: `start.sh api`) |
| Alle Dienste stoppen | `MR_BASE/scripts/stop.sh` (Reihenfolge Caddy → Web → Staff → API → Worker; setzt die Wartungsmarke `run/maintenance`, der Watchdog startet dann nichts neu) |
| Befehl mit Pilot-Umgebung | `MR_BASE/scripts/with-env.sh <befehl>` (z. B. `pnpm staff:bootstrap-admin`; Secrets bleiben nicht in der Shell) |
| Neustart | `MR_BASE/scripts/restart.sh [dienst]` |
| LaunchAgents neu laden | `MR_BASE/scripts/install-launchd.sh` |

Dienste: `de.mietroyal.pilot.{api,worker,web,staff,caddy}` (KeepAlive, Neustart nur bei Absturz,
30 s Drossel; ohne aktives Release bzw. ohne Caddy-Freigabe beenden sich die Wrapper mit Exit 0 und
warten auf `deploy.sh`/`caddy-enable.sh`); Timer: `watchdog` (alle 2 min), `backup` (03:17),
`backup-offsite` (03:50), `restore-test` (04:20), `rotate-logs` (05:05), `dyndns` (alle 5 min, nur
wenn aktiviert). Verpasste Kalendertermine holt launchd nur nach dem **Schlaf** nach, nicht nach
„aus“/Neustart – der Watchdog startet überfällige Backups, Off-site-Läufe und Restore-Tests selbst
(älter als ~25 h). `install-launchd.sh` lädt nur geänderte Agents neu (kein Neustart laufender
Dienste bei unveränderter Konfiguration).

## 3. Deployment und Rollback

- `MR_BASE/scripts/deploy.sh <git-sha|main>`: holt den Commit in den Bare-Mirror, baut
  `releases/<sha>` (install, Web-/Staff-Build mit den Origins aus `pilot.env`), Preflight
  (Pflichtvariablen, https-Pilotbasis, `WEB_INDEXING_ENABLED` ≠ true, Storage, Node, Datenbank,
  Speicher, Offline-Lease-Schlüssel), Backup `pre-deploy`, `pnpm db:migrate`, atomarer
  `current`-Wechsel, Neustart von API/Worker/Web/Staff, Health/Ready/Smoke (Umgebung =
  production, robots ohne Sitemap). Scheitert der Smoke, wird automatisch das vorige Release
  reaktiviert; die Datenbank wird nie zurückgerollt (Migrationen sind additiv).
- `MR_BASE/scripts/rollback.sh [sha]`: nur Anwendungsversion + Neustart + Health. Kein
  Down-Migration, keine Daten- oder Dokumentlöschung. Ein Datenbank-Restore ist ein separater,
  manueller Vorgang (Abschnitt 5).
- Es bleiben mindestens die letzten drei Releases erhalten; `current` und `previous` werden nie
  gelöscht. Ein Deployment ist erst „fertig“, wenn `pilot-check.sh` PASS zeigt.
- Nachweis nach jedem Deployment: `status.sh` zeigt den Git-SHA, `GET /health` meldet
  `environment: production`.

## 4. Backup

- Täglich 03:17 (`backup.sh daily`), zusätzlich automatisch vor jedem Deployment
  (`pre-deploy`, von der Retention ausgenommen – manuell löschen). Inhalt je Sicherung
  `backups/<ts>_<label>/`: `db.dump.age` (`pg_dump -Fc`), `storage.tar.gz.age`, `secrets.tar.gz.age`
  (Schlüssel gehören in dieselbe Sicherung), `storage-files.sha256` (Pfad, SHA-256 und Größe jeder
  Storage-Datei – Grundlage des Restore-Tests), `pilot.env` (ohne Secrets), `manifest.json` (Git-SHA,
  Migrationsstand, Zählstände, Dateianzahl, Größen), `backup.sha256`, `.completed` (nur vollständige
  Backups).
- Verschlüsselung mit `age` an alle Empfänger in `config/backup-recipients.txt` (mindestens die
  Automationsidentität `secrets/backup-age.key`; empfohlen zusätzlich ein Offline-Schlüssel von
  Dennis). **Ohne die Identität sind Backups wertlos** – Dennis bewahrt eine Kopie außerhalb des
  MacBooks auf (`configure-secrets.sh backup-key` zeigt sie einmalig an).
- Retention: 7 tägliche, danach je Kalenderwoche eine bis 4 Wochen; vor jedem Lauf Platzprüfung
  (ca. 2 × DB + Storage frei), sonst Abbruch ohne Löschung. Retention nach den ersten Wochen anhand
  der realen Größe in `pilot.env` (`MR_BACKUP_KEEP_*`) nachjustieren.
- Prüfen: `backup-verify.sh [verzeichnis]` (Prüfsummen, Entschlüsselbarkeit, Manifest).
- Off-site (STRATO-SFTP, `config/offsite.conf`): `backup-offsite.sh` lädt nur abgeschlossene,
  verschlüsselte Archive mit gepinntem Host-Key hoch, vergleicht Größen, markiert `.offsite-done`,
  hält `OFFSITE_KEEP` Sicherungen vor. Fehler ⇒ Exit ≠ 0 und Watchdog-Hinweis. Ziel nie im Webroot.

## 5. Restore

- Automatisch täglich 04:20: `restore-test.sh` spielt das neueste Backup in eine NEUE Wegwerf-
  Datenbank und ein NEUES Verzeichnis zurück, vergleicht Zählstände mit dem Manifest, führt
  `db:migrate` (No-op) aus, prüft jede gesicherte Storage-Datei gegen `storage-files.sha256` und
  jede Datei-Referenz der Datenbank (Dokumente, Übergabefotos, Unterschriften, Nachrichtenfotos:
  SHA-256/Bytes), startet eine API auf Port 3101 gegen den Restore (health/ready) und räumt auf.
  Ergebnis in `run/restore-test-last`.
- Echter Restore (nur nach Entscheidung von Dennis, z. B. nach Datenverlust): Dienste stoppen
  (`stop.sh` – setzt die Wartungsmarke, der Watchdog greift nicht ein; `start.sh`/`deploy.sh` heben
  sie auf), Backup entschlüsseln (`age -d -i secrets/backup-age.key`), in eine NEUE Datenbank
  zurückspielen (`pg_restore --no-owner --no-privileges --exit-on-error`), Storage in ein NEUES
  Verzeichnis entpacken, `DATABASE_URL`/`STORAGE_FS_ROOT` in den Secrets/der Konfiguration
  umstellen, `deploy.sh <aktueller sha> --no-backup --skip-build` (Migration No-op), `pilot-check.sh`.
  Die bisherige Datenbank bleibt bis zur ausdrücklichen Löschung erhalten.

## 6. DynDNS, Caddy, Zertifikate

- Bevorzugt übernimmt der Router das STRATO-DynDNS für `pilot`, `staff-pilot`, `api-pilot`.
  Sonst `configure-secrets.sh dyndns` (macht sofort ein Probe-Update; bei `badauth` bleibt DynDNS
  aus) + `install-launchd.sh` (Agent alle 5 min, Update nur bei IP-Wechsel bzw. täglich; Antwort
  `good`/`nochg` = ok; Passwort nur in `secrets/dyndns.secret`). Der Updater akzeptiert
  ausschließlich die drei Pilot-Hosts aus `pilot.env` (alles andere, insbesondere `www`, Apex, MX,
  wird abgewiesen – kein Update). Fatale Antworten (`badauth`, `abuse`, `nohost`, `notfqdn`,
  `badagent`) stoppen den Updater dauerhaft (`run/dyndns-fatal`, Watchdog WARN, Pilot-Check FAIL);
  nach Behebung die Datei löschen. `911` ⇒ 30 min Pause.
- Caddy startet erst über `caddy-enable.sh`, wenn alle drei Hosts auf die eigene öffentliche IPv4
  zeigen – so werden keine Zertifikate ins Leere angefordert (Let's-Encrypt-Rate-Limits). Das
  Skript setzt die Freigabemarke `run/caddy-enabled`; ohne sie beendet sich der Caddy-Wrapper mit
  Exit 0 (kein Neustart durch launchd, kein Watchdog-Alarm außer WARN „nicht freigegeben“), und
  `start.sh`/`restart.sh` überspringen Caddy. Konfiguration: `config/caddy/Caddyfile` (aus der
  Vorlage gerendert; `render-caddyfile.sh` validiert die neue Datei VOR dem Austausch, die alte
  bleibt als `.bak`). Zertifikate und Erneuerung verwaltet Caddy (Daten unter `run/caddy-data`).
  Beim ersten Start fragt die macOS-Firewall nach („caddy eingehende Verbindungen erlauben?“) –
  `caddy-enable.sh` trägt das Binary per `socketfilterfw` ein (sudo); nach `brew upgrade caddy`
  `caddy-enable.sh` wiederholen oder den Dialog mit „Erlauben“ beantworten.
- Prüfen: `pilot-check.sh` (HTTPS 200 lokal über Caddy mit echtem Zertifikat – unabhängig davon,
  ob der Router NAT-Loopback kann; Zertifikat FAIL unter 14 Tagen Restlaufzeit; der externe Zugriff
  von innen ist nur INFO, maßgeblich ist die Prüfung aus dem Mobilfunknetz), `logs/caddy.log`.
  Der Watchdog prüft HTTPS/Zertifikat lokal alle 2 min. Caddy spricht nur HTTP/1.1 und HTTP/2
  (kein HTTP/3, da der Router nur TCP weiterleitet), setzt HSTS nur für die Pilot-Hosts und blockt
  auf dem Web-Host `/api/staff/*` und `/api/auth/*` (die Website nutzt nur `/api/public` und
  `/api/portal`). `render-caddyfile.sh` lädt ein laufendes Caddy nach erfolgreicher Validierung neu;
  `deploy.sh` übernimmt eine geänderte Vorlage aus dem Release. `MR_ACME_EMAIL` (Betreiberadresse)
  empfohlen – ohne E-Mail nutzt Caddy nur Let's Encrypt ohne ZeroSSL-Fallback.
- Unbekannte Hosts erhalten keinen TLS-Handshake bzw. werden auf Port 80 abgebrochen; der
  API-Host erlaubt nur `/webhooks/*`, `/public/calendar/*`, `/health`, `/ready`.
- Access-Log: nur minimal (`logs/caddy-access.log`, Caddy rotiert selbst), Cookies/Authorization/
  Referer entfernt, Query-Strings gelöscht, Token-Pfade (`/dokument`, `/angebot`, `/kontakt`,
  `/konto`, `/api/portal`, `/api/public`, `/public/calendar`, `/qr`, `/vorschau`, `/webhooks`,
  `/api/auth`) gar nicht geloggt, Client-IP maskiert; Fehlerantworten (z. B. 502 während eines
  Neustarts) laufen über `handle_errors`, damit auch das Fehlerlog keine Token-URIs enthält.
  Nachweis mit Testtoken: `grep -c <token> logs/*` muss 0 sein.

## 7. Worker und Jobs

- Operator-Sicht: Staff → Einstellungen → System (dead/retrying, Worker-Lebenszeichen) und
  Einstellungen → Kommunikation (Outbox). `status.sh` zeigt waiting/retrying/processing/dead und
  den letzten Worker-Erfolg. Jobs nie per SQL ändern (docs/DEPLOYMENT_NOTES.md „Betrieb im Pilot“).
- Watchdog startet den Worker neu, wenn fällige Jobs länger als 5 min warten – höchstens dreimal
  pro Stunde, danach Status CRIT (`run/watchdog-status.txt`).

## 8. Störungen

| Störung | Vorgehen |
| --- | --- |
| Stromausfall / Neustart | Mac startet (pmset `autorestart 1`), FileVault verlangt die Anmeldung von Dennis; danach starten alle LaunchAgents automatisch. Prüfen: `status.sh`, `pilot-check.sh`. Nie FileVault deaktivieren. |
| Routerausfall / neue öffentliche IP | Dienste laufen weiter; DynDNS (Router oder Agent) aktualisiert die Hosts, Caddy behält Zertifikate. Prüfen: `pilot-check.sh` (DNS = eigene IP), `logs/dyndns.log`. |
| Kurzer Netzausfall | API/Worker/DB lokal unberührt; Caddy nimmt Verbindungen wieder an; keine Jobdoppelung (at-least-once, Lease 5 min). |
| SSD voll | Watchdog meldet WARN (< 20 %) / CRIT (< 10 %); Backups laufen nicht mehr an (Platzprüfung). Nie Storage-Dateien löschen; alte Releases (`releases/` ohne current/previous) und Logs (`logs/*.gz`) zuerst, dann Retention prüfen. |
| Mailausfall | Zustellungen bleiben `retry`/`failed` in der Outbox; Einstellungen → Kommunikation „Erneut senden“; Zugang prüfen mit `mail-smoke.sh <eigene Adresse>`; `outcome_unknown` nur bewusst wiederholen. |
| Datenbankfehler | `/ready` 500, Watchdog CRIT; `brew services restart postgresql@18`; Logs `$(brew --prefix)/var/log/postgresql@18.log`; bei Beschädigung Restore (Abschnitt 5), nie in die laufende DB hinein. |
| Dienst startet nicht | `logs/<dienst>.log`, `launchctl print gui/$(id -u)/de.mietroyal.pilot.<dienst>`; Konfigurationsfehler beenden API/Worker fail-closed mit Variablennamen (nie Werten). |
| Deployment rot | deploy.sh fällt automatisch auf das vorige Release zurück; Ursache in `logs/build-*.log`, `logs/api.log`; Datenbank bleibt. |
| Zertifikat läuft ab | Caddy erneuert automatisch; wenn `pilot-check.sh` < 14 Tage meldet: Port 80/443 von außen, DNS, `logs/caddy.log`. |

## 9. Netzbetrieb, Sicherheit, Protokolle

- `pmset -c sleep 0 disksleep 0 displaysleep 15 autorestart 1` (nur Netzbetrieb; vorherige Werte in
  `config/pmset-before.txt`, einmalig gesichert). Batteriebetrieb unverändert. Bildschirm sperren,
  nie abmelden. **Deckel offen lassen** oder Clamshell-Betrieb (externes Display + Netzteil):
  bei geschlossenem Deckel schläft ein MacBook trotz `pmset`; das Inventar zeigt den
  Deckelzustand (`AppleClamshellState`).
- Öffentlich nur 80/443 (Caddy). PostgreSQL/API/Web/Staff/Worker nur `127.0.0.1`. Keine
  Routerfreigabe für 22/5432/3000–3002. macOS-Firewall nicht deaktivieren.
- Logs: `MR_BASE/logs/` (Dienste, Watchdog, Backup, DynDNS); `rotate-logs.sh` täglich
  (copytruncate, 14 Archive). PII-Grep wie in Phase 18/19 gegen die Logs; `secret-scan.sh` nach
  jeder Secret-Änderung.
- Inventar aktualisieren: `inventory.sh docs/PILOT_MACBOOK_INVENTORY.md` (keine Seriennummern).
