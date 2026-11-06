/**
 * Phase 16 (WEB, Order §11–§17, Design §3/§5/§11.2.7/§11.2.8): Logik des Slush-Konfigurators.
 *
 * - Der Browser rechnet nie Geld: alle Beträge, Kontingente, Empfehlungen und Hinweise kommen
 *   aus `POST /api/public/configurator/preview`; hier wird nur die Auswahl gesammelt.
 * - Eingabeprüfung hier ist UX (CLAUDE.md) – die API prüft jede Anfrage erneut.
 * - Idempotenz (Order §15): `clientMutationId` (UUID) wird beim ersten Sendeversuch erzeugt,
 *   in `sessionStorage` gehalten (nur die ID, keine Kontaktdaten) und erst nach Erfolg gelöscht.
 *   „Erneut senden“ schickt den IDENTISCHEN Payload mit derselben ID.
 *
 * Reine Funktionen ohne React-/Browser-Abhängigkeit (node --test).
 */
import type {
  ConfiguratorPreviewRequest,
  InquiryContact,
  InquiryFulfillment,
  PublicConfiguratorPreview,
  PublicInquiryRequest,
} from './site-types.ts';

export const PREVIEW_URL = '/api/public/configurator/preview';
export const INQUIRY_URL = '/api/public/inquiries';
/** Nur die Idempotenz-ID – nie Kontakt- oder Eventdaten. */
export const MUTATION_ID_STORAGE_KEY = 'mr-konfigurator-anfrage-id';
/** Entprellung der laufenden Übersicht. */
export const PREVIEW_DEBOUNCE_MS = 350;

export const CONFIGURATOR_STEPS = [
  { id: 'event', title: 'Event' },
  { id: 'machine', title: 'Maschine' },
  { id: 'syrup', title: 'Sirup & Zubehör' },
  { id: 'fulfillment', title: 'Abholung oder Lieferung' },
  { id: 'contact', title: 'Kontakt' },
  { id: 'summary', title: 'Zusammenfassung' },
] as const;
export type ConfiguratorStepId = (typeof CONFIGURATOR_STEPS)[number]['id'];

export const CONFIGURATOR_TEXT = {
  RECOMMENDATION_FALLBACK:
    'Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.',
  DELIVERY_NOTE: 'Lieferung wird individuell geprüft.',
  DELIVERY_WINDOW_HINT: 'Zeitfenster am Veranstaltungstag (optional)',
  PICKUP_ADDRESS_NOTE: 'Die genaue Abholadresse teilen wir dir rechtzeitig mit.',
  UNASSIGNED_SYRUP: 'Sorte später abstimmen',
  PRIVACY_LABEL: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
  SUBMIT: 'Unverbindliches Angebot anfordern',
  SUBMITTING: 'Wird gesendet …',
  RETRY: 'Erneut senden',
  PRIVACY_UNAVAILABLE:
    'Anfragen sind gerade nicht möglich. Bitte versuche es später erneut oder kontaktiere uns direkt.',
  ORIGIN_MISMATCH:
    'Anfragen sind auf dieser Website gerade nicht möglich. Bitte versuche es später erneut oder kontaktiere uns direkt.',
  UNCERTAIN:
    'Wir konnten nicht sicher feststellen, ob deine Anfrage angekommen ist. Sende sie bitte erneut – sie wird dabei nicht doppelt angelegt.',
  RATE_LIMITED:
    'Gerade kommen zu viele Anfragen von deinem Anschluss. Bitte warte ein paar Minuten und sende dann erneut.',
  DEMO_RESET:
    'Die Demo-Umgebung wird gerade zurückgesetzt. Bitte versuche es in einer Minute erneut.',
  INVALID: 'Bitte prüfe deine Angaben – einige Felder sind noch nicht vollständig oder korrekt.',
  REJECTED:
    'Deine Anfrage konnte gerade nicht gesendet werden. Bitte lade die Seite neu und versuche es erneut.',
  ALREADY_RECEIVED: 'Deine Anfrage ist bereits bei uns eingegangen.',
  PREVIEW_UNAVAILABLE:
    'Die Übersicht ist gerade nicht verfügbar. Du kannst trotzdem weitermachen – wir prüfen alles persönlich.',
  PREVIEW_RATE_LIMITED: 'Die Übersicht wird gleich wieder aktualisiert.',
  /** Wortgleich mit der API (400 auf `body.fulfillment.windowTo`). */
  DELIVERY_WINDOW_ORDER: 'Das Ende des Wunsch-Lieferzeitfensters muss nach dem Beginn liegen.',
  /** Hinweis bis zur Hydration (Felder bis dahin gesperrt, keine Eingabe geht verloren). */
  HYDRATING: 'Konfigurator wird geladen …',
} as const;

