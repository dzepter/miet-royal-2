import type {
  CmsCta,
  CmsPageContent,
  CmsPageTypeName,
  CmsSiteSettings,
} from '@mietroyal/validation/cms';

/**
 * Phase 16 (Order §5/§10): redaktionelle Erst-Entwürfe für `pnpm cms:bootstrap`.
 * Reine Daten – der Bootstrap legt nur FEHLENDE Einträge mit diesem Inhalt als
 * ENTWURF an, überschreibt nie Redaktionsarbeit und veröffentlicht in production
 * nie. Nur belegte Fakten (MASTER_SPEC, Datenbank, bestehende Website laut
 * docs/WEBSITE_MIGRATION_NOTES.md); KEINE Preise (kommen aus dem Katalog).
 *
 * Phase 16 (CONTENT): Inhalte befüllt (Design §7, §11.2.13). Grundsätze:
 * - Preise erscheinen nur über die Blöcke `product_grid`/`included_items` (Katalog aus
 *   products/product_prices) – nie als Text; keine Kapazitäten je Zeiteinheit, keine
 *   Lieferpreise, kein „buchen“-Versprechen, keine Bewertungen, Zähler oder Referenzen.
 * - Abholung öffentlich nur „Mainz-Hechtsheim“; die genaue Abholadresse steht nirgends.
 * - Kontaktwerte stehen nur in `site_settings` (Seiten nutzen `contact_details`), außer in
 *   den Rechtstexten, die als redaktionelle Entwürfe aus der bisherigen Website stammen.
 * - Jeder Eintrag mit offenen Punkten trägt eine interne `editorNote` (nie öffentlich).
 * Der Unit-Test `apps/api/test/cms-bootstrap-content.test.ts` prüft Schema, Pfade,
 * Sperrliste und Links.
 */
export type CmsBootstrapEntry =
  | {
      kind: 'site_settings';
      content: CmsSiteSettings;
      editorNote?: string;
    }
  | {
      kind: 'page';
      pageType: CmsPageTypeName;
      path: string;
      content: CmsPageContent;
      metaTitle?: string;
      metaDescription?: string;
      /** Interne Redaktionsnotiz, z. B. „vor Live rechtlich prüfen“. */
      editorNote?: string;
    };

// ── Bausteine ────────────────────────────────────────────────────────────────

/** Absätze (Leerzeile) – der Web-Renderer trennt Absätze an Leerzeilen. */
function paragraphs(...parts: string[]): string {
  return parts.join('\n\n');
}

/** Zeilen ohne Leerzeile (Zeilenumbruch innerhalb eines Absatzes). */
function lines(...parts: string[]): string {
  return parts.join('\n');
}

/** Aufzählung als reiner Text (kein HTML im CMS). */
function bullets(...items: string[]): string {
  return items.map((item) => `– ${item}`).join('\n');
}

const CTA_CONFIGURE: CmsCta = { label: 'Slush konfigurieren', href: '/konfigurator' };
const CTA_INQUIRE_CONTACT: CmsCta = { label: 'Unverbindlich anfragen', href: '/kontakt' };
const CTA_CONTACT: CmsCta = { label: 'Kontakt aufnehmen', href: '/kontakt' };
const CTA_FAQ: CmsCta = { label: 'Häufige Fragen', href: '/faq' };
const CTA_PROCESS: CmsCta = { label: 'So läuft es ab', href: '/ablauf' };

/** Wochenend-Standard laut MASTER_SPEC §8 („Freitag 18:00 / Sonntag 11:00, änderbar“). */
const PICKUP_TEXT_WEEKEND =
  'Feierst du am Wochenende, holst du die Maschine standardmäßig freitags um 18 Uhr ab und bringst sie sonntags um 11 Uhr zurück. Andere Zeiten stimmen wir gern mit dir ab.';

const RETURN_TEXT =
  'Bitte gib sie entleert und zweimal gespült zurück und bau nichts ab. Kleine, unvermeidbare Reste sind kein Problem. Ist eine Maschine deutlich nicht gereinigt, berechnen wir eine Reinigungsgebühr.';

// ── Website-Einstellungen ────────────────────────────────────────────────────

const SITE_SETTINGS: CmsBootstrapEntry = {
  kind: 'site_settings',
  content: {
    businessName: 'Miet-Royal',
    tagline: 'Slushmaschinen mieten – persönlich aus Mainz',
    contact: { phone: '+49 160 96663665', email: 'info@miet-royal.de' },
    footerNote:
      'Deine Anfrage ist unverbindlich – verbindlich wird es erst, wenn du dein schriftliches Angebot annimmst.',
    recommendationRules: [],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16) – vor Veröffentlichung bestätigen:',
    '– Telefonnummer und E-Mail-Adresse stammen von der bisherigen Website (miet-royal.de) und sind laut OPEN_ITEMS „Geschäftsdaten“ noch nicht final bestätigt.',
    '– Instagram: Die bisherige Website verlinkt kein Instagram-Profil – URL erst eintragen, wenn sie feststeht.',
    '– Logo: erst hochladen, wenn Vektorquelle und Nutzungsrechte geklärt sind (siehe WEBSITE_MIGRATION_NOTES).',
    '– Empfehlungsregeln (Gästezahl → Maschine) bewusst leer: fachlich noch nicht festgelegt (OPEN_ITEMS). Ohne Regel zeigt der Konfigurator „Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.“',
    '– Slogan „persönlich aus Mainz“ und Fußzeile bei Bedarf anpassen.',
  ),
};

// ── Startseite ───────────────────────────────────────────────────────────────

const HOME: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'home',
  path: '/',
  metaTitle: 'Slushmaschine mieten in Mainz & Umgebung | Miet-Royal',
  metaDescription:
    'Slushmaschine mieten in Mainz, Wiesbaden und Umgebung: Abholung in Mainz-Hechtsheim oder Lieferung auf Anfrage. Sirup, Becher und Strohhalme inklusive.',
  content: {
    title: 'Startseite',
    blocks: [
      {
        type: 'hero',
        heading: 'Slushmaschine mieten – eiskalter Spaß für dein Event',
        lead: 'Ob Kindergeburtstag, Hochzeit oder Vereinsfest: Mit einer Slushmaschine von Miet-Royal gibt es bunten, eiskalten Slush für alle. Wir sind ein Familienbetrieb aus Mainz, schauen uns jede Anfrage persönlich an und stellen mit dir zusammen, was zu deiner Feier passt.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_INQUIRE_CONTACT,
      },
      {
        type: 'features',
        heading: 'Warum Slush von Miet-Royal?',
        items: [
          {
            title: 'Persönlich statt anonym',
            text: 'Jede Anfrage lesen und prüfen wir selbst. Dann melden wir uns mit einem Angebot, das wirklich zu deiner Feier passt.',
          },
          {
            title: 'Startklar dabei',
            text: 'Sirup, Becher und Strohhalme gehören zu jeder Miete. So kannst du direkt loslegen.',
          },
          {
            title: 'Zuckerfrei und aus Deutschland',
            text: 'Unsere Sirups in Wassermelone, Kirsche, Waldmeister und Blauer Himbeere sind zuckerfrei und kommen aus Deutschland.',
          },
          {
            title: 'Du zahlst, was du öffnest',
            text: 'Mehr Sirup, Becher oder Strohhalme nimmst du auf Kommission mit. Berechnet wird, was du öffnest – Ungeöffnetes gibst du einfach zurück.',
          },
          {
            title: 'Abholen oder liefern lassen',
            text: 'Hol deine Maschine in Mainz-Hechtsheim ab oder frag eine Lieferung an. Die prüfen wir für jeden Eventort individuell.',
          },
          {
            title: 'Unverbindlich und transparent',
            text: 'Im Konfigurator siehst du schon beim Zusammenstellen eine Preisübersicht. Verbindlich wird es erst, wenn du dein schriftliches Angebot annimmst.',
          },
        ],
      },
      {
        type: 'product_grid',
        heading: 'Unsere Slushmaschinen',
        intro:
          'Ein Behälter für eine Sorte oder zwei Behälter für zwei Sorten, jeweils mit 8 oder 10 Litern. Du wählst frei – und wenn du unsicher bist, beraten wir dich gern.',
      },
      {
        type: 'included_items',
        heading: 'Das ist bei jeder Miete dabei',
        intro:
          'Damit dein Slush-Stand sofort startklar ist. Brauchst du mehr, packen wir dir Nachschub auf Kommission ein.',
      },
      {
        type: 'steps',
        heading: 'So kommst du zu deinem Slush',
        items: [
          {
            title: 'Konfigurieren',
            text: 'Datum, Gästezahl und Anlass angeben, Maschine und Sorten wählen – bequem am Handy oder am Rechner.',
          },
          {
            title: 'Angebot erhalten',
            text: 'Wir prüfen deine Anfrage persönlich und schicken dir dein schriftliches Angebot als Link und als PDF.',
          },
          {
            title: 'Online annehmen',
            text: 'Passt alles, nimmst du das Angebot mit einem Klick an – ganz ohne Unterschrift.',
          },
          {
            title: 'Feiern',
            text: 'Du holst die Maschine in Mainz-Hechtsheim ab oder wir liefern nach Absprache. Dann heißt es: Slush zapfen und genießen.',
          },
        ],
      },
      { type: 'reviews', heading: 'Stimmen unserer Kundinnen und Kunden' },
      {
        type: 'service_areas',
        heading: 'Unterwegs in Mainz, Wiesbaden und Umgebung',
        intro:
          'Abholen kannst du deine Maschine in Mainz-Hechtsheim. Ob wir zu dir liefern können, prüfen wir für jeden Eventort individuell.',
        areas: ['Mainz', 'Wiesbaden', 'Bad Kreuznach', 'Rheinhessen', 'Rhein-Main'],
      },
      {
        type: 'secondary_offers',
        heading: 'Außerdem bei uns',
        intro:
          'Für noch mehr Genuss auf deiner Feier: Frag uns auch nach Popcornmaschinen und Waffeleisen.',
      },
      {
        type: 'cta',
        heading: 'Bereit für eiskalten Slush?',
        text: 'Stell dir deine Maschine in wenigen Schritten zusammen. Die Anfrage ist unverbindlich – wir melden uns persönlich bei dir.',
        primary: CTA_CONFIGURE,
        secondary: CTA_FAQ,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16). Preise erscheinen nur über die Blöcke „Produkte“ und „Inklusive“ aus dem Produktkatalog – nie im Text.',
    'Vor Veröffentlichung bestätigen: „Familienbetrieb aus Mainz“ (bisherige Website), Einsatzgebiet-Liste (Mainz, Wiesbaden, Bad Kreuznach, Rheinhessen, Rhein-Main laut MASTER_SPEC §30).',
    'Bewusst nicht übernommen von der alten Startseite: Preisangaben („ab … pro Tag“, „All-Inclusive“), Zähler/Statistiken, Erento-Bewertungen, WhatsApp-Button, Newsletter, Nachhaltigkeitsaussagen (unbelegt), „Endreinigung inklusive“.',
    'Bilder: erst ergänzen, wenn Eigentum und Einwilligungen (erkennbare Personen/Kinder) geklärt sind.',
  ),
};

