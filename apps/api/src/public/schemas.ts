import { inquiryOccasion } from '@mietroyal/database';
import { z } from '@mietroyal/validation';
import { UUID_PATTERN } from '../routes/auth.ts';

/**
 * Phase 16 (PUBLIC, Design §3.2/§3.3): strikte Eingabeschemas des öffentlichen
 * Konfigurators. Unbekannte Felder ⇒ 400 (`strictObject`); Fehler tragen nur
 * Feldpfade und Meldungen, nie Eingabewerte (parseOrThrow).
 */

const productSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Ungültige Produktangabe.');

/** Uhrzeit „HH:MM“ (24 h). */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Bitte eine Uhrzeit im Format HH:MM angeben.');

const syrupEntry = (maxLiters: number) =>
  z.strictObject({
    slug: productSlugSchema,
    liters: z.number().int().min(0).max(maxLiters),
  });

const syrupsSchema = z.strictObject({
  free: z.array(syrupEntry(20)).max(20),
  extra: z.array(syrupEntry(50)).max(20),
});

const extrasSchema = z.strictObject({
  cups25: z.number().int().min(0).max(50),
  straws25: z.number().int().min(0).max(50),
});

const canistersSchema = z.number().int().min(0).max(20);
const guestsSchema = z.number().int().min(1).max(100_000);

/** `POST /public/configurator/preview` – alles optional (laufende Übersicht). */
export const configuratorPreviewSchema = z.strictObject({
  guests: guestsSchema.optional(),
  machineSlug: productSlugSchema.optional(),
  syrups: syrupsSchema.optional(),
  extras: extrasSchema.optional(),
  canisters: canistersSchema.optional(),
  fulfillment: z.enum(['pickup', 'delivery']).optional(),
});
export type ConfiguratorPreviewBody = z.infer<typeof configuratorPreviewSchema>;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Telefon optional; leer ⇒ nicht angegeben. Bewusst tolerant (keine unnötigen Pflichtfelder). */
const optionalPhoneSchema = z
  .string()
  .trim()
  .max(40)
  .refine(
    (value) => value === '' || /^\+?[0-9][0-9 ()/-]{3,38}$/.test(value),
    'Bitte eine gültige Telefonnummer angeben.',
  )
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const emailSchema = z
  .string()
  .trim()
  .max(200)
  .pipe(z.email('Bitte eine gültige E-Mail-Adresse angeben.'));

const contactSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('private'),
    firstName: trimmed(1, 80),
    lastName: trimmed(1, 80),
    email: emailSchema,
    phone: optionalPhoneSchema,
  }),
  z.strictObject({
    type: z.literal('organization'),
    organizationName: trimmed(1, 160),
    contactPerson: trimmed(1, 120),
    email: emailSchema,
    phone: optionalPhoneSchema,
  }),
]);

const fulfillmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pickup') }),
  z.strictObject({
    type: z.literal('delivery'),
    street: trimmed(1, 120),
    postalCode: z.string().regex(/^[0-9]{5}$/, 'Bitte eine fünfstellige Postleitzahl angeben.'),
    city: trimmed(1, 80),
    windowFrom: timeOfDaySchema.optional(),
    windowTo: timeOfDaySchema.optional(),
  }),
]);

/** `POST /public/inquiries` – vollständige, serverseitig erneut geprüfte Anfrage. */
export const publicInquirySchema = z.strictObject({
  clientMutationId: z
    .string()
    .regex(UUID_PATTERN, 'muss eine UUID sein')
    .transform((value) => value.toLowerCase()),
  event: z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT angeben.'),
    startTime: timeOfDaySchema.optional(),
    endTime: timeOfDaySchema.optional(),
    guests: guestsSchema,
    occasion: z.enum(inquiryOccasion.enumValues),
  }),
  machineSlug: productSlugSchema,
  syrups: syrupsSchema,
  extras: extrasSchema,
  canisters: canistersSchema,
  fulfillment: fulfillmentSchema,
  contact: contactSchema,
  privacyAcknowledged: z.literal(true, 'Bitte bestätige die Datenschutzhinweise.'),
});
export type PublicInquiryBody = z.infer<typeof publicInquirySchema>;