// ── Zustand ──────────────────────────────────────────────────────────────────

export type ContactType = 'private' | 'organization';
export type FulfillmentType = 'pickup' | 'delivery';

export interface ConfiguratorState {
  event: { date: string; startTime: string; endTime: string; guests: string; occasion: string };
  machineSlug: string;
  /** Gratis-Sirup je Sorte (Liter). */
  freeSyrups: Record<string, number>;
  /** Zusätzlicher Sirup auf Kommission je Sorte (Liter). */
  extraSyrups: Record<string, number>;
  cups25: number;
  straws25: number;
  canisters: number;
  fulfillment: FulfillmentType;
  delivery: {
    street: string;
    postalCode: string;
    city: string;
    windowFrom: string;
    windowTo: string;
  };
  contact: {
    type: ContactType;
    firstName: string;
    lastName: string;
    organizationName: string;
    contactPerson: string;
    email: string;
    phone: string;
  };
  privacyAcknowledged: boolean;
}

export function createInitialState(machineSlug = ''): ConfiguratorState {
  return {
    event: { date: '', startTime: '', endTime: '', guests: '', occasion: '' },
    machineSlug,
    freeSyrups: {},
    extraSyrups: {},
    cups25: 0,
    straws25: 0,
    // Order §11: Kanister empfehlen, aber NICHT vorauswählen.
    canisters: 0,
    fulfillment: 'pickup',
    delivery: { street: '', postalCode: '', city: '', windowFrom: '', windowTo: '' },
    contact: {
      type: 'private',
      firstName: '',
      lastName: '',
      organizationName: '',
      contactPerson: '',
      email: '',
      phone: '',
    },
    privacyAcknowledged: false,
  };
}

export function stepIndex(step: ConfiguratorStepId): number {
  return CONFIGURATOR_STEPS.findIndex((candidate) => candidate.id === step);
}

export function nextStep(step: ConfiguratorStepId): ConfiguratorStepId {
  const index = stepIndex(step);
  return CONFIGURATOR_STEPS[Math.min(index + 1, CONFIGURATOR_STEPS.length - 1)]!.id;
}

export function previousStep(step: ConfiguratorStepId): ConfiguratorStepId {
  const index = stepIndex(step);
  return CONFIGURATOR_STEPS[Math.max(index - 1, 0)]!.id;
}

// ── Kleine Prüfer (UX, nicht Sicherheit) ─────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()/-]{3,38}$/;
const POSTAL_CODE_PATTERN = /^[0-9]{5}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_GUESTS = 100_000;