// ── Slush ────────────────────────────────────────────────────────────────────

const SLUSH: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'slush',
  path: '/slushmaschine-mieten',
  metaTitle: 'Slushmaschine mieten – Maschinen, Sirup & Zubehör | Miet-Royal',
  metaDescription:
    'Slushmaschinen mit 8 oder 10 Litern, ein oder zwei Behälter: zuckerfreier Sirup aus Deutschland inklusive, Extras auf Kommission. Unverbindlich konfigurieren.',
  content: {
    title: 'Slushmaschine mieten',
    blocks: [
      {
        type: 'hero',
        heading: 'Slushmaschine mieten bei Miet-Royal',
        lead: 'Bunt, eiskalt und ein echter Hingucker: Unsere Slushmaschinen bringen Erfrischung auf deine Feier. Hier findest du alle Maschinen mit den aktuellen Preisen, alles, was schon inklusive ist, und was du zusätzlich dazunehmen kannst.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_INQUIRE_CONTACT,
      },
      {
        type: 'text',
        heading: 'Für welche Anlässe?',
        body: paragraphs(
          'Slush passt fast überall, wo gefeiert wird: beim Kindergeburtstag und auf der Hochzeit, bei Firmen- und Weihnachtsfeiern, im Sport-, Fußball- oder Tanzverein, in Kindergärten und Schulen, auf Vereins- und Stadtfesten.',
          'Du erzählst uns, was du planst – wir helfen dir, die passende Maschine zu finden.',
        ),
      },
      {
        type: 'product_grid',
        heading: 'Unsere Maschinen',
        intro:
          'Wir vermieten Slushmaschinen mit einem oder zwei Behältern, jeweils mit 8 oder 10 Litern. Mit zwei Behältern bietest du zwei Sorten gleichzeitig an.',
      },
      {
        type: 'included_items',
        heading: 'Inklusive und auf Kommission',
        intro:
          'Zu jeder Miete gehören Sirup für den Start sowie Becher und Strohhalme. Was du darüber hinaus brauchst, nimmst du auf Kommission mit: Bei Sirup werden geöffnete Flaschen voll berechnet, ungeöffnete gibst du zurück.',
      },
      {
        type: 'features',
        heading: 'Gut zu wissen',
        items: [
          {
            title: 'Wie viel Slush?',
            text: 'Ein Liter Sirup ergibt ungefähr sechs Liter Slush. Bei 0,2 Litern pro Becher sind das rund 30 Becher – eine Orientierung, keine feste Größe.',
          },
          {
            title: 'Zuckerfreier Sirup',
            text: 'Unsere Sirups sind zuckerfrei und kommen aus Deutschland. Den inklusiven Sirup verteilst du frei auf die Sorten – oder wir stimmen die Sorte später gemeinsam ab.',
          },
          {
            title: 'Mischkanister',
            text: 'Unser 6-Liter-Mischkanister mit Liter-Markierung ist ein Kaufartikel und bleibt bei dir. Wir empfehlen ihn dir gern – bis zu zwei Stück je Maschinenbehälter.',
          },
          {
            title: 'Großes Event?',
            text: 'Ab 250 Gästen stimmen wir die Planung persönlich mit dir ab. Deine Anfrage stellst du trotzdem ganz normal über den Konfigurator.',
          },
          {
            title: 'Persönliche Beratung',
            text: 'Du bist unsicher, welche Maschine passt? Gib deine Gästezahl im Konfigurator an – wir schauen uns deine Anfrage an und beraten dich.',
          },
        ],
      },
      {
        type: 'faq',
        heading: 'Fragen zur Slushmaschine',
        items: [
          {
            question: 'Kann ich zwei Sorten gleichzeitig anbieten?',
            answer:
              'Ja – mit einer Maschine mit zwei Behältern, also 2×8 L oder 2×10 L. So kann zum Beispiel Kirsche neben Waldmeister laufen.',
          },
          {
            question: 'Was ist, wenn meine Wunschmaschine schon vergeben ist?',
            answer:
              'Dann melden wir uns mit einer Alternative, zum Beispiel einer anderen Größe oder zwei einzelnen Maschinen statt einer mit zwei Behältern. Deine Anfrage wird nicht automatisch abgelehnt.',
          },
          {
            question: 'Muss ich die Maschine reinigen?',
            answer: RETURN_TEXT,
          },
        ],
      },
      { type: 'reviews', heading: 'Das sagen unsere Kundinnen und Kunden' },
      {
        type: 'cta',
        heading: 'Stell dir deine Maschine zusammen',
        text: 'Maschine, Sorten und Extras wählen, Abholung oder Lieferung angeben – mit laufender Preisübersicht und ganz unverbindlich.',
        primary: CTA_CONFIGURE,
        secondary: CTA_PROCESS,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16). Maschinen und Preise kommen ausschließlich aus dem Produktkatalog (Block „Produkte“); Inklusivmengen und Kommissionspreise aus dem Block „Inklusive“.',
    'Mengenangaben im Text laut MASTER_SPEC §5/§6: 1 L Sirup ≈ 6 L Slush, 0,2 L je Becher als Orientierung, Kanister max. 2 je Behälter, Großevent ab 250 Gästen. Bei Regeländerungen hier mitziehen.',
    'Bewusst nicht übernommen: Kapazitätsangaben in Bechern je Zeiteinheit, Sorten „Blaubeere/Himbeere“, Gratis-Sirup „pro Gerät“, Becher/Halme „pro Gerät“, Einweg-/Mehrweg-Varianten, Softeis.',
  ),
};

// ── Ablauf ───────────────────────────────────────────────────────────────────

