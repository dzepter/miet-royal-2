import type { AppConfig } from '@mietroyal/config';
import { lexwareContactMappings, type DatabaseExecutor } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { AccountingPayload } from '../accounting/gateway.ts';
import { LexwareBlockedError, type LexwareConnectionService } from './connection-service.ts';
import type { LexwareContext } from './context.ts';
import { payloadBlockers } from './invoice-builder.ts';
import type { TaxConfigService, TaxConfigState } from './tax-config-service.ts';

/**
 * Transfer-Vorbedingungen für den Provider „lexware“ (Vertrag §6, Order
 * §§13/14/26/27/70/72) – OHNE externen Aufruf (nur DB/Konfiguration). Wird
 * vom Zweiphasenpfad (Phase 1) UND von den Views genutzt, damit die UI exakt
 * dieselben Blocker zeigt, an denen ein Transfer scheitern würde.
 */
export interface ReadinessBlocker {
  code: string;
  label: string;
  action: string;
}

export const ACCOUNTING_BLOCKER_LABELS: Record<string, { label: string; action: string }> = {
  TAX_CONFIG_INCOMPLETE: {
    label: 'Steuerkonfiguration für Buchhaltung unvollständig',
    action: 'Steuerkonfiguration unter Einstellungen vervollständigen.',
  },
  TAX_TYPE_MISMATCH: {
    label: 'Steuerkonfiguration passt nicht zum Lexware-Profil',
    action: 'Lexware-Steuertyp/Kleinunternehmerregelung mit der Steuerkonfiguration abgleichen.',
  },
  CONTACT_REVIEW_REQUIRED: {
    label: 'Lexware-Kontakt prüfen',
    action: 'Im Kundenprofil den passenden Lexware-Kontakt wählen oder neu anlegen.',
  },
  CONTACT_SYNC_IN_PROGRESS: {
    label: 'Lexware-Kontakt wird gerade angelegt',
    action: 'Kurz warten – die Übertragung wird automatisch erneut versucht.',
  },
  ADVANCE_PAYMENT_UNSUPPORTED: {
    label: 'Lexware-Abbildung für Anzahlung muss vor Übertragung geklärt werden.',
    action: 'Anzahlung mit Buchhaltung klären – keine automatische Übertragung.',
  },
  DEPOSIT_UNSUPPORTED: {
    label: 'Lexware-Abbildung für angewendete Kaution muss vor Übertragung geklärt werden.',
    action: 'Angewendete Kaution mit Buchhaltung klären – keine automatische Übertragung.',
  },
  LINE_TYPE_UNSUPPORTED: {
    label: 'Positionstyp ohne Buchhaltungsabbildung',
    action: 'Buchhaltungsprüfung erforderlich.',
  },
  PAYLOAD_TOTAL_MISMATCH: {
    label: 'Summenabweichung – Buchhaltungsprüfung erforderlich',
    action: 'Abrechnungssumme und Positionen prüfen.',
  },
  LEXWARE_NOT_CONFIGURED: {
    label: 'Buchhaltungsintegration nicht konfiguriert',
    action: 'LEXWARE_API_KEY serverseitig setzen (Deployment-Hinweise).',
  },
  LEXWARE_NOT_CONNECTED: {
    label: 'Lexware-Verbindung getrennt – Einstellungen prüfen',
    action: 'Unter Einstellungen → Lexware „Verbindung prüfen“ ausführen.',
  },
  LEXWARE_ORGANIZATION_MISMATCH: {
    label: 'Lexware-Organisation hat sich geändert – Bestätigung erforderlich',
    action: 'Unter Einstellungen → Lexware die Organisation bewusst bestätigen.',
  },
  LEXWARE_UNAUTHORIZED: {
    label: 'API-Key ungültig/abgelaufen',
    action: 'API-Key in Lexware erneuern und serverseitig hinterlegen.',
  },
  LEXWARE_FORBIDDEN: {
    label: 'API-Berechtigung fehlt',
    action: 'Berechtigungen des API-Keys in Lexware prüfen.',
  },
  LEXWARE_FEATURE_MISSING: {
    label: 'Lexware-Vertrag ohne Rechnungsfunktion – Einstellungen prüfen',
    action: 'Lexware-Vertrag/Business-Feature INVOICING prüfen.',
  },
  LEXWARE_VALIDATION: {
    label: 'Lexware hat den Beleg abgelehnt – Buchhaltungsprüfung erforderlich',
    action: 'Steuerkonfiguration und Positionen prüfen, danach erneut übertragen.',
  },
  LEXWARE_TIMEOUT: {
    label: 'Lexware antwortet nicht – wird erneut versucht',
    action: 'Später erneut versuchen.',
  },
  LEXWARE_NETWORK: {
    label: 'Lexware nicht erreichbar – wird erneut versucht',
    action: 'Später erneut versuchen.',
  },
  LEXWARE_RATE_LIMITED: {
    label: 'Lexware-Anfragelimit erreicht – wird erneut versucht',
    action: 'Später erneut versuchen.',
  },
  LEXWARE_SERVER: {
    label: 'Lexware-Störung – wird erneut versucht',
    action: 'Später erneut versuchen.',
  },
  TOTAL_MISMATCH: {
    label: 'Summenabweichung – Buchhaltungsprüfung erforderlich',
    action: 'Rechnung in Lexware mit der Abrechnung vergleichen.',
  },
  RECOVERY_AMBIGUOUS: {
    label: 'Lexware-Abgleich erforderlich',
    action: 'Belege in Lexware prüfen – mehrere Kandidaten für diesen Vorgang.',
  },
  SNAPSHOT_MISMATCH: {
    label: 'Buchhaltungsprüfung erforderlich',
    action: 'Snapshot der Übertragung weicht ab – Buchhaltung prüfen.',
  },
  INVOICE_VOIDED: {
    label: 'Buchhaltungsprüfung erforderlich',
    action: 'Rechnung wurde in Lexware storniert – Buchhaltung prüfen.',
  },
  INVOICE_MISSING: {
    label: 'Buchhaltungsprüfung erforderlich',
    action: 'Rechnung in Lexware nicht mehr vorhanden – Buchhaltung prüfen.',
  },
  INVOICE_UNEXPECTED_STATUS: {
    label: 'Buchhaltungsprüfung erforderlich',
    action: 'Rechnungsstatus in Lexware prüfen.',
  },
};

