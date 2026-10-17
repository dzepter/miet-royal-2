'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CONFLICT_LABELS, type ConflictCode } from '@mietroyal/offline';
import { AuthGuard } from '../../components/auth-guard';
import { formatBerlin } from '../../lib/handover';
import { offlineStatusLabel, useOffline } from '../../lib/offline/provider';
import type { OfflineRuntime } from '../../lib/offline/runtime';

type Row = Awaited<ReturnType<OfflineRuntime['listMutations']>>[number] & {
  conflict: { code: string; message: string } | null;
  /** Vorgangs-ID (aus dem lokalen Snapshot) für den Absprung in den Wizard. */
  processId: string | null;
};

const STATUS_LABELS: Record<Row['status'], string> = {
  pending: 'Ausstehend',
  syncing: 'Wird übertragen',
  synced: 'Synchronisiert',
  conflict: 'Prüfung erforderlich',
  failed_retryable: 'Erneuter Versuch geplant',
  failed_permanent: 'Abgelehnt',
};

/** Ablehnungscodes des Servers (keine Konfliktcodes) – neutral erklärt, ohne Fachdaten. */
const REJECTION_LABELS: Record<string, string> = {
  PERMISSION_REVOKED: 'Das Recht für diese Aktion wurde zwischenzeitlich entzogen.',
  VALIDATION: 'Die Eingabe wurde serverseitig nicht akzeptiert.',
  FORBIDDEN: 'Diese Änderung gehört zu einem anderen Benutzer.',
  MEDIA_HASH_MISMATCH: 'Ein Foto oder eine Unterschrift ist beschädigt.',
  PAYLOAD_TOO_LARGE: 'Die Übertragung ist zu groß (Fotos verkleinern).',
};

function conflictText(code: string, fallback: string): string {
  if ((Object.keys(CONFLICT_LABELS) as string[]).includes(code)) {
    return CONFLICT_LABELS[code as ConflictCode];
  }
  return (
    REJECTION_LABELS[code] ?? (fallback !== '' ? fallback : CONFLICT_LABELS.SERVER_STATE_CHANGED)
  );
}

/**
 * „Synchronisierung prüfen“ (Phase-8-Order §§34, 41, 42): ausstehende
 * Aktionen, Konflikte mit verständlicher Erklärung (welcher Vorgang, welche
 * Aktion, was offline erfasst wurde, was sich serverseitig änderte) und die
 * drei Handlungen: Serverstand laden & prüfen, erneut anwenden (über die
 * normalen Domainservices – keine Direktüberschreibung), bewusst verwerfen.
 */
