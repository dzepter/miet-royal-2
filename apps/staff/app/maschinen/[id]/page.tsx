'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/commerce';
import { DamageDiagram } from '../../../components/damage-diagram';
import { fileToBase64 } from '../../../lib/handover';
import {
  SEVERITY_LABELS,
  type DamageMarkerShape,
  type DamageSeverity,
  type MachineCondition,
} from '../../../lib/returns';
import { fromBerlinInput } from '../../../lib/scheduling';
import {
  MACHINE_LOCATION_LABELS,
  MACHINE_STATUS_ICONS,
  MACHINE_STATUS_LABELS,
  MANUAL_MACHINE_STATUSES,
  type MachineBlockRow,
  type MachineDetail,
  type MachineLocationKind,
  type MachineStatus,
} from '../../../lib/warehouse';

interface DetailResponse {
  machine: MachineDetail;
  blocks: MachineBlockRow[];
  availability: { status: string; reasons: string[]; notFullyCheckable: boolean };
}

/**
 * Maschinendetail (Order §24): Stammdaten, Status, Standort, Sperren,
 * Referenzfoto/Platzhalter, QR und aktuelle Verfügbarkeitswarnung; Phase 7:
 * aktuelle Schäden, Reinigungsabschluss/24-h-Warnung, nachträgliche
 * Feststellung, technischer Defekt, offene Fehlteile – ohne Historienlisten.
 */