/** Ganze Zahl aus einem Eingabefeld (nur Ziffern) oder null. */
export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[0-9]{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isValidTimeOfDay(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** Heutiges Datum in Europe/Berlin als `YYYY-MM-DD` (Mindestdatum des Events). */
export function berlinToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Ende ≤ Beginn ⇒ Ende am Folgetag (Design §11.2.7) – nur ein Hinweis, kein Fehler. */
export function endsNextDay(event: { startTime: string; endTime: string }): boolean {
  return (
    isValidTimeOfDay(event.startTime) &&
    isValidTimeOfDay(event.endTime) &&
    event.endTime <= event.startTime
  );
}

/**
 * Wunsch-Lieferzeitfenster gilt am Veranstaltungstag (Design §11.2.7) – anders als die
 * Eventzeit gibt es KEIN „Ende am Folgetag“: Ende ≤ Beginn ist ein Fehler (API: 400 auf
 * `body.fulfillment.windowTo`). Nur, wenn beide Zeiten gesetzt und gültig sind.
 */
export function deliveryWindowReversed(window: { windowFrom: string; windowTo: string }): boolean {
  return (
    isValidTimeOfDay(window.windowFrom) &&
    isValidTimeOfDay(window.windowTo) &&
    window.windowTo <= window.windowFrom
  );
}

/** Großevent-Hinweis (Schwelle kommt aus dem Katalog der API); nie ein Fehler. */
export function isLargeEvent(guests: string, threshold: number): boolean {
  const parsed = parseWholeNumber(guests);
  return parsed !== null && Number.isFinite(threshold) && parsed >= threshold;
}

/** Summe verteilter Liter (Mengenanzeige, kein Geld). */
export function totalLiters(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce(
    (sum, liters) => sum + (Number.isInteger(liters) && liters > 0 ? liters : 0),
    0,
  );
}

// ── Schrittprüfung ───────────────────────────────────────────────────────────

export type ConfiguratorField =
  | 'date'
  | 'startTime'
  | 'endTime'
  | 'guests'
  | 'occasion'
  | 'machineSlug'
  | 'freeSyrups'
  | 'canisters'
  | 'street'
  | 'postalCode'
  | 'city'
  | 'windowFrom'
  | 'windowTo'
  | 'firstName'
  | 'lastName'
  | 'organizationName'
  | 'contactPerson'
  | 'email'
  | 'phone'
  | 'privacy';

export type FieldErrors = Partial<Record<ConfiguratorField, string>>;

export interface ValidationContext {
  /** Mindestdatum (heute, Europe/Berlin). */
  today: string;
  machineSlugs: ReadonlySet<string>;
  occasions: ReadonlySet<string>;
  /** Kontingente aus der letzten Übersicht der API (oder null, solange keine vorliegt). */
  quota: PublicConfiguratorPreview['quota'] | null;
}

function required(value: string, max: number): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= max;
}

export function validateStep(
  step: ConfiguratorStepId,
  state: ConfiguratorState,
  ctx: ValidationContext,
): FieldErrors {
  const errors: FieldErrors = {};
  switch (step) {
    case 'event': {
      const { date, startTime, endTime, guests, occasion } = state.event;
      if (date === '') errors.date = 'Bitte wähle das Datum deines Events.';
      else if (!isValidCalendarDate(date)) errors.date = 'Bitte gib ein gültiges Datum an.';
      else if (date < ctx.today) errors.date = 'Das Datum darf nicht in der Vergangenheit liegen.';
      if (startTime !== '' && !isValidTimeOfDay(startTime)) {
        errors.startTime = 'Bitte gib die Uhrzeit im Format HH:MM an.';
      }
      if (endTime !== '' && !isValidTimeOfDay(endTime)) {
        errors.endTime = 'Bitte gib die Uhrzeit im Format HH:MM an.';
      }
      const parsed = parseWholeNumber(guests);
      if (parsed === null || parsed < 1) {
        errors.guests = 'Bitte gib die ungefähre Gästezahl an (mindestens 1).';
      } else if (parsed > MAX_GUESTS) {
        errors.guests = 'Bitte gib eine Gästezahl bis 100.000 an.';
      }
      if (!ctx.occasions.has(occasion)) errors.occasion = 'Bitte wähle einen Anlass.';
      break;
    }
    case 'machine':
      if (!ctx.machineSlugs.has(state.machineSlug)) {
        errors.machineSlug = 'Bitte wähle eine Maschine.';
      }
      break;
    case 'syrup':
      if (ctx.quota !== null && totalLiters(state.freeSyrups) > ctx.quota.freeSyrupLiters) {
        errors.freeSyrups = `Du kannst höchstens ${ctx.quota.freeSyrupLiters} L Gratis-Sirup verteilen.`;
      }
      if (ctx.quota !== null && state.canisters > ctx.quota.canisterMax) {
        errors.canisters = `Für diese Maschine sind höchstens ${ctx.quota.canisterMax} Mischkanister möglich.`;
      }
      break;
    case 'fulfillment':
      if (state.fulfillment === 'delivery') {
        const { street, postalCode, city, windowFrom, windowTo } = state.delivery;
        if (!required(street, 120)) errors.street = 'Bitte gib Straße und Hausnummer an.';
        if (!POSTAL_CODE_PATTERN.test(postalCode.trim())) {
          errors.postalCode = 'Bitte gib eine fünfstellige Postleitzahl an.';
        }
        if (!required(city, 80)) errors.city = 'Bitte gib den Ort an.';
        if (windowFrom !== '' && !isValidTimeOfDay(windowFrom)) {
          errors.windowFrom = 'Bitte gib die Uhrzeit im Format HH:MM an.';
        }
        if (windowTo !== '' && !isValidTimeOfDay(windowTo)) {
          errors.windowTo = 'Bitte gib die Uhrzeit im Format HH:MM an.';
        } else if (deliveryWindowReversed(state.delivery)) {
          errors.windowTo = CONFIGURATOR_TEXT.DELIVERY_WINDOW_ORDER;
        }
      }
      break;
    case 'contact': {
      const contact = state.contact;
      if (contact.type === 'private') {
        if (!required(contact.firstName, 80)) errors.firstName = 'Bitte gib deinen Vornamen an.';
        if (!required(contact.lastName, 80)) errors.lastName = 'Bitte gib deinen Nachnamen an.';
      } else {
        if (!required(contact.organizationName, 160)) {
          errors.organizationName =
            'Bitte gib den Namen der Organisation, Firma oder des Vereins an.';
        }
        if (!required(contact.contactPerson, 120)) {
          errors.contactPerson = 'Bitte gib eine Ansprechperson an.';
        }
      }
      const email = contact.email.trim();
      if (email === '' || email.length > 200 || !EMAIL_PATTERN.test(email)) {
        errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
      }
      const phone = contact.phone.trim();
      if (phone !== '' && (phone.length > 40 || !PHONE_PATTERN.test(phone))) {
        errors.phone = 'Bitte gib eine gültige Telefonnummer an oder lass das Feld leer.';
      }
      break;
    }
    case 'summary':
      if (!state.privacyAcknowledged) {
        errors.privacy =
          'Bitte bestätige, dass du die Datenschutzhinweise zur Kenntnis genommen hast.';
      }
      break;
  }
  return errors;
}

/** Erster Schritt mit Fehlern (für „Absenden“ aus der Zusammenfassung) oder null. */
export function firstInvalidStep(
  state: ConfiguratorState,
  ctx: ValidationContext,
): ConfiguratorStepId | null {
  for (const step of CONFIGURATOR_STEPS) {
    if (Object.keys(validateStep(step.id, state, ctx)).length > 0) return step.id;
  }
  return null;
}

// ── Anfragen an die API ──────────────────────────────────────────────────────

/** Liter je Sorte ⇒ API-Liste (nur > 0, nach Slug sortiert ⇒ deterministischer Payload). */
export function syrupEntries(
  record: Readonly<Record<string, number>>,
): Array<{ slug: string; liters: number }> {
  return Object.entries(record)
    .filter(([, liters]) => Number.isInteger(liters) && liters > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slug, liters]) => ({ slug, liters }));
}

