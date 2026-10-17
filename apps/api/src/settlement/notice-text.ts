/**
 * Textaufbau der kombinierten Kundeninformation vor Schaden-/Fehlteil-
 * belastung (Phase-9-Vorgabe §25): Vorgangsnummer, je Position Beschreibung
 * und Betrag, Gesamtsumme der zusätzlichen Belastungen, Hinweis auf das
 * Rückgabeprotokoll, neutraler Schluss – keine Drohformulierung, keine
 * MwSt-Texte (§3), keine Fotos (§25). Reine Darstellung: hier wird nichts
 * berechnet, Beträge kommen als Integer-Cent aus dem Settlement.
 */

export interface NoticePosition {
  lineId: string;
  type: 'damage_charge' | 'missing_item_charge';
  description: string;
  amountCents: number;
}

/** Integer-Cent → „1.234,56 EUR“ ohne Gleitkomma-Arithmetik. */
export function formatEuroCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped},${String(rest).padStart(2, '0')} EUR`;
}

export function noticeSubject(processNumber: string): string {
  return `Information zu Ihrer Rückgabe – Vorgang ${processNumber}`;
}

export function buildCustomerNoticeText(input: {
  processNumber: string;
  customerName: string;
  positions: readonly NoticePosition[];
  totalCents: number;
}): { subject: string; bodyText: string } {
  const greeting =
    input.customerName.trim() === '' ? 'Guten Tag,' : `Guten Tag ${input.customerName.trim()},`;
  const lines = input.positions.map(
    (position) => `- ${position.description}: ${formatEuroCents(position.amountCents)}`,
  );
  const bodyText =
    `${greeting}\n\n` +
    `bei der Rückgabe zu Ihrem Vorgang ${input.processNumber} haben wir folgende Punkte festgestellt, ` +
    'die wir Ihnen zusätzlich berechnen müssen:\n\n' +
    `${lines.join('\n')}\n\n` +
    `Summe der zusätzlichen Belastungen: ${formatEuroCents(input.totalCents)}\n\n` +
    'Die Einzelheiten finden Sie im Rückgabeprotokoll, das Ihnen bereits vorliegt.\n' +
    'Wenn Sie Fragen dazu haben oder etwas anders sehen, melden Sie sich gern bei uns.\n\n' +
    'Mit freundlichen Grüßen\nMiet-Royal Mainz';
  return { subject: noticeSubject(input.processNumber), bodyText };
}
