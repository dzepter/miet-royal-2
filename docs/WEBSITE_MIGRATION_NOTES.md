# WEBSITE_MIGRATION_NOTES — Inventur der bisherigen Website miet-royal.de

**Stand:** 06.11.2026 (Phase 16, Order §24). Grundlage: einmalige, rein lesende Inventur der
Live-Website `https://miet-royal.de/` (nur GET-Abrufe von Seiten, Sitemaps, `robots.txt`,
WP-REST-Listen und Bild-Anfängen; kein Formular abgesendet, kein Login, keine Änderung).

**Wichtig**

- Die bestehende Live-Website bleibt **unverändert online** – keine DNS-/Domain-Umschaltung,
  kein Löschen von WordPress, keine Änderung an Inhalten oder Plugins.
- **Phase 16 setzt keine Redirects um.** Redirect-/410-Matrix Alt → Neu, Sitemap, Robots,
  Canonicals, strukturierte Daten und die Prüfung alter URLs/Rankings sind **Phase 17**. Die
  Spalte „inhaltliche Entsprechung“ in §2 ist nur eine Orientierung, keine Redirect-Entscheidung.
- **Nichts kopiert:** Keine Bilder, Logos, Videos, PDFs, CSS oder Skripte der Alt-Seite liegen im
  Repository. Texte wurden nur als **redaktionelle Entwürfe** in die CMS-Bootstrap-Inhalte
  übernommen (`apps/api/src/cms/bootstrap-content.ts`, §7), jeweils mit interner
  Redaktionsnotiz.
- Die **exakte Abholadresse** stand auf der Alt-Seite öffentlich (Kontaktseite und
  Datenschutzerklärung). Sie steht bewusst **nicht** in diesem Dokument und nirgends in den neuen
  Inhalten; öffentlich gilt nur „Mainz-Hechtsheim“ (MASTER_SPEC §8).
- Rechtstexte (Impressum/Datenschutz): Befunde in §5 sind Beobachtungen, **keine
  Rechtsberatung** – vor Live rechtlich prüfen.

## 1 Technik der Alt-Seite

- Domain `https://www.miet-royal.de/` → `301` → `https://miet-royal.de/` (Apache).
- WordPress 6.9.x mit Theme „Hello Elementor“ (+ Child-Theme), Page-Builder Elementor/Elementor
  Pro; Plugins u. a. ElementsKit Lite, Jeg Elementor Kit (Zähler, Video-Button,
  Mailchimp-Formular), MetForm (Kontaktformular), Popup Builder, ShopEngine, WooCommerce
  (inkl. Order Attribution mit `allowTracking`), Chaty (WhatsApp-/Telefon-Widget), CookieYes
  (Banner mit Kategorien Analytics/Advertisement), Rank Math (SEO/Sitemaps). Reste eines
  Buchungs-Plugins (BookingPress) mit roh ausgegebenen Shortcodes.
- Keine Analyse-/Werbe-Tracker im HTML gefunden (kein Google Analytics/Tag Manager, kein
  Meta-Pixel, kein Clarity/Hotjar).
- **Keine Inhaltsseite hat ein `<h1>`** (Seitentitel vom Theme ausgeblendet).
- Strukturierte Daten (Rank Math, `Organization`): `legalName` = `techremedys` (Agentur-/
  Autorenkennung statt Miet-Royal), Logo = Favicon-JPEG. WordPress-Autor ebenfalls
  `techremedys`. → falsch, nicht übernehmen.
- Fußzeile: „© 2025 Miet Royal. Alle Rechte vorbehalten.“; Social-Icons Facebook/Twitter/
  YouTube **ohne Link-Ziel**.
- Schrift Poppins, extern von Google Fonts geladen; Google-Maps-iframe (nur „Mainz“) in der
  Fußzeile jeder Seite.

## 2 Öffentliche URLs

Quellen: `robots.txt`, `sitemap_index.xml` (Rank Math: Post-, Page-, MetForm-, Kategorie-
Sitemap), WP-REST (21 Seiten, 1 Beitrag), Hauptnavigation.

