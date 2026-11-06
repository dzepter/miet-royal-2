# WEBSITE_CONFIGURATOR — Slush-Konfigurator und Website-Anfrage (Phase 16)

Stand: Phase 16 (2026-11-06). Maßgeblich ist der Code; dieses Dokument beschreibt ihn.
Verwandte Dokumente: [WEBSITE_CMS.md](WEBSITE_CMS.md) (Inhalte, Empfehlungsregeln,
Datenschutz-Seite), [DOMAIN_RULES.md](DOMAIN_RULES.md) „Website / Konfigurator (Phase 16)“,
[DATA_MODEL.md](DATA_MODEL.md) „PublicInquirySubmission (Phase 16, `public_inquiry_submissions`)“,
[MASTER_SPEC.md](MASTER_SPEC.md) §4–§8.

Code: API `apps/api/src/public/` (`catalog.ts`, `configurator.ts`, `schemas.ts`,
`website-inquiry.ts`), Routen `apps/api/src/routes/public-configurator.ts`, Preisengine
`packages/domain/src/pricing.ts` + `packages/domain/src/pricing-input.ts`, Web
`apps/web/app/konfigurator/page.tsx`, `apps/web/components/configurator/configurator.tsx`,
`apps/web/lib/configurator.ts`, Staff `apps/staff/components/website-submission.tsx`.

## Grundsätze

- **Geld wird nie im Browser berechnet.** Der Browser sendet nur die Auswahl; Preise, Summen,
  Gratis-Kontingent und Kanister-Maximum liefert der Server über die zentrale Preisengine
  (`priceOffer` + `resolvePricingInput`, dieselbe Auflösung wie das Angebot). Die Vorschau ist
  keine Autorität: Die Anfrage prüft alles serverseitig erneut.
- **Preise nur aus `products`/`product_prices`** zum Abfragezeitpunkt (geplante Preise wirken ab
  `effective_from`); Produkte ohne wirksamen Preis erscheinen nicht (nie 0 € erfinden).
- **Nur eine Anfrage, keine Buchung.** Die Website erzeugt einen Vorgang mit Anfrage – kein
  Angebot, keine Buchung, kein Payment, keine Mail an den Kunden, kein Job.
- **Keine Verfügbarkeitsprüfung, keine Ablehnung.** Keine Bestands- oder Lageranzeige, keine
  Live-Verfügbarkeit, keine Ablehnung wegen Verfügbarkeit oder ab 250 Gästen.
- **Abholung nur „Mainz-Hechtsheim“** (öffentliche Region, nie die exakte Adresse); **Lieferung
  individuell**, ohne Preis und ohne km-Formel.

## Die sechs Schritte (Web `/konfigurator`)

Der Server lädt Katalog und Website-Bootstrap parallel; `?maschine=<slug>` wählt eine Maschine
vor, wenn sie im Katalog steht. Laufende Übersicht ausschließlich aus
`POST /api/public/configurator/preview` (entprellt 350 ms, ältere Anfragen werden abgebrochen).
Der Wizard wird serverseitig vorgerendert; seine Eingaben und Knöpfe sind erst nach der
Hydration bedienbar (bis dahin gesperrt mit Hinweis „Konfigurator wird geladen …“), damit vorher
gemachte Eingaben nicht verloren gehen.

