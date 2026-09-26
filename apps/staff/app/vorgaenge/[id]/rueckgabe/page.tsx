'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../../components/auth-guard';
import { DamageDiagram } from '../../../../components/damage-diagram';
import { QrScanner } from '../../../../components/qr-scanner';
import { SignaturePad } from '../../../../components/signature-pad';
import { apiFetch, hasPermission } from '../../../../lib/api';
import {
  DOCUMENT_TYPE_LABELS,
  fileToBase64,
  formatBerlin,
  formatEuroCents,
  PACKET_STATUS_LABELS,
  type DeliveryPacketView,
} from '../../../../lib/handover';
import {
  ACCESSORY_LABELS,
  RETURNER_LABELS,
  SEVERITY_LABELS,
  type AccessoryType,
  type DamageMarkerShape,
  type DamageSeverity,
  type ReturnDetail,
  type ReturnDocument,
  type ReturnerKind,
  type ReturnMachineView,
} from '../../../../lib/returns';
import { fromBerlinInput, toBerlinInput } from '../../../../lib/scheduling';
import { MACHINE_STATUS_ICONS, type MachineStatus } from '../../../../lib/warehouse';

/**
 * Geführte Rückgabe (Phase-7-Order §§62–64): Tablet-first, eine dominante
 * Hauptaktion je Schritt. 1 Vorgang/Rückgabeperson → 2 Maschinen bestätigen/
 * QR → 3 Zubehör → 4 Entleert/2× gespült/nichts demontiert → 5 Kommission →
 * 6 Schäden/Fehlteile → 7 Zusammenfassung → 8 Unterschrift Kunde →
 * 9 Unterschrift Mitarbeiter → 10 Abschluss. Alle Pflichtprüfungen rechnet
 * der Server (Blocker-Liste); die UI ist kein Berechtigungsschutz.
 */
const STEPS = [
  'Vorgang',
  'Maschinen',
  'Zubehör',
  'Vorbereitung',
  'Kommission',
  'Schäden & Fehlteile',
  'Zusammenfassung',
  'Unterschrift Kunde',
  'Unterschrift Mitarbeiter',
  'Abschluss',
] as const;

interface ProcessReturnResponse {
  detail: ReturnDetail | null;
  bookingId?: string;
  canStart: boolean;
  documents: ReturnDocument[];
}

interface DamageDraft {
  severity: DamageSeverity;
  description: string;
  markers: DamageMarkerShape[];
  markerType: 'point' | 'area';
}

const EMPTY_DRAFT: DamageDraft = {
  severity: 'light',
  description: '',
  markers: [],
  markerType: 'point',
};

