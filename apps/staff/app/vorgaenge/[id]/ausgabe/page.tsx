'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { QrScanner } from '../../../../components/qr-scanner';
import { apiFetch, hasPermission } from '../../../../lib/api';
import {
  ASSIGNMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  formatBerlin,
  formatEuroCents,
  NEXT_ACTION_LABELS,
  type HandoverDetail,
  type HandoverDocument,
  type SlotView,
  type SuggestionEntry,
} from '../../../../lib/handover';
import { MACHINE_STATUS_ICONS } from '../../../../lib/warehouse';

/**
 * Ausgabe vorbereiten (Phase-6-Order §§6–10, 18–20, 29–30, 53): konkrete
 * Maschinen je Slot (Vorschlag, QR, bewusster Override), Vorbereitung
 * (Reserviert), Lieferschein-Entwurf mit Ist-Mengen und Zusatzpositionen,
 * Lagerwarnungen, alternative Abholperson, Transporthinweise – und der
 * Einstieg in die geführte Übergabe. Alle Regeln rechnet der Server.
 */
interface ProductOption {
  id: string;
  name: string;
  category: string;
  saleUnit: string;
}

function PreparationView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [detail, setDetail] = useState<HandoverDetail | null>(null);
  const [documents, setDocuments] = useState<HandoverDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeSlot, setActiveSlot] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{
    preferredBasis: string | null;
    entries: SuggestionEntry[];
    warnings: string[];
  } | null>(null);
  const [pendingOverride, setPendingOverride] = useState<{
    slotId: string;
    machineId: string;
    machineCode: string;
    problems: SuggestionEntry['problems'];
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [scanning, setScanning] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [additionProduct, setAdditionProduct] = useState('');
  const [additionQuantity, setAdditionQuantity] = useState('1');
  const [rep, setRep] = useState({ firstName: '', lastName: '', phone: '' });

  const canAssign = hasPermission(me, 'machine.assign');
  const canPrepare = hasPermission(me, 'handover.prepare');
  const canEditNote = hasPermission(me, 'delivery_note.edit');
  const canPerform = hasPermission(me, 'handover.perform');

  const load = useCallback(async () => {
    const result = await apiFetch<{ detail: HandoverDetail | null }>(
      `/staff/processes/${params.id}/handover`,
    );
    if (result.data === null) {
      setError(result.errorMessage ?? 'Ausgabe konnte nicht geladen werden.');
      return;
    }
    setDetail(result.data.detail);
    if (result.data.detail !== null) {
      const docs = await apiFetch<{ detail: HandoverDetail; documents: HandoverDocument[] }>(
        `/staff/handover/${result.data.detail.booking.id}`,
      );
      if (docs.data !== null) setDocuments(docs.data.documents);
      const items = result.data.detail.deliveryNote.items;
      // Ungespeicherte Eingaben bleiben erhalten – ein Nachladen (z. B. nach
      // einer anderen Aktion) setzt nur neue Positionen auf ihren Ist-Wert.
      setQuantities((previous) => {
        const merged = { ...previous };
        for (const item of items) {
          if (merged[item.id] === undefined) merged[item.id] = String(item.actualQuantity);
        }
        return merged;
      });
      const representative = result.data.detail.representative;
      if (representative !== null) {
        setRep((previous) =>
          previous.firstName === '' && previous.lastName === '' && previous.phone === ''
            ? {
                firstName: representative.firstName,
                lastName: representative.lastName,
                phone: representative.phone ?? '',
              }
            : previous,
        );
      }
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canEditNote) return;
    void apiFetch<{ products: ProductOption[] }>('/staff/handover-addition-products').then(
      (result) => {
        if (result.data !== null) setProducts(result.data.products);
      },
    );
  }, [canEditNote]);

  async function run(path: string, method: string, body?: unknown, okNotice?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch(path, body === undefined ? { method } : { method, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return false;
    }
    if (okNotice !== undefined) setNotice(okNotice);
    await load();
    return true;
  }

  async function openSuggestion(slot: SlotView) {
    if (detail === null) return;
    setActiveSlot(slot.id);
    setPendingOverride(null);
    const result = await apiFetch<{
      preferredBasis: string | null;
      entries: SuggestionEntry[];
      warnings: string[];
    }>(`/staff/handover/${detail.booking.id}/slots/${slot.id}/suggestion`);
    if (result.data !== null) setSuggestion(result.data);
    else setError(result.errorMessage ?? 'Vorschlag konnte nicht geladen werden.');
  }

  async function chooseMachine(slotId: string, machineId: string, machineCode: string) {
    if (detail === null) return;
    const evaluation = await apiFetch<{
      problems: SuggestionEntry['problems'];
      hardBlocked: boolean;
      overrideRequired: boolean;
      productMatches: boolean;
    }>(`/staff/handover/${detail.booking.id}/slots/${slotId}/evaluate?machineId=${machineId}`);
    if (evaluation.data === null) {
      setError(evaluation.errorMessage ?? 'Prüfung fehlgeschlagen.');
      return;
    }
    if (evaluation.data.hardBlocked) {
      setError(
        `Maschine ${machineCode} ist an einen anderen Vorgang ausgegeben und physisch nicht verfügbar. ${evaluation.data.problems
          .map((p) => p.detail)
          .join(' ')}`,
      );
      return;
    }
    if (evaluation.data.overrideRequired) {
      setPendingOverride({ slotId, machineId, machineCode, problems: evaluation.data.problems });
      setOverrideReason('');
      return;
    }
    const ok = await run(
      `/staff/handover/${detail.booking.id}/slots/${slotId}/assign`,
      'POST',
      { machineId },
      `Maschine ${machineCode} zugewiesen.`,
    );
    if (ok) {
      setActiveSlot(null);
      setSuggestion(null);
      setScanning(false);
    }
  }

  async function confirmOverride() {
    if (detail === null || pendingOverride === null) return;
    const ok = await run(
      `/staff/handover/${detail.booking.id}/slots/${pendingOverride.slotId}/assign`,
      'POST',
      {
        machineId: pendingOverride.machineId,
        override: { confirmed: true, reason: overrideReason.trim() },
      },
      `Maschine ${pendingOverride.machineCode} mit Override zugewiesen.`,
    );
    if (ok) {
      setPendingOverride(null);
      setActiveSlot(null);
      setSuggestion(null);
      setScanning(false);
    }
  }

  if (error !== null && detail === null) {
    return (
      <main className="page">
        <p className="error">{error}</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="page">
        <p className="muted">Lade …</p>
      </main>
    );
  }
  const { booking, handover, slots } = detail;
  const finalized = handover.status === 'finalized';
  const canisterLine = detail.deliveryNote.items.filter((item) => item.kind === 'purchase');
  const insufficient = detail.stock.filter((entry) => !entry.sufficient);

  return (
    <main className="page">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang {booking.processNumber}</Link> ·{' '}
        <Link href="/ausgabe">Ausgabe-Übersicht</Link>
      </p>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Ausgabe vorbereiten – {booking.processNumber}</h1>
        <p>
          <strong>{booking.customerName}</strong> · Event {booking.eventDate ?? '–'}
          {booking.eventTimeLabel !== null ? ` (${booking.eventTimeLabel})` : ''} ·{' '}
          {booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung'}
          {' · '}
          {booking.machineQuantity > 1 ? `${booking.machineQuantity} × ` : ''}
          {booking.machineTypeName ?? 'Maschine'}
        </p>
        {handover.appointment !== null && (
          <p className="muted">
            {handover.appointment.kind === 'delivery' ? 'Lieferung' : 'Abholung'}:{' '}
            {handover.appointment.startAt === null
              ? 'Zeit noch festlegen'
              : formatBerlin(handover.appointment.startAt)}
          </p>
        )}
        {booking.fulfillment === 'delivery' && (
          <p className="muted">
            Lieferadresse: {booking.deliveryAddressLines.join(', ') || '–'}
            {booking.onsiteContactName !== null && (
              <>
                {' · '}Vor Ort: {booking.onsiteContactName}
                {booking.onsiteContactPhone !== null && (
                  <>
                    {' '}
                    <a href={`tel:${booking.onsiteContactPhone}`} className="button-like">
                      📞 {booking.onsiteContactPhone}
                    </a>
                  </>
                )}
              </>
            )}
          </p>
        )}
        <p>
          <strong>Nächster Schritt:</strong>{' '}
          {detail.nextAction === 'handover' && canPerform ? (
            <Link href={`/vorgaenge/${params.id}/uebergabe`} className="button-like primary">
              Übergabe starten
            </Link>
          ) : detail.nextAction === 'done' ? (
            <span className="badge ok">Übergabe abgeschlossen</span>
          ) : (
            <span>{NEXT_ACTION_LABELS[detail.nextAction]}</span>
          )}
        </p>
      </div>

      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}

      {/* ── Maschinen je Slot ────────────────────────────────────────── */}
      <div className="card" data-testid="assignment-slots">
        <h2>Konkrete Maschinen</h2>
        {slots.map((slot) => (
          <div
            className="list-row"
            key={slot.id}
            data-testid={`slot-${slot.slotNo}`}
            style={{ alignItems: 'flex-start' }}
          >
            <div>
              <strong>
                Maschine {slot.slotNo} · {slot.productName}
              </strong>
              <div>
                {slot.machine === null ? (
                  <span className="badge locked">{ASSIGNMENT_STATUS_LABELS.open}</span>
                ) : (
                  <>
                    <span className="badge">
                      {MACHINE_STATUS_ICONS[slot.machine.status]} {slot.machine.machineCode} ·{' '}
                      {slot.machine.statusLabel}
                    </span>{' '}
                    <span
                      className={`badge ${slot.status === 'prepared' || slot.status === 'issued' ? 'ok' : ''}`}
                    >
                      {ASSIGNMENT_STATUS_LABELS[slot.status]}
                    </span>
                    <div className="muted">
                      Standort: {slot.machine.locationLabel}
                      {slot.machine.locationNote !== null ? ` – ${slot.machine.locationNote}` : ''}
                    </div>
                  </>
                )}
              </div>
              {slot.override !== null && (
                <div className="muted">
                  Override: {slot.override.reason} ({slot.override.confirmedByName ?? '–'},{' '}
                  {formatBerlin(slot.override.confirmedAt)})
                </div>
              )}
              {slot.currentProblems.length > 0 && slot.status !== 'issued' && (
                <div className="conflict-box" data-testid={`slot-${slot.slotNo}-warning`}>
                  <strong>
                    ⚠️ {slot.overrideStale ? 'Problemlage geändert – erneut bestätigen' : 'Hinweis'}
                  </strong>
                  <ul style={{ margin: '0.3rem 0 0 1rem' }}>
                    {slot.currentProblems.map((problem) => (
                      <li key={problem.descriptor}>
                        {problem.label}: {problem.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {!finalized && (
              <div style={{ textAlign: 'right' }}>
                {canAssign && slot.status !== 'issued' && (
                  <p style={{ margin: '0.2rem 0' }}>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void openSuggestion(slot)}
                    >
                      {slot.machine === null ? 'Maschine wählen' : 'Maschine wechseln'}
                    </button>{' '}
                    {slot.machine !== null && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(
                            `/staff/handover/${booking.id}/slots/${slot.id}/release`,
                            'POST',
                            undefined,
                            'Zuordnung gelöst.',
                          )
                        }
                      >
                        Zuordnung lösen
                      </button>
                    )}
                  </p>
                )}
                {canPrepare && slot.machine !== null && slot.status === 'assigned' && (
                  <p style={{ margin: '0.2rem 0' }}>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          `/staff/handover/${booking.id}/slots/${slot.id}/prepare`,
                          'POST',
                          undefined,
                          'Als vorbereitet markiert (🟠 Reserviert).',
                        )
                      }
                    >
                      Als vorbereitet markieren
                    </button>
                  </p>
                )}
                {canPrepare && slot.status === 'prepared' && (
                  <p style={{ margin: '0.2rem 0' }}>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          `/staff/handover/${booking.id}/slots/${slot.id}/unprepare`,
                          'POST',
                          undefined,
                          'Vorbereitung zurückgenommen.',
                        )
                      }
                    >
                      Vorbereitung zurücknehmen
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>
        ))}

        {activeSlot !== null && suggestion !== null && (
          <div className="card" data-testid="machine-suggestion">
            <h3 style={{ marginTop: 0 }}>
              Vorschlag für Maschine {slots.find((s) => s.id === activeSlot)?.slotNo}
              {suggestion.preferredBasis !== null
                ? ` · bevorzugt: ${suggestion.preferredBasis}`
                : ''}
            </h3>
            <p>
              <button onClick={() => setScanning(true)}>📷 QR scannen</button>{' '}
              <button
                onClick={() => {
                  setActiveSlot(null);
                  setSuggestion(null);
                  setScanning(false);
                  setPendingOverride(null);
                }}
              >
                Abbrechen
              </button>
            </p>
            {scanning && (
              <QrScanner
                onResolved={(machine) =>
                  void chooseMachine(activeSlot, machine.machineId, machine.machineCode)
                }
                onClose={() => setScanning(false)}
              />
            )}
            {suggestion.warnings.map((warning) => (
              <p className="muted" key={warning}>
                ⚠️ {warning}
              </p>
            ))}
            {suggestion.entries.map((entry) => (
              <div
                className="list-row"
                key={entry.machineId}
                data-testid={`suggest-${entry.machineCode}`}
              >
                <div>
                  <strong>
                    {MACHINE_STATUS_ICONS[entry.status]} {entry.machineCode}
                  </strong>{' '}
                  {entry.preferred && <span className="badge ok">Bevorzugt</span>}{' '}
                  <span className="badge">{entry.statusLabel}</span>
                  <div className="muted">
                    Standort: {entry.locationLabel}
                    {entry.locationNote !== null ? ` – ${entry.locationNote}` : ''}
                    {entry.purchaseDate !== null
                      ? ` · Kaufdatum ${entry.purchaseDate}`
                      : ' · Kaufdatum unbekannt'}
                  </div>
                  {entry.problems.length > 0 && (
                    <ul className="muted" style={{ margin: '0.2rem 0 0 1rem' }}>
                      {entry.problems.map((problem) => (
                        <li key={problem.descriptor}>
                          {problem.label}: {problem.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <button
                    className={entry.eligibility === 'eligible' ? 'primary' : ''}
                    disabled={busy || entry.hardBlocked}
                    onClick={() =>
                      void chooseMachine(activeSlot, entry.machineId, entry.machineCode)
                    }
                  >
                    {entry.hardBlocked
                      ? 'Nicht verfügbar'
                      : entry.overrideRequired
                        ? 'Trotzdem wählen …'
                        : 'Wählen'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {pendingOverride !== null && (
          <div className="conflict-box" data-testid="override-dialog">
            <h3 style={{ marginTop: 0 }}>
              ⚠️ Starke Warnung – Maschine {pendingOverride.machineCode}
            </h3>
            <ul>
              {pendingOverride.problems
                .filter((problem) => !problem.warningOnly)
                .map((problem) => (
                  <li key={problem.descriptor}>
                    <strong>{problem.label}:</strong> {problem.detail}
                    {problem.otherProcessNumber !== undefined && (
                      <>
                        {' '}
                        (Vorgang{' '}
                        <Link href={`/vorgaenge?q=${problem.otherProcessNumber}`}>
                          {problem.otherProcessNumber}
                        </Link>
                        {problem.from !== undefined
                          ? `, ${formatBerlin(problem.from)} – ${formatBerlin(problem.to ?? null)}`
                          : ''}
                        )
                      </>
                    )}
                  </li>
                ))}
            </ul>
            {hasPermission(me, 'machine.override_block') ? (
              <>
                <label htmlFor="override-reason">Grund (Pflicht)</label>
                <textarea
                  id="override-reason"
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
                <p>
                  <button
                    className="danger"
                    disabled={busy || overrideReason.trim() === ''}
                    onClick={() => void confirmOverride()}
                  >
                    Trotzdem zuordnen (bewusst bestätigen)
                  </button>{' '}
                  <button onClick={() => setPendingOverride(null)}>Abbrechen</button>
                </p>
              </>
            ) : (
              <p className="muted">
                Für diese Maschine ist ein Override nötig – dir fehlt das Recht „Maschinensperre
                übersteuern“.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Lieferschein / Artikel ────────────────────────────────────── */}
      <div className="card" data-testid="delivery-note">
        <h2>Lieferschein {finalized ? '(final)' : '(Entwurf)'}</h2>
        {insufficient.length > 0 && !finalized && (
          <div className="conflict-box" data-testid="stock-warning">
            <strong>Lagerbestand prüfen</strong>
            <ul style={{ margin: '0.3rem 0 0 1rem' }}>
              {insufficient.map((entry) => (
                <li key={entry.inventoryItemId}>
                  {entry.productName}: System{' '}
                  {entry.systemStock === null ? 'nicht erfasst' : entry.systemStock}, benötigt{' '}
                  {entry.required}
                </li>
              ))}
            </ul>
            <p style={{ margin: '0.3rem 0 0' }}>
              <Link href="/lager">Wareneingang erfassen / Bestand prüfen</Link> oder Ausgabemenge
              unten korrigieren.
            </p>
          </div>
        )}
        {detail.deliveryNote.items.map((item) => (
          <div className="list-row" key={item.id} data-testid={`note-item-${item.id}`}>
            <div>
              <strong>{item.description}</strong> <span className="badge">{item.kindLabel}</span>
              <div className="muted">
                Soll: {item.plannedQuantity} {item.unit}
                {item.kind !== 'included'
                  ? ` · ${formatEuroCents(item.unitPriceCents)} / ${item.unit}`
                  : ''}
                {item.fromAddition ? ' · nachträglich vereinbart' : ''}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {canEditNote && !finalized ? (
                <>
                  <input
                    aria-label={`Ausgabemenge ${item.description}`}
                    type="number"
                    min={0}
                    style={{ width: '5rem' }}
                    value={quantities[item.id] ?? String(item.actualQuantity)}
                    onChange={(e) => setQuantities({ ...quantities, [item.id]: e.target.value })}
                  />{' '}
                  <button
                    disabled={busy || Number(quantities[item.id]) === item.actualQuantity}
                    onClick={() =>
                      void run(
                        `/staff/handover/${booking.id}/items/${item.id}`,
                        'PATCH',
                        {
                          actualQuantity: Number(quantities[item.id]),
                        },
                        'Ausgabemenge gespeichert.',
                      )
                    }
                  >
                    Speichern
                  </button>
                </>
              ) : (
                <strong>
                  Ist: {item.actualQuantity} {item.unit}
                </strong>
              )}
            </div>
          </div>
        ))}
        {canisterLine.length > 0 && (
          <p className="muted">
            Kanister: maximal {detail.canisterLimit} (2 je gebuchtem Behälter).
          </p>
        )}
        {canEditNote && !finalized && (
          <p>
            <label htmlFor="addition-product">
              Zusätzlichen Artikel erfassen (mit Kunde vereinbart)
            </label>
            <select
              id="addition-product"
              value={additionProduct}
              onChange={(e) => setAdditionProduct(e.target.value)}
            >
              <option value="">Artikel wählen …</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.saleUnit})
                </option>
              ))}
            </select>{' '}
            <input
              aria-label="Zusatzmenge"
              type="number"
              min={1}
              style={{ width: '5rem' }}
              value={additionQuantity}
              onChange={(e) => setAdditionQuantity(e.target.value)}
            />{' '}
            <button
              disabled={busy || additionProduct === '' || Number(additionQuantity) < 1}
              onClick={() =>
                void run(
                  `/staff/handover/${booking.id}/additions`,
                  'POST',
                  {
                    productId: additionProduct,
                    quantity: Number(additionQuantity),
                  },
                  'Zusatzposition mit aktuellem Preis gespeichert – die Buchung bleibt unverändert.',
                ).then((ok) => {
                  if (ok) {
                    setAdditionProduct('');
                    setAdditionQuantity('1');
                  }
                })
              }
            >
              Zusatzposition hinzufügen
            </button>
          </p>
        )}
        {detail.additions.length > 0 && (
          <p className="muted">
            Zusatzpositionen:{' '}
            {detail.additions
              .map((a) => `${a.quantity} × ${a.description} (${formatEuroCents(a.unitPriceCents)})`)
              .join(', ')}
          </p>
        )}
        <p>
          <a
            href={`/api/staff/handover/${booking.id}/delivery-note/preview`}
            target="_blank"
            rel="noreferrer"
          >
            Lieferschein-Vorschau (PDF)
          </a>
          {documents.map((doc) => (
            <span key={doc.id}>
              {' · '}
              <a href={`/api/staff/documents/${doc.id}`} target="_blank" rel="noreferrer">
                {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type} (final)
              </a>
            </span>
          ))}
        </p>
      </div>

      {/* ── Abholperson & Transport (nur Selbstabholung) ───────────────── */}
      {booking.fulfillment === 'pickup' && (
        <div className="card" data-testid="representative">
          <h2>Alternative Abholperson</h2>
          {detail.representative !== null ? (
            <p>
              {detail.representative.firstName} {detail.representative.lastName}
              {detail.representative.phone !== null ? ` · ${detail.representative.phone}` : ''}
              {detail.representative.changeableUntil !== null && (
                <span className="muted">
                  {' '}
                  (vom Kunden änderbar bis {formatBerlin(detail.representative.changeableUntil)})
                </span>
              )}
            </p>
          ) : (
            <p className="muted">
              Keine alternative Abholperson hinterlegt – der Kunde holt selbst ab.
            </p>
          )}
          {canPrepare && !finalized && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  `/staff/handover/${booking.id}/representative`,
                  'PUT',
                  {
                    firstName: rep.firstName,
                    lastName: rep.lastName,
                    phone: rep.phone.trim() === '' ? null : rep.phone,
                  },
                  'Abholperson gespeichert.',
                );
              }}
            >
              <label htmlFor="rep-first">Vorname</label>
              <input
                id="rep-first"
                value={rep.firstName}
                onChange={(e) => setRep({ ...rep, firstName: e.target.value })}
              />
              <label htmlFor="rep-last">Nachname</label>
              <input
                id="rep-last"
                value={rep.lastName}
                onChange={(e) => setRep({ ...rep, lastName: e.target.value })}
              />
              <label htmlFor="rep-phone">Telefon (wird nach Abschluss gelöscht)</label>
              <input
                id="rep-phone"
                value={rep.phone}
                onChange={(e) => setRep({ ...rep, phone: e.target.value })}
              />
              <button
                className="primary"
                type="submit"
                disabled={busy || rep.firstName.trim() === '' || rep.lastName.trim() === ''}
              >
                Abholperson speichern
              </button>{' '}
              {detail.representative !== null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      `/staff/handover/${booking.id}/representative`,
                      'DELETE',
                      undefined,
                      'Abholperson entfernt.',
                    )
                  }
                >
                  Entfernen
                </button>
              )}
            </form>
          )}
          {booking.transportNotes.length > 0 && (
            <>
              <h3>Transporthinweise</h3>
              <ul className="muted">
                {booking.transportNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </main>
  );
}

export default function PreparationPage() {
  return (
    <AuthGuard>
      <PreparationView />
    </AuthGuard>
  );
}