| Schritt | Inhalt |
| --- | --- |
| 1 Event | Datum (frühestens heute, Europe/Berlin), Beginn und Ende optional (Hinweis, wenn das Ende am Folgetag liegt), Gästezahl, Anlass (aus dem Katalog). Ab der Schwelle des Katalogs (250) ein freundlicher Großevent-Hinweis – die Anfrage geht normal weiter. |
| 2 Maschine | Die aktiven Slush-Maschinen mit Preis und Behälterangabe; Empfehlung bzw. Fallbacktext aus der Vorschau, Kennzeichnung „Empfohlen“; freie Wahl jederzeit. Keine Bestands- oder Verfügbarkeitsanzeige. |
| 3 Sirup & Zubehör | Gratis-Sirup-Kontingent aus der Vorschau (`quota`), frei auf Sorten verteilbar; weniger als das Kontingent ist erlaubt („Noch offen: X L – Sorte später abstimmen“). 25 Becher + 25 Strohhalme als inklusive angezeigt. Extra-Sirup, Becher, Strohhalme auf Kommission mit Einheitspreis. Mischkanister empfohlen, aber 0 vorausgewählt, Maximum aus `quota.canisterMax` (2 je Behälter). |
| 4 Abholung oder Lieferung | Abholung: „Selbst abholen in {Abholregion}“ + „Die genaue Abholadresse teilen wir dir rechtzeitig mit.“ Lieferung: Straße, PLZ (5 Ziffern), Ort, Zeitfenster „am Veranstaltungstag“ optional (Ende nach dem Beginn, keine Folgetag-Regel; das Web prüft das schon im Schritt mit derselben Meldung wie die API), Hinweis „Lieferung wird individuell geprüft.“ |
| 5 Kontakt | Privatperson (Vorname, Nachname, E-Mail, Telefon optional) oder Organisation/Firma/Verein (Organisationsname, Ansprechperson, E-Mail, Telefon optional). Keine weiteren Pflichtfelder. |
| 6 Zusammenfassung | Alle Angaben mit „Ändern“, Pflicht-Checkbox „Ich habe die Datenschutzhinweise zur Kenntnis genommen.“ (Link `/datenschutz`, neuer Tab), dominanter Button „Unverbindliches Angebot anfordern“. |

Bestätigung: „Danke! Deine Anfrage ist bei uns eingegangen.“ mit Vorgangsnummer und dem Hinweis,
dass die Anfrage unverbindlich und noch keine Buchung ist. Kein Newsletter-Opt-in, kein Tracking.

Laufende Übersicht (nur aus der Vorschau): feste Miet-/Kaufkosten mit Summe, inklusive
Positionen, Kommissionsartikel mit Einheitspreis, Lieferung „wird individuell angeboten“,
Hinweise (`issues`) und der Text „Die Übersicht basiert auf den aktuell hinterlegten Preisen.
Verbindlich wird der Preis erst mit deinem schriftlichen Angebot.“

## Routen

| Methode | Pfad | Zugriff | Limit | Hinweise |
| --- | --- | --- | --- | --- |
| GET | `/public/configurator/catalog` | öffentlich (SSR + Browser) | kein IP-Limit | `Cache-Control: no-store` |
| POST | `/public/configurator/preview` | öffentlich (Browser über `/api`) | 60/min je IP | Verstöße sind Hinweise, nie 4xx; `no-store` |
| POST | `/public/inquiries` | öffentlich (Browser über `/api`) | 5/min je IP (`@fastify/rate-limit`) + 20/h je IP (prozessinternes Fenster) | Idempotent über `clientMutationId`; `no-store` |
| GET | `/staff/processes/:id/website-submission` | Staff: `inquiry.view` + `process.view_all` + Sichtbarkeitsfenster des Vorgangs | – | 404, wenn der Vorgang keine Website-Anfrage hat oder unsichtbar ist |

Alle POSTs unterliegen dem globalen CSRF-Hook (`Sec-Fetch-Site`, Fallback
`AUTH_ALLOWED_ORIGINS`; Cross-/Same-Site ⇒ 403 `CSRF_REJECTED`). Es gibt keine CORS-Header.
In `APP_ENV=demo` unterliegen die POSTs Reset-Gate und Barrier (503 `DEMO_RESET`); der
Katalog-GET bleibt erreichbar. Die Limits gelten nur bei aktiven Rate-Limits und sind
prozesslokal (siehe „Betrieb“).

## DTOs

### Katalog `PublicCatalog`

