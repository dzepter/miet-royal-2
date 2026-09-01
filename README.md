# Miet-Royal 2.0

Vollständiger Neuaufbau des Miet-Royal-Vermietungssystems: öffentliche Website,
Slush-Konfigurator, Kundenbereich, Mitarbeiter-PWA, Maschinen-/Lagerverwaltung,
Ausgabe/Rückgabe, Abrechnung und Integrationen.

**Leitprinzip: Das System darf intern komplex sein. Für Mitarbeitende und
Kunden muss es einfach wirken.**

Aktueller Stand: **Phase 2 (Kunden, Vorgänge, Zuständigkeit & globale
Suche) umgesetzt** — auf Basis von Phase 1 (Staff-Authentifizierung mit
TOTP-2FA, serverseitige Sessions, App-Sperre, granulare Rollen/Rechte):
Kundenstammdaten mit Dublettenwarnung, zentrale Vorgänge mit race-sicherer
MR-Nummer, Zuständigkeit, interne Notizen, Abschluss-/Sichtbarkeitslogik,
Kunden-Papierkorb und tippfehlertolerante globale Suche (pg_trgm).
Angebote, Buchungen, Maschinen & Lager folgen ab Phase 3.

## Voraussetzungen

- Node.js ≥ 22.12 (LTS)
- pnpm ≥ 10 (`corepack enable` oder `npm i -g pnpm`)
- Docker + Docker Compose (für PostgreSQL)

## Schnellstart

```bash
pnpm install        # Abhängigkeiten
pnpm infra:up       # PostgreSQL 18 (Datenbanken: dev/test/demo)
pnpm db:migrate:dev # versionierte Migrationen auf die lokale Dev-DB anwenden
pnpm dev            # alle Apps im Watch-Modus
```

Diese vier Befehle funktionieren auf einem frischen Checkout ohne weitere
Konfiguration: Die Entwicklungs-Kommandos (`pnpm dev`, `pnpm db:migrate:dev`)
setzen selbst `APP_ENV=development`, und nur in dieser Umgebung greifen sichere
lokale Defaults (passend zu `infra/docker-compose.yml`). Für staging/demo/
production gibt es keine Defaults – dort müssen alle Variablen explizit gesetzt
sein, sonst bricht der Start ab (siehe `docs/ENVIRONMENTS.md`). Danach:

- Web: http://localhost:3000
- Staff: http://localhost:3002 (Anmeldung; erstes Konto über `pnpm staff:bootstrap-admin`)
- API: http://localhost:3001/health und http://localhost:3001/ready

## Kommandos (Repo-Wurzel)

| Kommando                               | Zweck                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm install`                         | Abhängigkeiten installieren                                                      |
| `pnpm dev`                             | Alle Apps parallel im Watch-Modus                                                |
| `pnpm build`                           | Produktionsbuilds (Next-Apps)                                                    |
| `pnpm lint` / `lint:fix`               | ESLint                                                                           |
| `pnpm format` / `format:check`         | Prettier                                                                         |
| `pnpm typecheck`                       | `tsc --noEmit` über alle Pakete                                                  |
| `pnpm test`                            | Unit-Tests (ohne Infrastruktur lauffähig)                                        |
| `pnpm test:integration`                | Integrationstests gegen echtes PostgreSQL (`pnpm infra:up` zuerst)               |
| `pnpm test:e2e`                        | Playwright-E2E (startet Web + API auf Ports 3100/3101)                           |
| `pnpm db:generate`                     | Neue SQL-Migration aus Schemaänderung erzeugen                                   |
| `pnpm db:migrate`                      | Migrationen anwenden (`APP_ENV`/`DATABASE_URL` müssen gesetzt sein – für Server) |
| `pnpm db:migrate:dev`                  | Migrationen auf die lokale Entwicklungs-DB anwenden                              |
| `pnpm api` / `pnpm worker`             | API bzw. Worker einzeln starten                                                  |
| `pnpm infra:up` / `infra:down`         | Lokale Infrastruktur (PostgreSQL) starten/stoppen                                |
| `pnpm check:env-isolation a.env b.env` | Prüft, dass zwei Umgebungen DB/Storage/Secrets nicht teilen                      |

Hinweis E2E: In Umgebungen mit vorinstalliertem Chromium
`CHROMIUM_PATH=/pfad/zur/chromium pnpm test:e2e`; sonst einmalig
`pnpm --filter @mietroyal/e2e exec playwright install chromium`.

## Struktur

```text
apps/
  web/        öffentliche Website (Next.js, Phase-0-Shell)
  staff/      Mitarbeiter-App (Next.js, Phase-0-Shell, später PWA)
  api/        Fastify-API (/health, /ready, Fehler-/Validierungsbasis)
  worker/     Hintergrundjob-Worker (PostgreSQL-Queue)
packages/
  config/     Umgebungs-Konfiguration + Demo/Live-Isolationsprüfung
  database/   Drizzle-Schema, Client, versionierte Migrationen
  domain/     zentrale Geschäftslogik (ab Phase 2+)
  permissions/ granulare Rechte (ab Phase 1)
  documents/  PDF-/Dokumenterzeugung (spätere Phasen)
  integrations/ Jobqueue, Storage-Interface, spätere Provider
  ui/         gemeinsame UI-Bausteine (spätere Phasen)
  validation/ Zod-Basis für serverseitige Validierung
tests/e2e/    Playwright-Smoke-Tests
infra/        Docker Compose (PostgreSQL + Init-SQL)
docs/         Spezifikation + TECH_DECISIONS / ENVIRONMENTS / DEPLOYMENT_NOTES
prompts/      Phasen-Prompts (PHASE_00_FOUNDATION.md)
```

## Spezifikation

Verbindliche Arbeitsregeln: `CLAUDE.md`. Fachlicher Umfang: `docs/MASTER_SPEC.md`,
Geschäftsregeln: `docs/DOMAIN_RULES.md`, außerdem `DATA_MODEL.md`,
`PERMISSIONS.md`, `UX_RULES.md`, `INTEGRATIONS.md`, `ARCHITECTURE.md`,
`TEST_PLAN.md`, `ROADMAP.md`, `OPEN_ITEMS.md`, `DECISIONS_LEDGER.md`.

Nie das gesamte System in einem einzigen Lauf bauen: immer eine
Roadmap-Phase implementieren, testen, abnehmen, dann weiter
(nächste Phase: ROADMAP.md „1 Staff Auth & Permissions“).

Technische Entscheidungen der Foundation: `docs/TECH_DECISIONS.md`.
