'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../../lib/api';
import { OCCASION_LABELS, type ProductRow } from '../../../../lib/commerce';

/**
 * Interne Anfrage im Vorgang (Phase-3-Vorgabe Nr. 39): Eventdaten, Gäste,
 * Anlass, Maschine, Sirup, Extras, Abholung/Lieferung. Keine
 * Verfügbarkeitsentscheidung, keine automatische Ablehnung.
 */

interface InquiryData {
  inquiry: {
    eventDate: string | null;
    eventStart: string | null;
    eventEnd: string | null;
    guestCount: number | null;
    occasion: string | null;
    machineProductId: string | null;
    fulfillment: 'pickup' | 'delivery';
    deliveryStreet: string | null;
    deliveryPostalCode: string | null;
    deliveryCity: string | null;
    deliveryWindowFrom: string | null;
    deliveryWindowTo: string | null;
    collectionWindowFrom: string | null;
    collectionWindowTo: string | null;
    onsiteContactName: string | null;
    onsiteContactPhone: string | null;
  };
  selections: { productId: string; role: 'free' | 'extra'; quantity: number }[];
  notes: string[];
}

function toLocalInput(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  return new Date(value).toISOString();
}

function InquiryView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [productsList, setProductsList] = useState<ProductRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState(false);

  const [form, setForm] = useState({
    eventDate: '',
    eventStart: '',
    eventEnd: '',
    guestCount: '',
    occasion: '',
    machineProductId: '',
    fulfillment: 'pickup' as 'pickup' | 'delivery',
    deliveryStreet: '',
    deliveryPostalCode: '',
    deliveryCity: '',
    deliveryWindowFrom: '',
    deliveryWindowTo: '',
    collectionWindowFrom: '',
    collectionWindowTo: '',
    onsiteContactName: '',
    onsiteContactPhone: '',
  });
  const [freeSyrup, setFreeSyrup] = useState<Record<string, number>>({});
  const [extras, setExtras] = useState<Record<string, number>>({});

  const machines = useMemo(
    () => productsList.filter((p) => p.category === 'machine' && p.active),
    [productsList],
  );
  const syrups = useMemo(
    () => productsList.filter((p) => p.category === 'syrup' && p.active),
    [productsList],
  );
  const extraProducts = useMemo(
    () =>
      productsList.filter(
        (p) =>
          (p.category === 'syrup' || p.category === 'consumable' || p.category === 'purchase') &&
          p.active,
      ),
    [productsList],
  );
  const selectedMachine = machines.find((m) => m.id === form.machineProductId) ?? null;
  const freeBudget = selectedMachine?.containerCount ?? 0;
  const freeUsed = Object.values(freeSyrup).reduce((sum, value) => sum + value, 0);
  const canisterLimit = freeBudget * 2;

  const load = useCallback(async () => {
    const [productsResult, inquiryResult] = await Promise.all([
      apiFetch<{ products: ProductRow[] }>('/staff/products'),
      apiFetch<{ inquiry: InquiryData | null }>(`/staff/processes/${params.id}/inquiry`),
    ]);
    if (productsResult.data !== null) setProductsList(productsResult.data.products);
    if (inquiryResult.data?.inquiry !== null && inquiryResult.data?.inquiry !== undefined) {
      const { inquiry, selections, notes: loadedNotes } = inquiryResult.data.inquiry;
      setExists(true);
      setNotes(loadedNotes);
      setForm({
        eventDate: inquiry.eventDate ?? '',
        eventStart: toLocalInput(inquiry.eventStart),
        eventEnd: toLocalInput(inquiry.eventEnd),
        guestCount: inquiry.guestCount === null ? '' : String(inquiry.guestCount),
        occasion: inquiry.occasion ?? '',
        machineProductId: inquiry.machineProductId ?? '',
        fulfillment: inquiry.fulfillment,
        deliveryStreet: inquiry.deliveryStreet ?? '',
        deliveryPostalCode: inquiry.deliveryPostalCode ?? '',
        deliveryCity: inquiry.deliveryCity ?? '',
        deliveryWindowFrom: toLocalInput(inquiry.deliveryWindowFrom),
        deliveryWindowTo: toLocalInput(inquiry.deliveryWindowTo),
        collectionWindowFrom: toLocalInput(inquiry.collectionWindowFrom),
        collectionWindowTo: toLocalInput(inquiry.collectionWindowTo),
        onsiteContactName: inquiry.onsiteContactName ?? '',
        onsiteContactPhone: inquiry.onsiteContactPhone ?? '',
      });
      const free: Record<string, number> = {};
      const extra: Record<string, number> = {};
      for (const selection of selections) {
        if (selection.role === 'free') free[selection.productId] = selection.quantity;
        else extra[selection.productId] = selection.quantity;
      }
      setFreeSyrup(free);
      setExtras(extra);
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const selections = [
      ...Object.entries(freeSyrup)
        .filter(([, quantity]) => quantity > 0)
        .map(([productId, quantity]) => ({ productId, role: 'free' as const, quantity })),
      ...Object.entries(extras)
        .filter(([, quantity]) => quantity > 0)
        .map(([productId, quantity]) => ({ productId, role: 'extra' as const, quantity })),
    ];
    const result = await apiFetch(`/staff/processes/${params.id}/inquiry`, {
      method: 'PUT',
      body: {
        eventDate: form.eventDate === '' ? null : form.eventDate,
        eventStart: fromLocalInput(form.eventStart),
        eventEnd: fromLocalInput(form.eventEnd),
        guestCount: form.guestCount === '' ? null : Number(form.guestCount),
        occasion: form.occasion === '' ? null : form.occasion,
        machineProductId: form.machineProductId === '' ? null : form.machineProductId,
        fulfillment: form.fulfillment,
        deliveryStreet: form.deliveryStreet === '' ? null : form.deliveryStreet,
        deliveryPostalCode: form.deliveryPostalCode === '' ? null : form.deliveryPostalCode,
        deliveryCity: form.deliveryCity === '' ? null : form.deliveryCity,
        deliveryWindowFrom: fromLocalInput(form.deliveryWindowFrom),
        deliveryWindowTo: fromLocalInput(form.deliveryWindowTo),
        collectionWindowFrom: fromLocalInput(form.collectionWindowFrom),
        collectionWindowTo: fromLocalInput(form.collectionWindowTo),
        onsiteContactName: form.onsiteContactName === '' ? null : form.onsiteContactName,
        onsiteContactPhone: form.onsiteContactPhone === '' ? null : form.onsiteContactPhone,
        selections,
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setNotice('Anfrage gespeichert.');
    await load();
  }

  const canEdit = exists ? hasPermission(me, 'inquiry.edit') : hasPermission(me, 'inquiry.create');
  const guestCountNumber = Number(form.guestCount);

  return (
    <main className="page">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang</Link>
      </p>
      <h1>Anfrage</h1>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {notes.map((note) => (
        <p className="badge active" key={note} style={{ display: 'inline-block' }}>
          {note}
        </p>
      ))}
      {Number.isInteger(guestCountNumber) && guestCountNumber >= 250 && (
        <p className="badge active" style={{ display: 'inline-block' }}>
          Großveranstaltung – individuelles Angebot / persönliche Prüfung
        </p>
      )}

      <div className="card">
        <h2>Eventdaten</h2>
        <div className="grid-2">
          <div>
            <label htmlFor="i-date">Eventdatum</label>
            <input
              id="i-date"
              type="date"
              value={form.eventDate}
              onChange={(e) => setForm({ ...form, eventDate: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="i-guests">Gästezahl (exakt)</label>
            <input
              id="i-guests"
              type="number"
              min={1}
              value={form.guestCount}
              onChange={(e) => setForm({ ...form, guestCount: e.target.value })}
            />
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label htmlFor="i-start">Eventbeginn</label>
            <input
              id="i-start"
              type="datetime-local"
              value={form.eventStart}
              onChange={(e) => setForm({ ...form, eventStart: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="i-end">Eventende</label>
            <input
              id="i-end"
              type="datetime-local"
              value={form.eventEnd}
              onChange={(e) => setForm({ ...form, eventEnd: e.target.value })}
            />
          </div>
        </div>
        <label htmlFor="i-occasion">Anlass</label>
        <select
          id="i-occasion"
          value={form.occasion}
          onChange={(e) => setForm({ ...form, occasion: e.target.value })}
        >
          <option value="">– bitte wählen –</option>
          {Object.entries(OCCASION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h2>Maschine &amp; Sirup</h2>
        <label htmlFor="i-machine">Gewünschter Maschinentyp</label>
        <select
          id="i-machine"
          value={form.machineProductId}
          onChange={(e) => setForm({ ...form, machineProductId: e.target.value })}
        >
          <option value="">– bitte wählen –</option>
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
        {selectedMachine !== null && (
          <p className="muted">
            Gratis-Sirup: {freeBudget} L (1 L je Behälter) – frei auf die Sorten verteilbar. Aktuell
            verteilt: {freeUsed} L.
          </p>
        )}
        {syrups.map((syrup) => (
          <div className="grid-2" key={syrup.id}>
            <div>
              <label htmlFor={`free-${syrup.id}`}>{syrup.name} – gratis (L)</label>
              <input
                id={`free-${syrup.id}`}
                type="number"
                min={0}
                value={freeSyrup[syrup.id] ?? 0}
                onChange={(e) =>
                  setFreeSyrup({ ...freeSyrup, [syrup.id]: Math.max(0, Number(e.target.value)) })
                }
              />
            </div>
            <div>
              <label htmlFor={`extra-${syrup.id}`}>{syrup.name} – zusätzlich (Kommission)</label>
              <input
                id={`extra-${syrup.id}`}
                type="number"
                min={0}
                value={extras[syrup.id] ?? 0}
                onChange={(e) =>
                  setExtras({ ...extras, [syrup.id]: Math.max(0, Number(e.target.value)) })
                }
              />
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Zusätzliche Artikel</h2>
        <p className="muted">
          25 Becher und 25 Strohhalme sind einmal pro Mietvorgang inklusive. Zusätzliche
          Becher/Strohhalme laufen auf Kommission; der 6-L-Mischkanister ist ein Kaufartikel (max.{' '}
          {canisterLimit > 0 ? canisterLimit : '2 je Behälter'}).
        </p>
        {extraProducts
          .filter((p) => p.category !== 'syrup')
          .map((product) => (
            <div className="grid-2" key={product.id}>
              <div>
                <label htmlFor={`extra-${product.id}`}>
                  {product.name} ({product.saleUnit})
                </label>
                <input
                  id={`extra-${product.id}`}
                  type="number"
                  min={0}
                  value={extras[product.id] ?? 0}
                  onChange={(e) =>
                    setExtras({ ...extras, [product.id]: Math.max(0, Number(e.target.value)) })
                  }
                />
              </div>
            </div>
          ))}
      </div>

      <div className="card">
        <h2>Abholung / Lieferung</h2>
        <label className="perm-item" style={{ display: 'inline-flex' }}>
          <input
            type="radio"
            name="fulfillment"
            checked={form.fulfillment === 'pickup'}
            onChange={() => setForm({ ...form, fulfillment: 'pickup' })}
          />
          <span>Selbstabholung (Mainz-Hechtsheim)</span>
        </label>{' '}
        <label className="perm-item" style={{ display: 'inline-flex' }}>
          <input
            type="radio"
            name="fulfillment"
            checked={form.fulfillment === 'delivery'}
            onChange={() => setForm({ ...form, fulfillment: 'delivery' })}
          />
          <span>Lieferung anfragen</span>
        </label>
        <p className="muted">
          Vorschlag Standard-Wochenende: Freitag 18:00 Uhr Abholung, Sonntag 11:00 Uhr Rückgabe
          (Zeiten bleiben änderbar).
        </p>
        {form.fulfillment === 'delivery' && (
          <>
            <label htmlFor="i-street">Liefer-/Eventadresse: Straße</label>
            <input
              id="i-street"
              value={form.deliveryStreet}
              onChange={(e) => setForm({ ...form, deliveryStreet: e.target.value })}
            />
            <div className="grid-2">
              <div>
                <label htmlFor="i-plz">PLZ</label>
                <input
                  id="i-plz"
                  value={form.deliveryPostalCode}
                  onChange={(e) => setForm({ ...form, deliveryPostalCode: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="i-city">Ort</label>
                <input
                  id="i-city"
                  value={form.deliveryCity}
                  onChange={(e) => setForm({ ...form, deliveryCity: e.target.value })}
                />
              </div>
            </div>
            <div className="grid-2">
              <div>
                <label htmlFor="i-dwf">Lieferzeitfenster von</label>
                <input
                  id="i-dwf"
                  type="datetime-local"
                  value={form.deliveryWindowFrom}
                  onChange={(e) => setForm({ ...form, deliveryWindowFrom: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="i-dwt">bis</label>
                <input
                  id="i-dwt"
                  type="datetime-local"
                  value={form.deliveryWindowTo}
                  onChange={(e) => setForm({ ...form, deliveryWindowTo: e.target.value })}
                />
              </div>
            </div>
            <div className="grid-2">
              <div>
                <label htmlFor="i-cwf">Abholzeitfenster von</label>
                <input
                  id="i-cwf"
                  type="datetime-local"
                  value={form.collectionWindowFrom}
                  onChange={(e) => setForm({ ...form, collectionWindowFrom: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="i-cwt">bis</label>
                <input
                  id="i-cwt"
                  type="datetime-local"
                  value={form.collectionWindowTo}
                  onChange={(e) => setForm({ ...form, collectionWindowTo: e.target.value })}
                />
              </div>
            </div>
            <div className="grid-2">
              <div>
                <label htmlFor="i-contact">Vor-Ort-Kontakt: Name (optional)</label>
                <input
                  id="i-contact"
                  value={form.onsiteContactName}
                  onChange={(e) => setForm({ ...form, onsiteContactName: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="i-contactphone">Vor-Ort-Kontakt: Telefon (optional)</label>
                <input
                  id="i-contactphone"
                  value={form.onsiteContactPhone}
                  onChange={(e) => setForm({ ...form, onsiteContactPhone: e.target.value })}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {canEdit && (
        <p>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            Anfrage speichern
          </button>
        </p>
      )}
    </main>
  );
}

export default function InquiryPage() {
  return (
    <AuthGuard>
      <InquiryView />
    </AuthGuard>
  );
}