```ts
{ asOf: string;
  machines: Array<{ slug; name; category; description: string | null; priceCents; billingMode;
                    unitLabel; containerCount; containerVolumeLiters }>;   // nur Slush-Maschinen
  syrups: PublicProduct[];                 // Kommission, je 1 L
  accessories: PublicProduct[];            // becher-25, strohhalme-25 (Kommission)
  canister: (PublicProduct & { maxPerContainer: 2 }) | null;   // mischkanister-6l, Kauf
  included: { freeSyrupLitersPerContainer: 1; cupsPerProcess: 25; strawsPerProcess: 25 };
  pickupArea: string;                      // öffentliche Region, nie die exakte Adresse
  largeEventGuestThreshold: 250;
  occasions: Array<{ value: InquiryOccasion; label: string }>;
  priceNote: string }
// PublicProduct = { slug, name, category, description, priceCents, billingMode: 'fixed' | 'commission', unitLabel }
```

Nur aktive Produkte mit wirksamem Preis. NIE: IDs, physischer Bestand, Maschinen, Sperren,
Lagerbestand, Kaufdaten, interne Kosten/Felder, Staff-Daten, Preis-Historie. Exakte
Abholadresse nie öffentlich: enthält die Produktbeschreibung sie ⇒ `description: null`; enthält
der Produktname sie ⇒ das Produkt fehlt öffentlich ganz (Katalog, `product_grid`, Vorschau,
Anfrage, Empfehlung); Log `public.catalog.exact_address_suppressed` nur mit `productSlug`.
Slush-Maschine = Kategorie `machine` mit gepflegter Behälteranzahl und -größe
(`isSlushMachineProduct`). Anlässe: Geburtstag, Hochzeit, Firmenfeier, Verein, Party,
Schule / Kindergarten, Festival, Sonstiges.

### Vorschau `POST /public/configurator/preview`

Body (strict, alles optional, leerer Body gültig):
`{ guests?: 1..100000; machineSlug?; syrups?: { free: [{ slug, liters 0..20 }] (≤ 20), extra:
[{ slug, liters 0..50 }] (≤ 20) }; extras?: { cups25: 0..50; straws25: 0..50 }; canisters?:
0..20; fulfillment?: 'pickup' | 'delivery' }`.

Antwort `PublicConfiguratorPreview`:

```ts
{ recommendation: { machineSlug: string | null; message: string };
  largeEvent: boolean;                         // guests ≥ 250 ⇒ nur Hinweis
  quota: { freeSyrupLiters; assignedFreeLiters; unassignedFreeLiters; canisterMax };
  fixed: Array<{ label; quantity; unitPriceCents; totalCents }>;   // Maschinenmiete, Kanister (Kauf)
  fixedTotalCents: number;
  included: Array<{ label; quantity; unit }>;  // Gratis-Sirup je Sorte bzw. „Sorte später abstimmen“ (L), 25 Becher, 25 Strohhalme
  commission: Array<{ label; quantity; unitPriceCents; unit }>;    // Extra-Sirup, Becher, Strohhalme – nur Einheitspreis
  delivery: { requested: boolean; text: 'Lieferung wird individuell geprüft und angeboten.' };
  issues: Array<{ code; message }>;
  priceNote: string }
```

Issue-Codes: `MACHINE_UNAVAILABLE`, `SYRUP_UNAVAILABLE`, `ACCESSORY_UNAVAILABLE`,
`FREE_SYRUP_BUDGET_EXCEEDED`, `CANISTER_LIMIT_EXCEEDED`, `PRICING_INVALID`. Eine betroffene
Position wird nicht berechnet; die Vorschau antwortet trotzdem 200. Gleiche Sorte mehrfach ⇒
Mengen zusammengefasst, 0-Liter-Einträge entfallen. Jeder Slug wird zuerst auf aktives Produkt
UND passende Kategorie geprüft, erst dann aus dem Auflösungs-Cache genommen: ein
Maschinen-Slug (oder ein anderes Nicht-Sirup-Produkt) als Sirup ⇒ `SYRUP_UNAVAILABLE` am
Sirupfeld (`syrups.<free|extra>.<i>.slug`), die gewählte Maschine wird normal berechnet.

### Anfrage `POST /public/inquiries`

Body (strict):