/** Body der laufenden Übersicht – nur gültige Teile (die Übersicht ist nie Autorität). */
export function buildPreviewRequest(state: ConfiguratorState): ConfiguratorPreviewRequest {
  const request: ConfiguratorPreviewRequest = {
    syrups: { free: syrupEntries(state.freeSyrups), extra: syrupEntries(state.extraSyrups) },
    extras: { cups25: state.cups25, straws25: state.straws25 },
    canisters: state.canisters,
    fulfillment: state.fulfillment,
  };
  const guests = parseWholeNumber(state.event.guests);
  if (guests !== null && guests >= 1 && guests <= MAX_GUESTS) request.guests = guests;
  if (state.machineSlug !== '') request.machineSlug = state.machineSlug;
  return request;
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Vollständiger Anfrage-Body (`POST /public/inquiries`, strict – nur bekannte Felder). */
export function buildInquiryPayload(
  state: ConfiguratorState,
  clientMutationId: string,
): PublicInquiryRequest {
  const startTime = optionalTrimmed(state.event.startTime);
  const endTime = optionalTrimmed(state.event.endTime);
  const event: PublicInquiryRequest['event'] = {
    date: state.event.date.trim(),
    ...(startTime === undefined ? {} : { startTime }),
    ...(endTime === undefined ? {} : { endTime }),
    guests: parseWholeNumber(state.event.guests) ?? 0,
    occasion: state.event.occasion,
  };
  let fulfillment: InquiryFulfillment;
  if (state.fulfillment === 'delivery') {
    const windowFrom = optionalTrimmed(state.delivery.windowFrom);
    const windowTo = optionalTrimmed(state.delivery.windowTo);
    fulfillment = {
      type: 'delivery',
      street: state.delivery.street.trim(),
      postalCode: state.delivery.postalCode.trim(),
      city: state.delivery.city.trim(),
      ...(windowFrom === undefined ? {} : { windowFrom }),
      ...(windowTo === undefined ? {} : { windowTo }),
    };
  } else {
    fulfillment = { type: 'pickup' };
  }
  const phone = optionalTrimmed(state.contact.phone);
  const email = state.contact.email.trim();
  const contact: InquiryContact =
    state.contact.type === 'organization'
      ? {
          type: 'organization',
          organizationName: state.contact.organizationName.trim(),
          contactPerson: state.contact.contactPerson.trim(),
          email,
          ...(phone === undefined ? {} : { phone }),
        }
      : {
          type: 'private',
          firstName: state.contact.firstName.trim(),
          lastName: state.contact.lastName.trim(),
          email,
          ...(phone === undefined ? {} : { phone }),
        };
  return {
    clientMutationId,
    event,
    machineSlug: state.machineSlug,
    syrups: { free: syrupEntries(state.freeSyrups), extra: syrupEntries(state.extraSyrups) },
    extras: { cups25: state.cups25, straws25: state.straws25 },
    canisters: state.canisters,
    fulfillment,
    contact,
    privacyAcknowledged: true,
  };
}

/** Feldpfad einer 400-Antwort (`body.event.date`) ⇒ Schritt des Konfigurators. */
export function stepForIssuePath(path: string): ConfiguratorStepId {
  const parts = path.split('.');
  const key = parts[0] === 'body' ? parts[1] : parts[0];
  switch (key) {
    case 'event':
      return 'event';
    case 'machineSlug':
      return 'machine';
    case 'syrups':
    case 'extras':
    case 'canisters':
      return 'syrup';
    case 'fulfillment':
      return 'fulfillment';
    case 'contact':
      return 'contact';
    default:
      return 'summary';
  }
}

const ISSUE_FIELDS: Readonly<Record<string, Readonly<Record<string, ConfiguratorField>>>> = {
  event: {
    date: 'date',
    startTime: 'startTime',
    endTime: 'endTime',
    guests: 'guests',
    occasion: 'occasion',
  },
  fulfillment: {
    street: 'street',
    postalCode: 'postalCode',
    city: 'city',
    windowFrom: 'windowFrom',
    windowTo: 'windowTo',
  },
  contact: {
    firstName: 'firstName',
    lastName: 'lastName',
    organizationName: 'organizationName',
    contactPerson: 'contactPerson',
    email: 'email',
    phone: 'phone',
  },
};

/**
 * Feldpfad einer 400-Antwort ⇒ Eingabefeld des Konfigurators (oder null, wenn es kein
 * einzelnes Feld gibt). Beispiel: `body.fulfillment.windowTo` ⇒ `windowTo`,
 * `body.event.startTime` ⇒ `startTime` (z. B. „Diese Uhrzeit gibt es am gewählten Tag wegen
 * der Zeitumstellung nicht.“).
 */
export function fieldForIssuePath(path: string): ConfiguratorField | null {
  const parts = path.split('.');
  const [group, key] = parts[0] === 'body' ? [parts[1], parts[2]] : [parts[0], parts[1]];
  switch (group) {
    case 'machineSlug':
      return 'machineSlug';
    case 'syrups':
      return parts.includes('free') ? 'freeSyrups' : null;
    case 'canisters':
      return 'canisters';
    case 'privacyAcknowledged':
      return 'privacy';
    case 'event':
    case 'fulfillment':
    case 'contact':
      return key === undefined ? null : (ISSUE_FIELDS[group]?.[key] ?? null);
    default:
      return null;
  }
}

export interface InquiryIssue {
  path: string;
  message: string;
  step: ConfiguratorStepId;
  field: ConfiguratorField | null;
}

/**
 * 400-Fehler aufteilen: Schritt des ersten Fehlers, Feldfehler dieses Schritts (am Feld
 * angezeigt, `aria-invalid`) und die übrigen Meldungen (gesammelt im Fehlerkasten) – jede
 * Meldung erscheint genau einmal.
 */
export function splitInquiryIssues(issues: readonly InquiryIssue[]): {
  step: ConfiguratorStepId | null;
  fieldErrors: FieldErrors;
  remaining: InquiryIssue[];
} {
  const first = issues[0];
  if (first === undefined) return { step: null, fieldErrors: {}, remaining: [] };
  const fieldErrors: FieldErrors = {};
  const remaining: InquiryIssue[] = [];
  for (const issue of issues) {
    if (
      issue.step === first.step &&
      issue.field !== null &&
      fieldErrors[issue.field] === undefined
    ) {
      fieldErrors[issue.field] = issue.message;
    } else {
      remaining.push(issue);
    }
  }
  return { step: first.step, fieldErrors, remaining };
}

export type InquiryOutcome =
  | { kind: 'success'; processNumber: string; receivedAt: string | null; repeated: boolean }
  | { kind: 'already_received'; processNumber: string | null }
  | { kind: 'privacy_unavailable'; message: string }
  | { kind: 'invalid'; issues: InquiryIssue[] }
  | { kind: 'rate_limited' }
  | { kind: 'demo_reset' }
  | { kind: 'rejected' }
  | { kind: 'uncertain' };

interface ErrorBody {
  code: unknown;
  message: unknown;
  processNumber: unknown;
  issues: unknown;
}

function errorOf(body: unknown): Partial<ErrorBody> {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as { error?: unknown }).error;
  return typeof error === 'object' && error !== null ? (error as Partial<ErrorBody>) : {};
}

