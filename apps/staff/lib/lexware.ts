'use client';

/**
 * Phase 10: Typen, deutsche Labels und API-Aufrufe der Lexware-Office-
 * Integration (Spiegel von scratchpad/phase10_contracts.md §§3–6).
 * Nur Darstellung – keine Steuer-, Preis- oder Statuslogik im Client.
 * Der API-Key wird vom Server nie geliefert und hier nie angezeigt.
 */

import { apiFetch, type ApiResult } from './api';

// ── Verbindung / Status (§3) ─────────────────────────────────────────────

export type LexwareConnectionStatus =
  | 'not_configured'
  | 'connected'
  | 'error'
  | 'incomplete'
  | 'disconnected'
  | 'organization_mismatch';

export const LEXWARE_STATUS_LABELS: Record<LexwareConnectionStatus, string> = {
  not_configured: 'Nicht eingerichtet',
  connected: 'Verbunden',
  error: 'Fehler',
  incomplete: 'Konfiguration unvollständig',
  disconnected: 'Verbindung getrennt',
  organization_mismatch: 'Organisation geändert',
};

export type LexwareWebhookStatus = 'configured' | 'incomplete' | 'not_configured' | 'error';

export const LEXWARE_WEBHOOK_STATUS_LABELS: Record<string, string> = {
  configured: 'Eingerichtet',
  incomplete: 'Unvollständig',
  not_configured: 'Nicht eingerichtet',
  error: 'Fehler',
};

export interface LexwareStatus {
  configured: boolean;
  enabled: boolean;
  environment: 'development' | 'staging' | 'demo' | 'production' | string;
  status: LexwareConnectionStatus | string;
  statusLabel?: string | null;
  companyName?: string | null;
  organizationIdShort?: string | null;
  connectionOk?: boolean;
  taxConfigComplete?: boolean;
  /** Optional, falls der Server die Details von `isComplete()` mitliefert. */
  taxConfig?: { complete: boolean; missing?: string[]; synthetic?: boolean } | null;
  webhooks?: {
    status: LexwareWebhookStatus | string;
    subscriptions?: { eventType: string }[];
    callbackUrl?: string | null;
  } | null;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorCode?: string | null;
  apiKeyReminderDate?: string | null;
  pendingOrganizationId?: string | null;
  deeplinkBase?: string | null;
}

export interface WebhookSetupResult {
  created?: string[];
  existing?: string[];
  failed?: { eventType: string; code?: string | null }[];
}

export interface ReconcileResult {
  checked?: number;
  updated?: number;
  attention?: number;
}

export function lexwareStatusLabel(status: LexwareStatus | null): string {
  if (status === null) return LEXWARE_STATUS_LABELS.not_configured;
  if (!status.configured || !status.enabled) return LEXWARE_STATUS_LABELS.not_configured;
  if (status.statusLabel !== undefined && status.statusLabel !== null && status.statusLabel !== '')
    return status.statusLabel;
  return (
    LEXWARE_STATUS_LABELS[status.status as LexwareConnectionStatus] ??
    LEXWARE_STATUS_LABELS.not_configured
  );
}

export const LEXWARE_NOT_CONFIGURED_HINT =
  'Nicht eingerichtet – LEXWARE_API_KEY serverseitig setzen (siehe Deployment-Hinweise)';

/** Neutrale Texte zu Verbindungs-Fehlercodes (nie Rohfehler, nie Key). */
export const LEXWARE_ERROR_CODE_LABELS: Record<string, string> = {
  LEXWARE_UNAUTHORIZED: 'API-Key ungültig/abgelaufen',
  LEXWARE_FORBIDDEN: 'API-Berechtigung fehlt',
  LEXWARE_FEATURE_MISSING: 'Lexware-Vertrag ohne Rechnungsfunktion',
  LEXWARE_NOT_CONNECTED: 'Lexware-Verbindung getrennt',
  LEXWARE_NOT_CONFIGURED: 'Buchhaltungsintegration nicht konfiguriert',
  LEXWARE_ORGANIZATION_MISMATCH: 'Lexware-Organisation hat sich geändert',
  LEXWARE_TIMEOUT: 'Lexware antwortet nicht – später erneut prüfen',
  LEXWARE_UNAVAILABLE: 'Lexware derzeit nicht erreichbar',
};

