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

## Mitarbeiter-Authentifizierung & Berechtigungen (Phase 1)

| Entscheidung | Wahl | Begründung |
| ------------ | ---- | ----------- |
| Passwort-Hashing | **Argon2id** über `@node-rs/argon2` (19 MiB, t=2, p=1 – OWASP-Empfehlung) | Etablierte Bibliothek mit vorgebauten nativen Binaries; keine Eigenkryptografie. |
| Passwortregeln | Mindestens 10, höchstens 128 Zeichen; KEINE Kompositionsregeln | Phase-1-Vorgabe: passwortmanager-freundlich; Länge schlägt Zwangszeichen. |
| Sessions | Opake 256-Bit-Zufallstokens; in der DB nur der SHA-256-Hash; HttpOnly-Cookie `mr_staff_session`, SameSite=Strict, Secure außerhalb development | Serverseitig jederzeit widerrufbar (keine Langzeit-JWTs). Ein DB-Leak liefert keine verwendbaren Tokens. Session-IDs entstehen ausschließlich serverseitig nach vollständigem Login → keine Session-Fixation. |
| Session-Laufzeit | 30 Tage Inaktivität → endgültig widerrufen; 15 Minuten Inaktivität → App-Sperre (Session bleibt, Entsperren mit Passwort über /auth/unlock) | ARCHITECTURE.md + Phase-1-Vorgabe Nr. 5/6. Beides wird serverseitig durchgesetzt; die UI spiegelt es nur. |
| CSRF | SameSite=Strict + Same-Origin-Proxy der Staff-App (`/api/*`-Rewrite) + serverseitige Prüfung: `Sec-Fetch-Site: cross-site` wird blockiert, Legacy-Fälle mit Origin-Header nur per Allowlist (`AUTH_ALLOWED_ORIGINS`) | Header-basierte Prüfung funktioniert auch hinter Proxies; kein Token-Tanz nötig. |
| Brute-Force | `@fastify/rate-limit` per Route (Login/TOTP/Unlock: 10/min pro IP, Reset: 5/15min) | Einfach und wirksam für eine Instanz. Verteiltes/kontobasiertes Limit: bewusst offen (siehe Deferred). |
| 2FA | TOTP (RFC 6238) über `otpauth`; QR-Code serverseitig via `qrcode`; Secrets **AES-256-GCM-verschlüsselt** (Schlüssel aus `AUTH_SECRET_KEY`, je Umgebung eigen); 10 Recovery-Codes, nur als Hash gespeichert, je einmal verwendbar | Authenticator-Apps sind der Phase-1-Standard; keine Sicherheitsfragen. Zweistufiger Login über kurzlebige, gehashte Login-Challenges (5 min) statt halbfertiger Sessions. |
| Login-Fehler | Eine neutrale Meldung für falsches Passwort, unbekannte E-Mail, gesperrt und deaktiviert; Timing durch Dummy-Argon2-Prüfung angeglichen | Keine internen Details/Status nach außen (Phase-1-Vorgabe Nr. 1). |
| Rechteberechnung | (Rollen ∪ gültige Allows) ∖ gültige Denies; **Deny gewinnt immer**, auch gegen gleichzeitig gültige befristete Allows | PERMISSIONS.md definiert keine Präzedenz; Deny-gewinnt ist die sicherheitskonservative Standardinterpretation. Befristungen werden bei JEDER Berechnung gegen die aktuelle Zeit geprüft – kein Background-Job. |
| Sofortwirkung | Rechte werden bei jeder Anfrage frisch aus der DB berechnet; nichts wird in Session/Cookie eingefroren | Phase-1-Vorgabe Nr. 11. Bei heutigen Nutzerzahlen unkritisch; ein Cache wäre eine spätere, bewusste Optimierung. |
| Letzter-Admin-Schutz | Nach jeder Status-/Rechte-Mutation prüft dieselbe Transaktion, ob noch ein aktiver Mitarbeiter `employee.manage` + `permission.manage` effektiv besitzt; sonst Rollback | Deckt alle Wege ab (Status, Rollen zuweisen/ändern/löschen, Overrides) inklusive indirekter Effekte über Rollenänderungen. |
| Erster Admin | `pnpm staff:bootstrap-admin` (Env-Variablen oder interaktive Prompts, Passwort unsichtbar); nur solange KEIN Konto existiert; legt Rolle „Administrator“ mit allen Katalogrechten an | Kein hardcodierter Admin, kein Masterpasswort, nichts im Repository. |
| Neue Mitarbeiter | Konto startet mit zufälligem, niemandem bekanntem Passwort; Admin erhält EINMALIG einen Einrichtungs-Link (7 Tage, einmal verwendbar), über den die Person ihr Passwort selbst setzt | Kein Passwort-Versand nötig, solange es keine Mail-Infrastruktur gibt. |
| Mail | Schmaler `StaffMailPort`-Adapter: development loggt den Reset-Link lokal, staging/demo/production sind bewusst still (kein Token in Logs), Tests injizieren In-Memory | Echte Mail-Infrastruktur kommt planmäßig später (INTEGRATIONS.md); nichts vorweggenommen. |
| Audit | Tabelle `staff_security_events`, nur sicherheitsrelevante Ereignisse (siehe Katalog in `apps/api/src/auth/audit.ts`); `details` nie mit Passwörtern/Tokens/Secrets | Phase-1-Vorgabe Nr. 14: bewusst klein, kein Tracking. `session.new_device_login` ist die Audit-Grundlage für den späteren Admin-Push (Phase 12). |

### Bewusst offen (Deferred, Phase 1)

- **Biometrie/WebAuthn als Geräteentsperrung**: Architektur ist vorbereitet
  (App-Sperre ist ein eigener Zustand auf der weiterlaufenden Session;
  /auth/unlock ist der einzige Entsperrpfad und kann später zusätzlich
  WebAuthn akzeptieren). Bewusst nicht in Phase 1 gebaut.
- **Admin-Push bei neuem Gerät**: kommt mit der Push-Infrastruktur (Phase 12);
  das Audit-Ereignis existiert bereits.
- **Verteiltes/kontobasiertes Brute-Force-Limit**: aktuelles Limit ist
  IP-basiert und pro Prozess (in-memory). Ausreichend für den geplanten
  Ein-Server-Betrieb; bei Mehrinstanzbetrieb bewusst nachrüsten.
- **Aufräumjob für abgelaufene Tokens/Challenges**: abgelaufene Einträge sind
  wirkungslos (Gültigkeit wird immer geprüft); ein Housekeeping-Job über die
  bestehende Queue folgt, wenn fachliche Jobs kommen.

### Härtungen aus dem adversarialen Phase-1-Security-Review

- **Letzter-Admin-Schutz, zeitlich robust**: Die Invariante wird nicht nur
  „jetzt“, sondern an jedem zukünftigen Override-Grenzzeitpunkt geprüft
  (vordatierter Deny / auslaufendes Sonderrecht können das System nicht
  admin-los machen).
- **Letzter-Admin-Schutz, nebenläufig robust**: transaktionsweiter
  PostgreSQL-Advisory-Lock serialisiert alle rechte-/statusrelevanten
  Mutationen (kein Write-Skew bei zwei gleichzeitigen Sperrungen).
- **Rate-Limits pro Konto statt pro Proxy**: keyGenerator = Client-IP +
  E-Mail/Challenge/Session (Hook `preHandler`, damit der Body verfügbar
  ist); zusätzlich `API_TRUST_PROXY_HOPS` für die echte Client-IP hinter
  dem Staff-Proxy (niemals pauschales trustProxy).
- **Admin-Reset-Weg**: `POST /staff/users/:id/reset-link` (employee.manage)
  erzeugt einen einmaligen 60-Minuten-Reset-Link – der dokumentierte
  Wiederherstellungspfad ohne Mail-Infrastruktur; mit UI-Button und Audit.
- **TOTP-Replay-Schutz**: der höchste akzeptierte RFC-6238-Zeitschritt wird
  je Konto gespeichert (Migration 0003) und atomar konsumiert – derselbe
  Code wird nie zweimal akzeptiert.
- **CSRF verschärft**: auch `Sec-Fetch-Site: same-site` wird blockiert
  (Schwester-Subdomains können keine Staff-Aktionen auslösen).
- **Session-Cookie mit Max-Age 30 Tage** (passend zur serverseitigen
  Inaktivitätsgrenze; Autorität bleibt der Server).
- **Atomare Einmal-Token**: Challenge/Reset-Token/Recovery-Codes werden mit
  WHERE-Guard + Treffer-Prüfung entwertet (kein Double-Spend im Rennen);
  Passwortwechsel/-reset entwertet zusätzlich alle offenen Reset-Tokens.
- **Unique-Rennen → 409** statt 500 (PG-Fehlercode 23505 zentral gemappt).
- **App-Sperre blickdicht**: im gesperrten Zustand wird der Seiteninhalt
  nicht mehr gerendert.
- **Sessionregel (vom Auftraggeber verbindlich entschieden)**: Die
  Mitarbeiter-Session läuft nach 30 Tagen INAKTIVITÄT ab; es gibt derzeit
  KEINE zusätzliche absolute Maximaldauer für regelmäßig aktive Sessions.
  Die 15-Minuten-App-Sperre bleibt unverändert. ARCHITECTURE.md wurde
  entsprechend korrigiert; die implementierte Logik war bereits korrekt.

## Phase 2: Kunden, Vorgänge, Zuständigkeit & globale Suche

| Thema | Entscheidung | Begründung |
| --- | --- | --- |
| Vorgangsnummer | PostgreSQL-Sequenz `process_number_seq` + Formatierung `MR-<Berliner Jahr>-<lfd. Nr., min. 4-stellig>` in einer Transaktion; Unveränderbarkeit zusätzlich per DB-Trigger `processes_number_immutable` | Sequenzen sind race-sicher ohne Locks (nie doppelt, nie wiederverwendet) und laufen fachgemäß über den Jahreswechsel weiter. Das Jahr kommt aus `Intl` mit Zeitzone Europe/Berlin, nicht aus UTC. Der Trigger schützt auch vor direkten SQL-Updates. |
| Tippfehlertolerante Suche | `pg_trgm` (Migration 0004) mit GIN-Indexen auf Name/Organisation/E-Mail/Vorgangsnummer; Treffer = ILIKE-Teilstring ODER `similarity() > 0.3`, Ranking per `GREATEST(similarity …)`, offene vor abgeschlossenen | In PostgreSQL bordeigen (Phase-2-Vorgabe: kein Elasticsearch). Erweiterung um neue Felder (z. B. Maschinen-ID) = zusätzlicher Matcher + ggf. Index in einer neuen Migration. |
| Zentrale Sichtbarkeitsregel | EINE Implementierung (`apps/api/src/crm/visibility.ts`) für Liste, Detail, Kundenakte, Suche und Dashboard: offen immer; abgeschlossen/storniert nur innerhalb `completed_process_staff_visibility_days` (Default 7, Admin-einstellbar, Tabelle `system_settings`); wieder geöffnet nur mit `process.view_completed` | „Keine Sicherheit durch UI“ – jede Route filtert serverseitig über dieselbe Regel; unsichtbares Detail liefert 404 (kein Existenz-Orakel). |
| Dubletten | Warnung (gleiche E-Mail, gleiche normalisierte Telefonnummer, `similarity > 0.5` bei Name/Organisation), niemals Blockade oder automatische Zusammenführung | Phase-2-Vorgabe Nr. 2: Der Mitarbeiter entscheidet bewusst; der Anlage-Endpunkt liefert die Warnungen mit, blockiert aber nicht. |
| Normalisierung | E-Mail: trim + lowercase. Telefon: zusätzliche Spalte `phone_normalized` (nur Ziffern, deutsche Vorwahl-Heuristik 0→49); die eingegebene Darstellung bleibt erhalten | Suche und Dublettenprüfung arbeiten auf der Normalform, Anzeige auf dem Original (Vorgabe Nr. 1). |
| Papierkorb | Soft-Delete (`deleted_at`/`deleted_by`) NUR für Kunden ohne Vorgänge; `trash.manage` (Admin), Wiederherstellungsfrist 30 Tage serverseitig erzwungen; für Vorgänge existiert kein Lösch-Endpunkt | Geschäftsvorgänge sind nie hart löschbar (Vorgabe Nr. 11); keine Legal-Retention-Engine in Phase 2. |
| Statusmodell | `main_status`: open / completed / reopened / cancelled als kleiner, erweiterbarer Hauptstatus; Statuswechsel transaktional mit Zustandsprüfung; UI zeigt deutsche Labels | Spätere Fachstatus (Angebot, Rückgabe, Abrechnung) kommen als eigene Module und ersetzen diesen Überstatus nicht. `cancel` setzt in Phase 2 nur den Status – Storno-Fachlogik (Gebühren etc.) folgt in Phase 9. |
| Berechtigungen | Ausschließlich das Phase-1-System; neue Katalogrechte: `process.edit`, `process.complete`, `process.view_completed`, `trash.manage` | Kein Parallelsystem. Neue Katalogrechte gelten für Systemadmins automatisch (siehe Systemadmin-Semantik, Phase-2-Finalisierung); normale Rollen erhalten neue Keys bewusst NICHT automatisch. |
| Zuständigkeit | `assigned_user_id` optional; NEUE Zuweisung nur an aktive Mitarbeitende, bestehende historische Referenzen bleiben bei Deaktivierung erhalten | Eine zentrale Auflösungsstelle (`ProcessService.assign`), auf der die spätere Vertretungslogik aufsetzen kann. |

### Bewusst offen (Deferred, Phase 2)

- **Papierkorb-Endreinigung**: Einträge älter als 30 Tage sind nicht mehr
  sichtbar/wiederherstellbar; die physische Endlöschung kommt als
  Housekeeping-Job, sobald die Queue fachliche Jobs erhält.
- **„Heute“-Dashboard**: Phase 2 liefert nur die Abfragegrundlage
  (offene / meine / neueste Vorgänge) – ohne Termine und Kalender.
- **Vorbereitete Vorgangs-Bereiche** (Angebot, Buchung, Lieferung,
  Abrechnung): als leere Struktur sichtbar, bewusst ohne Fake-Logik.

### Härtungen aus dem adversarialen Phase-2-Review

- **Datenminimierung im Vorgangsdetail**: `GET /staff/processes/:id` liefert
  vom Kunden nur Anzeige-/Kontaktdaten (Name/Organisation, E-Mail, Telefon);
  vollständige Stammdaten (Rechnungsadresse, USt-ID, Kostenstelle …) gibt es
  ausschließlich über `GET /staff/customers/:id` (customer.view).
- **Sichtbarkeitsregel auch auf Schreibpfaden**: PATCH/assign/complete/
  cancel/notes laden den Vorgang in einer Transaktion mit `FOR UPDATE` und
  wenden dieselbe Sichtbarkeitsregel an – unsichtbare Vorgänge sind auch
  beim Schreiben ein 404 (kein Status-Orakel, kein Bearbeiten unsichtbarer
  wieder geöffneter Vorgänge). Ausnahme bewusst: `reopen`, weil
  `process.reopen_completed` den Zugriff auf Abgeschlossene fachlich
  einschließt. Der Zeilen-Lock beseitigt zugleich Check-then-act-Rennen
  (z. B. Notiz vs. gleichzeitiges Abschließen).
- **Erstzuweisung = Zuweisung**: `POST /staff/processes` mit
  `assignedUserId` verlangt zusätzlich `process.reassign` (§7: „Zuweisung
  und Wechsel serverseitig berechtigungsgeprüft“).
- **Eigenes Storno-Recht**: `process.cancel` statt des Buchungsrechts
  `booking.cancel` (das bleibt für die spätere Buchungs-Fachlogik).
- **Keine Kundendaten in Logs**: Der Request-Serializer loggt URLs ohne
  Query-String (Suchbegriffe!), und Datenbankfehler (DrizzleQueryError
  trägt SQL + Parameter in message/stack) werden nur mit technischen
  Metadaten (PG-Code, Constraint, Tabelle) geloggt; der PG-Code 23505 wird
  jetzt auch aus `error.cause` erkannt (409 statt 500).
- **Kalender-echte Datumsvalidierung**: `31.02.` & Co. werden in Suche und
  eventDate-Schema abgewiesen (400 bzw. ignoriert) statt als
  PostgreSQL-Datumsfehler zu enden.
- **Suche konsistent zur Liste**: Die Standardsuche umfasst open UND
  reopened (gefiltert durch die zentrale Sichtbarkeitsregel); die
  Tippfehler-Arme nutzen den indexfähigen `%`-Operator PLUS explizite
  `similarity() > 0.3`-Schwelle (GUC-unabhängig; Klammerung nötig, da `%`
  stärker bindet als `||`).
- **Papierkorb ohne TOCTOU**: `moveToTrash` sperrt die Kundenzeile
  (`FOR UPDATE`), die Vorgangserstellung hält `FOR KEY SHARE` auf den
  Kunden – „löschen während gleichzeitig ein Vorgang entsteht“ ist damit
  serialisiert.
- **Bewusst NICHT geändert** (Reviewer-Vorschläge, verifiziert als nicht
  spezifikationswidrig): Der „Abgeschlossene einblenden“-Filter bleibt an
  `process.view_completed` gebunden (§15: Filter „darf“ angeboten werden,
  §17-Recht ist genau dieses); kein DB-Trigger gegen DELETE auf processes
  (es existiert keine Lösch-Funktion – Invariante erfüllt); die
  pg_trgm-Spezialobjekte leben nur in Migration 0004 (drizzle-kit kennt
  sie nicht, löscht sie aber auch nicht); der Dubletten-Check ist mit
  `customer.create` erreichbar (fachlich nötig für die Warnung beim
  Anlegen, minimale Felder).


## Phase-2-Finalisierung: Systemadmin-Semantik

| Thema | Entscheidung | Begründung |
| --- | --- | --- |
| Systemadmin-Erkennung | Stabile Spalte `staff_roles.is_system_admin` (Migration 0005); ein Benutzer ist Systemadmin, wenn er Mitglied mindestens einer Systemrolle ist. NIE über den frei änderbaren Anzeigenamen prüfen. | Auftraggeber-Vorgabe: Der Hauptadmin darf nach Updates niemals manuell neue Permission Keys benötigen. |
| Rechteberechnung | `effectivePermissions()` liefert für Systemadmins `fullPermissionSet()` – dynamisch ALLE aktuell im Katalog definierten Keys, auch zukünftige. Individuelle Deny-Overrides sind für Systemadmins wirkungslos (speicherbar, aber inert). | Neue Keys späterer Phasen gelten automatisch; ein Deny kann den Systemadmin nicht versehentlich entmachten. |
| Systemrolle | Die von `bootstrapFirstAdmin` angelegte Rolle „Administrator" trägt das Flag; sie ist nicht bearbeitbar/löschbar (ihre expliziten `staff_role_permissions` sind irrelevant und werden nicht mehr befüllt). Mehrere Systemadmins = mehrere Mitglieder dieser Rolle. | Eine geschützte Systemrolle statt Pro-Benutzer-Flag passt zur bestehenden Rollen-/Zuweisungsarchitektur. |
| Ernennung/Entzug | Nur ein bereits berechtigter Systemadmin darf die Systemrolle zuweisen oder entziehen (`FORBIDDEN` sonst, auch mit `permission.manage`). Beides wird auditiert (`permission.system_admin_granted/_revoked`). | Vier-Augen-Grundsatz auf der höchsten Berechtigungsstufe. |
| Letzter-Admin-Schutz | Invariante umgestellt: Es muss immer mindestens ein AKTIVER Mitarbeiter Mitglied einer Systemrolle sein (Advisory-Lock bleibt). Die frühere Override-basierte Abdeckung (unbefristete allow-Overrides auf employee.manage+permission.manage) zählt NICHT mehr; die zeitliche Grenzwertprüfung entfiel, weil die Eigenschaft strukturell und unbefristet ist. Zwei Phase-1-Tests wurden entsprechend an die neue Fachregel angepasst. | Die Systemadmin-Eigenschaft ist nicht zeitbefristet und nicht deny-bar – nur sie garantiert dauerhaft volle Verwaltungsfähigkeit. |
| Backfill | Migration 0005 markiert die Rolle „Administrator" (deterministischer Bootstrap-Name) einmalig; Sicherheitsnetz: existiert danach keine Systemrolle, werden Rollen mit employee.manage+permission.manage markiert. | Bestehende Installationen erhalten die Eigenschaft ohne Handarbeit; zur Laufzeit wird trotzdem nie über den Namen geprüft. |

## Phase 3: Produkte, Preise, Anfragen, Angebote & Auftragsbestätigung

- **Zentrale Preisengine**: `priceOffer()` in `@mietroyal/domain`
  (packages/domain/src/pricing.ts) ist die EINZIGE Stelle, die
  Angebotspreise berechnet – reine Funktion über Integer-Cents (kein
  Float; Basispunkte für Prozente, `divRound` für Rundung). Sie erzeugt
  die vollständige Positionsliste (Maschine, Gratis-Sirup „inklusive“,
  Extras als Kommission, Becher/Strohhalme 25+25 einmal inklusive,
  Kanister mit Max-2-je-Behälter-Regel, manueller Lieferpreis) samt
  Abrechnungsart `fixed`/`commission`/`included`. Der FESTE ANGEBOTSWERT
  enthält ausschließlich `fixed`-Positionen; Kommission wird separat als
  Maximalbetrag ausgewiesen. Keine MwSt-Logik – bewusst nirgends ein
  Steuersatz erfunden.
- **Rabatt-Schwellen mit Aufrundung**: Der effektive Rabatt-Prozentsatz
  eines EUR-Rabatts wird gegen die Maschinenmiete-Zwischensumme mit
  `ceil` in Basispunkten berechnet – Schwellen (10 %/20 %) können so nie
  durch Abrundung unterlaufen werden. Grund ab >10 % Pflicht, Freigabe
  ab >20 % (`discount.over_20_approve`); wer selbst freigeben darf, gibt
  mit dem Versand implizit frei. Sonderpreise speichern
  vorher/nachher/Mitarbeiter/Zeitpunkt in der Position UND im
  Versions-Eingabezustand; 0-EUR verlangt
  `offer.apply_special_price_zero`.
- **Zukünftige Preise ohne Background-Job**: `product_prices` mit
  `effective_from`; „aktueller Preis“ ist eine reine Datumsabfrage.
  Bereits wirksame Preise sind unveränderlich (CONFLICT), geplante frei
  änder-/löschbar. Versendete Angebote frieren Preise in
  `offer_line_items` ein und sind von jeder Preis-/Produktänderung
  unabhängig (Pflichttests 4/6).
- **Angebotsversionen**: Versand friert Kunden-/Event-Snapshot, Summen,
  `terms_version_id`, `sent_at`/`expires_at` ein; jede Änderung danach
  läuft über `createNewVersion` (Row-Locks auf Angebot+Version; die alte
  Version wird SOFORT `superseded` – nicht erst beim neuen Versand, damit
  es nie zwei annehmbare Stände gibt). Gültigkeit: Kalendertagdifferenz
  Europe/Berlin (`Intl`-basiert, DST-fest); Event in ≤14 Tagen → 3 Tage,
  sonst 7. `expires_at` ist persistiert; `expired`/`superseded` werden
  lazy als Effektivstatus berechnet (kein Cron).
- **Token-Rotation je Versand**: Jeder Versand widerruft alle alten
  Zugriffstoken des Angebots und erzeugt ein frisches 32-Byte-Token
  (base64url); die DB speichert NUR den SHA-256-Hash. Alte Links sind
  damit strukturell tot (E2E-Szenario D). Ungültige Token → neutrales
  404 ohne Detailpreisgabe; öffentliche Routen sind pro IP rate-limitiert.
- **Atomare, idempotente Annahme**: `accept()` läuft in einer Transaktion
  mit `FOR UPDATE` auf Angebot und Version; geprüft werden aktuell,
  versendet, nicht abgelaufen, nicht storniert, Daten vorhanden. Bereits
  angenommen → gleiche Buchungs-ID zurück (Doppel-Submit sicher). Die
  Buchung snapshottet Positionen/Summen aus dem VERSAND-Zeitpunkt und die
  Kundendaten zum ANNAHME-Zeitpunkt; spätere Profil-/Preisänderungen
  berühren sie nie. Die Auftragsbestätigung wird automatisch `prepared`.
- **AB-Freigabe blockiert ohne Abholadresse in JEDER Umgebung**: Die
  Order verlangt die Blockade mindestens in Production; wir blockieren
  Freigabe/`readiness` bei Selbstabholung auch in dev/test, solange
  `pickup_exact_address` fehlt (Tests/Seeds setzen eine klar als
  SYNTHETISCH markierte Adresse). Bewusst strenger als gefordert: eine
  nur-Production-Blockade wäre in dev nie getestet worden. Die exakte
  Adresse erscheint ausschließlich in der AB – nie im öffentlichen
  Angebot. Transporthinweise (aufrecht, gegen Umkippen sichern, nur
  Kofferraum/Ladefläche, Tragepersonen aus dem Produkt-Snapshot) stehen
  in der AB; Gewichte werden unterstützt, aber nicht erfunden (Seeds
  ohne Gewicht ⇒ keine Gewichtszeile).
- **Dokumente immutable**: Zentrale `documents`-Entität (Typ, Vorgang,
  Angebotsversion/Buchung, Storage-Key, SHA-256, Größe, `finalized_at`).
  Es existiert KEIN Update-Pfad; jede Erzeugung schreibt ein neues Objekt
  unter neuem Key. `bytesFor()` verifiziert beim Lesen den SHA-256 –
  manipulierter Storage fällt auf (CONFLICT). PDFs entstehen serverseitig
  (pdfkit, `compress:false`, damit Metadaten/Text im Bytestrom prüfbar
  sind); neutraler Titel `Angebot <Vorgang> V<n>` bzw.
  `Auftragsbestätigung <Vorgang>`; keine Steuertexte.
- **Storage privat, je Umgebung getrennt**: `StorageProvider`-Abstraktion
  aus Phase 0 mit `FilesystemStorageProvider` (dev/test) und
  `S3StorageProvider` (forcePathStyle, KEINE ACLs, kurzlebige
  `signedGetUrl`, Default 300 s). MinIO läuft als dev/test-Infra in
  `infra/docker-compose.yml`. `assertConfigsIsolated` erkennt gemeinsame
  Buckets/Endpoints/Zugangsdaten zwischen Umgebungen; Auslieferung nur
  über autorisierte API-Routen (`offer.view` für Staff, Token für
  Kunden). Frontends kennen keinerlei Storage-Secrets (Same-Origin-Proxy
  `/api/*`).
- **Versand über Gateway**: `OfferDeliveryGateway` mit
  `OutboxDeliveryGateway` (Tabelle `offer_deliveries`) für dev/test und
  `UnconfiguredProductionGateway`, das in Production hart mit CONFLICT
  blockt, solange kein echter Versandweg konfiguriert ist. Analog
  Mietbedingungen: `termsService.activeForSending()` nimmt in Production
  nur Nicht-Test-Versionen und blockt den Versand mit klarer Meldung,
  wenn keine existiert (TEST-Platzhalter nur dev/test; kein Rechtstext
  erfunden).
- **Berechtigungen**: PERMISSIONS.md-Schlüssel wortwörtlich
  (offer.create/edit_draft/send/create_new_version/change_price/
  apply_discount/apply_special_price, discount.up_to_10/
  over_10_with_reason/over_20_request/over_20_approve, product.manage,
  price.manage, booking.confirm); kontrolliert ergänzt: offer.view,
  offer.apply_special_price_zero, inquiry.view/create/edit, product.view.
  Systemadmins erhalten alle neuen Keys automatisch
  (Phase-2-Finalisierung). AB-Freigabe UND -Versand laufen unter
  `booking.confirm`; der manuelle Lieferpreis verlangt zusätzlich
  `offer.change_price`. Nach Annahme ist das Angebot für normale
  Bearbeitung gesperrt (Nachträge folgen in einer späteren Phase).

### Ergebnisse des adversarialen Phase-3-Reviews (verifiziert und behoben)

- **Versand komplett in EINER Transaktion**: Freigabe-/Grundpflicht-Prüfung
  lief vorher auf einem Stand VOR der Transaktion (TOCTOU – paralleles
  setDiscount hätte die >20-%-Freigabe umgehen können). Jetzt: Angebot- und
  Versionszeile sperren (gleiche Reihenfolge wie accept/createNewVersion),
  neu durchrechnen, auf GENAU dem eingefrorenen Endstand validieren,
  Selbst-Freigabe in der Transaktion schreiben.
- **Production blockiert VOR dem Einfrieren**: `assertConfigured()` am
  Gateway wirft in Production ohne echten Versandadapter, bevor Status,
  Token oder finales PDF entstehen – vorher wurde die Version als
  „versendet“ persistiert, obwohl der Adapter danach blockte.
- **Alle Entwurfs-Mutationen sperren die Version** (`FOR UPDATE` +
  Status-Recheck in der Transaktion): ein zeitgleich abgeschlossener
  Versand kann eine eingefrorene Version nicht mehr nachträglich mutieren.
- **Rabatt-Drift**: Ein fester EUR-Rabatt wird entfernt, sobald sich die
  Maschinen-Zwischensumme ändert (Maschinenwechsel, Maschinen-Sonderpreis,
  Anfrage-Übernahme) – sonst wären Stufenrechte (>10 %/>20 %) still
  unterlaufen worden; der Rabatt muss rechtegeprüft neu gesetzt werden.
- **Races geschlossen**: `requestRecheck` und `markDeclined` sind
  bedingte Updates (`WHERE status='sent'`) und können einen
  accepted-Status nie überschreiben; `accept` prüft den Token-Widerruf
  ERNEUT unter der Zeilensperre (alter Link kann im Rennen mit dem
  V2-Versand nie V2 annehmen).
