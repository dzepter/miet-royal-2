'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { QrScanner } from '../../../../components/qr-scanner';
import { SignaturePad } from '../../../../components/signature-pad';
import { apiFetch, hasPermission } from '../../../../lib/api';
import {
  DOCUMENT_TYPE_LABELS,
  fileToBase64,
  formatBerlin,
  PACKET_STATUS_LABELS,
  type DeliveryPacketView,
  type HandoverDetail,
  type HandoverDocument,
} from '../../../../lib/handover';
import { MACHINE_STATUS_ICONS } from '../../../../lib/warehouse';

/**
 * Geführte Übergabe (Phase-6-Order §§24–44, 56): Tablet-first, ein
 * dominanter nächster Schritt je Bildschirm, keine unnötigen
 * Zwischenschritte. Schritte: Vorgang prüfen → Maschinen bestätigen →
 * Artikel prüfen → je Maschine aktiv prüfen + Gesamtfoto → Kunde/Vertreter
 * → Zusammenfassung → Unterschrift Kunde → Unterschrift Mitarbeiter →
 * Abschluss. Alle Pflichtprüfungen rechnet der Server (Blocker-Liste).
 */
const STEPS = [
  'Vorgang',
  'Maschinen',
  'Artikel',
  'Prüfung & Foto',
  'Empfänger',
  'Zusammenfassung',
  'Unterschrift Kunde',
  'Unterschrift Mitarbeiter',
  'Abschluss',
] as const;

const RECIPIENT_LABELS = {
  customer: 'Kunde selbst',
  representative: 'Hinterlegte Abholperson',
  other: 'Sonstiger Vertreter',
} as const;