function MachineDetailView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusChoice, setStatusChoice] = useState<MachineStatus>('ready');
  const [locationChoice, setLocationChoice] = useState<MachineLocationKind>('warehouse');
  const [locationNote, setLocationNote] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [weightGrams, setWeightGrams] = useState('');
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [blockWarnings, setBlockWarnings] = useState<string[]>([]);
  const [qr, setQr] = useState<{
    token: string;
    url: string | null;
    baseConfigured: boolean;
  } | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [condition, setCondition] = useState<MachineCondition | null>(null);
  const [findingOpen, setFindingOpen] = useState(false);
  const [findingSeverity, setFindingSeverity] = useState<DamageSeverity>('light');
  const [findingDescription, setFindingDescription] = useState('');
  const [findingMarkers, setFindingMarkers] = useState<DamageMarkerShape[]>([]);
  const [findingPhoto, setFindingPhoto] = useState<File | null>(null);
  const [defectPhoto, setDefectPhoto] = useState<File | null>(null);
  const [defectDescription, setDefectDescription] = useState('');
  const [defectHint, setDefectHint] = useState<string | null>(null);
  const canCleanComplete = hasPermission(me, 'machine.clean_complete');
  const canResolveDamage = hasPermission(me, 'damage.resolve_current');
  const canDocumentDamage = hasPermission(me, 'damage.document');
  const canResolveMissing = hasPermission(me, 'missing_item.resolve');

  const canStatus = hasPermission(me, 'machine.change_status');
  const canLocation = hasPermission(me, 'machine.change_location');
  const canManage = hasPermission(me, 'machine.manage');
  const canBlock = hasPermission(me, 'machine.block');
  const canPhoto = hasPermission(me, 'machine.replace_reference_photo');
  const canQr = hasPermission(me, 'machine.qr');

  const load = useCallback(async () => {
    const result = await apiFetch<DetailResponse>(`/staff/machines/${params.id}`);
    if (result.data !== null) {
      setData(result.data);
      setStatusChoice(
        MANUAL_MACHINE_STATUSES.includes(result.data.machine.status)
          ? result.data.machine.status
          : 'ready',
      );
      setLocationChoice(result.data.machine.locationKind);
      setLocationNote(result.data.machine.locationNote ?? '');
      setPurchaseDate(result.data.machine.purchaseDate ?? '');
      setWeightGrams(
        result.data.machine.weightGrams === null ? '' : String(result.data.machine.weightGrams),
      );
      setError(null);
    } else {
      setError(result.errorMessage ?? 'Maschine konnte nicht geladen werden.');
    }
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadCondition = useCallback(async () => {
    const result = await apiFetch<MachineCondition>(`/staff/machines/${params.id}/condition`);
    if (result.data !== null) setCondition(result.data);
  }, [params.id]);
  useEffect(() => {
    void loadCondition();
  }, [loadCondition]);

  useEffect(() => {
    if (!canQr) return;
    void apiFetch<{ token: string; url: string | null; baseConfigured: boolean }>(
      `/staff/machines/${params.id}/qr`,
    ).then((result) => {
      if (result.data !== null) setQr(result.data);
    });
  }, [canQr, params.id]);

  useEffect(() => {
    if (qr === null || qr.url === null) {
      setQrImage(null);
      return;
    }
    void QRCode.toDataURL(qr.url, { margin: 1, width: 240 }).then(setQrImage);
  }, [qr]);

  async function run(path: string, body?: unknown, method = 'POST'): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await apiFetch(path, { method, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
      return false;
    }
    await load();
    await loadCondition();
    return true;
  }

  async function submitFinding(): Promise<void> {
    if (findingPhoto === null) {
      setError('Für einen nachträglich festgestellten Schaden ist ein Foto Pflicht.');
      return;
    }
    const mime = findingPhoto.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const ok = await run(`/staff/machines/${params.id}/damages`, {
      severity: findingSeverity,
      description: findingDescription.trim(),
      markers: findingMarkers,
      photo: { mimeType: mime, dataBase64: await fileToBase64(findingPhoto) },
    });
    if (ok) {
      setNotice(
        'Nachträglicher Schaden dokumentiert – das unterschriebene Rückgabeprotokoll bleibt unverändert.',
      );
      setFindingOpen(false);
      setFindingDescription('');
      setFindingMarkers([]);
      setFindingPhoto(null);
    }
  }

  if (data === null) {
    return (
      <main className="page">
        <p>
          <Link href="/maschinen">← Maschinen</Link>
        </p>
        {error !== null ? <p className="error">{error}</p> : <p className="muted">Lade …</p>}
      </main>
    );
  }
  const { machine, blocks, availability } = data;

  return (
    <main className="page">
      <p>
        <Link href="/maschinen">← Maschinen</Link>
      </p>
      <h1>{machine.machineCode}</h1>
      <p className="muted">{machine.productName}</p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}

      <div className="card">
        <p>
          Status:{' '}
          <span className="badge">
            <span aria-hidden="true">{MACHINE_STATUS_ICONS[machine.status]}</span>{' '}
            {machine.statusLabel}
          </span>
          <br />
          Standort: {machine.locationLabel}
          {machine.locationNote !== null ? ` – ${machine.locationNote}` : ''}
          <br />
          Kaufdatum: {machine.purchaseDate ?? 'unbekannt'}
          <br />
          Gewicht:{' '}
          {machine.weightGrams === null
            ? 'unbekannt'
            : `${(machine.weightGrams / 1000).toLocaleString('de-DE')} kg`}
          <br />
          Tragepersonen: {machine.carryPersons ?? '–'}
        </p>
        {(availability.reasons.length > 0 || availability.status !== 'available') && (
          <div className="conflict-box" data-testid="availability-warning">
            <strong>Verfügbarkeitshinweise (nächste 14 Tage):</strong>
            {availability.reasons.length === 0 ? (
              <p className="muted">Kapazität aktuell ohne freie Reserve.</p>
            ) : (
              availability.reasons.map((reason) => <p key={reason}>{reason}</p>)
            )}
          </div>
        )}
      </div>

      {condition !== null && condition.cleaning.active && (
        <div
          className={`conflict-box${condition.cleaning.overdue ? ' cleaning-warning' : ''}`}
          data-testid="cleaning-card"
        >
          <strong>
            {condition.cleaning.overdue ? '⚠️ ' : '🧽 '}
            In Reinigung seit {formatBerlin(condition.cleaning.since)}
            {condition.cleaning.overdue ? ' – länger als 24 Stunden!' : ''}
          </strong>
          {canCleanComplete && (
            <p style={{ margin: '0.5rem 0 0' }}>
              <button
                className="primary"
                data-testid="clean-complete-button"
                disabled={busy}
                onClick={() =>
                  void run(`/staff/machines/${machine.id}/clean-complete`).then((ok) => {
                    if (ok) setNotice('Maschine ist gereinigt und einsatzbereit.');
                  })
                }
              >
                Gereinigt &amp; einsatzbereit
              </button>
            </p>
          )}
        </div>
      )}
      {condition !== null &&
        !condition.cleaning.active &&
        condition.cleaning.cleanedAt !== null && (
          <p className="muted" data-testid="cleaned-meta">
            Zuletzt gereinigt am {formatBerlin(condition.cleaning.cleanedAt)} (administrativer
            Hinweis)
          </p>
        )}

      <div className="card" data-testid="current-damages">
        <h2>Aktuelle Schäden</h2>
        {condition === null ? (
          <p className="muted">Lade …</p>
        ) : condition.currentDamages.length === 0 ? (
          <p className="muted">Keine aktuellen Schäden.</p>
        ) : (
          condition.currentDamages.map((damage) => (
            <div
              key={damage.id}
              className="conflict-box"
              data-testid={`current-damage-${damage.id}`}
            >
              <strong>{damage.severityLabel}</strong>: {damage.description}{' '}
              <span className="muted">
                (
                {damage.origin === 'post_return_finding'
                  ? 'nachträglich festgestellt'
                  : 'bei Rückgabe'}{' '}
                · {formatBerlin(damage.createdAt)})
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
                  alt="Schadensfoto (intern)"
                  style={{ marginRight: '0.4rem' }}
                />
              ))}
              {canResolveDamage && (
                <p style={{ margin: '0.5rem 0 0' }}>
                  <button
                    data-testid={`resolve-damage-${damage.id}`}
                    disabled={busy}
                    onClick={() =>
                      void run(`/staff/damages/${damage.id}/resolve`).then((ok) => {
                        if (ok)
                          setNotice(
                            'Schaden als nicht mehr aktuell markiert (historisch bleibt er erhalten).',
                          );
                      })
                    }
                  >
                    Nicht mehr aktuell
                  </button>
                </p>
              )}
            </div>
          ))
        )}
        {condition?.postReturnFindingOpen === true && canDocumentDamage && (
          <div data-testid="post-return-damage">
            {!findingOpen ? (
              <p>
                <button data-testid="post-return-damage-open" onClick={() => setFindingOpen(true)}>
                  Nachträglich entdeckten Schaden ergänzen
                </button>
              </p>
            ) : (
              <div className="card">
                <h3 style={{ marginTop: 0 }}>Nachträglicher Schaden zum letzten Rückgabevorgang</h3>
                <DamageDiagram
                  markers={findingMarkers}
                  editable
                  productSlug={condition?.productSlug}
                  onAddMarker={(marker) => setFindingMarkers((current) => [...current, marker])}
                  onRemoveMarker={(index) =>
                    setFindingMarkers((current) => current.filter((_, i) => i !== index))
                  }
                  testId="finding-diagram"
                />
                <label>
                  Schweregrad
                  <select
                    id="finding-severity"
                    value={findingSeverity}
                    onChange={(event) => setFindingSeverity(event.target.value as DamageSeverity)}
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
                    id="finding-description"
                    rows={2}
                    value={findingDescription}
                    onChange={(event) => setFindingDescription(event.target.value)}
                  />
                </label>
                <label>
                  Foto (Pflicht, Kamera oder Galerie)
                  <input
                    id="finding-photo"
                    data-testid="finding-photo-input"
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={(event) => setFindingPhoto(event.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  className="primary"
                  data-testid="finding-save"
                  disabled={
                    busy ||
                    findingMarkers.length === 0 ||
                    findingDescription.trim() === '' ||
                    findingPhoto === null
                  }
                  onClick={() => void submitFinding()}
                >
                  Schaden speichern
                </button>{' '}
                <button onClick={() => setFindingOpen(false)}>Abbrechen</button>
              </div>
            )}
          </div>
        )}
      </div>

      {condition !== null && condition.openMissingCases.length > 0 && (
        <div className="card" data-testid="open-missing-cases">
          <h2>Offene Fehlteile</h2>
          {condition.openMissingCases.map((missing) => (
            <div key={missing.id} className="list-row" data-testid={`missing-case-${missing.id}`}>
              <span>
                {missing.missingQuantity} × {missing.accessoryLabel} · Vorgang{' '}
                <Link href={`/vorgaenge/${missing.processId}`}>{missing.processNumber}</Link>
                {missing.description !== null ? ` · ${missing.description}` : ''}{' '}
                <span className="badge locked">finanzielle Klärung offen</span>
              </span>
              {canResolveMissing && (
                <button
                  disabled={busy}
                  data-testid={`resolve-missing-${missing.id}`}
                  onClick={() =>
                    void run(`/staff/missing-items/${missing.id}/resolve`).then((ok) => {
                      if (ok) setNotice('Fehlteil erledigt.');
                    })
                  }
                >
                  Erledigt
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {condition !== null &&
        (condition.defectLinkOpen || condition.technicalDefects.length > 0) && (
          <div className="card" data-testid="technical-defects">
            <h2>Technischer Defekt (intern)</h2>
            {condition.technicalDefects.map((defect) => (
              <p key={defect.id} className="muted">
                {formatBerlin(defect.occurredAt)}: {defect.description}
                {defect.hasPhoto ? ' · Foto vorhanden' : ''} – keine Kundenbelastung
              </p>
            ))}
            {defectHint !== null && <p className="success">{defectHint}</p>}
            {condition.defectLinkOpen && canStatus && (
              <>
                <label>
                  Beschreibung
                  <input
                    id="defect-description"
                    value={defectDescription}
                    onChange={(event) => setDefectDescription(event.target.value)}
                  />
                </label>
                <label>
                  Foto (optional, Kamera oder Galerie)
                  <input
                    id="defect-photo"
                    data-testid="defect-photo-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => setDefectPhoto(event.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  data-testid="defect-save"
                  disabled={busy || defectDescription.trim() === ''}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      setError(null);
                      const mime =
                        defectPhoto?.type === 'image/png'
                          ? 'image/png'
                          : defectPhoto?.type === 'image/webp'
                            ? 'image/webp'
                            : 'image/jpeg';
                      const result = await apiFetch<{ hint: string }>(
                        `/staff/machines/${machine.id}/technical-defects`,
                        {
                          method: 'POST',
                          body: {
                            description: defectDescription.trim(),
                            photo:
                              defectPhoto === null
                                ? null
                                : { mimeType: mime, dataBase64: await fileToBase64(defectPhoto) },
                          },
                        },
                      );
                      setBusy(false);
                      if (!result.ok || result.data === null) {
                        setError(result.errorMessage ?? 'Aktion fehlgeschlagen.');
                        return;
                      }
                      setDefectHint(result.data.hint);
                      setDefectDescription('');
                      setDefectPhoto(null);
                      await loadCondition();
                    })()
                  }
                >
                  Defekt zum letzten Rückgabevorgang erfassen
                </button>
              </>
            )}
          </div>
        )}

      <div className="card">
        <h2>Referenzfoto</h2>
        {machine.hasReferencePhoto ? (
          // Privater Storage: Auslieferung NUR über die authentifizierte API.
          <img
            src={`/api/staff/machines/${machine.id}/reference-photo?v=${photoVersion}`}
            alt={`Referenzfoto ${machine.machineCode}`}
            style={{ maxWidth: '280px', borderRadius: '6px' }}
          />
        ) : (
          <p className="muted">Kein Referenzfoto hinterlegt (neutraler Platzhalter).</p>
        )}
        {canPhoto && (
          <p>
            <label className="button-like" htmlFor="reference-photo-input">
              Referenzfoto ersetzen
            </label>
            <input
              id="reference-photo-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = String(reader.result ?? '');
                  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                  void run(
                    `/staff/machines/${machine.id}/reference-photo`,
                    {
                      mimeType: file.type,
                      dataBase64: base64,
                    },
                    'PUT',
                  ).then((ok) => {
                    if (ok) setPhotoVersion((value) => value + 1);
                  });
                };
                reader.readAsDataURL(file);
                event.target.value = '';
              }}
            />
          </p>
        )}
      </div>

      {canStatus && (
        <div className="card">
          <h2>Status ändern</h2>
          <p className="muted">
            „Reserviert“ und „Vermietet“ entstehen später durch Zuweisung/Ausgabe – sie sind kein
            manueller Status.
            {machine.status === 'cleaning' &&
              ' Von „Reinigung“ nach „Einsatzbereit“ geht es nur über „Gereinigt & einsatzbereit“.'}
          </p>
          <select
            aria-label="Neuer Status"
            value={statusChoice}
            onChange={(event) => setStatusChoice(event.target.value as MachineStatus)}
          >
            {MANUAL_MACHINE_STATUSES.filter(
              (status) => !(machine.status === 'cleaning' && status === 'ready'),
            ).map((status) => (
              <option key={status} value={status}>
                {MACHINE_STATUS_ICONS[status]} {MACHINE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>{' '}
          <button
            disabled={busy}
            onClick={() =>
              void run(`/staff/machines/${machine.id}/status`, { status: statusChoice })
            }
          >
            Status speichern
          </button>
        </div>
      )}

      {canLocation && (
        <div className="card">
          <h2>Standort ändern</h2>
          <select
            aria-label="Neuer Standort"
            value={locationChoice}
            onChange={(event) => setLocationChoice(event.target.value as MachineLocationKind)}
          >
            {(Object.keys(MACHINE_LOCATION_LABELS) as MachineLocationKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {MACHINE_LOCATION_LABELS[kind]}
              </option>
            ))}
          </select>{' '}
          <input
            aria-label="Standort-Ergänzung (optional)"
            placeholder="Ergänzung (optional)"
            value={locationNote}
            onChange={(event) => setLocationNote(event.target.value)}
          />{' '}
          <button
            disabled={busy}
            onClick={() =>
              void run(`/staff/machines/${machine.id}/location`, {
                locationKind: locationChoice,
                locationNote: locationNote === '' ? null : locationNote,
              })
            }
          >
            Standort speichern
          </button>
        </div>
      )}

      {canManage && (
        <div className="card">
          <h2>Stammdaten</h2>
          <p className="muted">
            Maschinen-ID und Typ sind nach Vergabe unveränderbar. Unbekannte Werte bleiben leer –
            nichts erfinden.
          </p>
          <div className="grid-2">
            <div>
              <label htmlFor="machine-purchase-date">Kaufdatum (optional)</label>
              <input
                id="machine-purchase-date"
                type="date"
                value={purchaseDate}
                onChange={(event) => setPurchaseDate(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="machine-weight">Gewicht in Gramm (optional)</label>
              <input
                id="machine-weight"
                type="number"
                min={0}
                value={weightGrams}
                onChange={(event) => setWeightGrams(event.target.value)}
              />
            </div>
          </div>
          <p>
            <button
              disabled={busy}
              onClick={() =>
                void run(
                  `/staff/machines/${machine.id}`,
                  {
                    purchaseDate: purchaseDate === '' ? null : purchaseDate,
                    weightGrams: weightGrams === '' ? null : Number(weightGrams),
                  },
                  'PATCH',
                )
              }
            >
              Stammdaten speichern
            </button>
          </p>
        </div>
      )}

      <div className="card">
        <h2>Sperren</h2>
        {blocks.length === 0 ? (
          <p className="muted">Keine aktiven oder zukünftigen Sperren.</p>
        ) : (
          blocks.map((block) => (
            <div className="list-row" key={block.id}>
              <div>
                {formatBerlin(block.startsAt)} bis {formatBerlin(block.endsAt)}
                <div className="muted">Grund: {block.reason}</div>
              </div>
              <div>
                {block.active ? (
                  <span className="badge locked">Aktiv</span>
                ) : (
                  <span className="badge">Geplant</span>
                )}{' '}
                {canBlock && (
                  <button
                    disabled={busy}
                    onClick={() => void run(`/staff/machine-blocks/${block.id}/lift`)}
                  >
                    Sperre aufheben
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        {blockWarnings.length > 0 && (
          <div className="conflict-box" data-testid="block-warnings">
            <strong>Starke Warnung – Kapazität betroffen:</strong>
            {blockWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
        {canBlock && (
          <div style={{ borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
            <p className="muted" style={{ margin: '0 0 0.3rem' }}>
              Zeiten in Europe/Berlin. Der Grund ist Pflicht.
            </p>
            <div className="grid-2">
              <div>
                <label htmlFor="block-start">Sperre von</label>
                <input
                  id="block-start"
                  type="datetime-local"
                  value={blockStart}
                  onChange={(event) => setBlockStart(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="block-end">Sperre bis</label>
                <input
                  id="block-end"
                  type="datetime-local"
                  value={blockEnd}
                  onChange={(event) => setBlockEnd(event.target.value)}
                />
              </div>
            </div>
            <label htmlFor="block-reason">Grund (Pflicht)</label>
            <input
              id="block-reason"
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
            />
            <p>
              <button
                disabled={busy || blockStart === '' || blockEnd === '' || blockReason.trim() === ''}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void apiFetch<{ warnings: string[] }>(`/staff/machines/${machine.id}/blocks`, {
                    method: 'POST',
                    body: {
                      startsAt: fromBerlinInput(blockStart),
                      endsAt: fromBerlinInput(blockEnd),
                      reason: blockReason,
                    },
                  }).then(async (result) => {
                    setBusy(false);
                    if (!result.ok || result.data === null) {
                      setError(result.errorMessage ?? 'Sperre konnte nicht angelegt werden.');
                      return;
                    }
                    setBlockWarnings(result.data.warnings);
                    setBlockStart('');
                    setBlockEnd('');
                    setBlockReason('');
                    setNotice('Sperre angelegt.');
                    await load();
                  });
                }}
              >
                Sperre setzen
              </button>
            </p>
          </div>
        )}
      </div>

      {canQr && (
        <div className="card">
          <h2>QR-Code</h2>
          {qr === null ? (
            <p className="muted">Lade …</p>
          ) : (
            <>
              <p className="muted">
                QR-Identifier (ohne Klartextdaten): <code data-testid="qr-token">{qr.token}</code>
              </p>
              {qr.baseConfigured && qrImage !== null ? (
                <div>
                  <img
                    src={qrImage}
                    alt={`QR-Code ${machine.machineCode}`}
                    width={240}
                    height={240}
                  />
                  <p>
                    <button onClick={() => window.print()}>QR drucken</button>
                  </p>
                </div>
              ) : (
                <p className="muted">
                  Für einen druckbaren QR-Code muss zuerst die Staff-App-Basis-URL in den
                  Einstellungen konfiguriert werden – es wird keine Live-URL erfunden.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

export default function MachineDetailPage() {
  return (
    <AuthGuard>
      <MachineDetailView />
    </AuthGuard>
  );
}
