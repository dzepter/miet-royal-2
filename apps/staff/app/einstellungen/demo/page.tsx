'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { useOfflineNow } from '../../../components/communication';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { hasPermission } from '../../../lib/api';
import {
  DEMO_OUTDATED_TEXT,
  DEMO_RESET_CONFIRMATION,
  DEMO_STORAGE_CLEANUP_FAILED_TEXT,
  DEMO_STORAGE_CLEANUP_PENDING_TEXT,
  fetchDemoSeedEntities,
  fetchDemoStatus,
  resetDemo,
  type DemoSeedEntity,
  type DemoStatus,
} from '../../../lib/demo';
import { formatBerlin } from '../../../lib/handover';

/**
 * Einstellungen → Demo (Phase 14, Order §§8, 15, 16; Recht demo.manage, nur in
 * APP_ENV=demo): Datenstand des kanonischen Demo-Datensatzes, Seed-Szenarien
 * und die destruktive Aktion „Demo-Geschäftsdaten zurücksetzen“ mit
 * Pflicht-Texteingabe „DEMO ZURÜCKSETZEN“ (bestehendes Dialogmuster, kein
 * window.confirm). Nie ein automatischer Reset.
 */

function staffName(ref: { name: string } | null): string {
  return ref === null ? 'unbekannt' : ref.name;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

function DemoSettings() {
  const me = useMe();
  const offlineNow = useOfflineNow();
  const allowed = me?.environment === 'demo' && hasPermission(me, 'demo.manage');
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entities, setEntities] = useState<DemoSeedEntity[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    const result = await fetchDemoStatus();
    if (result.data !== null) {
      setStatus(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.errorMessage ?? 'Demo-Status konnte nicht geladen werden.');
    }
  }, [allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadEntities() {
    const result = await fetchDemoSeedEntities();
    if (result.data !== null) setEntities(result.data.entities);
  }

  async function runReset() {
    if (confirmation !== DEMO_RESET_CONFIRMATION) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await resetDemo(confirmation);
    setBusy(false);
    setDialogOpen(false);
    setConfirmation('');
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Zurücksetzen fehlgeschlagen.');
      await load();
      return;
    }
    const seconds = Math.max(1, Math.round(result.data.durationMs / 1000));
    setNotice(
      `Demo-Geschäftsdaten wurden zurückgesetzt (Datenstand Version ${result.data.datasetVersion}, ` +
        `${sumCounts(result.data.deleted)} Datensätze entfernt, ${sumCounts(result.data.seeded)} neu angelegt, ` +
        `${seconds} s).`,
    );
    setEntities(null);
    await load();
  }

  if (me === null) return null;
  if (!allowed) {
    return (
      <main className="page">
        <p>
          <Link href="/einstellungen">← Einstellungen</Link>
        </p>
        <h1>Demo-Umgebung</h1>
        <p className="error" data-testid="demo-not-available">
          Diese Seite ist nur in der Demo-Umgebung für Administratoren verfügbar.
        </p>
      </main>
    );
  }

  const resetBlocked =
    busy || offlineNow || (status?.resetInProgress === true && !status.resetStale);

  return (
    <main className="page" data-testid="demo-settings">
      <p>
        <Link href="/einstellungen">← Einstellungen</Link>
      </p>
      <h1>Demo-Umgebung</h1>
      <p className="muted">
        Alle Daten hier sind synthetisch. Der kanonische Demo-Datensatz wird nie automatisch
        zurückgesetzt – nur bewusst über die Aktion unten.
      </p>
      {loadError !== null && <p className="error">{loadError}</p>}
      {error !== null && (
        <p className="error" data-testid="demo-reset-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="success" data-testid="demo-reset-notice">
          {notice}
        </p>
      )}

      {status !== null && (
        <div className="card" data-testid="demo-status">
          <h2>Datenstand</h2>
          {status.outdated && (
            <p className="conflict-box" data-testid="demo-outdated">
              {status.outdatedHint ?? DEMO_OUTDATED_TEXT}
            </p>
          )}
          {status.resetInProgress && !status.resetStale && (
            <p className="conflict-box" data-testid="demo-reset-running">
              Die Demo-Umgebung wird gerade zurückgesetzt
              {status.resetStartedAt !== null
                ? ` (seit ${formatBerlin(status.resetStartedAt)})`
                : ''}
              . Änderungen sind währenddessen für alle blockiert.
            </p>
          )}
          {status.resetStale && (
            <p className="conflict-box" data-testid="demo-reset-stale">
              Letzter Reset unterbrochen – erneut zurücksetzen.
            </p>
          )}
          {status.storageCleanup !== undefined &&
            (status.storageCleanup.deadJobs > 0 || status.storageCleanup.pendingJobs > 0) && (
              // Phase 14 (reset, Order §22): neutraler Hinweis – der neue Datensatz ist konsistent,
              // nur alte Dateien werden noch (bzw. nicht mehr automatisch) entfernt.
              <p
                className={status.storageCleanup.deadJobs > 0 ? 'error' : 'muted'}
                data-testid="demo-storage-cleanup"
              >
                {status.storageCleanup.deadJobs > 0
                  ? DEMO_STORAGE_CLEANUP_FAILED_TEXT
                  : `${DEMO_STORAGE_CLEANUP_PENDING_TEXT} (${status.storageCleanup.pendingJobs})`}
              </p>
            )}
          <p>
            Version{' '}
            <strong data-testid="demo-dataset-version">{status.datasetVersion ?? '–'}</strong>{' '}
            <span className="muted">(erwartet {status.expectedDatasetVersion})</span>
          </p>
          <p className="muted">
            Zuletzt gesetzt:{' '}
            {status.seededAt === null
              ? 'noch nie'
              : `${formatBerlin(status.seededAt)} von ${staffName(status.seededBy)}`}
            <br />
            Zuletzt zurückgesetzt:{' '}
            {status.lastResetAt === null
              ? 'noch nie'
              : `${formatBerlin(status.lastResetAt)} von ${staffName(status.lastResetBy)}`}
          </p>
          <p data-testid="demo-counts">
            Kunden: <strong>{status.counts.customers}</strong> · Vorgänge:{' '}
            <strong>{status.counts.processes}</strong> · Touren:{' '}
            <strong>{status.counts.tours}</strong> · Seed-Szenarien:{' '}
            <strong>{status.seedEntities}</strong>
          </p>
          <details
            onToggle={(event) =>
              event.currentTarget.open && entities === null && void loadEntities()
            }
          >
            <summary>Seed-Szenarien anzeigen</summary>
            {entities === null ? (
              <p className="muted">Wird geladen …</p>
            ) : entities.length === 0 ? (
              <p className="muted">Keine Seed-Szenarien registriert.</p>
            ) : (
              <ul data-testid="demo-seed-entities">
                {entities.map((entity) => (
                  <li key={entity.seedKey}>
                    <code>{entity.seedKey}</code>{' '}
                    <span className="muted">({entity.entityType})</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      )}

      <div className="card">
        <h2>Demo-Geschäftsdaten zurücksetzen</h2>
        <p className="muted">
          Löscht alle Demo-Geschäftsdaten und erzeugt den kanonischen Demo-Datensatz neu.
          Mitarbeiterkonten, Rollen, Rechte, bekannte Geräte, Security-Audit und Trainingsstände
          bleiben erhalten.
        </p>
        {offlineNow && (
          <p className="muted">
            Diese Aktion ist offline nicht verfügbar – bitte mit Verbindung erneut versuchen.
          </p>
        )}
        <button
          type="button"
          className="danger"
          data-testid="demo-reset"
          disabled={resetBlocked}
          onClick={() => {
            setConfirmation('');
            setDialogOpen(true);
          }}
        >
          Demo-Geschäftsdaten zurücksetzen
        </button>
      </div>

      {dialogOpen && (
        <ConfirmDialog
          testId="demo-reset-dialog"
          title="Demo-Geschäftsdaten zurücksetzen?"
          confirmLabel={busy ? 'Wird zurückgesetzt …' : 'Demo-Geschäftsdaten zurücksetzen'}
          confirmTestId="demo-reset-confirm"
          busy={busy}
          danger
          disabled={confirmation !== DEMO_RESET_CONFIRMATION}
          maxWidth="30rem"
          onConfirm={() => void runReset()}
          onCancel={() => {
            if (busy) return;
            setDialogOpen(false);
            setConfirmation('');
          }}
        >
          <p>
            Alle Demo-Geschäftsdaten (Kunden, Vorgänge, Angebote, Buchungen, Termine, Touren,
            Kommunikation, Lager- und Maschinen-Fachdaten) werden unwiderruflich gelöscht und durch
            den kanonischen Demo-Datensatz ersetzt. Während des Zurücksetzens sind Änderungen in der
            Demo für alle blockiert.
          </p>
          <label htmlFor="demo-reset-confirmation">
            Zur Bestätigung „{DEMO_RESET_CONFIRMATION}“ eingeben
          </label>
          <input
            id="demo-reset-confirmation"
            data-testid="demo-reset-confirmation"
            autoComplete="off"
            autoFocus
            value={confirmation}
            disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function DemoSettingsPage() {
  return (
    <AuthGuard>
      <DemoSettings />
    </AuthGuard>
  );
}