Hauptnavigation: Maschinen & Zubehör · Ablauf & Preise · Buchung · Über uns · Kontakt,
Header-Button „Jetzt buchen“ (→ `/buchung/`). Fußzeile: Impressum, Datenschutz.

### 2a Inhaltsseiten (relevant für Phase 17)

| Alt-URL | `<title>` | Meta-Description (gekürzt) | robots | zuletzt geändert | inhaltliche Entsprechung neu (nur Orientierung) |
| --- | --- | --- | --- | --- | --- |
| `/` | Miet Royal Mainz – Slushmaschinen & Funfood Mieten | „Slushmaschinen, Popcorn & Funfood Geräte in Mainz & Wiesbaden mieten …“ | index | 2026-06-23 | `/` |
| `/maschinen-zubehoer/` | Maschinen & Zubehör - Miet Royal | „1 Liter Sirup / Ergibt 6 Liter Slush = 30 Becher a. 0,20 Liter“ | index | 2026-03-09 | `/slushmaschine-mieten` (Popcorn/Waffel: eigene Entwürfe) |
| `/ablauf/` | Ablauf - Miet Royal (Navigation „Ablauf & Preise“) | „Unser Prozess“ | index | 2026-02-28 | `/ablauf` |
| `/buchung/` | Buchung - Miet Royal | „Online-Buchungssystem“ | index | 2026-03-30 | `/konfigurator` |
| `/uber-uns/` | Über Uns - Miet Royal | „Wir sind ein kleines Startup aus Mainz und seit 2023 …“ | index | 2026-02-28 | `/ueber-uns` |
| `/kontaktformular/` | Kontaktformular - Miet Royal | „Ihr habt Fragen zu unseren Maschinen …“ | index | 2026-03-09 | `/kontakt` |
| `/impressum/` | Impressum - Miet Royal | (enthält die Impressumsanschrift) | index | 2026-03-09 | `/impressum` |
| `/datenschutz/` | Datenschutz - Miet Royal | „Wir freuen uns über Ihr Interesse an Miet Royal …“ | index | 2026-03-09 | `/datenschutz` |

Es gibt **keine** FAQ-Seite, **keine** Ortsseiten, **keine** eigenen Produktseiten
(Slush/Popcorn/Waffel nur als Abschnitte) und keinen Blog (nur der WordPress-Standardbeitrag).

### 2b Shop-, Plugin- und Standard-Reste (ohne Inhalt; Phase-17-Kandidaten für 410/Redirect)

| Alt-URL | Befund | robots |
| --- | --- | --- |
| `/shop/` | WooCommerce-Shop „Es wurden keine Produkte gefunden“ (Store-API liefert keine Produkte) | index |
| `/warenkorb/` | leerer Warenkorb | noindex |
| `/kasse/` | leitet auf `/warenkorb/` um | noindex |
| `/mein-konto/` | WooCommerce-Login (nicht benutzt) | noindex |
| `/hello-world/`, `/category/uncategorized/` | WordPress-Standardbeitrag inkl. Standardkommentar, Kategorie-Archiv | index |
| `/sample-page/` | WordPress-Standardseite | index |
| `/metform-form/contact-form/` | Einzelseite des Formular-Plugins | index |
| `/book-appointment/`, `/my-bookings/`, `/thank-you/` | Buchungs-Plugin-Reste mit roh ausgegebenen Shortcodes | index |
| `/cancel-appointment/`, `/cancel-payment/`, `/appointment-cancellation-confirmation/`, `/appointment-reschedule/`, `/bookingpress-complete-payment/` | nur aus Sitemap/REST bekannt, **nicht einzeln abgerufen** – vermutlich gleiche Leerseiten | unklar |

`robots.txt` sperrt nur WooCommerce-Upload-/Log-Pfade, `add-to-cart`-Parameter und `/wp-admin/`.
Rankings der Alt-URLs wurden **nicht** geprüft (Phase 17).

## 3 Zentrale Inhalte der Alt-Seite (Kurzfassung)

