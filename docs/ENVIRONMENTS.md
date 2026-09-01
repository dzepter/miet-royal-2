# ENVIRONMENTS — Umgebungen und Konfiguration

## Die vier Umgebungen

| APP_ENV       | Zweck                                  | Konfigquelle                                    |
| ------------- | -------------------------------------- | ------------------------------------------------ |
| `development` | Lokale Entwicklung                     | Sichere Defaults im Code (passend zu `infra/docker-compose.yml`); alles per Env-Variable überschreibbar. |
| `staging`     | Vorabnahme vor Produktion              | Alle Variablen explizit als Secrets/Env gesetzt. |
| `demo`        | Demo/Training (MASTER_SPEC Nr. 29)     | Alle Variablen explizit; **eigene** DB, Storage, Secrets. |
| `production`  | Live-Betrieb                           | Alle Variablen explizit; niemals mit demo geteilt. |

`APP_ENV` ist von `NODE_ENV` getrennt: `NODE_ENV` steuert nur
Framework-Optimierungen, `APP_ENV` die fachliche Umgebung.

## Regeln (verbindlich, CLAUDE.md „Live / Demo / Staging“)

- Getrennte Datenbanken, getrennte Secrets, getrennte Storage-Konfiguration.
- Für `staging`/`demo`/`production` gibt es **keine Defaults**: fehlt eine
  Pflichtvariable, bricht der Start sofort mit einer Fehlermeldung ab, die nur
  Variablennamen nennt (nie Werte).
- Echte Secrets niemals ins Repository oder in Chat-Prompts – nur als
  Umgebungsvariablen/Secrets auf dem Zielsystem.
- Backend-Prozesse (API, Worker, Migrationen) lesen ausschließlich echte
  Prozess-Umgebungsvariablen; eine `.env`-Datei wird **nicht** automatisch
  geladen (bewusste Entscheidung, siehe TECH_DECISIONS.md). `.env.example`
  ist eine Referenzliste der Variablennamen; `.env`-Dateien sind gitignored
  und werden nur vom Isolations-Check explizit als Dateien eingelesen.

## Variablen

Siehe `.env.example` für die vollständige Liste. Pflicht außerhalb von
development: `APP_ENV`, `DATABASE_URL`, `AUTH_SECRET_KEY` (≥ 32 Zeichen,
verschlüsselt u. a. TOTP-Secrets im Ruhezustand; je Umgebung ein eigener
Zufallswert – der Isolations-Check erzwingt das), `STORAGE_DRIVER` (+ die zum
Treiber gehörenden `STORAGE_*`-Variablen). Optional: `AUTH_ALLOWED_ORIGINS`
(CSRF-Legacy-Fallback, meist leer). Optional mit Defaults: `API_HOST` (127.0.0.1),
`API_PORT` (3001), `LOG_LEVEL` (debug in development, sonst info),
`WORKER_POLL_INTERVAL_MS` (2000).

## Lokale Entwicklung

`pnpm infra:up` startet PostgreSQL 18 mit drei getrennten Datenbanken:

| Datenbank        | Zweck                          |
| ---------------- | ------------------------------ |
| `mietroyal_dev`  | Entwicklung (`APP_ENV=development`-Default) |
| `mietroyal_test` | Integrationstests (`TEST_DATABASE_URL`)     |
| `mietroyal_demo` | Lokale Demo-Experimente        |

Lokale Verbindungsdaten (kein Geheimnis, nur Docker-lokal; der Port ist
ausschließlich an 127.0.0.1 gebunden):
`postgresql://mietroyal:mietroyal_local_dev@localhost:55432/<datenbank>`

Die Dev-Kommandos (`pnpm dev`, `pnpm db:migrate:dev`) setzen
`APP_ENV=development` selbst; nur in dieser Umgebung greifen die obigen
Defaults automatisch. Wer API/Worker einzeln mit `pnpm api`/`pnpm worker`
startet, setzt `APP_ENV=development` (bzw. die vollständige Serverkonfiguration)
explizit in der Shell.

## Isolation prüfen (produktionsnaher Check)

`assertConfigsIsolated` (`@mietroyal/config`) erkennt Kollisionen zweier
Umgebungen: gleiche Datenbank (auch bei kosmetisch unterschiedlicher URL),
gleicher S3-Bucket/Endpoint, gleiche S3-Zugangsdaten, gleiches
Storage-Verzeichnis. Vor jedem Deployment mit realen Serverkonfigurationen
ausführen:

```bash
pnpm check:env-isolation /pfad/zu/prod.env /pfad/zu/demo.env
```

Exit-Code 0 = isoliert; 1 = Kollision (der Report nennt die betroffenen
Variablen, nie deren Werte). Die gleichen Prüfungen laufen als Unit-Tests in
`packages/config/test/load-config.test.ts`.
