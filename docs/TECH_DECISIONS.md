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
  `/staff/machines/qr/…` wie die öffentlichen Angebots-Links) noch in
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