- **Startseite:** Hero „Funfood & Slushmaschine mieten in Mainz & Wiesbaden“, Unterzeile mit
  Preis „ab … pro Tag, inkl. Verbrauchsmaterialien“, CTAs „Angebot anfordern“ und „Per WhatsApp
  anfragen“, selbst gehostetes Intro-Video; Kurzvorstellung (Slush-/Popcornmaschinen für
  Geburtstage, Hochzeiten, Firmenfeiern in Mainz, Wiesbaden und Umgebung); Zähler (114 „Events
  seit 2023“, 1712 „Liter Slush gezapft“, 39 „°Grad“, 42 „Einsatzorte“ – unbelegt); „Warum
  Miet-Royal?“ (All-Inclusive ab Preis, Kommission, Endreinigung inklusive, Abholung oder
  Lieferung, E-Auto & Solarstrom); Anlässe (Kindergeburtstage, Hochzeiten, Firmen- und
  Weihnachtsfeiern, Sport-/Fußball-/Tanzvereine, Kindergärten, Schulen, Vereins- und
  Stadtfeste); Nachhaltigkeit (PDF-Urkunden Dritter); Angebot Slush/Popcorn/Waffel ohne Preise;
  12 statisch eingebettete Bewertungen **von Erento** (nicht Google) plus Erento-Badge;
  Newsletter-Formular; Template-Füllsätze.
- **Maschinen & Zubehör:** Gratis je „Slush-Maschine“ 1 L Sirup (≈ 6 L Slush ≈ 30 Becher à
  0,2 L), 25 Becher, 25 Trinkhalme; Maschinen 1×8 L, 2×8 L, 1×10 L, 2×10 L **mit
  Becher-pro-Stunde-Angaben**; Sirupsorten Waldmeister, Kirsche, Blaubeere, Himbeere;
  Einweg-/Mehrweg-Varianten; Popcorn (Inklusivmengen), Waffeleisen („ohne Zubehör“).
- **Ablauf:** sechs Schritte (online buchen → schriftliches Angebot „innerhalb 24 Stunden“ →
  Lieferung oder Abholung in Mainz-Hechtsheim → Einweisung + YouTube-Videos → Nutzung →
  Rückgabe, Bezahlung auf Rechnung); zweiter Ablauf mit fester Anzahlung und „Bestätigung nach
  Zahlungseingang“; Preisbeispiele (u. a. eine nicht existierende 3×10-L-Maschine); Template-
  Zähler (100 K+, 1 M, 500+, 30+).
- **Buchung:** eigenes Anfrageformular („unverbindlich anfragen … verbindlich erst nach
  ausdrücklicher Bestätigung“) mit Zeitraum, Lieferung/Abholung, Anlass, Zeitfenstern,
  Personenzahl, Adresse, Geräten (Slush-Varianten, Popcorn, **Softeis**, Waffeleisen),
  Kommissions-Extras ohne Preise, Aktionscode, „Wie aufmerksam geworden“, Newsletter-Opt-in,
  Datenschutz-Checkbox. Gratis-Logik im Skript **je Gerät** (nicht je Behälter/Vorgang).
- **Über uns:** Familienbetrieb/„kleines Startup aus Mainz“ seit 2023; Gründer Dennis, Idee beim
  Kindergeburtstag der Tochter („ausgebucht, zu teuer oder kompliziert“); Geschwister betreuen
  jede Vermietung persönlich; Mission „Faire Preise. Klare Kommunikation. Ein Erlebnis, das
  überzeugt.“; Fotogalerie; Zähler wie Startseite.
- **Kontakt:** E-Mail `info@miet-royal.de`, Telefon `+49 160 96663665`, **exakte Abholadresse
  mit Ortsbeschreibung** (nicht übernommen), Kontaktformular.
- **Querschnitt:** Ansprache uneinheitlich (Sie/ihr/du); keine Öffnungszeiten; **kein
  Instagram-Link**; keine Google-Bewertungen; keine FAQ; Zahlung „auf Rechnung“ (Ablauf) bzw.
  Rechnung/EC/Kreditkarten/PayPal (Datenschutz).

## 4 Eigene Bilder und Logo – Herkunftsbewertung