/** Antwort von `POST /public/inquiries` ⇒ Ergebnis für die Oberfläche (rein). */
export function interpretInquiryResponse(status: number, body: unknown): InquiryOutcome {
  if (status === 200 || status === 201) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (typeof record.processNumber === 'string' && record.processNumber !== '') {
      return {
        kind: 'success',
        processNumber: record.processNumber,
        receivedAt: typeof record.receivedAt === 'string' ? record.receivedAt : null,
        repeated: status === 200,
      };
    }
    return { kind: 'uncertain' };
  }
  const error = errorOf(body);
  if (status === 409 && error.code === 'PUBLIC_INQUIRY_CONFLICT') {
    return {
      kind: 'already_received',
      processNumber: typeof error.processNumber === 'string' ? error.processNumber : null,
    };
  }
  if (status === 409 && error.code === 'PRIVACY_NOT_PUBLISHED') {
    const message =
      typeof error.message === 'string' && error.message.trim() !== ''
        ? error.message
        : CONFIGURATOR_TEXT.PRIVACY_UNAVAILABLE;
    return { kind: 'privacy_unavailable', message };
  }
  if (status === 400) {
    const raw = Array.isArray(error.issues) ? error.issues : [];
    const issues = raw
      .filter(
        (issue): issue is { path: string; message: string } =>
          typeof issue === 'object' &&
          issue !== null &&
          typeof (issue as { path?: unknown }).path === 'string' &&
          typeof (issue as { message?: unknown }).message === 'string',
      )
      .map((issue) => ({
        path: issue.path,
        message: issue.message,
        step: stepForIssuePath(issue.path),
        field: fieldForIssuePath(issue.path),
      }));
    return { kind: 'invalid', issues };
  }
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 503 && error.code === 'DEMO_RESET') return { kind: 'demo_reset' };
  if (status === 403 || status === 409 || status === 413 || status === 415) {
    return { kind: 'rejected' };
  }
  // 5xx, Gateway-Fehler, unbekannte Antworten: Ausgang unklar ⇒ identisch erneut senden.
  return { kind: 'uncertain' };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function jsonInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Sendet die Anfrage; Netzfehler/Timeout ⇒ `uncertain` (nie eine Ausnahme). */
