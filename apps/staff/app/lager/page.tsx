'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import {
  STOCKTAKE_STATUS_LABELS,
  stockLabel,
  type InventoryItemRow,
  type StocktakeRow,
} from '../../lib/warehouse';

/**
 * Lager (Order §§25–36): Bestände in echten Lagereinheiten, ehrliches
 * „Noch nicht initial erfasst“, Wareneingang als HINZUGEFÜGTE Menge,
 * Mindestbestände, Anfangsbestand/Inventur mit Freigabe-Workflow.
 * Verkaufspreise bleiben im Produkte-Modul (Order §39).
 */
function InventoryView() {
  const me = useMe();
  const [items, setItems] = useState<InventoryItemRow[] | null>(null);
  const [stocktakes, setStocktakes] = useState<StocktakeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [minStockInput, setMinStockInput] = useState<Record<string, string>>({});
  const [countInput, setCountInput] = useState<Record<string, string>>({});
  const [fullCountMode, setFullCountMode] = useState(false);

  const canReceive = hasPermission(me, 'inventory.add_stock');
  const canMinStock = hasPermission(me, 'inventory.manage_min_stock');
  const canCount = hasPermission(me, 'inventory.count');
  const canMovements = hasPermission(me, 'inventory.view_movement_history');

  const load = useCallback(async () => {
    const result = await apiFetch<{ items: InventoryItemRow[] }>('/staff/inventory');
    if (result.data !== null) {
      setItems(result.data.items);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Lager konnte nicht geladen werden.');
    }
    if (hasPermission(me, 'inventory.count')) {
      const takes = await apiFetch<{ stocktakes: StocktakeRow[] }>('/staff/inventory/stocktakes');
      if (takes.data !== null) setStocktakes(takes.data.stocktakes);
    }
  }, [me]);
  useEffect(() => {
    void load();
  }, [load]);

  async function startStocktake(entries: { itemId: string; countedStock: number }[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch<{ stocktake: StocktakeRow }>('/staff/inventory/stocktakes', {
      method: 'POST',
      body: { entries },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Inventur konnte nicht gespeichert werden.');
      return;
    }
    const stocktake = result.data.stocktake;
    setCountInput({});
    setFullCountMode(false);
    if (stocktake.status === 'completed') {
      setNotice('Inventur ohne Differenz abgeschlossen – keine Korrektur nötig.');
      await load();
    } else {
      window.location.href = `/lager/inventur/${stocktake.id}`;
    }
  }

  const lowCount = (items ?? []).filter((item) => item.lowStock).length;
  const pending = stocktakes.filter((row) => row.status === 'pending_approval');

  return (
    <main className="page">
      <h1>Lager</h1>
      <p className="muted">
        Maschinen &amp; Lager · <Link href="/maschinen">Zu den Maschinen</Link>
        {canMovements && (
          <>
            {' '}
            · <Link href="/lager/bewegungen">Bewegungshistorie</Link>
          </>
        )}
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {lowCount > 0 && (
        <div className="conflict-box" data-testid="low-stock-warning">
          <strong>Lagerbestand niedrig: {lowCount} Artikel</strong>
        </div>
      )}
      {pending.length > 0 && (
        <div className="card">
          <h2>Inventuren mit ausstehender Freigabe</h2>
          {pending.map((row) => (
            <p key={row.id}>
              <Link href={`/lager/inventur/${row.id}`}>
                Inventur vom{' '}
                {new Date(row.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
              </Link>{' '}
              <span className="badge">{STOCKTAKE_STATUS_LABELS[row.status]}</span>
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <div className="list-row">
          <h2 style={{ margin: 0 }}>Artikel</h2>
          {canCount && (
            <span>
              {fullCountMode ? (
                <>
                  <button
                    disabled={
                      busy ||
                      // Deaktivierte Artikel sind historisch – die
                      // Komplettinventur zählt nur aktive Artikel.
                      (items ?? [])
                        .filter((item) => item.productActive)
                        .some(
                          (item) =>
                            countInput[item.itemId] === undefined || countInput[item.itemId] === '',
                        )
                    }
                    onClick={() =>
                      void startStocktake(
                        (items ?? [])
                          .filter((item) => item.productActive)
                          .map((item) => ({
                            itemId: item.itemId,
                            countedStock: Number(countInput[item.itemId]),
                          })),
                      )
                    }
                  >
                    Komplettinventur speichern
                  </button>{' '}
                  <button onClick={() => setFullCountMode(false)}>Abbrechen</button>
                </>
              ) : (
                <button onClick={() => setFullCountMode(true)}>Komplette Lagerinventur</button>
              )}
            </span>
          )}
        </div>
        {items === null && <p className="muted">Lade …</p>}
        {(items ?? []).map((item) => (
          <div
            className="list-row"
            key={item.itemId}
            data-testid={`inventory-${item.productSlug}`}
            style={{ alignItems: 'flex-start' }}
          >
            <div>
              <strong>{item.productName}</strong>
              {!item.productActive && <span className="badge locked"> Deaktiviert</span>}
              <div className="muted">
                Bestand: {stockLabel(item)}
                {' · '}
                Mindestbestand:{' '}
                {item.minStock === null
                  ? 'nicht festgelegt'
                  : `${item.minStock} × ${item.saleUnit}`}
              </div>
              {item.lowStock && <span className="badge locked">Unter Mindestbestand</span>}
            </div>
            <div style={{ textAlign: 'right' }}>
              {canReceive && item.currentStock !== null && item.productActive && (
                <p style={{ margin: '0.2rem 0' }}>
                  <input
                    aria-label={`Menge hinzufügen ${item.productName}`}
                    type="number"
                    min={1}
                    style={{ width: '6rem' }}
                    placeholder="+ Menge"
                    value={receiveQty[item.itemId] ?? ''}
                    onChange={(event) =>
                      setReceiveQty({ ...receiveQty, [item.itemId]: event.target.value })
                    }
                  />{' '}
                  <button
                    disabled={busy || (receiveQty[item.itemId] ?? '') === ''}
                    onClick={() => {
                      setBusy(true);
                      void apiFetch(`/staff/inventory/${item.itemId}/receive`, {
                        method: 'POST',
                        body: { addedQuantity: Number(receiveQty[item.itemId]) },
                      }).then(async (result) => {
                        setBusy(false);
                        if (!result.ok) {
                          setError(result.errorMessage ?? 'Wareneingang fehlgeschlagen.');
                          return;
                        }
                        setReceiveQty({ ...receiveQty, [item.itemId]: '' });
                        setNotice('Wareneingang gebucht.');
                        await load();
                      });
                    }}
                  >
                    Menge hinzufügen
                  </button>
                </p>
              )}
              {canMinStock && item.productActive && (
                <p style={{ margin: '0.2rem 0' }}>
                  <input
                    aria-label={`Mindestbestand ${item.productName}`}
                    type="number"
                    min={0}
                    style={{ width: '6rem' }}
                    placeholder="Minimum"
                    value={minStockInput[item.itemId] ?? ''}
                    onChange={(event) =>
                      setMinStockInput({ ...minStockInput, [item.itemId]: event.target.value })
                    }
                  />{' '}
                  <button
                    disabled={busy || (minStockInput[item.itemId] ?? '') === ''}
                    onClick={() => {
                      setBusy(true);
                      void apiFetch(`/staff/inventory/${item.itemId}/min-stock`, {
                        method: 'PUT',
                        body: { minStock: Number(minStockInput[item.itemId]) },
                      }).then(async (result) => {
                        setBusy(false);
                        if (!result.ok) {
                          setError(result.errorMessage ?? 'Mindestbestand fehlgeschlagen.');
                          return;
                        }
                        setMinStockInput({ ...minStockInput, [item.itemId]: '' });
                        await load();
                      });
                    }}
                  >
                    Mindestbestand setzen
                  </button>
                </p>
              )}
              {canCount && item.productActive && !fullCountMode && item.currentStock === null && (
                <p style={{ margin: '0.2rem 0' }}>
                  <input
                    aria-label={`Anfangsbestand ${item.productName}`}
                    type="number"
                    min={0}
                    style={{ width: '6rem' }}
                    placeholder="Gezählt"
                    value={countInput[item.itemId] ?? ''}
                    onChange={(event) =>
                      setCountInput({ ...countInput, [item.itemId]: event.target.value })
                    }
                  />{' '}
                  <button
                    disabled={busy || (countInput[item.itemId] ?? '') === ''}
                    onClick={() =>
                      void startStocktake([
                        { itemId: item.itemId, countedStock: Number(countInput[item.itemId]) },
                      ])
                    }
                  >
                    Anfangsbestand erfassen
                  </button>
                </p>
              )}
              {canCount && item.productActive && !fullCountMode && item.currentStock !== null && (
                <p style={{ margin: '0.2rem 0' }}>
                  <input
                    aria-label={`Inventur ${item.productName}`}
                    type="number"
                    min={0}
                    style={{ width: '6rem' }}
                    placeholder="Gezählt"
                    value={countInput[item.itemId] ?? ''}
                    onChange={(event) =>
                      setCountInput({ ...countInput, [item.itemId]: event.target.value })
                    }
                  />{' '}
                  <button
                    disabled={busy || (countInput[item.itemId] ?? '') === ''}
                    onClick={() =>
                      void startStocktake([
                        { itemId: item.itemId, countedStock: Number(countInput[item.itemId]) },
                      ])
                    }
                  >
                    Artikel-Inventur
                  </button>
                </p>
              )}
              {canCount && item.productActive && fullCountMode && (
                <p style={{ margin: '0.2rem 0' }}>
                  <input
                    aria-label={`Zählung ${item.productName}`}
                    type="number"
                    min={0}
                    style={{ width: '6rem' }}
                    placeholder="Gezählt"
                    value={countInput[item.itemId] ?? ''}
                    onChange={(event) =>
                      setCountInput({ ...countInput, [item.itemId]: event.target.value })
                    }
                  />
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function InventoryPage() {
  return (
    <AuthGuard>
      <InventoryView />
    </AuthGuard>
  );
}
