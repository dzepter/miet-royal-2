/**
 * Phase 15 (Kundenportal, Design §5/§6): typisierter Client, DTO-Spiegel und
 * reine Hilfsfunktionen des Portals unter /konto.
 *
 * Grundsätze (Order §7, §9, §12, §50):
 * - Alle Aufrufe laufen same-origin über den Rewrite `/api/portal/...`
 *   (next.config.ts) mit `credentials: 'same-origin'` und `cache: 'no-store'`;
 *   die Session liegt ausschließlich im HttpOnly-Cookie der API.
 * - Der Client sendet NIE eine Kunden-ID als Autorität; Tokens (Magic Link,
 *   Reauth, E-Mail-Wechsel) existieren nur im React-State und werden per POST
 *   verbraucht – nie in Storage, Cookie, URL oder Konsole.
 * - Fehler werden hier in kundentaugliche Texte übersetzt (nie rohe Codes).
 *
 * Diese Datei ist bewusst frei von React/Browser-Abhängigkeiten auf
 * Modulebene, damit `node --test` sie ohne Next laden kann.
 */

// ── DTOs (EXAKT Design §6; Vertrag API ↔ Web) ───────────────────────────────

export type PortalEnvironment = 'development' | 'staging' | 'demo' | 'production';
export type PortalCustomerType = 'private' | 'organization';

export interface PortalMeView {
  customer: { displayName: string; type: PortalCustomerType; email: string };
  session: { expiresAt: string; reauthFresh: boolean };
  links: { newInquiryUrl: string | null; phoneNumber: string | null };
  environment: PortalEnvironment;
}

export interface PortalProfileView {
  type: PortalCustomerType;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  contactPerson: string | null;
  email: string;
  phone: string | null;
  billingStreet: string | null;
  billingPostalCode: string | null;
  billingCity: string | null;
  billingCountry: string | null;
  vatId: string | null;
  department: string | null;
  costCenter: string | null;
  orderReference: string | null;
  /** PROFILE_HINT */
  hint: string;
}

export type PortalBookingState = 'active' | 'completed_open' | 'cancelled_free' | 'cancelled_fee';
export type PortalFulfillment = 'pickup' | 'delivery';
export type PortalTravelStatus = 'none' | 'en_route';
export type PortalAppointmentKind = 'pickup' | 'return' | 'delivery';
export type PortalItemKind = 'machine' | 'syrup' | 'consumable' | 'purchase' | 'delivery';
export type PortalBillingMode = 'fixed' | 'commission' | 'included';
export type PortalInvoiceState = 'none' | 'preparing' | 'open' | 'paid' | 'overdue';
export type PortalDocumentType =
  'offer' | 'order_confirmation' | 'delivery_note' | 'handover_protocol' | 'return_protocol';

export interface PortalBookingSummary {
  bookingId: string;
  processNumber: string;
  portalState: PortalBookingState;
  stateLabel: string;
  eventDate: string | null;
  fulfillment: PortalFulfillment;
  /** descriptions kind=machine */
  machines: string[];
  travelStatus: PortalTravelStatus;
}

export interface PortalBookingItem {
  kind: PortalItemKind;
  description: string;
  quantity: number;
  unit: string | null;
  agreedUnitPriceCents: number | null;
  totalCents: number | null;
  billingMode: PortalBillingMode;
}

export interface PortalAppointment {
  kind: PortalAppointmentKind;
  label: string;
  timing: 'exact' | 'window' | 'unplanned';
  startAt: string | null;
  endAt: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
}

export interface PortalInvoiceStatus {
  status: PortalInvoiceState;
  label: string;
  finalAmountCents: number | null;
}

export interface PortalCancellationInfo {
  cancelledAt: string;
  feeCents: number;
  feePercent: number;
  invoiceFollows: boolean;
}

export interface PortalNavigationLinks {
  apple: string;
  android: string;
  web: string;
}