```ts
{ clientMutationId: uuid;                                   // intern klein geschrieben
  event: { date: 'YYYY-MM-DD' /* ≥ heute Berlin */; startTime?: 'HH:MM'; endTime?: 'HH:MM';
           guests: 1..100000; occasion: InquiryOccasion };
  machineSlug: string;                                      // aktive Slush-Maschine
  syrups: { free: Array<{ slug; liters 0..20 }>; extra: Array<{ slug; liters 0..50 }> };
  extras: { cups25: 0..50; straws25: 0..50 };
  canisters: 0..20;                                         // fachlich ≤ 2 je Behälter
  fulfillment: { type: 'pickup' }
             | { type: 'delivery'; street 1..120; postalCode /^[0-9]{5}$/; city 1..80;
                 windowFrom?: 'HH:MM'; windowTo?: 'HH:MM' };
  contact: { type: 'private'; firstName 1..80; lastName 1..80; email; phone? }
         | { type: 'organization'; organizationName 1..160; contactPerson 1..120; email; phone? };
  privacyAcknowledged: true }
```

Telefon optional und tolerant geprüft (leer = nicht angegeben). Zeiten sind Uhrzeiten am
Veranstaltungstag (Europe/Berlin ⇒ `timestamptz`). Veranstaltung: Ende ≤ Beginn ⇒ Ende am
Folgetag (kein 400). Wunsch-Lieferzeitfenster: beide Zeiten am Veranstaltungstag, keine
Folgetag-Regel – Ende ≤ Beginn ⇒ 400 an `body.fulfillment.windowTo` („Das Ende des
Wunsch-Lieferzeitfensters muss nach dem Beginn liegen.“). Uhrzeiten, die es am jeweiligen Tag
wegen der Zeitumstellung nicht gibt (z. B. 28.03.2027, 02:30), ⇒ 400 am jeweiligen Feld
(`body.event.startTime|endTime`, `body.fulfillment.windowFrom|windowTo`, „Diese Uhrzeit gibt es
am gewählten Tag wegen der Zeitumstellung nicht.“). Datum in der Vergangenheit und Zeiten werden
erst NACH der Wiederholungserkennung geprüft: eine bereits gespeicherte `clientMutationId`
bekommt immer 200 bzw. 409, auch wenn das Datum inzwischen vergangen ist.

| Antwort | Bedeutung |
| --- | --- |
| 201 `{ processNumber, receivedAt }` | neue Anfrage, genau ein Vorgang |
| 200 `{ processNumber, receivedAt }` | Wiederholung: gleiche `clientMutationId` UND gleicher Payload-Hash ⇒ dieselben Werte, kein zweiter Vorgang |
| 409 `PUBLIC_INQUIRY_CONFLICT` + `processNumber` | gleiche `clientMutationId`, anderer Inhalt – „Deine Anfrage ist bereits bei uns eingegangen.“ |
| 409 `PRIVACY_NOT_PUBLISHED` | keine gültige veröffentlichte Datenschutz-Revision – „Anfragen sind gerade nicht möglich. Bitte versuche es später erneut oder kontaktiere uns direkt.“ |
| 400 `VALIDATION_ERROR` | `issues: [{ path: 'body.…', message }]` ohne Werte (z. B. `body.event.date` in der Vergangenheit, `body.event.startTime` bei Zeitumstellung, `body.fulfillment.windowTo` bei Ende ≤ Beginn, `body.machineSlug`, `body.syrups.free.<i>.slug` bei nicht wählbarer Sorte, `body.canisters`) – auch Regelverstöße der Preisengine (Gratis-Kontingent, Kanisterlimit); mehrere Zeit-Issues kommen gemeinsam in einer Antwort |
| 429 | Rate-Limit (Stundenfenster mit Code `RATE_LIMITED`; Minutenlimit über `@fastify/rate-limit` mit generischem Code – maßgeblich ist der Status) |
| 403 `CSRF_REJECTED` | Cross-/Same-Site-POST |
| 503 `DEMO_RESET` | demo: Reset läuft |

## Maschinenempfehlung

