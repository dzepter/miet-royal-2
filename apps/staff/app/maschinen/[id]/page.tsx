'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import { formatBerlin } from '../../../lib/commerce';
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
 * Referenzfoto/Platzhalter, QR und aktuelle Verfügbarkeitswarnung – ohne
 * Schäden/Historien/Ausgabe/Rückgabe (spätere Phasen).
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
    return true;
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
          </p>
          <select
            aria-label="Neuer Status"
            value={statusChoice}
            onChange={(event) => setStatusChoice(event.target.value as MachineStatus)}
          >
            {MANUAL_MACHINE_STATUSES.map((status) => (
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