Alle Dateien liegen unter `https://miet-royal.de/wp-content/uploads/…`. Das belegt **keine**
Rechte. Keines der Fotos trägt EXIF-Daten (Kamera/Datum entfernt). **Keine Datei wurde ins
Repository oder ins CMS übernommen.** Verwendung nur als CMS-Medium (Upload durch das Team), wenn
die Bedingung in der letzten Spalte erfüllt ist.

### 4a Logo

| Datei | Inhalt | Bewertung | Bedingung |
| --- | --- | --- | --- |
| `2025/11/Miet-Royal-Logo-01-scaled-e1764355618558.png` (PNG 1545×810, transparent) | MR-Monogramm mit Krone + Wortmarke „MIET-ROYAL“, Gold-Verlauf | eigener Markenauftritt (belegt durch Verwendung in Header/Footer/OG-Bild) | Vektor-Original (Illustrator-Datei, laut XMP erstellt am 21.11.2025) und Nutzungsrechte beim Inhaber/Designer anfordern |
| `2025/11/Miet-Royal-Logo-02-scaled.png` (PNG 2560×1792) | nur Monogramm | wie oben | wie oben |
| `2025/11/cropped-Miet-Royal-Logo-1.jpeg` (JPEG 512×512, + Favicon-Größen) | Monogramm auf Schwarz | wie oben | wie oben |
| `Bestellen/Miet-Royal-Logo.jpeg` (JPEG 2085×1459) | Volllogo Gold auf Schwarz | wie oben | wie oben |

Logo-Farben (aus der PNG-Palette gemessen, Verlauf): hellstes Gold `#F6E385`, `#EDCA72`, Mitte
`#BA8E51`/`#B18F58`, häufigster Ton `#A97E4A`, dunkle Bronze `#8F6540`/`#7B5426`. Theme:
Creme `#FFFCF2`/`#FFFBEF`, Gold `#BF9B30`, Theme-Gelb `#FFBF00` (Template-Farbe, weicht vom
Logo ab). Logo-Schrift: Serifen-Versalien, konkrete Schrift unklar.

### 4b Fotos und Grafiken

| Datei | Inhalt | vermutete Herkunft | Bedingung / Entscheidung |
| --- | --- | --- | --- |
| `2025/11/1492338C-…-ED02F79F8ACE.jpeg` | zwei Slush-Becher auf einem Vereinsfest | wahrscheinlich eigenes Smartphone-Foto | Eigentum bestätigen |
| `2025/11/59BD8D22-…-8DAB026B2874.jpeg` | Herz-Waffeleisen im Lager | wahrscheinlich eigen | Eigentum bestätigen |
| `2025/11/77F01870-…-7E906.jpeg` | 2-Behälter-Slushmaschine, stark nachbearbeitet, Herstellerlogo prominent | wahrscheinlich eigen, unklar | Eigentum bestätigen |
| `2025/11/29A323B4-…-8197F12A.jpeg` | Popcornmaschine im Innenraum | wahrscheinlich eigen | Eigentum bestätigen |
| `2025/11/B5B26C3F-…-DC949.jpeg` | 1- und 2-Behälter-Maschinen mit Becherstapel, draußen | wahrscheinlich eigen | Eigentum bestätigen |
| `2026/05/1.jpeg` | Person zapft Slush an einer Vereinsheim-Theke | wahrscheinlich eigenes Event-Foto, **erkennbare Person** | Eigentum + Einwilligung der Person |
| `2026/05/2.jpeg` | vier Slush-Becher, Hände, von oben | wahrscheinlich eigen | Eigentum bestätigen |
| `2026/05/4.jpeg` | Frau an Slushmaschine, **Kinder in Vereinstrikots** (Verein erkennbar) | wahrscheinlich eigen | **nicht ohne Freigabe** (Minderjährige, Verein) |
| `2026/03/82314DE2-…-scaled.webp`, `2026/03/EB094AD8-…-scaled.jpeg` | Hintergrundbilder Startseite, nicht vollständig gesichtet | unklar | klären |
| `2026/05/MietRoyal-Intro-1.mp4` | Intro-Video (nicht abgerufen) | vermutlich eigen, unklar | klären; kein Video-Block im CMS |
| `2025/11/freepicdownloader.com-*.jpg` (2 Dateien) | Slushmaschinen, Retro-Popcornmaschine | **Stock (Freepik)** | **nicht verwenden** |
| `2026/02/81r0qdniofl._ac_sl1500_.webp` | Waffeleisen | **Händler-Produktbild (Amazon-Dateischema)** | **nicht verwenden** |
| `Bestellen/popcorn.jpg` | Popcornmaschine | **KI-generiert** (C2PA-Manifest eines Bildgenerators) | **nicht verwenden** |
| `Bestellen/waffeln.jpg`, `Bestellen/slush.jpg`, `Bestellen/softeis.jpg` | Studio-Freisteller (u. a. 3-Behälter-Maschine, Softeis) | Stock/KI/Composing, unklar | **nicht verwenden** (zeigen teils keine Spec-Modelle) |
| `Baum-Urkunde.pdf`, `Plastic-Fischer.pdf` | Urkunden Dritter (nicht abgerufen) | Dritte | nicht übernehmen |