export interface PortalBookingView {
  bookingId: string;
  processNumber: string;
  portalState: PortalBookingState;
  stateLabel: string;
  event: {
    eventDate: string | null;
    eventStart: string | null;
    eventEnd: string | null;
    guestCount: number | null;
    occasion: string | null;
    onsiteContactName: string | null;
  };
  fulfillment: PortalFulfillment;
  pickup: { address: string | null; navigation: PortalNavigationLinks | null } | null;
  delivery: { street: string; postalCode: string; city: string } | null;
  appointments: PortalAppointment[];
  items: PortalBookingItem[];
  price: {
    agreedTotalCents: number;
    machineSubtotalCents: number;
    discountCents: number;
    voucherDiscountCents: number;
    deliveryPriceCents: number | null;
  };
  invoice: PortalInvoiceStatus;
  cancellation: PortalCancellationInfo | null;
  travelStatus: PortalTravelStatus;
  canCancelOnline: boolean;
  canMessage: boolean;
  acceptedAt: string;
}

export interface PortalDocumentView {
  id: string;
  type: PortalDocumentType;
  label: string;
  createdAt: string;
}

export interface PortalCancellationPreview {
  eventDate: string | null;
  remainingDays: number | null;
  feePercent: number | null;
  baseCents: number | null;
  feeCents: number | null;
  allowed: boolean;
  blockedMessage: string | null;
}

export interface PortalMessagePhoto {
  id: string;
  mimeType: string;
  byteSize: number;
  deleted: boolean;
}

export interface PortalMessageView {
  id: string;
  from: 'customer' | 'miet_royal';
  body: string;
  bodyDeleted: boolean;
  createdAt: string;
  photos: PortalMessagePhoto[];
}

// Antwort-Hüllen der Routen (Design §1.2, §2.5, §3.1)
export interface PortalBookingListResponse {
  bookings: PortalBookingSummary[];
}
export interface PortalDocumentListResponse {
  documents: PortalDocumentView[];
}
export interface PortalMessageListResponse {
  messages: PortalMessageView[];
  canSend: boolean;
}
export interface PortalTravelStatusResponse {
  status: PortalTravelStatus;
}
export interface PortalMessageResponse {
  message: string;
}
export interface PortalConsumeResponse {
  authenticated: true;
  expiresAt: string;
}
export interface PortalReauthConsumeResponse {
  reauthenticatedAt: string;
}
export interface PortalEmailChangeConsumeResponse {
  changed: true;
  message: string;
}

/** Eingabe für `PATCH /portal/profile` (Design §1.1; `type`/`email` sind nie Teil davon). */
export interface PortalProfilePrivateInput {
  firstName: string;
  lastName: string;
  phone: string;
  billingStreet: string;
  billingPostalCode: string;
  billingCity: string;
  billingCountry: string;
}
export interface PortalProfileOrganizationInput {
  organizationName: string;
  contactPerson: string;
  phone: string;
  billingStreet: string;
  billingPostalCode: string;
  billingCity: string;
  billingCountry: string;
  vatId: string;
  department: string;
  costCenter: string;
  orderReference: string;
}
export type PortalProfileInput = PortalProfilePrivateInput | PortalProfileOrganizationInput;

/** Eingabe für `POST /portal/bookings/:id/messages` (Design §3.1). */
export interface PortalMessageInput {
  body: string;
  photos?: { mimeType: PortalPhotoMimeType; dataBase64: string }[];
}

// ── Texte (Spiegel von apps/api/src/portal/types.ts PORTAL_MESSAGES + UI) ──

/** Identisch mit `PORTAL_MESSAGES` der API (apps/api/src/portal/types.ts). */
export const PORTAL_MESSAGES = {
  MAGIC_LINK_REQUESTED:
    'Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen Anmeldelink.',
  TOKEN_INVALID: 'Dieser Anmeldelink ist ungültig oder abgelaufen. Bitte fordere einen neuen an.',
  UNAUTHENTICATED: 'Bitte melde dich an, um deinen Kundenbereich zu öffnen.',
  REAUTH_REQUIRED:
    'Bitte bestätige diese Änderung zuerst über den Link, den wir dir per E-Mail schicken.',
  CANCELLATION_BLOCKED:
    'Diese Buchung kann nicht mehr online storniert werden. Bitte kontaktiere uns.',
  BOOKING_CLOSED: 'Zu dieser Buchung können keine neuen Nachrichten mehr gesendet werden.',
  PROFILE_HINT:
    'Änderungen gelten für zukünftige Anfragen. Deine bereits bestätigte Buchung bleibt unverändert.',
  EMAIL_CHANGED: 'E-Mail-Adresse geändert. Bitte melde dich mit deiner neuen Adresse erneut an.',
  EMAIL_UNAVAILABLE: 'Diese E-Mail-Adresse kann nicht verwendet werden.',
} as const;