export function lexwareErrorLabel(code: string | null | undefined): string | null {
  if (code === undefined || code === null || code === '') return null;
  return LEXWARE_ERROR_CODE_LABELS[code] ?? 'Verbindung prüfen';
}

export function fetchLexwareStatus(): Promise<ApiResult<LexwareStatus>> {
  return apiFetch<LexwareStatus>('/staff/lexware/status');
}

export function checkConnection(): Promise<ApiResult<LexwareStatus>> {
  return apiFetch<LexwareStatus>('/staff/lexware/check-connection', { method: 'POST', body: {} });
}

export function setupWebhooks(): Promise<ApiResult<WebhookSetupResult>> {
  return apiFetch<WebhookSetupResult>('/staff/lexware/setup-webhooks', {
    method: 'POST',
    body: {},
  });
}

export function reconcile(): Promise<ApiResult<ReconcileResult>> {
  return apiFetch<ReconcileResult>('/staff/lexware/reconcile', { method: 'POST', body: {} });
}

export function confirmOrganization(organizationId: string): Promise<ApiResult<LexwareStatus>> {
  return apiFetch<LexwareStatus>('/staff/lexware/confirm-organization', {
    method: 'POST',
    body: { organizationId },
  });
}

// ── Steuerkonfiguration (§4) ─────────────────────────────────────────────

export type LexwareTaxType = 'net' | 'gross' | 'vatfree';

export const TAX_TYPE_LABELS: Record<LexwareTaxType, string> = {
  net: 'Netto (Steuer wird aufgeschlagen)',
  gross: 'Brutto (Preise enthalten Steuer)',
  vatfree: 'Steuerfrei',
};

export type TaxTreatment = 'taxable' | 'vatfree';

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: 'Steuerpflichtig',
  vatfree: 'Steuerfrei',
};

export type TaxCategory =
  | 'machine_rental'
  | 'delivery'
  | 'purchase'
  | 'commission_consumption'
  | 'cleanup_fee'
  | 'damage_charge'
  | 'missing_item_charge'
  | 'late_fee'
  | 'manual_charge'
  | 'cancellation_charge';

/** Reihenfolge der zehn Kategorien in der Tabelle (Vertrag §4). */
export const TAX_CATEGORIES: TaxCategory[] = [
  'machine_rental',
  'delivery',
  'purchase',
  'commission_consumption',
  'cleanup_fee',
  'damage_charge',
  'missing_item_charge',
  'late_fee',
  'manual_charge',
  'cancellation_charge',
];

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  machine_rental: 'Maschinenmiete',
  delivery: 'Lieferung',
  purchase: 'Kaufartikel',
  commission_consumption: 'Kommissionsartikel (Verbrauch)',
  cleanup_fee: 'Reinigungsgebühr',
  damage_charge: 'Schadenkosten',
  missing_item_charge: 'Ersatzkosten Fehlteil',
  late_fee: 'Verspätungsgebühr',
  manual_charge: 'Nachbelastung',
  cancellation_charge: 'Stornokosten',
};

export interface TaxCategoryConfig {
  category: TaxCategory | string;
  label?: string;
  treatment: TaxTreatment | string;
  taxRateBp: number;
  synthetic?: boolean;
  updatedAt?: string | null;
}

export interface TaxConfig {
  taxType: LexwareTaxType | null;
  categories: TaxCategoryConfig[];
  complete: boolean;
  missing?: string[];
  synthetic?: boolean;
  hint?: string;
  /** Optional – fehlt es, entscheidet die UI anhand `environment` der Status-Route. */
  syntheticAllowed?: boolean;
}

export interface TaxConfigInput {
  taxType: LexwareTaxType;
  categories: { category: string; treatment: TaxTreatment; taxRateBp: number }[];
}

export const TAX_CONFIG_HINT =
  'Steuerkonfiguration vor Produktivbetrieb mit Buchhaltung/Steuerberatung prüfen.';

/**
 * Eingabe in Prozent („19“, „19,00“, „7.5“) → Basispunkte (1900, 750).
 * Reine Eingabeumwandlung mit maximal zwei Dezimalstellen; ungültig ⇒ null.
 */