Fazit: Sicher eigene Markenassets sind nur die Logos (Rechte/Vektorquelle trotzdem klären). Die
Smartphone-Fotos sind wahrscheinlich eigene Aufnahmen, Eigentum aber nicht nachweisbar und teils
mit erkennbaren Personen/Kindern. Die neue Website kommt ohne Bilder aus; Sektionen ohne Bild
sind sauber gestaltet (Order §3).

## 5 Impressum und Datenschutz – Befunde (vor Live rechtlich prüfen)

Beide Texte wurden als **redaktionelle Entwürfe** in den CMS-Bootstrap übernommen
(`/impressum`, `/datenschutz`, Seitentyp `legal`, nur Textblöcke). Sie wurden **nicht
juristisch angepasst**; Ausnahmen: Anschriften (siehe unten) und beim Datenschutztext die
Ansprache „du“. Die Prüfpunkte stehen zusätzlich in der internen Redaktionsnotiz der Einträge.

### 5a Impressum

- Angaben: „Miet Royal“, Inhaberbezeichnung „Dennis Zeptr Vermietungen“, Anschrift, Telefon,
  E-Mail, „USt-ID“, „Verantwortlich gemäß § 18 Abs. 2 MStV“, Haftungsausschluss (Inhalte,
  Links, Urheberrecht), Hinweis zur Verbraucherstreitbeilegung („weder bereit noch
  verpflichtet“).
- **Anschrift widersprüchlich:** Impressum und Datenschutzerklärung nennen **zwei verschiedene
  Anschriften**; die im Datenschutz genannte ist der Abholort. Im Entwurf steht deshalb ein
  Platzhalter „[vor Veröffentlichung eintragen]“ – die ladungsfähige Geschäftsanschrift wird
  nach rechtlicher Prüfung eingetragen und nicht als Abholort bezeichnet.
- „USt-ID“ hat das Format einer **Steuernummer**, nicht einer USt-IdNr. (`DE` + 9 Ziffern).
- Haftungstexte verweisen auf das **TMG** (§ 7 Abs. 1, §§ 8–10) – Rechtsgrundlage prüfen.
- Schreibweise der Inhaberbezeichnung („Zeptr“; an anderer Stelle „Zepter“) und „Miet Royal“
  vs. Marke „Miet-Royal“ bestätigen; Rechtsform vollständig? (OPEN_ITEMS „Geschäftsdaten“).

### 5b Datenschutzerklärung

- Gliederung: Einleitung; 1 Verantwortlicher; 2 Erhebung; 3 Zwecke; 4 Weitergabe
  (Zahlungsdienstleister, Steuerberater/Finanzbehörden); 5 Speicherung/Löschung; 6 Cookies;
  7 Server-Logfiles; 8 Kontaktformular & Buchungssystem; 9 Zahlungsabwicklung (Rechnung, EC,
  Kreditkarten, PayPal; Art. 6 Abs. 1 lit. b DSGVO); 10 YouTube; 11 Betroffenenrechte (Art. 15–18,
  20, 21); 12 Widerruf; 13 Sicherheit; 14 Änderungen. Kein Stand/Datum, keine Aufsichtsbehörde,
  kein Hoster.
- **Verantwortlicher** nennt die exakte Abholadresse → im Entwurf neutral „Anschrift: wie im
  Impressum angegeben“.
