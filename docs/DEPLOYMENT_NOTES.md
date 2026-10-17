# DEPLOYMENT_NOTES — Grundlage (Phase 0)

Provider-neutral (ARCHITECTURE.md „Hosting“); Ziel ist ein Linux-VPS oder
vergleichbarer Cloud-Server. Dieses Dokument wächst mit den Phasen; hier steht
nur, was die Foundation bereits festlegt.

## Prozesse

| Prozess | Start                                   | Zweck                                   |
| ------- | --------------------------------------- | ---------------------------------------- |
| API     | `pnpm api` (`apps/api`, tsx)            | HTTP-API inkl. `/health` und `/ready`.   |
| Worker  | `pnpm worker` (`apps/worker`, tsx)      | Verarbeitet die PostgreSQL-Jobqueue.     |
| Web     | `pnpm --filter @mietroyal/web build && … start`   | Öffentliche Website (Next.js).  |
| Staff   | `pnpm --filter @mietroyal/staff build && … start` | Mitarbeiter-App (Next.js).      |

Alle Prozesse werden über einen Prozessmanager (z. B. systemd) mit den
Umgebungsvariablen der jeweiligen Umgebung betrieben (kein `.env`-Autoloading,
siehe TECH_DECISIONS.md).

**Pflichtwert für den Staff-Server in staging/production:**
`STAFF_OFFLINE_LEASE_VERIFICATION_KEY` (öffentlicher Ed25519-Verifikations-
schlüssel der Offline-Lease, kein Secret; Wert per `pnpm offline:lease-key`
in der API-Umgebung ausgeben). Ohne diesen Wert ist der Offlinebetrieb der
Staff-App dort bewusst gesperrt (fail-closed), der Online-Betrieb läuft
normal. Nach jeder Rotation von `AUTH_SECRET_KEY` neu ausgeben und setzen.
Details: ENVIRONMENTS.md „Offline-Lease-Verifikationsschlüssel“.

Worker-Hinweis: Die Jobqueue arbeitet **at-least-once** mit Lease-basierter
Crash-Recovery (Default 5 min, `PostgresJobQueueOptions.leaseMs`). Mehrere
Worker-Instanzen sind sicher (SKIP LOCKED); Job-Handler müssen idempotent
sein, und die Lease muss deutlich über der längsten Job-Laufzeit liegen. API und Worker laufen in
Phase 0 über tsx direkt aus TypeScript; falls später ein kompilierter Build
gewünscht ist, wird das als eigene Entscheidung in TECH_DECISIONS.md ergänzt.

## Release-Ablauf (CLAUDE.md „Deployment“)

1. Implementieren + lokale Tests (`pnpm lint && pnpm typecheck && pnpm test`).
2. Integration/E2E gegen lokale Infrastruktur (`pnpm infra:up`,
   `pnpm test:integration`, `pnpm test:e2e`).
3. Staging deployen, dort abnehmen.
4. **Backup vor kritischem Release** (Datenbank + Storage, siehe
   ARCHITECTURE.md „Backups“).
5. `pnpm check:env-isolation <prod.env> <demo.env>` — Release abbrechen, wenn
   Umgebungen kollidieren.
6. Migrationen anwenden: `pnpm db:migrate` (läuft vor dem App-Start; nur
   versionierte Migrationen, keine manuellen Schemaänderungen).
6a. Staging/Production-Checkliste Offline: `STAFF_OFFLINE_LEASE_VERIFICATION_KEY`
   beim Staff-Server gesetzt und identisch mit `pnpm offline:lease-key` der
   zugehörigen API-Umgebung (Production ≠ Demo); sonst keine Offline-Lease.
7. Prozesse neu starten, dann Smoke Test: `/health` muss 200 liefern,
   `/ready` muss 200 liefern (prüft die Datenbankverbindung).
8. Bei Fehlern: Rollback auf vorherigen Stand + Backup-Restore-Pfad.

Claude Code deployt niemals eigenmächtig auf Produktion.

## Lexware Office (Phase 10)

- Variablen: `LEXWARE_API_KEY` (Pflicht für aktive Anbindung in production,
  sonst bleibt die Buchhaltung „nicht konfiguriert“), `LEXWARE_ORGANIZATION_ID`
  (gepinnt), `LEXWARE_WEBHOOK_CALLBACK_URL` (öffentliche HTTPS-URL der API,
  Pfad `/webhooks/lexware`, Zertifikat „Grade A“), optional
  `LEXWARE_API_KEY_REMINDER_DATE`. In demo darf KEIN Key gesetzt sein; in
  development/staging nur mit `LEXWARE_ENABLED=true`. `LEXWARE_BASE_URL` ist
  in production verboten (fester Host `https://api.lexware.io`).
- Berechtigungen des Keys (Least Privilege, siehe docs/LEXWARE_API_NOTES.md):
  Profil lesen; Kontakte lesen/schreiben; Rechnungen lesen/schreiben;
  Zahlungen lesen; Belegliste lesen; Rechnungsdatei lesen;
  Event-Subscriptions lesen/anlegen/löschen.
- Key-Rotation (spätestens alle 24 Monate, Lexware-Ablauf): neuen Key in der
  Lexware-Key-Verwaltung erzeugen → `LEXWARE_API_KEY` auf API und Worker
  setzen → Prozesse neu starten → `pnpm lexware:setup` ausführen (Lexware
  löscht beim Invalidieren des alten Keys dessen Subscriptions; der Befehl
  legt fehlende Subscriptions idempotent neu an) → in Einstellungen → Lexware
  „Verbindung prüfen“. Keine automatische Rotation; das Ablaufdatum liefert
  Lexware nicht per API – ggf. `LEXWARE_API_KEY_REMINDER_DATE` pflegen.
- Erstinbetriebnahme: Steuerkonfiguration (Einstellungen → Steuern) mit
  Buchhaltung/Steuerberatung festlegen – ohne vollständige Konfiguration
  blockiert production jede Rechnung; `pnpm lexware:setup`; Testlauf mit
  `LEXWARE_SMOKE=1 pnpm lexware:smoke` (liest nur Profil und Subscriptions).
- Betrieb: Webhooks sind der primäre Rückkanal; `pnpm lexware:reconcile`
  bzw. „Zahlungsstatus abgleichen“ nur für Ausnahmefälle (kein Polling).
  Bei `token.revoked`/401 zeigt die Adminansicht „Verbindung getrennt“ –
  Key erneuern, Setup wiederholen.
- Der Rechnungsversand per E-Mail ist NICHT Teil der Public API: Rechnungen
  stehen in Lexware (Deeplink) und tragen in Miet-Royal „Versand ausstehend“
  bis Phase 12 den zentralen Mailadapter liefert.

## Healthchecks

- `/health`: Prozess lebt (ohne Abhängigkeiten) – für Prozessmanager/Uptime.
- `/ready`: Datenbank erreichbar – für Load-Balancer/Deploy-Gates.

## Offene Punkte für spätere Phasen

- Konkreter Hoster/VPS (OPEN_ITEMS.md „Hosting“), TLS/Reverse Proxy,
  Firewall, Rate Limits.
- S3-kompatibler Object Storage je Umgebung.
- Rechnungsversand per Miet-Royal-Mailadapter (Phase 12) – bis dahin
  `invoice_delivery_status = pending`.
- Backup-Automatisierung + Restore-Test (ARCHITECTURE.md).
- CI-Pipeline (Lint/Typecheck/Tests auf jedem Push).