/** Reine UI-Texte des Portals (Design §5). */
export const PORTAL_UI = {
  TOO_MANY_ATTEMPTS: 'Zu viele Versuche. Bitte warte einen Moment.',
  OFFLINE: 'Keine Verbindung. Bitte später erneut versuchen.',
  GENERIC_ERROR: 'Das hat leider nicht geklappt. Bitte versuche es später noch einmal.',
  INPUT_INVALID: 'Bitte prüfe deine Eingaben.',
  BOOKING_NOT_AVAILABLE: 'Diese Buchung ist nicht (mehr) verfügbar.',
  TEMPORARILY_UNAVAILABLE:
    'Der Kundenbereich ist gerade kurz nicht erreichbar. Bitte versuche es gleich noch einmal.',
  PHOTOS_TOO_LARGE: 'Die Bilder sind zusammen zu groß. Bitte sende weniger oder kleinere Bilder.',
  PHOTO_REJECTED: 'Nur Bilder im Format JPEG, PNG oder WebP bis 8 MB.',
  PHOTO_LIMIT: 'Bitte höchstens 5 Bilder je Nachricht.',
  NEW_INQUIRY_FALLBACK: 'Für eine neue Anfrage melde dich gern bei uns.',
  PICKUP_ADDRESS_PENDING: 'Die genaue Abholadresse teilen wir dir rechtzeitig mit.',
  APPOINTMENT_UNPLANNED: 'Zeit wird noch festgelegt',
  REAUTH_SENT: 'Wir haben dir einen Bestätigungslink geschickt.',
  EMAIL_CHANGE_SENT: 'Wir haben einen Bestätigungslink an die neue Adresse geschickt.',
  REAUTH_DONE: 'Du kannst deine Änderung jetzt speichern.',
  PROFILE_SAVED: 'Deine Angaben sind gespeichert.',
  INVOICE_FOLLOWS: 'Rechnung folgt',
  EN_ROUTE: 'Unterwegs',
} as const;

// ── Routen/Pfade ─────────────────────────────────────────────────────────────

export const PORTAL_API_BASE = '/api/portal';

export const PORTAL_ROUTES = {
  home: '/konto',
  login: '/konto/anmelden',
  profile: '/konto/profil',
  reauth: '/konto/profil/bestaetigen',
  emailChange: '/konto/profil/e-mail-bestaetigen',
  booking: (bookingId: string): string => `/konto/buchung/${encodeURIComponent(bookingId)}`,
} as const;

/** Download-/Byte-Pfade (gleiche Origin, Cookie geht automatisch mit). */
export function portalDocumentHref(bookingId: string, documentId: string): string {
  return `${PORTAL_API_BASE}/bookings/${encodeURIComponent(bookingId)}/documents/${encodeURIComponent(documentId)}`;
}

export function portalPhotoHref(bookingId: string, messageId: string, photoId: string): string {
  return `${PORTAL_API_BASE}/bookings/${encodeURIComponent(bookingId)}/messages/${encodeURIComponent(messageId)}/photos/${encodeURIComponent(photoId)}`;
}

// ── Fehler ───────────────────────────────────────────────────────────────────

/** Fehlerantwort der API `{error:{code,message,correlationId}}`, bereits kundentauglich übersetzt. */
export class PortalApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;

  constructor(code: string, status: number, message: string, correlationId: string | null = null) {
    super(message);
    this.name = 'PortalApiError';
    this.code = code;
    this.status = status;
    this.correlationId = correlationId;
  }
}

/** Netzwerk-/Verbindungsfehler (fetch hat keine Antwort geliefert). */
export class PortalNetworkError extends Error {
  constructor() {
    super(PORTAL_UI.OFFLINE);
    this.name = 'PortalNetworkError';
  }
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof PortalApiError && error.status === 401;
}

/** 403 PORTAL_REAUTH_REQUIRED (Design §1.3); tolerant gegenüber dem generischen FORBIDDEN-Code. */
export function isReauthRequired(error: unknown): boolean {
  if (!(error instanceof PortalApiError) || error.status !== 403) return false;
  return error.code === 'PORTAL_REAUTH_REQUIRED' || error.code === 'FORBIDDEN';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof PortalApiError && error.status === 404;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; correlationId?: unknown } | null;
}

