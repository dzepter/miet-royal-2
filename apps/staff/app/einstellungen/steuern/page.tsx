'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/handover';
import {
  applySyntheticTax,
  basisPointsToInput,
  fetchLexwareStatus,
  fetchTaxConfig,
  parsePercentInput,
  saveTaxConfig,
  TAX_CATEGORIES,
  TAX_CATEGORY_LABELS,
  TAX_CONFIG_HINT,
  TAX_TREATMENT_LABELS,
  TAX_TYPE_LABELS,
  type LexwareTaxType,
  type TaxCategory,
  type TaxConfig,
  type TaxTreatment,
} from '../../../lib/lexware';

/**
 * Phase 10 (Order §§13, 62): Steuerkonfiguration für die Lexware-Übertragung.
 * Die UI pflegt nur Werte – keine Steuerlogik, keine Defaults, keine
 * Rechtsberatung. Vollständigkeit und Plausibilität entscheidet der Server.
 * Synthetische Testwerte gibt es ausschließlich außerhalb von Production.
 */

interface RowDraft {
  treatment: TaxTreatment;
  rate: string;
  synthetic: boolean;
  updatedAt: string | null;
  present: boolean;
}

type Drafts = Record<TaxCategory, RowDraft>;

function emptyDrafts(): Drafts {
  const drafts = {} as Drafts;
  for (const category of TAX_CATEGORIES) {
    drafts[category] = {
      treatment: 'taxable',
      rate: '',
      synthetic: false,
      updatedAt: null,
      present: false,
    };
  }
  return drafts;
}

function draftsFrom(config: TaxConfig): Drafts {
  const drafts = emptyDrafts();
  for (const row of config.categories) {
    if (!(TAX_CATEGORIES as string[]).includes(row.category)) continue;
    const category = row.category as TaxCategory;
    drafts[category] = {
      treatment: row.treatment === 'vatfree' ? 'vatfree' : 'taxable',
      rate: basisPointsToInput(row.taxRateBp),
      synthetic: row.synthetic === true,
      updatedAt: row.updatedAt ?? null,
      present: true,
    };
  }
  return drafts;
}