- **Vorgangs-Sichtbarkeit auch im Commerce**: Alle vorgangsbezogenen
  Staff-Routen (Anfrage, Angebot, Versionen, Dokumente, AB) verlangen
  `process.view_all` und wenden die zentrale Phase-2-Sichtbarkeitsregel an
  (unsichtbar = neutrales 404) – vorher reichte z. B. `offer.view` für
  beliebige Vorgangs-IDs inkl. Kunden-Snapshot.
- **AB-Freigabe/-Versand serialisiert**: Zeilensperre (`FOR NO KEY
  UPDATE`, kompatibel mit dem FK-KEY-SHARE des Outbox-Inserts) +
  Status-Recheck – Doppelklicks erzeugen keine zweiten finalen PDFs und
  keinen Doppelversand. AB-Vorschau-PDF (`§41 „ansehen“`) und
  Dokument-Link ergänzt; Versandtext behauptet keinen Anhang mehr.
- **Keine Klartext-Token in der DB**: Die Outbox maskiert den
  /angebot/-Link im persistierten Body (§25 „nur Hash“); Request-Logs
  maskieren den Token im Pfad. Der interne Rabattgrund (§18) erscheint
  nicht mehr in Kundendokumenten.
- **Inhalte vervollständigt**: AB-PDF trägt jetzt Eventzeiten,
  Zeitfenster, Lieferadresse und den Rabatt aus dem Buchungs-Snapshot;
  Angebots-PDF/Web zeigen Eventzeiten; Kommissions-Fußnote nennt nur die
  spezifizierte Sirup-Regel (§3) statt einer erfundenen Verallgemeinerung;
  Migration 0008 entfernt erfundene Seed-Aussagen (Hygiene-Begründung,
  Ungeöffnet-Regel auf Becher/Strohhalme).
- **Kanisterlimit produktgenau**: Die Max-2-je-Behälter-Regel zählt nur
  den 6-L-Mischkanister (CANISTER_SLUG), nicht alle künftigen
  Kaufartikel; serverseitig zusätzlich per Integrationstest abgesichert.
- **Berlin-Stichtag DST-fest**: Die Produkte-UI berechnet den
  Wirksamkeits-Stichtag als Mitternacht Europe/Berlin (kein fester
  +01:00-Offset mehr). UI-Lücken geschlossen: Produkt bearbeiten +
  Metadaten (Gewicht/Tragepersonen), geplante Preise ändern, „Neu aus der
  Anfrage übernehmen“ im Angebotsentwurf.
- **Bewusst NICHT geändert** (geprüft, Entscheidung dokumentiert): Die
  Angebotsgültigkeit rechnet mit festen 3×24 h/7×24 h ab `sent_at` (die
  Europe/Berlin-Kalendertagslogik der Order bezieht sich auf die
  Event-Distanz; ein DST-Übergang verschiebt die Wanduhrzeit des Ablaufs
  um maximal eine Stunde – deterministisch und exakt persistiert). Die
  Outbox bleibt über `system.settings` einsehbar (interner Prüfpfad).

## Phase 4: Kalender, Termine, Zuständigkeit, Vertretung, Konflikte & „Heute“

- **SchedulingService strikt getrennt**: Terminerzeugung/-pflege lebt in
  `apps/api/src/scheduling/` – der OfferService kennt keine Termine. Die
  verbindliche Annahme löst die Terminerzeugung als ROUTEN-Orchestrierung
  aus (best effort im öffentlichen Accept-Endpunkt); zusätzlich zieht ein
  Selbstheilungs-Pass in Heute-/Offen-Ansichten Buchungen ohne
  vollständige Termine nach (`ensureMissingBookingAppointments`) – keine
  bestätigte Buchung geht verloren, selbst wenn der Hook fehlschlug. Die
  Terminplanung im Vorgang ensured weiterhin lazy; Backfill-Kommando
  `pnpm scheduling:ensure-booking-appointments`. Idempotenz über
  `UNIQUE (booking_id, kind)` + `ON CONFLICT DO NOTHING`; Buchungs- und
  Angebots-Snapshots bleiben unangetastet. Ein fachlich unmögliches
  Snapshot-Fenster (Ende ≤ Beginn) wird NICHT zu einer erfundenen exakten
  Zeit – der Termin bleibt „Zeit festlegen“.
- **Zeitposition ehrlich**: exakte Zeit (nur `start_at`), Zeitfenster
  (`start_at` + `end_at > start_at`) oder ungeplant (beides NULL, sichtbar
  als „Zeit festlegen“). Aus Zeitfenstern werden nie exakte Zeiten
  erfunden; Zeitzone fest `Europe/Berlin` (Spalte dokumentiert das).
  DST-feste Wanduhrzeit-Konstruktion via Offset-Probing (+01:00/+02:00 mit
  Intl-Verifikation) in `packages/domain/src/scheduling.ts`; Drag & Drop
  verschiebt Termine unter Erhalt der Berliner Wanduhrzeit und der
  Fensterdauer.
- **Wochenend-Standard als zentrale Funktion**: letzter Freitag ≤ Event
  18:00 / erster Sonntag ≥ Event 11:00, validiert gegen Eventbeginn/-ende
  (ersatzweise Berliner Tagesgrenzen). Unpassende Vorschläge werden nie
  automatisch gespeichert – die API antwortet mit Begründung. Der Standard
  ist eine SELBSTABHOLUNGS-Regel: Lieferbuchungen lehnt der Server ab
  (das vereinbarte Liefer-/Rückholfenster bleibt führend), und beide
  Zeiten werden ATOMAR in einer Transaktion gesetzt (deterministische
  Lock-Reihenfolge – nie ein halb angewendeter Standard).
- **Genau ein Zuständiger, effektiv über Vertretung**: initiale Zuweisung
  nur aus dem aktiven Vorgangs-Zuständigen, sonst offen („Mitarbeiter
  zuweisen“, nie Auto-Pick). `resolveEffectiveAssigneeId` ist die EINZIGE
  Auflösungsstelle (Single-Hop, exklusiv: während einer aktiven Vertretung
  sieht die Vertretung die Termine unter „Meine“, das Original nicht).
  Ausgewertet wird für ZUKÜNFTIGE Termine zum Terminbeginn, für bereits
  begonnene/überfällige und ungeplante Termine zum JETZT-Zeitpunkt – so
  fällt OFFENE Zuständigkeit nach Vertretungsende automatisch an das
  Original zurück (rein zeitbasiert, kein Background-Job). Vertretungen
  mit gesperrter/deaktivierter Vertretung werden ignoriert (Rückfall an
  das Original – ein Nutzer ohne Login betreut keine Termine).
  Vorgangs-Zuständigkeit wird durch Termin-Zuweisungen nie verändert.
- **Same-Day-Übernahmebestätigung serverseitig**: Umzuweisung am selben
  Berliner Tag (nur mit `appointment.reassign_same_day`) setzt
  `acknowledgement_requested_at/_for`; jede erneute Umzuweisung
  invalidiert die alte Anforderung, Bestätigen ist identitätsgebunden.
  Erstzuweisung ist bewusst KEINE Umzuweisung (keine Bestätigung nötig).
  Push-Vorbereitung als Datenlage: angefragt/nicht versendet/bestätigt.
- **Vertretungen kollisionsfrei**: `pg_advisory_xact_lock` je
  Original-Mitarbeiter verhindert parallele überlappende Anlagen; nur
  aktive Mitarbeiter, Original ≠ Vertretung, Ein-Klick-Frühende über
  konditionales UPDATE.
- **Konflikte als Provider-Registry**: `staff_double_booking` (stark,
  Überlappung desselben effektiven Mitarbeiters; halboffene Fenster,
  gleiche Startzeiten kollidieren) und `process_sequence` (Warnung:
  Rückgabe vor Abholung/Lieferung derselben Buchung). Phase 5 registriert
  weitere Provider; Konflikte warnen nur, blockieren nie. „Konflikt
  gelöst“ darf jeder aktive Mitarbeiter mit Sicht auf ALLE beteiligten
  Termine – ohne Kommentar, Historie oder Audit-Event. Die Unterdrückung
  speichert ausschließlich einen serverseitig berechneten
  SHA-256-Fingerprint über (Typ + beteiligte Termine mit Zeiten und
  effektivem Mitarbeiter); Clients liefern nur Typ + Termin-IDs, der
  Server rechnet auf aktuellem Stand – relevante Änderungen ⇒ neuer
  Fingerprint ⇒ Konflikt erscheint wieder.
- **Überfällige Rückgaben lazy statt Cron**: `ensureOverdueIncidents`
  heilt beim Lesen zuerst (offene Vorfälle, die zum aktuellen Terminstand
  nicht mehr passen – Termin erledigt, Vorgang storniert, Zeit geändert,
  Race-Phantome – werden gelöst) und erzeugt dann idempotent je aktuell
  überfälliger Rückgabe genau EINEN OFFENEN Vorfall pro verpasster Zeit.
  Die Eindeutigkeit ist ein PARTIELLER Unique-Index
  `(appointment_id, missed_at) WHERE resolved_at IS NULL` – auch eine
  identische, erneut gerissene Zeit ergibt einen NEUEN Vorfall mit neuem
  Push-Anspruch. `admin_notified_at IS NULL` modelliert „genau ein
  Admin-Push fällig“; interner Abschluss beendet offene Vorfälle sofort.
  Neue vereinbarte Rückgabezeit beendet alle offenen Vorfälle des Termins
  und markiert „Kundeninformation erforderlich“ (jede vereinbarte und
  wieder gerissene Zeit ist bewusst ein EIGENER Vorfall – „Kunde
  kontaktiert“ gehört zum jeweiligen Vorfall, kein Verlauf). Interne
  Umzuweisung allein löst keine Kundeninformation aus. 1-h-Reminder nur
  als Datenlage (`reminder_sent_at`, Fenster aus
  `appointment_reminder_minutes`, Default 60, `system_settings`).
  Stornierte Vorgänge verschwinden aus Kalender/Heute/Offen-Liste und
  erzeugen keine Vorfälle; ABGESCHLOSSENE Vorgänge behalten ihre offenen
  Termine bewusst sichtbar (eine reale ausstehende Rückgabe darf durch
  einen CRM-Abschluss nicht unsichtbar werden).
- **Nebenläufigkeit**: optimistische Versionsspalte (`expectedVersion` ⇒
  409 bei Konflikt) plus `FOR NO KEY UPDATE`-Zeilenlocks (kompatibel mit
  FK-`KEY SHARE` paralleler Vorfalls-Inserts – Lehre aus dem
  Phase-3-Deadlock). Keine globalen Locks.
- **Rechte (PERMISSIONS.md führend)**: wiederverwendet werden
  `calendar.view_all` (Gesamtkalender + Mitarbeiterfilter),
  `calendar.drag_drop` (ALLE Umplanungspfade: DnD, Vorschau-Formular,
  neue Rückgabezeit, Wochenend-Standard), `appointment.assign`,
  `appointment.reassign_same_day` (zusätzlich zur Zuweisung am selben
  Tag). Kontrolliert ergänzt: `calendar.view` (Basis: Heute, Meine
  Termine, Übernahme bestätigen, Kunde kontaktiert, Konflikt lösen),
  `calendar.manage` (interner Planungsabschluss), `substitution.manage`.
  Systemadmins erhalten neue Schlüssel automatisch (Phase-1-Semantik);
  Konfliktlösung ist bewusst NICHT admin-exklusiv. Einzeltermin-Sicht ohne
  `view_all`: nur zugewiesene/effektive eigene Termine, sonst neutrale
  404 (kein ID-Oracle).
- **Datenminimierung**: `CalendarEntry` liefert nur operative Felder
  (Kunde Name/Telefon, MR-Nummer, Maschinen-Name aus dem Snapshot,
  Standort-Label); intern zeigt der „base“-Standort die LIVE-Einstellung
  `pickup_exact_address` (öffentlich bleibt Mainz-Hechtsheim). Keine
  Kundendaten in Logs des Scheduling-Pfads.
- **„Heute“ als operative Startseite**: Reihenfolge fest – überfällige
  Rückgaben, heutige Termine, organisatorisch Offenes, danach höchstens
  2 kommende Termine, wenn weniger als 3 heute anstehen. Keine
  Umsatz-/Analytics-Elemente. Interner Abschluss heißt ehrlich „Intern
  als erledigt markieren“ und ändert nie den Vorgangsstatus.
- **Apple-/Lager-Vorbereitung ohne Sonderfelder**: stabile
  Termin-Entität; Lager-Sichten der Phase 5 lesen DIESELBEN Termine
  (`/staff/calendar`-Datenmodell), eine spätere `integration_mapping`-
  Tabelle koppelt Apple-Kalender an – Miet-Royal bleibt führend.
- **Adversarialer Phase-4-Review (Ultracode, 6 Dimensionen + Refute-Pass)**
  – bestätigte Funde behoben: (1) verbindliche Annahme erzeugt Termine
  jetzt sofort (Routen-Hook) plus Selbstheilungs-Pass in Heute/Offen –
  vorher konnten bestätigte Buchungen im Terminbereich unsichtbar bleiben;
  (2) Wochenend-Standard nur noch für Selbstabholung und atomar; (3)
  stornierte Vorgänge fallen aus allen operativen Termin-Sichten und
  Vorfällen; (4) alle Zeit-Eingaben der Staff-App (Termin, Vertretung,
  Anfrage) werden geräteunabhängig als Europe-Berlin-Wanduhrzeit
  interpretiert; (5) Incident-Eindeutigkeit partiell (identische erneut
  gerissene Zeit ⇒ neuer Vorfall), interner Abschluss/Selbstheilung
  beenden offene Vorfälle; (6) Zuständigkeits-Rückfall auch für
  vergangene offene Termine, gesperrte Vertretungen zählen nicht; (7)
  Termin-Endpunkte je Vorgang respektieren die zentrale
  Vorgangs-Sichtbarkeitsregel der Phase 2; (8) Übernahmebestätigung ohne
  Existenz-Orakel (neutrale 404); (9) Jahres-Plausibilität 2020–2100;
  (10) UI: leerer Terminart-Filter zeigt nichts, Vorschau scrollt in den
  sichtbaren Bereich, rotes Warnsymbol, „Heute“ zeigt Datum bei nicht
  heutigen Zeiten. Bewusst NICHT geändert: Termine ABGESCHLOSSENER
  Vorgänge bleiben sichtbar (s. o.), und jede vereinbarte und erneut
  gerissene Rückgabezeit ist ein eigener Vorfall mit eigenem
  Push-Anspruch (Order §24-Semantik).

## Phase 5: Physische Maschinen, Verfügbarkeit, QR & Lagerbestand

- **Maschinentyp vs. physische Maschine strikt getrennt**: Angebote/
  Buchungen referenzieren weiterhin NUR den Typ (Phase-3-Produkt); die
  neuen `machines` verweisen auf das Produkt und werden erst in Phase 6
  einer Buchung zugeordnet (keine `machine_assignments`-Tabelle).
- **Maschinen-ID serverseitig und unveränderbar**: Schema
  `MR-[Liter]-[Behälter]-[Laufnummer]` wird aus den Produktfeldern
  (containerVolumeLiters/containerCount) abgeleitet; Vergabe unter
  `pg_advisory_xact_lock` je Typ-Präfix + Unique-Index (race-sicher,
  max(Laufnummer)+1 – keine Wiederverwendung). Kein Update-Pfad und
  strikte Zod-Schemas: `machine_code` ist nie ein editierbares Feld.
  Initialbestand (11 Maschinen, 2/1/6/2) als Migration-0010-Seed;
  Kaufdatum/Gewicht bleiben NULL (nichts erfinden), Tragepersonen kommen
  aus dem Produkt.
- **Zentrale Statusregeln**: 6 Status (Enum englisch, UI deutsch mit
  Icon+Text); manuell nur Einsatzbereit/Reinigung/Reparatur/Außer
  Betrieb – Reserviert/Vermietet lehnen Service UND UI ab, weil sie erst
  durch Zuweisung/Ausgabe (Phase 6/7) fachlich entstehen. Keine
  Reparaturhistorie (Order §7). Standort als zentrale Logik
  (Lager/Kunde/Mitarbeiter/Reparatur/Sonstiges + optionale Notiz),
  keine Fahrzeugverwaltung.
- **Sperren**: Zeitraum + Pflichtgrund + Ersteller; Anlage ist auch bei
  entstehendem Kapazitätskonflikt erlaubt – die Route antwortet dann mit
  einer STARKEN Warnung (Availability-Check über den Sperrzeitraum)
  statt zu blockieren. Aufheben ohne Pflichtgrund per konditionalem
  UPDATE (`lifted_at IS NULL AND ends_at > now`); Datensätze bleiben.
- **QR-Grundlage**: opaker Zufallstoken je Maschine (Seeds: 64 Hex aus
  gen_random_uuid-Material; Service: crypto.randomBytes(24)), im
  Klartext gespeichert, aber bewusst KEIN Bearer: Auflösung nur nach
  Staff-Login + `machine.view`, Anzeige/Druck nur mit `machine.qr`, der
  Token erscheint weder in Logs (Request-Logger maskiert
  `/staff/machines/qr/…` wie die öffentlichen Angebots-Links; seit der
  Phase-8-Finalisierung reist der Token ohnehin nur noch im Body von
  `POST /staff/machines/qr/resolve`) noch in
  normalen Antworten – auch Mutationsantworten liefern eine Projektion
  ohne qrToken/Storage-Keys. Druckbare QR-URL nur mit konfiguriertem
  Setting `staff_app_base_url` (adminpflegbar unter „Einstellungen“ mit
  `system.settings`; dev/test synthetisch) – ohne Basis wird nur der
  Identifier gezeigt, keine erfundene Live-URL. Staff-Route
  `/qr/[token]` öffnet nach Login die richtige Maschine; QR-Bild
  clientseitig via `qrcode`-Bibliothek.
- **Referenzfoto**: privater Storage über die Phase-3-Abstraktion
  (Key `machines/<id>/reference-<random>.<ext>`), Upload als Base64-JSON
  (Limit 6 MB, JPEG/PNG/WebP), Auslieferung nur über die
  authentifizierte API; Ersetzen serialisiert parallele Aufrufe per
  Zeilensperre (der jeweils verdrängte Key wird gezielt gelöscht, kein
  dauerhaft verwaistes Objekt), Löschen des Altobjekts best effort –
  keine Foto-Historie.
- **MachineAvailabilityService**: rechnet ausschließlich intern aus dem
  ECHTEN Bestand: einsetzbar = Status `ready` minus zeitlich
  überlappende offene Sperren (Reinigung/Reparatur/Außer Betrieb nicht
  regulär verfügbar; Reserviert/Vermietet sind in Phase 5 nicht
  erreichbar und zählen defensiv ebenfalls nicht). Bedarf aus
  bestätigten Buchungen über die Phase-4-Termine (Abhol-/Lieferbeginn
  bis Rückgabe-Ende), gewichtet mit der gebuchten MENGE aus dem
  Buchungs-Snapshot (eine Buchung über 2 Maschinen belegt 2); fehlende
  Zeiten ⇒ „Verfügbarkeit noch nicht vollständig prüfbar – Terminzeit
  fehlt“ (nur für offene Vorgänge gelistet), NIE eine Blockade.
  Bewertung an kritischen Zeitpunkten (Bedarfs-/Sperrbeginne): conflict
  (Fehlmenge – auch wenn OHNE konkurrierende Buchung keine einzige
  Maschine einsetzbar ist), tight (keine Reserve), available; der
  Warntext nennt Bedarf und Einsetzbarkeit desselben
  Engpass-Zeitpunkts. Alternativen sind eine feste, kleine Domänenliste
  (2×10 → zwei 1×10; 2×8 → größere 2×10) und IMMER nur „Mögliche
  Alternative“ mit Verfügbarkeitsindikator – keine Umstellung, kein
  Preis, keine Kundenkommunikation.
- **Kapazitätskonflikte über die Phase-4-Engine**: ConflictProvider
  dürfen jetzt async sein (`detectAll` awaitet); der Provider
  `machine_capacity` bildet Überlappungs-Cluster je Maschinentyp und
  warnt (severity warning), wenn der mengen­gewichtete Spitzenbedarf die
  einsetzbaren Maschinen übersteigt; vollständig vergangene Cluster
  werden nicht rückwirkend mit dem heutigen Flottenzustand bewertet.
  Der Fingerprint rechnet über `extra` den kapazitätsrelevanten Zustand
  ein (Maschinen+Status, Sperren NUR im Cluster-Fenster – irrelevante
  Sperren entwerten keine Suppression –, Buchungszeiträume samt Menge,
  deterministisch sortiert) – kapazitätsrelevante Änderungen ergeben
  einen neuen Fingerprint, alte Suppressions wirken nicht weiter.
  „Konflikt gelöst“ nutzt unverändert den serverseitigen Resolve-Pfad
  (Limit der Termin-IDs auf 200, damit auch große transitiv verkettete
  Cluster lösbar bleiben). Bewusste Entscheidung: Lösen verlangt
  Sichtbarkeit ALLER Cluster-Termine – Kapazitätskonflikte quer über
  fremde Termine löst also die Planung (calendar.view_all); Basis-Nutzer
  sehen die Warnung an den eigenen Terminen.
- **Auswahlvorschlag (Phase-6-Vorbereitung)**: reine Vorschlagsfunktion
  (`preferred` + Basis, weitere Maschinen, Warnungen) mit Eligibility
  eligible/warning(Reinigung)/override_required(Status/Sperre);
  Präferenz ältestes BEKANNTES Kaufdatum, deterministischer Fallback
  Maschinen-ID, Standort nur Zusatzinfo. Keine Assignment-Tabelle,
  kein Override-Vollzug.
- **Lager als Ledger**: `inventory_items` referenziert die Phase-3-
  Produkte 1:1 (Einheit = sale_unit, Preise bleiben im Produktmodul);
  `current_stock` NULL = „Noch nicht initial erfasst“ (nie still 0),
  `min_stock` NULL = „nicht festgelegt“. JEDE Bestandsänderung läuft
  durch `applyMovement` (Zeilenlock FOR NO KEY UPDATE → Bewegung mit
  resulting_stock → Bestand), Integer-only. Aktive Arten: initial
  (Erstinventur), incoming (Wareneingang, NUR hinzugefügte Menge),
  inventory_adjustment (freigegebene Inventur); issue/return sind als
  Domain-Schnittstellen für Phase 6/7 vorbereitet (ohne Routen, mit
  `allowNegative`-Option für die spätere Warn-statt-Block-Regel).
- **Inventur mit Freigabe**: Anlegen speichert System-/Ist-Stand und
  ändert den Bestand NICHT; ohne Differenz (und initialisiert) sofort
  `completed`, sonst `pending_approval`. Der Ist-Wert ist vor der
  Freigabe korrigierbar (nur pending, unter Zeilenlock). Die Freigabe
  claimt den Status per konditionalem UPDATE (pending→approved) –
  Double-Submit und parallele Freigaben erzeugen exakt EINE Bewegung je
  Artikel. Die Korrektur ist die bei der ZÄHLUNG festgestellte Differenz
  (Ist − System-Snapshot) und wird auf den aktuellen Bestand angewendet:
  ein Wareneingang zwischen Zählung und Freigabe bleibt erhalten. Wurde
  der Artikel zwischenzeitlich durch eine ANDERE Inventur initialisiert
  oder würde die Freigabe den Bestand unter 0 senken, bricht die
  Freigabe mit klarem Konflikt ab („bitte neu zählen“) statt still zu
  überschreiben. **Exklusivität (Phase-5-Finalisierung):** je Lagerartikel
  existiert zu jedem Zeitpunkt höchstens EINE offene Zählung (pending) –
  auch zwischen Einzelartikel- und Komplettinventur. `createStocktake`
  nimmt je Artikel einen `pg_advisory_xact_lock` in deterministisch
  sortierter Reihenfolge (keine Deadlocks, unterschiedliche Artikel
  parallel), prüft dann auf offene Zählungen und lehnt mit CONFLICT ab
  („… bereits eine Inventur mit ausstehender Freigabe offen“); der
  partielle Unique-Index auf `inventory_stocktake_items.open_item_id`
  (gesetzt solange pending, bei Freigabe NULL) ist der
  datenbankseitige Backstop. Damit kann eine später freigegebene zweite
  Zählung nie eine veraltete Differenz auf einen bereits korrigierten
  Bestand anwenden. Erstinventur
  („Anfangsbestand erfassen“) initialisiert per `initial`-Bewegung
  (Delta 0 nur hier erlaubt). Prozentdifferenz in Integer-Arithmetik
  mit einer Nachkommastelle; System 0/unbekannt ⇒ „nicht berechenbar“.
- **Rechte (PERMISSIONS.md führend)**: wiederverwendet machine.view/
  change_status/block/replace_reference_photo und inventory.view/
  add_stock/count/approve_adjustment/view_movement_history; kontrolliert
  ergänzt machine.manage (Stammdaten/Anlage), machine.change_location,
  machine.qr, inventory.manage_min_stock. `machine.assign`/
  `machine.override_block`/`inventory.issue`/`inventory.return` bleiben
  für Phase 6/7 reserviert. Datenminimierung: Maschinen-Antworten
  enthalten weder Storage-Keys noch QR-Token (eigener Endpunkt).
- **Heute-Integration kompakt**: eine Karte „Maschinen- & Lagerwarnungen“
  (nicht einsetzbare/gesperrte Maschinen als §22-Datengrundlage, „Lagerbestand
  niedrig: N Artikel“) zwischen „Organisatorisch offen“ und „Nächste
  Termine“ – überfällige Rückgaben bleiben immer oben, kein Dashboard.
  Als Maschinen-Warnung zählen nur JETZT wirksame Sperren; rein
  zukünftige Sperren sind heute keine Warnung (die Maschinenliste zeigt
  sie als „Sperre geplant“).
- **Deaktivierte Lagerartikel serverseitig historisch**: Wareneingang,
  Mindestbestand und NEUE Inventuren lehnen deaktivierte Artikel im
  Service ab (kein Security-by-UI); die Komplettinventur zählt nur
  aktive Artikel. Historie, Bestand und alte Inventuren bleiben
  vollständig sichtbar.
- **Adversarialer Review (Phase 5)**: 6-dimensionaler Workflow-Review
  (Maschinen-ID/Stammdaten, Sperren/Verfügbarkeit, QR/Foto/Security,
  Kapazitätskonflikt/Kalender, Lager-Ledger, Scope/Tests) mit
  Refute-Pass; 29 Findings, alle selbst gegen Order und Code
  verifiziert. Behoben u. a.: Mutationsantworten leakten qrToken/
  Storage-Keys (jetzt Projektion), QR-Token stand im Request-Log (jetzt
  maskiert + Test), Bedarf ignorierte die gebuchte Maschinen-MENGE
  (jetzt mengengewichtet in Availability UND Kapazitätsprovider),
  „verfügbar“ trotz null einsetzbarer Maschinen (jetzt Konflikt inkl.
  Alternativen), Inventur-Freigabe überschrieb zwischenzeitliche
  Wareneingänge (jetzt Differenz-Semantik), Fingerprint enthielt
  irrelevante Sperren (jetzt Cluster-Fenster + stabiler Sortschlüssel),
  vergangene Cluster wurden mit heutigem Zustand bewertet (jetzt
  übersprungen), Resolve-Limit 24 machte große Cluster unlösbar (200),
  QR-Basis-URL war nicht pflegbar (Route + Einstellungs-UI mit
  `system.settings`), Heute zählte zukünftige Sperren, Foto-Ersetzen
  hatte ein Verwaisungs-Race, Kalenderdaten/ID-Grenzen validieren
  jetzt (kein 500 bei 31.02. oder 100-L-Typen), deaktivierte Artikel
  waren nur im UI gesperrt. Bewusst NICHT geändert: QR-Token bleibt
  Klartext-Spalte (kein Bearer – Auflösung verlangt Session + Recht),
  Kapazitätskonflikte löst die Planung mit calendar.view_all. Die
  ursprünglich dokumentierte Nacheinander-Anwendung parallel offener
  Inventuren desselben Artikels wurde in der Phase-5-Finalisierung durch
  die Exklusivitätsregel (höchstens eine offene Zählung je Artikel)
  ersetzt. Zusatztests R1–R10 sichern alle Fixes ab; zwei
  Phase-4-Testflakes am Berliner Tageswechsel (NaN-Stundenparser,
  ungeprüftes now+10min) wurden testseitig robust gemacht.

## Phase 6: Maschinenzuweisung, Vorbereitung, Ausgabe & Übergabe

- **Zuweisung als stabile Slots**: `machine_assignments` legt je
  bestätigter Buchung genau `machineQuantity` Zeilen (`slot_no` 1…n,
  Unique `(booking_id, slot_no)`) idempotent an (`ensureSlotsForBooking`
  unter Advisory-Lock je Buchung); `machine_id` bleibt NULL bis zur
  konkreten Zuordnung. Status open → assigned → prepared → issued
  (→ returned ab Phase 7). Ein partieller Unique-Index
  `machine_id WHERE status = 'issued'` ist der datenbankseitige Backstop
  dafür, dass eine physische Maschine nie an zwei Kunden gleichzeitig
  ausgegeben ist. Der Mietzeitraum (Abhol-/Lieferbeginn bis Rückgabe-Ende
  aus den Phase-4-Terminen) wird bei jeder Zuordnung in die Zeile
  gespiegelt (`rental_from/to`), damit Kollisionen ohne Join-Kaskaden
  berechenbar bleiben.
- **Bewertung rechnet ausschließlich der Server**: `evaluateMachine`
  liefert Typprüfung, Problemliste mit stabilen Deskriptoren
  (`status_cleaning/status_repair/status_out_of_service/status_rented`,
  `blocked:<blockId>`, `collision:<assignmentId>`,
  `issued_elsewhere:<assignmentId>`, `period_unknown` nur Warnung),
  `hardBlocked`, `overrideRequired` und einen Situations-Fingerprint
  (SHA-256 über die sortierten nicht-warnenden Deskriptoren). Harte
  Blockade = Maschine ist physisch an einen anderen Vorgang ausgegeben
  (Assignment `issued` oder Status Vermietet) – keine Ausnahme, auch nicht
  für Admins. Alles andere (zeitliche Kollision, Sperre, Reinigung,
  Reparatur, Außer Betrieb) ist eine STARKE Warnung mit Override.
  Domainentscheidung: auch Reinigung verlangt eine bewusste Bestätigung,
  weil eine nicht gereinigte Maschine ohne Grundangabe nicht beim Kunden
  landen soll.
