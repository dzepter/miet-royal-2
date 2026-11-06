'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { CmsNoAccess, WebsiteSubnav, canReadCms } from '../../../components/website';
import { apiFetch, hasPermission } from '../../../lib/api';
import type { CmsCatalog, CmsCatalogProduct } from '../../../lib/cms';
import { euro } from '../../../lib/commerce';
import { formatBerlin } from '../../../lib/handover';

/**
 * Phase 16 (STAFF, Design §6/Order §7): Lesesicht „So erscheinen Produkte und Preise auf
 * der Website“ aus `GET /staff/cms/catalog` (product.view) – dieselbe Projektion wie der
 * öffentliche Katalog (nur aktive Produkte mit wirksamem Preis, keine Bestände/IDs).
 * Im CMS werden KEINE Preise gepflegt; Änderungen nur unter „Produkte & Preise“
 * (`/produkte`, price.manage). Geplante Preise erscheinen ab ihrem Wirksamkeitszeitpunkt.
 */

const BILLING_TEXT: Record<CmsCatalogProduct['billingMode'], string> = {
  fixed: 'fest berechnet',
  commission: 'Kommission – nur Verbrauchtes/Geöffnetes wird berechnet',
};

function ProductRows({ products }: { products: CmsCatalogProduct[] }) {
  if (products.length === 0) {
    return <p className="muted">Keine aktiven Produkte mit aktuellem Preis.</p>;
  }
  return (
    <>
      {products.map((product) => (
        <div className="list-row" key={product.slug}>
          <div>
            <strong>{product.name}</strong>
            {product.description !== null && <div className="muted">{product.description}</div>}
            <div className="muted">{BILLING_TEXT[product.billingMode]}</div>
          </div>
          <div>
            {euro(product.priceCents)} <span className="muted">je {product.unitLabel}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function WebsiteProductsView() {
  const me = useMe();
  const allowed = canReadCms(me);
  const canView = hasPermission(me, 'product.view');
  const [catalog, setCatalog] = useState<CmsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<CmsCatalog>('/staff/cms/catalog');
    if (result.ok && result.data !== null) {
      setCatalog(result.data);
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Die Produktübersicht konnte nicht geladen werden.');
    }
  }, []);
  useEffect(() => {
    if (allowed && canView) void load();
  }, [allowed, canView, load]);

  if (me === null) return null;
  if (!allowed) return <CmsNoAccess title="Website – Produkte & Preise" />;

  return (
    <main className="page">
      <h1>Website – Produkte &amp; Preise</h1>
      <WebsiteSubnav me={me} />
      {!canView ? (
        <p className="error" data-testid="cms-products-not-available">
          Für diese Ansicht brauchst du das Recht „Produkte ansehen“.
        </p>
      ) : (
        <>
          <section className="card">
            <h2>So erscheinen Produkte und Preise auf der Website</h2>
            <p className="muted">
              Die Website liest Produkte und Preise immer aktuell aus „Produkte &amp; Preise“ – im
              Website-Bereich werden keine Preise gepflegt. Geplante Preisänderungen erscheinen ab
              ihrem Wirksamkeitszeitpunkt automatisch. Produkte ohne aktuellen Preis und
              deaktivierte Produkte erscheinen nicht.
            </p>
            <p>
              <Link href="/produkte" className="button-like" data-testid="cms-products-link">
                Preise und Produkte ändern
              </Link>{' '}
              {!hasPermission(me, 'price.manage') && (
                <span className="muted">
                  (Preisänderungen brauchen das Recht „Preise verwalten“.)
                </span>
              )}
            </p>
            {catalog !== null && <p className="muted">Stand: {formatBerlin(catalog.asOf)}</p>}
            {error !== null && (
              <p className="error" role="alert">
                {error}{' '}
                <button type="button" onClick={() => void load()}>
                  Erneut laden
                </button>
              </p>
            )}
          </section>

          {catalog !== null && (
            <>
              <section className="card" data-testid="cms-products-machines">
                <h2>Slush-Maschinen (Miete)</h2>
                {catalog.machines.length === 0 && (
                  <p className="muted">Keine aktiven Slush-Maschinen mit aktuellem Preis.</p>
                )}
                {catalog.machines.map((machine) => (
                  <div className="list-row" key={machine.slug}>
                    <div>
                      <strong>{machine.name}</strong>
                      <div className="muted">
                        {machine.containerCount} Behälter à{' '}
                        {machine.containerVolumeLiters.toLocaleString('de-DE')} L
                      </div>
                      {machine.description !== null && (
                        <div className="muted">{machine.description}</div>
                      )}
                    </div>
                    <div>
                      {euro(machine.priceCents)}{' '}
                      <span className="muted">je {machine.unitLabel}</span>
                    </div>
                  </div>
                ))}
              </section>

              <section className="card">
                <h2>Inklusive</h2>
                <ul>
                  <li>
                    {catalog.included.freeSyrupLitersPerContainer} L Sirup je Maschinenbehälter
                    (frei auf die Sorten verteilbar)
                  </li>
                  <li>
                    {catalog.included.cupsPerProcess} Becher und {catalog.included.strawsPerProcess}{' '}
                    Strohhalme einmal je Mietvorgang
                  </li>
                </ul>
              </section>

              <section className="card">
                <h2>Sirup (zusätzlich)</h2>
                <ProductRows products={catalog.syrups} />
              </section>

              <section className="card">
                <h2>Zubehör (zusätzlich)</h2>
                <ProductRows products={catalog.accessories} />
                {catalog.canister !== null ? (
                  <>
                    <ProductRows products={[catalog.canister]} />
                    <p className="muted">
                      Höchstens {catalog.canister.maxPerContainer} Kanister je Maschinenbehälter.
                    </p>
                  </>
                ) : (
                  <p className="muted">Mischkanister derzeit nicht aktiv oder ohne Preis.</p>
                )}
              </section>

              <section className="card">
                <h2>Abholung und Lieferung</h2>
                <ul>
                  <li>
                    Öffentlich genannte Abholregion: <strong>{catalog.pickupArea}</strong> (die
                    genaue Abholadresse erscheint nie auf der Website)
                  </li>
                  <li>
                    Lieferung: wird individuell geprüft und angeboten – kein Lieferpreis online.
                  </li>
                  <li>
                    Ab {catalog.largeEventGuestThreshold} Gästen: Hinweis auf persönliche
                    Abstimmung, Anfrage bleibt möglich.
                  </li>
                </ul>
                <p className="muted">Hinweis auf der Website: „{catalog.priceNote}“</p>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

export default function WebsiteProductsPage() {
  return (
    <AuthGuard>
      <WebsiteProductsView />
    </AuthGuard>
  );
}
