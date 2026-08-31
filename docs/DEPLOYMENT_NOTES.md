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
Umgebungsvariablen der jeweiligen Umgebung betrieben. API und Worker laufen in
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
7. Prozesse neu starten, dann Smoke Test: `/health` muss 200 liefern,
   `/ready` muss 200 liefern (prüft die Datenbankverbindung).
8. Bei Fehlern: Rollback auf vorherigen Stand + Backup-Restore-Pfad.

Claude Code deployt niemals eigenmächtig auf Produktion.

## Healthchecks

- `/health`: Prozess lebt (ohne Abhängigkeiten) – für Prozessmanager/Uptime.
- `/ready`: Datenbank erreichbar – für Load-Balancer/Deploy-Gates.

## Offene Punkte für spätere Phasen

- Konkreter Hoster/VPS (OPEN_ITEMS.md „Hosting“), TLS/Reverse Proxy,
  Firewall, Rate Limits.
- S3-kompatibler Object Storage je Umgebung.
- Backup-Automatisierung + Restore-Test (ARCHITECTURE.md).
- CI-Pipeline (Lint/Typecheck/Tests auf jedem Push).