export function blockerFor(code: string): ReadinessBlocker {
  const entry = ACCOUNTING_BLOCKER_LABELS[code];
  return entry === undefined
    ? { code, label: 'Buchhaltungsprüfung erforderlich', action: 'Buchhaltung prüfen.' }
    : { code, label: entry.label, action: entry.action };
}

export interface TransferReadinessInput {
  config: AppConfig;
  lexware: LexwareContext;
  connection: LexwareConnectionService;
  taxConfig: TaxConfigService;
  payload: AccountingPayload;
  customerId: string;
  executor?: DatabaseExecutor;
}

export interface TransferReadiness {
  blockers: ReadinessBlocker[];
  /** Gepinnte Organisation (nur wenn die Verbindung bereit ist). */
  organizationId: string | null;
  taxConfig: TaxConfigState;
}

export async function assessTransferReadiness(
  input: TransferReadinessInput,
): Promise<TransferReadiness> {
  const executor = input.executor ?? input.lexware.db;
  const codes: string[] = [];
  let organizationId: string | null = null;
  let profileTaxType: string | null = null;
  let profileSmallBusiness: boolean | null = null;

  if (!input.config.lexware.enabled || input.lexware.client === null) {
    codes.push('LEXWARE_NOT_CONFIGURED');
  } else {
    try {
      const ready = await input.connection.assertReady(executor);
      organizationId = ready.organizationId;
      profileTaxType = ready.state.taxType;
      profileSmallBusiness = ready.state.smallBusiness;
    } catch (error) {
      if (!(error instanceof LexwareBlockedError)) throw error;
      codes.push(error.code);
    }
  }

  const taxConfig = await input.taxConfig.load(executor);
  if (!taxConfig.complete) codes.push('TAX_CONFIG_INCOMPLETE');
  else {
    // Plausibilität gegen das Profil (Order §14): keine Detailentscheidung,
    // nur Widerspruch ⇒ Blocker.
    const anyTaxable = Object.values(taxConfig.categories).some(
      (entry) => entry !== undefined && entry.treatment === 'taxable',
    );
    if (
      (profileTaxType !== null && profileTaxType !== taxConfig.taxType) ||
      (profileSmallBusiness === true && taxConfig.taxType !== 'vatfree') ||
      (taxConfig.taxType === 'vatfree' && anyTaxable)
    ) {
      codes.push('TAX_TYPE_MISMATCH');
    }
  }

  for (const code of payloadBlockers(input.payload, taxConfig)) {
    if (!codes.includes(code)) codes.push(code);
  }

  const mappings = await executor
    .select({ syncStatus: lexwareContactMappings.syncStatus })
    .from(lexwareContactMappings)
    .where(eq(lexwareContactMappings.customerId, input.customerId));
  if (mappings[0]?.syncStatus === 'review_required') codes.push('CONTACT_REVIEW_REQUIRED');

  return { blockers: codes.map(blockerFor), organizationId, taxConfig };
}

