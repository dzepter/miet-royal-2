'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../../lib/api';
import {
  BILLING_LABELS,
  euro,
  formatBerlin,
  OFFER_STATUS_LABELS,
  parseEuroToCents,
  type OfferVersionRow,
} from '../../../../lib/commerce';

/**
 * Angebots- und AB-Bereich eines Vorgangs (Phase-3-Vorgaben Nr. 40/41):
 * Versionen, Preiszusammenfassung, Rabatte/Sonderpreise je Berechtigung,
 * PDF-Vorschau, Versand über den Phase-3-Adapter, AB-Prüfung/Freigabe.
 */

interface OfferData {
  offer: {
    offer: { id: string; currentVersionId: string | null };
    versions: OfferVersionRow[];
  } | null;
  booking: { id: string; acceptedAt: string; fulfillment: string } | null;
  confirmation: {
    id: string;
    status: string;
    sentAt: string | null;
    documentId: string | null;
  } | null;
}

function statusBadge(status: string) {
  const cls =
    status === 'accepted' || status === 'sent' ? 'active' : status === 'draft' ? '' : 'locked';
  return <span className={`badge ${cls}`}>{OFFER_STATUS_LABELS[status] ?? status}</span>;
}

function OfferView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [data, setData] = useState<OfferData | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publicPath, setPublicPath] = useState<string | null>(null);
  const [discountForm, setDiscountForm] = useState({ type: 'percent', value: '', reason: '' });
  const [specialInputs, setSpecialInputs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const result = await apiFetch<OfferData>(`/staff/processes/${params.id}/offer`);
    if (result.data !== null) {
      setData(result.data);
      if (result.data.confirmation !== null) {
        const readiness = await apiFetch<{ blockers: string[] }>(
          `/staff/processes/${params.id}/confirmation`,
        );
        if (readiness.data !== null) setBlockers(readiness.data.blockers);
      }
    } else {
      setError(result.errorMessage ?? 'Angebot konnte nicht geladen werden.');
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(path: string, body?: unknown, method = 'POST'): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch<Record<string, unknown>>(path, { method, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return false;
    }
    if (typeof result.data?.publicPath === 'string') {
      setPublicPath(result.data.publicPath);
    }
    await load();
    return true;
  }

  if (data === null) {
    return (
      <main className="page">
        {error !== null ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted">Wird geladen …</p>
        )}
      </main>
    );
  }

  const versions = data.offer?.versions ?? [];
  const current =
    versions.find((version) => version.id === data.offer?.offer.currentVersionId) ?? null;
  const isDraft = current?.effectiveStatus === 'draft';
  const isSent = current?.effectiveStatus === 'sent';
  const isAccepted = current?.effectiveStatus === 'accepted';
  const canEditDraft = hasPermission(me, 'offer.edit_draft');

  const commissionMax =
    current?.lineItems
      .filter((item) => item.billingMode === 'commission')
      .reduce((sum, item) => sum + item.totalCents, 0) ?? 0;

  return (
    <main className="page">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang</Link>
      </p>
      <h1>Angebot</h1>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {publicPath !== null && (
        <div className="card">
          <p className="success" style={{ margin: 0 }}>
            Angebot versendet (Test-Outbox). Online-Link für den Kunden:
          </p>
          <p style={{ wordBreak: 'break-all' }}>
            <code data-testid="public-offer-link">{publicPath}</code>
          </p>
        </div>
      )}

      {data.offer === null && (
        <div className="card">
          <p className="muted">Für diesen Vorgang existiert noch kein Angebot.</p>
          {hasPermission(me, 'offer.create') && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(`/staff/processes/${params.id}/offer`)}
            >
              Angebot erstellen (aus Anfrage)
            </button>
          )}
        </div>
      )}

      {current !== null && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Version {current.versionNumber} {statusBadge(current.effectiveStatus)}
          </h2>
          {current.sentAt !== null && (
            <p className="muted">
              Versendet: {formatBerlin(current.sentAt)} · Gültig bis:{' '}
              {formatBerlin(current.expiresAt)}
            </p>
          )}
          {isAccepted && (
            <p className="success">
              Verbindlich angenommen am {formatBerlin(current.acceptedAt)} – Preise und
              Buchungs-Snapshot sind gesperrt.
            </p>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Position</th>
                  <th style={{ textAlign: 'right' }}>Menge</th>
                  <th style={{ textAlign: 'right' }}>Einzelpreis</th>
                  <th style={{ textAlign: 'right' }}>Gesamt</th>
                  <th>Abrechnung</th>
                  {isDraft && hasPermission(me, 'offer.apply_special_price') && (
                    <th>Sonderpreis</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {current.lineItems.map((item) => {
                  const lineKey =
                    item.kind === 'machine'
                      ? 'machine'
                      : item.kind === 'delivery'
                        ? 'delivery'
                        : item.productId !== null
                          ? `extra:${item.productId}`
                          : null;
                  return (
                    <tr key={item.id} style={{ borderTop: '1px solid #eee' }}>
                      <td>
                        {item.description}
                        {item.priceSource === 'special' && (
                          <span className="badge active"> Sonderpreis</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {item.quantity} {item.unit}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {item.billingMode === 'included' ? '–' : euro(item.agreedUnitPriceCents)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {item.billingMode === 'included' ? 'inklusive' : euro(item.totalCents)}
                      </td>
                      <td>{BILLING_LABELS[item.billingMode]}</td>
                      {isDraft && hasPermission(me, 'offer.apply_special_price') && (
                        <td>
                          {item.billingMode !== 'included' &&
                            lineKey !== null &&
                            lineKey !== 'delivery' && (
                              <SpecialPriceCell
                                lineKey={lineKey}
                                item={item}
                                versionId={current.id}
                                busy={busy}
                                specialInputs={specialInputs}
                                setSpecialInputs={setSpecialInputs}
                                run={run}
                              />
                            )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ textAlign: 'right', marginBottom: 0 }}>
            Maschinenmiete: {euro(current.machineSubtotalCents ?? 0)}
            {(current.discountCents ?? 0) > 0 && (
              <>
                {' · '}Rabatt: -{euro(current.discountCents ?? 0)}
                {current.discountReason ? ` (${current.discountReason})` : ''}
              </>
            )}
          </p>
          <p style={{ textAlign: 'right', fontSize: '1.2rem', fontWeight: 700 }}>
            Fester Angebotswert: {euro(current.fixedTotalCents ?? 0)}
          </p>
          {commissionMax > 0 && (
            <p className="muted" style={{ textAlign: 'right' }}>
              Kommissionsartikel (Abrechnung nach tatsächlichem Verbrauch): maximal{' '}
              {euro(commissionMax)}
            </p>
          )}

          <p>
            <a
              href={`/api/staff/offer-versions/${current.id}/pdf-preview`}
              target="_blank"
              rel="noreferrer"
            >
              PDF-Vorschau öffnen
            </a>
          </p>

          {isDraft && canEditDraft && (
            <DraftEditor
              current={current}
              busy={busy}
              run={run}
              canChangePrice={hasPermission(me, 'offer.change_price')}
            />
          )}

          {isDraft && hasPermission(me, 'offer.apply_discount') && (
            <div style={{ borderTop: '1px solid #eee', paddingTop: '0.8rem' }}>
              <h3>Rabatt (auf die Maschinenmiete)</h3>
              <div className="grid-2">
                <div>
                  <label htmlFor="d-type">Art</label>
                  <select
                    id="d-type"
                    value={discountForm.type}
                    onChange={(e) => setDiscountForm({ ...discountForm, type: e.target.value })}
                  >
                    <option value="percent">Prozent</option>
                    <option value="fixed">EUR-Betrag</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="d-value">
                    {discountForm.type === 'percent' ? 'Prozent (z. B. 10)' : 'Betrag (EUR)'}
                  </label>
                  <input
                    id="d-value"
                    value={discountForm.value}
                    onChange={(e) => setDiscountForm({ ...discountForm, value: e.target.value })}
                  />
                </div>
              </div>
              <label htmlFor="d-reason">Interner Grund (Pflicht über 10 %)</label>
              <input
                id="d-reason"
                value={discountForm.reason}
                onChange={(e) => setDiscountForm({ ...discountForm, reason: e.target.value })}
              />
              <p>
                <button
                  disabled={busy}
                  onClick={() => {
                    const value =
                      discountForm.type === 'percent'
                        ? Math.round(Number(discountForm.value.replace(',', '.')) * 100)
                        : parseEuroToCents(discountForm.value);
                    if (value === null || !Number.isFinite(value) || value <= 0) {
                      setError('Bitte einen gültigen Rabattwert angeben.');
                      return;
                    }
                    void run(`/staff/offer-versions/${current.id}/discount`, {
                      discount: {
                        type: discountForm.type,
                        value,
                        reason: discountForm.reason === '' ? null : discountForm.reason,
                      },
                    });
                  }}
                >
                  Rabatt setzen
                </button>{' '}
                {current.discountType !== null && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(`/staff/offer-versions/${current.id}/discount`, { discount: null })
                    }
                  >
                    Rabatt entfernen
                  </button>
                )}{' '}
                {hasPermission(me, 'discount.over_20_approve') &&
                  current.discountType !== null &&
                  current.discountApprovedBy === null && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(`/staff/offer-versions/${current.id}/approve-discount`)
                      }
                    >
                      Rabatt freigeben (&gt;20 %)
                    </button>
                  )}
              </p>
              {current.discountApprovedBy !== null && (
                <p className="success">Rabattfreigabe erteilt.</p>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid #eee', paddingTop: '0.8rem' }}>
            {isDraft && hasPermission(me, 'offer.send') && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(`/staff/offer-versions/${current.id}/send`)}
              >
                Angebot versenden
              </button>
            )}{' '}
            {isSent && hasPermission(me, 'offer.create_new_version') && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(`/staff/offers/${data.offer?.offer.id}/new-version`, {
                    changeNote: null,
                  })
                }
              >
                Neue Version erstellen
              </button>
            )}{' '}
            {(isSent || current.effectiveStatus === 'expired') && canEditDraft && (
              <button
                className="danger"
                disabled={busy}
                onClick={() => void run(`/staff/offer-versions/${current.id}/decline`)}
              >
                Als abgelehnt markieren
              </button>
            )}
            {current.effectiveStatus === 'recheck_requested' &&
              hasPermission(me, 'offer.create_new_version') && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(`/staff/offers/${data.offer?.offer.id}/new-version`, {
                      changeNote: 'Erneute Prüfung nach Ablauf',
                    })
                  }
                >
                  Neue Version nach erneuter Prüfung
                </button>
              )}
          </div>
        </div>
      )}

      {versions.length > 1 && (
        <div className="card">
          <h2>Versionshistorie</h2>
          {versions
            .slice()
            .reverse()
            .map((version) => (
              <div className="list-row" key={version.id}>
                <div>
                  Version {version.versionNumber} {statusBadge(version.effectiveStatus)}
                  <div className="muted">
                    {version.sentAt !== null
                      ? `Versendet ${formatBerlin(version.sentAt)}`
                      : 'Nicht versendet'}
                    {version.changeNote ? ` · ${version.changeNote}` : ''}
                  </div>
                </div>
                <span>{euro(version.fixedTotalCents ?? 0)}</span>
              </div>
            ))}
        </div>
      )}

      {data.booking !== null && (
        <div className="card">
          <h2>Auftragsbestätigung</h2>
          <p className="muted">
            Buchung verbindlich seit {formatBerlin(data.booking.acceptedAt)} (
            {data.booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung'}).
          </p>
          {data.confirmation !== null && (
            <>
              <p>
                Status:{' '}
                <span className="badge active">
                  {data.confirmation.status === 'prepared'
                    ? 'Vorbereitet'
                    : data.confirmation.status === 'approved'
                      ? 'Freigegeben'
                      : 'Versendet'}
                </span>
              </p>
              {blockers.map((blocker) => (
                <p className="error" key={blocker}>
                  {blocker}
                </p>
              ))}
              <p>
                <a
                  href={`/api/staff/order-confirmations/${data.confirmation.id}/pdf-preview`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Auftragsbestätigung ansehen (PDF-Vorschau)
                </a>
                {data.confirmation.documentId !== null && (
                  <>
                    {' · '}
                    <a
                      href={`/api/staff/documents/${data.confirmation.documentId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Finale AB (PDF)
                    </a>
                  </>
                )}
              </p>
              {data.confirmation.status === 'prepared' && hasPermission(me, 'booking.confirm') && (
                <button
                  className="primary"
                  disabled={busy || blockers.length > 0}
                  onClick={() =>
                    void run(`/staff/order-confirmations/${data.confirmation?.id}/approve`)
                  }
                >
                  Auftragsbestätigung freigeben
                </button>
              )}
              {data.confirmation.status === 'approved' && hasPermission(me, 'booking.confirm') && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(`/staff/order-confirmations/${data.confirmation?.id}/send`)
                  }
                >
                  Auftragsbestätigung versenden
                </button>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

function SpecialPriceCell({
  lineKey,
  item,
  versionId,
  busy,
  specialInputs,
  setSpecialInputs,
  run,
}: {
  lineKey: string;
  item: { id: string; priceSource: string };
  versionId: string;
  busy: boolean;
  specialInputs: Record<string, string>;
  setSpecialInputs: (value: Record<string, string>) => void;
  run: (path: string, body?: unknown, method?: string) => Promise<boolean>;
}) {
  const key = lineKey;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <input
        aria-label="Sonderpreis (EUR)"
        style={{ width: '6rem' }}
        value={specialInputs[key] ?? ''}
        onChange={(e) => setSpecialInputs({ ...specialInputs, [key]: e.target.value })}
        placeholder="EUR"
      />{' '}
      <button
        disabled={busy}
        onClick={() => {
          const cents = parseEuroToCents(specialInputs[key] ?? '');
          if (cents === null) return;
          void run(`/staff/offer-versions/${versionId}/special-price`, {
            lineKey: key,
            unitPriceCents: cents,
          });
        }}
      >
        Setzen
      </button>
      {item.priceSource === 'special' && (
        <button
          disabled={busy}
          onClick={() =>
            void run(`/staff/offer-versions/${versionId}/special-price`, {
              lineKey: key,
              unitPriceCents: null,
            })
          }
        >
          Zurücksetzen
        </button>
      )}
    </span>
  );
}

function DraftEditor({
  current,
  busy,
  run,
  canChangePrice,
}: {
  current: OfferVersionRow;
  busy: boolean;
  run: (path: string, body?: unknown, method?: string) => Promise<boolean>;
  canChangePrice: boolean;
}) {
  const [deliveryPrice, setDeliveryPrice] = useState(
    current.deliveryPriceCents === null ? '' : String(current.deliveryPriceCents / 100),
  );
  return (
    <div style={{ borderTop: '1px solid #eee', paddingTop: '0.8rem' }}>
      <h3>Entwurf</h3>
      <p className="muted">
        Maschine, Sirup und Extras kommen aus der Anfrage: dort ändern und anschließend über „Neu
        aus der Anfrage übernehmen“ in diesen Entwurf holen. Der Lieferpreis wird manuell festgelegt
        („Lieferpreis individuell geprüft“).
      </p>
      <p>
        <button
          disabled={busy}
          onClick={() => void run(`/staff/offer-versions/${current.id}/sync-from-inquiry`)}
        >
          Neu aus der Anfrage übernehmen
        </button>
      </p>
      {current.fulfillment === 'delivery' && canChangePrice && (
        <div className="grid-2">
          <div>
            <label htmlFor="dp">Lieferpreis (EUR, individuell geprüft)</label>
            <input
              id="dp"
              value={deliveryPrice}
              onChange={(e) => setDeliveryPrice(e.target.value)}
              placeholder="z. B. 49,00"
            />
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button
              disabled={busy}
              onClick={() => {
                const cents = parseEuroToCents(deliveryPrice);
                void run(
                  `/staff/offer-versions/${current.id}`,
                  { deliveryPriceCents: cents },
                  'PATCH',
                );
              }}
            >
              Lieferpreis speichern
            </button>
          </div>
        </div>
      )}
      <p>
        <button
          disabled={busy}
          onClick={() => void run(`/staff/offer-versions/${current.id}`, {}, 'PATCH')}
        >
          Neu berechnen
        </button>
      </p>
    </div>
  );
}

export default function OfferPage() {
  return (
    <AuthGuard>
      <OfferView />
    </AuthGuard>
  );
}