- Nur aus VERÖFFENTLICHTEN Empfehlungsregeln der Website-Einstellungen
  (`loadPublishedSiteSettings` ⇒ `recommendMachineSlug`), nur aktive Slush-Maschinen mit Preis.
  Entwurfsregeln wirken nie. Keine Formel; die Regeln sind initial leer (offener Business-Punkt,
  [OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 16“).
- Mit Regel: „Unsere Empfehlung für deine Gästezahl: <Name>. Du kannst jederzeit eine andere
  Maschine wählen.“ Ohne passende Regel: „Wir prüfen persönlich, welche Maschine am besten zu
  deinem Event passt.“ – keine Ablehnung, keine Verfügbarkeitszusage.
- Die Empfehlung ist nie Pflicht; die Anfrage nimmt jede aktive Slush-Maschine an.

## Website-Anfrage → Vorgang

Ablauf in `WebsiteInquiryService.submit` (`apps/api/src/public/website-inquiry.ts`):

1. Optionale Portal-Session VOR der Transaktion (Route; `authenticate(token, { touch: false })`;
   ungültiges Cookie ⇒ anonym, nie 401). Im Service vor jeder Verbindung nur
   deterministische Schritte: Datum ist ein reales Kalenderdatum (sonst 400), Payload-Hash,
   Kontakt-Snapshot.
2. EINE Transaktion über EINE Verbindung (kein `this.db` innerhalb – funktioniert mit
   Pool max = 1):
   1. `pg_advisory_xact_lock(hashtext('public-inquiry:' || clientMutationId))`.
   2. Vorhandene Submission mit dieser ID ⇒ gleicher Hash 200 (Wiederholung), anderer Hash 409
      mit `processNumber` – ohne jede weitere Prüfung, also auch nach Ablauf des Eventdatums.
   3. Nur neue Anfragen: Datum nicht in der Vergangenheit (Berlin) und Zeitregeln (Uhrzeit
      existiert am jeweiligen Tag, Lieferfenster-Reihenfolge) ⇒ sonst 400 am Feld.
   4. `loadPublishedPrivacyRevision(tx)` ⇒ null ⇒ 409 `PRIVACY_NOT_PUBLISHED` (Rollback).
   5. Auswahl erneut auflösen und mit `priceOffer` prüfen (Verstoß ⇒ 400 mit Feldpfad).
   6. `pg_advisory_xact_lock(hashtext('public-inquiry-email:' || normalisierte E-Mail))`.
   7. Kunde bestimmen bzw. anlegen (`CustomerService.createCustomerWithin`, Validierung und
      Normalisierung wie der Staff-Pfad).
   8. Vorgang `ProcessService.createProcessWithin(tx, null, { customerId, source: 'website',
      eventDate })` – `created_by` NULL, kein künstlicher „Website-Mitarbeiter“.
   9. Anfrage + Auswahl `InquiryService.upsertWithin(tx, null, processId, …)` – dieselbe
      Validierung wie die Staff-Route.
   10. Unveränderliche Zeile `public_inquiry_submissions` (Payload-Hash, Kundenzuordnung,
       Kontakt-Snapshot, Datenschutz-Revision, Zeitpunkt).
3. Commit ⇒ 201. Ein Fehler an beliebiger Stelle ⇒ nichts gespeichert (kein Kunde ohne Vorgang).

Payload-Hash: SHA-256 über kanonisches JSON (Schlüssel sortiert) des validierten Bodys OHNE
`clientMutationId`. Umsortierte Felder oder eine groß geschriebene UUID ergeben dieselbe
Wiederholung.

### Kundenzuordnung (`customer_match`)

| Wert | Fall | Wirkung |
| --- | --- | --- |
| `portal_session` | gültige Portal-Session eines aktiven Kunden | genau dieser Kunde |
| `email_unique` | anonym, genau EIN aktiver Kunde mit exakt dieser normalisierten E-Mail | dieser Kunde; Stammdaten werden NICHT überschrieben |
| `new_customer` | kein aktiver Kunde mit dieser E-Mail | neuer Kunde aus den Kontaktdaten |
| `new_customer_email_ambiguous` | mehrere aktive Kunden mit dieser E-Mail | neuer Kunde + interne Dublettenwarnung, keine Zusammenführung |

Gelöschte Kunden (Papierkorb) zählen nicht; ist der Kunde einer Portal-Session inzwischen
gelöscht, wird wie anonym zugeordnet. Es gibt keine öffentliche Meldung „E-Mail existiert
bereits“. Gleichzeitige Erstanfragen mit derselben neuen E-Mail werden über den E-Mail-Lock
serialisiert; die zweite wird dann dem eben angelegten Kunden (`email_unique`) zugeordnet.

### Kontakt-Snapshot

Genau die abgesendeten Kontaktfelder, normalisiert wie gespeichert:
privat `{ type, firstName, lastName, email, phone | null }`, Organisation
`{ type, organizationName, contactPerson, email, phone | null }`. Unveränderlich (Trigger
`public_inquiry_submissions_no_update`). Staff sieht Abweichungen zum aktuellen CRM-Kunden
(`differences`: `type`, `firstName`, `lastName`, `organizationName`, `contactPerson`, `email`,
`phone`; Telefon normalisiert verglichen).

### Datenschutz-Nachweis (fail-closed)

- Pflicht-Checkbox (`privacyAcknowledged: true`); kein Newsletter-Opt-in.
- Gespeichert werden `privacy_revision_id` (die zum Zeitpunkt veröffentlichte Revision von
  `/datenschutz`) und `privacy_acknowledged_at` (Serverzeit) – nicht der Text.
- Ohne veröffentlichte, gültige Datenschutzhinweise (nicht veröffentlicht, nur Entwurf, leerer
  oder ungültiger Rechtstext) ist keine Anfrage möglich: Web sperrt das Absenden
  (`cfg-privacy-unavailable`), die API antwortet 409 `PRIVACY_NOT_PUBLISHED`.
- `/datenschutz` lässt sich nicht zurückziehen ([WEBSITE_CMS.md](WEBSITE_CMS.md)); das erste
  Veröffentlichen schaltet die Anfragen dauerhaft frei – erst nach juristischer Prüfung.

### Staff-Kasten „Website-Anfrage“

In der Inquiry-Ansicht des Vorgangs (`apps/staff/app/vorgaenge/[id]/anfrage/page.tsx`) aus
`GET /staff/processes/:id/website-submission`:
`{ submittedAt; customerMatch; duplicateWarning (= new_customer_email_ambiguous);
contactSnapshot; differences: string[]; privacy: { acknowledgedAt; revisionNumber } }`.
Angezeigt werden Eingangszeit, Kundenzuordnung, Dublettenhinweis, abgesendete Kontaktangaben,
Abweichungen zum Kundenstamm bzw. „stimmen überein“, bei Lieferung mit Zeitfenster der Hinweis
„als Uhrzeit am Veranstaltungstag angegeben“ und der Datenschutz-Nachweis (Zeitpunkt +
Revisionsnummer). Keine automatische Zusammenführung, keine Stammdatenänderung. Jede Nicht-2xx-
Antwort ⇒ kein Kasten. Die Vorgangsübersicht zeigt wie bisher die Quelle „Website“.

## Idempotenz im Web

- `clientMutationId` wird beim ersten Sendeversuch erzeugt (`crypto.randomUUID`, Fallback
  `getRandomValues`) und in `sessionStorage` unter `mr-konfigurator-anfrage-id` gehalten – NUR
  die UUID, nie Kontakt- oder Eventdaten. Gelöscht nach Erfolg bzw. „bereits eingegangen“;
  ohne Speicher nur im Formularzustand.
- Doppelklick ist gesperrt. Unklarer Ausgang (5xx, Netz) ⇒ Formular gesperrt, Text „Wir
  konnten nicht sicher feststellen, ob deine Anfrage angekommen ist. Sende sie bitte erneut – sie
  wird dabei nicht doppelt angelegt.“, „Erneut senden“ schickt den IDENTISCHEN Payload mit
  derselben ID.
- Nach einem Reload wird dieselbe ID wiederverwendet; geänderte Daten ergeben serverseitig 409
  ⇒ „Deine Anfrage ist bereits bei uns eingegangen.“ mit Vorgangsnummer.

| Antwort | Web-Reaktion |
| --- | --- |
| 201/200 | Bestätigung mit Vorgangsnummer |
| 409 `PUBLIC_INQUIRY_CONFLICT` | „Deine Anfrage ist bereits bei uns eingegangen.“ + Nummer |
| 409 `PRIVACY_NOT_PUBLISHED` | API-Text, Absenden gesperrt |
| 400 `VALIDATION_ERROR` | Meldungen dem jeweiligen Schritt und Feld zugeordnet (z. B. Zeitumstellung an der Uhrzeit, Lieferfenster an „bis“) |
| 429 | „Gerade kommen zu viele Anfragen von deinem Anschluss …“, gesperrt + „Erneut senden“ |
| 503 `DEMO_RESET` | „Die Demo-Umgebung wird gerade zurückgesetzt. Bitte versuche es in einer Minute erneut.“, gesperrt + „Erneut senden“ |
| 403/413/415/sonstige 409 | neutral „Seite neu laden“ |
| 5xx/Netz | unklarer Ausgang (siehe oben) |
| Vorschau-Fehler | „Die Übersicht ist gerade nicht verfügbar. Du kannst trotzdem weitermachen – wir prüfen alles persönlich.“ |

Weicht `WEB_API_ORIGIN` zur Laufzeit vom beim Build eingebackenen API-Origin ab, bleibt das
Absenden gesperrt („Anfragen sind auf dieser Website gerade nicht möglich …“; ebenso CMS-Vorschau
und Bewertungs-Sektion) –
[DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „Website, CMS, Konfigurator, Bewertungen (Phase 16)“.

## Domain-Konstanten (eine Wahrheit, `packages/domain/src/pricing.ts`)

`FREE_SYRUP_LITERS_PER_CONTAINER` (1), `FREE_CUPS_PER_RENTAL` / `FREE_STRAWS_PER_RENTAL` (25),
`CUPS_PACK_SLUG` (`becher-25`), `STRAWS_PACK_SLUG` (`strohhalme-25`), `CANISTER_SLUG`
(`mischkanister-6l`), `CANISTERS_PER_CONTAINER_LIMIT` (2), `LARGE_EVENT_GUEST_THRESHOLD` (250),
Helfer `freeSyrupBudgetFor(containers)`, `canisterLimitFor(containers)`; `PricingError.code`
(`FREE_SYRUP_BUDGET_EXCEEDED` | `CANISTER_LIMIT_EXCEEDED` | `PRICING_INVALID`).
`resolvePricingInput` (`packages/domain/src/pricing-input.ts`) baut aus einer Auswahl die
Eingabe von `priceOffer` – genutzt von Angebot (Produkte per ID) und Konfigurator (per Slug).

## Demo

Website-Anfragen in der Demo erzeugen nur Demo-Kunden, -Vorgänge und -Anfragen in der
Demo-Datenbank. Der Demo-Business-Reset löscht `public_inquiry_submissions` (vor `inquiries`);
CMS-Inhalte bleiben. Während eines Resets 503 `DEMO_RESET`.

## Betrieb und Sicherheit

- Keine PII in Logs, keine Request-Bodies im Log, keine E-Mail-/Telefonwerte in Audit oder
  Fehlerbodies; Fehler tragen nur Feldpfade.
- Rate-Limits (5/min, 20/h, 60/min) sind prozesslokal wie alle bestehenden IP-Limits: mehrere
  API-Prozesse vervielfachen das effektive Limit. Die echte Client-IP gibt es nur mit korrekt
  gesetztem `API_TRUST_PROXY_HOPS` ([DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „Öffentliche
  Token-Links hinter Proxy“). Kein CAPTCHA in Phase 16.
- `/konfigurator` ist eine normale Website-Seite (Indexierung folgt `WEB_INDEXING_ENABLED`; die
  Demo-Web-Instanz ist immer noindex, ebenso `/konfigurator` ohne Katalog bzw. ohne wählbare
  Maschine).

## Tests

Siehe [TEST_PLAN.md](TEST_PLAN.md) „Website, CMS, Konfigurator, Bewertungen (Phase 16)“
(`apps/api/test/public-*.integration.test.ts`, `packages/domain/test/pricing-input.test.ts`,
`apps/web/lib/configurator.test.ts`).
