'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../../lib/api';
import {
  percentLabel,
  STOCKTAKE_STATUS_LABELS,
  type StocktakeRow,
} from '../../../../lib/warehouse';

/**
 * Inventurdetail (Order §§34–37): Systembestand, Ist, absolute und
 * prozentuale Differenz; bei Differenz „Freigabe erforderlich“ – der
 * Bestand ändert sich ERST mit der Freigabe (genau eine Bewegung je
 * Artikel). Vor der Freigabe darf der Zählwert korrigiert werden.
 */
function StocktakeView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [stocktake, setStocktake] = useState<StocktakeRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const canApprove = hasPermission(me, 'inventory.approve_adjustment');

  const load = useCallback(async () => {
    const result = await apiFetch<{ stocktake: StocktakeRow }>(
      `/staff/inventory/stocktakes/${params.id}`,
    );
    if (result.data !== null) {
      setStocktake(result.data.stocktake);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Inventur konnte nicht geladen werden.');
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page">
      <p>
        <Link href="/lager">← Lager</Link>
      </p>
      <h1>Inventur</h1>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {stocktake === null ? (
        <p className="muted">Lade …</p>
      ) : (
        <>
          <p>
            <span className="badge">{STOCKTAKE_STATUS_LABELS[stocktake.status]}</span>{' '}
            <span className="muted">
              erfasst{' '}
              {new Date(stocktake.createdAt).toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
              })}
              {stocktake.createdByName !== null ? ` von ${stocktake.createdByName}` : ''}
            </span>
          </p>
          <div className="card">
            {stocktake.items.map((item) => (
              <div className="list-row" key={item.itemId} style={{ alignItems: 'flex-start' }}>
                <div>
                  <strong>{item.productName}</strong>
                  <div className="muted">
                    Systembestand:{' '}
                    {item.systemStock === null
                      ? 'Noch nicht initial erfasst'
                      : `${item.systemStock} × ${item.saleUnit}`}
                    <br />
                    Gezählt (Ist): {item.countedStock} × {item.saleUnit}
                    <br />
                    Differenz:{' '}
                    {item.absoluteDifference === null
                      ? 'Anfangsbestand (keine Vergleichsbasis)'
                      : `${item.absoluteDifference > 0 ? '+' : ''}${item.absoluteDifference} (${percentLabel(item.percentDifference)})`}
                  </div>
                </div>
                {stocktake.status === 'pending_approval' && canApprove && (
                  <div>
                    <input
                      aria-label={`Zählwert korrigieren ${item.productName}`}
                      type="number"
                      min={0}
                      style={{ width: '6rem' }}
                      placeholder={String(item.countedStock)}
                      value={corrections[item.itemId] ?? ''}
                      onChange={(event) =>
                        setCorrections({ ...corrections, [item.itemId]: event.target.value })
                      }
                    />{' '}
                    <button
                      disabled={busy || (corrections[item.itemId] ?? '') === ''}
                      onClick={() => {
                        setBusy(true);
                        void apiFetch(
                          `/staff/inventory/stocktakes/${stocktake.id}/items/${item.itemId}`,
                          {
                            method: 'PATCH',
                            body: { countedStock: Number(corrections[item.itemId]) },
                          },
                        ).then(async (result) => {
                          setBusy(false);
                          if (!result.ok) {
                            setError(result.errorMessage ?? 'Korrektur fehlgeschlagen.');
                            return;
                          }
                          setCorrections({ ...corrections, [item.itemId]: '' });
                          setNotice('Zählwert korrigiert.');
                          await load();
                        });
                      }}
                    >
                      Zählwert korrigieren
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {stocktake.status === 'pending_approval' && (
            <div className="card">
              {canApprove ? (
                <p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void apiFetch(`/staff/inventory/stocktakes/${stocktake.id}/approve`, {
                        method: 'POST',
                      }).then(async (result) => {
                        setBusy(false);
                        if (!result.ok) {
                          setError(result.errorMessage ?? 'Freigabe fehlgeschlagen.');
                          return;
                        }
                        setNotice('Inventur freigegeben – Bestand wurde angepasst.');
                        await load();
                      });
                    }}
                  >
                    Bestandskorrektur freigeben
                  </button>
                </p>
              ) : (
                <p className="muted">
                  Freigabe erforderlich: Eine berechtigte Person muss die Bestandskorrektur
                  freigeben.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

export default function StocktakePage() {
  return (
    <AuthGuard>
      <StocktakeView />
    </AuthGuard>
  );
}