- **Passt nicht zur neuen Website** (Prüfpunkte, nicht still repariert): Online-Buchungssystem/
  Kontaktformular (neu: Konfigurator mit unverbindlicher Anfrage und Datenschutz-Nachweis,
  Kundenbereich mit Anmeldelink per E-Mail); Zahlungsabwicklung (neu: keine Online-Zahlung);
  YouTube (neu: keine Einbindung); Cookies (neu: nur technisch notwendige). Es **fehlen** u. a.
  Google-Bewertungen (Abruf erst nach Klick), Instagram-Link, E-Mail-Versanddienst,
  Rechtsgrundlagen je Zweck, konkrete Speicherfristen, Aufsichtsbehörde, Stand.
- Auf der Alt-Seite **technisch eingebunden, aber im Text nicht genannt:** Google Fonts,
  Google-Maps-iframe, WhatsApp (Button + Widget), Mailchimp-Newsletter, Erento-Badge/-Link,
  CookieYes-Banner, WooCommerce Order Attribution, WordPress-Emoji/Gravatar,
  Kommentarfunktion. Die neue Website nutzt keinen dieser Dienste.
- Die veröffentlichte Revision von `/datenschutz` ist Voraussetzung für Website-Anfragen
  (Order §17, fail-closed) – sie darf erst nach rechtlicher Prüfung live veröffentlicht werden.

## 6 Widersprüche Alt-Seite ↔ MASTER_SPEC

Bei Widerspruch gelten MASTER_SPEC und aktuelle Fachdaten (Order §5).

| # | Alt-Seite | MASTER_SPEC | Folge für die neue Website |
| --- | --- | --- | --- |
| W1 | Sirupsorten Waldmeister, Kirsche, Blaubeere, Himbeere | §5: Wassermelone, Kirsche, Waldmeister, Blaue Himbeere | Spec-Sorten (Katalog) |
| W2 | 1 L Gratis-Sirup **je Gerät** | §5: 1 L je **Maschinenbehälter** | je Behälter |
| W3 | 25 Becher + 25 Halme **je Gerät** (Beispiele 50/75) | §5: 25 + 25 **einmal je Mietvorgang** | je Mietvorgang |
| W4 | „bis zu 60/120/80/160 Becher/Stunde“ | §6 + Order §2/§5: keine Kapazitätsbehauptung | nicht übernommen |
| W5 | exakte Abholadresse öffentlich (Kontakt, Datenschutz), „an der Autobahn“ | §8: öffentlich nur „Mainz-Hechtsheim“, exakte Adresse erst nach bestätigter Buchung | nur „Mainz-Hechtsheim“ |
| W6 | Preisbeispiel mit 3×10-L-Maschine | §4: nur 1×8, 2×8, 1×10, 2×10 L | nicht übernommen |
| W7 | „ab … pro Tag, inkl. Verbrauchsmaterialien“, „All-Inclusive“ | §4 (kein Tagesbezug), §5 (Kommission über Gratis-Kontingent hinaus), §8 (Wochenend-Standard) | nicht übernommen; Preise nur aus dem Katalog |
| W8 | „Endreinigung inklusive“ | §13: entleert + zweimal gespült zurück, sonst Gebühr | nicht übernommen; Rückgabepflichten erklärt |
| W9 | feste Anzahlung, „Bestätigung nach Zahlungseingang“ | §22 Anzahlung ohne Betrag; §10 AB nach Annahme + Freigabe | nicht übernommen |
| W10 | „Angebot innerhalb 24 Stunden“ | keine Frist definiert | nicht übernommen |
| W11 | „online buchen“, „Jetzt buchen“, „Online-Buchungssystem“ | §6 + Order §3/§11: nur unverbindliche Anfrage | nur „anfragen“/„konfigurieren“ |
| W12 | Softeis-Maschine, „Eismaschinen“ | §1/§30: Slush primär, Popcorn/Waffel sekundär | nicht übernommen |
| W13 | Einweg-/Mehrweg-Becher und -Halme | §5: nur Becher/Strohhalme im 25er | nicht übernommen |
| W14 | „kostenfreie Abholung“; Lieferung Mainz/Wiesbaden ohne Preis | §8: Lieferung individuelle Prüfung; Abholgebühr nicht geregelt | Lieferung „individuell geprüft“, keine Kostenaussage zur Abholung |
| W15 | Popcorn-Inklusivleistungen widersprüchlich, max. 2 Maschinen | keine Spec-Fakten; OPEN_ITEMS offen | Popcorn-Seite nur als Struktur-Entwurf |
| W16 | Waffeleisen „ohne Zubehör“, max. 4 Geräte | keine Spec-Fakten; OPEN_ITEMS offen | Waffel-Seite nur als Struktur-Entwurf |
| W17 | WhatsApp-Button/-Widget, Maps-iframe, Newsletter, Aktionscode | Order §2/§17/§19 | nicht übernommen |
| W18 | statische Erento-Bewertungen + Badge | Order §18: echte Google-Bewertungen nur über ReviewGateway | nicht übernommen (auch nicht als Demo) |
| W19 | Zähler 114/1712/39/42 und Template-Zähler | Order §3: keine Fake-Statistik | nicht übernommen |
| W20 | Einsatzgebiet „Mainz, Wiesbaden und Umgebung“ | §30: Mainz, Wiesbaden, Bad Kreuznach + Umland | konsistent; Regionsseiten als Entwürfe |
| W21 | 1 L Sirup ≈ 6 L Slush ≈ 30 Becher à 0,2 L | §5/§6 (Orientierung) | als „ungefähr“/„rund“ übernommen |
| W22 | Preise 1×8 L und 2×10 L im Beispiel | §4 | konsistent, aber nie im CMS-Text – nur Katalog |
| W23 | Sirup „zuckerfrei“ | §5 „zuckerfrei, aus Deutschland“ | übernommen inkl. „aus Deutschland“ |
| W24 | Kommission „du zahlst nur, was du verbrauchst“, Mischkanister fehlt | §5 inkl. „geöffnet = voll berechnet“, Kanister max. 2 je Behälter | mit Öffnungsregel und Kanister formuliert |

