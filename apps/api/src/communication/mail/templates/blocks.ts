/**
 * Gemeinsames Block-Modell der Mailvorlagen (Phase 12, Order §10): jede
 * Vorlage beschreibt ihren Inhalt als Liste neutraler Blöcke; daraus
 * entstehen IMMER beide Teile – text/plain und HTML – aus derselben Quelle.
 *
 * Sicherheit: Der HTML-Renderer escaped JEDEN Text (auch Linktexte und
 * URL-Attribute); Vorlagen können kein Roh-HTML einschleusen, Kundendaten
 * (Namen, Freitext) erst recht nicht. Es gibt keine Bilder, kein CSS von
 * außen, keine Tracking-Elemente – nur Links auf die eigene öffentliche
 * Web-App.
 */

export type MailBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; items: readonly string[] }
  | { type: 'link'; label: string; url: string }
  | { type: 'rows'; rows: readonly { label: string; value: string }[] }
  | { type: 'code'; text: string };

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Nur http(s)-URLs werden verlinkt; alles andere erscheint als Text. */
export function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s<>"']+$/.test(url);
}

const CURRENCY = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

/** Integer-Cent → „1.234,56 €“ (nie Fließkomma-Rechnung). */
export function formatEuroCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new TypeError('Betrag muss Integer-Cent sein.');
  return CURRENCY.format(cents / 100);
}

const BERLIN = 'Europe/Berlin';
const DATE_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  hour: '2-digit',
  minute: '2-digit',
});

function parseDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Ungültiges Datum in der Mailvorlage.');
  return date;
}

/** ISO-Datum (JJJJ-MM-TT) oder Zeitstempel → „18.10.2026“. */
export function formatDate(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  return DATE_FORMAT.format(parseDate(value));
}

/** Zeitstempel → „Samstag, 18.10.2026, 10:00 Uhr“ (Europe/Berlin). */
export function formatDateTime(value: string | Date): string {
  return `${DATE_TIME_FORMAT.format(parseDate(value))} Uhr`;
}

/** Zeitstempel → „10:00 Uhr“ (Europe/Berlin). */
export function formatTime(value: string | Date): string {
  return `${TIME_FORMAT.format(parseDate(value))} Uhr`;
}

export function renderBlocksText(blocks: readonly MailBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        parts.push(block.text);
        break;
      case 'heading':
        parts.push(block.text.toUpperCase());
        break;
      case 'list':
        parts.push(block.items.map((item) => `- ${item}`).join('\n'));
        break;
      case 'link':
        parts.push(`${block.label}:\n${block.url}`);
        break;
      case 'rows':
        parts.push(block.rows.map((row) => `${row.label}: ${row.value}`).join('\n'));
        break;
      case 'code':
        parts.push(block.text);
        break;
    }
  }
  return `${parts.join('\n\n')}\n`;
}

function renderBlockHtml(block: MailBlock): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`;
    case 'heading':
      return `<h2>${escapeHtml(block.text)}</h2>`;
    case 'list':
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    case 'link': {
      if (!isSafeHttpUrl(block.url)) {
        return `<p>${escapeHtml(block.label)}: ${escapeHtml(block.url)}</p>`;
      }
      const href = escapeHtml(block.url);
      return `<p>${escapeHtml(block.label)}:<br><a href="${href}">${href}</a></p>`;
    }
    case 'rows':
      return `<table role="presentation" cellpadding="0" cellspacing="0">${block.rows
        .map(
          (row) =>
            `<tr><td style="padding:2px 12px 2px 0">${escapeHtml(row.label)}</td><td style="padding:2px 0">${escapeHtml(row.value)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'code':
      return `<p><strong style="font-family:monospace;font-size:1.2em;letter-spacing:1px">${escapeHtml(block.text)}</strong></p>`;
  }
}

/** Komplettes, eigenständiges HTML-Dokument ohne externe Ressourcen. */
export function renderBlocksHtml(title: string, blocks: readonly MailBlock[]): string {
  const body = blocks.map(renderBlockHtml).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    '<body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;background:#ffffff">',
    '<div style="max-width:640px">',
    body,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