/**
 * Übersetzt Status + Code + API-Text in einen Kundentext. Portal-Fehlercodes
 * (`PORTAL_*`) und Auth-Fehler (401/403/409/400 ohne Zod-Validierung) kommen
 * aus der API bereits kundentauglich; alles andere wird neutralisiert.
 */
export function customerMessageFor(
  status: number,
  code: string,
  apiMessage: string | null,
): string {
  if (status === 429) return PORTAL_UI.TOO_MANY_ATTEMPTS;
  if (status === 413) return PORTAL_UI.PHOTOS_TOO_LARGE;
  if (status === 503) return PORTAL_UI.TEMPORARILY_UNAVAILABLE;
  if (status >= 500) return PORTAL_UI.GENERIC_ERROR;
  const text = apiMessage?.trim() ?? '';
  if (code.startsWith('PORTAL_') && text !== '') return text;
  if (status === 401) return PORTAL_MESSAGES.UNAUTHENTICATED;
  if (status === 404) return PORTAL_UI.BOOKING_NOT_AVAILABLE;
  if (code === 'VALIDATION_ERROR' || code === 'CSRF_REJECTED') return PORTAL_UI.INPUT_INVALID;
  if ((status === 400 || status === 403 || status === 409) && text !== '') return text;
  if (status === 400) return PORTAL_UI.INPUT_INVALID;
  return PORTAL_UI.GENERIC_ERROR;
}

/** Anzeigetext für JEDEN Fehler der Portal-Aufrufe (nie rohe Codes). */
export function portalErrorMessage(error: unknown): string {
  if (error instanceof PortalApiError) return error.message;
  if (error instanceof PortalNetworkError) return PORTAL_UI.OFFLINE;
  return PORTAL_UI.GENERIC_ERROR;
}

// ── Client ───────────────────────────────────────────────────────────────────

export type PortalFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PortalFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Wird als JSON gesendet. */
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Nur Tests. */
  fetchImpl?: PortalFetchLike | undefined;
}

const defaultFetch: PortalFetchLike = (input, init) => fetch(input, init);

/**
 * `portalFetch<T>('/me')` ⇒ GET /api/portal/me. Immer same-origin + no-store.
 * 204 ⇒ `undefined`. Nicht-2xx ⇒ `PortalApiError`; Netzfehler ⇒ `PortalNetworkError`.
 */
export async function portalFetch<T>(path: string, options: PortalFetchOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetchImpl(`${PORTAL_API_BASE}${path}`, init);
  } catch (error) {
    // Ein bewusster Abbruch (AbortSignal) ist kein Verbindungsfehler.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new PortalNetworkError();
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorBody = (body as ErrorBody | null)?.error ?? null;
    const code = typeof errorBody?.code === 'string' ? errorBody.code : `HTTP_${response.status}`;
    const apiMessage = typeof errorBody?.message === 'string' ? errorBody.message : null;
    const correlationId =
      typeof errorBody?.correlationId === 'string' ? errorBody.correlationId : null;
    throw new PortalApiError(
      code,
      response.status,
      customerMessageFor(response.status, code, apiMessage),
      correlationId,
    );
  }
  return body as T;
}

// ── Fragment-Token (Order §7) ────────────────────────────────────────────────

/** Tokens sind base64url (32 Byte ⇒ 43 Zeichen); die API ist die Autorität, hier nur Zeichenklasse/Länge. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Liest `token` aus einem URL-Fragment (`#token=…`, auch `#a=1&token=…`).
 * Gibt `null` bei fehlendem/ungültigem Wert zurück. Rein – ohne Seiteneffekt.
 */
