import {
  accountingTaxConfig,
  type AccountingTaxConfigRow,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { getStringSetting, setStringSetting } from '../crm/settings-service.ts';

/**
 * Explizite Steuerkonfiguration für die Buchhaltung (Order §13/§62, Vertrag
 * §4). Es gibt KEINE Produktionsdefaults und keinen hartkodierten Steuersatz:
 * jede Abrechnungskategorie braucht eine administrativ gepflegte Behandlung
 * (steuerpflichtig mit Satz in Basispunkten oder steuerfrei) und der globale
 * Lexware-`taxType` (net | gross | vatfree) muss gesetzt sein. Fehlt etwas,
 * ist die Konfiguration unvollständig ⇒ Hard Block vor jedem Transfer.
 * Synthetische Werte (klar markiert) gibt es nur außerhalb von production.
 * Änderungen wirken nur auf künftige Transfers – der Provider-Snapshot v2
 * friert die zum Zeitpunkt des Transfers gültige Konfiguration ein.
 */

export const TAX_CATEGORIES = [
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
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

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

export const LEXWARE_TAX_TYPES = ['net', 'gross', 'vatfree'] as const;
export type LexwareTaxType = (typeof LEXWARE_TAX_TYPES)[number];
export type TaxTreatment = AccountingTaxConfigRow['treatment'];

/** system_settings-Schlüssel des globalen Lexware-taxType. */
export const LEXWARE_TAX_TYPE_SETTING_KEY = 'accounting_lexware_tax_type';

export const TAX_CONFIG_HINT =
  'Steuerkonfiguration vor Produktivbetrieb mit Buchhaltung/Steuerberatung prüfen.';

/** Synthetischer Satz für Test/Dev (Basispunkte) – NIE in production wirksam. */
export const SYNTHETIC_TAX_RATE_BP = 1900;

export interface TaxCategoryConfig {
  treatment: TaxTreatment;
  taxRateBp: number;
  synthetic: boolean;
}

/** Konfigurationsstand zu einem Zeitpunkt (wird als Snapshot eingefroren). */
export interface TaxConfigState {
  taxType: LexwareTaxType | null;
  categories: Partial<Record<TaxCategory, TaxCategoryConfig>>;
  complete: boolean;
  missing: string[];
  synthetic: boolean;
}

export interface TaxConfigEntryView {
  category: TaxCategory;
  label: string;
  treatment: TaxTreatment;
  taxRateBp: number;
  synthetic: boolean;
  updatedAt: string;
}

export interface TaxConfigView {
  taxType: LexwareTaxType | null;
  categories: TaxConfigEntryView[];
  complete: boolean;
  missing: string[];
  synthetic: boolean;
  syntheticAllowed: boolean;
  hint: string;
}

export interface TaxConfigUpdateInput {
  taxType: LexwareTaxType;
  categories: { category: string; treatment: TaxTreatment; taxRateBp: number }[];
}

export function isTaxCategory(value: string): value is TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(value);
}

export function isLexwareTaxType(value: string | null): value is LexwareTaxType {
  return value !== null && (LEXWARE_TAX_TYPES as readonly string[]).includes(value);
}

/**
 * Abbildung Payload-Positionstyp (Phase-9-Snapshot) → Steuerkategorie.
 * `discount` übernimmt die Behandlung der Maschinenmiete (Order §24/§25);
 * Credits (Anzahlung/Kaution) haben keine Steuerzeile (fail-closed, §26/§27)
 * ⇒ null. Unbekannte Typen ⇒ null (Blocker, nichts wird erfunden).
 */
export function taxCategoryForLineType(lineType: string): TaxCategory | null {
  if (lineType === 'discount') return 'machine_rental';
  if (lineType === 'cancellation_fee') return 'cancellation_charge';
  return isTaxCategory(lineType) ? lineType : null;
}

export class TaxConfigService {
  constructor(
    private readonly db: Database,
    private readonly appEnv: string,
  ) {}

  get syntheticAllowed(): boolean {
    return this.appEnv !== 'production';
  }

  /** Aktueller Stand (ohne Labels) – Grundlage für Snapshot und Readiness. */
  async load(executor: DatabaseExecutor = this.db): Promise<TaxConfigState> {
    const rows = await executor.select().from(accountingTaxConfig);
    const rawTaxType = await getStringSetting(executor, LEXWARE_TAX_TYPE_SETTING_KEY);
    const taxType = isLexwareTaxType(rawTaxType) ? rawTaxType : null;
    const categories: Partial<Record<TaxCategory, TaxCategoryConfig>> = {};
    let synthetic = false;
    for (const row of rows) {
      if (!isTaxCategory(row.category)) continue;
      // In production zählen synthetische Zeilen nicht als Konfiguration.
      if (row.synthetic && !this.syntheticAllowed) continue;
      categories[row.category] = {
        treatment: row.treatment,
        taxRateBp: row.taxRateBp,
        synthetic: row.synthetic,
      };
      if (row.synthetic) synthetic = true;
    }
    const missing: string[] = TAX_CATEGORIES.filter(
      (category) => categories[category] === undefined,
    );
    if (taxType === null) missing.push('taxType');
    return { taxType, categories, complete: missing.length === 0, missing, synthetic };
  }

  /** Vertrag §3/§4: alle 10 Kategorien ∧ taxType ∧ (production ⇒ keine synthetischen Zeilen). */
  async isComplete(
    executor: DatabaseExecutor = this.db,
  ): Promise<{ complete: boolean; missing: string[]; synthetic: boolean }> {
    const state = await this.load(executor);
    return { complete: state.complete, missing: state.missing, synthetic: state.synthetic };
  }

  async list(): Promise<TaxConfigView> {
    const rows = await this.db.select().from(accountingTaxConfig);
    const state = await this.load();
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    const categories: TaxConfigEntryView[] = [];
    for (const category of TAX_CATEGORIES) {
      const row = byCategory.get(category);
      if (row === undefined) continue;
      if (row.synthetic && !this.syntheticAllowed) continue;
      categories.push({
        category,
        label: TAX_CATEGORY_LABELS[category],
        treatment: row.treatment,
        taxRateBp: row.taxRateBp,
        synthetic: row.synthetic,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return {
      taxType: state.taxType,
      categories,
      complete: state.complete,
      missing: state.missing,
      synthetic: state.synthetic,
      syntheticAllowed: this.syntheticAllowed,
      hint: TAX_CONFIG_HINT,
    };
  }

  /**
   * Administrative Pflege (system.settings). Validierung: bekannte
   * Kategorien, keine Duplikate, taxRateBp 0..10000, vatfree ⇒ 0. Es wird
   * nichts ergänzt, was nicht angegeben wurde – Vollständigkeit entscheidet
   * `isComplete()`. Gespeicherte Zeilen sind nie synthetisch.
   */
  async update(actorId: string, input: TaxConfigUpdateInput, now = new Date()): Promise<void> {
    if (!isLexwareTaxType(input.taxType)) {
      throw new AuthError('VALIDATION', 'Ungültiger Lexware-Steuertyp.');
    }
    const seen = new Set<string>();
    const entries: { category: TaxCategory; treatment: TaxTreatment; taxRateBp: number }[] = [];
    for (const entry of input.categories) {
      if (!isTaxCategory(entry.category)) {
        throw new AuthError('VALIDATION', 'Unbekannte Abrechnungskategorie.');
      }
      if (seen.has(entry.category)) {
        throw new AuthError('VALIDATION', 'Kategorie mehrfach angegeben.');
      }
      seen.add(entry.category);
      if (entry.treatment !== 'taxable' && entry.treatment !== 'vatfree') {
        throw new AuthError('VALIDATION', 'Ungültige steuerliche Behandlung.');
      }
      if (!Number.isInteger(entry.taxRateBp) || entry.taxRateBp < 0 || entry.taxRateBp > 10_000) {
        throw new AuthError('VALIDATION', 'Steuersatz muss zwischen 0 und 100 % liegen.');
      }
      if (entry.treatment === 'vatfree' && entry.taxRateBp !== 0) {
        throw new AuthError('VALIDATION', 'Steuerfreie Kategorien haben den Satz 0 %.');
      }
      if (input.taxType === 'vatfree' && entry.treatment === 'taxable') {
        throw new AuthError(
          'VALIDATION',
          'Bei steuerfreiem Lexware-Konto können Kategorien nicht steuerpflichtig sein.',
        );
      }
      entries.push({
        category: entry.category,
        treatment: entry.treatment,
        taxRateBp: entry.treatment === 'vatfree' ? 0 : entry.taxRateBp,
      });
    }
    await this.db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx
          .insert(accountingTaxConfig)
          .values({
            category: entry.category,
            treatment: entry.treatment,
            taxRateBp: entry.taxRateBp,
            synthetic: false,
            updatedBy: actorId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: accountingTaxConfig.category,
            set: {
              treatment: entry.treatment,
              taxRateBp: entry.taxRateBp,
              synthetic: false,
              updatedBy: actorId,
              updatedAt: now,
            },
          });
      }
    });
    await setStringSetting(this.db, actorId, LEXWARE_TAX_TYPE_SETTING_KEY, input.taxType);
  }

  /**
   * Synthetische Testwerte (NUR außerhalb von production): alle Kategorien
   * steuerpflichtig mit SYNTHETIC_TAX_RATE_BP, taxType net, `synthetic = true`.
   * Kein Produktionsdefault – in production gibt es diese Aktion nicht.
   */
  async applySyntheticDefaults(actorId: string, now = new Date()): Promise<void> {
    if (!this.syntheticAllowed) {
      throw new AuthError(
        'CONFLICT',
        'Synthetische Steuerwerte sind in dieser Umgebung nicht zulässig.',
      );
    }
    await this.db.transaction(async (tx) => {
      for (const category of TAX_CATEGORIES) {
        await tx
          .insert(accountingTaxConfig)
          .values({
            category,
            treatment: 'taxable',
            taxRateBp: SYNTHETIC_TAX_RATE_BP,
            synthetic: true,
            updatedBy: actorId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: accountingTaxConfig.category,
            set: {
              treatment: 'taxable',
              taxRateBp: SYNTHETIC_TAX_RATE_BP,
              synthetic: true,
              updatedBy: actorId,
              updatedAt: now,
            },
          });
      }
    });
    await setStringSetting(this.db, actorId, LEXWARE_TAX_TYPE_SETTING_KEY, 'net');
  }

  /** Testhilfe/Admin: Kategorie entfernen (macht die Konfiguration unvollständig). */
  async removeCategory(category: TaxCategory): Promise<void> {
    await this.db.delete(accountingTaxConfig).where(eq(accountingTaxConfig.category, category));
  }
}