function TaxConfigView() {
  const me = useMe();
  const [config, setConfig] = useState<TaxConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [taxType, setTaxType] = useState<LexwareTaxType | ''>('');
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSynthetic, setConfirmSynthetic] = useState(false);

  const apply = useCallback((next: TaxConfig) => {
    setConfig(next);
    setTaxType(next.taxType ?? '');
    setDrafts(draftsFrom(next));
  }, []);

  const load = useCallback(async () => {
    const result = await fetchTaxConfig();
    if (result.data !== null) apply(result.data);
    else setError(result.errorMessage ?? 'Steuerkonfiguration konnte nicht geladen werden.');
    setLoaded(true);
  }, [apply]);

  useEffect(() => {
    void load();
    void fetchLexwareStatus().then((result) => {
      if (result.data !== null) setEnvironment(result.data.environment);
    });
  }, [load]);

  const canManage = hasPermission(me, 'system.settings');
  const effectiveEnvironment = environment ?? me?.environment ?? null;
  const syntheticAllowed =
    config?.syntheticAllowed !== undefined
      ? config.syntheticAllowed
      : effectiveEnvironment !== null && effectiveEnvironment !== 'production';
  const anySynthetic =
    config?.synthetic === true || TAX_CATEGORIES.some((c) => drafts[c].synthetic);

  function updateRow(category: TaxCategory, patch: Partial<RowDraft>): void {
    setDrafts((prev) => ({ ...prev, [category]: { ...prev[category], ...patch } }));
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (taxType === '') {
      setError('Bitte die Steuerart wählen.');
      return;
    }
    const categories: { category: string; treatment: TaxTreatment; taxRateBp: number }[] = [];
    for (const category of TAX_CATEGORIES) {
      const row = drafts[category];
      if (row.treatment === 'vatfree') {
        categories.push({ category, treatment: 'vatfree', taxRateBp: 0 });
        continue;
      }
      const bp = parsePercentInput(row.rate);
      if (bp === null) {
        setError(
          `Bitte für „${TAX_CATEGORY_LABELS[category]}“ einen Steuersatz in Prozent mit höchstens zwei Dezimalstellen eingeben (z. B. 19,00).`,
        );
        return;
      }
      categories.push({ category, treatment: 'taxable', taxRateBp: bp });
    }
    setBusy(true);
    const result = await saveTaxConfig({ taxType, categories });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    apply(result.data);
    setNotice('Gespeichert. Die Werte gelten nur für künftige Übertragungen.');
  }

  async function runSynthetic(): Promise<void> {
    setConfirmSynthetic(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await applySyntheticTax();
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Synthetische Testwerte konnten nicht gesetzt werden.');
      return;
    }
    apply(result.data);
    setNotice(
      'Synthetische Testwerte gesetzt – nur für Test/Entwicklung, keine Produktionsdefaults.',
    );
  }

  return (
    <main className="page" data-testid="tax-config-page">
      <p>
        <Link href="/einstellungen">← Einstellungen</Link>
      </p>
      <h1>
        Steuerkonfiguration (Lexware){' '}
        {anySynthetic && (
          <span className="badge locked" data-testid="tax-synthetic-badge">
            SYNTHETISCH
          </span>
        )}
      </h1>
      <div className="card">
        <p className="muted" data-testid="tax-hint">
          {config?.hint !== undefined && config.hint !== '' ? config.hint : TAX_CONFIG_HINT}
        </p>
        <p className="muted">
          Hier wird festgelegt, wie Positionen der Abrechnung an Lexware übergeben werden. Es werden
          keine Steuersätze vorbelegt. Änderungen wirken nur auf künftige Übertragungen – bereits
          erstellte Rechnungen bleiben unverändert.
        </p>
        {!canManage && (
          <p className="error">Zum Bearbeiten ist das Recht „Systemeinstellungen“ erforderlich.</p>
        )}
        {error !== null && <p className="error">{error}</p>}
        {notice !== null && <p className="success">{notice}</p>}
        {!loaded && <p className="muted">Lade …</p>}
        {loaded && (
          <p>
            Vollständigkeit:{' '}
            <span
              className={`badge ${config?.complete === true ? 'ok' : 'locked'}`}
              data-testid="tax-complete"
            >
              {config?.complete === true ? 'Vollständig' : 'Unvollständig'}
            </span>
            {config !== null && config.complete !== true && (config.missing?.length ?? 0) > 0 && (
              <span className="muted">
                {' '}
                – fehlt:{' '}
                {config.missing
                  ?.map((key) => TAX_CATEGORY_LABELS[key as TaxCategory] ?? key)
                  .join(', ')}
              </span>
            )}
          </p>
        )}
        <form onSubmit={(e) => void save(e)}>
          <label htmlFor="tax-type">Steuerart (Lexware taxType)</label>
          <select
            id="tax-type"
            data-testid="tax-type"
            value={taxType}
            disabled={busy || !canManage}
            onChange={(e) => setTaxType(e.target.value as LexwareTaxType | '')}
          >
            <option value="">– bitte wählen –</option>
            {(Object.keys(TAX_TYPE_LABELS) as LexwareTaxType[]).map((key) => (
              <option key={key} value={key}>
                {TAX_TYPE_LABELS[key]}
              </option>
            ))}
          </select>
          <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Kategorie</th>
                  <th>Behandlung</th>
                  <th>Satz in %</th>
                  <th>Stand</th>
                </tr>
              </thead>
              <tbody>
                {TAX_CATEGORIES.map((category) => {
                  const row = drafts[category];
                  return (
                    <tr
                      key={category}
                      data-testid={`tax-row-${category}`}
                      style={{ borderTop: '1px solid #eee' }}
                    >
                      <td style={{ padding: '0.4rem 0.25rem' }}>
                        <label htmlFor={`tax-treatment-${category}`} style={{ margin: 0 }}>
                          {TAX_CATEGORY_LABELS[category]}
                        </label>
                        {row.synthetic && <span className="badge locked"> SYNTHETISCH</span>}
                      </td>
                      <td style={{ padding: '0.4rem 0.25rem', minWidth: '10rem' }}>
                        <select
                          id={`tax-treatment-${category}`}
                          data-testid={`tax-treatment-${category}`}
                          value={row.treatment}
                          disabled={busy || !canManage}
                          onChange={(e) =>
                            updateRow(category, {
                              treatment: e.target.value as TaxTreatment,
                              rate: e.target.value === 'vatfree' ? '0,00' : row.rate,
                            })
                          }
                        >
                          {(Object.keys(TAX_TREATMENT_LABELS) as TaxTreatment[]).map((key) => (
                            <option key={key} value={key}>
                              {TAX_TREATMENT_LABELS[key]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: '0.4rem 0.25rem', minWidth: '7rem' }}>
                        <input
                          id={`tax-rate-${category}`}
                          data-testid={`tax-rate-${category}`}
                          aria-label={`Steuersatz ${TAX_CATEGORY_LABELS[category]} in Prozent`}
                          inputMode="decimal"
                          placeholder="z. B. 19,00"
                          value={row.rate}
                          disabled={busy || !canManage || row.treatment === 'vatfree'}
                          onChange={(e) => updateRow(category, { rate: e.target.value })}
                        />
                      </td>
                      <td className="muted" style={{ padding: '0.4rem 0.25rem' }}>
                        {row.present ? formatBerlin(row.updatedAt) : 'nicht konfiguriert'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p>
            <button
              className="primary"
              type="submit"
              data-testid="tax-save"
              disabled={busy || !canManage || !loaded}
            >
              Speichern
            </button>{' '}
            {syntheticAllowed && canManage && (
              <button
                type="button"
                data-testid="tax-apply-synthetic"
                disabled={busy || !loaded}
                onClick={() => setConfirmSynthetic(true)}
              >
                Synthetische Testwerte setzen
              </button>
            )}
          </p>
        </form>
      </div>
      {confirmSynthetic && (
        <ConfirmDialog
          testId="tax-synthetic-dialog"
          title="Synthetische Testwerte setzen?"
          confirmLabel="Testwerte setzen"
          confirmTestId="tax-synthetic-confirm"
          busy={busy}
          onCancel={() => setConfirmSynthetic(false)}
          onConfirm={() => void runSynthetic()}
        >
          <p>
            Alle Kategorien werden mit klar als SYNTHETISCH markierten Testwerten überschrieben. Nur
            für Test und Entwicklung – in Production nicht verfügbar.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function TaxConfigPage() {
  return (
    <AuthGuard>
      <TaxConfigView />
    </AuthGuard>
  );
}