export function readTokenFromHash(hash: string | null | undefined): string | null {
  if (hash === null || hash === undefined) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const token = params.get('token')?.trim() ?? '';
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Entfernt das Fragment sofort aus der Adresszeile (History-Eintrag wird
 * ersetzt, kein neuer Eintrag). Nur im Browser aufrufen.
 */
export function stripFragmentFromLocation(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}`);
}

// ── Formatierer (Europe/Berlin, de-DE) ──────────────────────────────────────

const BERLIN = 'Europe/Berlin';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Integer-Cent ⇒ „1.234,56 €“ (deterministisch, ohne Intl-Leerzeichenvarianten). */
export function euro(cents: number): string {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = String(abs % 100).padStart(2, '0');
  return `${rounded < 0 ? '-' : ''}${whole},${fraction} €`;
}

function berlinParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

function parseIso(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2026-10-18` oder ISO-Zeitpunkt ⇒ „18.10.2026“ (Berliner Kalendertag); null/ungültig ⇒ „–“. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const match = DATE_ONLY.exec(value);
  if (match !== null) return `${match[3]}.${match[2]}.${match[1]}`;
  const date = parseIso(value);
  if (date === null) return '–';
  const p = berlinParts(date);
  return `${p.day}.${p.month}.${p.year}`;
}

/** ISO-Zeitpunkt ⇒ „10:00“ (Berlin); null/ungültig ⇒ „–“. */
export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const date = parseIso(value);
  if (date === null) return '–';
  const p = berlinParts(date);
  return `${p.hour}:${p.minute}`;
}

/** ISO-Zeitpunkt ⇒ „Samstag, 18.10.2026, 10:00 Uhr“ (Berlin); null/ungültig ⇒ „–“. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const date = parseIso(value);
  if (date === null) return '–';
  const p = berlinParts(date);
  return `${p.weekday}, ${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute} Uhr`;
}

/**
 * Termin-Text (Order §18): exakt ⇒ „Samstag, 18.10.2026, 10:00 Uhr“;
 * Fenster ⇒ „Samstag, 18.10.2026, 10:00–12:00 Uhr“; sonst „Zeit wird noch festgelegt“.
 * Aus einem Fenster wird NIE eine Uhrzeit erfunden.
 */
export function formatAppointmentTime(
  appointment: Pick<PortalAppointment, 'timing' | 'startAt' | 'endAt'>,
): string {
  if (appointment.timing === 'exact' && appointment.startAt !== null) {
    return formatDateTime(appointment.startAt);
  }
  if (appointment.timing === 'window' && appointment.startAt !== null) {
    const start = parseIso(appointment.startAt);
    if (start !== null) {
      const p = berlinParts(start);
      const day = `${p.weekday}, ${p.day}.${p.month}.${p.year}`;
      const end = appointment.endAt === null ? null : formatTime(appointment.endAt);
      return end === null || end === '–'
        ? `${day}, ab ${p.hour}:${p.minute} Uhr`
        : `${day}, ${p.hour}:${p.minute}–${end} Uhr`;
    }
  }
  return PORTAL_UI.APPOINTMENT_UNPLANNED;
}

/** Eventzeit „10:00–18:00 Uhr“ aus Start/Ende (fehlt eines ⇒ nur das vorhandene, fehlen beide ⇒ null). */
export function formatEventTime(start: string | null, end: string | null): string | null {
  const s = start === null ? null : formatTime(start);
  const e = end === null ? null : formatTime(end);
  if (s !== null && e !== null) return `${s}–${e} Uhr`;
  if (s !== null) return `ab ${s} Uhr`;
  if (e !== null) return `bis ${e} Uhr`;
  return null;
}

export function remainingDaysText(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 0) return 'Das Event ist heute oder bereits vorbei.';
  if (days === 1) return 'Noch 1 Tag bis zum Event.';
  return `Noch ${days} Tage bis zum Event.`;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const OCCASION_LABELS: Record<string, string> = {
  birthday: 'Geburtstag',
  wedding: 'Hochzeit',
  company_event: 'Firmenfeier',
  club: 'Verein',
  party: 'Party',
  school_kindergarten: 'Schule / Kindergarten',
  festival: 'Festival',
  other: 'Sonstiges',
};

export function occasionLabel(occasion: string | null): string | null {
  if (occasion === null || occasion === '') return null;
  return OCCASION_LABELS[occasion] ?? null;
}

export const APPOINTMENT_LABELS: Record<PortalAppointmentKind, string> = {
  pickup: 'Abholung',
  delivery: 'Lieferung',
  return: 'Rückgabe',
};

/** Rückgabe heißt bei Lieferung „Rückholung“ (Design §6). */
export function appointmentLabel(
  kind: PortalAppointmentKind,
  fulfillment: PortalFulfillment,
): string {
  if (kind === 'return' && fulfillment === 'delivery') return 'Rückholung';
  return APPOINTMENT_LABELS[kind];
}

