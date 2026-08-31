# TECH_DECISIONS — Technische Entscheidungen (Phase 0)

Stand: 2026-08-31. Jede Entscheidung ist bewusst „langweilig/stabil“
(PHASE_00_FOUNDATION.md) und gilt, bis sie hier ausdrücklich revidiert wird.
Keine spontanen Framework-/ORM-Wechsel (CLAUDE.md „Dependencies“).

## Monorepo & Tooling

| Entscheidung   | Wahl                             | Begründung                                                                                                                                                                                                                       |
| -------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace      | pnpm 10 Workspaces               | Von ARCHITECTURE.md empfohlen; strikte Abhängigkeiten pro Paket, schnell, verbreitet.                                                                                                                                              |
| Sprache        | TypeScript **6.0.3**, strict     | 7.0 (nativer Compiler) ist erschienen, wird aber von typescript-eslint (< 6.1.0) noch nicht unterstützt. 6.0.x ist die aktuellste stabile, ökosystem-kompatible Version. Upgrade auf 7.x später als bewusster, separater Schritt. |
| Lint           | ESLint 10 (Flat Config) + typescript-eslint 8 | Standard; `no-explicit-any` als Fehler (CLAUDE.md „kein routinemäßiges any“).                                                                                                                                       |
| Format         | Prettier 3                       | Standard; Spezifikationsdokumente (`CLAUDE.md`, `docs/`, `prompts/`) sind ausgenommen, damit Fachdokumente byte-identisch bleiben.                                                                                                 |
| Interne Pakete | TS-Source-Exports (`./src/index.ts`) | Pakete werden nicht separat gebaut; API/Worker laufen über tsx, Next transpiliert selbst, Vitest liest TS direkt. Kein doppelter Build-Graph in Phase 0. Wenn später ein kompilierter Artefakt-Build nötig wird (z. B. Docker-Image ohne tsx), wird das als eigener Schritt eingeführt. |
| Node-Runtime   | Node ≥ 22.12 (LTS), Ausführung über `tsx` | tsx ist esbuild-basiert, wartungsarm und produktionserprobt; vermeidet in Phase 0 einen Emit-/Bundle-Schritt. Trade-off dokumentiert (siehe DEPLOYMENT_NOTES.md).                                                            |

## Konfiguration

| Entscheidung | Wahl | Begründung |
| ------------ | ---- | ----------- |
| Env-Quelle   | **Nur echte Prozess-Umgebungsvariablen**, kein `.env`-Autoloading in Backend-Prozessen | Explizit und überraschungsfrei: Auf Servern kommen Werte aus systemd/Secrets; lokal setzen die Dev-Kommandos `APP_ENV=development` selbst und die development-Defaults greifen. Ein automatisch geladenes `.env` (mit je nach cwd unterschiedlichem Fundort im Monorepo) wäre eine stille zweite Konfigurationsquelle. `.env.example` bleibt Referenzliste; `pnpm check:env-isolation` liest env-Dateien bewusst nur als explizit übergebene Argumente. |
| Dev-Defaults | Nur bei `APP_ENV=development`, niemals für staging/demo/production | Fail-Fast in allen Serverumgebungen (fehlende Variable = Startabbruch mit Variablennamen, nie Werten). |

## Datenbank

| Entscheidung | Wahl                                   | Begründung                                                                                                                                                                                              |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DBMS         | PostgreSQL 18 (lokal via Docker)       | Vorgabe der Spezifikation; 18 ist die aktuelle stabile Major-Version.                                                                                                                                    |
| ORM          | **Drizzle ORM 0.45 + drizzle-kit**     | TS-first, gut gewartet, erzeugt **versionierte SQL-Migrationen** als Dateien (CLAUDE.md „jede Schemaänderung als versionierte Migration“), dünne Abstraktion ohne Magie. Alternative Prisma: eigener Engine-Prozess und generierter Client sind für dieses Projekt unnötige Komplexität. |
| Migrationen  | `packages/database/migrations`, angewendet über `pnpm db:migrate` | Migrationen liegen beim Schema-Paket (eine Quelle). ARCHITECTURE.md skizziert `migrations/` auf Top-Level – bewusste, hier dokumentierte Abweichung; die Anforderung „versioniert + reproduzierbar“ ist erfüllt. `db:generate` erzeugt, `db:migrate` wendet an – identisch in allen Umgebungen. |

## API

| Entscheidung | Wahl          | Begründung                                                                                                                                       |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework    | **Fastify 5** | Ausgereift, schnell, strukturierte pino-Logs eingebaut, sauberes Error-Handling. Express ist träger im Typing; NestJS wäre unnötiger Overhead.    |
| Validierung  | Zod 4 über `@mietroyal/validation` (`parseOrThrow`) | Eine Validierungsbibliothek für Config UND Requests; Fehler werden zentral als strukturierte 400 mit Feldpfaden (ohne Eingabewerte) beantwortet. |
| Fehlerform   | `{ error: { code, message, correlationId, issues? } }` | Einheitlich; interne Fehler nach außen generisch (keine Stacktraces, keine Pfade), vollständige Details nur im Server-Log.                        |
| Correlation  | `x-correlation-id` (eingehend übernommen, sonst UUID) | Durchgängige Nachverfolgbarkeit über API-Logs; Antwort trägt den Header immer.                                                                    |