const PROCESS: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'process',
  path: '/ablauf',
  metaTitle: 'So funktioniert’s: Ablauf deiner Slush-Miete | Miet-Royal',
  metaDescription:
    'So läuft deine Slush-Miete ab: unverbindlich anfragen, persönlich geprüftes Angebot online annehmen, abholen oder liefern lassen und entspannt zurückgeben.',
  content: {
    title: 'Ablauf',
    blocks: [
      {
        type: 'hero',
        heading: 'So läuft deine Slush-Miete ab',
        lead: 'Von der ersten Anfrage bis zur Rückgabe: Hier siehst du Schritt für Schritt, was dich erwartet. Unverbindlich anfragen, persönlich geprüftes Angebot erhalten, online annehmen – und feiern.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_FAQ,
      },
      {
        type: 'steps',
        heading: 'Schritt für Schritt',
        items: [
          {
            title: 'Anfrage stellen',
            text: 'Im Konfigurator gibst du Datum, Gästezahl und Anlass an, wählst Maschine, Sirup und Extras und entscheidest dich für Abholung oder Lieferung. Deine Anfrage ist unverbindlich.',
          },
          {
            title: 'Wir prüfen persönlich',
            text: 'Wir schauen uns jede Anfrage selbst an – auch, ob die gewünschte Maschine zu deinem Termin passt. Ist sie schon vergeben, schlagen wir dir eine Alternative vor.',
          },
          {
            title: 'Dein schriftliches Angebot',
            text: 'Du bekommst dein Angebot von uns online als Link und als PDF – mit allen Positionen auf einen Blick.',
          },
          {
            title: 'Online annehmen',
            text: 'Passt alles, nimmst du das Angebot mit einem Klick verbindlich an, ganz ohne Unterschrift. Ab dann gelten die Preise aus deinem Angebot.',
          },
          {
            title: 'Auftragsbestätigung',
            text: 'Wir schicken dir deine Auftragsbestätigung. Im Kundenbereich findest du danach alle Details und Dokumente – auch die genaue Abholadresse.',
          },
          {
            title: 'Abholung oder Lieferung',
            text: 'Bei der Übergabe halten wir den Zustand der Maschine gemeinsam in einem Protokoll fest, das du unterschreibst, und erklären dir kurz die Bedienung.',
          },
          {
            title: 'Rückgabe und Abrechnung',
            text: 'Du gibst die Maschine entleert und zweimal gespült zurück. Wir erfassen gemeinsam, was du an Kommissionsware geöffnet hast, und erstellen danach deine Abrechnung.',
          },
        ],
      },
      {
        type: 'text',
        heading: 'Abholung in Mainz-Hechtsheim',
        body: paragraphs(
          'Abgeholt wird bei uns in Mainz-Hechtsheim. Die genaue Adresse bekommst du, sobald deine Buchung bestätigt ist – du findest sie dann auch in deinem Kundenbereich.',
          PICKUP_TEXT_WEEKEND,
          'Soll jemand anderes die Maschine abholen? Dann gib uns bis spätestens eine Stunde vor der Abholung Vorname, Nachname und Telefonnummer dieser Person durch.',
        ),
      },
      {
        type: 'text',
        heading: 'Lieferung',
        body: paragraphs(
          'Du möchtest die Maschine lieber geliefert bekommen? Dann gib im Konfigurator die Adresse deines Eventorts und dein Wunsch-Zeitfenster an.',
          'Wir prüfen jede Lieferung individuell – Strecke, Termin und Aufwand – und nennen dir den Preis dafür in deinem Angebot.',
        ),
      },
      {
        type: 'text',
        heading: 'Rückgabe',
        body: paragraphs(
          'Bitte gib die Maschine entleert und zweimal gespült zurück und bau nichts ab. Zu jedem Behälter gehören ein Deckel und eine Tropfschale – bitte bring alles vollständig mit.',
          'Die Rückgabe machen wir gemeinsam mit dir oder mit der Person, die du schickst. Kleine, unvermeidbare Reste sind kein Problem. Ist eine Maschine deutlich nicht gereinigt, berechnen wir eine Reinigungsgebühr.',
        ),
      },
      {
        type: 'text',
        heading: 'Abrechnung',
        body: paragraphs(
          'Nach der Rückgabe erstellen wir deine Endabrechnung: Miete, geöffnete Kommissionsware, Kaufartikel wie den Mischkanister und – falls vereinbart – die Lieferung.',
          'Du bezahlst bequem auf Rechnung, die Rechnung bekommst du per E-Mail. Online bezahlen musst du nichts.',
        ),
      },
      {
        type: 'cta',
        heading: 'Klingt gut? Dann leg los.',
        text: 'Stell dir deine Slushmaschine zusammen – die Anfrage ist unverbindlich.',
        primary: CTA_CONFIGURE,
        secondary: CTA_CONTACT,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16). Ablauf aus MASTER_SPEC §3, §7–§10, §12–§14, §16 abgeleitet.',
    'Vor Veröffentlichung bestätigen: „kurze Erklärung der Bedienung bei der Übergabe“ (bisherige Website). Telefonische Erreichbarkeit während der Miete wurde bewusst nicht zugesagt.',
    'Wochenend-Standardzeiten (Fr 18 Uhr / So 11 Uhr, MASTER_SPEC §8) hier anpassen, falls die Voreinstellung geändert wird.',
    'Bewusst nicht übernommen: „Angebot innerhalb 24 Stunden“, feste Anzahlung, „Bestätigung nach Zahlungseingang“, „Endreinigung inklusive“, „online buchen“, YouTube-Videos.',
  ),
};

// ── FAQ ──────────────────────────────────────────────────────────────────────

