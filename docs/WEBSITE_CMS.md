# WEBSITE_CMS — Internes Website-CMS (Phase 16)

Stand: Phase 16 (2026-11-06), ergänzt Phase 17 (2026-11-12: SEO-Hinweise im Staff, Metadaten,
Brotkrumen, Preis-Guard). Maßgeblich ist der Code; dieses Dokument beschreibt ihn.
Verwandte Dokumente: [WEBSITE_CONFIGURATOR.md](WEBSITE_CONFIGURATOR.md) (Konfigurator und
Website-Anfrage), [GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md) (Bewertungen),
[SEO_TECHNICAL.md](SEO_TECHNICAL.md) (Indexierung, Canonicals, robots, Sitemap, Redirects),
[SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md) (strukturierte Daten),
[WEBSITE_MIGRATION_NOTES.md](WEBSITE_MIGRATION_NOTES.md) (Inventur der bisherigen Website),
[DATA_MODEL.md](DATA_MODEL.md) „Website-CMS (Phase 16, Migration 0033)“, [PERMISSIONS.md](PERMISSIONS.md)
„Website / CMS (Phase 16)“, [OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 16“.

## Grundsätze

- **Kein externes CMS.** Schlankes CMS in der bestehenden API (`apps/api/src/cms/`,
  Routen `apps/api/src/routes/website-cms.ts`) und der Staff-App (`/website`).
- **Strukturierte Blöcke statt HTML.** Inhalte sind streng validierte Blöcke
  (`packages/validation/src/cms.ts`, Import `@mietroyal/validation/cms`, alle `strictObject`):
  kein HTML, kein Script, kein WYSIWYG-Blob, keine HTML-artigen Tags, keine Steuer- oder
  Formatzeichen (Unicode `Cc`/`Cf`: C0, DEL und C1-Steuerzeichen, weiches Trennzeichen,
  Zero-Width-Zeichen, Bidi-Steuerzeichen, BOM, sowie U+2028/U+2029). Erlaubt ist nur der
  Zeilenumbruch `\n` – in Medien-Bezeichnung und -Standard-Alt-Text auch dieser nicht. Dieselbe
  Regel (`hasForbiddenTextCharacters`) gilt für alle Blocktexte, Titel, Meta-Felder, Alt-Texte,
  Medien-Bezeichnung/-Standard-Alt-Text und die Redaktionsnotiz; Verstoß ⇒ 400
  `VALIDATION_ERROR` am Feld. Folge: zusammengesetzte Emojis mit Zero-Width-Joiner sind nicht
  erlaubt, einfache Emojis schon. Texte sind reiner Text (Absätze an Leerzeilen). Kein
  Drag-and-Drop-Builder.
- **Keine Preise im CMS.** Maschinen-, Sirup-, Zubehör- und Kanisterpreise kommen ausschließlich
  aus `products`/`product_prices` zum Abrufzeitpunkt (geplante Preise wirken ab
  `effective_from`). Das Schema kennt kein Preisfeld; Preis-Freitext wird abgelehnt (Prüfregeln).
  Preisänderungen bleiben unter `/produkte` mit `price.manage`.
- **Entwurf ist nie öffentlich.** Öffentliche Routen lesen ausschließlich
  `published_revision_id`. Entwürfe erreicht man nur über Staff-Routen oder eine an genau eine
  Revision gebundene Vorschau.
- **Historie bleibt.** Revisionen sind unveränderlich (DB-Trigger); jede Änderung erzeugt eine
  neue Revision.
- **Nichts wird automatisch veröffentlicht** – weder bei API-Start noch bei Migration oder
  Deployment. `pnpm cms:bootstrap` legt nur Entwürfe an; `--publish-demo` ist auf
  development/demo (und Tests) beschränkt.

## Datenmodell (Kurzfassung)

Migration `packages/database/migrations/0033_phase16_website_cms.sql`, Schema
`packages/database/src/schema/website.ts`; Details in [DATA_MODEL.md](DATA_MODEL.md).

| Tabelle | Inhalt |
| --- | --- |
| `cms_entries` | stabiler Eintrag: `kind` (`site_settings` \| `page`), `page_type`, `path` (eindeutig), Zeiger `draft_revision_id` und `published_revision_id`, `published_at`/`published_by`, `version` (optimistische Zählung, +1 bei jedem Speichern, Wiederherstellen, Veröffentlichen, Zurückziehen) |
| `cms_revisions` | unveränderliche Revision: fortlaufende `revision_number` je Eintrag, `content` (JSON), `meta_title`, `meta_description`, `editor_note` (intern), `based_on_revision_id` (bei Wiederherstellung), `created_by` (NULL beim Bootstrap) |
| `cms_media`, `cms_media_variants` | hochgeladenes Bild (Bezeichnung, Maße, `default_alt`) und seine WebP-Varianten mit internem Storage-Key |
| `cms_revision_media` | welche Revision welches Medium referenziert (Grundlage der öffentlichen Medien-Freigabe) |
| `cms_preview_access` | Vorschau-Zugang: nur Hashes von Zugangs- und Sitzungstoken, Ablauf, Einlösezeitpunkt |

- `site_settings` ist ein Singleton (eindeutiger Index), Seiten haben immer Typ und Pfad
  (CHECK `cms_entries_kind_check`), Pfade folgen `cms_entries_path_format`.
- Trigger `cms_revisions_no_update_delete`: UPDATE und DELETE auf `cms_revisions` schlagen fehl.
- Der Vorschau-Zugang verweist per zusammengesetztem FK `(revision_id, entry_id)` auf
  `cms_revisions(id, entry_id)` – eine Vorschau gehört immer zu einer Revision DESSELBEN Eintrags.
- Die CMS-Tabellen überleben den Demo-Business-Reset.

## Einträge, Seitentypen, Pfade

| Seitentyp | Pfad | Hinweise |
| --- | --- | --- |
| `site_settings` (Eintragsart) | – | Firmenname, Kurzbeschreibung, Kontakt (Telefon, E-Mail), Instagram-Link, Logo, Fußzeile, Empfehlungsregeln |
| `home` | `/` | |
| `slush` | `/slushmaschine-mieten` | |
| `process` | `/ablauf` | |
| `faq` | `/faq` | |
| `about` | `/ueber-uns` | |
| `contact` | `/kontakt` | `/kontakt/[token]` bleibt die bestehende Token-Seite |
| `legal` | `/impressum`, `/datenschutz` | nur Textblöcke; die veröffentlichte Revision von `/datenschutz` ist Pflicht für Website-Anfragen |
| `secondary_offer` | `/popcornmaschine-mieten`, `/waffeleisen-mieten` | zurückziehbar |
| `region` | `/slushmaschine-mieten/<slug>` | Slug 2–60 Zeichen `[a-z0-9]` mit Bindestrichen; zurückziehbar |

Feste Seiten legt nur `pnpm cms:bootstrap` an (Pfad muss zum Typ passen,
`isValidCmsPathForPageType`). Weitere Regionsseiten legt die Redaktion **einzeln** an
(`POST /staff/cms/entries`): Revision 1 mit `{ title, blocks: [] }`, keine Vorlage, keine
Massenerzeugung, keine automatische Veröffentlichung. Einträge werden nicht gelöscht.

## Inhaltsschema

Seite: `{ title (1–120), blocks (≤ 40) }`. `title` ist die H1, außer der erste Block ist ein
`hero` (dann dessen Überschrift); `hero` ist nur als erster Block erlaubt.

| Block | Felder (Auszug) | Daten aus |
| --- | --- | --- |
| `hero` | Überschrift, Lead, Bild, primärer/sekundärer Button | CMS |
| `text` | Überschrift, Text (≤ 8000) | CMS |
| `features` | 1–6 Einträge (Titel/Text) | CMS |
| `steps` | 1–8 Schritte | CMS |
| `product_grid` | Überschrift/Einleitung, optional `productSlugs` (1–6) | Katalog: ohne `productSlugs` die Slush-Maschinen, sonst genau diese aktiven Produkte mit wirksamem Preis |
| `included_items` | Überschrift/Einleitung | Domain-Konstanten + Katalog (Gratis-Sirup je Behälter, 25 Becher/Strohhalme, Sirup-/Zubehör-/Kanisterpreise) |
| `image` | Bild, Bildunterschrift | Medien |
| `gallery` | 1–12 Bilder | Medien |
| `faq` | 1–40 Frage/Antwort | CMS |
| `reviews` | Überschrift/Einleitung | Bewertungs-Provider; der Block entfällt serverseitig, solange der Provider `disabled` ist |
| `service_areas` | 1–20 Ortsnamen | CMS; verlinkt nur veröffentlichte Regionsseiten |
| `secondary_offers` | Überschrift/Einleitung | verlinkt nur veröffentlichte `secondary_offer`-Seiten |
| `contact_details` | Überschrift/Einleitung | veröffentlichte Website-Einstellungen + öffentliche Abholregion und Knopf „Unverbindlich anfragen“ (auf `secondary_offer`-Seiten nur Telefon/E-Mail) |
| `cta` | Überschrift, Text, primärer/sekundärer Button | CMS |

- **Links** (`cmsHrefSchema`): interner Pfad, `https:`-URL ohne Zugangsdaten, `mailto:` oder
  `tel:` – nie `javascript:`/`data:`. Der Web-Renderer blendet interne Links auf
  unveröffentlichte CMS-Seiten aus; der SEO-Check meldet solche Links der Redaktion
  (`BROKEN_INTERNAL_LINK`, Phase 17).
- **Bilder**: nur über die opake `mediaId`; Alt-Text (≥ 3 Zeichen) oder ausdrücklich
  `decorative: true` mit leerem Alt-Text.
- **Meta**: Meta-Titel 1–70, Meta-Beschreibung 1–170 Zeichen (reiner Text). Leere Werte ⇒ null.
  Der SEO-Check (Phase 17) empfiehlt 20–60 bzw. 50–160 Zeichen und je Seite eindeutige Werte –
  Hinweise, keine Sperre (Abschnitt „SEO-Hinweise im Staff (Phase 17)“).
- **Redaktionsnotiz** (`editorNote`): intern, ≤ 2000 Zeichen, nie öffentlich (Konvention:
  interne Prüfliste „vor Veröffentlichung …“).
- **Website-Einstellungen** (`cmsSiteSettingsSchema`): `businessName` (Pflicht), `tagline`,
  `contact.phone`, `contact.email`, `instagramUrl` (nur `https://instagram.com/…` bzw.
  `https://www.instagram.com/…`, reiner Link – kein Feed, kein iframe), `logo`, `footerNote`,
  `recommendationRules` (≤ 20).
- **Empfehlungsregeln**: `{ guestMin, guestMax?, machineProductSlug }`; Lücken erlaubt,
  Überschneidungen verboten (Schema), nur aktive Slush-Maschinen (Prüfung gegen `products`).
  Keine Formel, keine Vorbelegung; ohne passende veröffentlichte Regel zeigt der Konfigurator
  „Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.“
  (siehe [WEBSITE_CONFIGURATOR.md](WEBSITE_CONFIGURATOR.md)). Die Regeln erscheinen nie in
  öffentlichen DTOs.

## Ablauf: Entwurf → Vorschau → Veröffentlichen

1. **Entwurf speichern** (`PUT /staff/cms/entries/:id/draft`, `cms.edit`): vollständige
   Ersetzung (fehlende optionale Felder ⇒ null). `baseRevisionId` muss der aktuelle Entwurf
   sein, sonst 409 `CMS_DRAFT_CONFLICT` („Der Entwurf wurde inzwischen geändert – bitte neu
   laden.“) – nie stilles Überschreiben. Ergebnis: neue Revision, Entwurfszeiger umgesetzt,
   `version + 1`. Die öffentliche Website bleibt unverändert.
2. **Vorschau** (`POST /staff/cms/entries/:id/preview`, `cms.edit` oder `cms.publish`): kurzer
   Zugang zu genau einer Revision (Default: aktueller Entwurf; aus der Historie auch ältere
   Revisionen), Ablauf siehe „Vorschau“.
3. **Veröffentlichen** (`POST /staff/cms/entries/:id/publish`, `cms.publish`,
   Body `{ revisionId }`): in EINER Transaktion `SELECT … FOR UPDATE` auf den Eintrag,
   `revisionId` = aktueller Entwurf (sonst 409 `CMS_PUBLISH_STALE`), bereits veröffentlicht ⇒
   409 `CMS_ALREADY_PUBLISHED`, alle Prüfregeln, Zeiger `published_revision_id` umsetzen,
   `published_at`/`published_by`, `version + 1`, Audit `cms.published`. Parallele
   Veröffentlichungen desselben Stands: genau eine gelingt.
4. **Wiederherstellen** (`POST /staff/cms/entries/:id/restore`, `cms.edit`,
   `{ revisionId, baseRevisionId }`): übernimmt den Inhalt einer alten Revision als NEUE
   Entwurfsrevision (`based_on_revision_id`), mit denselben Prüfregeln wie Speichern. Eine alte
   Revision wird nie direkt veröffentlicht – erst wiederherstellen, dann veröffentlichen.
5. **Zurückziehen** (`POST /staff/cms/entries/:id/unpublish`, `cms.publish`, Body `{}`): nur
   `region` und `secondary_offer` (sonst 409 `CMS_UNPUBLISH_FORBIDDEN`; nicht veröffentlicht ⇒
   409 `CMS_NOT_PUBLISHED`). Setzt den veröffentlichten Zeiger auf NULL, Audit
   `cms.unpublished`. Startseite, Hauptseiten, Rechtstexte und Website-Einstellungen lassen
   sich NICHT zurückziehen – nur durch eine neue Revision ersetzen. Das gilt insbesondere für
   `/datenschutz`: einmal veröffentlicht, schaltet sie Website-Anfragen dauerhaft frei.

**Status in der Staff-Übersicht:** `published` „Veröffentlicht“, `published_with_draft_changes`
„Entwurf mit Änderungen“, `never_published` „Nicht veröffentlicht“ (die API meldet
`never_published` auch für zurückgezogene Seiten; deshalb neutral „Nicht veröffentlicht“).

## Rechte und Routen

Alle Staff-Routen: `requireAuth` + Rechte frisch serverseitig berechnet, Bodies `strictObject`.
Lesen = `cms.edit` ODER `cms.publish`. Wer nur `cms.publish` hat, kann alles lesen (inkl.
Entwurf), Vorschau erzeugen, veröffentlichen und zurückziehen, aber nicht bearbeiten.

| Methode | Pfad | Recht | Body ⇒ Antwort |
| --- | --- | --- | --- |
| GET | `/staff/cms/entries` | edit \| publish | `{ entries: StaffCmsEntrySummary[] }` (Einstellungen zuerst, dann nach Pfad) |
| GET | `/staff/cms/entries/:id` | edit \| publish | `StaffCmsEntryDetail` (Entwurf, veröffentlichter Stand, Historie, `canUnpublish`) |
| GET | `/staff/cms/revisions/:revisionId` | edit \| publish | `StaffCmsRevision` |
| PUT | `/staff/cms/entries/:id/draft` | `cms.edit` | `{ baseRevisionId, content, metaTitle?, metaDescription?, editorNote? }` ⇒ 200 Detail |
| POST | `/staff/cms/entries/:id/restore` | `cms.edit` | `{ revisionId, baseRevisionId }` ⇒ 200 Detail |
| POST | `/staff/cms/entries/:id/publish` | `cms.publish` | `{ revisionId }` ⇒ 200 Detail |
| POST | `/staff/cms/entries/:id/unpublish` | `cms.publish` | `{}` ⇒ 200 Detail |
| POST | `/staff/cms/entries` | `cms.edit` | `{ regionSlug, title }` ⇒ 201 Detail (Regionsseite) |
| POST | `/staff/cms/entries/:id/preview` | edit \| publish | `{ revisionId? }` ⇒ 201 `{ url, expiresAt }`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| GET | `/staff/cms/media` | edit \| publish | `{ media: StaffCmsMedia[] }` (u. a. `usedInPublished`, `variantWidths`) |
| POST | `/staff/cms/media` | `cms.edit` | `{ label, mimeType, dataBase64 }` (Routen-Body-Limit 9 MiB) ⇒ 201 `StaffCmsMedia` |
| PATCH | `/staff/cms/media/:id` | `cms.edit` | `{ label?, defaultAlt?: string \| null }` ⇒ 200 `StaffCmsMedia` |
| GET | `/staff/cms/media/:id/:width` | edit \| publish | Bild `image/webp`, `private, no-store` |
| GET | `/staff/cms/catalog` | `product.view` | öffentliche Katalog-Projektion („Produkte & Preise“, Lesesicht) |
| GET | `/staff/cms/seo-check` | edit \| publish | Phase 17: `{ checkedAt, warnings: SeoWarning[] }` – Hinweise zur Suchmaschinen-Darstellung; `Cache-Control: no-store`, nie blockierend, kein Audit (Abschnitt „SEO-Hinweise im Staff (Phase 17)“) |

Öffentliche Routen (Web-SSR bzw. Browser über den Same-Origin-Rewrite `/api/*`; keine
CORS-Header):

| Methode | Pfad | Verhalten |
| --- | --- | --- |
| GET | `/public/site/settings` | `PublicSiteBootstrap { environment, settings, pages, reviews: { mode }, pickupArea }`; nur veröffentlichte Inhalte; `no-store`; kein IP-Limit |
| GET | `/public/site/page?path=…` | Pfad strikt (Regex wie `cms_entries_path_format`, ≤ 200) ⇒ 200 `PublicPage` oder 404; `no-store`; kein IP-Limit |
| GET | `/public/cms/media/:mediaId/:width` | nur Medien einer aktuell veröffentlichten Revision und nur vorhandene Breiten, sonst 404; `public, max-age=31536000, immutable` |
| POST | `/public/cms/preview/consume` | `{ token }` ⇒ 200 `{ path, entryKind, expiresAt }` + Vorschau-Cookie; 401 `CMS_PREVIEW_INVALID`; 20/min je IP; CSRF-Hook; in demo Reset-Gate |
| GET | `/public/cms/preview/page` | Vorschau-Cookie ⇒ `PublicPreviewPage { preview, page, settings }`; sonst 401 `CMS_PREVIEW_INVALID` |
| GET | `/public/cms/preview-media/:mediaId/:width` | Cookie + Medium der Vorschau-Revision (oder veröffentlicht) ⇒ `private, no-store`; sonst 404 |

Die SSR-Leserouten haben bewusst kein IP-Limit: Die Web-App liest sie serverseitig direkt an
`WEB_API_ORIGIN` – alle Aufrufe kommen von der IP des Web-Servers.

## Fehlercodes

Fehlerform `{ error: { code, message, correlationId, issues?: [{ path, message }] } }`; `issues`
nennen Feldpfade (z. B. `content.blocks.2.body`, `metaTitle`), nie Werte.

| Code | Status | Wann |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Schemafehler (Inhalt, Meta, Redaktionsnotiz, Regions-Slug, Medienfelder, Parameter) |
| `CMS_CONTENT_INVALID` | 400 | Veröffentlichen: Seitentyp-Regeln verletzt (Rechtstexte nur Textblöcke, mindestens einer) |
| `CMS_PUBLISH_INCOMPLETE` | 400 | Veröffentlichen einer Seite ohne Meta-Titel |
| `CMS_PRICE_TEXT_FORBIDDEN` | 400 | Preisangabe als Text (außer Rechtstexte) |
| `CMS_EXACT_ADDRESS_FORBIDDEN` | 400 | Text enthält die konfigurierte exakte Abholadresse (auch Rechtstexte) |
| `CMS_RECOMMENDATION_INVALID` | 400 | Empfehlungsregel verweist nicht auf eine aktive Slush-Maschine |
| `CMS_MEDIA_UNKNOWN` | 400 | referenzierte Medien-ID existiert nicht |
| `CMS_MEDIA_REJECTED` | 400 | Upload kein JPEG/PNG/WebP, getarnt, defekt, zu groß, kein Base64 |
| `NOT_FOUND` | 404 | Eintrag/Revision/Medium unbekannt; Revision eines anderen Eintrags |
| `CMS_DRAFT_CONFLICT` | 409 | `baseRevisionId` ≠ aktueller Entwurf (Speichern/Wiederherstellen) |
| `CMS_PUBLISH_STALE` | 409 | `revisionId` ≠ aktueller Entwurf |
| `CMS_ALREADY_PUBLISHED` | 409 | dieser Stand ist bereits veröffentlicht |
| `CMS_NOT_PUBLISHED` | 409 | Zurückziehen ohne veröffentlichten Stand |
| `CMS_UNPUBLISH_FORBIDDEN` | 409 | Zurückziehen eines anderen Typs als `region`/`secondary_offer` |
| `CMS_PATH_TAKEN` | 409 | Regionsseite mit bereits belegtem Pfad |
| `CMS_PREVIEW_UNAVAILABLE` | 409 | `MAIL_PUBLIC_WEB_BASE_URL` fehlt in dieser Umgebung |
| `CMS_PREVIEW_INVALID` | 401 | Vorschau-Token ungültig, abgelaufen oder verbraucht bzw. Vorschau-Cookie ungültig (neutral) |
| `FORBIDDEN` / `UNAUTHENTICATED` | 403 / 401 | fehlendes Recht bzw. keine Staff-Session |
| `CSRF_REJECTED` | 403 | Cross-/Same-Site-POST (globaler CSRF-Hook) |
| (Status 429) | 429 | Vorschau-Einlösen > 20/min je IP – `@fastify/rate-limit`; maßgeblich ist der Status, der Code ist der generische der API-Fehlerbehandlung (`BAD_REQUEST`, englische Plugin-Meldung) |
| `DEMO_RESET` | 503 | demo: Mutation während eines laufenden Resets |

Die Staff-App zeigt nie rohe Codes, sondern die Servermeldung und die `issues` am Feld.

## Prüfregeln (eine Stelle: `apps/api/src/cms/content-rules.ts`)

| Regel | Speichern / Wiederherstellen / Regionsanlage / Bootstrap | Veröffentlichen | Öffentlicher Lesepfad |
| --- | --- | --- | --- |
| Schema (`cmsPageContentSchema` / `cmsSiteSettingsSchema`) | ja | ja | ungültiger gespeicherter Inhalt gilt als nicht veröffentlicht (Log nur Eintrags-ID) |
| Preis-Freitext (`containsPriceText`; Text vorher NFKC-normalisiert, unsichtbare Formatzeichen entfernt; erkennt u. a. „60 €“, „60€“, „60,00 EUR“, „€ 60“, „EUR60“, „12 Euro“, „60 Euros“, „60,- €“, „60,– €“, „60.- €“, „60.- EUR“ und die Kurzform ohne Währung „60,-“/„60.-“; nicht „10-12 Uhr“, „12.-14. Juni“, „2 Europaletten“) in allen Texten, `title`, Meta | ja (außer `legal`) | ja (außer `legal`) | – |
| exakte Abholadresse (`pickup_exact_address`; Fragmente: ganze Adresse, jeder Teil mit Ziffer und Straße + Hausnummer – auch ohne Komma/mit PLZ vorn; Teile ohne Ziffer und reine „PLZ Ort“-Teile nie; Vergleich normalisiert (NFKC, Formatzeichen entfernt, URL-dekodiert, ß/Straße/Str. vereinheitlicht) und kompakt ohne Leerzeichen/Bindestriche/„Nr.“) | ja (auch `legal`) | ja | fail-closed: betroffene Blöcke/Felder entfallen; `title`/`metaTitle` betroffen ⇒ 404; Meta-Beschreibung betroffen ⇒ null; `businessName` betroffen ⇒ `settings: null`; Log `cms.public.exact_address_suppressed` nur mit Eintrags-ID |
| Medien existieren (`CMS_MEDIA_UNKNOWN`) | ja | ja | nur veröffentlichte Medien werden ausgeliefert |
| Empfehlungsregeln: aktive Slush-Maschine, keine Überschneidung | ja | ja | Regeln werden nie ausgeliefert; der Konfigurator wertet sie serverseitig aus |
| Seitentyp-Regeln (`cmsPageTypeIssues`) | nein (Entwürfe dürfen unfertig sein) | ja | `/datenschutz` zählt nur mit gültigem Rechtstext als veröffentlicht |
| Meta-Titel Pflicht | nein | ja (Seiten) | Fallback Seitentitel |

Ohne konfigurierte exakte Abholadresse gibt es keine Adressprüfung. Die öffentliche
Abholregion (Default „Mainz-Hechtsheim“) kommt aus `publicPickupArea`, das selbst fail-closed
auf den Default zurückfällt, falls die gepflegte Region die exakte Adresse enthielte.
Die Redaktionsnotiz wird nicht auf Preis-/Adresstext geprüft, ist aber nie öffentlich.
Der Adressabgleich ist bewusst fail-closed: ein Teilstring-Treffer (z. B. dieselbe Straße mit
einer Hausnummer, die mit der Abhol-Hausnummer beginnt) wird ebenfalls abgelehnt; Firmen- oder
Personennamen und die Region allein (Teile ohne Ziffer) lösen nie aus.

Produktdaten (`products.name`/`description`) sind keine CMS-Inhalte und werden beim Speichern
nicht geprüft; die öffentliche Katalog-Projektion ist aber ebenfalls fail-closed (siehe
„Öffentliche Projektion“).

## Audit

In derselben Transaktion wie die Änderung, Tabelle `staff_security_events`, Details nur IDs,
Revisionsnummern, Pfad und Quelle – nie Texte, nie Tokens:

| Ereignis | Details |
| --- | --- |
| `cms.published` | `{ entryId, revisionId, revisionNumber, previousRevisionId, path, source: 'staff' \| 'bootstrap' }` (`actorUserId` null bei `bootstrap`) |
| `cms.unpublished` | `{ entryId, revisionId, revisionNumber, path, source: 'staff' }` |
| `cms.preview_created` | `{ entryId, revisionId }` |

## Medien

Upload (`apps/api/src/cms/media-service.ts`), Reihenfolge:

1. Größe roh 1 B … 6 MiB (Base64-JSON, Routen-Body-Limit 9 MiB).
2. Deklarierter Typ (normalisiert, nur `image/jpeg`, `image/png`, `image/webp`) muss zu den Magic
   Bytes passen (`detectImageMime`). SVG, HTML, GIF, HEIC und getarnte Dateien ⇒ 400
   `CMS_MEDIA_REJECTED`.
3. Erst dann Decode mit sharp (`failOn: 'error'`, `limitInputPixels: 40_000_000`); das Format aus
   dem Decode muss erneut passen.
4. EXIF-Ausrichtung anwenden, neu kodieren als WebP (Qualität 82) in den Breiten 480/960/1600,
   jeweils nur ≤ Originalbreite (mindestens eine Variante; schmaler als 480 ⇒ eine Variante in
   Originalbreite). Animierte WebP: nur das erste Bild.
5. Kein Original gespeichert, keine Metadaten (EXIF/XMP/ICC/GPS entfallen).
6. Storage-Keys `cms-media/<mediaId>/<breite>.webp` über den bestehenden `StorageProvider` – nie in
   DTOs, Logs oder URLs. Scheitert ein Schritt nach dem Schreiben, werden nur die eigenen Keys
   entfernt (keine Bucket-weiten Operationen).

Auslieferung nur über die opake Medien-ID: öffentlich ausschließlich Medien, die in
`cms_revision_media` einer aktuell VERÖFFENTLICHTEN Revision stehen, und nur in den
vorhandenen Breiten – erratene IDs von Entwurfsmedien liefern 404. Antwort-Header:
`Content-Type: image/webp`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`.
`cms_revision_media` wird bei JEDER Revision befüllt (Speichern, Wiederherstellen,
Regionsanlage, Bootstrap).

**Caching-Hinweis:** Veröffentlichte Varianten tragen `Cache-Control: public, max-age=31536000,
immutable`. Ein einmal veröffentlichtes Bild kann deshalb bis zu ein Jahr in Browser-Caches
bleiben – auch nachdem die Seite zurückgezogen oder das Bild aus dem Entwurf entfernt wurde.
Inhalte, die nie öffentlich sein dürfen, also nie veröffentlichen. Vorschau- und Staff-Medien
sind `private, no-store`. Medien werden in Phase 16 nicht gelöscht (die Historie referenziert
sie).

## Vorschau

Die Vorschau nutzt den ECHTEN Web-Renderer (`apps/web/components/site/block-renderer.tsx`),
nicht eine Staff-Nachbildung. Es wird keine Staff-Session an die Web-Origin übertragen.

1. **Zugang erzeugen** (Staff): `POST /staff/cms/entries/:id/preview`. 32 Zufallsbytes
   base64url (43 Zeichen); in der DB nur der SHA-256-Hash; gültig 30 Minuten (absolut); an
   genau eine Revision des Eintrags gebunden (fremde Revision ⇒ 404). Abgelaufene Zugänge
   (älter als 1 Tag nach Ablauf) werden beim Erzeugen neuer Zugänge gelöscht (kein eigener
   Scheduler). Antwort `{ url, expiresAt }` mit
   `url = ${MAIL_PUBLIC_WEB_BASE_URL}/vorschau#token=<token>` – das Token steht im
   URL-Fragment und erreicht nie einen Server-Log. Ohne `MAIL_PUBLIC_WEB_BASE_URL` ⇒ 409
   `CMS_PREVIEW_UNAVAILABLE` (kein Fallback auf localhost).
2. **Staff-App** öffnet den Tab im Klick (`about:blank`), setzt nach der Antwort
   `opener = null` und leitet per `location.replace(url)` weiter; bei blockiertem Popup ein
   einmal nutzbarer Link mit `rel="noopener noreferrer"`.
3. **Web `/vorschau`** (Server-Hülle mit Origin-Prüfung, Client-Einlösung wie
   `/konto/anmelden`): liest `#token=`, entfernt das Fragment sofort, `POST
   /api/public/cms/preview/consume { token }` (`referrerPolicy: no-referrer`).
4. **API Consume**: atomar `UPDATE … SET consumed_at, session_token_hash WHERE
   access_token_hash = $1 AND consumed_at IS NULL AND expires_at > now RETURNING` – einmalig.
   Cookie `__Host-mr_cms_preview` (development: `mr_cms_preview`), HttpOnly, Secure (außer
   development), SameSite=Strict, Path=/, ohne Domain, Max-Age = Restlaufzeit des Zugangs.
   Ungültig, abgelaufen oder verbraucht ⇒ 401 `CMS_PREVIEW_INVALID` (neutral).
5. **Web `/vorschau/seite`** (Server-Komponente) liest das Cookie und ruft
   `GET <WEB_API_ORIGIN>/public/cms/preview/page` mit genau diesem Cookie. Banner „Vorschau –
   Entwurf (Revision n), nicht veröffentlicht“ + Ablaufzeit. Bei einer Vorschau der
   Website-Einstellungen enthält `settings` den Entwurf und `page` die veröffentlichte
   Startseite (ohne sie den Fallback).
6. **Header**: API-Vorschauantworten `Cache-Control: private, no-store`,
   `X-Robots-Tag: noindex, noarchive`, `Referrer-Policy: no-referrer`; Web `/vorschau` und
   `/vorschau/:path*` (`apps/web/next.config.ts`) `Cache-Control: private, no-store, max-age=0`,
   `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`,
   `X-Frame-Options: DENY`, `nosniff`.
7. **Isolation**: Öffentliche Site-Routen lesen das Vorschau-Cookie nie (kein Draft-Leak über
   Caches). Tokens erscheinen nie in Logs, Audit, Query-Strings oder Fehlerbodies. Demo und
   Live sind getrennt, weil jede Umgebung ihre eigene Datenbank hat (ein Zugang aus DB A ist in
   DB B unbekannt).
8. **Build-/Laufzeit-Origin**: Weicht `WEB_API_ORIGIN` zur Laufzeit vom beim Build
   eingebackenen API-Origin ab, bleibt die Vorschau gesperrt (ebenso Konfigurator-Absenden und
   Bewertungs-Sektion; siehe
   [DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md) „Website, CMS, Konfigurator, Bewertungen
   (Phase 16)“).

## Öffentliche Projektion (`apps/api/src/cms/public-site.ts`)

- `PublicSiteSettings { businessName, tagline, phone, email, instagramUrl, logo, footerNote }` –
  keine Empfehlungsregeln.
- `PublicPage { path, pageType, revisionId, publishedAt (null nur in der Vorschau), title,
  metaTitle, metaDescription, blocks }`.
- Jede Bildreferenz wird zu `PublicImage { mediaId, alt ('' wenn dekorativ), decorative,
  width, height (= größte Variante), variants: [{ width, url }] }` mit
  `url = /api/public/cms/media/<id>/<w>` (Vorschau `/api/public/cms/preview-media/<id>/<w>`).
- `product_grid` erhält `products` (aktive Produkte mit wirksamem Preis zum Abrufzeitpunkt),
  `included_items` erhält `included`, `syrups`, `accessories`, `canister` aus
  `buildPublicCatalog` (`apps/api/src/public/catalog.ts`). Keine IDs, keine Bestände, keine
  Historie, keine internen Felder.
- Exakte Abholadresse in Produktdaten (fail-closed, gleiche Fragmente wie oben, einmal je
  Request geladen): enthält die Produktbeschreibung sie ⇒ `description: null`; enthält der
  Produktname sie ⇒ das Produkt entfällt öffentlich ganz (`product_grid`, `included_items`,
  Konfigurator-Katalog, Staff-Lesesicht `/staff/cms/catalog`; im Konfigurator zusätzlich nicht
  wählbar und nie empfohlen). Log `public.catalog.exact_address_suppressed` nur mit
  `productSlug`, nie dem Text.
- Preisangaben in Produktdaten (Phase 17, Auftrag §23, fail-closed – Preis-Guard,
  `apps/api/src/public/catalog.ts`): enthält die Produktbeschreibung einen Preis-Freitext
  (`containsPriceText`, dieselbe Erkennung wie die CMS-Prüfregel inkl. Cent-Beträgen) ⇒
  `description: null`; enthält der Produktname oder die Verkaufseinheit (`saleUnit`, öffentlich
  `unitLabel`) einen ⇒ das Produkt entfällt öffentlich ganz (Katalog, `product_grid`,
  `included_items`, Konfigurator-Auswahl, Inklusiv-Pack, Empfehlung, Website-Anfrage,
  Staff-Lesesicht) – wie beim Adress-Guard, der seit Phase 17 ebenfalls die Verkaufseinheit
  prüft. Der Preis bleibt ausschließlich `priceCents` aus `product_prices`; Log
  `public.catalog.price_text_suppressed` nur mit `productSlug` und Feldname. Interne
  Produktdaten (`/staff/products`) bleiben unverändert; der SEO-Check meldet den Fall
  (`PRODUCT_*_PRICE_HIDDEN`). **Für die Redaktion: Preise gehören nicht in Produktnamen,
  -beschreibungen oder Verkaufseinheiten – die Website blendet sie aus.**
- Nie enthalten: Redaktionsnotiz, Staff-IDs, Storage-Keys, Entwurfsinhalte.
- `pages` im Bootstrap listet nur veröffentlichte Seiten (Pfad, Typ, Titel, Meta-Beschreibung;
  seit Phase 17 `publishedAt` = ISO-Zeitpunkt der letzten Veröffentlichung als Grundlage für
  `lastModified` der Sitemap; Einträge ohne `published_at` entfallen fail-closed); Navigation,
  Fußzeile und Links des Web-Renderers richten sich danach. Der Bootstrap enthält seit Phase 17
  außerdem `publicBaseUrl: string | null` (= `MAIL_PUBLIC_WEB_BASE_URL` ohne Schluss-Slash, ohne
  Konfiguration `null`) – die einzige Quelle absoluter SEO-URLs des Web (Canonical, `og:url`,
  Sitemap, JSON-LD; nie Host-Header), siehe [SEO_TECHNICAL.md](SEO_TECHNICAL.md).

## Bootstrap (`pnpm cms:bootstrap`)

Root-Skript → `pnpm --filter @mietroyal/api cms:bootstrap` → `apps/api/scripts/cms-bootstrap.ts`
(Logik `apps/api/src/cms/bootstrap.ts`, Inhalte `apps/api/src/cms/bootstrap-content.ts`).

- Legt FEHLENDE Einträge aus `CMS_BOOTSTRAP_ENTRIES` als Entwurf an (Revision 1,
  `created_by` NULL). Idempotent: Ein vorhandener Eintrag bleibt unberührt – auch wenn er leer
  ist; Redaktionsarbeit wird nie überschrieben. Dieselben Prüfregeln wie beim Speichern;
  ungültige Einträge werden gemeldet und nicht angelegt.
- Ohne Flag wird NICHTS veröffentlicht. Läuft nie automatisch (kein API-Start, keine Migration,
  kein Deployment) und wendet keine Migrationen an (`pnpm db:migrate` ist ein eigener Schritt).
- `--publish-demo`: nur bei `APP_ENV` development oder demo (die Bootstrap-Funktion erlaubt
  zusätzlich `test` für Integrationstests). production/staging ⇒ Abbruch mit Exit 2 VOR jeder
  Änderung (bereits anhand der rohen Umgebungsvariable, vor dem Laden der Konfiguration).
  Veröffentlicht die Entwürfe aller Einträge, die noch NIE veröffentlicht waren (kein
  veröffentlichter Stand UND kein früheres `cms.published`-Audit – bewusst zurückgezogene
  Seiten bleiben zurückgezogen) über `CmsService.publish` mit denselben Prüfungen und Audit
  `cms.published` (`source: 'bootstrap'`). Achtung: Das veröffentlicht in development/demo auch
  die Rechtstext-ENTWÜRFE inklusive Platzhalter.
- Aufruf mit der vollständigen Server-Konfiguration der Zielumgebung (wie `pnpm db:migrate`;
  `APP_ENV` ist Pflicht). Ausgabe nur Pfade, Zähler und Fehlercodes – nie Inhalte oder Secrets.
  Exit-Code 1, wenn ein Eintrag ungültig ist oder nicht veröffentlicht werden konnte.

### Bootstrap-Inhalte (redaktionelle Erst-Entwürfe)

14 Einträge, alle als Entwurf, jeweils mit Redaktionsnotiz (interne Prüfliste):

| Eintrag | Pfad | Hinweise |
| --- | --- | --- |
| Website-Einstellungen | – | Firmenname „Miet-Royal“, Kurzbeschreibung, Kontaktwerte aus der bisherigen Website als ENTWURF („vor Veröffentlichung bestätigen“), KEINE Instagram-URL, KEIN Logo, `recommendationRules: []` |
| Startseite | `/` | Hero mit „Slush konfigurieren“ → `/konfigurator` und „Unverbindlich anfragen“ → `/kontakt` |
| Slush | `/slushmaschine-mieten` | Produkte/Inklusivleistungen nur über `product_grid`/`included_items`; Meta-Titel in Phase 17 auf ≤ 60 Zeichen gekürzt (SEO-Check ohne Hinweis) |
| Ablauf | `/ablauf` | |
| FAQ | `/faq` | |
| Über uns | `/ueber-uns` | Fakten nur von der bisherigen Website ⇒ Inhaber-Bestätigung nötig |
| Kontakt | `/kontakt` | Kontaktwerte nur über `contact_details` |
| Impressum | `/impressum` | redaktioneller Entwurf aus der bisherigen Website, „vor Live rechtlich prüfen“; Anschrift als Platzhalter „[vor Veröffentlichung eintragen]“ |
| Datenschutz | `/datenschutz` | redaktioneller Entwurf aus der bisherigen Website (auf „du“ umgestellt, nicht juristisch repariert), „vor Live rechtlich prüfen“ |
| Popcorn | `/popcornmaschine-mieten` | nur Struktur, keine Preise, Inklusivleistungen, Transportangaben oder Zahlen |
| Waffel | `/waffeleisen-mieten` | wie Popcorn |
| Mainz, Wiesbaden, Bad Kreuznach | `/slushmaschine-mieten/<ort>` | je eigener Inhalt und Aufbau (keine Ortsnamen-Schablone), „vor Veröffentlichung lokal prüfen“ |

Fakten-Grenzen (geprüft in `apps/api/test/cms-bootstrap-content.test.ts`): keine Preise im
Text, keine Kapazität je Zeiteinheit, keine Lieferpreise, kein „buchen“, keine
Bewertungen/Zähler/Referenzen, keine Medien, keine Instagram-URL, Abholung nur
„Mainz-Hechtsheim“, keine exakte Adresse (auch nicht in Rechtstexten oder Notizen), Ansprache
„du“, alle Links auf existierende Seiten bzw. `mailto:`/`tel:`. Mengenangaben aus MASTER_SPEC
(z. B. 1 L je Behälter, 25 + 25 je Mietvorgang, 2 Kanister je Behälter, 250 Gäste) stehen als
Text und müssen bei einer Regeländerung manuell nachgezogen werden.

## Staff-Bereich `/website`

Navigationseintrag „Website“ bei `cms.edit` ODER `cms.publish` (`apps/staff/components/auth-guard.tsx`).

- **Übersicht** `/website` (`apps/staff/app/website/page.tsx`): Gruppen Einstellungen,
  Hauptseiten, Regionale Seiten, Sekundäre Angebote, Rechtliches; Status als Text (nie nur
  Farbe), Revisionsnummern, Datum; „Regionale Seite anlegen“ (`cms.edit`).
  Phase 17: Kasten „Hinweise zur Suchmaschinen-Darstellung“ (`cms-seo-warnings`) oberhalb der
  Gruppen – nur wenn Hinweise vorliegen – mit dem Satz „Das sind Hinweise für die Redaktion –
  nichts wird blockiert.“; je Eintrag die Zählzeile „n Hinweise zur Suchmaschinen-Darstellung“
  (`cms-entry-seo-count`); Katalog-Hinweise verlinken „Produkte & Preise öffnen“ auf die
  Produktverwaltung `/produkte` (nur mit `product.view`). Details Abschnitt „SEO-Hinweise im
  Staff (Phase 17)“.
- **Editor** `/website/eintrag/[id]` (`apps/staff/app/website/eintrag/[id]/page.tsx`): Titel,
  Meta-Titel/-Beschreibung mit Zeichenzählern, Blockliste (hinzufügen – Hero nur als erster
  Block, Rechtstexte nur Text –, verschieben, entfernen mit Bestätigung), Formulare je Blocktyp
  (`apps/staff/components/cms-fields.tsx`), Bildwahl aus der Medienliste mit Alt-Text bzw.
  „dekorativ“, Redaktionsnotiz. Clientseitige Vorprüfung mit denselben Schemas (nur UX).
  „Entwurf speichern“ (`cms.edit`), „Vorschau öffnen“ (neuer Tab, 30 min, einmal einlösbar),
  „Veröffentlichen“ (`cms.publish`, Bestätigungsdialog „Revision n veröffentlichen?“, gesperrt
  bei ungespeicherten Änderungen), „Zurückziehen“ (nur bei `canUnpublish`), Historie mit
  „Ansehen“, Vorschau einer alten Revision und „Als neuen Entwurf übernehmen“ (`cms.edit`).
  Nur-Publisher ⇒ Lesemodus. Konflikt (`CMS_DRAFT_CONFLICT`/`CMS_PUBLISH_STALE`) ⇒ „Der Entwurf
  wurde inzwischen geändert – bitte neu laden.“
  Phase 17: unter der Meta-Beschreibung der Kasten „Hinweise zu Titel, Beschreibung und
  Inhalt“ (`cms-seo-entry-warnings`, nur die Hinweise dieses Eintrags, Geltungsbereich als Text
  „Veröffentlicht“/„Entwurf“), neu geladen nach Speichern, Veröffentlichen, Zurückziehen und
  „Als neuen Entwurf übernehmen“; kein Knopf hängt davon ab.
- **Website-Einstellungen** im selben Editor (`apps/staff/components/cms-settings-form.tsx`):
  Firmenname, Kurzbeschreibung, Logo, Fußzeile, Telefon, E-Mail, Instagram-Link,
  Empfehlungsregeln (Gäste ab/bis ⇒ Maschine nur aus `GET /staff/cms/catalog`, Überschneidungen
  werden live angezeigt, leer erlaubt, keine Vorbelegung).
- **Medien** `/website/medien`: Upload (Bezeichnung, JPEG/PNG/WebP ≤ 6 MiB, Hinweis
  „Metadaten werden entfernt“), Liste mit Vorschau, Abmessungen, Varianten, „Auf der Website
  veröffentlicht“, Bezeichnung und Standard-Alt-Text bearbeiten. Kein Löschen.
- **Produkte & Preise** `/website/produkte` (`product.view`): Lesesicht der öffentlichen
  Projektion („So erscheinen Produkte und Preise auf der Website“) + Link „Preise und Produkte
  ändern“ nach `/produkte` (Änderung nur dort, `price.manage`). Keine Berechnung im Browser.
- **Offline**: Der CMS-Bereich ist online-only (Aktionsknöpfe offline deaktiviert,
  `ONLINE_REQUIRED`), CMS-Seiten liegen nicht im Offline-Vorabcache.

## Web-Renderer (`apps/web`)

- Seiten: `/`, `/slushmaschine-mieten`, `/slushmaschine-mieten/[region]`, `/ablauf`, `/faq`,
  `/ueber-uns`, `/kontakt`, `/impressum`, `/datenschutz`, `/popcornmaschine-mieten`,
  `/waffeleisen-mieten` (je `apps/web/app/<pfad>/page.tsx` über `CmsRoute` in
  `apps/web/components/site/cms-route.tsx`), dazu `/konfigurator`, `/vorschau`,
  `/vorschau/seite`, `not-found`.
- SSR liest `/public/site/*` direkt an `WEB_API_ORIGIN` (`apps/web/lib/site-api.ts`,
  `cache: 'no-store'`, Timeout 2,5 s, je Request per React `cache` dedupliziert).
  Nicht veröffentlicht ⇒ echter 404 mit Seitenrahmen; API nicht erreichbar ⇒ freundliche
  Seite „Gleich wieder da“ (immer noindex). Startseite ohne veröffentlichten Inhalt ⇒ schlichter
  Fallback (Wortmarke, „Unsere neue Website wird gerade vorbereitet.“, CTA „Slush
  konfigurieren“), ebenfalls immer noindex – auch bei `WEB_INDEXING_ENABLED=true`.
- EIN Block-Renderer für öffentliche Seiten und Vorschau (alle 14 Blocktypen,
  `switch` mit `never`-Prüfung); Texte nur als React-Text, kein `dangerouslySetInnerHTML`;
  Bilder `<img>` mit `srcSet` nur aus den opaken Medienrouten; dekorativ ⇒ `alt=""` +
  `aria-hidden`.
- `reviews` erscheint nur bei `reviews.mode ≠ 'disabled'` als Klick-zum-Laden-Sektion
  (`apps/web/components/site/reviews-section.tsx`, Logik `apps/web/lib/reviews.ts`):
  - fail-closed: Weicht der Build-Origin der API vom Laufzeit-Origin ab, gibt es keine
    Bewertungs-Sektion (der Klick ginge sonst über den eingebackenen Rewrite an eine andere
    Umgebung). Eine Antwort, deren `mode` nicht dem Modus der Seite entspricht, wird verworfen
    ⇒ „Bewertungen sind gerade nicht verfügbar.“
  - Google-Modus: Attribution mit dem offiziellen Google-Maps-Logo (Phase 17: unverändertes
    Asset aus `apps/web/public/google-maps-logo-gray.svg`, 18 px hoch, `alt="Google Maps"`,
    `translate="no"`, eigenständig neben der Gesamtbewertung, verlinkt auf den Ort bei Google
    Maps; Details [GOOGLE_REVIEWS_API_NOTES.md](GOOGLE_REVIEWS_API_NOTES.md) „Logo-Attribution“);
    „Google Maps“ in den Linktexten „Alle Bewertungen auf Google Maps“ und „Auf Google Maps
    ansehen“ weiterhin `translate="no"` ohne Zeilenumbruch; der Richtlinienhinweis von Google mit
    Link „Zur Richtlinie von Google für Bewertungen“ (lokaler Fallback, falls die API-Felder
    fehlen), bei übersetzten Bewertungen „Von Google übersetzt“ und der Originaltext optional zum
    Aufklappen („Originaltext anzeigen“).
  - Demo: „DEMO – synthetische Beispielbewertungen“, nie „Google“.
- `contact_details` (Logik `contactDetailsPlan` in `apps/web/lib/site-blocks.ts`): Telefon-Links
  ohne die geklammerte Verkehrsausscheidungsziffer nach der Ländervorwahl (aus „+49 (0) …“ wird
  `tel:+49…`; gilt auch für die Fußzeile). Auf Popcorn-/Waffel-Seiten (`secondary_offer`) nur
  Telefon und E-Mail – ohne die Zeile „Abholung: …“, ohne Instagram-Eintrag und ohne den Knopf
  „Unverbindlich anfragen“ → `/konfigurator` (der Konfigurator kann nur Slush); ohne gepflegte
  Kontaktwerte dort „Unsere Kontaktdaten ergänzen wir hier in Kürze.“ (ohne
  Konfigurator-Verweis). Andere Seitentypen unverändert.
- Meta (Phase 17, Details [SEO_TECHNICAL.md](SEO_TECHNICAL.md)): Titel aus `metaTitle` bzw.
  `title` (+ „ – Miet-Royal“, wenn nicht enthalten), Beschreibung aus `metaDescription` (fehlt
  sie, gibt es keine – nichts wird erfunden); KEIN Titel-Template im Root-Layout (Portal-/
  Token-Titel unverändert), das Root-Layout setzt `robots` immer auf noindex. Jede Website-Seite
  setzt `robots`, Canonical, OpenGraph (`type website`, `locale de_DE`, `siteName` = Firmenname)
  und Twitter Card selbst; `index, follow`, Canonical, `og:url` und Social Image gibt es nur im
  indexierbaren Kontext (`WEB_INDEXING_ENABLED=true`, keine Demo, gültige Basis `publicBaseUrl`,
  keine Origin-Sperre) und nur für veröffentlichte Seiten. Social Image: nur das Bild eines
  `hero`-Blocks an erster Stelle (größte veröffentlichte Variante als absolute Medien-URL, `alt`
  nur wenn nicht dekorativ) – ohne Hero-Bild bleiben OpenGraph/Twitter ohne Bild; das Logo der
  Einstellungen ist kein `og:image`. Immer noindex: Demo-Web-Instanz, Zustandsseiten
  (Fallback-Startseite, „Gleich wieder da“), `/konfigurator` ohne Katalog, ohne wählbare
  Maschine, ohne veröffentlichte Datenschutzhinweise oder mit Origin-Sperre
  (`apps/web/lib/site-meta.ts`). 404: Titel „Seite nicht gefunden – Miet-Royal“, Status 404,
  noindex – auch für unveröffentlichte oder zurückgezogene CMS-Seiten.
- Brotkrume (Phase 17): nur auf Regionsseiten (`Start › <Titel der veröffentlichten
  Slush-Seite> › <Seitentitel>`) und sekundären Angeboten (`Start › <Seitentitel>`), mit
  `BreadcrumbList`-JSON-LD nur auf indexierbaren Seiten; in der Vorschau sichtbar ohne JSON-LD.
  Startseite und Hauptseiten haben keine Brotkrume.
- Gestaltung und Navigation: [UX_RULES.md](UX_RULES.md) „Website“.

## Demo und Umgebungen

- Demo-CMS nur in der Demo-Datenbank und im Demo-Storage; keine gemeinsamen Vorschau-Tokens;
  der DEMO-Banner gilt auf allen öffentlichen Seiten (Root-Layout). Die Demo-Web-Instanz ist
  immer `noindex` – auch wenn dort `WEB_INDEXING_ENABLED=true` gesetzt wäre.
- Der Demo-Business-Reset löscht keine CMS-Tabellen und keine CMS-Medien (Storage-Keys der
  CMS-Varianten stehen nicht auf der Reset-Löschliste); Redaktionsinhalt überlebt.
- In demo unterliegen alle CMS-Mutationen (`/staff/cms/*` und `POST
  /public/cms/preview/consume`) Reset-Gate und Barrier (503 `DEMO_RESET`).

## SEO-Hinweise im Staff (Phase 17)

`GET /staff/cms/seo-check` (Recht `cms.edit` ODER `cms.publish`, `Cache-Control: no-store`, kein
Audit; Kernfunktion `computeSeoWarnings` in `apps/api/src/cms/seo-check.ts`) liefert
`{ checkedAt, warnings: SeoWarning[] }` mit
`SeoWarning { code, scope: 'published' | 'draft' | 'catalog', entryId, path, field, message }`.
Geltungsbereiche: `published` = veröffentlichte Revision; `draft` = aktueller Entwurf nur, wenn er
vom veröffentlichten Stand abweicht oder nie veröffentlicht wurde (keine doppelten Hinweise);
`catalog` = Produktdaten der öffentlichen Projektion (ohne `entryId`/`path`). Reihenfolge:
veröffentlicht, Entwurf, Katalog; darin Pfad, Code, Meldung. Meldungen sind deutsch, ohne Code
und nennen nie einen Preis oder die Adresse. **Nie blockierend:** Speichern, Vorschau und
Veröffentlichen hängen nicht an den Hinweisen; kein Score, keine automatische Umschreibung –
die Redaktion entscheidet. `site_settings` werden nicht geprüft.

| Code | Bedeutung |
| --- | --- |
| `META_TITLE_MISSING` | Meta-Titel fehlt (Entwurf: ohne Meta-Titel kein Veröffentlichen möglich) |
| `META_TITLE_SHORT` / `META_TITLE_LONG` | Meta-Titel < 20 bzw. > 60 Zeichen (Suchmaschinen kürzen; Empfehlung, keine Grenze des Schemas) |
| `META_DESCRIPTION_MISSING` | Meta-Beschreibung fehlt |
| `META_DESCRIPTION_SHORT` / `META_DESCRIPTION_LONG` | Meta-Beschreibung < 50 bzw. > 160 Zeichen |
| `META_TITLE_DUPLICATE` / `META_DESCRIPTION_DUPLICATE` | exakt gleicher Wert auf mehreren Seiten (NFKC, getrimmt, klein, Leerraum zusammengefasst; veröffentlichte Seiten und Entwürfe getrennt; Meldung nennt alle Pfade) |
| `PAGE_EMPTY` | Seite ohne Blöcke bzw. ohne eigenen Text (nur Bilder/automatisch befüllte Bausteine) |
| `BROKEN_INTERNAL_LINK` | interner Link auf eine CMS-Seite, die die Website nicht ausliefert (nicht veröffentlicht, ungültiger Inhalt oder fail-closed wegen der Abholadresse); App-Pfade `/`, `/konfigurator`, `/konto/…` gelten als vorhanden |
| `REGION_NEAR_DUPLICATE` | zwei Regionsseiten mit nahezu identischem Text (Jaccard der Wort-3-Gramme ≥ 0,6, ab 30 Trigrammen zusätzlich Containment ≥ 0,6 für Teilkopien – ein Ortsnamen-Tausch wird erkannt) |
| `PAGE_SUPPRESSED` | veröffentlichte Seite, die die Website fail-closed nicht ausliefert, weil Titel oder Meta-Titel die exakte Abholadresse enthalten |
| `PRODUCT_DESCRIPTION_PRICE_HIDDEN` | Produktbeschreibung mit Preisangabe – die Website blendet die Beschreibung aus |
| `PRODUCT_NAME_PRICE_HIDDEN` / `PRODUCT_UNIT_PRICE_HIDDEN` | Produktname bzw. Verkaufseinheit mit Preisangabe – das Produkt erscheint nicht auf der Website; in der Produktverwaltung („Produkte & Preise“, `/produkte`) anpassen |

Staff-Darstellung (`SeoWarningsBox`, `apps/staff/components/website.tsx`): Übersicht
`/website` Kasten „Hinweise zur Suchmaschinen-Darstellung“ (`cms-seo-warnings`, je Zeile
`cms-seo-warning` mit `data-code`/`data-scope`/`data-entry-id`, Link „Bearbeiten“ zum Eintrag,
bei Katalog-Hinweisen „Produkte & Preise öffnen“ → `/produkte` nur mit `product.view`) und
Zählzeile je Eintrag; Editor Kasten „Hinweise zu Titel, Beschreibung und Inhalt“
(`cms-seo-entry-warnings`) unter den Meta-Feldern, neu geladen nach jeder Änderung des Eintrags.
Geltungsbereich als Text („Veröffentlicht“, „Entwurf“, „Produkte & Preise“); unbekannte Codes
werden mit ihrer Meldung angezeigt. Schlägt der Abruf fehl (401/403, offline, 5xx, Demo-Reset),
fehlt der Kasten still – kein Fehlerhinweis, keine Sperre.

## Phase 17 (umgesetzt)

Phase 16 lieferte Meta-Titel/-Beschreibung im CMS, semantische Überschriften, serverseitig
gerenderte Inhalte, stabile URLs, Alt-Texte und responsive Layouts. Phase 17 ergänzt: fail-closed
Indexierbarkeit mit konfigurierter Basis, Canonicals, robots.txt, dynamische Sitemap aus
veröffentlichten Seiten, OpenGraph/Twitter, strukturierte Daten, Brotkrumen, 404-Metadaten,
410-Seite und Redirect-/410-Matrix der Alt-URLs ([SEO_TECHNICAL.md](SEO_TECHNICAL.md),
[REDIRECT_MATRIX.md](REDIRECT_MATRIX.md), [SEO_STRUCTURED_DATA_NOTES.md](SEO_STRUCTURED_DATA_NOTES.md)),
die SEO-Hinweise im Staff, den Preis-Guard der Produktprojektion und die technische QA
([WEBSITE_QA_REPORT.md](WEBSITE_QA_REPORT.md)). Nicht Teil von Phase 17: DNS-Umschaltung,
Indexierung einschalten, Search Console, Ranking-Prüfung, juristische Freigabe der Rechtstexte
([OPEN_ITEMS.md](OPEN_ITEMS.md) „Phase 17“).

## Tests

Siehe [TEST_PLAN.md](TEST_PLAN.md) „Website, CMS, Konfigurator, Bewertungen (Phase 16)“
(u. a. `apps/api/test/cms-*.integration.test.ts`, `packages/validation/test/cms.test.ts`,
`apps/api/test/cms-bootstrap-content.test.ts`, `apps/web/lib/*.test.ts`) und „SEO, Redirects,
technische QA (Phase 17)“ (SEO-Check SEO-U*/SEO-API*, Preis-Guard SEO-P*, Web SEO-W*, E2E-Projekt
`seo`).
