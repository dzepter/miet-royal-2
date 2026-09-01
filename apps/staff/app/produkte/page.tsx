'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';
import {
  berlinMidnightIso,
  BILLING_LABELS,
  CATEGORY_LABELS,
  euro,
  parseEuroToCents,
  type ProductRow,
} from '../../lib/commerce';

function PriceEditor({
  product,
  onChanged,
  setError,
}: {
  product: ProductRow;
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [price, setPrice] = useState('');
  const [futurePrice, setFuturePrice] = useState('');
  const [futureDate, setFutureDate] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const result = await apiFetch(path, { method, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return false;
    }
    await onChanged();
    return true;
  }

  return (
    <div>
      <div className="grid-2">
        <div>
          <label htmlFor={`p-price-${product.id}`}>Neuer Preis (EUR, sofort wirksam)</label>
          <input
            id={`p-price-${product.id}`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="z. B. 80,00"
          />
          <button
            disabled={busy || parseEuroToCents(price) === null}
            onClick={() => {
              const cents = parseEuroToCents(price);
              if (cents === null) return;
              void run(`/staff/products/${product.id}/price`, 'POST', { priceCents: cents }).then(
                (ok) => ok && setPrice(''),
              );
            }}
          >
            Preis ändern
          </button>
        </div>
        <div>
          <label htmlFor={`p-fprice-${product.id}`}>Zukünftiger Preis (EUR) + Stichtag</label>
          <input
            id={`p-fprice-${product.id}`}
            value={futurePrice}
            onChange={(e) => setFuturePrice(e.target.value)}
            placeholder="z. B. 85,00"
          />
          <input
            aria-label="Wirksam ab"
            type="date"
            value={futureDate}
            onChange={(e) => setFutureDate(e.target.value)}
          />
          <button
            disabled={busy || parseEuroToCents(futurePrice) === null || futureDate === ''}
            onClick={() => {
              const cents = parseEuroToCents(futurePrice);
              if (cents === null) return;
              void run(`/staff/products/${product.id}/future-price`, 'POST', {
                priceCents: cents,
                // Stichtag = Mitternacht Europe/Berlin (DST-fest, kein fester Offset).
                effectiveFrom: berlinMidnightIso(futureDate),
              }).then((ok) => {
                if (ok) {
                  setFuturePrice('');
                  setFutureDate('');
                }
              });
            }}
          >
            Zukünftigen Preis planen
          </button>
        </div>
      </div>
      {product.futurePrices.length > 0 && (
        <div>
          <p className="muted">Geplante Preise (bis zur Wirksamkeit änder-/löschbar):</p>
          {product.futurePrices.map((row) => (
            <PlannedPriceRow key={row.id} row={row} busy={busy} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Geplanter Preis: ändern (Betrag/Stichtag) oder löschen – §38. */
function PlannedPriceRow({
  row,
  busy,
  run,
}: {
  row: { id: string; priceCents: number; effectiveFrom: string };
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  return (
    <div className="list-row">
      <span>
        {euro(row.priceCents)} ab{' '}
        {new Date(row.effectiveFrom).toLocaleDateString('de-DE', {
          timeZone: 'Europe/Berlin',
        })}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>
        <input
          aria-label="Neuer geplanter Preis (EUR)"
          style={{ width: '6rem' }}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="EUR"
        />{' '}
        <button
          disabled={busy || parseEuroToCents(price) === null}
          onClick={() => {
            const cents = parseEuroToCents(price);
            if (cents === null) return;
            void run(`/staff/product-prices/${row.id}`, 'PATCH', { priceCents: cents }).then(
              (ok) => ok && setPrice(''),
            );
          }}
        >
          Preis ändern
        </button>{' '}
        <input
          aria-label="Neuer Stichtag"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />{' '}
        <button
          disabled={busy || date === ''}
          onClick={() =>
            void run(`/staff/product-prices/${row.id}`, 'PATCH', {
              effectiveFrom: berlinMidnightIso(date),
            }).then((ok) => ok && setDate(''))
          }
        >
          Stichtag ändern
        </button>{' '}
        <button
          className="danger"
          disabled={busy}
          onClick={() => void run(`/staff/product-prices/${row.id}`, 'DELETE')}
        >
          Löschen
        </button>
      </span>
    </div>
  );
}

/** Produktdaten bearbeiten (§38: bearbeiten + Metadaten wie Gewicht pflegen). */
function ProductEditor({
  product,
  onChanged,
  setError,
}: {
  product: ProductRow;
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: product.name,
    description: product.description ?? '',
    saleUnit: product.saleUnit,
    sortOrder: String(product.sortOrder),
    weightGrams: product.weightGrams === null ? '' : String(product.weightGrams),
    carryPersons: product.carryPersons === null ? '' : String(product.carryPersons),
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const result = await apiFetch(`/staff/products/${product.id}`, {
      method: 'PATCH',
      body: {
        name: form.name,
        description: form.description === '' ? undefined : form.description,
        saleUnit: form.saleUnit,
        ...(form.sortOrder === '' ? {} : { sortOrder: Number(form.sortOrder) }),
        ...(form.weightGrams === '' ? {} : { weightGrams: Number(form.weightGrams) }),
        ...(form.carryPersons === '' ? {} : { carryPersons: Number(form.carryPersons) }),
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    await onChanged();
  }

  return (
    <div style={{ borderTop: '1px dashed #ddd', paddingTop: '0.6rem' }}>
      <div className="grid-2">
        <div>
          <label htmlFor={`pe-name-${product.id}`}>Anzeigename</label>
          <input
            id={`pe-name-${product.id}`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`pe-unit-${product.id}`}>Verkaufseinheit</label>
          <input
            id={`pe-unit-${product.id}`}
            value={form.saleUnit}
            onChange={(e) => setForm({ ...form, saleUnit: e.target.value })}
          />
        </div>
      </div>
      <label htmlFor={`pe-desc-${product.id}`}>Beschreibung</label>
      <input
        id={`pe-desc-${product.id}`}
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <div className="grid-2">
        <div>
          <label htmlFor={`pe-sort-${product.id}`}>Sortierung</label>
          <input
            id={`pe-sort-${product.id}`}
            type="number"
            min={0}
            value={form.sortOrder}
            onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`pe-weight-${product.id}`}>Gewicht (Gramm, optional)</label>
          <input
            id={`pe-weight-${product.id}`}
            type="number"
            min={1}
            value={form.weightGrams}
            onChange={(e) => setForm({ ...form, weightGrams: e.target.value })}
            placeholder="nur eintragen, wenn bekannt"
          />
        </div>
      </div>
      {product.category === 'machine' && (
        <div>
          <label htmlFor={`pe-carry-${product.id}`}>Tragepersonen</label>
          <input
            id={`pe-carry-${product.id}`}
            type="number"
            min={1}
            value={form.carryPersons}
            onChange={(e) => setForm({ ...form, carryPersons: e.target.value })}
          />
        </div>
      )}
      <p>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Produkt speichern
        </button>
      </p>
    </div>
  );
}

function ProductsView() {
  const me = useMe();
  const [productsList, setProductsList] = useState<ProductRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState({
    slug: '',
    name: '',
    category: 'machine',
    saleUnit: 'Stück',
    price: '',
    containerCount: '',
    containerVolumeLiters: '',
  });

  const load = useCallback(async () => {
    const result = await apiFetch<{ products: ProductRow[] }>('/staff/products');
    if (result.data !== null) setProductsList(result.data.products);
    else setError(result.errorMessage ?? 'Produkte konnten nicht geladen werden.');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const canManage = hasPermission(me, 'product.manage');
  const canPrice = hasPermission(me, 'price.manage');

  async function createProduct() {
    const cents = parseEuroToCents(create.price);
    if (cents === null) {
      setError('Bitte einen gültigen Preis angeben.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiFetch('/staff/products', {
      method: 'POST',
      body: {
        slug: create.slug,
        name: create.name,
        category: create.category,
        saleUnit: create.saleUnit,
        initialPriceCents: cents,
        ...(create.category === 'machine' && create.containerCount !== ''
          ? { containerCount: Number(create.containerCount) }
          : {}),
        ...(create.category === 'machine' && create.containerVolumeLiters !== ''
          ? { containerVolumeLiters: Number(create.containerVolumeLiters) }
          : {}),
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Anlegen fehlgeschlagen.');
      return;
    }
    setShowCreate(false);
    setCreate({
      slug: '',
      name: '',
      category: 'machine',
      saleUnit: 'Stück',
      price: '',
      containerCount: '',
      containerVolumeLiters: '',
    });
    await load();
  }

  async function toggleActive(product: ProductRow) {
    setBusy(true);
    const result = await apiFetch(`/staff/products/${product.id}/active`, {
      method: 'POST',
      body: { active: !product.active },
    });
    setBusy(false);
    if (!result.ok) setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
    await load();
  }

  return (
    <main className="page">
      <h1>Produkte &amp; Preise</h1>
      {error !== null && <p className="error">{error}</p>}

      {canManage && (
        <div className="card">
          {showCreate ? (
            <>
              <h2>Neues Produkt anlegen</h2>
              <div className="grid-2">
                <div>
                  <label htmlFor="np-name">Anzeigename</label>
                  <input
                    id="np-name"
                    value={create.name}
                    onChange={(e) => setCreate({ ...create, name: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="np-slug">Technischer Key (stabil)</label>
                  <input
                    id="np-slug"
                    value={create.slug}
                    onChange={(e) => setCreate({ ...create, slug: e.target.value })}
                    placeholder="z. B. popcornmaschine"
                  />
                </div>
              </div>
              <div className="grid-2">
                <div>
                  <label htmlFor="np-cat">Kategorie</label>
                  <select
                    id="np-cat"
                    value={create.category}
                    onChange={(e) => setCreate({ ...create, category: e.target.value })}
                  >
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="np-unit">Verkaufseinheit</label>
                  <input
                    id="np-unit"
                    value={create.saleUnit}
                    onChange={(e) => setCreate({ ...create, saleUnit: e.target.value })}
                  />
                </div>
              </div>
              {create.category === 'machine' && (
                <div className="grid-2">
                  <div>
                    <label htmlFor="np-containers">Behälteranzahl</label>
                    <input
                      id="np-containers"
                      type="number"
                      min={1}
                      value={create.containerCount}
                      onChange={(e) => setCreate({ ...create, containerCount: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor="np-vol">Volumen je Behälter (L)</label>
                    <input
                      id="np-vol"
                      type="number"
                      min={1}
                      value={create.containerVolumeLiters}
                      onChange={(e) =>
                        setCreate({ ...create, containerVolumeLiters: e.target.value })
                      }
                    />
                  </div>
                </div>
              )}
              <label htmlFor="np-price">Aktueller Preis (EUR)</label>
              <input
                id="np-price"
                value={create.price}
                onChange={(e) => setCreate({ ...create, price: e.target.value })}
                placeholder="z. B. 60,00"
              />
              <p>
                <button className="primary" disabled={busy} onClick={() => void createProduct()}>
                  Produkt anlegen
                </button>{' '}
                <button onClick={() => setShowCreate(false)}>Abbrechen</button>
              </p>
            </>
          ) : (
            <button className="primary" onClick={() => setShowCreate(true)}>
              Produkt anlegen
            </button>
          )}
        </div>
      )}

      <div className="card">
        {productsList.map((product) => (
          <div key={product.id}>
            <div className="list-row">
              <div>
                <strong>{product.name}</strong>{' '}
                {!product.active && <span className="badge locked">deaktiviert</span>}
                <div className="muted">
                  {CATEGORY_LABELS[product.category]} · {euro(product.currentPriceCents)} je{' '}
                  {product.saleUnit} · {BILLING_LABELS[product.defaultBillingMode]}
                  {product.containerCount !== null
                    ? ` · ${product.containerCount} Behälter à ${product.containerVolumeLiters ?? '?'} L`
                    : ''}
                  {product.futurePrices.length > 0
                    ? ` · ${product.futurePrices.length} geplante Preisänderung(en)`
                    : ''}
                </div>
              </div>
              <div>
                {canPrice && (
                  <button onClick={() => setExpanded(expanded === product.id ? null : product.id)}>
                    Preise
                  </button>
                )}{' '}
                {canManage && (
                  <button onClick={() => setEditing(editing === product.id ? null : product.id)}>
                    Bearbeiten
                  </button>
                )}{' '}
                {canManage && (
                  <button disabled={busy} onClick={() => void toggleActive(product)}>
                    {product.active ? 'Deaktivieren' : 'Reaktivieren'}
                  </button>
                )}
              </div>
            </div>
            {editing === product.id && canManage && (
              <ProductEditor product={product} onChanged={load} setError={setError} />
            )}
            {expanded === product.id && canPrice && (
              <PriceEditor product={product} onChanged={load} setError={setError} />
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

export default function ProductsPage() {
  return (
    <AuthGuard>
      <ProductsView />
    </AuthGuard>
  );
}