// ── Buchhaltungsblock der Views (Vertrag §6) ─────────────────────────────

export interface AccountingInvoiceView {
  created: boolean;
  /** Nur mit accounting.view_reference. */
  voucherNumber: string | null;
  /** Nur mit accounting.view_reference (offizielle Deeplink-Struktur). */
  deeplink: string | null;
  voucherStatus: string | null;
  paymentStatus: 'open' | 'paid' | 'overdue' | null;
  paymentStatusLabel: string | null;
  deliveryStatus: 'pending' | 'sent' | null;
  deliveryLabel: string | null;
  attentionCode: string | null;
  attentionLabel: string | null;
  lastSyncedAt: string | null;
}

export interface AccountingBlockView {
  provider: 'mock' | 'disabled' | 'lexware';
  blockers: ReadinessBlocker[];
  invoice: AccountingInvoiceView;
  canRetry: boolean;
  retryLabel: string;
}

export const LEXWARE_RETRY_LABEL = 'Lexware-Übertragung erneut versuchen';
export const DELIVERY_PENDING_LABEL = 'Versand ausstehend';

const PAYMENT_LABELS: Record<'open' | 'paid' | 'overdue', string> = {
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
};

export interface AccountingBlockInput {
  provider: 'mock' | 'disabled' | 'lexware';
  blockers: ReadinessBlocker[];
  transfer: {
    status: string;
    externalReference: string | null;
    paymentStatus: 'open' | 'paid' | 'overdue' | null;
    attentionCode: string | null;
    claimExpiresAt: Date | null;
  } | null;
  mapping: {
    lexwareInvoiceId: string | null;
    voucherNumber: string | null;
    voucherStatus: string | null;
    paymentStatus: string | null;
    deliveryStatus: string;
    attentionCode: string | null;
    lastSyncedAt: Date | null;
  } | null;
  /** Lokal gespiegelter Zahlungsstatus (Settlement/Storno) als Fallback. */
  localPaymentStatus: 'open' | 'paid' | 'overdue' | null;
  localDeliveryStatus: string | null;
  canViewReference: boolean;
  deeplink: string | null;
  now: Date;
}

export function buildAccountingBlock(input: AccountingBlockInput): AccountingBlockView {
  const { transfer, mapping } = input;
  const created =
    transfer?.status === 'succeeded' ||
    (mapping !== null && mapping.lexwareInvoiceId !== null) ||
    (transfer?.status === 'attention' && mapping?.lexwareInvoiceId !== null);
  const rawPayment = mapping?.paymentStatus ?? transfer?.paymentStatus ?? input.localPaymentStatus;
  const paymentStatus =
    rawPayment === 'open' || rawPayment === 'paid' || rawPayment === 'overdue' ? rawPayment : null;
  const rawDelivery = created ? (mapping?.deliveryStatus ?? input.localDeliveryStatus) : null;
  const deliveryStatus =
    rawDelivery === 'sent' ? 'sent' : rawDelivery === 'pending' ? 'pending' : null;
  const attentionCode = transfer?.attentionCode ?? mapping?.attentionCode ?? null;
  const claimActive =
    transfer?.status === 'in_progress' &&
    transfer.claimExpiresAt !== null &&
    transfer.claimExpiresAt.getTime() > input.now.getTime();
  const canRetry =
    transfer !== null &&
    transfer.status !== 'succeeded' &&
    transfer.status !== 'pending' &&
    !claimActive &&
    (input.provider === 'lexware' ? transfer.status !== 'attention' : true);
  return {
    provider: input.provider,
    blockers: input.blockers,
    invoice: {
      created,
      voucherNumber: input.canViewReference
        ? (mapping?.voucherNumber ?? (created ? (transfer?.externalReference ?? null) : null))
        : null,
      deeplink: input.canViewReference ? input.deeplink : null,
      voucherStatus: mapping?.voucherStatus ?? null,
      paymentStatus: created ? paymentStatus : null,
      paymentStatusLabel: created && paymentStatus !== null ? PAYMENT_LABELS[paymentStatus] : null,
      deliveryStatus,
      deliveryLabel:
        deliveryStatus === 'pending'
          ? DELIVERY_PENDING_LABEL
          : deliveryStatus === 'sent'
            ? 'Versendet'
            : null,
      attentionCode,
      attentionLabel: attentionCode === null ? null : blockerFor(attentionCode).label,
      lastSyncedAt: mapping?.lastSyncedAt?.toISOString() ?? null,
    },
    canRetry,
    retryLabel: input.provider === 'lexware' ? LEXWARE_RETRY_LABEL : 'Übertragung erneut versuchen',
  };
}