function HandoverWizard() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [detail, setDetail] = useState<HandoverDetail | null>(null);
  const [documents, setDocuments] = useState<HandoverDocument[]>([]);
  const [packets, setPackets] = useState<DeliveryPacketView[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [recipientKind, setRecipientKind] = useState<'customer' | 'representative' | 'other'>(
    'customer',
  );
  const [otherName, setOtherName] = useState('');
  const [otherPhone, setOtherPhone] = useState('');
  const canPerform = hasPermission(me, 'handover.perform');

  const load = useCallback(async () => {
    const result = await apiFetch<{ detail: HandoverDetail | null }>(
      `/staff/processes/${params.id}/handover`,
    );
    if (result.data === null) {
      setError(result.errorMessage ?? 'Übergabe konnte nicht geladen werden.');
      return;
    }
    setDetail(result.data.detail);
    if (result.data.detail !== null) {
      const docs = await apiFetch<{ documents: HandoverDocument[] }>(
        `/staff/handover/${result.data.detail.booking.id}`,
      );
      if (docs.data !== null) setDocuments(docs.data.documents);
      if (result.data.detail.handover.recipientKind !== null) {
        setRecipientKind(result.data.detail.handover.recipientKind);
        if (result.data.detail.handover.recipientKind === 'other') {
          setOtherName(result.data.detail.handover.recipientName ?? '');
          setOtherPhone(result.data.detail.handover.recipientPhone ?? '');
        }
      }
      if (result.data.detail.handover.status === 'finalized') {
        setStep(STEPS.length - 1);
        const packetResult = await apiFetch<{ packets: DeliveryPacketView[] }>(
          `/staff/processes/${params.id}/delivery-packets`,
        );
        if (packetResult.data !== null) setPackets(packetResult.data.packets);
      }
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(
    path: string,
    method: string,
    body?: unknown,
    okNotice?: string,
  ): Promise<boolean> {
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

  if (detail === null) {
    return (
      <main className="page">
        {error !== null ? <p className="error">{error}</p> : <p className="muted">Lade …</p>}
      </main>
    );
  }
  const { booking, handover, slots } = detail;
  const finalized = handover.status === 'finalized';
  const allAssigned = slots.length > 0 && slots.every((slot) => slot.machine !== null);
  const allPrepared =
    allAssigned && slots.every((slot) => slot.status === 'prepared' || slot.status === 'issued');
  const machineState = (slotId: string) => detail.machines.find((m) => m.assignmentId === slotId);
  const allChecked = slots.every((slot) => machineState(slot.id)?.checked === true);
  const allPhotos = slots.every((slot) => (machineState(slot.id)?.photos.length ?? 0) > 0);
  const recipientSet = handover.recipientKind !== null;
  const customerSigned = detail.signatures.customer !== null;
  const staffSigned = detail.signatures.staff !== null;

  const stepDone = [
    true,
    allPrepared,
    true,
    allChecked && allPhotos,
    recipientSet,
    true,
    customerSigned,
    staffSigned,
    finalized,
  ];

  async function uploadPhoto(slotId: string, file: File) {
    const mime = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
    const dataBase64 = await fileToBase64(file);
    await run(
      `/staff/handover/${booking.id}/machines/${slotId}/photos`,
      'POST',
      { mimeType: mime, dataBase64 },
      'Gesamtfoto gespeichert.',
    );
  }

  const nav = (
    <div className="wizard-nav" aria-label="Schritte">
      {STEPS.map((label, index) => (
        <span key={label} className={index === step ? 'active' : stepDone[index] ? 'done' : ''}>
          {index + 1}. {label}
        </span>
      ))}
    </div>
  );

  const next = (enabled: boolean, label = 'Weiter') => (
    <p>
      {step > 0 && (
        <button className="big" onClick={() => setStep(step - 1)} disabled={busy}>
          Zurück
        </button>
      )}{' '}
      <button
        className="primary big"
        onClick={() => setStep(step + 1)}
        disabled={!enabled || busy}
        data-testid="wizard-next"
      >
        {label}
      </button>
    </p>
  );

  return (
    <main className="page wizard-step">
      <p>
        <Link href={`/vorgaenge/${params.id}/ausgabe`}>← Vorbereitung</Link> ·{' '}
        <Link href={`/vorgaenge/${params.id}`}>Vorgang {booking.processNumber}</Link>
      </p>
      <h1>Übergabe – {booking.processNumber}</h1>
      {nav}
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {!canPerform && !finalized && (
        <p className="muted">
          Dir fehlt das Recht, Ausgaben durchzuführen – die Übergabe ist hier nur einsehbar.
        </p>
      )}

      {step === 0 && (
        <div className="card">
          <h2>1. Vorgang prüfen</h2>
          <p>
            <strong>{booking.customerName}</strong> · Event {booking.eventDate ?? '–'}
            {booking.eventTimeLabel !== null ? ` (${booking.eventTimeLabel})` : ''}
          </p>
          <p>
            {booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung'} ·{' '}
            {booking.machineQuantity > 1 ? `${booking.machineQuantity} × ` : ''}
            {booking.machineTypeName ?? 'Maschine'}
          </p>
          {booking.fulfillment === 'delivery' && (
            <p>
              Lieferadresse: {booking.deliveryAddressLines.join(', ') || '–'}
              {booking.onsiteContactName !== null && (
                <>
                  <br />
                  Vor Ort: {booking.onsiteContactName}{' '}
                  {booking.onsiteContactPhone !== null && (
                    <a href={`tel:${booking.onsiteContactPhone}`} className="button-like">
                      📞 Anrufen
                    </a>
                  )}
                </>
              )}
            </p>
          )}
          {booking.fulfillment === 'pickup' && booking.transportNotes.length > 0 && (
            <ul className="muted" data-testid="wizard-transport-notes">
              {booking.transportNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {next(true)}
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2>2. Maschinen bestätigen / scannen</h2>
          {slots.map((slot) => (
            <div className="list-row" key={slot.id} data-testid={`wizard-slot-${slot.slotNo}`}>
              <div>
                <strong>Maschine {slot.slotNo}</strong> · {slot.productName}
                <div>
                  {slot.machine === null ? (
                    <span className="badge locked">
                      Nicht zugewiesen – bitte in der Vorbereitung zuordnen
                    </span>
                  ) : (
                    <>
                      <span className="badge">
                        {MACHINE_STATUS_ICONS[slot.machine.status]} {slot.machine.machineCode}
                      </span>{' '}
                      {slot.status !== 'prepared' && slot.status !== 'issued' && (
                        <span className="badge locked">
                          Noch nicht vorbereitet – bitte in der Vorbereitung als vorbereitet
                          markieren
                        </span>
                      )}
                    </>
                  )}
                </div>
                {slot.overrideStale && (
                  <div className="conflict-box">
                    ⚠️ Problemlage geändert – bitte in der Vorbereitung erneut prüfen und bewusst
                    bestätigen.
                  </div>
                )}
              </div>
              {slot.machine !== null && !finalized && (
                <div>
                  <button className="big" onClick={() => setScanFor(slot.id)} disabled={busy}>
                    📷 Scannen zur Bestätigung
                  </button>
                </div>
              )}
            </div>
          ))}
          {scanFor !== null && (
            <QrScanner
              onResolved={(machine) => {
                const slot = slots.find((s) => s.id === scanFor);
                if (slot?.machine?.id === machine.machineId) {
                  setNotice(`Maschine ${machine.machineCode} bestätigt.`);
                  setError(null);
                } else {
                  setError(
                    `Gescannt: ${machine.machineCode} – das ist nicht die zugewiesene Maschine dieses Slots.`,
                  );
                }
                setScanFor(null);
              }}
              onClose={() => setScanFor(null)}
            />
          )}
          {!allPrepared && (
            <p>
              <Link href={`/vorgaenge/${params.id}/ausgabe`} className="button-like">
                Zur Vorbereitung (Maschinen zuweisen und vorbereiten)
              </Link>
            </p>
          )}
          {next(allPrepared)}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>3. Ausgegebene Artikel prüfen</h2>
          {detail.deliveryNote.items
            .filter((item) => item.actualQuantity > 0)
            .map((item) => (
              <div className="list-row" key={item.id}>
                <div>
                  {item.description} <span className="badge">{item.kindLabel}</span>
                </div>
                <strong>
                  {item.actualQuantity} {item.unit}
                </strong>
              </div>
            ))}
          {detail.stock.some((entry) => !entry.sufficient) && (
            <div className="conflict-box" data-testid="wizard-stock-warning">
              <strong>Lagerbestand prüfen</strong> –{' '}
              {detail.stock
                .filter((entry) => !entry.sufficient)
                .map(
                  (entry) =>
                    `${entry.productName} (System ${entry.systemStock ?? 'nicht erfasst'}, benötigt ${entry.required})`,
                )
                .join('; ')}
              . <Link href="/lager">Wareneingang erfassen</Link> oder Mengen in der{' '}
              <Link href={`/vorgaenge/${params.id}/ausgabe`}>Vorbereitung</Link> korrigieren.
            </div>
          )}
          <p className="muted">
            Mengen ändern:{' '}
            <Link href={`/vorgaenge/${params.id}/ausgabe`}>Vorbereitung / Lieferschein</Link>
          </p>
          {next(true)}
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2>4. Jede Maschine gemeinsam prüfen + Gesamtfoto</h2>
          {slots.map((slot) => {
            const state = machineState(slot.id);
            return (
              <div className="card" key={slot.id} data-testid={`check-${slot.slotNo}`}>
                <h3 style={{ marginTop: 0 }}>
                  {slot.machine?.machineCode ?? `Maschine ${slot.slotNo}`} · {slot.productName}
                </h3>
                <p>
                  {state?.checked === true ? (
                    <span className="badge ok">
                      ✓ Maschine gemeinsam geprüft ({formatBerlin(state.checkedAt)})
                    </span>
                  ) : canPerform && !finalized ? (
                    <button
                      className="primary big"
                      disabled={busy || slot.machine === null}
                      onClick={() =>
                        void run(
                          `/staff/handover/${booking.id}/machines/${slot.id}/check`,
                          'POST',
                          undefined,
                          'Prüfung bestätigt.',
                        )
                      }
                    >
                      Maschine gemeinsam geprüft
                    </button>
                  ) : (
                    <span className="badge locked">Noch nicht geprüft</span>
                  )}
                </p>
                <p>
                  {(state?.photos ?? []).map((photo) => (
                    <img
                      key={photo.id}
                      className="photo-thumb"
                      src={`/api/staff/handover/photos/${photo.id}`}
                      alt={`Gesamtfoto ${slot.machine?.machineCode ?? ''}`}
                    />
                  ))}
                </p>
                {canPerform && !finalized && (
                  <p>
                    <label htmlFor={`photo-${slot.id}`} className="button-like big">
                      📸 {state?.photos.length ? 'Weiteres Foto' : 'Gesamtfoto aufnehmen (Pflicht)'}
                    </label>
                    <input
                      id={`photo-${slot.id}`}
                      data-testid={`photo-input-${slot.slotNo}`}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      disabled={busy || slot.machine === null}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file !== undefined) void uploadPhoto(slot.id, file);
                        e.target.value = '';
                      }}
                    />
                  </p>
                )}
              </div>
            );
          })}
          {next(allChecked && allPhotos)}
        </div>
      )}

      {step === 4 && (
        <div className="card">
          <h2>5. Kunde oder Vertreter bestimmen</h2>
          <p>
            <label>
              <input
                type="radio"
                name="recipient"
                checked={recipientKind === 'customer'}
                onChange={() => setRecipientKind('customer')}
              />{' '}
              {RECIPIENT_LABELS.customer}: {booking.customerName}
            </label>
          </p>
          {detail.representative !== null && (
            <p>
              <label>
                <input
                  type="radio"
                  name="recipient"
                  checked={recipientKind === 'representative'}
                  onChange={() => setRecipientKind('representative')}
                />{' '}
                {RECIPIENT_LABELS.representative}: {detail.representative.firstName}{' '}
                {detail.representative.lastName}
              </label>
            </p>
          )}
          <p>
            <label>
              <input
                type="radio"
                name="recipient"
                checked={recipientKind === 'other'}
                onChange={() => setRecipientKind('other')}
              />{' '}
              {RECIPIENT_LABELS.other} (vom Mitarbeiter bestätigt)
            </label>
          </p>
          {recipientKind === 'other' && (
            <>
              <label htmlFor="other-name">Name</label>
              <input
                id="other-name"
                value={otherName}
                onChange={(e) => setOtherName(e.target.value)}
              />
              <label htmlFor="other-phone">Telefon (nur wenn betrieblich erforderlich)</label>
              <input
                id="other-phone"
                value={otherPhone}
                onChange={(e) => setOtherPhone(e.target.value)}
              />
            </>
          )}
          <p className="muted">Kein Ausweis, keine Ausweisnummer, kein Ausweisfoto.</p>
          {canPerform && !finalized && (
            <p>
              <button
                className="primary big"
                disabled={busy || (recipientKind === 'other' && otherName.trim() === '')}
                onClick={() =>
                  void run(
                    `/staff/handover/${booking.id}/recipient`,
                    'PUT',
                    {
                      kind: recipientKind,
                      name: recipientKind === 'other' ? otherName.trim() : null,
                      phone:
                        recipientKind === 'other' && otherPhone.trim() !== ''
                          ? otherPhone.trim()
                          : null,
                    },
                    'Empfangsperson gespeichert.',
                  )
                }
              >
                Übernehmen
              </button>
            </p>
          )}
          {handover.recipientName !== null && (
            <p>
              Aktuell: <strong>{handover.recipientName}</strong> (
              {RECIPIENT_LABELS[handover.recipientKind ?? 'customer']})
            </p>
          )}
          {next(recipientSet)}
        </div>
      )}

      {step === 5 && (
        <div className="card">
          <h2>6. Zusammenfassung</h2>
          <ul>
            {slots.map((slot) => (
              <li key={slot.id}>
                {slot.machine?.machineCode ?? '–'} ({slot.productName}) – geprüft, Foto vorhanden
              </li>
            ))}
            {detail.deliveryNote.items
              .filter((item) => item.actualQuantity > 0)
              .map((item) => (
                <li key={item.id}>
                  {item.actualQuantity} {item.unit} {item.description} ({item.kindLabel})
                </li>
              ))}
            <li>Übergabe an: {handover.recipientName ?? '–'}</li>
          </ul>
          {detail.blockers.length > 0 && (
            <div className="conflict-box" data-testid="wizard-blockers">
              <strong>Noch offen:</strong>
              <ul style={{ margin: '0.3rem 0 0 1rem' }}>
                {detail.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          {next(true)}
        </div>
      )}

      {step === 6 && (
        <div className="card">
          <h2>7. Unterschrift Kunde / Vertreter</h2>
          {customerSigned ? (
            <p>
              <span className="badge ok">
                ✓ Unterschrieben von {detail.signatures.customer?.signerName} (
                {formatBerlin(detail.signatures.customer?.signedAt ?? null)})
              </span>
            </p>
          ) : null}
          {canPerform && !finalized && (
            <SignaturePad
              label="Kunde"
              signerName={handover.recipientName ?? '– bitte zuerst Empfänger bestimmen –'}
              disabled={busy || !recipientSet}
              onSubmit={async (png) => {
                await run(
                  `/staff/handover/${booking.id}/signatures/customer`,
                  'PUT',
                  { dataBase64: png },
                  'Kundenunterschrift gespeichert.',
                );
              }}
            />
          )}
          {next(customerSigned)}
        </div>
      )}

      {step === 7 && (
        <div className="card">
          <h2>8. Unterschrift Mitarbeiter</h2>
          {staffSigned ? (
            <p>
              <span className="badge ok">
                ✓ Unterschrieben von {detail.signatures.staff?.signerName} (
                {formatBerlin(detail.signatures.staff?.signedAt ?? null)})
              </span>
            </p>
          ) : null}
          {canPerform && !finalized && (
            <SignaturePad
              label="Mitarbeiter"
              signerName={`${me?.user.firstName ?? ''} ${me?.user.lastName ?? ''}`.trim()}
              disabled={busy}
              onSubmit={async (png) => {
                await run(
                  `/staff/handover/${booking.id}/signatures/staff`,
                  'PUT',
                  { dataBase64: png },
                  'Mitarbeiterunterschrift gespeichert.',
                );
              }}
            />
          )}
          {next(staffSigned)}
        </div>
      )}

      {step === 8 && (
        <div className="card" data-testid="wizard-final">
          <h2>9. Übergabe abschließen</h2>
          {finalized ? (
            <>
              <p>
                <span className="badge ok">
                  ✓ Übergabe abgeschlossen am {formatBerlin(handover.finalizedAt)}
                </span>
              </p>
              <p>
                {documents.map((doc) => (
                  <span key={doc.id}>
                    <a
                      href={`/api/staff/documents/${doc.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="button-like"
                    >
                      {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}
                    </a>{' '}
                  </span>
                ))}
              </p>
              <p className="muted">
                Lieferschein und Übergabeprotokoll sind final und unveränderlich.
              </p>
              {packets.map((packet) => (
                <p key={packet.id} data-testid="delivery-packet">
                  <span className="badge ok">
                    {PACKET_STATUS_LABELS[packet.status] ?? packet.status}
                  </span>{' '}
                  E-Mail-Paket an {packet.recipient !== '' ? packet.recipient : '– (keine E-Mail)'}:{' '}
                  {packet.subject} ({packet.documentIds.length} Dokumente)
                </p>
              ))}
              <p>
                <Link href={`/vorgaenge/${params.id}`} className="button-like primary">
                  Zum Vorgang
                </Link>
              </p>
            </>
          ) : (
            <>
              {detail.blockers.length > 0 && (
                <div className="conflict-box" data-testid="wizard-blockers">
                  <strong>Abschluss noch nicht möglich:</strong>
                  <ul style={{ margin: '0.3rem 0 0 1rem' }}>
                    {detail.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                  {detail.blockers.some((b) => b.startsWith('Lagerbestand')) && (
                    <p style={{ margin: '0.3rem 0 0' }}>
                      <Link href="/lager">Wareneingang erfassen / Inventur prüfen</Link> ·{' '}
                      <Link href={`/vorgaenge/${params.id}/ausgabe`}>Ausgabemenge korrigieren</Link>
                    </p>
                  )}
                </div>
              )}
              {canPerform && (
                <p>
                  <button
                    className="primary big"
                    data-testid="finalize-button"
                    disabled={busy || detail.blockers.length > 0}
                    onClick={() =>
                      void run(
                        `/staff/handover/${booking.id}/finalize`,
                        'POST',
                        {},
                        'Übergabe abgeschlossen.',
                      )
                    }
                  >
                    Übergabe final abschließen
                  </button>{' '}
                  <button className="big" onClick={() => void load()} disabled={busy}>
                    Erneut prüfen
                  </button>
                </p>
              )}
              <p>
                <button onClick={() => setStep(step - 1)} disabled={busy}>
                  Zurück
                </button>
              </p>
            </>
          )}
        </div>
      )}
    </main>
  );
}

export default function HandoverWizardPage() {
  return (
    <AuthGuard>
      <HandoverWizard />
    </AuthGuard>
  );
}
