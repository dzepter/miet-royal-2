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
| Berechtigungen | Ausschließlich das Phase-1-System; neue Katalogrechte: `process.edit`, `process.complete`, `process.view_completed`, `trash.manage` | Kein Parallelsystem. WICHTIG für bestehende Installationen: Vorhandene Administrator-Rollen erhalten neue Katalogrechte NICHT automatisch – nach dem Deployment einmalig der Admin-Rolle zuweisen (frische Bootstraps enthalten sie automatisch). |
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
