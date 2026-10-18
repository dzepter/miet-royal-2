/**
 * Zentrale Mailvorlagen (Phase 12, Order §§10–18): eine Funktion
 * `renderMail` je Vorlagenart liefert Betreff, text/plain und HTML aus
 * demselben Block-Modell. Inhalte: Ansprache „du“, deutsche Begriffe wie in
 * der Staff-App, Signatur aus MAIL_SIGNATURE, in demo immer „[DEMO] “ im
 * Betreff. Keine Fristerklärungen/kein Drohtext in der Schaden-Vorinfo
 * (Order §12), keine Bilder/Tracking (Order §9).
 */
import { formatVoucherCode } from '@mietroyal/domain';
import type { z } from '@mietroyal/validation';
import { DEMO_SUBJECT_PREFIX, MAIL_SIGNATURE, type MailDeliveryKind } from '../../types.ts';
import {
  formatDate,
  formatDateTime,
  formatEuroCents,
  formatTime,
  renderBlocksHtml,
  renderBlocksText,
  type MailBlock,
} from './blocks.ts';
import { MAIL_CONTEXT_SCHEMAS, MAIL_SECRET_SCHEMAS } from './contexts.ts';

export * from './contexts.ts';
export { escapeHtml, formatEuroCents, formatDate, formatDateTime } from './blocks.ts';

/** Vorlagenversion je Art – bei inhaltlichen Änderungen erhöhen (Outbox speichert sie). */
export const MAIL_TEMPLATE_VERSIONS: Record<MailDeliveryKind, number> = {
  // v2 (Härtung RA-8): kein „PDF im Anhang“ mehr – Order §11 sieht keinen Anhang vor.
  offer: 2,
  order_confirmation: 1,
  handover_protocol: 1,
  return_protocol: 1,
  settlement_damage_missing_notice: 1,
  cancellation_confirmation: 1,
  reminder_7_days: 1,
  reminder_1_day: 1,
  appointment_changed: 1,
  voucher_delivery: 1,
  invoice_delivery: 1,
  manual_customer_reply: 1,
};

export type MailRenderErrorCode =
  'CONTEXT_INVALID' | 'SECRETS_INVALID' | 'PUBLIC_WEB_BASE_URL_MISSING' | 'HEADER_INJECTION';

/** Trägt nur den Code und Feldpfade – nie Werte (Geheimnisse!). */
export class MailRenderError extends Error {
  constructor(
    readonly code: MailRenderErrorCode,
    readonly paths: readonly string[] = [],
  ) {
    super(
      `Mailvorlage nicht renderbar (${code}${paths.length > 0 ? `: ${paths.join(', ')}` : ''}).`,
    );
    this.name = 'MailRenderError';
  }
}

export interface MailRenderOptions {
  appEnv: 'development' | 'staging' | 'demo' | 'production';
  /** Absolute Basis-URL der öffentlichen Web-App; null ⇒ Linkvorlagen scheitern mit PUBLIC_WEB_BASE_URL_MISSING. */
  publicWebBaseUrl: string | null;
  /** Default: MAIL_SIGNATURE. */
  signature?: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
  templateVersion: number;
}