- **Override**: eigener Datensatz `machine_assignment_overrides`
  (Maschine, Vorgang, Buchung, Problemcodes, Zusammenfassung,
  Fingerprint, Pflichtgrund, bestätigt von/am, `archived_at` vorbereitet)
  – die Route nimmt nur `{confirmed: true, reason}` entgegen, ob ein
  Override nötig ist, entscheidet der Server aus der aktuellen Lage
  (Client kann nichts „freischalten“). Ohne Override → 409 mit
  Problemtext, ohne Recht `machine.override_block` → 403, ohne Grund →
  400. Ein Override gilt nur für die Lage, für die er bestätigt wurde:
  Ändert sich der Fingerprint (`overrideStale`), zeigt die UI
  „Problemlage geändert – erneut bestätigen“ und die Finalisierung lehnt
  ab, bis erneut bewusst bestätigt wurde. Admin-Liste
  `/staff/machine-overrides` (Maschine/Vorgang/Grund/Mitarbeiter).
- **Vorbereiten → 🟠 Reserviert nur über den Fachprozess**: `prepare`
  setzt die Maschine von `ready` auf `reserved` (nur aus `ready`; andere
  Status werden nicht still überschrieben) und das Assignment auf
  `prepared`; `unprepare`, `release` und der Wechsel auf eine andere
  Maschine setzen `reserved` sauber auf `ready` zurück – aber nur, wenn
  kein ANDERES vorbereitetes Assignment dieselbe Maschine hält
  (`otherPreparedExists`) und der Status tatsächlich noch `reserved` ist
  (kein Überschreiben einer zwischenzeitlichen Reparatur). Alle Pfade
  serialisieren über `pg_advisory_xact_lock('machine-assign:<machineId>')`
  plus Zeilensperre des Slots; das Lösen braucht keinen Pflichtgrund.
  Dieselbe Maschine erneut zu bestätigen (Override nach geänderter Lage)
  lässt `prepared` bestehen.
- **Risikohinweise (Future-Risk-Incidents)**: `machine_risk_incidents`
  mit Fingerprint `risk:<assignmentId>:<machineId>:<descriptor>` und
  partiellem Unique-Index auf offene Incidents (dedupliziert). Erzeugt
  werden sie lazy (`refreshRiskIncidents` bei Zuordnungsänderungen,
  Finalisierung und beim Laden der Liste) für zugewiesene, noch nicht
  ausgegebene Maschinen, deren Status/Sperre nach der Zuweisung
  problematisch wurde – Kollisionen/Ausgabe anderswo sind keine
  Incidents (sie sind Zuweisungsprobleme), und Deskriptoren, die ein
  gültiger Override bereits abdeckt, ebenfalls nicht. Felder für die
  Admin-Benachrichtigung sind vorbereitet: `admin_notification_due_at`
  (sofort), `admin_notified_at`, `follow_up_due_at` (= notified + 6 h),
  `follow_up_sent_at` (genau EIN Follow-up), `resolved_at/by`,
  `resolution` (`resolved` = Problem verschwunden, `acknowledged` =
  Admin „Geprüft“ ohne Grund; ein bestätigter Incident wird für dieselbe
  Lage nicht neu erzeugt und beim Verschwinden zu
  `acknowledged_cleared`). Kein Versand in Phase 6 (Outbox-Grundlage),
  keine automatische Neuzuweisung. Kompakter Hinweis auf „Heute“.
- **AUSGABE-Ansicht**: `/staff/handover/day?date=` liefert die Abhol-/
  Liefertermine des Berliner Kalendertags aus bestätigten Buchungen plus
  bestätigte, noch ungeplante Ausgaben (`unscheduled`), mit
  Vorbereitungsstand (none/partial/prepared) und effektivem
  Mitarbeiter. Die Staff-Seite `/ausgabe` ist Tablet-/Smartphone-first
  (große Touch-Karten, keine Tabellenwand).
- **QR-Scan ohne Hardwarezwang**: Kamera nur während der aktiven
  Scan-Funktion (Stream wird beim Schließen gestoppt), Erkennung über die
  Browser-`BarcodeDetector`-API, wenn vorhanden – sonst/immer auch
  manuelle Eingabe des Identifiers oder der gescannten Adresse. Die
  Auflösung läuft AUTHENTIFIZIERT über den Phase-5-Resolver
  (heute `POST /staff/machines/qr/resolve`, Token im Body, `machine.view`);
  ein Scan macht nie
  Rechte weiter. Im Wizard bestätigt der Scan die zugewiesene Maschine
  (falsche Maschine ⇒ klare Fehlermeldung, keine stille Umbuchung).
- **Ausgabeartikel getrennt vom Snapshot**: `delivery_notes` (1 je
  Buchung, `draft`/`final`) und `delivery_note_items` (Art
  inklusive/Kommission/Kauf, Soll aus dem Buchungs-Snapshot, Ist
  editierbar, eingefrorener Einzelpreis) entstehen automatisch beim
  ersten Aufruf des Vorgangs im Ausgabebereich; der Buchungs-Snapshot
  wird NIE verändert. Inklusive Regeln kommen aus dem Snapshot (1 L
  Sirup je Behälter, 25 Becher + 25 Strohhalme je Vorgang – nicht je
  Maschine); Kommission (Sirup 12 €/L, Becher/Strohhalme 25er-Pack) und
  Kaufartikel (Kanister) werden bei der Ausgabe als `issue`-Bewegung
  gebucht. Zusatzpositionen (`booking_additions`) sind nur für
  Sirup/Becher/Strohhalme/Kanister möglich (keine Maschine), frieren den
  aktuellen Listenpreis ein und erzeugen eine Lieferscheinposition
  („nachträglich vereinbart“); das Kanister-Maximum (2 je gebuchtem
  Behälter) prüft der Server. KEINE Endabrechnung in Phase 6.
- **Lagerausgabe atomar, verständlich blockierend**: Bei der
  Finalisierung werden die Ist-Mengen je Lagerartikel aggregiert und über
  `InventoryService.issueWithin` (Zeilenlock, Ledger-Bewegung `issue`)
  gebucht – niemals negativ. Unzureichender oder nicht erfasster Bestand
  ist VOR der Finalisierung ein sichtbarer Blocker „Lagerbestand
  prüfen: …“ (Vorbereitung, Wizard-Schritt Artikel und Abschluss) und
  bei einem Race in der Finalisierung selbst ein 409 mit derselben
  Botschaft – nie ein 500. Zuweisung und Vorbereitung bleiben trotz
  Lagerblocker möglich; Abhilfe: Wareneingang/Inventur oder Ist-Menge
  korrigieren.
- **Lieferschein-Vorschau und finales Dokument**: Die Vorschau rendert
  denselben serverseitigen pdfkit-Renderer aus dem Entwurf („Lieferschein
  (Entwurf)“, nur mit `handover.view`), das finale Dokument entsteht
  ausschließlich in der Finalisierung als Phase-3-Dokumententität
  (SHA-256, privater Storage, kein Update-Pfad). Inhalt: Maschinen-IDs
  und -Typen, Artikel mit Ist-Mengen, Abhol-/Lieferadresse, Zeitpunkt.
- **Alternative Abholperson**: genau EINE je Buchung
  (`booking_pickup_representatives`, Unique `booking_id`; Vorname,
  Nachname, Telefon – kein Ausweis), nur bei Selbstabholung. Die
  1-Stunden-Regel (Kunde kann bis 1 h vor Abholung ändern) ist nur als
  Datenlage vorbereitet (`changeableUntil` = Abholbeginn − 1 h in der
  Antwort); ein Kundenzugang existiert in Phase 6 nicht. Telefonnummern
  von Abholperson und sonstigem Vertreter werden bei der Finalisierung
  gelöscht (`phone_deleted_at`) – Datenminimierung, das Protokoll trägt
  nur den Namen.
- **Geführte Übergabe (Tablet-first)**: 9 Bildschirme mit genau einer
  dominanten nächsten Aktion (Vorgang → Maschinen scannen/bestätigen →
  Artikel → je Maschine „Maschine gemeinsam geprüft“ + Pflicht-Gesamtfoto
  → Empfänger → Zusammenfassung → Unterschrift Kunde → Unterschrift
  Mitarbeiter → Abschluss). Die Pflichtprüfungen rechnet der Server
  (`computeBlockers`): alle Slots zugewiesen und vorbereitet, keine
  veralteten Overrides, keine harte Blockade, je Maschine Prüfung UND
  mindestens ein Foto, Empfänger gesetzt, beide Unterschriften, Bestand
  ausreichend. KEIN Bypass – auch nicht für Admins. Ein kombiniertes
  Protokoll bei mehreren Maschinen; ein `ExistingDamageProvider`-Hook
  ist als Schnittstelle (ohne Implementierung) vorbereitet.
- **Fotos und Unterschriften privat**: Fotos (JPEG/PNG/WebP, ≤ 6 MB,
  Base64-JSON wie das Phase-5-Referenzfoto) liegen unter
  `handovers/<id>/photos/<assignment>-<random>.<ext>` im privaten
  Storage mit SHA-256; sie erscheinen NICHT im Kunden-PDF und werden nur
  über die authentifizierte API (`handover.view` + Vorgangs­sichtbarkeit)
  ausgeliefert. Unterschriften sind Canvas-PNGs (Magic-Byte-Prüfung,
  ≤ 2 MB), je Rolle genau eine (Unique `(handover_id, role)`; erneutes
  Unterschreiben ersetzt), Base64 taucht in keiner Antwort/keinem Log
  auf. Der Mitarbeiter-Unterzeichner kommt aus der Session, nie aus dem
  Body; ein Wechsel des Empfängers entwertet eine bereits vorhandene
  Kundenunterschrift.
- **Empfänger**: Kunde selbst, hinterlegte Abholperson oder sonstiger
  Vertreter (Name Pflicht, Telefon optional, vom Mitarbeiter bestätigt) –
  keine Ausweiskontrolle, keine Ausweisdaten. Bei Lieferung ist der
  Vor-Ort-Kontakt mit Anrufbutton (`tel:`) sichtbar.
- **Finalisierung zweiphasig, idempotent, atomar im Fachzustand**:
  Phase 1 (außerhalb der Transaktion): Blocker erneut prüfen, beide PDFs
  rendern und in den Storage laden (`uploadBytes`, Keys mit
  Zufallsanteil – ein Retry kollidiert nie mit einem alten Objekt).
  Phase 2 (eine Transaktion unter
  `pg_advisory_xact_lock('handover-finalize:<id>')`, Handover-Zeile FOR NO
  KEY UPDATE): ist die Übergabe bereits `finalized`, endet der Aufruf
  sofort erfolgreich (Double-Submit/parallele Finalisierung = genau ein
  Ergebnis, keine zweite Bewegung, kein zweites Dokument); sonst Blocker
  unter Sperre erneut prüfen, Dokumente registrieren, `issue`-Bewegungen
  buchen, Assignments `issued`, Maschinen 🔵 Vermietet mit Standort
  Kunde (Notiz = Vorgangsnummer ⇒ Anzeige „Kunde – MR-…“), Abhol-/
  Liefertermin über `SchedulingService.completeWithin` abschließen,
  Lieferschein `final`, Handover `finalized` (`finalized_at/by`,
  optional abweichende tatsächliche Ausgabezeit nur mit
  `handover.correct_actual_time`), Telefonnummern löschen und das
  Dokumentpaket `delivery_packets(handover_completed)` als
  `ready` anlegen (Outbox-Grundlage; kein Versand, Production nie
  „versendet“). Schlägt Storage/PDF fehl, bleibt der Fachzustand
  unberührt (nur verwaiste Storage-Objekte, keine DB-Zeilen); schlägt die
  Transaktion fehl, verweisen keine Zeilen auf die Uploads – ein Retry ist
  sicher. Der Vorgang wird NICHT abgeschlossen (Rückgabe/Abrechnung ab
  Phase 7).
- **Terminabschluss nur über die Übergabe**: `SchedulingService.complete`
  lehnt Abhol-/Liefertermine aus Buchungen mit klarem Konflikt ab
  („… werden über den Übergabeprozess abgeschlossen“); `completeWithin`
  ist idempotent, setzt den Mitarbeiter bei fehlender Zuständigkeit auf
  den Ausgebenden und schließt Überfälligkeits-Incidents. Der
  Rückgabetermin bleibt offen.
- **Dokumentzugriff ohne IDOR**: `/staff/documents/:id` verlangt
  `offer.view` ODER (`handover.view` für Lieferschein/Übergabeprotokoll)
  plus die Phase-2-Vorgangssichtbarkeit; alle Handover-Routen laufen
  über `visibleBooking` (neutrales 404) und prüfen, dass Slot/Foto/
  Signatur zur Buchung gehören (`slotOfBooking`). Nichts ist öffentlich
  erreichbar, es gibt keine signierten Links.
- **Rechte (PERMISSIONS.md führend)**: wiederverwendet `machine.assign`
  (Zuweisen/Lösen), `machine.override_block` (Override, Override-Liste),
  `machine.block` („Geprüft“ am Risikohinweis), `machine.view`
  (Risikoliste, QR-Auflösung), `handover.perform` (= Übergabe
  durchführen und abschließen INKLUSIVE Lagerausgabe – ein zusätzliches
  `inventory.issue` würde die Ausgabe an der Rampe in zwei Rollen
  zerreißen), `handover.correct_actual_time`; kontrolliert ergänzt
  `handover.view` (Ausgabe-Bereich/Details), `handover.prepare`
  (Vorbereitung, Abholperson) und `delivery_note.edit` (Ist-Mengen,
  Zusatzpositionen). `document.view` sinngemäß über `offer.view`/
  `handover.view` abgebildet, kein neuer Key.
- **Datenmodell versioniert**: Migration 0012 (8 Enums, 12 Tabellen),
  Rückgabe-/Zubehör-Metadaten nur vorbereitet (`returned`-Status,
  `return_protocol`-Dokumenttyp aus Phase 3), keine Rückgabe-Checkliste.
- **Adversarialer Review (Phase 6)**: 6-dimensionaler Workflow-Review
  (Races/TOCTOU, Override/Incidents, Lager/Dokumente, Security, Spec-
  Vollständigkeit, Tests/Schema) mit Refute-Pass; 45 Findings, alle selbst
  gegen Vorgabe und Code verifiziert. Behoben u. a.: Übergabe-Mutatoren
  (Mengen, Zusatzpositionen, Empfänger, Prüfung, Foto, Abholperson) liefen
  nur mit ungesperrtem Draft-Vorabcheck – jetzt ALLE unter der Zeilensperre
  der handovers-Zeile (`withDraftLock`), serialisiert mit der Finalisierung;
  Finalisierung sperrt Slot-Zeilen und Maschinen-Advisory-Locks VOR dem
  Recheck, vergleicht einen Inhalt-Fingerprint (Mengen, Maschinen, Empfänger,
  Fotos, Unterschrift-Hashes) zwischen PDF-Rendern und Transaktion und setzt
  `issued` nur bei unveränderter Maschine/Status `prepared`; einheitliche
  Sperrreihenfolge Slot → Maschinen (sortiert, alte + neue) → Lager →
  Maschinenzeile (kein Deadlock zwischen assign/prepare/release/finalize,
  Inventur-Freigabe sperrt Artikel jetzt ebenfalls sortiert); Mietzeitraum
  IMMER live aus den Phase-4-Terminen (gespeicherte `rental_from/to` waren
  nach Terminverschiebung veraltet → stille Doppelbelegung); dieselbe
  Maschine in zwei Slots derselben Buchung abgelehnt; Risiko-Scan
  prozessintern serialisiert + try-Advisory-Lock, Auto-Auflösung nur für
  Incidents vor Scanbeginn, Refresh sofort bei Status-/Sperränderung;
  Storno löst nicht ausgegebene Zuordnungen systemseitig (Reserviert
  zurück, keine Phantom-Kollisionen); Overrides gelöster/ersetzter
  Zuordnungen werden archiviert; Sperre vor bekanntem Beginn ohne Ende
  irrelevant, ohne Beginn nur Warnung; „Bevorzugt“ nie override-pflichtig;
  Ausgabe-Liste unterliegt der Phase-2-Sichtbarkeit (`process.view_all` +
  Fenster); abgeschlossene Vorgänge gesperrt, Vorgangsabschluss mit aktiven
  Zuordnungen verweigert; ephemere Telefonnummern auch bei Storno/Abschluss
  gelöscht; Dokument-/Fotoroute prüfen Recht/Sichtbarkeit vor Existenz und
  Storage-Zugriff; inklusive Positionen auf das gebuchte Kontingent
  begrenzt, nicht genutztes Gratis-Sirup-Kontingent wird bei Zusatzpositionen
  automatisch inklusive (Rest Kommission); Unterschrift-PNG wird VOR dem
  Speichern vollständig geprüft (Chunks, IDAT synchron dekomprimiert) – ein
  nicht dekodierbares Bild hätte pdfkit asynchron und damit den Prozess
  abgebrochen; Foto-Magic-Bytes gegen den deklarierten Typ; tatsächliche
  Ausgabezeit nur bei Abweichung vom ABSCHLUSS; Vorbereitung („Reserviert“)
  ist Pflichtvorbedingung der Finalisierung; Prüfung/Gesamtfoto werden beim
  Lösen/Maschinenwechsel entfernt (erneute aktive Prüfung); Korrektur der
  Abholperson folgt in den Empfänger und entwertet die Kundenunterschrift;
  Outbox-Paket im Vorgang/Wizard sichtbar; QR-Scanner scannt nach
  Fehlschlag weiter; Gesamtfoto aus Kamera ODER Galerie; Transporthinweise
  im Wizard vollständig. Zusatztests R1–R18 sichern alle Fixes ab (Test 42
  nutzt jetzt getrennte Service-Instanzen, damit die DB-Sperren – nicht die
  prozessinterne Mutex – die Parallelität entscheiden). Der zunächst
  dokumentierte Rest (Phase-2-Lesezugriffe über den Pool unter gehaltenen
  Sperren) ist mit der Phase-6-Finalisierung A1 beseitigt (siehe unten).
- **Bewusst offen (Deferred, Phase 6)**: Versand des Dokumentpakets
  (Outbox-Worker), Admin-Benachrichtigung/Follow-up der Risikohinweise
  (Datenlage vorbereitet), Kundenportal für die 1-Stunden-Regel der
  Abholperson, Rückgabe/Zubehörprüfung/Schadensmeldung, Endabrechnung,
  bestehende-Schäden-Provider (Schnittstelle vorhanden), Kamera-Scan in
  Browsern ohne `BarcodeDetector` (Fallback manuell), Mehrfach-Fotos je
  Maschine sind möglich, aber nur ein Foto ist Pflicht.

## Phase-6-Finalisierung: Pool-Disziplin, Termin-Hooks, unabhängige E2E-Specs

- **A1 – Kein verschachtelter Pool-Zugriff unter Transaktionen/Sperren**:
  Alle Lesezugriffe, die innerhalb einer Transaktion gebraucht werden,
  laufen über den `DatabaseExecutor` (Pool ODER Transaktion) derselben
  Verbindung: `AssignmentService` (`rentalIntervalFor`, `slotsForBooking`,
  `evaluateMachine`, `openBlocksFor`, `assignmentById`), `HandoverService`
  (`detailWithin(tx, …)` für den Finalisierungs-Recheck, Buchung/Termin/
  Positionen/Bestand), `getPickupExactAddress`/`getStringSetting`,
  `ProductService.pricingProduct*`/`effectivePriceCents` (die Preisengine
  las bisher innerhalb der Angebots-Transaktionen über den Pool) und der
  `DeliveryGateway.deliver(request, tx)` der AB. Die AB-Freigabe ist wie die
  Übergabe zweiphasig (PDF rendern/hochladen OHNE Sperre, danach kurze
  Transaktion mit Statusprüfung). Sperr-Reihenfolgen bleiben unverändert
  (Übergabe → Slots → sortierte Maschinen-Advisory-Locks); der Pool wurde
  NICHT vergrößert. Nachweis: `createPool(url, { max })` + Testkontext mit
  `poolMax`/`TEST_POOL_MAX` – mit EINER Verbindung wird jede verschachtelte
  Akquise zum deterministischen Verbindungs-Timeout. Die gesamte
  Integrationssuite (Phasen 1–6) läuft mit `TEST_POOL_MAX=1` grün;
  `handover-pool` prüft fünf parallele Finalisierungen verschiedener
  Übergaben mit Pool 2 (keine Timeouts, keine doppelten Bewegungen/
  Dokumente, keine halben Zustände), die dreifache Finalisierung derselben
  Übergabe über getrennte Instanzen und einen Ein-Verbindungs-Durchlauf aller
  Mutationspfade (Zuweisen/Vorbereiten/Wechseln/Lösen/AB/Termin/Finalisierung/
  Storno).
- **A2 – Terminänderungen bewerten Risikohinweise sofort neu**: Die
  Terminplanung kennt eine eigene Listener-Schnittstelle
  (`scheduling/hooks.ts`: `AppointmentChangeListener.appointmentTimesChanged`)
  und ruft sie NACH dem Commit von `reschedule`/`applyWeekendStandard` nur bei
  tatsächlicher Zeitänderung (Versionssprung) auf – nie unter Sperren, nie in
  der Transaktion; ein Listener-Fehler wird protokolliert, die committete
  Änderung bleibt (der nächste Lazy-Refresh holt die Bewertung nach). Das
  Handover-Modul liefert den Listener (`risk-refresh-listener.ts` →
  `refreshRiskIncidents`), verdrahtet in `app.ts` – Scheduling importiert
  nichts aus Handover (keine zyklische Abhängigkeit). Der Refresh erzeugt
  jetzt auch **Kollisions-Incidents** (`reason_kind = 'collision'`, Migration
  0013): genau einer je Paar (auf der Seite mit dem späteren Mietbeginn,
  Gleichstand/unbekannt → größere Zuordnungs-ID) und nur, wenn KEINE Seite die
  Kollision per Override bewusst akzeptiert hat; veraltete Incidents werden
  automatisch gelöst, Duplikate durch den offenen Fingerprint verhindert,
  kein Push (Phase 12). Tests: `handover-risk-refresh` (Sperre rein/raus,
  neue Kollision, aufgelöste Kollision, wiederholte Verschiebungen, Override-
  Abdeckung; Test 7 über die HTTP-Route als Nachweis der App-Verdrahtung).
- **A3 – E2E-Specs unabhängig von der Dateireihenfolge**: Jede Spec setzt
  die Testdatenbank in `beforeAll` synchron auf den unveränderlichen
  Basis-Seed zurück (`tests/e2e/helpers/seed.ts` → `scripts/e2e-seed.ts`,
  identisch zum Global-Setup) und legt ihre bestätigten Buchungen selbst an
  (`helpers/booking.ts`, echte Staff-/Web-Wege). `scheduling-flow` erzeugt
  Paula Partyfee/Willi Wechsel nun selbst statt die Commerce-Spec
  vorauszusetzen; die Phase-6-Spec heißt `handover-flow` (läuft alphabetisch
  VOR `warehouse-flow`) und erfasst alle benötigten Lagerartikel selbst.
  Nachweis: Handover-Spec allein, Warehouse-Spec allein, Scheduling-Spec
  allein und die Gesamtsuite auf sauberem Seed grün.

## Phase 7: Rückgabe, Schäden, Fehlteile, Kommissionsrückgabe, Reinigung & Rückgabeprotokoll

- **Zentrale Rückgabegrenze**: `ReturnService` (apps/api/src/returns)
  orchestriert Start, Rückgabeperson, Zubehör-/Sauberkeitskontrolle,
  Kommissionsrückgabe, Unterschriften, Finalisierung, Rückgabe-Liste,
  QR-Einstieg, Reinigungswarnungen und Fehlteil-Follow-ups; `DamageService`
  kapselt Schäden (Markierungen, Fotos, aktuelle Schäden, nachträgliche
  Feststellung, technische Defekte) und implementiert den Phase-6-
  `ExistingDamageProvider`. Lager, Maschinen, Dokumente, Terminplanung und
  Zuordnung werden nur wiederverwendet (`InventoryService.returnWithin`,
  `MachineService.applyReturned/completeCleaning`, `DocumentService`,
  `SchedulingService.completeWithin`) – keine Rückgabelogik in React, in
  Routen oder in fremden Services.
- **Rückgabeentität**: `rental_returns` genau einmal je Buchung (Unique),
  Status draft/finalized, Rückgabeperson (Art, Name, ephemeres Telefon mit
  `returner_phone_deleted_at`), Rückgabetermin-Referenz, Zeitfelder
  (`draft_actual_return_at` vor, `actual_return_at`/`original_actual_return_at`
  bei, `corrected_*` nach der Finalisierung), Protokoll-Dokument. Je
  ausgegebener Zuordnung ein `return_machines`-Abschnitt (eigenes
  `returned_at`, Order §7); Start nur mit ≥ 1 `issued`-Zuordnung – bestätigte
  oder nur vorbereitete Buchungen werden serverseitig abgewiesen.
- **Rückgabeperson**: Kunde selbst, hinterlegte Abholperson (Phase 6) oder
  sonstige Person mit Vorname/Nachname/Telefon (alle drei Pflicht, Order §8).
  Keine Ausweisdaten im Modell (Test 9 prüft die Spalten). Ein Wechsel
  entwertet eine vorhandene Kundenunterschrift; die Kundenunterschrift ist
  Pflicht, es gibt keinen Admin-Bypass (Blocker rechnet der Server).
- **Zubehör/Fehlteile**: Sollwerte aus `products.container_count`
  (1 → 1 Deckel + 1 Tropfschale, 2 → 2 + 2) werden je Abschnitt eingefroren;
  „Zubehör vollständig“ ist ein einfacher Zustand ohne Einträge. Ein
  Fehlteil-Fall entsteht nur durch bewusste Mitarbeiteraktion (nie aus einer
  Abweichung automatisch, DOMAIN_RULES), ohne Foto, ohne Betrag, mit
  `requires_financial_review` solange offen; die Menge ist auf den Sollwert
  begrenzt. Follow-ups haben kein Fälligkeitsdatum (`follow_up_opened_at` bei
  Finalisierung); „Fehlteil erledigt“ ist idempotent, ein Klick, kein Grund,
  keine Lagerbewegung (Deckel/Tropfschalen sind kein Verbrauchslager).
- **Sauberkeit/Reinigungsgebühr**: drei Kriterien je Maschine in EINER
  Bestätigung; jedes fehlgeschlagene Kriterium setzt `cleanup_required`,
  `cleanup_fee_snapshot_cents = 7500` und den Grund (DB-Check verhindert Fakt
  ohne Betrag und Betrag ohne Fakt; der Client kann keinen Betrag senden).
  Mängel erfassen verlangt `return.mark_cleanup_issue`. Kein Settlement, keine
  Rechnung; kleine Restmengen entscheidet der Mitarbeiter (keine Bild-KI –
  ein Foto ändert die Entscheidung nie). Bei Fakt ≥ 1 Beweisfoto Pflicht.
- **Kommissionsrückgabe**: `return_inventory_items` je tatsächlich
  ausgegebener Lieferscheinposition (inklusive/Kommission mit Lagerartikel;
  Kaufartikel/Kanister haben keine Zeile). Eingabe nur der UNGEÖFFNET
  zurückgegebenen Menge (Integer, 0 ≤ returned ≤ issued – Service, Route und
  DB-Check); abrechenbar = ausgegeben − ungeöffnet zurück, Betrag = Menge ×
  eingefrorenem Ausgabe-Einzelpreis (Snapshot aus dem Lieferschein, nie der
  aktuelle Produktpreis). Inklusive Positionen erzeugen eine Lagerrücknahme,
  aber nie eine Gutschrift. Werte sind VORLÄUFIG – keine Settlement-Position.
  Hinweis: MASTER_SPEC/DOMAIN_RULES wenden „nur ungeöffnet“ auf alle
  Kommissionsartikel an (Sirup, Becher-25, Strohhalme-25) – so umgesetzt; die
  Phase-3-Produkttexte („nach tatsächlichem Verbrauch“) bleiben damit
  konsistent (ungeöffnet zurück = nicht verbraucht).
- **Schadensmodell**: `machine_damages` (Maschine, Rückgabe/Abschnitt,
  origin return/post_return_finding, Schweregrad light/medium/severe – UI
  leicht/mittel/schwer –, Pflichtbeschreibung, `requires_financial_review`,
  `activated_at`, `resolved_at`), `damage_markers` (Ansicht vorne/hinten/
  links/rechts, Typ Punkt/Fläche, normalisierte Koordinaten 0..1 mit
  DB-Checks, Fläche innerhalb des Schemas), `damage_photos` (privat, SHA-256,
  Schlüssel nur aus IDs). Kein Betrag, keine Kostenfelder (strikte
  Request-Schemata weisen `costCents`/`amountCents` ab).
- **Schadensdiagramm**: `components/damage-diagram.tsx` zeichnet ein
  neutrales schematisches Schema je Ansicht (Umriss, Behälterbereich,
  Sockel) und projiziert die normalisierten Marker; `MACHINE_SKETCH_ASSETS`
  ist die Asset-Schnittstelle, über die echte Miet-Royal-Grafiken je
  Maschinentyp später ohne Datenmigration eingehängt werden. Im PDF werden
  die Schemata als Vektorgrafik gezeichnet (`drawDamageSketch`), ebenfalls
  aus denselben Koordinaten.
- **Bestehende Schäden bei der nächsten Übergabe**: `DamageService` ist als
  `ExistingDamageProvider` verdrahtet (Routen und Testhelfer). Die Phase-6-
  Finalisierung liest in Phase 1 die aktuellen Schäden, rendert Schema + Text
  (keine Fotos) ins Übergabeprotokoll und friert denselben Stand in
  `handover_machine_checks.existing_damages_snapshot` ein; spätere
  Auflösungen ändern weder Snapshot noch PDF (Tests 69–74).