export async function submitInquiry(
  payload: PublicInquiryRequest,
  fetchImpl: FetchLike = defaultFetch,
): Promise<InquiryOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(INQUIRY_URL, jsonInit(payload));
  } catch {
    return { kind: 'uncertain' };
  }
  const body: unknown = await response.json().catch(() => null);
  return interpretInquiryResponse(response.status, body);
}

/** Ergebnisse, nach denen das Formular gesperrt bleibt und „Erneut senden“ angeboten wird. */
export function isRetryableOutcome(outcome: InquiryOutcome): boolean {
  return (
    outcome.kind === 'uncertain' || outcome.kind === 'rate_limited' || outcome.kind === 'demo_reset'
  );
}

export function inquiryOutcomeMessage(outcome: InquiryOutcome): string | null {
  switch (outcome.kind) {
    case 'success':
      return null;
    case 'already_received':
      return CONFIGURATOR_TEXT.ALREADY_RECEIVED;
    case 'privacy_unavailable':
      return outcome.message;
    case 'invalid':
      return CONFIGURATOR_TEXT.INVALID;
    case 'rate_limited':
      return CONFIGURATOR_TEXT.RATE_LIMITED;
    case 'demo_reset':
      return CONFIGURATOR_TEXT.DEMO_RESET;
    case 'rejected':
      return CONFIGURATOR_TEXT.REJECTED;
    case 'uncertain':
      return CONFIGURATOR_TEXT.UNCERTAIN;
  }
}