/** CR/LF in Header-Feldern (Betreff, Anzeigename) ⇒ Header-Injection-Versuch. */
export function containsHeaderInjection(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

export function assertNoHeaderInjection(value: string, field: string): void {
  if (containsHeaderInjection(value)) throw new MailRenderError('HEADER_INJECTION', [field]);
}

const APPOINTMENT_LABELS = {
  pickup: 'Abholung',
  delivery: 'Lieferung',
  return: 'Rückgabe',
} as const;

/** Vorbereitungs-/Transporthinweise (Order §§17/18) – fester Text, keine Kundendaten. */
const PICKUP_TRANSPORT_HINTS: readonly string[] = [
  'Die Maschine bitte aufrecht transportieren und gegen Umkippen sichern.',
  'Transport im Kofferraum oder auf der Ladefläche – nicht auf dem Sitz oder im Fußraum.',
  'Bitte ausreichend Tragepersonen einplanen.',
];
const DELIVERY_PREPARATION_HINTS: readonly string[] = [
  'Bitte sorge dafür, dass der Aufstellort frei zugänglich ist.',
  'Eine Kontaktperson vor Ort sollte im Lieferzeitfenster erreichbar sein.',
];

interface TemplateOutput {
  subject: string;
  blocks: MailBlock[];
}

type Parsed<K extends MailDeliveryKind> = z.output<(typeof MAIL_CONTEXT_SCHEMAS)[K]>;
type ParsedSecrets<K extends MailDeliveryKind> = z.output<(typeof MAIL_SECRET_SCHEMAS)[K]>;

function publicLink(options: MailRenderOptions, path: string): string {
  if (options.publicWebBaseUrl === null) throw new MailRenderError('PUBLIC_WEB_BASE_URL_MISSING');
  return `${options.publicWebBaseUrl}${path}`;
}

function appointmentWindow(start: string, end: string | null): string {
  return end === null ? formatDateTime(start) : `${formatDateTime(start)} bis ${formatTime(end)}`;
}

function offer(
  ctx: Parsed<'offer'>,
  s: ParsedSecrets<'offer'>,
  o: MailRenderOptions,
): TemplateOutput {
  const link = publicLink(o, `/angebot/${encodeURIComponent(s.offerToken)}`);
  return {
    subject: `Dein Angebot von Miet-Royal – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `vielen Dank für deine Anfrage. Dein Angebot zum Vorgang ${ctx.processNumber}${
          ctx.eventDate === null ? '' : ` (Veranstaltung am ${formatDate(ctx.eventDate)})`
        } ist fertig.`,
      },
      { type: 'link', label: 'Angebot online ansehen und annehmen', url: link },
      {
        type: 'paragraph',
        // Härtung RA-8: kein Anhang (Order §11) – die öffentliche Angebotsseite bietet den PDF-Download.
        text: `Das Angebot ist gültig bis ${formatDateTime(ctx.validUntil)}. Über den Link kannst du das Angebot ansehen und als PDF herunterladen.`,
      },
    ],
  };
}

function orderConfirmation(ctx: Parsed<'order_confirmation'>): TemplateOutput {
  return {
    subject: `Auftragsbestätigung – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `vielen Dank für deine Buchung. Im Anhang findest du die Auftragsbestätigung zum Vorgang ${ctx.processNumber}${
          ctx.eventDate === null ? '' : ` (Veranstaltung am ${formatDate(ctx.eventDate)})`
        }.`,
      },
      {
        type: 'paragraph',
        text: 'Bitte prüfe die Angaben. Bei Fragen antworte einfach auf diese E-Mail.',
      },
    ],
  };
}

function handoverProtocol(ctx: Parsed<'handover_protocol'>): TemplateOutput {
  return {
    subject: `Übergabeprotokoll – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `die Übergabe zum Vorgang ${ctx.processNumber}${
          ctx.handoverAt === null ? '' : ` am ${formatDateTime(ctx.handoverAt)}`
        } ist abgeschlossen. Im Anhang findest du den Lieferschein und das Übergabeprotokoll.`,
      },
      { type: 'paragraph', text: 'Wir wünschen dir eine gelungene Veranstaltung.' },
    ],
  };
}

function returnProtocol(ctx: Parsed<'return_protocol'>): TemplateOutput {
  return {
    subject: `Rückgabeprotokoll – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `die Rückgabe zum Vorgang ${ctx.processNumber}${
          ctx.returnAt === null ? '' : ` am ${formatDateTime(ctx.returnAt)}`
        } ist abgeschlossen. Im Anhang findest du das Rückgabeprotokoll.`,
      },
      { type: 'paragraph', text: 'Vielen Dank, dass du bei Miet-Royal gemietet hast.' },
    ],
  };
}