## 7 In die neuen Entwürfe übernommen (CMS-Bootstrap)

`pnpm cms:bootstrap` legt diese Inhalte nur als **Entwurf** an (nie automatisch veröffentlicht
in production). Jede Seite hat eine interne Redaktionsnotiz mit offenen Punkten.

- **Einstellungen:** Markenname „Miet-Royal“, Telefon und E-Mail von der Alt-Seite (Entwurf,
  „vor Veröffentlichung bestätigen“), kein Instagram-Link, keine Empfehlungsregeln, kein Logo.
- **Fakten aus der Alt-Seite (konsistent mit MASTER_SPEC):** Einsatzgebiet Mainz, Wiesbaden und
  Umgebung; Anlässe-Liste; Abholung oder Lieferung (Lieferung individuell geprüft, ohne Preis);
  Abholung öffentlich nur „Mainz-Hechtsheim“; unverbindliche Anfrage → persönliche Prüfung →
  schriftliches Angebot → erst dann verbindlich; Sirup zuckerfrei; 1 L Sirup ≈ 6 L Slush,
  0,2 L als Orientierung; Kommission; Bezahlung auf Rechnung; kurze Erklärung der Bedienung bei
  der Übergabe (zu bestätigen); Über-uns-Geschichte (Familienbetrieb aus Mainz seit 2023,
  Gründer Dennis, Idee beim Kindergeburtstag der Tochter, Geschwister, Leitsatz) – in
  „du“-Ansprache, vor Veröffentlichung vom Inhaber zu bestätigen.
- **Fakten aus MASTER_SPEC:** Maschinen 1×8/2×8/1×10/2×10 L; 1 L Sirup je Behälter; 25 Becher +
  25 Strohhalme je Mietvorgang; Sorten; Kanister (Kaufartikel, bleibt beim Kunden, max. 2 je
  Behälter, empfohlen); ab 250 Gästen persönliche Abstimmung; Alternativen statt Ablehnung;
  Angebot als Link + PDF, Annahme online ohne Unterschrift; Auftragsbestätigung; exakte
  Abholadresse erst nach Bestätigung im Kundenbereich; Wochenend-Standard Fr 18 Uhr / So 11 Uhr
  (änderbar); Übergabeprotokoll mit Unterschrift; Rückgabe entleert + zweimal gespült, Deckel +
  Tropfschale je Behälter; Abholperson bis eine Stunde vorher; Kundenbereich optional
  (Anmeldelink, Dokumente, Nachrichten, Storno mit Betragsanzeige vor Bestätigung).