## Hintergrundjobs

| Entscheidung | Wahl                                                        | Begründung                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue        | **Eigene PostgreSQL-Queue** (`FOR UPDATE SKIP LOCKED`) auf `integration_jobs` | ARCHITECTURE.md verlangt eine „PostgreSQL-basierte Jobqueue als schlanken Start“. Die Tabelle entspricht direkt der DATA_MODEL-Entität *IntegrationJob* (type, idempotency_key, status, attempts, retry-Zeit, error) und liegt in unseren eigenen versionierten Migrationen. pg-boss wurde erwogen, verwaltet sein Schema aber selbst (kollidiert mit unserer Migrationsregel) und bringt mehr Features als Phase 0 braucht. |
| Idempotenz   | `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING`        | Doppelte Enqueues erzeugen nie einen zweiten Job (CLAUDE.md „Schutz vor Doppelaktionen“).                                                                                                                                                        |
| Retry        | Exponentieller Backoff (30 s Basis, Faktor 2, Cap 1 h), danach Status `dead` | Vorhersagbar und getestet; „dead“-Jobs sind der Anker für spätere Admin-Benachrichtigung (INTEGRATIONS.md).                                                                                                                                       |
| Crash-Recovery | **Lease-/Visibility-Timeout** (`lease_expires_at`, Default 5 min) + `reclaimExpired()` zu Beginn jedes Worker-Ticks | Ein Worker-Absturz (SIGKILL, OOM, Stromausfall) darf keinen Job dauerhaft in `processing` stranden lassen. Jeder Claim setzt eine Lease; abgelaufene Leases werden atomar wieder auf `pending` gesetzt (oder `dead` bei erschöpften Versuchen). `markSucceeded`/`markFailed` prüfen zusätzlich `locked_by`, damit ein Zombie-Worker einen bereits neu vergebenen Job nicht mehr verändert. Konsequenz: **at-least-once** – Handler müssen idempotent sein, und die Lease muss deutlich über der längsten Job-Laufzeit liegen. |
| Abstraktion  | `JobQueue`-Interface + `JobRunner` in `packages/integrations` | Aufrufer hängen am Interface, nicht an SQL – ein späterer Wechsel (z. B. pg-boss) bliebe lokal. Der Runner erlaubt keinen `start()` während eines laufenden Betriebs oder eines nicht abgeschlossenen `stop()` (wirft), damit nie zwei Poll-Schleifen parallel laufen.                                                                                                                                                  |

## Storage

| Entscheidung | Wahl                                               | Begründung                                                                                                                                                  |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface    | `StorageProvider` (put/get/exists/delete)          | Provider hinter Interface (CLAUDE.md); Schlüsselvalidierung verhindert Pfad-Traversal.                                                                       |
| Phase 0      | Filesystem-Provider (Entwicklung/Tests)            | Kein externer Dienst nötig, um lokal zu starten (PHASE_00_FOUNDATION.md Nr. 5/8).                                                                            |
| Später       | S3-kompatibler Provider                            | Die Konfiguration (Endpoint, Bucket, Credentials je Umgebung) ist in `packages/config` bereits vollständig vorgesehen; der Provider kommt mit dem ersten echten Datei-Feature. MinIO wird erst dann in `infra/docker-compose.yml` aufgenommen. |

## Frontends

| Entscheidung | Wahl                       | Begründung                                                                                                     |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Web & Staff  | Next.js 16 (App Router) + React 19 | Von ARCHITECTURE.md empfohlen; Staff-Shell ist mobile-first (spätere PWA). Phase 0: neutrale Shells ohne Branding und ohne Fachnavigation. |
| UI-Lint      | Nur Basis-ESLint           | `eslint-config-next`/React-Hooks-Regeln werden mit der ersten echten UI-Phase ergänzt, wenn es Hooks/Komponenten zu prüfen gibt.            |

## Tests

| Ebene       | Werkzeug                     | Phase-0-Abdeckung                                                                                                    |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Unit        | Vitest 4                     | Config-Validierung, Umgebungs-Isolation, Backoff, Storage-Keys, API-Fehlerform (fastify inject).                       |
| Integration | Vitest 4 + echtes PostgreSQL | Migrationen, /ready, Queue: enqueue → process → retry → dead → Idempotenz (Datenbank `mietroyal_test`).                |
| E2E         | Playwright 1.62              | Web-Shell rendert, API /health + strukturierte 404 (eigene Ports 3100/3101; `CHROMIUM_PATH` für vorinstallierte Browser). |