function settlementNotice(
  ctx: Parsed<'settlement_damage_missing_notice'>,
  s: ParsedSecrets<'settlement_damage_missing_notice'>,
  o: MailRenderOptions,
): TemplateOutput {
  const link = publicLink(o, `/dokument/${encodeURIComponent(s.documentToken)}`);
  return {
    subject: `Information zur Rückgabe – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `bei der Rückgabe zum Vorgang ${ctx.processNumber} wurden folgende Punkte festgestellt:`,
      },
      {
        type: 'rows',
        rows: [
          ...ctx.positions.map((p) => ({ label: p.label, value: formatEuroCents(p.amountCents) })),
          { label: 'Gesamtsumme', value: formatEuroCents(ctx.totalCents) },
        ],
      },
      { type: 'link', label: 'Rückgabeprotokoll ansehen', url: link },
      {
        type: 'paragraph',
        text: 'Wenn du Fragen dazu hast, antworte einfach auf diese E-Mail – wir melden uns bei dir.',
      },
    ],
  };
}

function cancellationConfirmation(ctx: Parsed<'cancellation_confirmation'>): TemplateOutput {
  const blocks: MailBlock[] = [
    { type: 'paragraph', text: ctx.salutation },
    {
      type: 'paragraph',
      text: `hiermit bestätigen wir die Stornierung deiner Buchung zum Vorgang ${ctx.processNumber}${
        ctx.eventDate === null ? '' : ` (Veranstaltung am ${formatDate(ctx.eventDate)})`
      }.`,
    },
  ];
  if (ctx.chargeCents > 0) {
    blocks.push({
      type: 'paragraph',
      text: `Es fallen Stornokosten in Höhe von ${formatEuroCents(ctx.chargeCents)} an. Die Rechnung dazu erhältst du getrennt.`,
    });
  } else {
    blocks.push({ type: 'paragraph', text: 'Es fallen keine Kosten an.' });
  }
  blocks.push({
    type: 'paragraph',
    text: 'Wir freuen uns, wenn wir dich ein anderes Mal unterstützen dürfen.',
  });
  return { subject: `Stornobestätigung – Vorgang ${ctx.processNumber}`, blocks };
}

function reminder(
  kind: 'reminder_7_days' | 'reminder_1_day',
  ctx: Parsed<'reminder_7_days'>,
  s: ParsedSecrets<'reminder_7_days'>,
  o: MailRenderOptions,
): TemplateOutput {
  const label = APPOINTMENT_LABELS[ctx.appointmentKind];
  const lead = kind === 'reminder_7_days' ? 'In einer Woche' : 'Morgen';
  const rows: { label: string; value: string }[] = [
    { label: 'Vorgang', value: ctx.processNumber },
    ...(ctx.eventDate === null
      ? []
      : [{ label: 'Veranstaltung', value: formatDate(ctx.eventDate) }]),
    { label: label, value: appointmentWindow(ctx.appointmentAt, ctx.windowEnd) },
    ...(ctx.address === null
      ? []
      : [
          {
            label: ctx.appointmentKind === 'pickup' ? 'Abholadresse' : 'Lieferadresse',
            value: ctx.address,
          },
        ]),
    ...(ctx.returnAt === null ? [] : [{ label: 'Rückgabe', value: formatDateTime(ctx.returnAt) }]),
  ];
  const blocks: MailBlock[] = [
    { type: 'paragraph', text: ctx.salutation },
    {
      type: 'paragraph',
      text: `${lead} steht die ${label} zu deiner Buchung an. Hier die wichtigsten Angaben:`,
    },
    { type: 'rows', rows },
    {
      type: 'heading',
      text: ctx.appointmentKind === 'pickup' ? 'Hinweise zum Transport' : 'Hinweise zur Lieferung',
    },
    {
      type: 'list',
      items: ctx.appointmentKind === 'pickup' ? PICKUP_TRANSPORT_HINTS : DELIVERY_PREPARATION_HINTS,
    },
  ];
  if (s.actionToken !== undefined) {
    blocks.push({
      type: 'link',
      label: ctx.appointmentKind === 'pickup' ? 'Abholperson ändern' : 'Kontakt vor Ort ändern',
      url: publicLink(o, `/kontakt/${encodeURIComponent(s.actionToken)}`),
    });
  }
  return {
    subject: `${kind === 'reminder_7_days' ? 'Erinnerung' : 'Erinnerung für morgen'}: ${label} – Vorgang ${ctx.processNumber}`,
    blocks,
  };
}

function appointmentChanged(ctx: Parsed<'appointment_changed'>): TemplateOutput {
  const label = APPOINTMENT_LABELS[ctx.appointmentKind];
  return {
    subject: `Terminänderung: ${label} – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `der Termin für die ${label} zum Vorgang ${ctx.processNumber} hat sich geändert.`,
      },
      {
        type: 'rows',
        rows: [
          // Phase 12 (scan): ohne bekannten Vorher-Wert keine „Bisher“-Zeile (nie geraten).
          ...(ctx.oldAt === null ? [] : [{ label: 'Bisher', value: formatDateTime(ctx.oldAt) }]),
          {
            label: 'Neu',
            value: ctx.newAt === null ? 'noch nicht geplant' : formatDateTime(ctx.newAt),
          },
        ],
      },
      {
        type: 'paragraph',
        text: 'Falls der neue Termin nicht passt, antworte bitte auf diese E-Mail.',
      },
    ],
  };
}