export type PreviewOutcome =
  | { kind: 'ok'; preview: PublicConfiguratorPreview }
  | { kind: 'rate_limited' }
  | { kind: 'unavailable' }
  | { kind: 'aborted' };

export function isConfiguratorPreview(value: unknown): value is PublicConfiguratorPreview {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.recommendation === 'object' &&
    record.recommendation !== null &&
    typeof record.quota === 'object' &&
    record.quota !== null &&
    Array.isArray(record.fixed) &&
    typeof record.fixedTotalCents === 'number' &&
    Array.isArray(record.included) &&
    Array.isArray(record.commission) &&
    typeof record.delivery === 'object' &&
    record.delivery !== null &&
    Array.isArray(record.issues) &&
    typeof record.priceNote === 'string'
  );
}

/** Laufende Übersicht (serverseitig berechnet). */
export async function fetchConfiguratorPreview(
  request: ConfiguratorPreviewRequest,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<PreviewOutcome> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  let response: Response;
  try {
    response = await fetchImpl(PREVIEW_URL, jsonInit(request, options.signal));
  } catch {
    return options.signal?.aborted === true ? { kind: 'aborted' } : { kind: 'unavailable' };
  }
  if (response.status === 429) return { kind: 'rate_limited' };
  if (!response.ok) return { kind: 'unavailable' };
  const body: unknown = await response.json().catch(() => null);
  return isConfiguratorPreview(body) ? { kind: 'ok', preview: body } : { kind: 'unavailable' };
}

// ── clientMutationId (Order §15, Design §5) ─────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Gespeicherte ID eines noch nicht bestätigten Sendeversuchs (oder null). */
export function readStoredMutationId(storage: StorageLike | null): string | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(MUTATION_ID_STORAGE_KEY);
    return value !== null && isUuid(value) ? value : null;
  } catch {
    return null;
  }
}

/** Vorhandene ID wiederverwenden, sonst neu erzeugen und (wenn möglich) speichern. */
export function ensureMutationId(storage: StorageLike | null, create: () => string): string {
  const existing = readStoredMutationId(storage);
  if (existing !== null) return existing;
  const id = create();
  try {
    storage?.setItem(MUTATION_ID_STORAGE_KEY, id);
  } catch {
    // Speicher gesperrt (privater Modus): die ID lebt dann nur im Formular-Zustand.
  }
  return id;
}

/** Nach Erfolg (oder „bereits eingegangen“): ID verwerfen – die nächste Anfrage bekommt eine neue. */
export function clearStoredMutationId(storage: StorageLike | null): void {
  try {
    storage?.removeItem(MUTATION_ID_STORAGE_KEY);
  } catch {
    // ohne Speicher nichts zu tun
  }
}

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** UUID v4 – `crypto.randomUUID()`, sonst aus `getRandomValues` (z. B. ohne sicheren Kontext). */
export function createClientMutationId(
  source: CryptoLike | undefined = globalThis.crypto as CryptoLike | undefined,
): string {
  if (typeof source?.randomUUID === 'function') {
    const id = source.randomUUID();
    if (isUuid(id)) return id.toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    // Idempotenzschlüssel, kein Geheimnis: ohne Web-Crypto genügt Math.random.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