function ReturnWizard() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [canStart, setCanStart] = useState(false);
  const [documents, setDocuments] = useState<ReturnDocument[]>([]);
  const [packets, setPackets] = useState<DeliveryPacketView[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [returnerKind, setReturnerKind] = useState<ReturnerKind>('customer');
  const [otherFirst, setOtherFirst] = useState('');
  const [otherLast, setOtherLast] = useState('');
  const [otherPhone, setOtherPhone] = useState('');
  const [missingFor, setMissingFor] = useState<string | null>(null);
  const [missingType, setMissingType] = useState<AccessoryType>('lid');
  const [missingQty, setMissingQty] = useState('1');
  const [missingNote, setMissingNote] = useState('');
  const [cleanChecks, setCleanChecks] = useState<
    Record<string, { emptied: boolean; rinsedTwice: boolean; nothingDismantled: boolean }>
  >({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [damageFor, setDamageFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<DamageDraft>(EMPTY_DRAFT);
  const [actualTime, setActualTime] = useState('');

  const canPerform = hasPermission(me, 'return.perform');
  const canComplete = hasPermission(me, 'return.complete');
  const canDamage = hasPermission(me, 'damage.document');
  const canMissing = hasPermission(me, 'missing_item.create');
  const canCleanupIssue = hasPermission(me, 'return.mark_cleanup_issue');
  const canCorrectTime = hasPermission(me, 'return.correct_actual_time');

  const load = useCallback(async () => {
    const result = await apiFetch<ProcessReturnResponse>(`/staff/processes/${params.id}/return`);
    if (result.data === null) {
      setError(result.errorMessage ?? 'Rückgabe konnte nicht geladen werden.');
      setLoaded(true);
      return;
    }
    setBookingId(result.data.bookingId ?? null);
    setCanStart(result.data.canStart);
    setDocuments(result.data.documents);
    const next = result.data.detail;
    setDetail(next);
    if (next !== null) {
      setReturnerKind(next.return.returnerKind ?? 'customer');
      setQuantities((current) => {
        const merged = { ...current };
        for (const item of next.items) {
          if (merged[item.id] === undefined)
            merged[item.id] = String(item.returnedUnopenedQuantity);
        }
        return merged;
      });
      setCleanChecks((current) => {
        const merged = { ...current };
        for (const machine of next.machines) {
          if (merged[machine.id] === undefined) {
            merged[machine.id] = {
              emptied: machine.emptied ?? true,
              rinsedTwice: machine.rinsedTwice ?? true,
              nothingDismantled: machine.nothingDismantled ?? true,
            };
          }
        }
        return merged;
      });
      if (next.return.status === 'finalized') {
        setStep(STEPS.length - 1);
        const packetResult = await apiFetch<{ packets: DeliveryPacketView[] }>(
          `/staff/processes/${params.id}/delivery-packets`,
        );
        if (packetResult.data !== null) {
          setPackets(
            packetResult.data.packets.filter((packet) => packet.kind === 'return_completed'),
          );
        }
      }
    }
    setLoaded(true);
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

  if (!loaded) {
    return (
      <main className="page">
        <p className="muted">Lade …</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="page wizard-step">
        <p>
          <Link href={`/vorgaenge/${params.id}`}>← Vorgang</Link> ·{' '}
          <Link href="/rueckgabe">Rückgabe-Liste</Link>
        </p>
        <h1>Rückgabe</h1>
        {error !== null && <p className="error">{error}</p>}
        {canStart && bookingId !== null ? (
          <div className="card">
            <p>Für diesen Vorgang sind Maschinen ausgegeben. Die Rückgabe kann jetzt beginnen.</p>
            <button
              className="primary big"
              data-testid="return-start"
              disabled={busy || !canPerform}
              onClick={() =>
                void run(`/staff/returns/${bookingId}/start`, 'POST', {}, 'Rückgabe begonnen.')
              }
            >
              Rückgabe starten
            </button>
            {!canPerform && <p className="muted">Dir fehlt das Recht, Rückgaben durchzuführen.</p>}
          </div>
        ) : (
          <p className="muted">
            Für diesen Vorgang ist noch keine Maschine ausgegeben – eine Rückgabe ist erst nach der
            Ausgabe möglich.
          </p>
        )}
      </main>
    );
  }

  const { booking, machines, items } = detail;
  const ret = detail.return;
  const finalized = ret.status === 'finalized';
  const returnerSet = ret.returnerKind !== null;
  const allAccessories = machines.every((m) => m.accessoryComplete !== null);
  const allCleanliness = machines.every((m) => m.cleanlinessCheckedAt !== null);
  const cleanupPhotosOk = machines.every((m) => !m.cleanupRequired || m.cleanupPhotos.length > 0);
  const damagesComplete = machines.every((m) => m.damages.every((d) => d.photos.length > 0));
  const customerSigned = detail.signatures.customer !== null;
  const staffSigned = detail.signatures.staff !== null;
  const stepDone = [
    returnerSet,
    true,
    allAccessories,
    allCleanliness && cleanupPhotosOk,
    true,
    damagesComplete,
    true,
    customerSigned,
    staffSigned,
    finalized,
  ];
  const editable = canPerform && !finalized;

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
      {/* Eine dominante Hauptaktion je Schritt (Order §62): „Weiter“ ist erst
          primär, wenn die Schrittbedingung erfüllt ist – vorher dominieren die
          Bestätigungen je Maschine. */}
      <button
        className={enabled ? 'primary big' : 'big'}
        onClick={() => setStep(step + 1)}
        disabled={!enabled || busy}
        data-testid="wizard-next"
      >
        {label}
      </button>
    </p>
  );

  async function uploadCleanupPhoto(machine: ReturnMachineView, file: File) {
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    await run(
      `/staff/returns/${booking.id}/machines/${machine.id}/photos`,
      'POST',
      { mimeType: mime, dataBase64: await fileToBase64(file) },
      'Beweisfoto gespeichert.',
    );
  }
  async function uploadDamagePhoto(damageId: string, file: File) {
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    await run(
      `/staff/damages/${damageId}/photos`,
      'POST',
      { mimeType: mime, dataBase64: await fileToBase64(file) },
      'Schadensfoto gespeichert.',
    );
  }

  const machineHeading = (machine: ReturnMachineView) => (
    <h3 style={{ margin: '0 0 0.4rem' }}>
      <span aria-hidden="true">{MACHINE_STATUS_ICONS[machine.machineStatus as MachineStatus]}</span>{' '}
      {machine.machineCode} · {machine.typeName}
    </h3>
  );

  return (
    <main className="page wizard-step">
      <p>
        <Link href={`/vorgaenge/${params.id}`}>← Vorgang {booking.processNumber}</Link> ·{' '}
        <Link href="/rueckgabe">Rückgabe-Liste</Link>
      </p>
      <h1>Rückgabe – {booking.processNumber}</h1>
      {nav}
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      {!canPerform && !finalized && (
        <p className="muted">
          Dir fehlt das Recht, Rückgaben durchzuführen – die Rückgabe ist hier nur einsehbar.
        </p>
      )}

      {step === 0 && (
        <div className="card">
          <h2>1. Vorgang und Rückgabeperson</h2>
          <p>
            Kunde: <strong>{booking.customerName}</strong>
            <br />
            Gebucht: {booking.machineQuantity > 1 ? `${booking.machineQuantity} × ` : ''}
            {booking.machineTypeName ?? 'Maschine'} ·{' '}
            {booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung'}
            <br />
            Rückgabetermin:{' '}
            {ret.appointment === null || ret.appointment.startAt === null
              ? 'nicht geplant'
              : `${formatBerlin(ret.appointment.startAt)} Uhr`}
            {ret.appointment?.overdue === true && (
              <>
                {' '}
                <span className="badge locked">Überfällig</span>
              </>
            )}
          </p>
          <p>
            Ausgegebene Maschinen: <strong>{machines.map((m) => m.machineCode).join(', ')}</strong>
          </p>
          <h3>Wer gibt zurück?</h3>
          {returnerSet && (
            <p>
              <span className="badge ok">✓ {ret.returnerName}</span> (
              {RETURNER_LABELS[ret.returnerKind!]})
            </p>
          )}
          {editable && (
            <>
              {(Object.keys(RETURNER_LABELS) as ReturnerKind[]).map((kind) => (
                <label key={kind} style={{ display: 'block' }}>
                  <input
                    type="radio"
                    name="returner"
                    value={kind}
                    checked={returnerKind === kind}
                    onChange={() => setReturnerKind(kind)}
                    disabled={kind === 'representative' && detail.representative === null}
                    style={{ width: 'auto', marginRight: '0.5rem' }}
                  />
                  {RETURNER_LABELS[kind]}
                  {kind === 'customer' ? ` (${booking.customerName})` : ''}
                  {kind === 'representative' && detail.representative !== null
                    ? ` (${detail.representative.firstName} ${detail.representative.lastName})`
                    : kind === 'representative'
                      ? ' – keine Abholperson hinterlegt'
                      : ''}
                </label>
              ))}
              {returnerKind === 'other' && (
                <div className="grid-2">
                  <label>
                    Vorname
                    <input
                      id="returner-first"
                      value={otherFirst}
                      onChange={(e) => setOtherFirst(e.target.value)}
                    />
                  </label>
                  <label>
                    Nachname
                    <input
                      id="returner-last"
                      value={otherLast}
                      onChange={(e) => setOtherLast(e.target.value)}
                    />
                  </label>
                  <label>
                    Telefon (nur operativ, wird nach Abschluss gelöscht)
                    <input
                      id="returner-phone"
                      value={otherPhone}
                      onChange={(e) => setOtherPhone(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <p>
                <button
                  className="primary big"
                  data-testid="returner-save"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      `/staff/returns/${booking.id}/returner`,
                      'PUT',
                      returnerKind === 'other'
                        ? {
                            kind: 'other',
                            firstName: otherFirst,
                            lastName: otherLast,
                            phone: otherPhone,
                          }
                        : { kind: returnerKind },
                      'Rückgabeperson übernommen.',
                    )
                  }
                >
                  Rückgabeperson übernehmen
                </button>
              </p>
            </>
          )}
          {next(returnerSet)}
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2>2. Maschinen bestätigen</h2>
          {machines.map((machine) => (
            <div
              key={machine.id}
              className="list-row"
              data-testid={`return-machine-${machine.slotNo}`}
            >
              <span>
                <strong>{machine.machineCode}</strong> · {machine.typeName}
              </span>
              <span>
                <span className="badge">
                  {MACHINE_STATUS_ICONS[machine.machineStatus as MachineStatus]}{' '}
                  {machine.machineStatusLabel}
                </span>{' '}
                {editable && (
                  <button className="big" onClick={() => setScanFor(machine.id)} disabled={busy}>
                    📷 Scannen zur Bestätigung
                  </button>
                )}
              </span>
            </div>
          ))}
          {scanFor !== null && (
            <QrScanner<{ machineId: string; machineCode: string }>
              onResolved={(machine) => {
                const expected = machines.find((m) => m.id === scanFor);
                if (expected?.machineId === machine.machineId) {
                  setNotice(`Maschine ${machine.machineCode} bestätigt.`);
                  setError(null);
                } else {
                  setError(
                    `Gescannt: ${machine.machineCode} – das ist nicht die erwartete Maschine dieses Vorgangs.`,
                  );
                }
                setScanFor(null);
              }}
              onClose={() => setScanFor(null)}
            />
          )}
          {next(true)}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>3. Zubehör prüfen</h2>
          <p className="muted">
            Pflichtkontrolle je Maschine: 1 Behälter = 1 Deckel + 1 Tropfschale, 2 Behälter = 2 + 2.
          </p>
          {machines.map((machine) => (
            <div key={machine.id} className="card" data-testid={`accessory-${machine.slotNo}`}>
              {machineHeading(machine)}
              <p>
                Soll: {machine.expectedLids} × Deckel, {machine.expectedDripTrays} × Tropfschale
                {machine.expectedDripTrays === 1 ? '' : 'n'}
              </p>
              {machine.accessoryComplete === true && (
                <p>
                  <span className="badge ok">✓ Zubehör vollständig</span>
                </p>
              )}
              {machine.missingCases.length > 0 && (
                <ul>
                  {machine.missingCases.map((missing) => (
                    <li key={missing.id} data-testid={`missing-${missing.id}`}>
                      <span className="badge locked">Fehlteil</span> {missing.missingQuantity} ×{' '}
                      {missing.accessoryLabel}
                      {missing.description !== null ? ` – ${missing.description}` : ''}
                      {editable && canMissing && (
                        <>
                          {' '}
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(
                                `/staff/returns/${booking.id}/missing/${missing.id}`,
                                'DELETE',
                                undefined,
                                'Fehlteil entfernt.',
                              )
                            }
                          >
                            Entfernen
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {editable && (
                <p>
                  {machine.accessoryComplete !== true && machine.missingCases.length === 0 && (
                    <button
                      className="primary big"
                      data-testid={`accessory-complete-${machine.slotNo}`}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          `/staff/returns/${booking.id}/machines/${machine.id}/accessories`,
                          'POST',
                          { complete: true },
                          'Zubehör vollständig bestätigt.',
                        )
                      }
                    >
                      Zubehör vollständig
                    </button>
                  )}{' '}
                  {canMissing && (
                    <button
                      className="big"
                      onClick={() => setMissingFor(machine.id)}
                      disabled={busy}
                    >
                      Fehlteil erfassen
                    </button>
                  )}
                </p>
              )}
              {missingFor === machine.id && (
                <div className="conflict-box" data-testid={`missing-form-${machine.slotNo}`}>
                  <label>
                    Zubehörtyp
                    <select
                      id="missing-type"
                      value={missingType}
                      onChange={(e) => setMissingType(e.target.value as AccessoryType)}
                    >
                      {(Object.keys(ACCESSORY_LABELS) as AccessoryType[]).map((type) => (
                        <option key={type} value={type}>
                          {ACCESSORY_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Fehlende Menge
                    <input
                      id="missing-qty"
                      type="number"
                      min={1}
                      value={missingQty}
                      onChange={(e) => setMissingQty(e.target.value)}
                    />
                  </label>
                  <label>
                    Beschreibung (optional)
                    <input
                      id="missing-note"
                      value={missingNote}
                      onChange={(e) => setMissingNote(e.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    data-testid="missing-save"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/staff/returns/${booking.id}/machines/${machine.id}/missing`,
                        'POST',
                        {
                          accessoryType: missingType,
                          missingQuantity: Number(missingQty),
                          description: missingNote.trim() === '' ? null : missingNote.trim(),
                        },
                        'Fehlteil erfasst – finanzielle Klärung später erforderlich.',
                      ).then((ok) => {
                        if (ok) {
                          setMissingFor(null);
                          setMissingNote('');
                          setMissingQty('1');
                        }
                      })
                    }
                  >
                    Fehlteil speichern
                  </button>{' '}
                  <button onClick={() => setMissingFor(null)}>Abbrechen</button>
                </div>
              )}
            </div>
          ))}
          {next(allAccessories)}
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2>4. Rückgabevorbereitung des Kunden</h2>
          <p className="muted">
            Je Maschine: entleert, zweimal mit Wasser gespült, nichts demontiert. Kleine
            unvermeidbare Restmengen sind kein Grund für eine Gebühr – der Mitarbeiter entscheidet.
          </p>
          {machines.map((machine) => {
            const checks = cleanChecks[machine.id] ?? {
              emptied: true,
              rinsedTwice: true,
              nothingDismantled: true,
            };
            const anyFalse = !checks.emptied || !checks.rinsedTwice || !checks.nothingDismantled;
            return (
              <div key={machine.id} className="card" data-testid={`cleanliness-${machine.slotNo}`}>
                {machineHeading(machine)}
                {(
                  [
                    ['emptied', 'Maschine entleert'],
                    ['rinsedTwice', 'Zweimal mit Wasser gespült'],
                    ['nothingDismantled', 'Nichts demontiert'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} style={{ display: 'block' }}>
                    <input
                      type="checkbox"
                      checked={checks[key]}
                      disabled={!editable}
                      data-testid={`clean-${key}-${machine.slotNo}`}
                      onChange={(e) =>
                        setCleanChecks((current) => ({
                          ...current,
                          [machine.id]: { ...checks, [key]: e.target.checked },
                        }))
                      }
                      style={{ width: 'auto', marginRight: '0.5rem' }}
                    />
                    {label}
                  </label>
                ))}
                {machine.cleanlinessCheckedAt !== null &&
                  (machine.cleanupRequired ? (
                    <div className="conflict-box" data-testid={`cleanup-fact-${machine.slotNo}`}>
                      <strong>
                        Reinigungsgebühr-Fakt: {formatEuroCents(machine.cleanupFeeCents ?? 0)}
                      </strong>{' '}
                      – {machine.cleanupReason} (kein Rechnungsbetrag, Abrechnung folgt später)
                      <br />
                      Beweisfoto:{' '}
                      {machine.cleanupPhotos.length === 0
                        ? 'fehlt (Pflicht)'
                        : `${machine.cleanupPhotos.length} vorhanden`}
                      {machine.cleanupPhotos.map((photo) => (
                        <img
                          key={photo.id}
                          className="photo-thumb"
                          src={`/api/staff/returns/photos/${photo.id}`}
                          alt="Beweisfoto"
                          style={{ display: 'block', marginTop: '0.4rem' }}
                        />
                      ))}
                      {editable && (
                        <p>
                          <label
                            htmlFor={`cleanup-photo-${machine.id}`}
                            className="button-like big"
                          >
                            📸 Beweisfoto aufnehmen / auswählen
                          </label>
                          <input
                            id={`cleanup-photo-${machine.id}`}
                            data-testid={`cleanup-photo-input-${machine.slotNo}`}
                            type="file"
                            accept="image/jpeg,image/png"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file !== undefined) void uploadCleanupPhoto(machine, file);
                              e.target.value = '';
                            }}
                          />
                        </p>
                      )}
                    </div>
                  ) : (
                    <p>
                      <span className="badge ok">✓ Ordnungsgemäß vorbereitet – keine Gebühr</span>
                    </p>
                  ))}
                {editable && (
                  <p>
                    <button
                      className="primary big"
                      data-testid={`cleanliness-confirm-${machine.slotNo}`}
                      disabled={busy || (anyFalse && !canCleanupIssue)}
                      onClick={() =>
                        void run(
                          `/staff/returns/${booking.id}/machines/${machine.id}/cleanliness`,
                          'POST',
                          checks,
                          anyFalse
                            ? 'Reinigungsgebühr-Fakt gespeichert – Beweisfoto erforderlich.'
                            : 'Vorbereitung bestätigt.',
                        )
                      }
                    >
                      Prüfung bestätigen
                    </button>
                    {anyFalse && !canCleanupIssue && (
                      <span className="muted">
                        {' '}
                        Dir fehlt das Recht, Reinigungsmängel zu erfassen.
                      </span>
                    )}
                  </p>
                )}
              </div>
            );
          })}
          {next(allCleanliness && cleanupPhotosOk)}
        </div>
      )}

      {step === 4 && (
        <div className="card">
          <h2>5. Kommissionsrückgabe</h2>
          <p className="muted">
            Nur die UNGEÖFFNET zurückgegebene Menge eintragen – verbraucht/abrechenbar rechnet das
            System aus der tatsächlichen Ausgabe. Kaufartikel (Kanister) bleiben beim Kunden.
          </p>
          {items.length === 0 && <p className="muted">Keine rückgabefähigen Artikel ausgegeben.</p>}
          {items.map((item) => (
            <div key={item.id} className="list-row" data-testid={`return-item-${item.id}`}>
              <span>
                <strong>{item.description}</strong> <span className="badge">{item.kindLabel}</span>
                <br />
                <span className="muted">
                  Ausgegeben: {item.issuedQuantity} {item.unit}
                  {item.kind === 'commission'
                    ? ` · verbraucht/abrechenbar: ${item.chargeableQuantity} (${formatEuroCents(item.chargeableAmountCents)} vorläufig)`
                    : ' · inklusive, keine Berechnung'}
                </span>
              </span>
              <span>
                <label htmlFor={`qty-${item.id}`}>Ungeöffnet zurück</label>
                <input
                  id={`qty-${item.id}`}
                  type="number"
                  min={0}
                  max={item.issuedQuantity}
                  step={1}
                  value={quantities[item.id] ?? String(item.returnedUnopenedQuantity)}
                  disabled={!editable}
                  onChange={(e) =>
                    setQuantities((current) => ({ ...current, [item.id]: e.target.value }))
                  }
                  style={{ width: '6rem' }}
                />{' '}
                {editable && (
                  <button
                    disabled={busy}
                    data-testid={`qty-save-${item.id}`}
                    onClick={() =>
                      void run(
                        `/staff/returns/${booking.id}/items/${item.id}`,
                        'PATCH',
                        {
                          returnedUnopenedQuantity: Number(
                            quantities[item.id] ?? item.returnedUnopenedQuantity,
                          ),
                        },
                        'Rückgabemenge übernommen.',
                      )
                    }
                  >
                    Übernehmen
                  </button>
                )}
              </span>
            </div>
          ))}
          {next(true)}
        </div>
      )}

      {step === 5 && (
        <div className="card">
          <h2>6. Schäden dokumentieren</h2>
          <p className="muted">
            Je Schaden: Ansicht wählen, Punkt/Bereich markieren, Schweregrad, Beschreibung, Foto.
            Schäden sind Dokumentation – kein Betrag (finanzielle Klärung erfolgt später).
          </p>
          {machines.map((machine) => (
            <div key={machine.id} className="card" data-testid={`damages-${machine.slotNo}`}>
              {machineHeading(machine)}
              {machine.damages.length === 0 && <p className="muted">Kein neuer Schaden erfasst.</p>}
              {machine.damages.map((damage) => (
                <div key={damage.id} className="conflict-box" data-testid={`damage-${damage.id}`}>
                  <strong>{damage.severityLabel}</strong>: {damage.description}{' '}
                  <span className="muted">
                    ({damage.markers.length} Markierung{damage.markers.length === 1 ? '' : 'en'},{' '}
                    {damage.photos.length} Foto{damage.photos.length === 1 ? '' : 's'})
                  </span>
                  <DamageDiagram
                    markers={damage.markers}
                    compact
                    productSlug={damage.productSlug}
                    testId={`damage-${damage.id}-diagram`}
                  />
                  {damage.photos.map((photo) => (
                    <img
                      key={photo.id}
                      className="photo-thumb"
                      src={`/api/staff/damages/photos/${photo.id}`}
                      alt="Schadensfoto"
                      style={{ marginRight: '0.4rem' }}
                    />
                  ))}
                  {damage.photos.length === 0 && (
                    <p className="error">Mindestens ein Foto ist Pflicht.</p>
                  )}
                  {editable && canDamage && (
                    <p>
                      <label htmlFor={`damage-photo-${damage.id}`} className="button-like big">
                        📸 Foto aufnehmen / auswählen
                      </label>
                      <input
                        id={`damage-photo-${damage.id}`}
                        data-testid={`damage-photo-input-${damage.id}`}
                        type="file"
                        accept="image/jpeg,image/png"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file !== undefined) void uploadDamagePhoto(damage.id, file);
                          e.target.value = '';
                        }}
                      />{' '}
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(
                            `/staff/returns/${booking.id}/damages/${damage.id}`,
                            'DELETE',
                            undefined,
                            'Schaden entfernt.',
                          )
                        }
                      >
                        Schaden entfernen
                      </button>
                    </p>
                  )}
                </div>
              ))}
              {editable && canDamage && damageFor !== machine.id && (
                <p>
                  <button
                    className="primary big"
                    data-testid={`damage-add-${machine.slotNo}`}
                    disabled={busy}
                    onClick={() => {
                      setDraft(EMPTY_DRAFT);
                      setDamageFor(machine.id);
                    }}
                  >
                    Schaden erfassen
                  </button>
                </p>
              )}
              {damageFor === machine.id && (
                <div className="card" data-testid={`damage-form-${machine.slotNo}`}>
                  <h4 style={{ marginTop: 0 }}>Neuer Schaden an {machine.machineCode}</h4>
                  <p>
                    <button
                      type="button"
                      className={draft.markerType === 'point' ? 'primary' : ''}
                      onClick={() => setDraft({ ...draft, markerType: 'point' })}
                    >
                      Punkt
                    </button>{' '}
                    <button
                      type="button"
                      className={draft.markerType === 'area' ? 'primary' : ''}
                      onClick={() => setDraft({ ...draft, markerType: 'area' })}
                    >
                      Bereich
                    </button>
                  </p>
                  <DamageDiagram
                    markers={draft.markers}
                    editable
                    productSlug={machine.productSlug}
                    markerType={draft.markerType}
                    onAddMarker={(marker) =>
                      setDraft({ ...draft, markers: [...draft.markers, marker] })
                    }
                    onRemoveMarker={(index) =>
                      setDraft({ ...draft, markers: draft.markers.filter((_, i) => i !== index) })
                    }
                    testId="damage-diagram"
                  />
                  <label>
                    Schweregrad
                    <select
                      id="damage-severity"
                      value={draft.severity}
                      onChange={(e) =>
                        setDraft({ ...draft, severity: e.target.value as DamageSeverity })
                      }
                    >
                      {(Object.keys(SEVERITY_LABELS) as DamageSeverity[]).map((severity) => (
                        <option key={severity} value={severity}>
                          {SEVERITY_LABELS[severity]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Beschreibung (Pflicht)
                    <textarea
                      id="damage-description"
                      rows={2}
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </label>
                  <p>
                    <button
                      className="primary big"
                      data-testid="damage-save"
                      disabled={
                        busy || draft.markers.length === 0 || draft.description.trim() === ''
                      }
                      onClick={() =>
                        void run(
                          `/staff/returns/${booking.id}/machines/${machine.id}/damages`,
                          'POST',
                          {
                            severity: draft.severity,
                            description: draft.description.trim(),
                            markers: draft.markers,
                          },
                          'Schaden gespeichert – bitte jetzt mindestens ein Foto aufnehmen.',
                        ).then((ok) => {
                          if (ok) {
                            setDamageFor(null);
                            setDraft(EMPTY_DRAFT);
                          }
                        })
                      }
                    >
                      Schaden speichern
                    </button>{' '}
                    <button className="big" onClick={() => setDamageFor(null)}>
                      Abbrechen
                    </button>
                  </p>
                </div>
              )}
            </div>
          ))}
          {next(damagesComplete)}
        </div>
      )}

      {step === 6 && (
        <div className="card" data-testid="return-summary">
          <h2>7. Zusammenfassung</h2>
          {detail.summary.withoutComplaint ? (
            <p>
              <span className="badge ok" style={{ fontSize: '1.1rem' }}>
                ✓ Rückgabe ohne Beanstandung
              </span>
            </p>
          ) : (
            <ul>
              {detail.summary.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            Rückgabeperson: {ret.returnerName ?? '–'} · Rückgabezeit:{' '}
            {ret.draftActualReturnAt === null
              ? 'Zeitpunkt des Abschlusses'
              : `${formatBerlin(ret.draftActualReturnAt)} Uhr (korrigiert)`}
          </p>
          {editable && canCorrectTime && (
            <p>
              <label htmlFor="actual-return-time">
                Tatsächliche Rückgabezeit korrigieren (optional)
              </label>
              <input
                id="actual-return-time"
                type="datetime-local"
                value={actualTime}
                onChange={(e) => setActualTime(e.target.value)}
              />{' '}
              <button
                disabled={busy || actualTime === ''}
                onClick={() =>
                  void run(
                    `/staff/returns/${booking.id}/actual-return-time`,
                    'PUT',
                    { actualReturnAt: fromBerlinInput(actualTime) },
                    'Rückgabezeit übernommen.',
                  )
                }
              >
                Zeit übernehmen
              </button>
            </p>
          )}
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
          {next(true, 'Weiter zu den Unterschriften')}
        </div>
      )}

      {step === 7 && (
        <div className="card">
          <h2>8. Unterschrift Kunde / Vertreter</h2>
          {customerSigned && (
            <p>
              <span className="badge ok">
                ✓ Unterschrieben von {detail.signatures.customer!.signerName}
              </span>{' '}
              <span className="muted">{formatBerlin(detail.signatures.customer!.signedAt)}</span>
            </p>
          )}
          {editable && (
            <SignaturePad
              label="Kunde"
              signerName={ret.returnerName ?? '– bitte zuerst die Rückgabeperson bestimmen –'}
              disabled={busy || !returnerSet}
              onSubmit={async (png) => {
                await run(
                  `/staff/returns/${booking.id}/signatures/customer`,
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

      {step === 8 && (
        <div className="card">
          <h2>9. Unterschrift Mitarbeiter</h2>
          {staffSigned && (
            <p>
              <span className="badge ok">
                ✓ Unterschrieben von {detail.signatures.staff!.signerName}
              </span>
            </p>
          )}
          {editable && (
            <SignaturePad
              label="Mitarbeiter"
              signerName={`${me?.user.firstName ?? ''} ${me?.user.lastName ?? ''}`.trim()}
              disabled={busy}
              onSubmit={async (png) => {
                await run(
                  `/staff/returns/${booking.id}/signatures/staff`,
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

      {step === 9 && (
        <div className="card" data-testid="wizard-final">
          <h2>10. Rückgabe abschließen</h2>
          {finalized ? (
            <>
              <p>
                <span className="badge ok">
                  ✓ Rückgabe abgeschlossen am {formatBerlin(ret.finalizedAt)}
                </span>
              </p>
              <p>
                Tatsächliche Rückgabezeit: {formatBerlin(ret.actualReturnAt)} Uhr
                {ret.correctedActualReturnAt !== null ? ' (korrigiert)' : ''} · Maschinen jetzt 🟡
                Reinigung im Lager.
              </p>
              <p>
                {documents.map((doc) => (
                  <a
                    key={doc.id}
                    href={`/api/staff/documents/${doc.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="button-like"
                  >
                    {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}
                  </a>
                ))}
              </p>
              {packets.map((packet) => (
                <p key={packet.id} data-testid="return-packet">
                  <span className="badge ok">
                    {PACKET_STATUS_LABELS[packet.status] ?? packet.status}
                  </span>{' '}
                  E-Mail-Paket an {packet.recipient !== '' ? packet.recipient : '– (keine E-Mail)'}:{' '}
                  {packet.subject}
                </p>
              ))}
              {canCorrectTime && (
                <p>
                  <label htmlFor="corrected-return-time">
                    Tatsächliche Rückgabezeit nachträglich korrigieren
                  </label>
                  <input
                    id="corrected-return-time"
                    type="datetime-local"
                    value={actualTime === '' ? toBerlinInput(ret.actualReturnAt) : actualTime}
                    onChange={(e) => setActualTime(e.target.value)}
                  />{' '}
                  <button
                    disabled={busy || actualTime === ''}
                    onClick={() =>
                      void run(
                        `/staff/returns/${booking.id}/actual-return-time`,
                        'PUT',
                        { actualReturnAt: fromBerlinInput(actualTime) },
                        'Rückgabezeit korrigiert – das unterschriebene Protokoll bleibt unverändert.',
                      )
                    }
                  >
                    Korrektur speichern
                  </button>
                </p>
              )}
              <p>
                <Link href={`/vorgaenge/${params.id}`} className="button-like primary">
                  Zum Vorgang
                </Link>{' '}
                <Link href="/maschinen" className="button-like">
                  Zu den Maschinen (Reinigung)
                </Link>
              </p>
            </>
          ) : (
            <>
              {detail.blockers.length > 0 ? (
                <div className="conflict-box" data-testid="wizard-blockers">
                  <strong>Abschluss noch nicht möglich:</strong>
                  <ul style={{ margin: '0.3rem 0 0 1rem' }}>
                    {detail.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>
                  Alle Pflichtprüfungen sind erfüllt. Mit dem Abschluss werden Maschinen auf
                  Reinigung gesetzt, die Lagerrücknahme gebucht und das Rückgabeprotokoll erzeugt.
                </p>
              )}
              <p>
                <button
                  className="primary big"
                  data-testid="finalize-button"
                  disabled={busy || detail.blockers.length > 0 || !canComplete}
                  onClick={() =>
                    void run(
                      `/staff/returns/${booking.id}/finalize`,
                      'POST',
                      {},
                      'Rückgabe abgeschlossen.',
                    )
                  }
                >
                  Rückgabe final abschließen
                </button>{' '}
                <button className="big" onClick={() => void load()} disabled={busy}>
                  Erneut prüfen
                </button>
              </p>
              {!canComplete && (
                <p className="muted">Dir fehlt das Recht, Rückgaben final abzuschließen.</p>
              )}
              <p>
                <button className="big" onClick={() => setStep(step - 1)} disabled={busy}>
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

export default function ReturnWizardPage() {
  return (
    <AuthGuard>
      <ReturnWizard />
    </AuthGuard>
  );
}
