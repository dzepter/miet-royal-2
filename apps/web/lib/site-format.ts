/**
 * Phase 16 (WEB, Design §5): reine Formatierer der öffentlichen Website.
 *
 * Geld kommt immer als Integer-Cent aus der API und wird hier nur angezeigt
 * (de-DE, „1.234,56 €“ – derselbe deterministische Formatierer wie im Portal);
 * die Website rechnet nie Geld. Ohne React-/Browser-Abhängigkeit (node --test).
 */
import { euro, formatTime } from './portal.ts';
import type { PublicMachine, PublicProduct } from './site-types.ts';

export const SITE_BRAND_NAME = 'Miet-Royal';

/** Integer-Cent ⇒ „60,00 €“ (nur Anzeige; ungültige Werte ⇒ „–“). */
export function formatPriceCents(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return '–';
  return euro(cents);
}

/** Dezimalzahl (z. B. Liter) ⇒ deutsche Schreibweise ohne unnötige Nachkommastellen. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace('.', ',');
}

/**
 * Reiner CMS-Text ⇒ Absätze (an Leerzeilen getrennt), jeder Absatz als Zeilenliste.
 * Kein HTML: die Ausgabe wird ausschließlich als React-Text gerendert.
 */
export function textParagraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    )
    .filter((lines) => lines.length > 0);
}

export function isMachine(product: PublicProduct | PublicMachine): product is PublicMachine {
  const candidate = product as Partial<PublicMachine>;
  return (
    typeof candidate.containerCount === 'number' &&
    candidate.containerCount > 0 &&
    typeof candidate.containerVolumeLiters === 'number' &&
    candidate.containerVolumeLiters > 0
  );
}

/** Menge mit Einheit aus der Übersicht: Liter ⇒ „2 L“, sonst „3 × 25er-Pack“. */
export function quantityText(quantity: number, unit: string): string {
  const amount = formatNumber(quantity);
  const trimmed = unit.trim();
  if (trimmed === '') return amount;
  if (trimmed === 'L') return `${amount} L`;
  return `${amount} × ${trimmed}`;
}

/** „2 Behälter à 8 L“ / „1 Behälter à 10 L“. */
export function machineCapacityText(machine: PublicMachine): string {
  return `${machine.containerCount} Behälter à ${formatNumber(machine.containerVolumeLiters)} L`;
}

/**
 * Preiszeile eines Katalogartikels – nur aus DTO-Werten:
 * Maschine ⇒ „Mietpreis 60,00 €“; Kommission ⇒ „12,00 € je 1-L-Flasche · auf Kommission“;
 * Kaufartikel ⇒ „5,00 € je Stück · Kaufartikel“.
 */
export function productPriceText(product: PublicProduct | PublicMachine): string {
  const price = formatPriceCents(product.priceCents);
  if (product.category === 'machine') return `Mietpreis ${price}`;
  const unit = product.unitLabel.trim() === '' ? '' : ` je ${product.unitLabel.trim()}`;
  if (product.billingMode === 'commission') return `${price}${unit} · auf Kommission`;
  return `${price}${unit} · Kaufartikel`;
}

/**
 * Dokumenttitel einer Website-Seite (Design §11.2.9: kein Titel-Template im Root-Layout):
 * Meta-Titel bzw. Seitentitel + „ – Miet-Royal“, außer die Marke steht schon darin.
 */
export function sitePageTitle(metaTitle: string | null | undefined, title: string): string {
  const base = (metaTitle ?? '').trim() !== '' ? (metaTitle ?? '').trim() : title.trim();
  if (base === '') return SITE_BRAND_NAME;
  if (base.toLocaleLowerCase('de-DE').includes(SITE_BRAND_NAME.toLocaleLowerCase('de-DE'))) {
    return base;
  }
  return `${base} – ${SITE_BRAND_NAME}`;
}

/** Bewertung ⇒ „4,8 von 5“ (Text statt nur Sterne/Farbe). */
export function ratingText(rating: number): string {
  if (!Number.isFinite(rating)) return '–';
  const clamped = Math.min(5, Math.max(0, rating));
  return `${formatNumber(Math.round(clamped * 10) / 10)} von 5`;
}

/** Ganze Sterne für die visuelle Darstellung (Text daneben ist maßgeblich). */
export function ratingStars(rating: number): string {
  const full = Math.min(5, Math.max(0, Math.round(Number.isFinite(rating) ? rating : 0)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/** Ablaufzeit der Vorschau ⇒ „14:30“ (Europe/Berlin). */
export function formatBerlinClock(iso: string): string {
  return formatTime(iso);
}

/** `tel:`-Link aus einer Anzeige-Telefonnummer (nur Ziffern und führendes +). */
export function phoneHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^0-9+]/g, '');
  const normalized = digits.startsWith('+')
    ? `+${digits.slice(1).replace(/\+/g, '')}`
    : digits.replace(/\+/g, '');
  return /^\+?[0-9]{6,20}$/.test(normalized) ? `tel:${normalized}` : null;
}