- **Nachträgliche Feststellung**: nur solange die Maschine 🟡 Reinigung hat
  und ein finalisierter Return existiert (Maschinenzeile gesperrt, damit
  „Gereinigt & einsatzbereit“ serialisiert); Beschreibung, Schweregrad,
  Markierung UND Foto in EINEM Aufruf Pflicht; origin `post_return_finding`,
  sofort aktuell; das unterschriebene Rückgabeprotokoll wird nie neu
  gerendert. Nach Einsatzbereit: 409.
- **Technischer Defekt**: `technical_defects` intern mit dem letzten
  finalisierten Return verknüpft, solange die Maschine seitdem nicht erneut
  ausgegeben wurde (Advisory-Lock `machine-assign:<id>` wie Zuweisung/
  Übergabe); Foto optional (JPEG/PNG/WebP, nicht im PDF);
  `requires_financial_review = false`; Antwort trägt den Hinweis „Maschine
  ggf. in Reparatur setzen“ – kein automatischer Statuswechsel, keine
  Kundenbelastung. Recht: `machine.change_status` (Reparatur-Nähe).
- **Reinigung**: Finalisierung setzt IMMER 🟡 Reinigung, Standort Lager,
  `cleaning_since`; „Gereinigt & einsatzbereit“ (`machine.clean_complete`)
  nur aus Reinigung, speichert `cleaned_by/cleaned_at` (nur administrative
  Sicht, Maßstab `employee.manage`), keine Historientabelle. 24-h-Warnung
  rein zeitabhängig aus `cleaning_since` (kein Job, kein Push) – ein manuell
  gesetzter Reinigungsstatus ohne Rückgabe hat keinen Reinigungsbeginn und
  löst keine Warnung aus (Order §53: „nach Rückgabe“). `machines.cleaned_by`
  bewusst ohne FK auf staff_users (Test-/Seed-Resets truncaten staff_users
  CASCADE – Stammdaten dürfen nicht mitgerissen werden).
- **Rückgabeprotokoll**: `renderReturnProtocolPdf` serverseitig (Dokumentart,
  Vorgang, Kunde, Rückgabeperson, tatsächliche Rückgabezeit, je Maschine
  Zubehör/Rückgabevorbereitung/Reinigungs-Fakt + Beweisfotos/neue Schäden
  mit Schema + Fotos/Fehlteile, Kommission als Tatsachen „ausgegeben /
  ungeöffnet zurück / verbraucht bzw. abrechenbar“, Zusammenfassung oder
  „Rückgabe ohne Beanstandung.“, beide Unterschriften, Integritätshinweis,
  ausdrücklich „keine Rechnung“). Fotos, die ins PDF eingebettet werden
  (Beweis-/Schadensfotos), sind auf JPEG/PNG beschränkt und werden VOR dem
  Speichern strukturell geprüft (`pngLooksValid`/`jpegLooksValid` in
  `handover/media.ts`), weil pdfkit PNGs asynchron dekomprimiert; nicht
  einbettbare Bilder brechen als `PhotoImageError` → VALIDATION ab. Ein
  Dokument je Return (Storage-Key mit Versuchs-Suffix, immutable, SHA-256).
- **Finalisierung/Idempotenz**: zweiphasig wie Phase 6 (Bilder laden, PDF
  rendern, hochladen OHNE Sperren; dann Transaktion mit Advisory-Lock
  `return-finalize:<id>`, Zeilensperre der Rückgabe, Slot-Zeilen und
  sortierte Maschinen-Advisory-Locks in derselben Reihenfolge wie Zuweisung/
  Übergabe, erneute Vorbedingungen über `detailWithin(tx)` (A1: keine
  Pool-Akquise unter Sperren), Fingerprint-Vergleich inkl. Signatur-Hashes).
  Atomar: Dokument registrieren, return-Bewegungen je Artikel, Kommissions-
  fakten einfrieren, Zuordnungen → returned (+ Override archivieren),
  Maschinen → Reinigung/Lager, Rückgabetermin `completeWithin`, Follow-ups
  aktivieren, Rückgabeschäden aktivieren, Return finalisieren + Telefon
  löschen, Paket `return_completed` (partieller Unique `(return_id, kind)`).
  Prozessinterne `KeyedMutex` + `status = 'finalized'`-Rückkehr unter Sperre
  machen Doppelklick/Retry/parallele Instanzen idempotent; Storage-/PDF-
  Fehler lassen keinen halben Zustand zurück (Tests 107–109). Der Vorgang
  bleibt offen.
- **Kalender**: `SchedulingService.complete` lehnt Rückgabetermine
  AUSGEGEBENER Buchungen ab („… über den Rückgabeprozess“); nicht
  ausgegebene Buchungen behalten den neutralen internen Abschluss.
- **Rechte** (PERMISSIONS.md führend, kontrollierte Ergänzungen):
  `return.view`, `return.complete`, `damage.resolve_current`,
  `machine.clean_complete`; wiederverwendet `return.perform`,
  `return.mark_cleanup_issue`, `return.correct_actual_time`,
  `damage.document`, `missing_item.create`, `missing_item.resolve`,
  `machine.change_status`; `inventory.return` bleibt für manuelle Rücknahmen
  außerhalb einer Rückgabe reserviert (die Rückgabe bucht unter
  `return.complete`, analog zu `handover.perform`). Alle Routen prüfen Recht
  und Phase-2-Sichtbarkeit serverseitig; QR umgeht nichts (Recht +
  Sichtbarkeit nach der Auflösung); Rückgabeprotokolle sind mit
  `return.view` abrufbar, alles andere unverändert.
- **UI**: `/rueckgabe` (überfällig → heute → kommende ±3 Tage → ohne
  Termin, QR-Einstieg über `QrScanner` mit Rückgabe-Resolver),
  `/vorgaenge/[id]/rueckgabe` (10 Schritte, eine dominante Hauptaktion je
  Schritt, Server-Blocker), Maschinendetail (Reinigungskarte mit roter
  24-h-Warnung und „Gereinigt & einsatzbereit“, aktuelle Schäden mit Schema/
  Fotos/„Nicht mehr aktuell“, nachträgliche Feststellung, technischer Defekt,
  offene Fehlteile), „Heute“ (rote Reinigungswarnung, offene Fehlteile –
  überfällige Rückgaben bleiben ganz oben), Vorgang (Rückgabe-Karte, nächste
  Aktion „Rückgabe starten/fortsetzen“).
- **Adversarialer Review (Phase 7)**: 5-dimensionaler Workflow-Review
  (Spec Rückgabe, Spec Schäden/Reinigung, Security, Nebenläufigkeit, Tests/UI)
  mit Skeptiker-Pass; jedes Finding selbst gegen Vorgabe und Code verifiziert.
  Behoben:
  - Nachtragsfenster (§§37/38) hing nur am Status „Reinigung“: ein späterer
    manueller Status „Reinigung“ (oder eine erneute Ausgabe mit altem
    `cleaning_since`) hätte Kundenschäden zum alten Return erlaubt. Jetzt
    `postReturnWindowOpen` = Status Reinigung UND von der Rückgabe gesetzter
    Reinigungsbeginn; `setStatus` ist übergangsbewusst (Reinigung →
    Einsatzbereit nur über „Gereinigt & einsatzbereit“, sonst 409; Verlassen
    der Reinigung löscht `cleaning_since`; manuelles „Reinigung“ startet keine
    Phase nach Rückgabe → keine falsche 24-h-Warnung); eine neue Ausgabe
    (`applyProcessStatus('rented')`) beendet die Reinigungsphase; zusätzlich
    `notReissuedSince`-Guard im Nachtrag. Tests R1, R2, 78b.
  - Schadensfoto-Upload lief außerhalb der Entwurfssperre (Foto hätte NACH
    dem Fingerprint-Recheck der Finalisierung committen können): `addPhoto`
    sperrt zuerst die führende Zeile (Rückgabe bzw. Maschine, gleiche
    Sperrreihenfolge wie Finalisierung/Reinigungsabschluss), dann den Schaden.
  - Verwaiste Rückgabeprotokolle im Storage (Idempotenz-Rückkehr, CONFLICT,
    DB-Fehler nach Upload): Finalisierung löscht das hochgeladene PDF, wenn es
    nicht registriert wurde.
  - §47 „alle issued Assignments enthalten“ war nicht serverseitig geprüft:
    Finalisierung vergleicht unter den gehaltenen Sperren die ausgegebenen
    Zuordnungen der Buchung mit den Rückgabeabschnitten (409 bei Abweichung,
    Test R4).
  - Kommissionsartikel ohne hinterlegten Lagerartikel (neu angelegte
    Verbrauchsprodukte, Phase 5 seedet nur die Grundausstattung) wurden still
    übergangen → Fakten (ausgegeben/ungeöffnet/abrechenbar, Preis-Snapshot,
    PDF) wären für Phase 9 verloren gegangen. `return_inventory_items.
    inventory_item_id` ist jetzt nullable; nur die Ledger-Bewegung entfällt
    (wie bei der Ausgabe in Phase 6). Test R3.
  - Rückgabe-Wizard erzwang die Kamera (`capture="environment"`) – §64 „kein
    Kamerazwang“: entfernt, der Systemdialog bietet Kamera und Galerie.
  - Asset-Schnittstelle (§30) war nur nominell: `productSlug` wird jetzt in
    `DamageView`/`ReturnMachineView`/`machineCondition` geführt und an jedes
    Schadensschema übergeben; PDF-Renderer erhalten `sketchImages` je Ansicht
    (`sketch-assets.ts`, leer = neutraler Platzhalter). Keine Datenänderung.
  - QR-Token des Rückgabe-Einstiegs (damals `/staff/returns/resolve-qr/:token`,
    seit der Phase-8-Finalisierung `POST /staff/returns/resolve-qr` mit Token
    im Body) wurde unmaskiert geloggt → `maskLoggedPath` erweitert (Test 135).
  - `/staff/missing-items` und die vorgangsbezogenen Teile von
    `/staff/machines/:id/condition` (Fehlteile, Defekte) folgten nicht der
    zentralen Sichtbarkeitsregel: jetzt `process.view_all` +
    `visibleProcessesWhere`; ohne Vorgangsrecht liefert die Maschinenansicht
    keine vorgangsbezogenen Einträge (Test R6).
  - Nachtrag/Defekt schrieben an den letzten Rückgabevorgang ohne dessen
    Sichtbarkeit zu prüfen → `postReturnTarget` + `requireVisibleProcess` vor
    dem Schreiben (Test R6).
  - Existenz-Orakel (404 vor 403): Grundrecht `process.view_all` wird in allen
    ressourcenbezogenen Rückgabe-Routen VOR dem Laden geprüft (Test R5).
  - DB-Backstops für Zustandsinvarianten (finalisiert ⇒ Zeitstempel/Protokoll
    vorhanden, Telefon gelöscht; Nachtrag ⇒ aktiv; erledigt ⇒ erledigt von/am;
    Schaden immer mit Rückgabebezug) als CHECK-Constraints in Migration 0014.
  - Terminvorschau: veralteter Hinweistext („folgt in einer späteren Phase“)
    ersetzt, Badge „Abgeschlossen“ statt „Intern abgeschlossen (kein
    Rückgabeabschluss)“, Link „Rückgabe öffnen“ am Rückgabetermin (§6).
  - Rückgabeliste (§5 „±3 Tage“): das „kommende Tage“-Fenster war ein
    rollierendes 72-h-Fenster (uhrzeitabhängig, E2E A vor 11:00 Uhr rot) →
    jetzt kalendertagbasiert (heute + 3 Berliner Kalendertage, DST-unabhängig;
    Test R7 mit festem Aufrufzeitpunkt).
  - Technischer Defekt: das optionale Foto (§39) war nur per API möglich →
    Datei-Eingabe im Maschinendetail (Kamera oder Galerie).
  - Wizard: „Weiter“ ist erst dann die primäre Aktion, wenn die
    Schrittbedingung erfüllt ist (§62 „eine dominante Hauptaktion je Schritt“).
  - Tests geschärft: 118 prüft die 24-h-Warnung als reine Ableitung (keine
    neuen Datensätze, keine Maschinenänderung) statt einer tautologischen
    Job-Zählung; 137 prüft relative, umgebungsneutrale Storage-Schlüssel ohne
    Kundendaten (Isolation selbst bleibt Konfigurationssache, Test 136);
    72 und E2E F/K zählen Bild-XObjects codec-unabhängig statt nur
    `/DCTDecode`; E2E I prüft die rote 24-h-Warnung in Maschinenansicht und
    „Heute“ über einen Test-Helfer (`e2e-backdate-cleaning.ts`); E2E J
    prüft die serverseitige Ablehnung (409) eines weiteren Kundenschadens nach
    der Reinigung – nicht nur das Verschwinden des Buttons.
  - E2E-Spec: Schritt 1 verlangt die Rückgabeperson vor „Weiter“, Laden der
    Seite wird abgewartet, Schema-Klick über den Locator (scrollt in den
    sichtbaren Bereich), verbrauchte Kommission ist keine Beanstandung (§41).
  Bewusst NICHT übernommen (verifiziert): die drei Sauberkeitskriterien als
  einzeln zu bestätigende Toggles – §15 verlangt die aktive Prüfung je
  Maschine, §41 „keine Checkbox-Orgie“: die Kriterien sind sichtbar
  vorbelegt und werden mit EINER Bestätigung je Maschine aktiv attestiert,
  Abweichungen werden vor der Bestätigung abgewählt (Fakt mit Grund).
  Ebenfalls nicht übernommen: manuelle Statuswechsel ab „Vermietet“ generell
  sperren (Phase-5-Statusregel bleibt; die Reinigungsphase wird stattdessen
  bei erneuter Ausgabe beendet).
- **Bewusst offen (Deferred, Phase 7)**: Versand des Rückgabe-Pakets
  (Outbox-Worker/Mailadapter), Schadens-/Fehlteilbeträge, Endabrechnung,
  Lexware, Schadenkosten-Mail/24-h-Frist (Phase 9+), echte Maschinengrafiken
  (Asset-Schnittstelle vorhanden), Teilrückgaben, Offline (Phase 8), Push
  (Phase 12), Kamera-Scan mit echter `BarcodeDetector`-API (E2E nutzt den
  manuellen Fallback).

## Phase 8: Offlinebetrieb, PWA-Sync & vereinfachter Lager-/Tabletmodus

- **Grundprinzip**: PostgreSQL bleibt die einzige Autorität (DOMAIN_RULES
  „Offline: Server ist Autorität“). Offline-Daten sind temporäre,
  verschlüsselte Arbeitskopien plus eine Queue noch nicht synchronisierter
  operativer Erfassungen – niemals eine zweite Geschäftsdatenbank. Lokal
  abgeschlossene Vorgänge heißen in der UI ausschließlich „Übergabe/Rückgabe
  offline erfasst – Synchronisierung ausstehend“; finale PDFs, Lagerbuchungen,
  Maschinenstatus und Terminabschlüsse entstehen erst serverseitig beim Sync.
- **Paketaufteilung**: `packages/offline` (`@mietroyal/offline`, reines TS,
  kein React) enthält den Offline-Kern: WebCrypto-Bausteine, versioniertes
  IndexedDB-Schema mit Migrationen, verschlüsselnden `OfflineStore`,
  `OfflineWorkspace` (Schlüssel/Lease/Entsperrung), `SyncEngine` (Queue,
  Abhängigkeiten, Backoff, Konflikte, Bereinigung) sowie unter
  `@mietroyal/offline/shared` die DOM-freien, von API UND Staff-App
  gemeinsam genutzten Mutationsverträge (zod, strict) und Paket-Wire-Typen.
  `apps/api/src/offline/` bildet die serverseitige Boundary (Lease, Paket,
  Sync-Orchestrator), `apps/staff/lib/offline/` die React-Bindung (Laufzeit-
  Singleton, Offline-Router in `apiFetch`, lokale Projektion, Provider).
  Unit-Tests laufen mit `fake-indexeddb` und Node-WebCrypto.
- **PWA**: `public/manifest.webmanifest` (standalone, neutrale Platzhalter-
  Icons SVG/PNG 192/512/maskable, drop-in ersetzbar), `public/sw.js` als
  reiner Cache-/Lifecycle-Worker (Order §80): `/_next/static/*` cache-first,
  Manifest/Icons/Schemata/Fonts stale-while-revalidate, Navigationen
  network-first mit Timeout und Fallback auf die gecachte Seite bzw. die
  Startseite; `/api/*` wird NIE abgefangen oder gecacht (Fachdaten, PDFs,
  Fotos, Unterschriften laufen nur über den verschlüsselten Store). Die App
  cacht nach jedem Paketabruf die Seiten-Shells der geladenen Vorgänge
  (`PREFETCH_PAGES`, nur HTML ohne Fachdaten), damit Offline-Navigation in
  Wizards möglich ist. Die Phase-7-Schadensschemata sind Inline-SVG im
  Bundle (offline immer verfügbar); `public/sketches/` ist für echte
  Grafiken vorbereitet und SW-cachebar.
- **Schlüsselmodell (Order §§6/7)**: Je Arbeitsbereich (Benutzer × Umgebung ×
  Gerät) ein zufälliger AES-256-GCM-Datenschlüssel (DEK). Alle fachlichen
  Inhalte (Vorgangs-Snapshots, Maschinen, Dokument-Bytes, Mutationspayloads,
  Medien, Konflikttexte) liegen als `{v, iv, ct}`-Blob mit datensatz-
  spezifischer AAD (`booking:<id>`, `media:<id>` …) in IndexedDB; im Klartext
  stehen nur technische Index-/Schlüsselfelder (IDs, Status, Zeitstempel,
  SHA-256-Hashes). Der DEK wird zweifach gewrappt: **Wrap A** mit einem KEK
  aus PBKDF2-SHA-256 (600 000 Iterationen, 16-Byte-Salt) über das
  Mitarbeiterpasswort – erzeugt ausschließlich bei einer ONLINE bestätigten
  Anmeldung/Entsperrung, bei der das Passwort ohnehin im Formular vorliegt
  (kein zusätzlicher Prompt, keine Warehouse-PIN); **Wrap B** mit dem
  serverseitigen Lease-Secret für die stille Entsperrung nach einem Reload
  bei bestehender Verbindung. Passwörter, Passwort-Hashes und TOTP-Secrets
  werden nie lokal gespeichert; ein falsches Passwort scheitert am GCM-Tag.
  KDF-Wahl: PBKDF2 ist die einzige in WebCrypto überall (inkl. WebKit)
  verfügbare Passwortableitung; Argon2 bliebe nur per WASM möglich und wurde
  bewusst nicht als zweite Krypto-Implementierung eingeführt.
- **Offline-Lease (Order §8)**: `offline_access_leases` – ein aktives Lease je
  Benutzer × Gerät × Umgebung, `expires_at ≤ issued_at + 72 h` (DB-Check),
  Secret nur AES-256-GCM-verschlüsselt mit `AUTH_SECRET_KEY` gespeichert,
  Ausgabe/Verlängerung/Widerruf als Security-Events. Ausstellung nur über
  eine entsperrte Session und nur für Konten mit operativen Rechten
  (`handover.view`/`return.view`/`machine.view`); jede Verlängerung erzeugt
  ein neues Secret (Client wickelt den DEK neu ein). **Client-Lease-
  Verifikation (Finalisierung §1, `packages/offline/src/lease-claim.ts`,
  `workspace.ts`)**: Der Client prüft den signierten Claim mit WebCrypto
  (`importKey('raw', pub, { name: 'Ed25519' })` / `verify('Ed25519', …)`)
  vollständig offline – Signatur, Struktur (`parseOfflineLeaseClaim`,
  Laufzeit ≤ 72 h), Identitätsbindung (userId × deviceId × environment der
  Workspace-Identität) und Ablauf gegen die monotone Uhr. `authorizeOnline`
  übernimmt leaseId/issuedAt/expiresAt NUR aus dem verifizierten Claim
  (ungültig ⇒ `LeaseInvalidError`, Grant wird nicht übernommen, bestehender
  Zustand bleibt); JEDE Entsperrung (Passwort, Lease-Secret, flüchtiger
  Service-Worker-Schlüssel) und `leaseState()` verifizieren erneut, und der
  lokale Datensatz muss exakt dem Claim entsprechen – ungültige Signatur/
  Abweichung ⇒ `lease_tampered`, abgelaufen ⇒ `lease_expired`, fehlendes
  Ed25519 in der Engine ⇒ ungültig (nie „durchgewinkt“). Der HMAC-SHA-256
  (HKDF aus dem DEK) über den Lease-Datensatz bleibt als Integritätsschutz
  für Rechte-Snapshot/Name und als Bindung des flüchtigen Schlüssels an
  genau diesen Arbeitsbereich, ist aber nicht mehr die Autorisierungsgrenze.
  **Schlüssel-Pinning (Review-Befund S1)**: Der öffentliche Serverschlüssel
  wird dem Client aus der Umgebung des Staff-Servers geliefert
  (`STAFF_OFFLINE_LEASE_VERIFICATION_KEY` → `<meta name="mr-offline-lease-key">`
  im Root-Layout, zur Laufzeit je Umgebung gerendert; Wert per
  `pnpm offline:lease-key` aus der API-Umgebung, Base64url, kein Secret;
  Fallback zur Build-Zeit `NEXT_PUBLIC_OFFLINE_LEASE_VERIFICATION_KEY`).
  In `staging`/`production` ist das Pinning **fail-closed**
  (`WorkspaceOptions.requireTrustedKey`): ohne hinterlegten Schlüssel wird
  keine Lease akzeptiert (Sperrmeldung „… nicht gegen den hinterlegten
  Serverschlüssel geprüft“, Online-Betrieb unberührt) – denn ohne Pinning
  wäre der im Grant gelieferte Schlüssel für einen Angreifer mit DevTools und
  Passwort austauschbar. In `development`/`demo` gilt ohne Pinning der im
  Grant gelieferte Schlüssel (Komfort für lokale Entwicklung; dokumentiertes
  Restrisiko nur dort). Nach Ablauf ist der Offline-Arbeitsbereich gesperrt,
  bis das Gerät online neu autorisiert. **Monotone Uhr (präzisierte Regel,
  `runtime.ts`)**: `meta.clock.serverMs` = höchste Serverzeit (Lease, Paket,
  Status), `meta.clock.maxSeenMs` = Untergrenze für `now()`. Serverzeit
  aktualisiert beide; lokale Zeit nur `maxSeen = max(maxSeen, min(local,
  serverMs + 72 h))` und nur, wenn schon eine Serverzeit bekannt ist;
  `now() = max(Date.now(), maxSeen)`. Eine zurückgestellte Uhr verlängert
  kein Lease (Gerät offline, Uhr +73 h ⇒ abgelaufen; Uhr zurück, Reload
  offline ⇒ bleibt abgelaufen), eine grob vorgehende Uhr sperrt höchstens bis
  Serverzeit + 72 h – eine neue Online-Autorisierung (expiresAt = Server-
  Jetzt + 72 h > maxSeen) öffnet wieder. Die frühere 72-h-15-min-
  Plausibilitätsregel ist entfernt. Meldet der Server beim Secret-Abruf 404/403
  (Lease abgelaufen/widerrufen), wird Wrap B lokal entfernt; es bleibt nur
  Wrap A (Passwort) bzw. eine neue Online-Autorisierung. Die lokale
  Passwort-Entsperrung ist nach 5 Fehlversuchen gesperrt (Zähler in `meta`,
  Reset nur durch erfolgreiche Entsperrung/Online-Autorisierung) – gegen
  Ausprobieren auf einem gestohlenen Gerät zusätzlich zu PBKDF2.
  **Serversignierter Lease-Claim (Phase-8-Finalisierung §1)**: Jede
  Ausstellung/Verlängerung liefert neben dem Secret einen Claim
  `{ v: 1, leaseId, userId, deviceId, environment, issuedAt, expiresAt,
  nonce }` (JSON-Text in exakt dieser Feldreihenfolge, Nonce = 16 Zufalls-
  bytes Base64url) plus `signature` (Ed25519 über die UTF-8-Bytes des
  Claim-Texts, Base64url) und `verificationKey` (rohe 32 Byte des
  öffentlichen Schlüssels, Base64url). Der private Schlüssel existiert nur
  serverseitig: Seed = HKDF-SHA256(`AUTH_SECRET_KEY`, Salt
  `mietroyal/offline-lease-signing/salt/v1`, Info
  `mietroyal/offline-lease-signing/v1`, 32 Byte) → PKCS#8-DER (RFC-8410-
  Präfix + Seed) → `crypto.createPrivateKey`; ausschließlich node:crypto,
  keine eigene Kryptografie, nichts zusätzlich zu persistieren
  (`OfflineLeaseSigner` in `apps/api/src/offline/lease-signing.ts`).
  Weil `AUTH_SECRET_KEY` je Umgebung verschieden sein MUSS (Env-Isolation),
  sind Demo-/Production-Signaturen nicht austauschbar; zusätzlich steht
  `environment` im Claim. Der Client verifiziert Claim und Signatur
  vollständig offline (WebCrypto Ed25519) und übernimmt Laufzeit und
  Identität NUR aus dem verifizierten Claim; `expiresAt − issuedAt` ist
  immer exakt 72 h (`OFFLINE_LEASE_MS`, kein Client-Parameter, DB-Check
  `≤ issued_at + 72 h` bleibt). Claim/Signatur werden nicht in der DB
  gespeichert (Server-Autorität sind die Spalten `issued_at`/`expires_at`,
  über die signiert wird); `GET /staff/offline/lease/secret` ist unverändert.
  Dokumentiertes Restrisiko (angepasst): Der Client kann ein Lease weder
  selbst verlängern noch neu erzeugen – ohne den serverseitigen Schlüssel
  gibt es keinen gültigen Claim, und ein veränderter Ablauf bricht die
  Signatur. Verbleibend ist allein manipulierter Client-Code auf einem
  Gerät, dessen Besitzer auch das Passwort kennt (er könnte die lokale
  Prüfung umgehen, nicht aber ein Lease fälschen); ein physisch offline
  befindliches Gerät kann nicht sofort widerrufen werden – gegen den
  Passwortinhaber schützt der Server beim nächsten Onlinekontakt.
  Serverseitiger Widerruf greift beim nächsten Onlinekontakt: Session-
  Widerruf oder Benutzersperre blockieren Secret, Paket UND Sync (jeder
  Offline-Endpunkt verlangt eine gültige Session, Rechte werden je Mutation
  frisch geprüft). Der Lease-Widerruf selbst (nur beim Abmelden, zusammen mit
  der Session) blockiert Secret-Abruf und Paket; der Sync prüft bewusst kein
  Lease, damit noch ausstehende Änderungen eines Geräts mit abgelaufenem
  Lease nach erneuter Autorisierung nicht verloren gehen – die Sicherheit
  hängt an der Session, nicht am Lease. Lokale Daten werden dabei nicht
  heimlich vernichtet (§39).