export const STATE_LABELS: Record<PortalBookingState, string> = {
  active: 'Bestätigte Buchung',
  completed_open: 'Abgeschlossen – Rechnung offen',
  cancelled_free: 'Storniert',
  cancelled_fee: 'Storniert – Stornogebühr',
};

export const DOCUMENT_LABELS: Record<PortalDocumentType, string> = {
  offer: 'Angebot (angenommen)',
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  handover_protocol: 'Übergabeprotokoll',
  return_protocol: 'Rückgabeprotokoll',
};

export const INVOICE_LABELS: Record<PortalInvoiceState, string> = {
  none: '',
  preparing: 'Rechnung wird vorbereitet',
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

export const ITEM_KIND_LABELS: Record<PortalItemKind, string> = {
  machine: 'Maschinen',
  syrup: 'Sirup',
  consumable: 'Verbrauchsartikel',
  purchase: 'Kaufartikel',
  delivery: 'Lieferung',
};

export const ITEM_KIND_ORDER: PortalItemKind[] = [
  'machine',
  'syrup',
  'consumable',
  'purchase',
  'delivery',
];

export const FULFILLMENT_LABELS: Record<PortalFulfillment, string> = {
  pickup: 'Selbstabholung',
  delivery: 'Lieferung',
};

/** Positionen nach Art gruppiert, in fester Reihenfolge; leere Gruppen entfallen. */
export function groupItems(
  items: PortalBookingItem[],
): { kind: PortalItemKind; label: string; items: PortalBookingItem[] }[] {
  return ITEM_KIND_ORDER.map((kind) => ({
    kind,
    label: ITEM_KIND_LABELS[kind],
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

// ── Navigation (Kopie der Staff-Logik, Design §5) ───────────────────────────

export type NavigationPlatform = 'apple' | 'android' | 'web';

export function navigationPlatform(userAgent: string): NavigationPlatform {
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(userAgent)) return 'apple';
  if (/Android/i.test(userAgent)) return 'android';
  return 'web';
}

/** Externer Karten-Link passend zur Plattform – enthält nur die Adresse (Order §20). */
export function navigationHref(
  links: PortalNavigationLinks | null,
  userAgent: string,
): string | null {
  if (links === null) return null;
  return links[navigationPlatform(userAgent)];
}

/** `tel:`-Link aus der konfigurierten Nummer (Order §37); null ⇒ kein Button. */
export function telHref(phoneNumber: string | null): string | null {
  if (phoneNumber === null) return null;
  const compact = phoneNumber.replace(/[^0-9+]/g, '');
  if (compact === '' || compact === '+') return null;
  return `tel:${compact}`;
}

// ── Fotos (Design §3.1; Limits wie API) ─────────────────────────────────────

export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PortalPhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_MAX_COUNT = 5;
/** Body-Limit der API 12 MiB; Base64 bläht um 4/3 ⇒ Summe der Rohbytes ≤ 8 MiB bleibt sicher darunter. */
export const PHOTO_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function isPortalPhotoMimeType(value: string): value is PortalPhotoMimeType {
  return (PHOTO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Client-Vorprüfung ausgewählter Dateien (Typ/Größe/Anzahl); die API prüft
 * zusätzlich die Magic Bytes. Rückgabe: Fehlertext oder null.
 */
export function validatePhotoSelection(files: { type: string; size: number }[]): string | null {
  if (files.length > PHOTO_MAX_COUNT) return PORTAL_UI.PHOTO_LIMIT;
  let total = 0;
  for (const file of files) {
    if (!isPortalPhotoMimeType(file.type) || file.size > PHOTO_MAX_BYTES) {
      return PORTAL_UI.PHOTO_REJECTED;
    }
    total += file.size;
  }
  if (total > PHOTO_MAX_TOTAL_BYTES) return PORTAL_UI.PHOTOS_TOO_LARGE;
  return null;
}

/** Data-URL (`data:image/png;base64,…`) ⇒ reiner Base64-Teil; sonst null. */
export function base64FromDataUrl(dataUrl: string): string | null {
  const index = dataUrl.indexOf(';base64,');
  if (!dataUrl.startsWith('data:') || index < 0) return null;
  const payload = dataUrl.slice(index + ';base64,'.length);
  return payload === '' ? null : payload;
}