function SyncView() {
  const offline = useOffline();
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (offline === null) return;
    const mutations = await offline.runtime.listMutations();
    const result: Row[] = [];
    for (const mutation of mutations) {
      const conflict =
        mutation.status === 'conflict' || mutation.status === 'failed_permanent'
          ? await offline.runtime.getConflict(mutation.clientMutationId)
          : null;
      const processId =
        mutation.contextKind === 'booking'
          ? ((await offline.runtime.findBooking(mutation.contextId))?.processId ?? null)
          : null;
      result.push({ ...mutation, conflict, processId });
    }
    setRows(result.sort((a, b) => a.seq - b.seq));
  }, [offline]);

  useEffect(() => {
    void load();
  }, [
    load,
    offline?.state.pending,
    offline?.state.conflicts,
    offline?.state.syncing,
    offline?.state.unlocked,
  ]);

  if (offline === null || !offline.state.initialized) {
    return (
      <main className="page">
        <h1>Synchronisierung prüfen</h1>
        <p className="muted">Der Offline-Arbeitsbereich ist auf diesem Gerät nicht aktiv.</p>
      </main>
    );
  }
  const { state } = offline;
  const open = rows.filter((row) => row.status !== 'synced');
  const conflicts = open.filter(
    (row) => row.status === 'conflict' || row.status === 'failed_permanent',
  );
  const pending = open.filter(
    (row) => row.status !== 'conflict' && row.status !== 'failed_permanent',
  );

  /** Aktion ausführen; `fn` liefert den Hinweistext (oder null) – danach Liste neu laden. */
  async function act(fn: () => Promise<string | null>) {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch {
      setNotice('Aktion fehlgeschlagen – bitte erneut versuchen.');
    } finally {
      setBusy(false);
      await load();
    }
  }

  const contextLink = (row: Row) => {
    if (row.contextKind === 'machine') return `/maschinen/${row.contextId}`;
    const wizard = row.type.startsWith('return.') ? 'rueckgabe' : 'uebergabe';
    return row.processId !== null
      ? `/vorgaenge/${row.processId}/${wizard}`
      : row.type.startsWith('return.')
        ? '/rueckgabe'
        : '/ausgabe';
  };

  const title = (row: Row) =>
    `${row.summary.processNumber !== null ? `Vorgang ${row.summary.processNumber} · ` : ''}${row.summary.actionLabel}${row.summary.detail !== null ? ` (${row.summary.detail})` : ''}`;

  return (
    <main className="page">
      <h1>Synchronisierung prüfen</h1>
      <p>
        <span className="badge" data-testid="sync-status">
          {offlineStatusLabel(state)}
        </span>{' '}
        {state.lastSyncAt !== null && (
          <span className="muted">Letzte Synchronisierung {formatBerlin(state.lastSyncAt)}</span>
        )}
      </p>
      {state.leaseExpiresAt !== null && (
        <p className="muted" data-testid="lease-info">
          Offline-Berechtigung dieses Geräts gültig bis {formatBerlin(state.leaseExpiresAt)} (max.
          72 Stunden seit letzter Online-Autorisierung).
        </p>
      )}
      <p>
        <button
          className="primary"
          data-testid="sync-now"
          disabled={busy || state.syncing || !state.unlocked}
          onClick={() =>
            void act(async () => {
              await offline.syncNow();
              return 'Synchronisierung ausgeführt.';
            })
          }
        >
          Jetzt synchronisieren
        </button>{' '}
        <button
          data-testid="package-refresh"
          disabled={busy || state.connectivity !== 'online' || !state.unlocked}
          onClick={() =>
            void act(async () =>
              (await offline.refreshPackage())
                ? 'Arbeitspaket aktualisiert.'
                : 'Arbeitspaket konnte nicht aktualisiert werden.',
            )
          }
        >
          Arbeitspaket aktualisieren
        </button>
      </p>
      {notice !== null && <p className="success">{notice}</p>}
      <p className="muted">
        {state.lastPackageAt !== null
          ? `Arbeitspaket (heute ±3 Tage) vom ${formatBerlin(state.lastPackageAt)}.`
          : 'Noch kein Arbeitspaket auf diesem Gerät – bei Onlinekontakt wird es geladen.'}
      </p>
      {state.storageWarning !== null && <p className="error">{state.storageWarning}</p>}

      <section className="card" data-testid="sync-conflicts">
        <h2>Prüfung erforderlich ({conflicts.length})</h2>
        {conflicts.length === 0 && <p className="muted">Keine Konflikte.</p>}
        {conflicts.map((row) => {
          const code = row.conflict?.code ?? row.lastErrorCode ?? 'SERVER_STATE_CHANGED';
          return (
            <div
              className="conflict-box sync-conflict"
              key={row.clientMutationId}
              data-testid="sync-conflict"
              data-code={code}
            >
              <strong>{title(row)}</strong>
              <div className="muted">Offline erfasst am {formatBerlin(row.createdAt)}.</div>
              <div>
                <strong>Serverseitig:</strong> {conflictText(code, row.conflict?.message ?? '')}
              </div>
              <div className="muted">
                Was jetzt zu tun ist: Serverstand laden und die Eingabe prüfen; wenn die Aktion
                weiterhin zulässig ist, erneut anwenden – sonst die lokale Änderung bewusst
                verwerfen. Fotos und Unterschriften bleiben bis dahin lokal erhalten.
              </div>
              <p className="conflict-actions">
                <Link href={contextLink(row)} className="button-like">
                  Serverstand laden &amp; prüfen
                </Link>{' '}
                <button
                  data-testid="conflict-retry"
                  disabled={busy || row.status === 'failed_permanent'}
                  onClick={() =>
                    void act(async () => {
                      await offline.runtime.retry(row.clientMutationId);
                      return 'Änderung wird erneut angewendet.';
                    })
                  }
                >
                  Erneut anwenden
                </button>{' '}
                <button
                  className="danger"
                  data-testid="conflict-discard"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        'Diese lokale Änderung (inkl. zugehöriger Fotos/Unterschriften) wird endgültig verworfen. Fortfahren?',
                      )
                    )
                      return;
                    void act(async () => {
                      await offline.runtime.discard(row.clientMutationId);
                      return 'Lokale Änderung verworfen.';
                    });
                  }}
                >
                  Verwerfen
                </button>
              </p>
            </div>
          );
        })}
      </section>

      <section className="card" data-testid="sync-pending">
        <h2>Ausstehende Änderungen ({pending.length})</h2>
        {pending.length === 0 && <p className="muted">Alles synchronisiert.</p>}
        {pending.map((row) => (
          <div className="sync-row" key={row.clientMutationId} data-testid="sync-pending-row">
            <span>
              {title(row)}
              <span className="muted"> · {formatBerlin(row.createdAt)}</span>
            </span>
            <span
              className="badge"
              data-testid="sync-pending-status"
              data-error={row.lastErrorCode ?? ''}
            >
              {STATUS_LABELS[row.status]}
              {row.status === 'failed_retryable' && row.lastErrorCode !== null
                ? ` (${row.lastErrorCode})`
                : ''}
            </span>
          </div>
        ))}
      </section>
      <p className="muted">
        Synchronisierte Änderungen werden nach kurzer Zeit automatisch vom Gerät entfernt;
        ausstehende oder zu prüfende Änderungen nie.
      </p>
    </main>
  );
}

export default function SyncPage() {
  return (
    <AuthGuard>
      <SyncView />
    </AuthGuard>
  );
}