const FAQ: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'faq',
  path: '/faq',
  metaTitle: 'Häufige Fragen zur Slushmaschinen-Miete | Miet-Royal',
  metaDescription:
    'Antworten rund um deine Slush-Miete: Inklusivleistungen, Sirupsorten, Abholung in Mainz-Hechtsheim, Lieferung, Rückgabe, Bezahlung und Kundenbereich.',
  content: {
    title: 'Häufige Fragen',
    blocks: [
      {
        type: 'hero',
        heading: 'Häufige Fragen',
        lead: 'Hier findest du Antworten rund um deine Slush-Miete – von der Anfrage bis zur Rückgabe. Deine Frage ist nicht dabei? Dann melde dich einfach bei uns.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_CONTACT,
      },
      {
        type: 'faq',
        heading: 'Anfrage und Angebot',
        items: [
          {
            question: 'Wie stelle ich eine Anfrage?',
            answer:
              'Am einfachsten über unseren Konfigurator: Du gibst Datum, Gästezahl und Anlass an, wählst Maschine, Sirup und Extras, entscheidest dich für Abholung oder Lieferung und hinterlässt deine Kontaktdaten. Nach dem Absenden siehst du sofort deine Vorgangsnummer.',
          },
          {
            question: 'Ist meine Anfrage verbindlich?',
            answer:
              'Nein. Über den Konfigurator stellst du eine unverbindliche Anfrage. Wir melden uns mit einem schriftlichen Angebot – verbindlich wird es erst, wenn du dieses Angebot annimmst.',
          },
          {
            question: 'Wie nehme ich mein Angebot an?',
            answer:
              'Dein Angebot bekommst du als Link und als PDF. Passt alles, nimmst du es online mit einem Klick an – eine Unterschrift brauchst du dafür nicht. Danach schicken wir dir deine Auftragsbestätigung.',
          },
          {
            question: 'Welche Maschine passt zu meinem Event?',
            answer:
              'Das hängt von deinen Gästen, der Dauer und davon ab, wie viele Sorten du anbieten möchtest. Gib im Konfigurator deine Gästezahl an – wir schauen uns deine Anfrage persönlich an und beraten dich, falls eine andere Maschine besser passt. Du kannst aber jederzeit frei wählen.',
          },
          {
            question: 'Wir erwarten mehr als 250 Gäste – geht das?',
            answer:
              'Gern. Ab 250 Gästen stimmen wir dein Event persönlich mit dir ab, damit Maschinen, Sirup und Becher wirklich passen. Deine Anfrage stellst du ganz normal über den Konfigurator.',
          },
          {
            question: 'Was ist, wenn meine Wunschmaschine schon vergeben ist?',
            answer:
              'Dann melden wir uns mit einer Alternative – zum Beispiel einer anderen Größe, zwei einzelnen Maschinen statt einer mit zwei Behältern oder einer etwas anderen Zeit. Deine Anfrage wird nicht automatisch abgelehnt.',
          },
        ],
      },
      {
        type: 'faq',
        heading: 'Maschinen, Sirup und Zubehör',
        items: [
          {
            question: 'Welche Slushmaschinen kann ich mieten?',
            answer:
              'Wir haben Maschinen mit einem oder zwei Behältern, jeweils mit 8 oder 10 Litern: 1×8 L, 2×8 L, 1×10 L und 2×10 L. Mit zwei Behältern kannst du zwei Sorten gleichzeitig anbieten. Die aktuellen Preise findest du auf unserer Slush-Seite und im Konfigurator.',
          },
          {
            question: 'Was ist bei der Miete dabei?',
            answer:
              'Pro Maschinenbehälter ist 1 Liter Sirup inklusive – bei einer Maschine mit zwei Behältern also 2 Liter. Dazu bekommst du einmal je Mietvorgang 25 Becher und 25 Strohhalme.',
          },
          {
            question: 'Welche Sirupsorten gibt es?',
            answer:
              'Aktuell Wassermelone, Kirsche, Waldmeister und Blaue Himbeere. Unsere Sirups sind zuckerfrei und kommen aus Deutschland. Den inklusiven Sirup kannst du frei auf die Sorten verteilen – und wenn du dich noch nicht festlegen möchtest, stimmen wir die Sorte später mit dir ab.',
          },
          {
            question: 'Wie viel Slush ergibt ein Liter Sirup?',
            answer:
              'Ungefähr sechs Liter. Rechnest du mit 0,2 Litern pro Becher, sind das rund 30 Becher. Das ist eine Orientierung – wie viel deine Gäste trinken, hängt zum Beispiel vom Wetter, von der Dauer und vom Anlass ab.',
          },
          {
            question: 'Was ist, wenn der Sirup nicht reicht?',
            answer:
              'Zusätzlichen Sirup, Becher und Strohhalme bekommst du auf Kommission. Berechnet wird, was du öffnest: Geöffnete Sirupflaschen werden voll berechnet, ungeöffnete gibst du bei der Rückgabe einfach zurück. Die aktuellen Preise siehst du im Konfigurator.',
          },
          {
            question: 'Wofür ist der Mischkanister?',
            answer:
              'Der 6-Liter-Mischkanister mit Liter-Markierung ist praktisch zum Anmischen. Er ist ein Kaufartikel und bleibt nach dem Event bei dir. Wir empfehlen ihn gern; möglich sind bis zu zwei Kanister je Maschinenbehälter.',
          },
        ],
      },
      {
        type: 'faq',
        heading: 'Abholung, Lieferung und Rückgabe',
        items: [
          {
            question: 'Wo hole ich die Maschine ab?',
            answer:
              'In Mainz-Hechtsheim. Die genaue Adresse bekommst du, sobald deine Buchung bestätigt ist. Du findest sie dann auch in deinem Kundenbereich.',
          },
          {
            question: 'Liefert ihr auch?',
            answer:
              'Ja, auf Anfrage. Gib im Konfigurator die Lieferadresse und dein Wunsch-Zeitfenster an. Wir prüfen jede Lieferung individuell und nennen dir den Lieferpreis in deinem Angebot.',
          },
          {
            question: 'Wann hole ich die Maschine bei einem Wochenend-Event ab?',
            answer: PICKUP_TEXT_WEEKEND,
          },
          {
            question: 'Kann jemand anderes die Maschine abholen?',
            answer:
              'Ja. Gib uns bis spätestens eine Stunde vor der Abholung Vorname, Nachname und Telefonnummer der Person durch, die kommt.',
          },
          {
            question: 'Muss ich die Maschine reinigen?',
            answer: RETURN_TEXT,
          },
          {
            question: 'Was mache ich, wenn während des Events etwas nicht klappt?',
            answer:
              'Ruf uns an. Die Telefonnummer findest du auf unserer Kontaktseite und während deiner Miete auch direkt in deinem Kundenbereich.',
          },
        ],
      },
      {
        type: 'faq',
        heading: 'Bezahlung und Kundenbereich',
        items: [
          {
            question: 'Wie bezahle ich?',
            answer:
              'Auf Rechnung. Nach der Rückgabe erstellen wir deine Endabrechnung, die Rechnung bekommst du per E-Mail. Falls wir eine Anzahlung vereinbaren, wird sie mit der Rechnung verrechnet. Online bezahlen musst du nichts.',
          },
          {
            question: 'Brauche ich ein Kundenkonto?',
            answer:
              'Nein, der Kundenbereich ist freiwillig. Dort siehst du nach der Bestätigung alle Details deiner Miete und deine Dokumente und kannst uns direkt schreiben. Ein Passwort brauchst du nicht – du meldest dich mit einem Link an, den wir dir per E-Mail schicken.',
          },
          {
            question: 'Kann ich stornieren?',
            answer:
              'Ja, nach der Bestätigung direkt in deinem Kundenbereich. Ob eine Gebühr anfällt, hängt davon ab, wie kurzfristig du stornierst. Den genauen Betrag siehst du, bevor du die Stornierung bestätigst.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Noch eine Frage offen?',
        text: 'Ruf uns an oder schreib uns – oder stell dir direkt deine Slushmaschine zusammen.',
        primary: CTA_CONFIGURE,
        secondary: CTA_CONTACT,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16) – die bisherige Website hatte keine FAQ. Antworten aus MASTER_SPEC (§5–§10, §12–§14, §16, §20, §22, §26).',
    'Bewusst ohne Zahlen, die eine zentrale Regel doppeln würden: keine Preise, keine Storno-Prozentsätze, keine Angebotsfristen. Bei Regeländerungen (Inklusivmengen, Sorten, Wochenendzeiten, Abholperson-Frist) Text prüfen.',
    'Nicht zugesagt (erst nach Bestätigung ergänzen): Einweisung vor Ort, telefonische Erreichbarkeit rund um die Uhr, Strom-/Platzbedarf der Maschinen.',
  ),
};

// ── Über uns ─────────────────────────────────────────────────────────────────

const ABOUT: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'about',
  path: '/ueber-uns',
  metaTitle: 'Über uns – Familienbetrieb aus Mainz | Miet-Royal',
  metaDescription:
    'Miet-Royal ist ein kleiner Familienbetrieb aus Mainz. Wir vermieten Slushmaschinen – fair, transparent und persönlich statt anonym.',
  content: {
    title: 'Über uns',
    blocks: [
      {
        type: 'hero',
        heading: 'Über uns: ein Familienbetrieb aus Mainz',
        lead: 'Miet-Royal ist ein kleiner Familienbetrieb aus Mainz. Seit 2023 vermieten wir Slushmaschinen für Feiern aller Art – fair, transparent und kundenfreundlich.',
        primaryCta: CTA_CONFIGURE,
      },
      {
        type: 'text',
        heading: 'Wie alles angefangen hat',
        body: paragraphs(
          'Die Idee zu Miet-Royal entstand bei einem Kindergeburtstag: Dennis suchte für die Feier seiner Tochter eine passende Maschine – und stellte fest, dass die Angebote ausgebucht, zu teuer oder zu kompliziert waren.',
          'So entstand Miet-Royal: ein Vermietungsbetrieb, der es dir so einfach wie möglich machen möchte.',
        ),
      },
      {
        type: 'text',
        heading: 'Persönlich für dich da',
        body: 'Dennis und seine Geschwister kümmern sich gemeinsam um jede Vermietung – persönlich. Wir prüfen deine Anfrage selbst, melden uns mit einem schriftlichen Angebot und sind bei Übergabe und Rückgabe für dich da.',
      },
      {
        type: 'features',
        heading: 'Wofür wir stehen',
        intro: 'Faire Preise. Klare Kommunikation. Ein Erlebnis, das überzeugt.',
        items: [
          {
            title: 'Faire Preise',
            text: 'Die aktuellen Mietpreise siehst du offen auf unserer Website und im Konfigurator. Zusätzliches Verbrauchsmaterial bekommst du auf Kommission – berechnet wird, was du öffnest.',
          },
          {
            title: 'Klare Kommunikation',
            text: 'Du bekommst ein schriftliches Angebot mit allen Positionen. Verbindlich wird es erst, wenn du es annimmst – und im Kundenbereich hast du alle Details im Blick.',
          },
          {
            title: 'Ein Erlebnis, das überzeugt',
            text: 'Nach jeder Rückgabe wird die Maschine gereinigt und erst danach wieder für das nächste Event freigegeben. So bekommst du eine Maschine, die startklar ist.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Wir freuen uns auf deine Anfrage',
        text: 'Erzähl uns von deinem Event – wir melden uns persönlich bei dir.',
        primary: CTA_CONFIGURE,
        secondary: CTA_CONTACT,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16). Geschichte aus der bisherigen Über-uns-Seite übernommen und in „du“-Ansprache umformuliert.',
    'Vor Veröffentlichung vom Inhaber bestätigen lassen: Gründungsjahr 2023, Vorname Dennis, Kindergeburtstag der Tochter als Anlass, Mitarbeit der Geschwister, Leitsatz „Faire Preise. Klare Kommunikation. Ein Erlebnis, das überzeugt.“',
    'Bewusst nicht übernommen: Zähler (Events, Liter, Einsatzorte, Temperatur), Nachhaltigkeitsaussagen (E-Auto, Solarstrom, Baum-Urkunde, Plastic-Fischer), „Startup“, Altersangabe.',
    'Offene Punkte: Team-/Familienfotos (nur eigene Bilder mit Einwilligung), ggf. Nachnamen/Rollen, belegte Nachhaltigkeitsthemen.',
  ),
};

// ── Kontakt ──────────────────────────────────────────────────────────────────

const CONTACT: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'contact',
  path: '/kontakt',
  metaTitle: 'Kontakt | Miet-Royal',
  metaDescription:
    'So erreichst du Miet-Royal: Telefon, E-Mail und Abholung in Mainz-Hechtsheim. Für dein Angebot nutzt du am besten direkt den Slush-Konfigurator.',
  content: {
    title: 'Kontakt',
    blocks: [
      {
        type: 'hero',
        heading: 'Kontakt – wir sind für dich da',
        lead: 'Du hast eine Frage zu deinem Event, zu unseren Maschinen oder zum Ablauf? Ruf uns an oder schreib uns eine E-Mail. Für ein konkretes Angebot nutzt du am besten direkt den Konfigurator – dort hast du alle wichtigen Angaben beisammen.',
        primaryCta: CTA_CONFIGURE,
      },
      {
        type: 'contact_details',
        heading: 'So erreichst du uns',
        intro: 'Wir antworten dir persönlich.',
      },
      {
        type: 'text',
        heading: 'Abholung in Mainz-Hechtsheim',
        body: 'Unsere Maschinen holst du in Mainz-Hechtsheim ab. Die genaue Abholadresse bekommst du mit der Bestätigung deiner Buchung – du findest sie dann auch in deinem Kundenbereich.',
      },
      {
        type: 'faq',
        heading: 'Kurz beantwortet',
        items: [
          {
            question: 'Wie komme ich am schnellsten zu einem Angebot?',
            answer:
              'Über den Konfigurator. Dort gibst du alles an, was wir für dein Angebot brauchen – Datum, Gästezahl, Maschine, Sirup, Abholung oder Lieferung. Wir prüfen deine Anfrage persönlich und melden uns bei dir.',
          },
          {
            question: 'Ist meine Anfrage verbindlich?',
            answer: 'Nein. Verbindlich wird es erst, wenn du dein schriftliches Angebot annimmst.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Noch Fragen offen?',
        text: 'In unseren häufigen Fragen findest du Antworten rund um Miete, Abholung und Rückgabe.',
        primary: CTA_CONFIGURE,
        secondary: CTA_FAQ,
      },
    ],
  },
  editorNote: lines(
    'Erst-Entwurf (Phase 16). Telefon und E-Mail kommen aus den Website-Einstellungen – dort vor Veröffentlichung bestätigen.',
    'Kein Kontaktformular: Anfragen laufen über den Konfigurator (genau ein Vorgang je Anfrage).',
    'Öffnungszeiten: auf der bisherigen Website nicht vorhanden – nicht erfinden, ggf. ergänzen.',
    'Die genaue Abholadresse nie nennen (bisherige Kontaktseite zeigte sie öffentlich – nicht übernommen).',
  ),
};

// ── Rechtstexte (redaktionelle Entwürfe aus der bisherigen Website) ──────────

const IMPRINT: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'legal',
  path: '/impressum',
  metaTitle: 'Impressum | Miet-Royal',
  metaDescription: 'Impressum von Miet-Royal – Angaben zum Anbieter dieser Website.',
  content: {
    title: 'Impressum',
    blocks: [
      {
        type: 'text',
        body: lines(
          'Miet Royal',
          'Dennis Zeptr Vermietungen',
          'Anschrift: [vor Veröffentlichung eintragen]',
          'Telefon: +49 160 96663665',
          'E-Mail: info@miet-royal.de',
          'USt-ID: 26/197/63574',
        ),
      },
      {
        type: 'text',
        heading: 'Verantwortlich gemäß § 18 Abs. 2 MStV',
        body: 'Dennis Zeptr Vermietungen, Anschrift: [vor Veröffentlichung eintragen]',
      },
      {
        type: 'text',
        heading: 'Haftung für Inhalte',
        body: 'Als Diensteanbieter sind wir gemäß § 7 Abs.1 TMG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 TMG sind wir als Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.',
      },
      {
        type: 'text',
        heading: 'Haftung für Links',
        body: 'Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich.',
      },
      {
        type: 'text',
        heading: 'Urheberrecht',
        body: 'Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechts bedürfen der schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers.',
      },
      {
        type: 'text',
        heading: 'Informationen gemäß Verbraucherstreitbeilegungsgesetz',
        body: 'Wir sind weder bereit noch verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
      },
    ],
  },
  editorNote: lines(
    'Redaktioneller Entwurf aus der bisherigen Website (miet-royal.de/impressum, Stand 2026-03-09) – vor Live rechtlich prüfen. Text unverändert übernommen und NICHT juristisch angepasst – einzige Ausnahme: die Anschrift.',
    'Prüfpunkte:',
    '1. Anschrift bewusst nicht übernommen: Impressum und Datenschutz der alten Website nannten zwei verschiedene Anschriften; eine davon ist der Abholort, der öffentlich nicht als Abholadresse erscheinen darf. Ladungsfähige Geschäftsanschrift nach Prüfung an beiden Platzhaltern eintragen.',
    '2. „USt-ID: 26/197/63574“ hat das Format einer Steuernummer, nicht einer USt-IdNr. (DE + 9 Ziffern) – klären, welche Angabe richtig und nötig ist.',
    '3. Haftungstexte verweisen auf das TMG (§ 7, §§ 8–10) – aktuelle Rechtsgrundlage prüfen.',
    '4. Inhaber-/Firmenbezeichnung bestätigen: Schreibweise „Dennis Zeptr Vermietungen“ (anderswo „Zepter“), „Miet Royal“ vs. Marke „Miet-Royal“, Rechtsform vollständig?',
    '5. „Verantwortlich gemäß § 18 Abs. 2 MStV“ – nötig und richtig?',
    '6. Aussage zur Verbraucherstreitbeilegung bestätigen.',
    'Telefon/E-Mail wie in den Website-Einstellungen – dort ebenfalls vor Veröffentlichung bestätigen.',
  ),
};

const PRIVACY: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'legal',
  path: '/datenschutz',
  metaTitle: 'Datenschutz | Miet-Royal',
  metaDescription:
    'Datenschutzhinweise von Miet-Royal: wie wir deine personenbezogenen Daten verarbeiten und welche Rechte du hast.',
  content: {
    title: 'Datenschutz',
    blocks: [
      {
        type: 'text',
        body: 'Wir freuen uns über dein Interesse an Miet Royal. Der Schutz deiner persönlichen Daten ist uns ein besonderes Anliegen. Wir behandeln deine personenbezogenen Daten vertraulich und entsprechend den gesetzlichen Datenschutzvorschriften der DSGVO sowie dieser Datenschutzerklärung.',
      },
      {
        type: 'text',
        heading: '1. Verantwortlicher',
        body: lines(
          'Miet Royal',
          'Anschrift: wie im Impressum angegeben',
          'Telefon: +49 160 96663665',
          'E-Mail: info@miet-royal.de',
        ),
      },
      {
        type: 'text',
        heading: '2. Erhebung und Speicherung personenbezogener Daten',
        body: paragraphs(
          lines(
            'Wir verarbeiten personenbezogene Daten nur, wenn dies gesetzlich erlaubt ist oder du in die Datenverarbeitung einwilligst. Zu den verarbeiteten Daten gehören zum Beispiel:',
            bullets(
              'Name',
              'Anschrift',
              'Telefonnummer',
              'E-Mail-Adresse',
              'Buchungsdaten',
              'Zahlungsinformationen',
              'Empfohlener Kontakt (wenn angegeben)',
            ),
          ),
          lines(
            'Diese Daten werden erhoben, wenn du:',
            bullets(
              'unser Online-Buchungssystem nutzt',
              'unser Kontaktformular ausfüllst',
              'uns telefonisch oder per E-Mail kontaktierst',
              'eine Mietanfrage stellst',
              'eine Buchung abschließt',
            ),
          ),
        ),
      },
      {
        type: 'text',
        heading: '3. Zweck der Datenverarbeitung',
        body: lines(
          'Wir verwenden deine personenbezogenen Daten ausschließlich zu folgenden Zwecken:',
          bullets(
            'Bearbeitung deiner Anfrage',
            'Durchführung und Abwicklung der Vermietung',
            'Kommunikation im Rahmen der Buchung',
            'Abrechnung und Zahlungsabwicklung',
            'Bereitstellung von Zubehör oder Kommissionsartikeln',
            'Erfüllung gesetzlicher Pflichten (z. B. steuerliche Aufbewahrungspflichten)',
          ),
        ),
      },
      {
        type: 'text',
        heading: '4. Weitergabe von Daten an Dritte',
        body: paragraphs(
          lines(
            'Eine Weitergabe deiner Daten an Dritte erfolgt nur, wenn:',
            bullets(
              'dies zur Durchführung des Mietvertrags erforderlich ist (z. B. Zahlungsanbieter)',
              'du ausdrücklich eingewilligt hast',
              'wir gesetzlich dazu verpflichtet sind',
            ),
          ),
          lines(
            'Mögliche Empfänger:',
            bullets(
              'Zahlungsdienstleister wie PayPal, EC-Zahlungsanbieter oder Kreditkartenanbieter',
              'Steuerberater / Finanzbehörden im Rahmen gesetzlicher Pflichten',
            ),
          ),
          'Eine Weitergabe zu Werbezwecken findet nicht statt.',
        ),
      },
      {
        type: 'text',
        heading: '5. Speicherung und Löschung der Daten',
        body: paragraphs(
          'Wir speichern deine personenbezogenen Daten nur so lange, wie sie für den jeweiligen Zweck erforderlich sind oder wir gesetzlich dazu verpflichtet sind.',
          'Nach Ablauf der gesetzlichen Aufbewahrungsfristen werden die Daten gelöscht.',
        ),
      },
      {
        type: 'text',
        heading: '6. Cookies',
        body: paragraphs(
          'Unsere Webseite verwendet Cookies, um bestimmte Funktionen bereitzustellen und die Nutzerfreundlichkeit zu verbessern.',
          'Du kannst die Speicherung von Cookies in deinem Browser deaktivieren. Dies kann jedoch zu Einschränkungen der Funktionalität führen.',
        ),
      },
      {
        type: 'text',
        heading: '7. Server-Logfiles',
        body: paragraphs(
          lines(
            'Beim Besuch der Website werden automatisch technische Daten durch den Server erfasst:',
            bullets(
              'Browsertyp',
              'Uhrzeit des Zugriffs',
              'IP-Adresse (gekürzt)',
              'Besuchte Seiten',
            ),
          ),
          'Diese Daten sind nicht bestimmten Personen zuordenbar und dienen der Sicherheit sowie der Verbesserung der Website.',
        ),
      },
      {
        type: 'text',
        heading: '8. Kontaktformular & Buchungssystem',
        body: paragraphs(
          'Wenn du uns über das Kontaktformular oder über das Buchungssystem eine Anfrage sendest, speichern wir die von dir angegebenen Daten zur Bearbeitung der Anfrage oder Buchung.',
          'Diese Daten geben wir nicht ohne deine Einwilligung weiter.',
        ),
      },
      {
        type: 'text',
        heading: '9. Zahlungsabwicklung',
        body: paragraphs(
          'Bei Zahlungen (Rechnung, EC, Mastercard, American Express, VISA, V Pay, PayPal) werden die erforderlichen Daten zur Abwicklung an den jeweiligen Zahlungsdienstleister übertragen.',
          'Die Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO.',
        ),
      },
      {
        type: 'text',
        heading: '10. YouTube-Einbindungen',
        body: paragraphs(
          lines(
            'Auf der Seite „Ablauf der Miete“ binden wir YouTube-Videos ein.',
            'YouTube ist ein Dienst von Google Ireland Limited.',
            'Beim Abspielen eines Videos können Cookies gesetzt oder Daten an Google übertragen werden.',
          ),
          'Weitere Informationen: https://policies.google.com/privacy',
        ),
      },
      {
        type: 'text',
        heading: '11. Deine Rechte als betroffene Person',
        body: paragraphs(
          lines(
            'Du hast jederzeit folgende Rechte:',
            bullets(
              'Recht auf Auskunft (Art. 15 DSGVO)',
              'Recht auf Berichtigung (Art. 16 DSGVO)',
              'Recht auf Löschung (Art. 17 DSGVO)',
              'Recht auf Einschränkung (Art. 18 DSGVO)',
              'Recht auf Datenübertragbarkeit (Art. 20 DSGVO)',
              'Recht auf Widerspruch (Art. 21 DSGVO)',
            ),
          ),
          'Hierzu kannst du uns jederzeit kontaktieren.',
        ),
      },
      {
        type: 'text',
        heading: '12. Widerruf deiner Einwilligung',
        body: lines(
          'Du kannst eine bereits erteilte Einwilligung jederzeit formlos widerrufen.',
          'Der Widerruf berührt die Rechtmäßigkeit der Datenverarbeitung bis zum Widerruf nicht.',
        ),
      },
      {
        type: 'text',
        heading: '13. Sicherheit deiner Daten',
        body: 'Wir verwenden technische und organisatorische Sicherheitsmaßnahmen, um deine Daten gegen Verlust, Missbrauch oder unbefugten Zugriff zu schützen.',
      },
      {
        type: 'text',
        heading: '14. Änderungen der Datenschutzerklärung',
        body: 'Wir behalten uns vor, diese Datenschutzerklärung bei Bedarf anzupassen, damit sie stets den aktuellen gesetzlichen Anforderungen entspricht.',
      },
    ],
  },
  editorNote: lines(
    'Redaktioneller Entwurf aus der bisherigen Website (miet-royal.de/datenschutz, Stand 2026-03-09) – vor Live rechtlich prüfen. Nur die Ansprache auf „du“ umgestellt (plus Tippfehler „Rechtgrundlage“); Inhalt sonst unverändert und NICHT juristisch angepasst.',
    'Die veröffentlichte Revision dieser Seite ist Voraussetzung für Website-Anfragen (Datenschutz-Nachweis je Anfrage).',
    'Prüfpunkte:',
    '1. Verantwortlicher: Die alte Fassung nannte hier die genaue Abholadresse – nicht übernommen, darf nicht öffentlich erscheinen. Ladungsfähige Anschrift nach Prüfung eintragen (alte Fassung widersprach außerdem der Impressumsanschrift).',
    '2. „Online-Buchungssystem“, „Kontaktformular“, „Buchung abschließen“: Die neue Website hat nur den Konfigurator (unverbindliche Anfrage, Datenschutz-Nachweis mit Zeitpunkt und Version) und den Kundenbereich (Anmeldelink per E-Mail, Sitzungs-Cookie) – beschreiben.',
    '3. Zahlungsabwicklung (PayPal, EC, Kreditkarten): Die neue Website hat keine Online-Zahlung; Rechnung über Lexware prüfen.',
    '4. YouTube: Die neue Website bindet kein YouTube ein.',
    '5. Cookies: Die neue Website setzt nur technisch notwendige Cookies (Sitzung im Kundenbereich; Vorschau nur für Mitarbeitende) – Abschnitt anpassen.',
    '6. Server-Logfiles: Hoster, Rechtsgrundlage und Speicherdauer fehlen.',
    '7. Fehlt: Google-Bewertungen (Abruf erst nach Klick, Texte/Profilbilder von Google), Instagram-Link, E-Mail-Versanddienst, Rechtsgrundlagen je Zweck, konkrete Speicherfristen, Aufsichtsbehörde/Beschwerderecht, Stand/Datum.',
    '8. Schreibweise „Miet Royal“ vs. Marke „Miet-Royal“.',
  ),
};

// ── Sekundäre Angebote (nur Struktur – Geschäftsdaten fehlen) ────────────────

const POPCORN: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'secondary_offer',
  path: '/popcornmaschine-mieten',
  metaTitle: 'Popcornmaschine mieten in Mainz | Miet-Royal',
  metaDescription:
    'Popcornmaschine mieten bei Miet-Royal aus Mainz – die Ergänzung zur Slushmaschine für deine Feier. Alle Details stimmen wir persönlich mit dir ab.',
  content: {
    title: 'Popcornmaschine mieten',
    blocks: [
      {
        type: 'hero',
        heading: 'Popcornmaschine mieten',
        lead: 'Frisches Popcorn passt zu fast jeder Feier. Neben unseren Slushmaschinen vermieten wir auch Popcornmaschinen – sprich uns einfach an, wir stimmen alle Details persönlich mit dir ab.',
        primaryCta: CTA_CONTACT,
        secondaryCta: CTA_CONFIGURE,
      },
      {
        type: 'text',
        heading: 'So fragst du an',
        body: paragraphs(
          'Popcornmaschinen sind bei uns ein Zusatzangebot. Preis, Ausstattung und Transport besprechen wir derzeit persönlich mit dir: Ruf uns an oder schreib uns, für wann und für wie viele Gäste du planst.',
          'Du möchtest Slush und Popcorn kombinieren? Sag uns einfach Bescheid.',
        ),
      },
      {
        type: 'contact_details',
        heading: 'Sprich uns an',
      },
    ],
  },
  editorNote: lines(
    'Nur Struktur (Phase 16) – Seite bleibt Entwurf, bis die fehlenden Geschäftsdaten bestätigt sind (OPEN_ITEMS „Popcorn/Waffel“, Order §30):',
    '– Mietpreis: als Produkt mit Preis im Produktkatalog anlegen und dann einen Block „Produkte“ mit diesem Produkt ergänzen – nie einen Preis in den Text schreiben.',
    '– Inklusivleistungen/Zusatzmengen: bisherige Website widersprüchlich („250 g Mais + 25 Popcorntüten“ vs. „1× 250 g Popcorn“) – nicht übernommen.',
    '– Mengenlimit (alt: max. 2 Maschinen) – unbestätigt.',
    '– Transport, Abholung/Lieferung, Strom-/Platzbedarf.',
    '– Anfrageweg: Der Konfigurator kann nur Slush; bis dahin Kontakt per Telefon/E-Mail.',
    '– Bilder: eigenes Foto der Popcornmaschine (alte Website) nur nach Klärung von Eigentum/Rechten; Stock- und KI-Bilder der alten Website nicht verwenden.',
  ),
};

const WAFFLE: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'secondary_offer',
  path: '/waffeleisen-mieten',
  metaTitle: 'Waffeleisen mieten in Mainz | Miet-Royal',
  metaDescription:
    'Waffeleisen mieten bei Miet-Royal aus Mainz – für frische Waffeln auf deiner Feier. Was dazugehört, klären wir persönlich mit dir.',
  content: {
    title: 'Waffeleisen mieten',
    blocks: [
      {
        type: 'hero',
        heading: 'Waffeleisen mieten',
        lead: 'Duftende Waffeln, frisch vom Eisen: Neben Slushmaschinen vermieten wir auch Waffeleisen für deine Feier. Erzähl uns von deinem Event – wir klären die Details persönlich mit dir.',
        primaryCta: CTA_CONTACT,
        secondaryCta: CTA_CONFIGURE,
      },
      {
        type: 'text',
        heading: 'Anfrage und Details',
        body: 'Waffeleisen sind bei uns ein Zusatzangebot. Was genau dazugehört, was die Miete kostet und wie das Eisen zu dir kommt, besprechen wir aktuell persönlich mit dir. Melde dich einfach telefonisch oder per E-Mail.',
      },
      {
        type: 'contact_details',
        heading: 'So erreichst du uns',
      },
      {
        type: 'cta',
        heading: 'Und dazu eine Slushmaschine?',
        text: 'Waffeln und eiskalter Slush – stell dir deine Slushmaschine gleich im Konfigurator zusammen.',
        primary: CTA_CONFIGURE,
      },
    ],
  },
  editorNote: lines(
    'Nur Struktur (Phase 16) – Seite bleibt Entwurf, bis die fehlenden Geschäftsdaten bestätigt sind (OPEN_ITEMS „Popcorn/Waffel“, Order §30):',
    '– Mietpreis: als Produkt mit Preis im Produktkatalog anlegen und dann einen Block „Produkte“ mit diesem Produkt ergänzen – nie einen Preis in den Text schreiben.',
    '– Inklusivleistungen/Zubehör (alt: „ohne Zubehör, Teig selbst zubereiten“) – unbestätigt, nicht übernommen.',
    '– Mengenlimit (alt: max. 4 Geräte) – unbestätigt.',
    '– Transport, Abholung/Lieferung, Strom-/Platzbedarf.',
    '– Anfrageweg: Der Konfigurator kann nur Slush; bis dahin Kontakt per Telefon/E-Mail.',
    '– Bilder: Das Waffeleisen-Bild der alten Website ist ein Händler-Produktfoto – nicht verwenden; eigenes Foto (Herz-Waffeleisen) nur nach Klärung der Rechte.',
  ),
};

// ── Regionale Seiten (je eigener Text, keine Ortsnamen-Schablone) ────────────

const REGION_NOTE_COMMON =
  'Nur belegte Aussagen: Abholung in Mainz-Hechtsheim, Lieferung individuell geprüft, Inklusivleistungen laut MASTER_SPEC. Ergänzen nur mit echten lokalen Bezügen (bestätigte Einsatzorte, eigene Erfahrungen, eigene Fotos) – keine erfundenen Referenzen, Orte oder Entfernungen. Nicht automatisch veröffentlichen; finale SEO-Prüfung in Phase 17.';

const REGION_MAINZ: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'region',
  path: '/slushmaschine-mieten/mainz',
  metaTitle: 'Slushmaschine mieten in Mainz | Miet-Royal',
  metaDescription:
    'Slushmaschine mieten in Mainz: Familienbetrieb aus Mainz, Abholung in Mainz-Hechtsheim, Lieferung auf Anfrage. Sirup, Becher und Strohhalme inklusive.',
  content: {
    title: 'Slushmaschine mieten in Mainz',
    blocks: [
      {
        type: 'hero',
        heading: 'Slushmaschine mieten in Mainz',
        lead: 'Miet-Royal ist ein Familienbetrieb aus Mainz – und abgeholt wird bei uns in Mainz-Hechtsheim. Stell dir deine Maschine online zusammen, wir melden uns persönlich mit deinem Angebot.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_INQUIRE_CONTACT,
      },
      {
        type: 'text',
        heading: 'Slush für deine Feier in Mainz',
        body: paragraphs(
          'Ob Geburtstag im Garten, Hochzeit, Sommerfest im Verein oder Feier in der Kita: Eine Slushmaschine sorgt für bunte, eiskalte Erfrischung – bei Groß und Klein.',
          'Du holst die Maschine in Mainz-Hechtsheim ab und nimmst sie direkt mit zu deinem Fest. Die genaue Abholadresse bekommst du, sobald deine Buchung bestätigt ist. Lieber liefern lassen? Dann gib im Konfigurator die Adresse deines Eventorts an – wir prüfen die Lieferung individuell und nennen dir den Preis in deinem Angebot.',
        ),
      },
      {
        type: 'product_grid',
        heading: 'Welche Maschine darf es sein?',
        intro:
          'Ein Behälter für eine Sorte oder zwei Behälter für zwei Sorten – mit 8 oder 10 Litern pro Behälter.',
      },
      {
        type: 'faq',
        heading: 'Kurz gefragt',
        items: [
          {
            question: 'Wo in Mainz hole ich die Maschine ab?',
            answer:
              'In Mainz-Hechtsheim. Die genaue Adresse schicken wir dir mit der Bestätigung, außerdem findest du sie dann in deinem Kundenbereich.',
          },
          {
            question: 'Liefert ihr innerhalb von Mainz?',
            answer:
              'Eine Lieferung kannst du im Konfigurator anfragen. Wir prüfen sie für deinen Eventort und Termin individuell – den Lieferpreis findest du dann in deinem Angebot.',
          },
          {
            question: 'Wann bekomme ich mein Angebot?',
            answer:
              'Wir schauen uns jede Anfrage persönlich an und melden uns so bald wie möglich mit deinem schriftlichen Angebot – als Link und als PDF.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Dein Fest in Mainz kann kommen',
        text: 'Maschine wählen, Sorten festlegen, Anfrage absenden – unverbindlich und bequem online.',
        primary: CTA_CONFIGURE,
        secondary: CTA_PROCESS,
      },
    ],
  },
  editorNote: lines(
    'Regionaler Erst-Entwurf (Phase 16) – vor Veröffentlichung lokal prüfen.',
    REGION_NOTE_COMMON,
    'Mainz: „Familienbetrieb aus Mainz“ stammt von der bisherigen Website – bestätigen.',
  ),
};

const REGION_WIESBADEN: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'region',
  path: '/slushmaschine-mieten/wiesbaden',
  metaTitle: 'Slushmaschine mieten in Wiesbaden | Miet-Royal',
  metaDescription:
    'Slushmaschine für dein Event in Wiesbaden: abholen in Mainz-Hechtsheim oder Lieferung individuell anfragen. Zuckerfreier Sirup, Becher und Strohhalme inklusive.',
  content: {
    title: 'Slushmaschine mieten in Wiesbaden',
    blocks: [
      {
        type: 'hero',
        heading: 'Slushmaschine für dein Event in Wiesbaden',
        lead: 'Du feierst in Wiesbaden und möchtest deinen Gästen etwas Besonderes bieten? Mit einer Slushmaschine von Miet-Royal gibt es eiskalten Slush in deinen Lieblingssorten – unkompliziert angefragt, persönlich geprüft.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_INQUIRE_CONTACT,
      },
      {
        type: 'text',
        heading: 'Abholen oder liefern lassen',
        body: paragraphs(
          'Für Events in Wiesbaden hast du zwei Möglichkeiten: Du holst die Maschine selbst bei uns in Mainz-Hechtsheim ab – die genaue Adresse bekommst du nach der Bestätigung. Oder du fragst eine Lieferung an: Gib im Konfigurator die Adresse deines Eventorts und dein Wunsch-Zeitfenster an. Wir prüfen jede Lieferung individuell und schreiben dir den Preis dafür direkt in dein Angebot.',
          'Bei Feiern am Wochenende gilt als Standard: Abholung am Freitag um 18 Uhr, Rückgabe am Sonntag um 11 Uhr. Passt dir das nicht, finden wir gemeinsam andere Zeiten.',
        ),
      },
      {
        type: 'included_items',
        heading: 'Damit kannst du rechnen',
        intro:
          'Zu jeder Miete gehört ein Grundpaket aus Sirup, Bechern und Strohhalmen. Was du darüber hinaus brauchst, nimmst du auf Kommission mit.',
      },
      {
        type: 'features',
        heading: 'Für kleine und große Runden',
        items: [
          {
            title: 'Zwei Sorten parallel',
            text: 'Mit einer Maschine mit zwei Behältern bietest du zwei Geschmacksrichtungen gleichzeitig an – etwa Wassermelone und Blaue Himbeere.',
          },
          {
            title: 'Zuckerfreier Sirup',
            text: 'Unsere Sirups sind zuckerfrei und kommen aus Deutschland.',
          },
          {
            title: 'Viele Gäste?',
            text: 'Ab 250 Gästen stimmen wir die Planung persönlich mit dir ab – anfragen kannst du ganz normal.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Bereit für Slush in Wiesbaden?',
        text: 'Stell dir deine Ausstattung zusammen und sieh direkt eine Preisübersicht – verbindlich wird erst dein schriftliches Angebot.',
        primary: CTA_CONFIGURE,
        secondary: CTA_FAQ,
      },
    ],
  },
  editorNote: lines(
    'Regionaler Erst-Entwurf (Phase 16) – vor Veröffentlichung lokal prüfen.',
    REGION_NOTE_COMMON,
    'Wiesbaden: Die bisherige Website nannte „Mainz, Wiesbaden und Umgebung“ als Einsatzgebiet – Lieferung nach Wiesbaden mit dem Inhaber abstimmen.',
  ),
};

const REGION_BAD_KREUZNACH: CmsBootstrapEntry = {
  kind: 'page',
  pageType: 'region',
  path: '/slushmaschine-mieten/bad-kreuznach',
  metaTitle: 'Slushmaschine mieten in Bad Kreuznach | Miet-Royal',
  metaDescription:
    'Slushmaschine mieten für deine Feier in Bad Kreuznach – online zusammenstellen, persönlich geprüftes Angebot erhalten. Abholung in Mainz-Hechtsheim.',
  content: {
    title: 'Slushmaschine mieten in Bad Kreuznach',
    blocks: [
      {
        type: 'hero',
        heading: 'Eiskalter Slush für deine Feier in Bad Kreuznach',
        lead: 'Für deine Feier in Bad Kreuznach stellst du dir deine Slushmaschine ganz einfach online zusammen. Wir prüfen deine Anfrage persönlich und melden uns mit einem schriftlichen Angebot.',
        primaryCta: CTA_CONFIGURE,
        secondaryCta: CTA_INQUIRE_CONTACT,
      },
      {
        type: 'text',
        heading: 'So kommt der Slush zu dir',
        body: paragraphs(
          'Abgeholt wird bei uns in Mainz-Hechtsheim. Ist dir die Abholung zu aufwendig, frag im Konfigurator einfach eine Lieferung nach Bad Kreuznach an. Ob und zu welchen Konditionen wir liefern, prüfen wir für deinen Termin individuell und sagen es dir in deinem Angebot.',
          'Frag am besten frühzeitig an – dann haben wir mehr Spielraum bei der Planung.',
        ),
      },
      {
        type: 'steps',
        heading: 'In drei Schritten zu deinem Slush',
        items: [
          {
            title: 'Zusammenstellen',
            text: 'Wähle im Konfigurator Datum, Gästezahl, Maschine und Sirupsorten.',
          },
          {
            title: 'Angebot erhalten',
            text: 'Wir prüfen alles persönlich und schicken dir dein Angebot als Link und als PDF.',
          },
          {
            title: 'Annehmen und feiern',
            text: 'Passt alles, nimmst du das Angebot online an – ohne Unterschrift.',
          },
        ],
      },
      {
        type: 'product_grid',
        heading: 'Die Maschinen',
        intro:
          'Wähle zwischen einem und zwei Behältern mit je 8 oder 10 Litern. Unsicher? Gib deine Gästezahl an – wir beraten dich persönlich.',
      },
      {
        type: 'faq',
        heading: 'Gut zu wissen',
        items: [
          {
            question: 'Was ist bei der Miete dabei?',
            answer:
              '1 Liter Sirup je Maschinenbehälter sowie 25 Becher und 25 Strohhalme je Mietvorgang. Mehr Sirup, Becher und Strohhalme bekommst du auf Kommission.',
          },
          {
            question: 'Muss ich mich gleich für eine Sorte entscheiden?',
            answer:
              'Nein. Den inklusiven Sirup kannst du frei auf unsere Sorten verteilen oder die Sorte später mit uns abstimmen.',
          },
        ],
      },
      {
        type: 'cta',
        heading: 'Lass uns über deine Feier sprechen',
        text: 'Unverbindlich anfragen und persönlich beraten lassen.',
        primary: CTA_CONFIGURE,
        secondary: CTA_CONTACT,
      },
    ],
  },
  editorNote: lines(
    'Regionaler Erst-Entwurf (Phase 16) – vor Veröffentlichung lokal prüfen.',
    REGION_NOTE_COMMON,
    'Bad Kreuznach steht im SEO-Fokus der MASTER_SPEC (§30), die bisherige Website nennt den Ort nicht – vor Veröffentlichung bestätigen, dass Anfragen und Lieferungen dorthin gewünscht sind.',
  ),
};

/**
 * Standard-Einträge in Bootstrap-Reihenfolge (Design §2.1): Einstellungen, Hauptseiten,
 * Rechtstexte, sekundäre Angebote, erste Regionsseiten.
 */
export const CMS_BOOTSTRAP_ENTRIES: readonly CmsBootstrapEntry[] = [
  SITE_SETTINGS,
  HOME,
  SLUSH,
  PROCESS,
  FAQ,
  ABOUT,
  CONTACT,
  IMPRINT,
  PRIVACY,
  POPCORN,
  WAFFLE,
  REGION_MAINZ,
  REGION_WIESBADEN,
  REGION_BAD_KREUZNACH,
];
