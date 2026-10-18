/**
 * Kontext-Verträge der Mailvorlagen (Phase 12, Order §10). Fachmodule füllen
 * genau diese Felder (nie Geheimnisse – die stehen in `secrets` und werden
 * verschlüsselt in der Outbox abgelegt). Jede Vorlage validiert ihren
 * Kontext per zod beim Einreihen UND beim Rendern.
 *
 * Konventionen:
 * - Zeitpunkte als ISO-8601-String (UTC); Kalenderdaten als `JJJJ-MM-TT`.
 * - Beträge als Integer-Cent.
 * - `salutation` ist die fertige Anrede („Hallo Max Mustermann,“) – Default „Hallo,“.
 */
import { z } from '@mietroyal/validation';
import type { MailDeliveryKind } from '../../types.ts';

const isoDateTime = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'muss ein gültiger Zeitstempel sein');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'muss JJJJ-MM-TT sein');
const salutation = z.string().max(200).default('Hallo,');
const processNumber = z.string().min(1).max(40);
const appointmentKind = z.enum(['pickup', 'delivery']);
const cents = z.number().int().min(0).max(100_000_000);

export const offerContextSchema = z.object({
  salutation,
  processNumber,
  eventDate: isoDate.nullable().default(null),
  validUntil: isoDateTime,
});
export const offerSecretsSchema = z.object({ offerToken: z.string().min(8).max(512) });

export const orderConfirmationContextSchema = z.object({
  salutation,
  processNumber,
  eventDate: isoDate.nullable().default(null),
});

export const handoverProtocolContextSchema = z.object({
  salutation,
  processNumber,
  handoverAt: isoDateTime.nullable().default(null),
});

export const returnProtocolContextSchema = z.object({
  salutation,
  processNumber,
  returnAt: isoDateTime.nullable().default(null),
});

export const settlementNoticeContextSchema = z.object({
  salutation,
  processNumber,
  positions: z.array(z.object({ label: z.string().min(1).max(300), amountCents: cents })).min(1),
  totalCents: cents,
});
export const settlementNoticeSecretsSchema = z.object({
  documentToken: z.string().min(8).max(512),
});

export const cancellationConfirmationContextSchema = z.object({
  salutation,
  processNumber,
  eventDate: isoDate.nullable().default(null),
  /** Stornokosten (0 ⇒ ohne Rechnung); > 0 ⇒ Rechnung folgt getrennt (Order §14). */
  chargeCents: cents.default(0),
});

export const reminderContextSchema = z.object({
  salutation,
  processNumber,
  eventDate: isoDate.nullable().default(null),
  appointmentKind,
  appointmentAt: isoDateTime,
  /** Ende des Zeitfensters (Lieferung) oder null. */
  windowEnd: isoDateTime.nullable().default(null),
  /** Bestätigte Abholadresse (pickup) bzw. Lieferadresse (delivery), mehrzeilig erlaubt. */
  address: z.string().max(500).nullable().default(null),
  returnAt: isoDateTime.nullable().default(null),
});
/** Aktions-Token optional: ohne Token entfällt nur der Link. */
export const reminderSecretsSchema = z.object({
  actionToken: z.string().min(8).max(512).optional(),
});

export const appointmentChangedContextSchema = z.object({
  salutation,
  processNumber,
  appointmentKind: z.enum(['pickup', 'delivery', 'return']),
  oldAt: isoDateTime.nullable().default(null),
  newAt: isoDateTime.nullable().default(null),
});

export const voucherDeliveryContextSchema = z.object({
  salutation,
  validUntil: isoDateTime,
});
export const voucherDeliverySecretsSchema = z.object({
  /** Kompakte Form `MR20XXXXXXXXXXXX`; die Vorlage formatiert mit Bindestrichen. */
  voucherCode: z.string().min(8).max(64),
});

export const invoiceDeliveryContextSchema = z.object({
  salutation,
  processNumber,
  invoiceNumber: z.string().min(1).max(64),
});

export const manualCustomerReplyContextSchema = z.object({
  salutation,
  processNumber,
  /** Freitext der Mitarbeitenden – wird escaped, nie als HTML interpretiert. */
  body: z.string().min(1).max(20_000),
  staffName: z.string().max(200).nullable().default(null),
});

const noSecrets = z.object({});

export const MAIL_CONTEXT_SCHEMAS = {
  offer: offerContextSchema,
  order_confirmation: orderConfirmationContextSchema,
  handover_protocol: handoverProtocolContextSchema,
  return_protocol: returnProtocolContextSchema,
  settlement_damage_missing_notice: settlementNoticeContextSchema,
  cancellation_confirmation: cancellationConfirmationContextSchema,
  reminder_7_days: reminderContextSchema,
  reminder_1_day: reminderContextSchema,
  appointment_changed: appointmentChangedContextSchema,
  voucher_delivery: voucherDeliveryContextSchema,
  invoice_delivery: invoiceDeliveryContextSchema,
  manual_customer_reply: manualCustomerReplyContextSchema,
} as const satisfies Record<MailDeliveryKind, z.ZodTypeAny>;

export const MAIL_SECRET_SCHEMAS = {
  offer: offerSecretsSchema,
  order_confirmation: noSecrets,
  handover_protocol: noSecrets,
  return_protocol: noSecrets,
  settlement_damage_missing_notice: settlementNoticeSecretsSchema,
  cancellation_confirmation: noSecrets,
  reminder_7_days: reminderSecretsSchema,
  reminder_1_day: reminderSecretsSchema,
  appointment_changed: noSecrets,
  voucher_delivery: voucherDeliverySecretsSchema,
  invoice_delivery: noSecrets,
  manual_customer_reply: noSecrets,
} as const satisfies Record<MailDeliveryKind, z.ZodTypeAny>;

/** Eingabe-Typen (vor Defaults) – das füllen die Fachmodule. */
export type OfferMailContext = z.input<typeof offerContextSchema>;
export type OfferMailSecrets = z.input<typeof offerSecretsSchema>;
export type OrderConfirmationMailContext = z.input<typeof orderConfirmationContextSchema>;
export type HandoverProtocolMailContext = z.input<typeof handoverProtocolContextSchema>;
export type ReturnProtocolMailContext = z.input<typeof returnProtocolContextSchema>;
export type SettlementNoticeMailContext = z.input<typeof settlementNoticeContextSchema>;
export type SettlementNoticeMailSecrets = z.input<typeof settlementNoticeSecretsSchema>;
export type CancellationConfirmationMailContext = z.input<
  typeof cancellationConfirmationContextSchema
>;
export type ReminderMailContext = z.input<typeof reminderContextSchema>;
export type ReminderMailSecrets = z.input<typeof reminderSecretsSchema>;
export type AppointmentChangedMailContext = z.input<typeof appointmentChangedContextSchema>;
export type VoucherDeliveryMailContext = z.input<typeof voucherDeliveryContextSchema>;
export type VoucherDeliveryMailSecrets = z.input<typeof voucherDeliverySecretsSchema>;
export type InvoiceDeliveryMailContext = z.input<typeof invoiceDeliveryContextSchema>;
export type ManualCustomerReplyMailContext = z.input<typeof manualCustomerReplyContextSchema>;

export type MailContextFor<K extends MailDeliveryKind> = z.input<(typeof MAIL_CONTEXT_SCHEMAS)[K]>;
export type MailSecretsFor<K extends MailDeliveryKind> = z.input<(typeof MAIL_SECRET_SCHEMAS)[K]>;