- **Preise:** nirgends im Text – nur über die Blöcke „Produkte“ und „Inklusive“ aus
  products/product_prices (Order §7).
- **Regionsseiten** Mainz, Wiesbaden, Bad Kreuznach: je eigener Text und Aufbau, nur belegte
  Aussagen, Notiz „vor Veröffentlichung lokal prüfen“.
- **Popcorn/Waffel:** nur Struktur (Kontaktweg, keine Preise/Inklusivleistungen/Transport), Notiz
  mit den fehlenden Geschäftsdaten.

## 8 Nicht übernehmen

- exakte Abholadresse samt Ortsbeschreibung und „an der Autobahn“ (W5)
- Becher-pro-Stunde-Angaben (W4)
- Sirupsorten Blaubeere/Himbeere, Gratis-Sirup „je Gerät“, Becher/Halme „je Gerät“ (W1–W3)
- Preisbeispiele, „ab … pro Tag“, „All-Inclusive“, 3×10-L-Maschine; jede Preisangabe im CMS-Text
  (W6, W7)
- „Endreinigung inklusive“, feste Anzahlung, „Bestätigung nach Zahlungseingang“, „Angebot
  innerhalb 24 Stunden“ (W8–W10)
- „online buchen“, „Jetzt buchen“, „Online-Buchungssystem“ (W11)
- Softeis, Einweg-/Mehrweg-Varianten (W12, W13)
- Popcorn-/Waffel-Preise, -Inklusivleistungen und -Limits als Fakten (W15, W16)
- Zähler/Statistiken und Template-Füllsätze (W19)
- Erento-Bewertungen und -Badge, jede statisch kopierte Bewertung (W18)
- WhatsApp-Button/-Widget, Google-Maps-iframe, Google Fonts, Newsletter/Opt-in, Aktionscode,
  „Wie aufmerksam geworden“ (W17)
- Nachhaltigkeitsaussagen (E-Auto, Solarstrom, Urkunden Dritter) – nur nach Beleg als eigener
  CMS-Inhalt
- Stock-, Händler-, KI- und Freisteller-Bilder (§4b)
- Rechtstexte unverändert live stellen (§5)
- strukturierte Daten mit falschem `legalName`, Social-Icons ohne Ziel

## 9 Offene Punkte

- **Inhaber/Geschäftsdaten:** Telefon/E-Mail bestätigen; ladungsfähige Anschrift,
  Steuernummer/USt-IdNr., Inhaberbezeichnung und Rechtsform klären; Impressum und
  Datenschutzerklärung juristisch final prüfen (OPEN_ITEMS „Geschäftsdaten“).
- **Über uns:** Geschichte, Gründungsjahr, Namen bestätigen; ggf. Team-/Familienfotos.
- **Bilder/Logo:** Logo-Vektorquelle und Rechte; Eigentum und Einwilligungen der Event-Fotos
  (insb. Foto mit Kindern); Intro-Video klären.
- **Instagram-URL**, **Google Place ID** und Google-Zugang: auf der Alt-Seite nicht vorhanden.
- **Öffnungszeiten:** nicht vorhanden – nicht erfinden.
- **Popcorn/Waffel:** Preise, Inklusivleistungen, Limits, Transport, Bilder, Anfrageweg
  (OPEN_ITEMS „Popcorn/Waffel“).
- **Empfehlungsregeln** Gästezahl → Maschine (OPEN_ITEMS).
- **Phase 17:** Redirect-/410-Matrix für §2a/§2b, Ranking-Prüfung, nicht einzeln abgerufene
  Buchungs-Plugin-Seiten prüfen, Sitemap/Robots/Canonicals/strukturierte Daten.