- **Arbeitspaket (Order §§9–12, 54)**: `OfflinePackageService` wendet Rechte
  und Phase-2-Sichtbarkeit serverseitig an (`buildVisibilityContext`),
  sammelt Kandidaten aus den bestehenden Listen (`HandoverService.listForDay`
----
1235:- **Grundprinzip**: PostgreSQL bleibt die einzige Autorität (DOMAIN_RULES
1242:- **Paketaufteilung**: `packages/offline` (`@mietroyal/offline`, reines TS,
1253:- **PWA**: `public/manifest.webmanifest` (standalone, neutrale Platzhalter-
1265:- **Schlüsselmodell (Order §§6/7)**: Je Arbeitsbereich (Benutzer × Umgebung ×
1282:- **Offline-Lease (Order §8)**: `offline_access_leases` – ein aktives Lease je
1298:
- **Arbeitspaket (Order §§9–12, 54)**: `OfflinePackageService` wendet Rechte
  und Phase-2-Sichtbarkeit serverseitig an (`buildVisibilityContext`),
  sammelt Kandidaten aus den bestehenden Listen (`HandoverService.listForDay`
  für heute ±3 Berliner Kalendertage, `ReturnService.listOpen` für aktive
  Vermietungen/überfällige Rückgaben, `extraBookingIds` mit gleicher
  Rechteprüfung), deckelt auf 60 Vorgänge (`truncated`) und liefert je
  Vorgang nur das Nötige: Übergabe-Detail, Rückgabe-Seed (spiegelt
  `ReturnService.start`), Kandidaten-Maschinen mit `situationFingerprint`,
  bestehende Schäden, jeweils neueste Dokumente je Typ als Bytes mit SHA-256,
  minimale Kontaktdaten (Name, Telefon, Lieferadresse nur bei Lieferung) –
  keine E-Mail, keine Admin-/Finanz-/Abrechnungsdaten. Maschinen tragen
  `qrHash = SHA-256(Token)`; Rechte-Snapshot und Umgebungs-ID liegen im Paket.
- **Lokaler Store (Order §§5, 59, 71)**: IndexedDB `mietroyal-offline-<env>-<userId>`
  (getrennte Namespaces je Umgebung und Benutzer), Schemaversion 2 mit
  expliziten Migrationsfunktionen (v1 Grundschema mit Stores workspace,
  packages, bookings, machines, documents, mutations, media, conflicts,
  receipts, meta; v2 Kontext-Index der Queue). Ein Downgrade bricht ab statt
  zu löschen; Upgrades erhalten alle Datensätze (Tests: frisch, v1→v2,
  pending Mutation überlebt). Keine Klartext-Indizes mit Kundenname/Telefon/
  Adresse; die QR-Zuordnung liegt nur als SHA-256 des Tokens vor.
- **Offline-QR (Order §13/§14)**: Der bestehende `QrScanner` erhält einen
  `resolve`-Hook; offline wird `SHA-256(token.toLowerCase())` gegen den
  lokalen Maschinen-Store verglichen (Token nie im Klartext gespeichert).
  Finalisierung: Client und Offline-Router übertragen den Token nur noch als
  POST-Body (`POST /staff/machines/qr/resolve`, `POST /staff/returns/
  resolve-qr`, Body `{ token }`), nie in einer URL oder in `console.*`; der
  Deep-Link `/qr/<token>` liest den Token einmal aus der Route, entfernt ihn
  sofort per `history.replaceState` aus der Adressleiste und löst per POST auf;
  der Service Worker legt `/qr/*`-Navigationen nie im Seitencache ab und
  entfernt sie beim Wipe (Review-Befund S2). Inhärent bleibt: Der Deep-Link
  selbst erreicht den Staff-Server (Zugriffslog des Next-Servers/Proxys) – das
  ist der Preis des Kamera-Scans ohne App; die API-Logs sind tokenfrei.
  Treffer nur für Maschinen des berechtigten Pakets; unbekannt/fremd ⇒
  neutrale Meldung „Dieser QR-Code ist nicht gültig.“; das Ergebnis führt
  in den passenden operativen Kontext (Ausgabe/Rückgabe/Maschine/Reinigung),
  nie in eine automatische Geschäftsaktion.
- **Offline-Router statt zweiter Wizards (Order §§15, 18, 19)**: `apiFetch`
  leitet offline – und online in Kontexten mit lokal ausstehenden Änderungen –
  an `routeOffline`. GET-Routen werden aus Snapshot + lokalen Mutationen
  projiziert (`projection.ts`, lokale IDs mit Präfix `local:`), Schreibrouten
  werden als typisierte Mutationen eingereiht. Nicht modellierte Schreibrouten
  liefern offline `ONLINE_REQUIRED`, online bei Pending-Kontext
  `OFFLINE_PENDING_CONTEXT` („zuerst synchronisieren“). Der lokale Abschluss
  heißt ausschließlich „Übergabe/Rückgabe offline erfasst – Synchronisierung
  ausstehend“.
- **Offline-Assignment/Override (Order §§16/17)**: Kandidaten samt
  `situationFingerprint` kommen aus dem Paket; eine offline gewählte Maschine
  wird mit Basisstand (`expectedMachineId`) und Fingerprint gesendet – der
  Server meldet `MACHINE_REASSIGNED`, `MACHINE_UNAVAILABLE` (inzwischen
  anderweitig ausgegeben/gesperrt) oder `SITUATION_CHANGED` statt still zu
  überschreiben.
- **Zeiten (Order §§68/69)**: Alle lokalen Zeitpunkte sind UTC-Instants, die
  Gerätezeit ist nur Input. Der Server prüft `clientTime`, `createdAt` und
  die getragene Erfassungszeit (Toleranz 15 Minuten, nicht in der Zukunft,
  nicht älter als 72 h) ⇒ `CLOCK_IMPLAUSIBLE` („Gerätezeit prüfen“).
- **Sync-Queue (Order §§27–31, 36)**: Mutationen tragen `clientMutationId`
  (UUID), Umgebung, Kontext (Vorgang/Maschine), `dependsOn`, `baseVersion`
  (Pflicht), Medien (SHA-256). Reihenfolge je Kontext, Medien vor
  Finalisierung, Backoff bei transienten Fehlern, kein Retry bei Konflikt/
  Ablehnung; Sitzungsverlust beendet den Lauf und lässt alles ausstehend.
- **Konnektivität (Order §78)**: `navigator.onLine` ist nur ein Hinweis;
  maßgeblich ist der authentifizierte Health-Check `/staff/offline/status`
  (verlängert die Aktivität nicht), 60-s-Intervall plus online/offline-
  Events; jeder Offline→Online-Übergang startet den Sync. Jeder Offline-
  Übergang erhöht eine Konnektivitäts-Epoche (`ConnectivityEpoch`): eine
  Health-Check-Antwort, die erst nach dem Übergang ausgewertet wird (Antwort
  lesen und Serverzeit persistieren sind asynchron), ist veraltet, setzt den
  Zustand nicht auf „online“ und startet keinen Sync (Phase 11 §3, Flake L6a).
- **Serverseitige Idempotenz (Order §§28, 63, 64)**: `offline_mutation_receipts`
  (PK clientMutationId, Status processing/applied/conflict/rejected,
  technische `result_ref`). Replay einer angewandten ID liefert dieselbe
  Antwort ohne zweite Wirkung; Konflikt/Ablehnung erlaubt die Neubewertung;
  fremde Mutations-IDs (anderer Benutzer) werden abgelehnt.
- **Sync-Orchestrator (Order §§61, 62, 74)**: `OfflineSyncService` prüft je
  Mutation Umgebung, Rechte (frisch aus der Datenbank), Sichtbarkeit,
  Basisstand, Uhrzeit und Medien-Hashes und führt die Fachmutation über die
  bestehenden Domainservices aus (Lager, PDFs, Maschinenstatus, Termine
  entstehen nur dort). Die Mitarbeiter-Identität einer Unterschrift kommt aus
  der Session, nie aus dem Client.
- **Konflikte (Order §§32–35, 65–67)**: Kein Last-Write-Wins. Neutrale
  Konfliktcodes, lokale Beweise (Fotos/Unterschriften) bleiben bis zur
  bewussten Entscheidung erhalten; „Erneut anwenden“ läuft über die normalen
  Domainservices, „Verwerfen“ nur mit Rückfrage. Es gibt keinen Force-
  Update-Endpunkt.
- **Konfliktdetails (Finalisierung §4)**: Jede Konflikt-/Ablehnungsantwort
  trägt `details: { offline, server, action }` – kurze deutsche Sätze mit nur
  den relevanten Feldern, serverseitig im Sync-Orchestrator erzeugt (der
  Client zeigt sie, interpretiert sie nicht). Erlaubt sind Maschinencodes,
  Mengen, Termin-Art + neue Zeit (Berliner Zeit), neutrale Problemlabels der
  Assignment-Bewertung („Zeitliche Kollision“, „Gesperrt“ …); ausgeschlossen
  sind Kundendaten, Vorgangsnummern anderer Kunden, Rechte-Keys und
  JSON-Dumps. `offline` ist null, wenn nur der Client die Offline-Grundlage
  kennt (Terminänderung: alte Zeit steht im Snapshot). Beispiele:
  MACHINE_REASSIGNED „Offline gewählt: MR-10-01-01; Grundlage: keine
  Maschine“ / „Der Slot ist inzwischen Maschine MR-10-01-02 zugeordnet.“;
  MACHINE_UNAVAILABLE „Maschine MR-… ist inzwischen an einen anderen Vorgang
  ausgegeben.“; SITUATION_CHANGED „Die Problemlage von MR-… hat sich
  geändert: Gesperrt.“; APPOINTMENT_CHANGED „Ausgabe inzwischen auf
  17.10.2026 14:30 geändert.“; QUANTITY_CHANGED „Offline erfasst: Menge 2
  (Grundlage: Menge 3)“ / „Serverseitig inzwischen Menge 5.“;
  CLOCK_IMPLAUSIBLE „Gerätezeit weicht um ca. 180 Minuten ab.“;
  PERMISSION_REVOKED „Dafür fehlt dir inzwischen die Berechtigung.“ (ohne
  Key). Codes ohne fachlich konkretere Gegenüberstellung erhalten
  Standarddetails (Aktionsbezeichnung aus `MUTATION_LABELS`, neutrale
  Ursache, Handlungsempfehlung). Client: Die frühere Entscheidung „keine
  Gegenüberstellung in der Liste“ ist aufgehoben. `details` wird im
  verschlüsselten Konflikt-Payload (`{ message, serverState, details }`)
  gespeichert; „Synchronisierung prüfen“ zeigt je Konflikt drei Zeilen
  „Offline erfasst“ / „Serverstand“ / „Was jetzt zu tun ist“. Fehlt
  `details.offline`, fällt die Anzeige auf den lokalen Snapshot/Payload
  zurück – bei `APPOINTMENT_CHANGED` „Offline-Grundlage: <Terminart>
  <dd.mm.yyyy HH:MM Uhr>“ aus dem Terminstand des Snapshots (Termin-ID aus
  dem Basisstand), sonst Aktionsbezeichnung + Detail; fehlen `server`/
  `action`, gelten Code-Label bzw. Standardtext. Keine JSON-Dumps, keine
  Kundendaten; die drei Handlungen bleiben.
- **Bereinigung (Order §§36–38)**: Synchronisierte Mutationen und
  ausschließlich von ihnen referenzierte Medien werden erst nach Ablauf einer
  Frist (1 h) entfernt; ausstehende/konfliktierte Daten nie automatisch.
  Logout ohne Pending löscht den lokalen Arbeitsbereich vollständig; Logout
  mit Pending warnt und löscht nicht still.
- **PWA-Update (Order §§70–72)**: kein automatisches `skipWaiting`; eine
  wartende Version erzeugt den unaufdringlichen Hinweis „Neue Version
  verfügbar“ nur außerhalb einer laufenden Erfassung (Wizard-Routen) und
  ohne ausstehende Mutationen; „Jetzt aktualisieren“ sendet `SKIP_WAITING`,
  `controllerchange` lädt neu. IndexedDB-Schemaänderungen laufen über
  Migrationen (nie löschen); `SW_VERSION` in `sw.js` steuert die Cache-
  Namen (alte Caches werden bei Aktivierung entfernt) und ist bei
  Änderungen an der Cache-Strategie hochzuzählen; Registrierung mit
  `updateViaCache: 'none'`.
- **Speicher (Order §§43/44)**: `navigator.storage.persist()` wird nach dem
  ersten Paketabruf angefragt (Ablehnung kein Fehler); `storage.estimate()`
  warnt ab 90 % Belegung oder unter 50 MB frei – keine künstliche GB-Grenze.
- **Lager-/Tabletmodus (Order §§46–52)**: `/tablet` mit vier großen Aktionen
  AUSGABE / RÜCKGABE / QR SCANNEN / REINIGUNG (optional Lager), pro Gerät
  aktivierbar (localStorage-Flag), reduzierte Navigation; reine Darstellung
  ohne Rechteerweiterung, keine Rolle, keine PIN. `/reinigung` zeigt Maschinen
  in Reinigung, länger als 24 h zuerst und rot.
- **Berechtigungen**: keine neuen Keys. Offline-relevanter Rechte-Snapshot
  nur für die Darstellung; jede Mutation wird serverseitig neu geprüft
  (`MUTATION_PERMISSIONS`), siehe `docs/PERMISSIONS.md` → „Offline“.
- **Entsperrter Schlüssel zwischen Navigationen (Order §§7, 38)**: Der DEK
  liegt nach der Entsperrung nur im Arbeitsspeicher – im Seitenkontext und
  als structured-clone im Speicher des Service Workers (`SET_KEY`/`GET_KEY`/
  `TOUCH_KEY`/`CLEAR_KEY`, nie in Cache, IndexedDB oder Storage). Ein Reload
  oder eine harte Navigation offline holt den Schlüssel per `MessageChannel`
  aus dem Worker und übernimmt ihn nur, wenn die Lease-HMAC mit genau
  diesem Schlüssel stimmt (fremder/alter Schlüssel ⇒ Sperrbildschirm). Der
  Worker verwirft ihn nach 15 Minuten ohne Aktivitätssignal (gleiche Frist
  wie die App-Sperre; `AuthGuard` meldet Aktivität gedrosselt weiter),
  bei `lock()`/Logout/Wipe sofort (Wipe entfernt zusätzlich aus dem Seiten-
  Shell-Cache `mr-pages-*` alle Einträge mit Datensatz-IDs in der URL; die
  ID-freien Shells bleiben, damit die App offline weiterhin startet), und
  beim Beenden des Workers durch den Browser ohnehin. Alternative „Schlüssel in sessionStorage/IndexedDB“ wurde
  verworfen: das wäre eine Klartext-Ablage des DEK auf dem Datenträger. Ohne
  aktiven Worker (erster Start, private Fenster) gilt schlicht die
  Passwort-Entsperrung.


- **Härtungen aus dem adversarialen Phase-8-Review (selbst verifiziert und
  umgesetzt)**:
  - *Unterbrochener Sync-Lauf*: Mutationen, die beim Schließen/Neuladen der
    Seite im Status „syncing“ zurückbleiben, werden beim nächsten Lauf erneut
    gesendet (serverseitige Quittungen machen die Wiederholung idempotent).
  - *Zweiphasige Quittung* (Migration 0016, Status `processing`): die Quittung
    wird VOR der Fachmutation reserviert. Ein Abbruch zwischen Fachmutation
    und Abschluss hinterlässt „processing“; eine Wiederholung derselben ID
    liefert dann 503 + `Retry-After` (Verarbeitung läuft, < 2 min) – nie eine
    stille zweite Ausführung (§28).
  - *Crash-Recovery* (Finalisierung §3, Migration 0017): Ist die
    „processing“-Quittung älter als 2 Minuten, prüft `OfflineSyncService.
    recover` operation-spezifisch, ob die Fachwirkung bereits existiert, und
    quittiert dann `applied` (dedupliziert, resultRef der bestehenden Wirkung,
    Hinweis „Bereits übernommen (Wiederaufnahme nach Unterbrechung)“); ist
    die Wirkung nicht nachweisbar, läuft die Mutation normal (reserve/execute/
    finish) – genau einmal. Nachweis je Typ: neu erzeugte Fachobjekte tragen
    die erzeugende Mutations-ID in `client_mutation_id` (partieller UNIQUE-
    Index auf `machine_damages`, `missing_accessory_cases`, `handover_photos`,
    `return_photos`, `damage_photos`, `handover_signatures`,
    `return_signatures`; die Domainservices nehmen dafür einen optionalen
    `operationId` entgegen, schreiben ihn und geben bei Replay die bestehende
    Zeile zurück, Online-Routen bleiben unverändert). Zustandsänderungen werden
    am Zielzustand erkannt (`handover.assign`: Slot trägt die Maschine;
    `prepare`: Slot vorbereitet; `check_machine`: geprüft; `item_quantity`:
    Ist == Erfassung; `recipient`/`returner`: Felder gleich; `return.accessory`/
    `cleanliness`/`actual_time`: Werte gleich). Finalisierungen und
    Reinigungsabschluss gelten nur dann als Wirkung dieser Mutation, wenn der
    Abschluss NACH der Reservierung der Quittung und durch denselben
    Benutzer erfolgte (`finalized_by`/`cleaned_by`, `finalized_at`/
    `cleaned_at`) – ein Abschluss durch eine andere Person läuft in die
    normale Bewertung (ALREADY_FINALIZED/NOT_IN_CLEANING). Lagerbewegungen
    entstehen so genau einmal, weil eine erkannte Finalisierung nie erneut
    finalisiert. Medien: Replays derselben Bytes werden schon vor dem Upload
    per SHA-256 je Kontext dedupliziert (kein zweites Fachobjekt, kein
    zweiter Storage-Upload); greift nur die `client_mutation_id`-Recovery im
    Domainservice, wird das bereits hochgeladene Duplikat sofort wieder
    gelöscht – ein verwaistes Storage-Objekt ist in jedem Fall harmlos
    (kein Fachbezug, keine Kundendaten im Schlüssel).
  - *Serialisierung je Kontext*: zwei Geräte, die denselben Vorgang gleichzeitig
    abschließen, laufen im Prozess nacheinander – das zweite sieht
    ALREADY_FINALIZED statt eines scheinbaren Erfolgs (§67). Mehrere API-
    Prozesse sichern die Exakt-einmal-Semantik weiterhin über die Advisory-
    Locks der Domainservices.
  - *Basisstand-Pflicht*: Mutationen ohne `baseVersion` werden abgelehnt
    (die Konfliktprüfungen §33 sind nicht abschaltbar); die getragene
    Erfassungszeit (`capturedAt`/`actualReturnAt`) unterliegt derselben
    Plausibilität wie Gerätezeit und Erstellzeit (nicht in der Zukunft,
    nicht älter als 72 h + Toleranz); beim Abschluss wird sie zur
    tatsächlichen Ausgabe-/Rückgabezeit. Weicht sie mehr als 15 Minuten von
    der Erstellzeit der Mutation ab (ein echter Client setzt beide im selben
    Moment), gilt das wie online als Zeitkorrektur und verlangt
    `handover.correct_actual_time` bzw. `return.correct_actual_time`
    (sonst `PERMISSION_REVOKED`) – ein manipulierter Client kann die Zeit
    nicht rückdatieren; eine Mutations-ID darf nicht für einen anderen
    Typ/Kontext wiederverwendet werden (§63).
  - *Session-Widerruf*: 401 beim Onlinekontakt (Health-Check, beliebiger
    API-Aufruf, Sync) sperrt den Offline-Arbeitsbereich sofort (§39) – Daten
    bleiben verschlüsselt erhalten. Der Sperrbildschirm nutzt bei erreichbarem
    Server immer den normalen Re-Auth-Weg (§7), lokal nur bei Netzausfall.
  - *Passwortwechsel*: Wrap A wird nach `/auth/password/change` sofort erneuert;
    bei einer Online-Anmeldung mit neuem Passwort wird der bestehende DEK vor
    der Lease-Erneuerung über das noch gültige Lease-Secret wiederhergestellt
    (keine Sperrschleife, keine Neuverschlüsselung mit Pending-Daten). Ist
    auch das Lease abgelaufen/widerrufen (Passwort-Reset während einer langen
    Offline-Phase) und liegen Pending-Daten vor, bleibt der Arbeitsbereich
    bewusst verschlossen: Der Sperrbildschirm erklärt das und bietet – nach
    serverseitig akzeptiertem Passwort und expliziter Bestätigung – „Lokale
    Offline-Erfassungen verwerfen und neu einrichten“ an (Order §38: nie
    still vernichten, aber auch keine Sackgasse). Ohne Verbindung öffnet
    weiterhin das bisherige Passwort (Wrap A).
  - *Client-Reihenfolge*: der Offline-Router ist ab Modulstart registriert und
    wartet auf eine laufende Initialisierung; der AuthGuard öffnet und
    entsperrt die Laufzeit VOR dem Rendern der Seiten (erster Datenabruf sieht
    lokale Pending-Daten); nicht offline modellierte Schreibrouten werden in
    Kontexten mit ausstehenden Änderungen abgewiesen („zuerst
    synchronisieren“); während eines Laufs eingereihte Mutationen lösen einen
    Folgelauf aus; die Verbindungserkennung startet den Sync bei jedem
    Offline→Online-Übergang (auch per 60-s-Prüfung).
  - *Paketabruf*: gleichzeitige Abrufe (automatisch + manuell) teilen sich
    einen Ingest – zwei verschränkte Ingests hätten sich gegenseitig als
    veraltet bereinigt; der Paketstand wird nach Reload aus dem Store gelesen
    (kein Neuabruf je Navigation); nach jedem Abruf werden die Seiten-Shells
    vorab gecacht.
  - *Konflikte in der Projektion*: konfliktierte Mutationen (und ihr
    Schadenfoto) gelten lokal nicht mehr als „angewendet“ – die Seite zeigt den
    Serverstand, die Konflikt-UI das offline Erfasste; „Serverstand laden“
    führt direkt in den Wizard des Vorgangs. „Verwerfen“ kaskadiert nur auf
    fachliche Kinder (Schadenfoto), reine Reihenfolge-Abhängigkeiten bleiben
    sendebereit.
  - *Absorption synchronisierter Mutationen* wird über die Serverzeit der
    Quittung entschieden (nicht über die Gerätezeit, §68).
  - *Knapper Bestand offline* (§24): keine Blockade, sondern starke Warnung im
    Wizard + Konfliktrisiko; der Server prüft den Bestand beim Sync.
  - *Service Worker*: `PREFETCH_PAGES` cacht nur `text/html` derselben Origin
    und nie `/api`; die Update-Aktivierung prüft Pending-Daten frisch aus
    IndexedDB. Rückgabemengen werden schon lokal gegen die ausgegebene Menge
    geprüft (§20); der Tabletmodus-Wechsel wirkt sofort in der Navigation;
    QR im Tabletmodus bietet auch den Ausgabe-Kontext an (§51); Speicher-
    warnung im Kopfbereich und nach jedem gespeicherten Medium (§43);
    Statusbezeichnungen SYNCHRONISIERUNG … / SYNCHRONISIERT (§40).
- **Phase-8-Finalisierung §2 – QR-Token nie im URL-Pfad**: Die QR-Auflösung
  läuft nur noch über `POST /staff/machines/qr/resolve` (Body `{ token }`,
  `machine.view`, neutrales 404 „Dieser QR-Code ist nicht gültig.“) und
  `POST /staff/returns/resolve-qr` (Body `{ token }`, `return.view` +
  `process.view_all` + Sichtbarkeit wie bisher). Die alten GET-Routen mit
  Token im Pfad sind entfernt – ein Rohtoken landet damit weder in Server-/
  Proxy-Zugriffslogs noch im Browserverlauf. Der Fastify-Request-Serializer
  gibt ausschließlich Methode + maskierten Pfad aus (nie Query, Header-
  Werte oder Bodies; `maskLoggedPath` bleibt als Schutz gegen Altpfade,
  der statische Routenname `resolve` bleibt lesbar); der Error-Handler
  loggt Datenbankfehler nur mit technischen Metadaten. Für Tests nimmt
  `buildApp` eine optionale `logDestination` (pino-Stream) entgegen; die
  Integrationstests fangen das Log auf Level `trace` auf und belegen, dass
  weder QR-Tokens noch Telefonnummern noch Unterschrift-/Fotobytes (roh,
  hex, base64) im Log erscheinen (`offline-hardening.integration.test.ts`).
- **Bewusst akzeptierte Restrisiken (dokumentiert, nicht gebaut)**: (0) Ein
  Abbruch zwischen Fach-Commit und Quittung erzeugt dank Crash-Recovery kein
  Duplikat mehr; verbleibende Unschärfe: zwei veraltete „processing“-
  Mutationen DESSELBEN Benutzers für denselben Abschluss (zwei Geräte) werden
  beide als „übernommen“ quittiert, weil der Abschluss nach beiden
  Reservierungen und durch denselben Benutzer erfolgte – fachlich korrekt
  (genau eine Finalisierung), nur die Zuordnung „welches Gerät hat
  gewonnen“ ist nicht mehr unterscheidbar. (1) entfällt seit der
  Finalisierung – offline geöffnete PDFs laufen im geschützten Viewer
  innerhalb der App-Sperre (siehe unten); (2) das Paket enthält die Preis-Snapshots der Lieferschein-
  positionen und die vorläufigen Kommissions-/Reinigungsbeträge, weil die
  bestehenden Wizards/Editoren sie anzeigen (§22 erlaubt die Anzeige, kein
  Client übermittelt Beträge als autoritativ; keine Settlement-, Kautions-,
  Gutschein- oder Admin-Daten); (3) Zwischenschritte zweier Geräte am selben
  Vorgang (Empfänger/Unterschrift) werden serverseitig mit Ersetzungssemantik
  angewendet – die Endkonsistenz entsteht an der Finalisierung (genau eine,
  das andere Gerät sieht den Konflikt, lokale Beweise bleiben); (4) die
  Update-Sperre ist je Tab, ein zweiter Tab desselben Geräts kann den neuen
  Worker aktivieren (IndexedDB-Migrationen sind additiv, Daten bleiben);
  (5) die Konfliktansicht zeigt je Konflikt Aktion, Erfassungszeit, die
  Gegenüberstellung „Offline erfasst / Serverstand / Was jetzt zu tun ist“
  (Finalisierung §4: nur die konfliktrelevanten Felder als Sätze, keine
  vollständige Feld-für-Feld-Tabelle) und die drei Handlungen „Serverstand
  laden & prüfen / Erneut anwenden / Verwerfen“ (Order §73); (6) die Fehlteil-
  Obergrenze (Soll-Deckel/-Tropfschalen) wird offline als UX-Vorprüfung aus
  dem Paket gespiegelt, die verbindliche Prüfung bleibt im `ReturnService`
  beim Sync.


- **Geschützter Offline-Dokument-Viewer (Finalisierung §5)**: `/dokumente/<id>`
  (optional `?booking=<bookingId>` für den Rücksprung) liegt wie alle Seiten
  im `AuthGuard`, entschlüsselt die Dokument-Bytes über die Laufzeit, zeigt
  sie als Blob-URL in einem `<iframe>` und widerruft die URL sofort beim
  Verlassen, bei `APP_LOCKED_EVENT` und bei gesperrter Laufzeit (gesperrt
  rendert der AuthGuard nur den Sperrbildschirm, die Seite unmountet, das
  Effekt-Cleanup revoziert). Keine Kopie der Klartextbytes in Cache/
  IndexedDB/localStorage, kein Download-Trigger, kein fremder Tab;
  `DocumentLink` navigiert offline per Router dorthin, online bleibt der
  Server-Link. Die HTML-Shells der Viewer-Routen werden mit dem Paket vorab
  gecacht (nur HTML, keine Bytes).
- **Offline-Suche (Finalisierung §6)**: `GET /staff/search` wird nur offline
  lokal beantwortet (online immer der Server): rein im Speicher über die
  entschlüsselten Buchungs-Snapshots und Maschinen des Pakets –
  Vorgangsnummer, Kundenname (`customer.name`) und Maschinencode, contains/
  case-insensitive; kein Suchindex, nichts persistiert (keine Klartext-
  Indizes, §5). Antwortform wie `SearchResults` des Servers plus
  `machines: [{ id, machineCode, status }]` und `offline: true`; die Seite
  zeigt Maschinentreffer und den Hinweis „Offline: Suche nur im geladenen
  Arbeitspaket“.
- **Abmelden mit Pending (Finalisierung §7)**: `window.confirm` ist durch
  einen zweistufigen In-App-Dialog ersetzt (Stufe 1 mit Zählern „X
  Erfassungen, Y Fotos/Unterschriften“ und „Zuerst synchronisieren
  (empfohlen)“ → `/sync`, „Abbrechen“, „Lokale Erfassungen verwerfen …“;
  Stufe 2 „Wirklich verwerfen? …“ mit „Ja, unwiderruflich verwerfen und
  abmelden“). Erst nach Stufe 2: Lease widerrufen, `wipe()`, `/auth/logout`.
  Ohne Pending direkter Logout; kein Timeout-Wipe. Der `rekey-refused`-Pfad
  des Sperrbildschirms nutzt dieselbe Stufe-2-Bestätigung. Zähler: offene +
  zu prüfende Mutationen und nicht hochgeladene Medien (Klartext-Metadaten,
  auch im gesperrten Zustand lesbar).
- **Offline-Override (Finalisierung §8)**: Die Assign-Route des Offline-
  Routers erlaubt einen Override nur, wenn der lokale Rechte-Snapshot
  `machine.override_block` enthält (sonst `FORBIDDEN` „Dafür fehlt dir die
  Berechtigung – online mit berechtigter Person klären.“), Grund bleibt
  Pflicht, `hardBlocked` nie; der Server prüft beim Sync erneut. Die
  Ausgabeseite zeigt offline dieselbe Override-Box wie online (Evaluate-
  Route liefert `overrideRequired`/`problems`).
- **E2E-Harness**: Die Staff-App läuft im E2E als Produktions-Build (`next
  build && next start`), weil der Turbopack-Dev-Server ohne HMR-Verbindung
  offline nicht hydratisiert. Playwright startet API, Web und Staff immer
  frisch (`reuseExistingServer: false`): ein liegengebliebener Server würde
  sonst unbemerkt alten Code testen. Die API-Ausgabe wird ins Testprotokoll
  geleitet; stockende Synchronisierungen protokollieren die Queue-Zeilen.
- **Bewusst offen (Deferred, Phase 8)**: Background Sync API (nur
  opportunistisch, nicht verlässlich), WebAuthn/Face ID-Entsperrung
  (Schlüsselmodell vorbereitet: zusätzlicher Wrap), Delta-Sync/Paket-Diffs,
  Offline-Zusatzpositionen/Abholperson, Offline-Löschen serverseitiger
  Schäden/Fehlteile, vollständige Feld-für-Feld-Konfliktvorschau (aktuell
  Gegenüberstellung der konfliktrelevanten Felder als Sätze + Serverstand-
  Link), RSC-Payload-Prefetch für
  nie besuchte Routen (Shell-Prefetch deckt die Paket-Vorgänge ab).
Shell cwd was reset to /home/user/Sparkoffer.de

## Phase 9: Abrechnung, Kommission, Nachbelastungen, Anzahlung/Kaution, Storno & Mock-Buchhaltung

- **Grundprinzip**: Die Endabrechnung entsteht ausschließlich aus
  eingefrorenen historischen Fakten (Buchungs-Snapshot, finaler
  Lieferschein, Phase-7-Rückgabefakten, Schaden-/Fehlteilentscheidungen,
  manuelle Nachbelastungen, erfasste Anzahlungen/angewendete Kaution).
  Aktuelle Produktpreise wirken nie auf alte Buchungen; Early Return ändert
  die Miete nicht. Geld ist Integer-Cent, Rechenregeln liegen nur in
  `@mietroyal/domain` (`settlement.ts`: `computeSettlementTotals`,
  `commissionChargeableQuantity`, `customerNoticeWaitUntil`,
  `calculateCancellation`); API und UI zeigen nur Ergebnisse. Keine
  implizite MwSt. (Payload-Feld `tax` reserviert für Phase 10).
- **Summenmodell**: fix = Miete + Lieferung − Rabatt (nie < 0), variabel =
  Kaufartikel (tatsächliche Ausgabe) + Kommissionsverbrauch (issued −
  returned unopened) + Reinigungsgebühr (Return-Fakt 75 € je Maschine),
  Nachbelastungen = Schaden/Fehlteil/Verspätung/manuell, Credits = aktive
  Anzahlungen + angewendete Kaution. `amount_due = max(0, brutto − credits)`,
  `overpayment = max(0, credits − brutto)` als separater Hinweis „Externe
  Rückzahlung/Verrechnung prüfen“ – nie eine negative Rechnung, keine
  Rückzahlung. Positionen tragen nur Beträge ≥ 0; die Richtung ergibt sich
  aus dem Typ (keine versteckten negativen Freitextpositionen).
- **Schema** (Migration 0018): `settlements`, `settlement_lines` (Unique je
  Quelle `(settlement_id, source_type, source_key)` = Idempotenz des
  Positionsaufbaus), `settlement_clarifications`, `settlement_customer_notices`,
  `accounting_transfers`, `booking_advance_payments`, `booking_security_deposits`
  (`applied_cents ≤ amount_cents` als DB-Check), `cancellations`
  (`fee_percent IN (0,50,100)`), `process_relations`. Optimistische Sperre
  über `version` plus Zeilensperren (`FOR UPDATE`) in jeder Mutation – keine
  Lost Updates bei gleichzeitigen Schadenkosten/Kautionsanwendungen.
- **Buchhaltungsgrenze**: genau ein `AccountingGateway`
  (`MockAccountingGateway` außerhalb von production, deterministische
  MOCK-Referenz; `DisabledAccountingGateway` in production: „Buchhaltungs-
  integration nicht konfiguriert“, nichts wird als übertragen markiert,
  kein Job, kein Endlos-Retry). `AccountingTransferService` ist die einzige
  Transfer-Boundary für Abrechnung UND Storno: `prepare()` friert den Payload
  (Lines, Summen, Kunden-/Rechnungsadress-Snapshot, Eventdatum,
  Idempotenzschlüssel, SHA-256-Hash) VOR dem ersten Versuch ein und ist
  idempotent; `execute()` hält die Transferzeile für die Dauer des
  Gateway-Aufrufs gesperrt (`SELECT … FOR UPDATE`): Doppelklick, paralleler
  Worker und Retry warten und sehen danach `succeeded` – genau eine externe
  Übertragung; ein Absturz während des Aufrufs rollt auf `pending` zurück,
  der Wiederholungsversuch nutzt denselben Schlüssel (Gateway-seitig
  idempotent). Fachliche Bedingungen werden im `recheck`-Hook INNERHALB der
  Sperre erneut geprüft (TOCTOU: Frist, Kundenrückmeldung, Betragsänderung,
  offene Klärungen, Prozessstatus). Fehlschläge speichern nur einen neutralen
  Fehlercode; Retry mit Backoff über die bestehende PostgreSQL-Queue
  (`settlement.accounting_transfer`, `cancellation.accounting_transfer`),
  keine neue Queue. Der Worker (`apps/worker`) registriert die Handler über
  `@mietroyal/api/jobs`; die API hält dieselben Handler in einem nicht
  gestarteten Runner nur für die Mock-Steuerung „fällige Jobs ausführen“.
- **Lock nach Transfer**: ab Vorbereitung der Übertragung
  (`accounting_transfer_id` gesetzt) und erst recht nach Erfolg sind
  Positionen, Beträge, Credits, Schaden-/Fehlteilkosten und Nachbelastungen
  unveränderlich (409 `SETTLEMENT_LOCKED`); es gibt keine „Zurückholen“-
  Funktion. Admin-Reopen (Phase-2-Funktion) lässt die Abrechnung gesperrt.
- **Zahlungsstatus/Referenz**: open/paid/overdue kommt von außen; Phase 9
  nur per Mock-Steuerung (`/staff/accounting/mock/*`: nicht in production –
  404 –, zusätzlich `system.settings`, Antworten tragen `mock: true`). Die
  externe Referenz ist nur mit `accounting.view_reference` (einziger neuer
  Rechte-Key) sichtbar; normale Mitarbeiter sehen Status, nie die Nummer.
  Kein Rechnungs-PDF, keine erfundene Lexware-Rechnungsnummer.
- **Kundeninformation & 24 h**: nur positive Schaden-/Fehlteilbelastungen
  erzwingen EINE kombinierte Kundeninformation (Reinigung, Verspätung,
  Nachbelastung nicht). Mitarbeiter gibt frei; erst der erfolgreiche
  Gateway-Aufruf (Outbox außerhalb von production; production blockiert)
  setzt `notice_sent_at` und `wait_until = +24 h` – nur einmal je
  Abrechnung. Der Auto-Transfer ist derselbe Queue-Job mit `run_at =
  wait_until` (kein Scanner, kein Cron-Sonderweg); Kundenrückmeldung,
  spätere Betragsänderung/Entfernung, „Jetzt freigeben“ und „Wie berechnet
  freigeben“ schalten auf manuelle Übertragung um (`manual_transfer_required`),
  der Job endet dann mit `skipped`.
- **Storno**: nur vor Ausgabe, in einer Transaktion mit denselben
  Zeilensperren wie die Übergabe-Finalisierung (Race: nie storniert UND
  ausgegeben). Satz nach Berlin-Kalendertagen (≥15 → 0 %, 7–14 → 50 %,
  0–6 → 100 %, vergangen wie 0), Basis = eingefrorene reguläre
  Maschinen-Listenpreise (`standardUnitPriceCents × Menge`, Rabatt/
  Sonderpreis/Lieferung/Kauf/Kommission egal), Gebühr kaufmännisch (half up)
  auf Cent gerundet (`floor((base × percent + 50) / 100)`). Client sendet nie
  Satz oder Basis. 0 % ⇒ „Storniert – ohne Rechnung“; sonst eine
  Transferzeile „Stornokosten gemäß Mietbedingungen – Vorgang MR-…“ mit
  Eventdatum/Basis/Satz/Betrag. Ressourcen werden sofort freigegeben
  (Termine, nicht ausgegebene Zuweisungen, reservierte Maschinen,
  Risikohinweise) – keine Lagerbewegung. Prozess bleibt `cancelled`;
  Folgevorgang kopiert nur den Kunden und wird über `process_relations`
  bidirektional verknüpft. `canceler_type = customer` ist vorbereitet, ohne
  öffentlichen Endpunkt.
- **Entscheidungen bei Regelkonflikten (dokumentiert, nicht erfunden)**:
  „Position entfernen“ nach versendeter Kundeninformation folgt
  DOMAIN_RULES („wenn sonst frei automatisch weiter“) und Order §33: kein
  Manuell-Flag, Frist läuft weiter, der Auto-Job überträgt den niedrigeren
  Betrag; entfällt die Notice-Pflicht ganz, ist die Abrechnung sofort
  bereit. „Wie berechnet freigeben“ nach Kundenrückmeldung folgt der
  Phase-9-Vorgabe §31 (bewusste manuelle Übertragung) – DOMAIN_RULES nennt
  hier noch „Auto-Lexware“; der Widerspruch ist im Phase-9-Bericht als
  offener Punkt geführt. „Betrag ändern“ ⇒ manuell (beide Quellen einig).
- **Zeilensperren im Storno**: processes/bookings werden mit `FOR NO KEY
  UPDATE` gesperrt, nicht `FOR UPDATE`: Die Übergabe-Finalisierung nimmt
  beim Einfügen von Dokumenten/Paketen FK-`KEY SHARE`-Sperren auf dieselben
  Zeilen – `FOR UPDATE` würde dort in einen Deadlock (40P01) statt in ein
  sauberes 409 laufen. `NO KEY UPDATE` serialisiert weiterhin mit allen
  Statusmutationen (ProcessService sperrt mit `FOR UPDATE`, das konfligiert)
  und folgt dem Muster von Handover-/SchedulingService. Blocker werden erst
  UNTER allen Sperren geprüft (Prozess, Buchung, Handover, Slots, Maschinen-
  Advisory-Locks, Termine) – Race-Test Storno vs. Finalisierung läuft
  mehrfach in beiden Startreihenfolgen.
- **Legacy-Storno-Route**: `POST /staff/processes/:id/cancel` bleibt für
  Vorgänge ohne Buchung (reiner Statuswechsel); mit bestätigter Buchung
  delegiert sie an den Storno-Pfad (zusätzlich `booking.cancel`), damit es
  keinen gebührenfreien Nebenweg gibt. Vorschau mit `booking.cancel` oder
  `settlement.view`. Bei Gebühr wird die Transferzeile mit eingefrorenem
  Payload immer angelegt (auch in production mit Provider `disabled`); nur
  der Job entfällt ohne konfigurierte Buchhaltung.
- **Datenminimierung**: Logs enthalten nur IDs, Status und Fehlercodes –
  keine Beträge mit Kundenbezug, keine Rechnungsadresse, keine
  Schadensbeschreibung, keine Zahlungsreferenzen.
- **Bewusst offen (Deferred, Phase 9)**: echter Buchhaltungs-Connector und
  Zahlungsstatus-Rückfluss (Phase 10), Steuerinformationen im Payload,
  Kunden-Storno-Endpunkt (`canceler_type = customer` vorbereitet),
  Gutschein-Hooks (Order §66), Mietverlängerung (§68), persistente Notiz
  zur Kundenrückmeldung (Schema ohne Spalte), Queue-Retry nach fehlge-
  schlagenem MANUELLEN Transfer (nur Auto-Jobs retryen; manuell erneut
  auslösbar), Admin-Information bei wiederholtem Transferfehler
  (DOMAIN_RULES „Admin informieren“ – Dead-Jobs sind in `integration_jobs`
  diagnostizierbar).

## Phase 10: Echte Lexware-Office-Integration

- **Quelle der Wahrheit**: Alle API-Annahmen stehen verifiziert in
  `docs/LEXWARE_API_NOTES.md` (Verifikationsdatum, Endpunkte, Berechtigungen,
  Einschränkungen). Lexware ist veränderlich – vor jedem Release erneut
  prüfen. Die alte lexoffice-Domain kommt im Code nicht vor; production
  verwendet fest `https://api.lexware.io`, `LEXWARE_BASE_URL` ist dort
  verboten (Tests/Fake nur außerhalb).
- **Providerwahl fail-closed** (`createAccountingGateway(config, lexware)`):
  production ⇒ `lexware` nur mit Key und aktivem Kontext, sonst `disabled`
  (nie Mock); demo ⇒ immer Mock (ein gesetzter Key ist ein
  Konfigurationsfehler); development/staging ⇒ Mock, Lexware nur per
  explizitem Opt-in (`LEXWARE_ENABLED=true`). `assertConfigsIsolated` lehnt
  denselben Lexware-Key in zwei Umgebungen ab. Der Key existiert nur in
  `config.lexware.apiKey` (nie DB, nie Antwort, Pino-Redaction für
  `apiKey`/`authorization`).
- **Ein Client, ein Limit**: `LexwareClient` ist der einzige fetch()-Ort
  (Bearer, JSON, Timeout, zod-validierte Antworten, neutrale Fehlerklassen
  `validation|unauthorized|forbidden|not_found|conflict|rate_limited|server|
  timeout|network|invalid_response`, Retry-After, Correlation-ID, Pfade mit
  maskierten IDs im Log). Retries entscheidet die Queue anhand `transient`.
  Das Lexware-Limit von 2 Requests/Sekunde gilt prozessübergreifend:
  `PostgresLexwareThrottle` reserviert in einer kurzen Transaktion
  (`lexware_rate_limit` FOR UPDATE) den nächsten Slot (≥ 500 ms Abstand) und
  wartet AUSSERHALB jeder Transaktion – API und Worker teilen sich so dieselbe
  Grenze ohne offene Business-Sperren.
- **Geld**: Lexware erwartet Dezimalbeträge; `money.ts` konvertiert
  Integer-Cent ⇄ Dezimalstring ohne Float-Arithmetik (JSON-Zahlen mit ≤ 2
  Nachkommastellen sind verlustfrei serialisierbar, gerechnet wird nie damit),
  lehnt mehr als zwei Nachkommastellen ab und rundet Steuer je Position
  kaufmännisch in Integer-Arithmetik. Summen werden vor dem Create lokal
  erwartet und nach dem Create gegen die Lexware-Antwort geprüft; Abweichung
  ⇒ `attention` (TOTAL_MISMATCH), nie stille Cent-Anpassung.
- **Steuern werden nicht erfunden**: `accounting_tax_config` je Kategorie
  (Behandlung, Satz in Basispunkten, `synthetic`-Kennzeichen) + globale
  Lexware-Steuerart in `system_settings`. Production blockiert jede Rechnung,
  solange eine Kategorie fehlt oder synthetisch ist; dev/test/demo dürfen
  klar markierte synthetische Werte setzen. Profil (`taxType`,
  `smallBusiness`) dient nur der Plausibilität.
- **Schema (Migration 0019)**: `lexware_integration_state` (eine Zeile je
  Umgebung: gepinnte organizationId, Status, Profilfelder ohne
  Personendaten, Webhook-Stand), `lexware_contact_mappings` (ein aktives
  Mapping je Kunde, ein Kunde je Lexware-Kontakt), `lexware_invoice_mappings`
  (je accounting_transfer: Rechnungs-ID, Nummer, Status, Fälligkeit, offener
  Betrag, Zahlungsstatus, `delivery_status` pending, stabiler
  `transfer_marker`), `lexware_webhook_events` (Fingerprint-Dedup),
  `lexware_rate_limit`, `accounting_tax_config`; `accounting_transfers`
  erhält `in_progress|outcome_unknown|attention`, Claim-Felder und einen
  versionierten Provider-Snapshot (v2), der den Phase-9-Snapshot nie ersetzt.
- **Webhook-Signatur**: offizieller Lexware-Public-Key (RSA-4096, PEM) im
  Code (`webhook-public-key.ts`, Quelle + Datum dokumentiert, per
  `LEXWARE_WEBHOOK_PUBLIC_KEY_PEM` für den Contract-Fake übersteuerbar);
  Verifikation RSA-SHA512 über die Rohbytes und – weil die Doku „ohne
  Whitespaces“ nennt – zusätzlich über die kompakt serialisierte Form; nie
  Vertrauen ohne gültige Signatur, danach organizationId-Abgleich, Allowlist,
  Dedup (SHA-256 aus organizationId|eventType|resourceId|eventDate), Job.
- **Contract-Fake statt echtem Account**: `FakeLexwareServer` simuliert die
  genutzten Endpunkte mit Pflichtfeldprüfung, read-only-Ablehnung,
  Draft-/Finalize-Semantik, voucherlist-`overdue` (transient), Payments,
  Event-Subscriptions (409 Duplikat, 406 unsichere Callback-URL), 2-Req/s-
  Limit, Fehlerinjektion und „Timeout nach erfolgreichem Create“. Der
  Quality-Gate läuft nie gegen einen echten Lexware-Account.
- **Zweiphasiger Transfer (Order §§32/59/60)**: `AccountingTransferService.execute()`
  delegiert beim Provider `lexware` an einen dreistufigen Pfad: Phase 1
  (kurze Transaktion, Transferzeile FOR UPDATE) prüft Hooks/Readiness
  (Verbindung gepinnt, Steuerkonfiguration vollständig und plausibel zum
  Profil, keine Anzahlungs-/Kautions-Credits, Kontakt eindeutig), friert den
  Provider-Snapshot v2 ein, beansprucht die Zeile (`in_progress`, Claim mit
  Ablauf) und legt das Rechnungs-Mapping mit stabilem Transfermarker an;
  Phase 2 läuft OHNE Datenbanksperre (Kontakt-Sync, Recovery, `POST
  /v1/invoices?finalize=true`, `GET invoice`, `GET payment`); Phase 3 commitet
  mit Claim-Fencing. Jeder Fehler nach dem abgesetzten Create ⇒
  `outcome_unknown` (Rechnungs-ID, falls bekannt, wird gemerkt); vor jedem
  erneuten Create läuft die Recovery (GET by ID bzw. Belegliste je Kontakt und
  Belegdatum ±1 Tag, Treffer nur bei Marker UND Bruttosumme; genau einer ⇒
  verbinden, keiner ⇒ Create, mehrere ⇒ `attention RECOVERY_AMBIGUOUS`).
  `outcome_unknown` wird erst verlassen, wenn eine Recovery abgeschlossen ist –
  auch bei gescheiterter Recovery, Blockern oder abgelaufenem Claim bleibt die
  Recovery-Pflicht erhalten (Review-Befund). Summen-Mismatch, Draft trotz
  finalize und Fremd-Claim ⇒ `attention` mit verbundener Rechnung, nie ein
  zweiter Create. Phase-9-Zeilen mit Provider `disabled` werden ohne zweite
  Zeile übernommen (externalReference leer, Schlüssel unverändert).
- **Kontakt-Sync**: ein aktives Mapping je Kunde, ein Kunde je
  Lexware-Kontakt (Unique je Organisation). Ohne Mapping: Suche über exakt
  normalisierte E-Mail und Name; nur bei E-Mail UND Person/Firma gleich wird
  automatisch verknüpft, sonst „Lexware-Kontakt prüfen“ (Admin wählt oder legt
  neu an). Create mit Claim vor dem HTTP-Aufruf (parallele Transfers erzeugen
  keinen Doppelkontakt), Unknown-Outcome-Recovery über die exakte Identität,
  ohne durchführbare Suche ⇒ Prüfung statt erneutem Create. PUT ist ein
  Merge über den aktuellen Remote-Kontakt (nur gepflegte Felder werden
  überschrieben), Basis ist immer der heutige Kundenstamm, nie ein
  Buchungs-Snapshot; die Rechnungsadresse im Beleg stammt ausschließlich aus
  dem eingefrorenen Accounting-Snapshot.
- **Webhooks/Reconcile**: Dedup und Job-Einreihung sind nicht in einer
  Transaktion (Queue auf eigener Verbindung); deshalb reiht eine erneute
  Zustellung desselben Events den Job mit demselben Idempotenzschlüssel
  nach. Reconcile prüft nur relevante Mappings (offen/überfällig, ohne
  dauerhafte Attention-Codes), Admin-Aktion mit kleinem Batch und
  Advisory-Lock, CLI bis 100 – kein Polling. Setup ohne Callback-URL
  verwirft keine eigenen Subscription-IDs.
- **Externe Änderung nach Übertragung**: Wird eine übertragene Rechnung in
  Lexware storniert (voided) oder gelöscht, bleibt der Settlement-Status
  `transferred` (Sperre, kein Retry, keine Neurechnung); nur das Status-Label
  und der Buchhaltungsblock zeigen „Buchhaltungsprüfung erforderlich“
  (Attention-Code `INVOICE_VOIDED`/`INVOICE_MISSING`), Zahlungsstatus bleibt
  unverändert. Die Auflösung ist ein manueller Buchhaltungsvorgang.
- **Preisbasis (offener Punkt)**: Die Phase-9-Beträge werden als
  NETTO-Beträge an Lexware übergeben (Steuerart net ⇒ `netAmount`, vatfree ⇒
  Satz 0, gross ⇒ `grossAmount`). MASTER_SPEC legt nicht fest, ob die
  Mietpreise netto oder brutto gelten – vor Produktivbetrieb mit der
  Buchhaltung entscheiden; die Steuerkonfiguration (`taxType`) bildet beides
  ab. Steuer wird je Steuersatz-Gruppe auf die Nettosumme gerechnet; die
  reale Lexware-Rundung ist nicht dokumentiert (Summenprüfung fail-closed).
- **Bewusst offen (Deferred, Phase 10)**: Anzahlungen/Kautionen auf der
  Lexware-Rechnung (Public API: Down-Payment-Invoices read-only ⇒
  fail-closed), Auflösung von Attention-Zeilen (nur manuell durch die
  Buchhaltung; keine Fachregel), Rechnungsversand (Phase 12), echte
  Key-Ablaufüberwachung (Lexware liefert kein Ablaufdatum), IP-Rate-Limit
  am Webhook-Endpunkt (Signaturprüfung vor jedem DB-Zugriff genügt vorerst),
  Nutzung von `Retry-After` im Queue-Backoff (Lexware dokumentiert den Header
  nicht), Live-Verifikation von Steuerrundung und Scope-Namen am Testaccount.

## Phase 11: Wiedermieter-Gutschein (Kern: Eligibility, Trigger, Code/Krypto, Versandvorbereitung)

- **Genau eine Gutscheinart, zentraler Service**: `apps/api/src/voucher/`
  (`VoucherService`) ist der einzige Ort für Entstehung, Validierung,
  Reservierung, Einlösung und Reaktivierung. Kein Coupon-/Kampagnen-/
  Guthaben-System; 20 % und 12 Kalendermonate sind serverseitige Konstanten
  aus `@mietroyal/domain` (`voucher.ts`), nie Client-Eingaben.
- **Eligibility (Order §§3–5, 47)**: `assessEligibility(settlementId)` prüft
  unter einer Sperre ALLE Bedingungen und liefert interne Gründe
  (`NO_BOOKING`, `PROCESS_CANCELLED`, `RETURN_NOT_FINALIZED`,
  `SETTLEMENT_NOT_TRANSFERRED`, `TRANSFER_NOT_SUCCEEDED`, `PAYMENT_NOT_PAID`,
  `CANCELLATION_EXISTS`, `DAMAGE_DOCUMENTED`, `POST_RETURN_WINDOW_OPEN`,
  `ALREADY_ISSUED`). Schadenfrei heißt: KEIN `machine_damages`-Datensatz zum
  Return (Rückgabe oder Nachtrag), unabhängig von Berechnung, Auflösung oder
  „nicht mehr aktuell“. Technische Defekte, Reinigungsgebühr, Fehlteile,
  Verspätung und manuelle Nachbelastungen sind kein Ausschluss. Das
  Nachtragsfenster gilt als offen, solange eine Maschine des Returns
  `status = cleaning` mit `cleaning_since` hat, ihr letzter finalisierter
  Return dieser Return ist und sie seitdem nicht erneut ausgegeben wurde
  (dieselbe Logik wie `damage-service.ts`). Stornorechnungen haben kein
  Settlement und erzeugen nie einen Gutschein; ein Storno der Buchung
  schließt den Gutschein aus.
- **Idempotente Entstehung (Order §§6, 10, 48)**: `ensureVoucherForSettlement`
  nimmt `pg_advisory_xact_lock(hashtext('voucher-ensure:'||settlementId))`,
  liest das Settlement `FOR SHARE`, prüft unter der Sperre und fügt mit
  `ON CONFLICT (origin_settlement_id) DO NOTHING` ein – UNIQUE als
  DB-Backstop. Ergebnis `created | exists | ineligible`; Logs enthalten nur
  IDs, Outcome und Gründe.
- **Trigger ohne Importzyklen (Order §7)**: Voucher importiert nichts aus
  lexware/, handover/ oder commerce/. `AccountingTransferService` erhält
  optionale `paymentStatusListeners`, die NACH dem Commit von
  `setPaymentStatus` (Mock-Steuerung, Webhook, Reconcile) und nach dem
  Lexware-Commit einer bereits bezahlten Rechnung aufgerufen werden.
  `MachineService` erhält einen optionalen `cleaningEndedListener`
  (Reinigungsabschluss, Statuswechsel aus der Reinigung, Neuausgabe – letztere
  innerhalb fremder Transaktion mit `runAt = +60 s`). Beide Listener reihen
  nur Jobs `voucher.eligibility_check` ein (Idempotenzschlüssel
  `voucher-eligibility:<settlementId>:paid:<transferId>` bzw.
  `…:cleaning:<machineId>:<endedAt>`); die Entscheidung trifft der Job über
  den Service. Komposition in `jobs/finance.ts` (`createVoucherTriggers`),
  verdrahtet in `app.ts` und `apps/worker/src/main.ts`. Kein Cron, kein
  künstlicher Zeit-Delay; Backfill `pnpm voucher:ensure`.
- **Code (Order §§11–12)**: `MR20` + 12 Zeichen aus einem Alphabet ohne
  0/O/1/I/L, erzeugt mit `crypto.randomInt` (≈ 59 Bit Entropie), nicht
  fortlaufend, ohne Bezug zu IDs/Kunde. Persistiert wird ausschließlich der
  SHA-256-Hash der kompakten Form plus die letzten vier Zeichen für die
  Maske `MR20-••••-••••-XXXX`. Eingabe wird normalisiert (case-insensitiv,
  Bindestriche/Leerzeichen), die Form bleibt streng. Fehler nach außen immer
  neutral (`VOUCHER_INVALID_MESSAGE`).
- **Versandkopie (Order §13)**: zusätzlich eine verschlüsselte temporäre Kopie
  `delivery_code_ciphertext` (AES-256-GCM, 12-Byte-Zufallsnonce, AAD =
  Gutschein-ID, base64 `iv|tag|ct`). Der Schlüssel wird per HKDF-SHA256 aus
  `AUTH_SECRET_KEY` mit eigenem Salt/Info (`mietroyal/voucher-delivery/v1`)
  abgeleitet – Purpose Separation gegenüber TOTP-Secrets und Offline-Leases,
  keine eigene Kryptografie. **Rotation von `AUTH_SECRET_KEY`**: noch nicht
  versendete Kopien werden unentschlüsselbar; Phase 12 muss das als
  Versandproblem melden (kein Datenverlust der Einlösbarkeit – der Hash bleibt
  gültig). Umgebungen mit verschiedenen Schlüsseln können einander Kopien
  nicht entschlüsseln (Env-Isolation).
- **Versandvorbereitung (Order §§15, 50, 51)**: Phase 11 setzt nur
  `delivery_status = pending` (UI „Versand ausstehend“, nie „gesendet“). Die
  Phase-12-Schnittstelle `VoucherDeliveryService` (`listPendingDeliveries`,
  `revealCodeForDelivery` – nur serverseitig –, `markDelivered`: sent,
  `delivered_at`, Kopie entfernt, Hash bleibt) hat KEINE Route. Kunde ohne
  E-Mail ⇒ Gutschein mit `delivery_problem_code = NO_EMAIL`, nichts erfunden.
- **Gültigkeit (Order §§16–17, 36, 40)**: `activated_at` = Erzeugung,
  `expires_at` = +12 Kalendermonate Europe/Berlin bei gleicher Wanduhrzeit
  (DST-sicher, Monatsende gekappt); Ablauf lazy (`now >= expires_at`),
  effektiver Status aus `voucherEffectiveStatus`. Einlösung speichert die
  exakte Restdauer in Sekunden; kostenloses Storno reaktiviert DENSELBEN
  Gutschein mit `expires_at = Stornozeit + Restdauer`.
- **Reservierung/Einlösung/Reaktivierung**: in der Transaktion des Aufrufers
  mit `FOR UPDATE` auf der Gutscheinzeile und `version`-Zähler;
  `releaseStaleReservation` gibt Reservierungen lazy frei, wenn das Angebot
  keine aktuelle gesendete, gültige Version (oder einen Entwurf) mit diesem
  Gutschein mehr hat; `reactivateForFreeCancellation` ist idempotent
  (Redemption einmalig markiert) und replay-sicher: ist der Gutschein nicht
  mehr `redeemed` oder existiert eine neuere Redemption, wird nur die alte
  Redemption markiert, der Gutschein bleibt unberührt (Order §§43–45).
- **Views/Rechte (Order §§52–56)**: `GET /staff/customers/:id` und
  `GET /staff/processes/:id` liefern `voucher` (Status, Label, Gültigkeit,
  maskierte Referenz, Versandstatus) unter den bestehenden Rechten
  (`customer.view` bzw. Vorgangssichtbarkeit) – nie Hash, Kopie oder
  Klartext; keine Gutschein-Routen, keine manuelle Erstellung/Verlängerung/
  Übertragung, kein Hard Delete. Offline-Sync kennt keine Gutschein-Mutation.
- **Review-Härtungen (adversarialer Review Phase 11)**: (1) Zahlungs-Trigger
  benachrichtigt nur bei echtem Statuswechsel, der Job-Schlüssel trägt den
  Wechselzeitpunkt – paid → overdue → paid prüft erneut, paid → paid nicht;
  (2) `markDeclined` wirkt nur auf die aktuelle, nicht ersetzte Version (eine
  superseded Version kann die Reservierung der Nachfolgeversion nicht
  freigeben); (3) Versionierung aus einem abgelaufenen/abgelehnten Angebot
  gibt die Reservierung frei – der Entwurf behält den Gutschein, erst der
  nächste Versand reserviert; (4) Einlösung in der letzten Sekunde vor Ablauf
  ⇒ 409 statt Serverfehler; (5) `ensureVoucherForSettlement` sperrt die
  Maschinen des Returns `FOR SHARE`, damit Nachtrags-Schaden und
  Reinigungsabschluss nicht zwischen Schadens- und Fensterprüfung fallen;
  (6) Kunden-/Vorgangsansicht zeigt eine Reservierung auf ein totes Angebot
  als „Aktiv“ (lazy, ohne Schreibzugriff); (7) `applyVoucher` prüft „bereits
  ein Gutschein angewendet“ vor der Code-Validierung (keine Rückschlüsse auf
  einen zweiten Code). (8, Phase 11 Final – ersetzt die frühere strengere
  Entscheidung „jeder Sonderpreis blockiert“): NUR ein Sonderpreis auf einer
  MASCHINEN-Position (auch 0 EUR) schließt den Gutschein aus. Sonderpreise auf
  Kaufartikeln (Mischkanister) und Kommissionsartikeln sowie der vereinbarte
  Lieferpreis bleiben mit dem Gutschein erlaubt, weil der Gutschein allein auf
  der Maschinenmiet-Zwischensumme rechnet und diese Positionen sie nicht
  berühren. Autoritative Stelle: `hasMachineSpecialPrice(lineItems)` in der
  Preisengine (Kind `machine` + Quelle `special` der SERVERSEITIG berechneten
  Positionen – nie der Client-lineKey). `priceOffer` wirft strukturell bei
  Gutschein + Maschinen-Sonderpreis (greift damit in Recompute, Versand und
  Versionierung); `applyVoucher` prüft per Probeberechnung ohne Gutschein,
  `setSpecialPrice` löst die Zielposition per Probeberechnung auf und blockiert
  bei gesetztem Gutschein nur `kind === 'machine'`. Gemischt ⇒ blockiert. Die
  Staff-UI sperrt bei aktivem Gutschein nur die Sonderpreis-Bedienung der
  Maschinenzeile (`special-price-blocked-by-voucher`).
- **Bewusst offen (Phase 11, Kern)**: Versand (Phase 12), Konfigurator
  (Phase 16); Hinweis zur Neuausgabe-Variante des Reinigungs-Triggers: eine
  Maschine in Reinigung ist fachlich nicht zuweisbar, der Pfad ist heute nur
  defensiv vorhanden.
- **Kein Klartextcode über stdout/CI-Logs (Phase 11 Final, Punkt 2)**: Das
  frühere Testskript `apps/api/scripts/e2e-voucher-reveal.ts` (gab den
  Klartextcode als JSON-Zeile auf stdout des Kindprozesses aus, damit die
  E2E-Spec ihn lesen konnte) ist vollständig entfernt – stdout eines
  Kindprozesses landet in CI-Protokollen. Die Phase-11-E2E-Spec erhält den
  Code jetzt ausschließlich IN-PROCESS: `tests/e2e/helpers/voucher.ts`
  (`revealVoucherCode`) importiert `decryptDeliveryCode` aus
  `apps/api/src/voucher/voucher-crypto.ts` direkt (Playwright transpiliert
  TS; das Modul hängt nur von `node:crypto` ab) und entschlüsselt die Spalte
  `delivery_code_ciphertext` des in Szenario A automatisch erzeugten
  Gutscheins mit dem Schlüssel der E2E-API (development-Default aus
  `packages/config/src/load-config.ts`, bzw. ein in der Shell gesetztes
  `AUTH_SECRET_KEY`, das die API ebenfalls erbt). Der Klartext lebt nur in
  einer Spec-Variablen und wird nur in das Eingabefeld getippt, das sich nach
  erfolgreichem Anwenden leert; Reporter ist `list`, Screenshots/Traces/Videos
  sind nicht konfiguriert. Verworfen: ein (Test-)HTTP-Endpunkt (wäre eine
  Produkt-Angriffsfläche), eine Klartextdatei, ein synthetischer Voucher per
  DB-Insert (Szenario A würde dann nicht mehr die echte Kette prüfen).
  `VoucherDeliveryService.revealCodeForDelivery` bleibt die serverinterne
  Phase-12-Boundary ohne Route und ohne Ausgabe. Nachweise: Integrationstests
  F16/F17/F19/F20 in `voucher-security.integration.test.ts` (API-Log über den
  In-Prozess-Jobrunner der API, Worker-Log mit eigenem `JobRunner`-Logger,
  Routentabelle `printRoutes` ohne reveal/code/vouchers-Pfad, kein
  Schreib-/stdout-Zugriff, Script existiert nicht), F21 = Delivery-Tests
  97–105 unverändert, F15/F18 = Voucher-E2E ohne Script.


## Phase 12 (mail): Outbox, Retry, outcome_unknown, Message-ID, Krypto v2

- **Outbox als Taktgeber, Queue als Zusteller.** Jede ausgehende E-Mail ist
  eine Zeile in `mail_deliveries` (Order §6). Fachservices schreiben die
  Zeile – gern in ihrer eigenen Transaktion (`MailOutbox.enqueue(input, tx)`)
  – und reihen NACH Commit den Job `mail.send` ein (`scheduleSend`, Key
  `mail.send:<deliveryId>`). Das Gateway (Nodemailer/SMTP) wird nur im Job
  aufgerufen, nie unter Zeilensperren (CLAUDE.md „Gateways nie in offenen
  Transaktionen“). Der Job beansprucht die Zeile per
  `UPDATE … WHERE status IN (pending, retry) RETURNING` (Claim); ohne Claim ist
  er ein No-op – at-least-once-Wiederholungen der Queue erzeugen keine zweite
  Mail. Eine seit > 15 min „sending“-Zeile (Worker-Absturz mitten im Versand)
  wird erneut aufgenommen.
- **Retry mit eigenem Backoff.** Transiente SMTP-Fehler (4xx, Verbindungs-/
  Timeout-Fehler vor DATA) setzen `retry`, `attempts + 1`,
  `next_attempt_at = now + 1 min × 2^(n−1)` (max. 6 h) und reihen einen NEUEN
  Job `mail.send:<id>:<attempt>` mit `runAt = next_attempt_at` ein; nach 8
  Versuchen `failed`. Permanente Fehler (5xx, abgelehnter Empfänger,
  Header-Injection) ⇒ `failed`. Die Job-Queue wiederholt selbst nur bei
  Infrastrukturfehlern (DB), nie wegen Gateway-Ergebnissen – so bleibt die
  Outbox die einzige Wahrheit über Versuche und Wartezeiten.
- **`outcome_unknown` statt Doppelversand.** Bricht die Verbindung NACH dem
  DATA-Kommando ab (Nodemailer `command === 'DATA'` ohne Antwortcode, Timeout,
  Socket-Fehler) oder wirft der Transport unerwartet, kann der Server die
  Mail bereits angenommen haben. Dann `outcome_unknown` ohne automatischen
  Retry (Order §9, Review „Duplicate Email nach Timeout“). Nur ein bewusstes
  „Erneut senden“ im Admin erzeugt eine NEUE Zustellung mit NEUER Message-ID
  (Key `<alt>:resend:<neueId>`); die alte Zeile bleibt als Nachweis. Dasselbe
  gilt für `failed` und konfigurationsbedingte Blockaden
  (`DEMO_NOT_WHITELISTED`, `MAIL_NOT_CONFIGURED`, `PUBLIC_WEB_BASE_URL_MISSING`).
- **Stabile Message-ID.** `<deliveryId@domain(MAIL_FROM_ADDRESS)>` wird beim
  Einreihen festgelegt und über alle Versuche derselben Zustellung
  wiederverwendet (Provider-Dedupe, Threading für Antworten via In-Reply-To/
  References). Keine Exactly-once-Behauptung.
- **Blockaden beim Einreihen sind kein Fehler.** Mail nicht konfiguriert
  (Gateway `disabled`), Demo-Empfänger nicht auf der Whitelist, fehlender/
  ungültiger Empfänger ⇒ `blocked` mit neutralem Grund; der Fachprozess
  (Rückgabe final, Rechnung gültig, Gutschein aktiv) läuft weiter (Order §3).
  Bestehende harte Versandblockaden bei bewusstem „An Kunde senden“ bleiben
  Sache der Fachmodule (z. B. `blockReasonFor()` vor der Aktion prüfen).
- **Vorlagen aus einem Block-Modell.** Jede Vorlage beschreibt Inhalt als
  neutrale Blöcke; daraus entstehen immer text/plain UND HTML. Der HTML-
  Renderer escaped jeden Text, verlinkt nur http(s)-URLs auf
  `MAIL_PUBLIC_WEB_BASE_URL`, kennt keine Bilder/Skripte/externen Ressourcen
  (kein Tracking, Order §9). Kontexte sind zod-validiert
  (`templates/contexts.ts`), Betreffe werden auf CR/LF geprüft, Gateways
  prüfen Betreff/Namen/Empfänger erneut (`HEADER_INJECTION`), Nodemailer
  erhält Adressobjekte statt zusammengesetzter Header.
- **Geheimnisse nur verschlüsselt.** Angebots-/Aktions-/Dokument-Token und
  Gutscheincodes stehen nie im Kontext (jsonb), sondern in
  `secret_payload_ciphertext` (AES-256-GCM v2, Purpose `mail-secret-payload`,
  AAD = env|purpose|deliveryId), werden nur im Job im Arbeitsspeicher
  entschlüsselt und nach `sent` gelöscht. Nicht entschlüsselbar ⇒ `blocked
  SECRET_UNDECRYPTABLE`.
- **Gutschein-Krypto v1 → v2 (Order §8).** Neue Versandkopien entstehen als
  `v2:<keyId>:<base64>` mit `COMMUNICATION_PAYLOAD_KEY`;
  `VoucherDeliveryService.revealCodeForDelivery` liest v2 (aktuell/Vorgänger)
  und Legacy v1 (AUTH_SECRET_KEY) und kapselt eine nicht aktuelle Kopie nach
  erfolgreichem Lesen sofort neu. `pnpm communication:rewrap-secrets`
  (`apps/api/src/communication/rewrap.ts`) hebt alle Kopien und offenen
  Mail-Payloads auf den aktuellen Schlüssel; nicht entschlüsselbare
  Gutscheinkopien erhalten `delivery_problem_code =
  DELIVERY_COPY_UNDECRYPTABLE` – Gutschein, Hash und Ciphertext bleiben
  unverändert (nie Codeänderung, auch nicht reserviert/eingelöst).
- **Gateway-Wahl je Umgebung.** `createOutboundMailGateway`: SMTP genau dann,
  wenn `config.mail.enabled` (vollständige SMTP-Daten), sonst `Disabled` –
  in jeder Umgebung inklusive demo (dort greift zusätzlich die Whitelist +
  `[DEMO]`-Betreff). `FakeMailGateway` existiert nur per Test-Injection;
  `buildApp`/`createCommunicationContext` lehnen ihn in production hart ab.
  TLS: `secure: true` (implizit) oder `requireTLS: true` (STARTTLS),
  `rejectUnauthorized` ist immer true und nicht konfigurierbar.
- **Logging.** Nur deliveryId/kind/status/neutraler Fehlercode. Pino-
  Redaction (`communication/logging.ts`) deckt SMTP-/IMAP-Passwörter,
  WhatsApp-Token/App-Secret, Push-Private-Key und Communication-Keys unter
  `config.*`, `*.config.*`, `*.*` ab (API und Worker).

## Phase 12 (push+calendar): Web Push, operative Push-Regeln, privater ICS-Feed

- **Gateway-Grenze.** `PushGateway.send(target, payload)` liefert nur
  `sent | gone | transient_error | permanent_error`. `WebPushGateway`
  (Bibliothek `web-push`, aes128gcm, VAPID-Details je Aufruf statt globalem
  `setVapidDetails`, TTL 3600 s) mappt 200/201 ⇒ sent, 404/410 ⇒ gone
  (RFC 8030 §7.3; 410 defensiv), 429/5xx/Netz ⇒ transient, 400/401/403/413 ⇒
  permanent. `createPushGateway(config)`: `push.enabled` (alle drei
  `PUSH_VAPID_*`) ⇒ WebPush, sonst `Disabled`; `FakePushGateway` nur per
  Test-Injection – `buildApp` lehnt ihn in production hart ab. Endpoint und
  Schlüssel (Capability-URL, RFC 8030 §8.3) erscheinen nie in Logs,
  Fehlermeldungen oder API-Antworten; die Geräteliste zeigt nur Label/Zeiten.
- **Subscription = User × Gerätesession.** `push_subscriptions` bindet
  Endpoint an `user_id` UND `session_id` der registrierenden Session.
  Logout/Revoke/Deaktivierung deaktivieren Subscriptions sofort über den
  `SessionLifecycleListener` der Auth (minimal-invasiver Hook in
  `StaffAuthService`; Listener können Login/Logout nie brechen); der
  Versandjob prüft zusätzlich lazy (User aktiv, Session nicht widerrufen) und
  deaktiviert als Backstop. `endpoint` ist UNIQUE: registriert ein anderer
  User denselben Browser-Endpoint, wird die Zeile ihm zugeordnet
  (`reassigned`, Zähler zurückgesetzt) – der alte User sieht/erreicht das
  Gerät nie wieder. Registrierung/Abmeldung braucht kein neues Recht (jede
  gültige Session, nur das eigene Gerät); Push gibt keine Daten frei.
- **Push-Outbox + Job.** `PushService.enqueue` schreibt genau eine Zeile je
  Idempotenzschlüssel in `push_deliveries` (UNIQUE ⇒ Dedupe) und reiht
  `push.send:<deliveryId>` (max. 5 Versuche) ein. Der Job sendet an alle
  aktiven Subscriptions des Empfängers: gone ⇒ Subscription `gone`,
  transient ⇒ Fehler ⇒ Queue-Retry (at-least-once; doppelte Anzeige fängt
  der Browser über den Notification-`tag`), Ende `sent` (≥ 1 Erfolg) oder
  `failed` (0 Geräte / alle permanent) mit Zählern.
- **Datenminimierung technisch erzwungen.** `buildPushPayload(input)` kennt
  nur geschlossene Eingaben (Vorgangsnummer im Format MR-YYYY-NNNN,
  Terminart, Vorgangs-ID); es gibt keinen freien Textparameter. Texte:
  „Termin in 1 Stunde / Abholung MR-2026-1234“, „Rückgabe überfällig /
  MR-… – in Miet-Royal prüfen“, „Maschinenkonflikt …“, „Neue Anmeldung von
  einem neuen Gerät – in Miet-Royal prüfen“ (bewusst OHNE Mitarbeitername –
  konservativ, Details stehen in der Mitarbeiterverwaltung), „Vertretung
  aktiv – in Miet-Royal prüfen“. `url` ist immer ein relativer Staff-Pfad
  (`/vorgaenge/<id>/termine`, `/mitarbeiter`, `/`); der Service Worker öffnet
  nur Same-Origin-Pfade.
- **Regeln (`PushRuleScanner.scanDue(now)`, aufgerufen vom zentralen
  `communication.scan_due`).** (a) 1 h vor Pickup/Delivery/Return
  (Vorlauf = Systemsetting `appointment_reminder_minutes`, Default 60) an die
  EFFEKTIVE Zuständigkeit inkl. Vertretung; Idempotenz über
  `appointment_reminders` (`push_1_hour`, Fingerprint =
  sha256(appointmentId|startAt|assignee)); Reschedule/Neuzuweisung ⇒ neuer
  Fingerprint ⇒ neuer Push, alte Zeile bleibt (no-op); ungeplante Termine nie;
  `appointments.reminder_sent_at` wird informativ gesetzt. (b)
  Vertretungsbeginn: Vertretungen mit Beginn in den letzten 24 h, die noch
  laufen – Schlüssel `push:substitution:<id>`. (c) Überfällige Rückgabe:
  `listDueOverdueAdminNotifications` (bestehende Incident-Definition), genau
  ein Push je Incident an alle aktiven Nutzer mit `calendar.view_all` ODER
  `employee.manage` (Planung/Admin), danach `admin_notified_at`. (d)
  Maschinenrisiko: offene `machine_risk_incidents` mit
  `admin_notification_due_at ≤ now` ⇒ ein Push, `follow_up_due_at = +6 h`;
  Follow-up genau einmal (`follow_up_sent_at`), nie mehr; Empfänger wie (c).
  (e) Neues Gerät: Sofort-Hook nach `session.new_device_login`
  (= erste Session eines Users mit bisher unbekanntem `device_label`) an
  Nutzer mit `employee.manage`; der Scan holt verpasste Ereignisse der letzten
  24 h mit demselben Schlüssel nach. (f) Reinigung > 24 h: bewusst kein Push;
  Touren existieren nicht (`tour.delay_risk` bleibt Grenzbegriff, kein
  PushKind).
- **ICS-Feed.** Token 32 Random-Bytes base64url (43 Zeichen), nur SHA-256 in
  `calendar_feed_tokens` (ein Token je User; Regenerate ersetzt den Hash ⇒
  alter Link sofort 404). Öffentliche Route `GET /public/calendar/<token>.ics`
  (`publicLimit(60)`, neutrales 404 für unbekannt/ungültig/inaktiven User,
  Pfad im Log maskiert `/public/calendar/***`, `Cache-Control: private,
  no-store`). Inhalt RFC 5545/7986: PRODID `-//Miet-Royal//Staff
  Calendar//DE`, METHOD:PUBLISH, NAME/X-WR-CALNAME „Miet-Royal – <Name>“,
  REFRESH-INTERVAL/X-PUBLISHED-TTL PT1H (Client bestimmt das Intervall),
  eingebettete VTIMEZONE Europe/Berlin (feste EU-Regeln), je effektivem
  Pickup/Delivery/Return (inkl. Vertretung, nur geplant, −30…+180 Tage) ein
  VEVENT mit UID `<appointmentId>@miet-royal`, DTSTAMP UTC,
  DTSTART/DTEND;TZID=Europe/Berlin (Ende = `end_at` oder +60 min),
  SEQUENCE = `appointments.version − 1` (RFC: Start 0, monoton – jede
  Mutation bumpt `version`), SUMMARY „Miet-Royal – Abholung MR-…“,
  DESCRIPTION = Terminart + Staff-Link, URL = Staff-Link; CRLF, Faltung
  ≤ 75 Oktette UTF-8-sicher, TEXT-Escaping. **Keine LOCATION** (Liefer-/
  Abholadresse ist Kundendatum; der Betriebsstandort wird nie öffentlich
  ausgespielt), keine VALARM, keine Namen/Telefon/Preise/Schäden/Notizen.
  Basis-URL der Links = Systemsetting `staff_app_base_url`; ohne Setting
  relative URL + Hinweis in der Antwort.
- **Service Worker.** `sw.js` erhält nur `push` (showNotification aus
  `{title, body, tag, url}`) und `notificationclick` (Fenster fokussieren/
  navigieren oder öffnen, nur Same-Origin-Pfade); Cache-/Offline-Logik und
  Schlüssel-Handling bleiben byte-identisch, keine API-Aufrufe im Worker.
  Registrierung nur aus einem Klick-Handler (`Notification.requestPermission`).

## Phase 12 (inbound): IMAP-Eingang, Konversation, Unmatched-Inbox, WhatsApp Cloud API

- **Inbound-Zuordnung ist konservativ und deterministisch.** Reihenfolge:
  (1) In-Reply-To, dann References gegen `mail_deliveries.message_id`
  (eigene Outbox) – mit und ohne spitze Klammern verglichen; (2) genau EINE
  Vorgangsnummer `MR-JJJJ-NNNN` in Betreff/Text UND Absender normalisiert ==
  `customers.email` des Vorgangskunden; (3) unmatched. Zwei Nummern, fremder
  Absender oder Nummer ohne Absenderabgleich ⇒ bewusst unmatched (Staff
  ordnet zu). Verworfen: Fuzzy-Matching über Namen/Domains (falsche
  Zuordnung wäre ein Datenschutzproblem).
- **E-Mail/WhatsApp autorisieren NIE Fachaktionen.** Inbound-Verarbeitung
  schreibt ausschließlich `conversation_messages`, `message_photos`,
  `inbound_mail_receipts`, `whatsapp_events`, `whatsapp_contacts`; der
  Vorgang bleibt unberührt (Tests 75/85/108 prüfen `updated_at`).
- **Dedupe dreifach, Restart-sicher.** UID-Tripel (mailbox+UIDVALIDITY+UID),
  Message-ID, Fingerprint (SHA-256 From|Date|Subject|Textanfang). `last_uid`
  wird je Nachricht erst nach erfolgreicher Verarbeitung fortgeschrieben;
  Fotos werden VOR der Transaktion unter dem vorab erzeugten
  Nachrichten-UUID hochgeladen (Unique-Rennen räumt Storage-Reste ab).
  UIDVALIDITY-Wechsel setzt den Zähler zurück; Belege fangen Duplikate.
  Kein UNSEEN-Zwang: Abruf über UID-Range, Mailbox read-only, nie `\Seen`,
  nie löschen.
- **HTML niemals rendern.** Eigener Tag-Stripper (Script/Style/Head samt
  Inhalt entfernt, alle Tags inkl. `<img>` entfernt, Entities dekodiert;
  `mailparser` mit `skipHtmlToText`, damit keine Link-/Bild-URLs in den Text
  wandern). Verworfen: html-to-text/sanitizer-Bibliotheken (mehr Angriffs-
  fläche, kein Mehrwert für reinen Text).
- **Bilder nur mit MIME UND Magic Bytes** (JPEG/PNG/WebP; E-Mail ≤ 8 MB,
  WhatsApp ≤ 5 MB nach Meta-Limit); SVG ist kein Bild (XSS-Vektor). Alles
  andere wird nie gespeichert, nur gezählt (`skippedAttachments`).
- **Poll-Job statt Scheduler-Framework.** `mail.inbound_poll` reiht sich
  selbst alle 2 Minuten mit Zeit-Bucket-Schlüssel ein (Folgejob ZUERST,
  damit ein Abruffehler die Kette nicht abreißt); `enqueueInboundPoll`
  beim Worker-Boot. Deaktivierte Quelle ⇒ No-op ohne Folgejob.
- **Konversation = Vorgangssichtbarkeit.** Dieselbe Hilfsfunktion wie
  routes/crm.ts/commerce.ts (`process.view_all` + `getVisibleProcess`,
  neutrales 404). Staff-Antwort per E-Mail: Empfänger ist IMMER die Kunden-
  E-Mail (kein Feld im Vertrag; Fremdfelder werden verworfen), Betreff aus
  der zentralen Vorlage `manual_customer_reply`, In-Reply-To = letzte
  eingehende Mail des Vorgangs; Outbox-Zeile und Konversationszeile in EINER
  Transaktion, `scheduleSend` erst nach Commit. Zustellstatus wird über
  `MailSentListener`/`MailFailedListener` der Outbox gespiegelt
  (`outcome_unknown` bleibt `queued` – kein falsches „failed“).
- **Retention-Hilfen** `deleteChatPhotosForProcess` (Storage + `deleted_at`)
  und `purgeChatTextForProcess` (body ''/subject NULL/`body_deleted_at`)
  sind idempotent und betreffen ausschließlich Kommunikationsdaten; der
  Cleanup-Job (Agent R) ruft sie.
- **WhatsApp: nur Meta Cloud API, Verträge nach Verifikation 2026-10-18**
  (docs/COMMUNICATION_INTEGRATIONS.md). Webhook-Signatur über die ROHEN
  Bytes (eigener Content-Type-Parser im eigenen Fastify-Scope wie beim
  Lexware-Webhook, 3 MB), `timingSafeEqual`, neutral 401; Verify-Token in
  konstanter Zeit. Verarbeitung idempotent im Request (Event-Zeile zuerst,
  UNIQUE wamid+event_type; fehlgeschlagene Events werden bei Metas
  Wiederholung erneut verarbeitet), Bilder asynchron über `whatsapp.media_fetch`
  (kein Download im Request – Media-URLs sind nur 5 min gültig, Retry holt
  neue). Nur Text + Bilder; alle anderen Typen als Hinweiszeile ohne Inhalt.
- **WhatsApp-Zuordnung:** Reply-Kontext vor Telefonnummer; Telefon nur bei
  genau EINEM Kunden UND genau EINEM aktiven Vorgang (`open`/`reopened` –
  abgeschlossene/stornierte zählen nicht). Kandidaten: wa_id, normalisiert,
  Variante 49→0 (dokumentiert, konservativ). Mehrdeutig ⇒ unmatched.
- **Service-Window serverseitig:** `whatsapp_contacts.last_inbound_at` + 24 h
  (Zeitstempel der Kundennachricht aus dem Webhook, nicht Empfangszeit);
  außerhalb 409 mit festem Hinweistext. Keine Templates, keine automatischen
  WhatsApp-Nachrichten – der Provider-Fehler 131047 wird zusätzlich als
  `WINDOW_CLOSED` (permanent) abgebildet. Sendeergebnisse landen als
  `whatsapp_events`-Zeile `send_result` (Code ohne Inhalt), Statuses
  (sent/delivered/read/failed) nur vorwärts.
- **Gateway-Wahl fail-closed:** production `live` oder `disabled` (nie Mock);
  demo immer Mock („DEMO / simuliert“, Config lehnt echte Werte ab);
  `buildApp` wirft bei injiziertem Fake/Mock in production. `fetch` ist im
  Cloud-API-Gateway injizierbar (Tests prüfen den Graph-Request ohne Netz).
- **Rechte:** Unmatched-Inbox unter `message.reply_customer` (siehe
  PERMISSIONS.md); WhatsApp-Antwort nur `whatsapp.reply`; keine neue
  Permission.

## Phase 12 (scan): Kunden-Erinnerungen, Terminänderung, Aktionslinks, Scheduler, Retention

- **Reminder-Zeitlogik (Order §17/§18).** Je Buchung zählt der erste
  kundenrelevante Übergabetermin (Pickup oder Delivery; geplant = `start_at`
  bzw. Fensterbeginn). `due_at = start_at − 7` bzw. `− 1` KALENDERTAG(E) in
  Europe/Berlin bei gleicher Wanduhrzeit (`addBerlinCalendarDays` in
  `packages/domain`, Schwester von `addBerlinCalendarMonths`; DST-Unit-Tests:
  167 h im März, 169 h im Oktober). Fällig, wenn `due_at ≤ now < start_at`,
  Termin `scheduled`, Vorgang `open|reopened`. **Kein Nachholen:** entstand die
  Buchung nach `due_at` (`bookings.created_at > due_at`) oder liegt `due_at`
  mehr als 6 h zurück (`REMINDER_TOLERANCE_MS` – deckt Worker-Ausfälle ab, ohne
  tagealte „Erinnerungen“ zu verschicken), wird die `appointment_reminders`-
  Zeile ohne Zustellung angelegt (Marker, idempotent). Ungeplante, stornierte
  und vergangene Termine erhalten nie eine Mail.
- **Fingerprint-Bindung (Order §19).** `fingerprint = sha256(appointmentId|kind|
  startAt-ISO)`, Outbox-Key `reminder:<kind>:<fingerprint>`. Reschedule ⇒ neuer
  Fingerprint ⇒ der neue Termin bekommt seine Mail, falls sein `due_at` noch
  offen ist; alte Zeilen/Zustellungen bleiben unverändert (nie doppelt). Die
  Reminder-Zeile wird ZUERST mit `ON CONFLICT DO NOTHING` in einer Transaktion
  geschrieben – nur der Gewinner reiht die Mail ein (Race zweier Scanner ⇒ genau
  ein Aktions-Token, genau eine Mail); `mail.send` wird nach Commit geplant.
  `sent_at` setzt ein MailSentListener.
- **Inhalt.** 7 Tage: Vorgang, Eventdatum, Terminart, Termin (+ Fensterende),
  Adresse, Rückgabe soweit geplant, Vorbereitungshinweise. 1 Tag: zusätzlich der
  Aktionslink (Pickup „Abholperson ändern“, Delivery „Kontakt vor Ort ändern“;
  Token nur in der verschlüsselten Secret-Payload). Abholadresse = Systemsetting
  `pickup_exact_address` (die bestätigte Adresse aus der AB; fehlt sie, entfällt
  die Zeile), Lieferadresse = `bookings.delivery_snapshot`. Kein Empfänger ⇒
  `blocked NO_RECIPIENT`, Zeile wird trotzdem angelegt.
- **Terminänderung (Order §19).** `POST /staff/appointments/:id/inform-customer`
  (`email.approve_prepared` + Terminsichtbarkeit) nur bei gesetztem
  `customer_info_required_at`; Outbox-Key `appointment_changed:<id>:<version>`
  (Doppelklick dedupliziert; erneute Verschiebung = neue Version = neue Mail
  möglich). Nach bestätigtem Versand setzt der Sent-Listener
  `customer_informed_at` und räumt `customer_info_required_at` nur ab, wenn die
  Terminversion unverändert ist (eine zwischenzeitliche weitere Änderung bleibt
  offen); `version` wird dabei bewusst NICHT erhöht (keine 409 für parallele
  Bearbeiter, ICS-SEQUENCE unverändert). **Vorheriger Termin:** die Phase-4-
  Verschiebung bewahrt den alten Wert nicht; die Mail nennt nur den neuen
  Termin (`oldAt = null`, Vorlage lässt „Bisher“ weg) – Client-Daten werden nie
  als „vorheriger Termin“ übernommen (siehe OPEN_ITEMS/Schema-Wunsch).
- **Aktionslinks (Order §20).** `CustomerActionLinkService`: 32 Random-Bytes
  base64url, nur SHA-256 in `customer_action_tokens`; Zweck ist Teil der
  Auflösung (Pickup-Token wirkt nie auf den Lieferkontakt); je Termin/Zweck ein
  aktiver Token (erneute Ausgabe widerruft); gültig bis exakt `start_at − 1 h`
  (`expires_at` bei Ausgabe UND serverseitiger Cutoff gegen den aktuellen
  Terminbeginn – ein vorgezogener Termin sperrt sofort, ein verschobener
  verlängert nicht; die neue 1-Tag-Mail bringt einen neuen Token). Öffentliche
  Routen `GET/POST /public/actions/:token` (`publicLimit(60)`/`(10)`,
  `Cache-Control: private, no-store`, Pfad im Log `/public/actions/***`):
  JEDER Fehlerfall – unbekannt, syntaktisch ungültig, abgelaufen, widerrufen,
  falscher Zweck, Cutoff, Termin/Vorgang storniert – liefert dasselbe neutrale
  404 (kein 400 für Token-Form, kein Orakel). Antwort datenminimiert
  (`purpose`, `processNumber`, `appointmentAt`, `appointmentEndAt`, `current`).
  Felder: Vor-/Nachname 1–80 Zeichen ohne Steuerzeichen, Telefon PFLICHT
  (Abholperson/Kontakt vor Ort muss erreichbar sein), normalisiert über
  `crm/normalize.ts` auf `+<6–20 Ziffern>`; Validierungsfehler 400 nur nach
  erfolgreicher Token-Auflösung. Ein Kontakt je Buchung und Art
  (`booking_customer_contacts`, Upsert) – „Phone-Löschung“ = vollständiges
  Überschreiben, keine Historie, keine Kopie, kein Audit-Detail mit Nummer.
  Staff-Sicht: `GET /staff/processes/:id/customer-contacts`.
- **Scheduler (Order §32/§37).** Ein Job `communication.scan_due` auf der
  bestehenden PG-Queue, alle 2 min: Worker-Boot reiht den aktuellen Bucket
  (`communication.scan_due:<Bucket-ISO>`) ein; jeder Lauf reiht ZUERST den
  nächsten Bucket (`runAt` = Bucket-Beginn) ein und ruft dann fehlertolerant
  nacheinander die `DueScanner` (Reminder 7d/1d, Push-Regeln `PushRuleScanner`,
  weitere Scanner einhängbar), den Outbox-Backstop (pending/retry mit fälligem
  `next_attempt_at` und > 5 min Karenz bzw. `sending` > 15 min ohne offenen
  `mail.send`-Job ⇒ Job `mail.send:<id>:backstop:<Bucket>`; der Handler ist ohne
  Claim ein No-op) und den Retention-Backstop (Chatfotos abgeschlossener
  Vorgänge bei jedem Lauf; Text-Retention täglich als Job
  `communication.cleanup_retention:<JJJJ-MM-TT>`). Scanner-Fehler werden nur mit
  Name/Code geloggt; die Kette reißt nie ab. Gleiche Handler im API-Runner
  (Mock-Steuerung/Tests: `ctx.scan.runOnce(now)`) und im Worker.
- **Retention (Order §25).** `ProcessService` erhält Nach-Commit-
  `ProcessCompletionListener`; der Abschluss reiht
  `communication.cleanup_retention:<processId>:photos:<completedAt>` ein
  (Zeitstempel im Schlüssel ⇒ Reopen + erneuter Abschluss läuft erneut).
  Gelöscht werden NUR `message_photos` (Storage + `deleted_at`); Dokumente,
  Übergabe-/Rückgabe-/Schadenfotos liegen in anderen Tabellen/Präfixen und
  werden nie berührt (Negativtest). Chattext: `body = ''`, `subject = NULL`,
  `body_deleted_at` 12 Kalendermonate (Berlin) nach `completed_at`, nur für
  `main_status = completed`. Reopen: nichts wird wiederhergestellt, neue
  Kommunikation läuft normal; erst der erneute Abschluss startet Foto-Lauf und
  Frist neu. Abschlüsse über den Abrechnungstransfer im Worker deckt der
  2-min-Backstop ab.


## Phase 12 (transactional): Transaktionsmails, Kundeninformation, Dokument-Link, Gutschein, Rechnung

- **Ein Weg für alle Transaktionsmails** (Order §§11–16): Fachservices reihen
  GENAU EINE Outbox-Zeile (`mail_deliveries`) in ihrer eigenen Transaktion ein
  (`enqueue(input, tx)`) und planen `mail.send` erst NACH dem Commit
  (`scheduleSend`). Kein Gateway-Aufruf unter Row-Locks mehr (AB, Notice,
  Storno liefen bis Phase 11 synchron in der Transaktion). Komposition:
  `createTransactionalMailModule` (apps/api/src/jobs/communication-transactional.ts)
  für API, Worker und Tests – Angebots-/AB-Gateway, Paket-/Notice-/Storno-
  Mailer, `CustomerDocumentLinkService`, Sent-/Failed-Listener, transienter
  Lexware-Rechnungsabruf; Jobs `voucher.delivery` und `invoice.delivery`.
- **Idempotenzschlüssel = Fachentität**: `offer:<offerVersionId>` (eine
  Version wird nur einmal versendet), `order_confirmation:<id>`,
  `handover_protocol:<handoverId>`, `return_protocol:<returnId>`,
  `settlement_notice:<noticeId>`, `cancellation_confirmation:<id>`,
  `voucher_delivery:<voucherId>`, `invoice_delivery:<lexwareInvoiceMappingId>`.
  Bewusste Wiederholung nach Fehlschlag (AB, Kundeninformation) hängt
  `:retry:<vorherigeDeliveryId>` an; der Outbox-Resend `:resend:<id>`. Die
  Listener lesen die Entität nur aus dem Präfix (`parseTransactionalKey`) –
  so erreichen auch manuelle Resends den Fachstatus. Alle Listener sind
  idempotent (Job-Wiederholung).
- **Fachstatus**: AB `approved → queued → sent | failed` (failed ⇒ erneute
  Sendeaktion); Paket `ready → queued → sent | failed` (ohne Kunden-E-Mail:
  Zustellung `blocked NO_RECIPIENT`, Paket `failed`); Stornobestätigung
  `prepared → queued → sent | failed | blocked`; Rechnung
  `invoice_delivery_status` an Abrechnung/Storno `pending → sent | failed |
  blocked`, `lexware_invoice_mappings.delivery_status` nur `pending → sent`
  (CHECK unverändert). Mailfehler rollen nie zurück: Übergabe/Rückgabe bleiben
  final, die Rechnung bleibt gültig, der Vorgang abgeschlossen (Order §3).
- **Angebot**: Der Klartext-Token existiert nur im Speicher des Versands und
  verschlüsselt in der Outbox-Payload (`secrets.offerToken`); nach `sent`
  löscht `mail.send` die Payload. `offer_deliveries` (Phase-5-Altbestand,
  Token dort schon maskiert) wird nicht mehr befüllt; `GET /staff/outbox`
  (system.settings) listet jetzt die Mail-Outbox (Felder `kind`, `recipient`
  kompatibel, nie Secrets/Kontext). Production ohne Mailweg: `assertConfigured`
  ⇒ CONFLICT VOR dem Einfrieren (wie bisher); außerhalb von production ohne
  SMTP: Zustellung `blocked MAIL_NOT_CONFIGURED`, sichtbar in der Outbox.
- **Kundeninformation (Schaden/Fehlteil)**: Freigabe = Einreihen (Notice
  `queued`, Dokument-Token ausgestellt, `approved_by/at`). `notice_sent_at`,
  `wait_until` (+24 h) und die Klärung „Kundeninformation“ setzt ERST der
  Sent-Listener mit der Versandzeit (`SettlementService.noticeMailSent`, nur
  wenn noch NULL). Mailfehler/Blockade ⇒ Notice `failed`/`blocked`, keine
  Frist, Transfer bleibt blockiert; erneute Freigabe erzeugt eine neue
  Zustellung. Ohne Mailweg (Gateway `disabled`) bleibt es bei
  `NOTICE_NOT_CONFIGURED` (409, Notice `blocked`). `SettlementNoticeGateway`
  und `AppOptions.noticeGateway` sind entfernt; der Worker-Transferjob braucht
  keinen Mailer (`notices: null`).
- **Customer Document Link** (Order §13): `customer_action_tokens` purpose
  `document_view`, 32 Byte base64url, nur SHA-256, gebunden an Vorgang/Kunde/
  Buchung und GENAU ein Dokument; Gültigkeit 90 Tage (Auftrag nennt keine
  Dauer – konservativ). `GET /public/documents/:token` (publicLimit 30/min,
  neutrales 404, `inline`, `no-store`, `nosniff`), Pfad in `maskLoggedPath`
  maskiert; Mail-Link `${MAIL_PUBLIC_WEB_BASE_URL}/dokument/<token>` (Web-
  Seite lädt die API-Route). Kein Storage-Link.
- **Gutschein**: `voucher.delivery:<voucherId>` nach Erzeugung (Eligibility-
  Job), Sweep `enqueuePendingVoucherDeliveries` (Zeit-Bucket-Schlüssel, nur
  Gutscheine ohne Zustellung) und Staff-Aktion `POST /staff/customers/:id/send-voucher` (Body `{ voucherId }`, Gutschein muss zum Kunden gehören)
  (customer.view + email.approve_prepared). Der Code steht nur in der
  verschlüsselten Outbox-Payload; Sent-Listener ⇒ `markDelivered` (Kopie
  gelöscht, Hash bleibt). Ohne E-Mail `NO_EMAIL`, nicht entschlüsselbar
  `DELIVERY_COPY_UNDECRYPTABLE` (kein Versand), Mailfehler `MAIL_FAILED` bzw.
  SMTP-Code – der Gutschein bleibt gültig. Mail deaktiviert ⇒ pending ohne
  Problemcode (Sweep versucht später erneut).
- **Rechnung**: Nach erfolgreicher Lexware-Rechnung (Abrechnung und Storno)
  reiht der Transfer-Service NACH dem Commit `invoice.delivery:<mappingId>`
  ein. Empfänger = eingefrorene Buchungs-E-Mail; Anhang `lexware_invoice`
  wird beim Versand über `client.getInvoiceFile` geholt und nur im Speicher
  gehalten (nie documents/Storage). Automatisch nie doppelt
  (`mail_delivery_id` am Mapping + UNIQUE Outbox-Schlüssel); manueller
  Resend über die Outbox (neue Message-ID).
- **Automatische Hintergrundmails nur bei explizit konfiguriertem Mailversand**:
  `voucher.delivery` und `invoice.delivery` (kein Staff-Klick) laufen nur, wenn
  `config.mail.enabled` (MAIL_ENABLED + vollständige SMTP-Daten) UND das
  Gateway nicht deaktiviert ist – in jeder echten Umgebung identisch mit „SMTP
  aktiv“ (Fake ist in production verboten), fail-closed, weil der Gutschein-
  versand die Versandkopie unwiderruflich löscht. Ohne Mailversand bleiben
  Gutschein/Rechnung „Versand ausstehend“; Nachholen über die Sweeps
  `enqueuePendingVoucherDeliveries` (in scan_due verdrahtet) und
  `enqueuePendingInvoiceDeliveries` (für scan_due bereitgestellt). Im
  Standard-Testkontext (FakeMailGateway ohne MAIL_ENABLED) bleibt damit der
  Phase-10/11-Zustand prüfbar; Phase-12-Tests setzen MAIL_ENABLED.
- **Test-Welt-Helfer**: `settleMailJobs` (apps/api/test/mail-job-helpers.ts)
  verarbeitet nach Angebotsversand/Finalisierung/Notice-Freigabe gezielt nur
  offene Outbox-Zustellungen (MailSendProcessor inkl. Listener) und entfernt
  die `mail.send`-Jobs – andere Jobs bleiben unberührt, damit die
  `runOnce()`-Erwartungen der Bestandstests weiter gelten. Hinweis:
  `JobRunner.drain()` verarbeitet bei nicht gestartetem Runner nur EINEN Job
  (`stopped` ist initial true) – Tests nutzen eine runOnce-Schleife.

## Phase 12 (UI): Staff-Kommunikation, Admin-Status, öffentliche Token-Seiten

- **Vorgang → Kommunikation** (`/vorgaenge/[id]/kommunikation`): chronologische
  Liste aus `GET /staff/processes/:id/conversation`; Texte ausschließlich als
  React-Text (`white-space: pre-wrap`), nie `dangerouslySetInnerHTML`;
  automatische Mails (`isSystemEvent`) als kompakte Ereigniszeile (Betreff +
  Zustellstatus, nie der interne `[kind]`-Body). Fotos werden per `fetch`
  (Session-Cookie, `no-store`) geladen und nur als Blob-URL gezeigt (beim
  Unmount widerrufen) – kein `<img src>` direkt auf die API, nichts im SW-Cache.
  Antwortformular ohne Empfängerfeld; Kanalwahl nur aus `canReplyEmail`/
  `canReplyWhatsApp` des Servers, WhatsApp-Option deaktiviert ohne offenes
  Service-Fenster (Text exakt laut Order §28), Mock-Kennzeichnung
  „DEMO / simuliert“ bei `whatsapp.mode === 'mock'`.
- **Vorgangsüberblick**: Karte „Kommunikation“ mit letzter Zustellung je
  Mailart (Labels aus der API: „Angebot – E-Mail gesendet“ …), vom Kunden
  gepflegter Abholperson-/Lieferkontakt und Einstieg in die Nachrichten.
  AB-/Storno-/Paket-/Kundeninfo-Zustände `queued`/`failed` werden ehrlich
  angezeigt („Versand eingeplant“/„Versand fehlgeschlagen“, nie „Versendet“
  vor bestätigtem Versand); `queued` blockiert die operative „Nächste Aktion“
  nicht, `failed` führt zu „Auftragsbestätigung erneut versenden“.
- **Nicht zugeordnet** (`/kommunikation/nicht-zugeordnet`, Navigation
  „Kommunikation“ nur mit `message.reply_customer`): Zuordnen über die
  bestehende `/staff/search` (nur sichtbare Vorgänge) mit Bestätigungsdialog,
  Ignorieren mit Bestätigungsdialog. Keine Mailbox-Funktionen.
- **Einstellungen → Kommunikation** (`/einstellungen/kommunikation`,
  `system.settings`): reine Statusseite (SMTP/IMAP/WhatsApp/Push), SMTP-Prüfung,
  letzte Zustellungen mit Statusfilter und „Erneut senden“ (Dialog, Warnung bei
  `outcome_unknown`). Neutrale Fehlercodes werden auf deutsche Texte
  abgebildet; der Code erscheint nur hier als „Diagnosecode“.
- **Terminänderung**: Button in der gemeinsamen Termin-Vorschau (Heute,
  Kalender, Terminplanung) nur mit `email.approve_prepared` und offener
  Kundeninformation; „Kunde informiert“ erst aus `customerInformedAt` (nach
  bestätigtem Versand), nie optimistisch.
- **Gutschein**: Problemtext (NO_EMAIL exakt laut Order §15) und
  „Gutschein jetzt senden“ (`customer.view` + `email.approve_prepared`, nur
  wenn der Server `canSendNow` meldet UND ein Versandproblem vorliegt – im
  Normalfall sendet der Server automatisch). Nie Klartext-Code.
- **Offline**: Kommunikationsaktionen sind Online-Aktionen – bei
  `connectivity === 'offline'` deaktiviert mit dem Text des Offline-Routers
  (`ONLINE_REQUIRED_MESSAGE`); der Router lehnt sie zusätzlich ab.
- **apps/web** `/kontakt/[token]` und `/dokument/[token]`: Client-Seiten über
  den bestehenden `/api`-Proxy, neutral „Dieser Link ist nicht verfügbar.“ bei
  jedem Fehler; nur Vorgangsnummer/Terminart/-zeit (Europe/Berlin) bzw. das
  PDF als Blob-Einbettung. Segment-Metadaten `noindex` + `referrer: no-referrer`,
  in `next.config.ts` zusätzlich `Cache-Control: private, no-store`,
  `X-Robots-Tag`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

<!-- Phase 12 (Härtung Review A) -->
## Phase 12 Härtung (Review A)

Reproduzierte Funde aus Review A, behoben und als Regressionstests in
`apps/api/test/communication-hardening-{smtp,config,outbox,inbound,transactional,public-links}.(integration.)test.ts`
(Fund-ID im Testnamen). RA-2/RA-5/RA-13 (hängendes `sending`, Erinnerung im
Retry nach Terminänderung, Demo-Whitelist beim Versand) liegen in
`send-job.ts` und sind in `communication-hardening-mail.integration.test.ts`
abgedeckt.

- **RA-1 SMTP-Klassifikation** (`mail/gateways.ts`): Nodemailer 10.1.6 meldet
  Socket-Timeout, Socket-Fehler und Abbruch einer bestehenden Sitzung immer mit
  `command: 'CONN'` – auch nach vollständig übertragenem DATA (im installierten
  `smtp-connection` geprüft und mit echtem Nodemailer gegen einen lokalen
  Mini-SMTP-Server reproduziert). Entscheidung: ohne Antwortcode ist ein Fehler
  nur bei POSITIVEM Nachweis „vor der Sitzung“ transient (`timeoutType`
  CONNECT/GREETING/UPGRADE, EDNS, ETLS, EPROXY, Aufbau-Systemcode bzw.
  `syscall` connect/getaddrinfo, Zertifikatsfehler, Kommandos vor MAIL FROM);
  alles andere ⇒ `unknown` ⇒ `outcome_unknown`. Ein Abbruch vor dem Greeting
  ist von einem Abbruch nach DATA nicht unterscheidbar und wird bewusst
  konservativ als unklar behandelt (kein eigenes Socket-Signal: dafür müsste
  die Verbindung außerhalb von Nodemailer aufgebaut werden). Fail-safe: fehlt
  ein Signal, entsteht nie ein automatischer Retry.
- **RA-3 Resend idempotent** (`mail/outbox.ts`): Quelle `FOR UPDATE` in einer
  Transaktion, Schlüssel `<alt>:resend:<quell-id>` ⇒ zweiter Resend 409;
  Resend einer Resend-Zustellung bleibt möglich. Zusätzlich „überholte
  Quelle“: existiert für dasselbe Fachobjekt (Präfix `<art>:<id>`) eine neuere
  laufende/versendete/unklare Zustellung ⇒ 409 (kein Gutscheincode an eine alte,
  falsche Adresse). Listen liefern `resentDeliveryId`, `resendable` ist dann false.
- **RA-4 Rewrap** (`communication/rewrap.ts`): alle Payloads außer `sent`;
  nicht entschlüsselbar ⇒ nur pending/retry werden `blocked`, andere Status
  bleiben (eine unklare Zustellung wird nie umgedeutet).
- **RA-6 Fingerprint** (`inbound/content.ts`, `processor.ts`): Dedupe per
  Fingerprint nur ohne Message-ID; Material = From|Date|Subject|gesamter Text|
  Anhang-Hashes, ohne Date zusätzlich Mailbox/UIDVALIDITY/UID. Mit Message-ID
  wird ein eigener Namensraum `message-id|<id>` gespeichert, weil die Spalte
  NOT NULL + UNIQUE ist (keine Schemaänderung nötig). Bestehende Belege
  behalten ihren alten Fingerprint; nach dem Update werden nur noch exakte
  Duplikate ohne Message-ID erkannt (bewusst).
- **RA-10 Poison Message**: Steuerzeichen in Body/Betreff/Absender/Adresse/
  Message-IDs werden entfernt (Dateinamen werden nicht gespeichert – nur
  generierte Storage-Keys). Je Nachricht `try/catch` in `pollOnce`: nur
  positiv erkannte Datenfehler (SQLSTATE 22/23 außer 23505, unlesbares MIME)
  ⇒ Beleg `rejected` + `match_reason = quarantined:<code>` (vorhandener
  Enum-Wert, keine Migration), lastUid weiter; alles andere wirft wie bisher
  (fail-safe: eine unbekannte Fehlerart blockiert lieber, als Mails zu
  überspringen). JobRunner (`packages/integrations`): `last_error`/Log nur
  `Klasse [Code]: erste Zeile` (≤ 500 Zeichen, ohne Steuerzeichen); Drizzle-
  Parameter (Zeile 2) und Meldungen roher pg-Fehler werden nie gespeichert (H3).
- **RA-8 Angebotsmail**: Satz „PDF im Anhang“ ersetzt durch „Über den Link
  kannst du das Angebot ansehen und als PDF herunterladen.“ (die öffentliche
  Angebotsseite bietet den PDF-Download; Ansprache „du“ wie alle Vorlagen),
  Vorlagenversion `offer` = 2.
- **RA-9/H6 Gutschein** (`voucher/voucher-delivery.ts` `voucherSendNowState`
  als einzige Regel für Profil, Route und Job): neue Zustellung
  `voucher_delivery:<id>:retry:<prev>` an die AKTUELLE Kundenadresse nur
  nach `failed`/`blocked` und nur über die bewusste Staff-Aktion (Job-Payload
  `retryOfDeliveryId`); laufend/unklar ⇒ 409, `canSendNow=false`,
  `sendNowBlock` (neutraler Code). Abgelaufene Gutscheine (`isVoucherExpired`
  aus `@mietroyal/domain`) werden weder vom Job noch vom Sweep noch über die
  Route versendet (`VOUCHER_EXPIRED`).
- **RA-11** (`packages/config`): `MAIL_PUBLIC_WEB_BASE_URL` außerhalb von
  development Pflicht bei `MAIL_ENABLED=true`.
- **RA-12 outcome_unknown** (`transactional/listeners.ts`,
  `settlement-service.ts noticeMailFailed`): kein Spiegeln als `failed`; der
  Fachstatus bleibt `queued`, die normale Sendeaktion ist gesperrt; erneutes
  Senden nur über die Admin-Outbox, deren Zustellung über das Schlüsselpräfix
  das Fachobjekt erreicht. Gutschein: nur Problemcode.
- **RA-14 Konversation** (`conversation/outbox-listener.ts`): automatische
  Mails mit Vorgang (außer `manual_customer_reply`) ⇒ `recordOutboundSystemEvent`
  bei `sent` und bei `failed`/`blocked`/`outcome_unknown` (Zustand gespiegelt,
  unklar bleibt „queued“), idempotent je Zustellung.
- **RA-15 Dedupe-Status** (`MailEnqueueResult.existingStatus`,
  `MailOutboxService.enqueueRetryingFailed`, `transactionalStatusOf`): der
  echte Status einer vorhandenen Zeile wird nie als „pending“ verschleiert;
  bewusste Wiederholung nach `failed`/`blocked` ⇒ `<key>:retry:<vorherige>`
  (Kette deterministisch, Doppelklick ⇒ dieselbe Zeile). Genutzt von der
  Stornobestätigung (AB/Kundeninformation hatten den Retry-Schlüssel bereits);
  die Terminänderungsmail (`informCustomer`) wird zentral nachgezogen.
- **H7**: vor der Transaktion hochgeladene Inbound-Fotos werden bei jedem
  Fehlschlag (nicht nur Unique-Konflikt) wieder gelöscht, ebenso Teil-Uploads.
- **H8**: Betrieb hinter Proxy (`API_TRUST_PROXY_HOPS`, Maskierung der
  Token-Pfade in Proxy-Access-Logs) in DEPLOYMENT_NOTES.md.

## Phase 12 Härtung (Review B)

Reproduzierte Funde aus Review B, behoben und als Regressionstests in
`apps/api/test/communication-hardening-{whatsapp,scheduler,retention,push,calendar}.integration.test.ts`
(Fund-ID im Testnamen; die Reviewer-Dateien `review-b-*` sind darin aufgegangen).

- **B16 ICS-Link** (`calendar/feed-service.ts` `feedPath`): Die Staff-App
  leitet nur `/api/:path*` an die API weiter und streift `/api` ab
  (`apps/staff/next.config.ts`). Der ausgegebene Link lautet daher
  `<Staff-Basis-URL>/api/public/calendar/<token>.ics` (ohne Basis-URL relativ
  `/api/public/calendar/…`); die API-Route bleibt `/public/calendar/:file`.
  `maskLoggedPath` ist nicht verankert und maskiert beide Pfadformen. Der Test
  wendet die echte Rewrite-Regel aus `next.config.ts` auf den Link an.
- **B12 Rechteentzug** (`resolveToken`): zusätzlich zu „Nutzer aktiv“ wird das
  effektive Recht `calendar.view` frisch über `StaffAuthService.effectivePermissions`
  geprüft; ohne Recht neutral 404 (wie unbekannter Token), bei erneuter
  Vergabe gilt derselbe Link wieder (kein Token-Widerruf – Regenerate bleibt
  die bewusste Aktion).
- **B6 Scheduler-Kette** (`communication/chain-bucket.ts`, `scan-due.ts`,
  `inbound/poll-job.ts`): Folge-Bucket = max(Payload-Bucket + 2 min, Bucket
  nach `now`) – der Bucket steht bereits im Payload; eine wenige ms
  nachgehende Worker-Uhr re-enqueued so nie mehr den eigenen (für immer
  UNIQUE) Schlüssel. Zusätzlich **Ketten-Watchdog** im Worker
  (`startChainWatchdog`, 60 s): ruft `enqueueScanDue`/`enqueueInboundPoll`
  für den AKTUELLEN Bucket (ein `INSERT … ON CONFLICT DO NOTHING`). Doppelketten
  entstehen nicht: je Bucket existiert genau ein Schlüssel, und jeder Lauf
  reiht mindestens den Bucket nach `now` ein – parallele Ketten laufen
  spätestens im nächsten Bucket zusammen (Test B6d).
- **B7 = RA-5 Pre-Send-Guard** (`mail/send-job.ts` `MailPreSendGuard`,
  registriert über `CommunicationContext.addMailPreSendGuard`): generischer
  Hook unmittelbar vor dem Versand, ohne Fachlogik im Job. `null` ⇒ senden,
  sonst `blocked` mit Code; wirft der Guard ⇒ Retry (`PRE_SEND_CHECK_FAILED`),
  nie Versand ohne Prüfung. Guards: Erinnerungen (`ReminderService.preSendGuard`:
  Reminder-Zeile über Fingerprint aus dem Schlüssel – auch für Resends –,
  Termin `scheduled`, noch nicht begonnen, Vorgang `open|reopened`,
  Fingerprint = aktueller `startAt`; sonst `STALE_APPOINTMENT`),
  Terminänderung (`AppointmentCustomerInfoService.preSendGuard`: dieselbe
  Bedingung wie `informCustomer` – Termin geplant, Vorgang nicht storniert;
  eine erneute Verschiebung blockiert nicht, der Sent-Listener behandelt
  abweichende Versionen), Angebot (`commerce/offer-mail-guard.ts`:
  `effectiveStatus` der Version = `superseded` ⇒ `SUPERSEDED`; nicht
  zuordenbare Zustellungen werden nicht blockiert). Der Aktionslink der
  1-Tag-Erinnerung wird nicht zusätzlich geprüft (eigene Cutoff-Prüfung).
- **RA-2 hängendes `sending`**: nicht mehr erneut gesendet, sondern atomar
  `outcome_unknown` mit `SENDING_STALE` (Fehler-Listener wie bei unknown); der
  Outbox-Backstop plant dafür weiterhin den Job. **RA-13**: unmittelbar vor
  dem Versand dieselbe Prüfung wie beim Einreihen (`MailOutboxService.blockReasonFor`,
  u. a. Demo-Whitelist, Mailweg deaktiviert) ⇒ `blocked` mit dem Code.
- **B1 WhatsApp-Event atomar** (`whatsapp/webhook-service.ts`): Event-Zeile,
  Kontakt, Konversationszeile und Ergebnis in EINER Transaktion; Fehler ⇒
  Rollback ⇒ Metas Wiederholung (nach Nicht-200) verarbeitet neu. Parallele
  Zustellungen warten am UNIQUE-Index. Altbestand (`failed` bzw. `queued` ohne
  Ergebnis älter als 2 min) wird bei Wiederholung verarbeitet. Media-Job nach
  Commit; Duplikate eines verarbeiteten Bildes reihen ihn dedupliziert erneut
  ein (Absturz zwischen Commit und Einreihen). Status-Events ebenfalls atomar.
- **B13** `metadata.phone_number_id` ≠ `WHATSAPP_PHONE_NUMBER_ID` ⇒ Event
  `ignored` (`PHONE_NUMBER_MISMATCH`), keine Konversation/kein Kontakt, 200 an
  Meta. **B2** `last_inbound_at = GREATEST(alt, neu)`.
- **B3 WhatsApp-`unknown`** (`WhatsAppSendOutcome` um `unknown` erweitert):
  Ausnahme beim Senden ist nur transient, wenn ein Fehlercode (auch in
  `cause`) nachweislich VOR dem Absenden liegt (ECONNREFUSED, ENOTFOUND,
  EAI_AGAIN, …UNREACH, UND_ERR_CONNECT_TIMEOUT, Zertifikatsfehler); Abbruch/
  Timeout/Verbindungsabbruch ⇒ `unknown` ⇒ Nachricht `failed` mit
  `OUTCOME_UNKNOWN`, kein Auto-Retry (Staff sendet bewusst neu). Ein Timeout
  während des Verbindungsaufbaus ist davon nicht unterscheidbar und wird
  konservativ als unklar behandelt.
- **B4 Media-Download**: Bearer-Token nur an erlaubte Hosts
  (`WHATSAPP_MEDIA_DOWNLOAD_HOSTS` = `lookaside.fbsbx.com` – nicht amtlich
  verifiziert – plus Host der Graph-Basis-URL; development mit Fake-Basis-URL
  zusätzlich localhost/127.0.0.1/[::1]); `redirect: 'error'`; Content-Length
  vorab, Stream mit 5-MB-Limit (Timeout umfasst das Lesen).
- **B5**: `media_fetch` bricht ab, wenn für die Nachricht irgendeine (auch
  gelöschte) Fotozeile existiert oder der Vorgang abgeschlossen ist.
- **B15 Retention**: `deletedAt` erst nach erfolgreichem Storage-Löschen
  (`StorageObjectNotFoundError` = Erfolg); Fehler ⇒ Zeile bleibt, Backstop
  (scan_due) wiederholt; Log nur `processId`/Anzahl/Fehlerklasse.
- **B10 Push-Endpoint-Allowlist** (`push/endpoint-policy.ts` `checkPushEndpoint`,
  eine Regel für Route UND `WebPushGateway`): überall https ohne Zugangsdaten;
  production/staging/demo nur bekannte Push-Dienste (`fcm.googleapis.com`,
  `updates.push.services.mozilla.com`, `web.push.apple.com`,
  `*.notify.windows.com`, `*.push.apple.com` – Liste aus den Push-Diensten
  der gängigen Browser, NICHT amtlich verifiziert), Port 443, keine IP-Literale
  (damit keine privaten/Loopback-/Link-local-Ziele); development ohne weitere
  Einschränkung (lokale Fakes, E2E `https://localhost:<port>`). Route ⇒ 400
  `PUSH_ENDPOINT_NOT_ALLOWED`; das Gateway prüft vor jedem Versand erneut
  (Altbestand) ⇒ `permanent_error`, Subscription `endpoint_not_allowed`.
  web-push folgt keinen Redirects (`https.request`, 3xx ⇒ permanent).
- **B11**: `isSessionExpiredByInactivity`/`sessionInactivityCutoff`
  (`auth/service.ts`) sind die EINE Inaktivitätsregel – `authenticate` und
  die Push-Ziele (`activeTargetsForUser`, `hasActiveSubscription`,
  `countActive`) nutzen sie; abgelaufene Sessions ⇒ `session_expired`.
- **B14 1h-Push**: erst Push-Zustellung (+ Job, Schlüssel je Fingerprint),
  dann Reminder-Marke + `reminderSentAt` in einer Transaktion; Absturz
  dazwischen ⇒ nächster Scan holt nach (dedupliziert). Eine Marke ohne
  `pushDeliveryId` (Altbestand) wird ergänzt.
- **Service Worker** (`apps/staff/public/sw.js`): `client.navigate()` wirft bei
  nicht kontrollierten Clients ⇒ Fallback `clients.openWindow(url)`.
- **Offen (fehlende Fachregel, nicht umgesetzt):** B8 Retention von Chatfotos/
  -texten STORNIERTER Vorgänge und B9 Retention unzugeordneter/ignorierter
  Nachrichten (ohne Vorgang). Order §25 regelt nur den Vorgangsabschluss;
  Frist und Bezugszeitpunkt (Storno-Datum? Eingang? Ignorieren?) sind fachlich
  festzulegen.