export function parsePercentInput(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s|%/g, '');
  if (trimmed === '') return null;
  const normalized = trimmed.replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const bp =
    Number.parseInt(whole ?? '0', 10) * 100 + Number.parseInt((fraction + '00').slice(0, 2), 10);
  if (!Number.isFinite(bp) || bp < 0 || bp > 10000) return null;
  return bp;
}

/** Basispunkte → Eingabewert „19,00“. */
export function basisPointsToInput(bp: number): string {
  const abs = Math.abs(Math.trunc(bp));
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export function fetchTaxConfig(): Promise<ApiResult<TaxConfig>> {
  return apiFetch<TaxConfig>('/staff/accounting/tax-config');
}

export function saveTaxConfig(body: TaxConfigInput): Promise<ApiResult<TaxConfig>> {
  return apiFetch<TaxConfig>('/staff/accounting/tax-config', { method: 'PUT', body });
}

export function applySyntheticTax(): Promise<ApiResult<TaxConfig>> {
  return apiFetch<TaxConfig>('/staff/accounting/tax-config/synthetic', {
    method: 'POST',
    body: {},
  });
}

// ── Kontakte (§5) ────────────────────────────────────────────────────────

export type ContactMappingStatus = 'linked' | 'review_required' | 'create_unknown' | string;

export interface ContactMapping {
  lexwareContactId: string | null;
  status: ContactMappingStatus;
  contactVersion?: number | null;
  linkedAt?: string | null;
  lastSyncedAt?: string | null;
  syncStatus?: string | null;
}

export interface ContactCandidate {
  contactId: string;
  displayName: string;
  email?: string | null;
  reason?: string | null;
}

export interface CustomerLexwareContact {
  mapping: ContactMapping | null;
  candidates: ContactCandidate[];
  deeplink?: string | null;
}

export const CONTACT_STATUS_LABELS = {
  linked: 'Verknüpft',
  review_required: 'Lexware-Kontakt prüfen',
  create_unknown: 'Anlage ausstehend – Abgleich beim nächsten Lauf',
  not_linked: 'Nicht verknüpft',
} as const satisfies Record<string, string>;

export function contactStatusLabel(view: CustomerLexwareContact | null): string {
  if (view === null || view.mapping === null) {
    return view !== null && view.candidates.length > 0
      ? CONTACT_STATUS_LABELS.review_required
      : CONTACT_STATUS_LABELS.not_linked;
  }
  return (
    (CONTACT_STATUS_LABELS as Record<string, string>)[view.mapping.status] ??
    CONTACT_STATUS_LABELS.not_linked
  );
}

export function fetchCustomerLexwareContact(
  customerId: string,
): Promise<ApiResult<CustomerLexwareContact>> {
  return apiFetch<CustomerLexwareContact>(`/staff/customers/${customerId}/lexware-contact`);
}

export function linkLexwareContact(
  customerId: string,
  lexwareContactId: string,
): Promise<ApiResult<CustomerLexwareContact>> {
  return apiFetch<CustomerLexwareContact>(`/staff/customers/${customerId}/lexware-contact/link`, {
    method: 'POST',
    body: { lexwareContactId },
  });
}

export function createLexwareContact(
  customerId: string,
): Promise<ApiResult<CustomerLexwareContact>> {
  return apiFetch<CustomerLexwareContact>(`/staff/customers/${customerId}/lexware-contact/create`, {
    method: 'POST',
    body: {},
  });
}

// ── Buchhaltungsblock in Abrechnung/Storno (§6) ──────────────────────────

export type AccountingProvider = 'lexware' | 'mock' | 'disabled';

export const ACCOUNTING_PROVIDER_LABELS = {
  lexware: 'Lexware',
  mock: 'MOCK',
  disabled: 'Nicht konfiguriert',
} as const satisfies Record<string, string>;

export function accountingProviderLabel(provider: string | null | undefined): string {
  if (provider === undefined || provider === null) return ACCOUNTING_PROVIDER_LABELS.disabled;
  return (
    (ACCOUNTING_PROVIDER_LABELS as Record<string, string>)[provider] ??
    ACCOUNTING_PROVIDER_LABELS.disabled
  );
}

export type AccountingBlockerCode =
  | 'TAX_CONFIG_INCOMPLETE'
  | 'TAX_TYPE_MISMATCH'
  | 'CONTACT_REVIEW_REQUIRED'
  | 'ADVANCE_PAYMENT_UNSUPPORTED'
  | 'DEPOSIT_UNSUPPORTED'
  | 'LEXWARE_NOT_CONFIGURED'
  | 'LEXWARE_NOT_CONNECTED'
  | 'LEXWARE_ORGANIZATION_MISMATCH'
  | 'LEXWARE_UNAUTHORIZED'
  | 'LEXWARE_FORBIDDEN'
  | 'TOTAL_MISMATCH'
  | 'RECOVERY_AMBIGUOUS'
  | 'INVOICE_VOIDED'
  | 'INVOICE_MISSING'
  | 'INVOICE_UNEXPECTED_STATUS'
  | 'LEXWARE_FEATURE_MISSING';

/** Blocker-Labels laut Vertrag §6 (Fallback, wenn der Server kein Label liefert). */
export const ACCOUNTING_BLOCKER_LABELS: Record<AccountingBlockerCode, string> = {
  TAX_CONFIG_INCOMPLETE: 'Steuerkonfiguration für Buchhaltung unvollständig',
  TAX_TYPE_MISMATCH: 'Steuerkonfiguration passt nicht zum Lexware-Profil',
  CONTACT_REVIEW_REQUIRED: 'Lexware-Kontakt prüfen',
  ADVANCE_PAYMENT_UNSUPPORTED:
    'Lexware-Abbildung für Anzahlung muss vor Übertragung geklärt werden.',
  DEPOSIT_UNSUPPORTED:
    'Lexware-Abbildung für angewendete Kaution muss vor Übertragung geklärt werden.',
  LEXWARE_NOT_CONFIGURED: 'Buchhaltungsintegration nicht konfiguriert',
  LEXWARE_NOT_CONNECTED: 'Lexware-Verbindung getrennt – Einstellungen prüfen',
  LEXWARE_ORGANIZATION_MISMATCH:
    'Lexware-Organisation hat sich geändert – Bestätigung erforderlich',
  LEXWARE_UNAUTHORIZED: 'API-Key ungültig/abgelaufen',
  LEXWARE_FORBIDDEN: 'API-Berechtigung fehlt',
  TOTAL_MISMATCH: 'Summenabweichung – Buchhaltungsprüfung erforderlich',
  RECOVERY_AMBIGUOUS: 'Lexware-Abgleich erforderlich',
  INVOICE_VOIDED: 'Buchhaltungsprüfung erforderlich',
  INVOICE_MISSING: 'Buchhaltungsprüfung erforderlich',
  INVOICE_UNEXPECTED_STATUS: 'Buchhaltungsprüfung erforderlich',
  LEXWARE_FEATURE_MISSING: 'Lexware-Vertrag ohne Rechnungsfunktion – Einstellungen prüfen',
};

export interface AccountingBlocker {
  code: AccountingBlockerCode | string;
  label?: string | null;
  action?: string | null;
}

export interface AccountingInvoiceInfo {
  created: boolean;
  /** Nur mit Recht accounting.view_reference geliefert. */
  voucherNumber?: string | null;
  /** Nur mit Recht geliefert; offizielle Deeplink-Struktur vom Server. */
  deeplink?: string | null;
  voucherStatus?: string | null;
  paymentStatus?: 'open' | 'paid' | 'overdue' | string | null;
  paymentStatusLabel?: string | null;
  deliveryStatus?: 'pending' | 'sent' | string | null;
  deliveryLabel?: string | null;
  attentionCode?: string | null;
  attentionLabel?: string | null;
  lastSyncedAt?: string | null;
}

export interface AccountingBlock {
  provider: AccountingProvider | string | null;
  blockers?: AccountingBlocker[];
  invoice?: AccountingInvoiceInfo | null;
  canRetry?: boolean;
  retryLabel?: string | null;
}

/** Nächste Aktion zu einem Blocker: Link in der Staff-App (nur bekannte, feste Ziele). */
export interface BlockerNextAction {
  label: string;
  href: string;
}

export function blockerLabel(blocker: AccountingBlocker): string {
  if (blocker.label !== undefined && blocker.label !== null && blocker.label !== '') {
    return blocker.label;
  }
  return (
    ACCOUNTING_BLOCKER_LABELS[blocker.code as AccountingBlockerCode] ??
    (ATTENTION_CODES.has(blocker.code) ? ACCOUNTING_ATTENTION_TEXT : TRANSFER_CHECK_TEXT)
  );
}

/**
 * Nächste Aktion je Blocker-Code (Order §70): Steuer ⇒ Steuerkonfiguration,
 * Kontakt ⇒ Kunde, Verbindung/Key/Berechtigung/Organisation ⇒ Einstellungen.
 */
export function blockerNextAction(
  code: string,
  context: { customerId?: string | null },
): BlockerNextAction | null {
  switch (code) {
    case 'TAX_CONFIG_INCOMPLETE':
    case 'TAX_TYPE_MISMATCH':
      return { label: 'Steuerkonfiguration öffnen', href: '/einstellungen/steuern' };
    case 'CONTACT_REVIEW_REQUIRED':
      return context.customerId !== undefined && context.customerId !== null
        ? { label: 'Kunde öffnen', href: `/kunden/${context.customerId}` }
        : null;
    case 'LEXWARE_NOT_CONFIGURED':
    case 'LEXWARE_NOT_CONNECTED':
    case 'LEXWARE_ORGANIZATION_MISMATCH':
    case 'LEXWARE_UNAUTHORIZED':
    case 'LEXWARE_FORBIDDEN':
    case 'LEXWARE_FEATURE_MISSING':
      return { label: 'Lexware-Einstellungen öffnen', href: '/einstellungen' };
    default:
      return null;
  }
}

/** Blocker, die eine manuelle Buchhaltungsprüfung (Attention) bedeuten. */
export const ATTENTION_CODES: ReadonlySet<string> = new Set([
  'TOTAL_MISMATCH',
  'RECOVERY_AMBIGUOUS',
  'INVOICE_VOIDED',
  'INVOICE_MISSING',
  'INVOICE_UNEXPECTED_STATUS',
]);

export const ATTENTION_LABELS: Record<string, string> = {
  TOTAL_MISMATCH: 'Summenabweichung – Buchhaltungsprüfung erforderlich',
  RECOVERY_AMBIGUOUS: 'Lexware-Abgleich erforderlich',
  INVOICE_VOIDED: 'Buchhaltungsprüfung erforderlich – Rechnung in Lexware storniert',
  INVOICE_MISSING: 'Buchhaltungsprüfung erforderlich – Rechnung in Lexware nicht gefunden',
  INVOICE_UNEXPECTED_STATUS: 'Buchhaltungsprüfung erforderlich',
};

export function attentionLabel(invoice: AccountingInvoiceInfo | null | undefined): string | null {
  if (invoice === undefined || invoice === null) return null;
  const code = invoice.attentionCode ?? null;
  if (code === null || code === '') return null;
  if (invoice.attentionLabel !== undefined && invoice.attentionLabel !== null) {
    return invoice.attentionLabel !== '' ? invoice.attentionLabel : null;
  }
  return ATTENTION_LABELS[code] ?? 'Buchhaltungsprüfung erforderlich';
}

export const PAYMENT_STATUS_LABELS_LEXWARE: Record<string, string> = {
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

/** Versandstatus: nie „gesendet“ behaupten (Order §3/§40) – die API kann nicht mailen. */
export const DELIVERY_STATUS_LABELS = {
  pending: 'Ausstehend',
} as const satisfies Record<string, string>;

export function deliveryStatusLabel(invoice: AccountingInvoiceInfo | null | undefined): string {
  const status = invoice?.deliveryStatus ?? 'pending';
  return (
    (DELIVERY_STATUS_LABELS as Record<string, string>)[status] ?? DELIVERY_STATUS_LABELS.pending
  );
}

export const TRANSFER_CHECK_TEXT = 'Lexware-Übertragung prüfen';
export const RETRY_TRANSFER_LABEL_LEXWARE = 'Lexware-Übertragung erneut versuchen';
export const ACCOUNTING_ATTENTION_TEXT = 'Buchhaltungsprüfung erforderlich';