function voucherDelivery(
  ctx: Parsed<'voucher_delivery'>,
  s: ParsedSecrets<'voucher_delivery'>,
): TemplateOutput {
  return {
    subject: 'Dein Gutschein von Miet-Royal',
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: 'vielen Dank für deine Miete bei Miet-Royal. Als Dankeschön erhältst du einen Gutschein für deine nächste Buchung:',
      },
      { type: 'code', text: formatVoucherCode(s.voucherCode) },
      {
        type: 'list',
        items: [
          '20 % Rabatt auf die Maschinenmiete deiner nächsten Buchung',
          'einmalig einlösbar und an dich als Kunde gebunden',
          'nicht mit anderen Rabatten oder Sonderpreisen kombinierbar',
          `gültig bis ${formatDate(ctx.validUntil)}`,
        ],
      },
      { type: 'paragraph', text: 'Gib den Code einfach bei deiner nächsten Anfrage an.' },
    ],
  };
}

function invoiceDelivery(ctx: Parsed<'invoice_delivery'>): TemplateOutput {
  return {
    subject: `Rechnung ${ctx.invoiceNumber} – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      {
        type: 'paragraph',
        text: `im Anhang findest du die Rechnung ${ctx.invoiceNumber} zum Vorgang ${ctx.processNumber}.`,
      },
      { type: 'paragraph', text: 'Vielen Dank für dein Vertrauen.' },
    ],
  };
}

function manualCustomerReply(ctx: Parsed<'manual_customer_reply'>): TemplateOutput {
  return {
    subject: `Nachricht von Miet-Royal – Vorgang ${ctx.processNumber}`,
    blocks: [
      { type: 'paragraph', text: ctx.salutation },
      { type: 'paragraph', text: ctx.body },
      ...(ctx.staffName === null
        ? []
        : [{ type: 'paragraph' as const, text: `– ${ctx.staffName}` }]),
    ],
  };
}

function buildTemplate(
  kind: MailDeliveryKind,
  context: unknown,
  secrets: unknown,
  options: MailRenderOptions,
): TemplateOutput {
  const ctxResult = MAIL_CONTEXT_SCHEMAS[kind].safeParse(context);
  if (!ctxResult.success) {
    throw new MailRenderError(
      'CONTEXT_INVALID',
      ctxResult.error.issues.map((i) => i.path.map(String).join('.') || '(root)'),
    );
  }
  const secretResult = MAIL_SECRET_SCHEMAS[kind].safeParse(secrets ?? {});
  if (!secretResult.success) {
    throw new MailRenderError(
      'SECRETS_INVALID',
      secretResult.error.issues.map((i) => i.path.map(String).join('.') || '(root)'),
    );
  }
  const ctx = ctxResult.data;
  const s = secretResult.data;
  switch (kind) {
    case 'offer':
      return offer(ctx as Parsed<'offer'>, s as ParsedSecrets<'offer'>, options);
    case 'order_confirmation':
      return orderConfirmation(ctx as Parsed<'order_confirmation'>);
    case 'handover_protocol':
      return handoverProtocol(ctx as Parsed<'handover_protocol'>);
    case 'return_protocol':
      return returnProtocol(ctx as Parsed<'return_protocol'>);
    case 'settlement_damage_missing_notice':
      return settlementNotice(
        ctx as Parsed<'settlement_damage_missing_notice'>,
        s as ParsedSecrets<'settlement_damage_missing_notice'>,
        options,
      );
    case 'cancellation_confirmation':
      return cancellationConfirmation(ctx as Parsed<'cancellation_confirmation'>);
    case 'reminder_7_days':
    case 'reminder_1_day':
      return reminder(
        kind,
        ctx as Parsed<'reminder_7_days'>,
        s as ParsedSecrets<'reminder_7_days'>,
        options,
      );
    case 'appointment_changed':
      return appointmentChanged(ctx as Parsed<'appointment_changed'>);
    case 'voucher_delivery':
      return voucherDelivery(
        ctx as Parsed<'voucher_delivery'>,
        s as ParsedSecrets<'voucher_delivery'>,
      );
    case 'invoice_delivery':
      return invoiceDelivery(ctx as Parsed<'invoice_delivery'>);
    case 'manual_customer_reply':
      return manualCustomerReply(ctx as Parsed<'manual_customer_reply'>);
  }
}

/** Validiert den Kontext und liefert den Betreff (ohne Geheimnisse, ohne Link) – fürs Einreihen. */
export function renderMailSubject(
  kind: MailDeliveryKind,
  context: unknown,
  options: Pick<MailRenderOptions, 'appEnv'>,
): string {
  // Betreffe brauchen keine Links/Secrets: Platzhalter-Secrets und Dummy-Basis-URL genügen.
  const placeholderSecrets = placeholderSecretsFor(kind);
  const output = buildTemplate(kind, context, placeholderSecrets, {
    appEnv: options.appEnv,
    publicWebBaseUrl: 'https://placeholder.invalid',
  });
  return decorateSubject(output.subject, options.appEnv);
}

function placeholderSecretsFor(kind: MailDeliveryKind): Record<string, string> {
  switch (kind) {
    case 'offer':
      return { offerToken: 'placeholder-token' };
    case 'settlement_damage_missing_notice':
      return { documentToken: 'placeholder-token' };
    case 'voucher_delivery':
      return { voucherCode: 'MR20AAAAAAAAAAAA' };
    default:
      return {};
  }
}

function decorateSubject(subject: string, appEnv: MailRenderOptions['appEnv']): string {
  assertNoHeaderInjection(subject, 'subject');
  return appEnv === 'demo' ? `${DEMO_SUBJECT_PREFIX}${subject}` : subject;
}

export function renderMail(
  kind: MailDeliveryKind,
  context: unknown,
  secrets: unknown,
  options: MailRenderOptions,
): RenderedMail {
  const output = buildTemplate(kind, context, secrets, options);
  const signature = options.signature ?? MAIL_SIGNATURE;
  const blocks: MailBlock[] = [...output.blocks, { type: 'paragraph', text: signature }];
  const subject = decorateSubject(output.subject, options.appEnv);
  return {
    subject,
    text: renderBlocksText(blocks),
    html: renderBlocksHtml(subject, blocks),
    templateVersion: MAIL_TEMPLATE_VERSIONS[kind],
  };
}
