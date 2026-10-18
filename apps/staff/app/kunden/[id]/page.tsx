'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { VoucherDeliveryActions } from '../../../components/communication';
import { apiFetch, hasPermission, type Me } from '../../../lib/api';
import {
  formatBerlinDate,
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type ProcessRow,
  type VoucherSummary,
} from '../../../lib/crm';
import { formatBerlin } from '../../../lib/handover';
import {
  contactStatusLabel,
  createLexwareContact,
  fetchCustomerLexwareContact,
  fetchLexwareStatus,
  linkLexwareContact,
  type ContactCandidate,
  type CustomerLexwareContact,
} from '../../../lib/lexware';
import { fetchAccountingStatus } from '../../../lib/settlement';
import { CustomerForm } from '../page';

interface CustomerDetail {
  customer: {
    id: string;
    type: 'private' | 'organization';
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    billingStreet: string | null;
    billingPostalCode: string | null;
    billingCity: string | null;
    vatId: string | null;
    department: string | null;
    costCenter: string | null;
    orderReference: string | null;
  };
  processes: ProcessRow[];
  /** Phase 11 (§52): Wiederkehrer-Gutschein – nur wenn vorhanden; nie der Code. */
  voucher?: VoucherSummary | null;
}

function CustomerView() {
  const params = useParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<CustomerDetail>(`/staff/customers/${params.id}`);
    if (result.data !== null) setDetail(result.data);
    else setError(result.errorMessage ?? 'Kunde nicht gefunden.');
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(values: Record<string, string>) {
    setBusy(true);
    setError(null);
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
    const result = await apiFetch(`/staff/customers/${params.id}`, {
      method: 'PATCH',
      body: payload,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Speichern fehlgeschlagen.');
      return;
    }
    setEditing(false);
    await load();
  }

  async function moveToTrash() {
    setBusy(true);
    setError(null);
    const result = await apiFetch(`/staff/customers/${params.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.errorMessage ?? 'Löschen fehlgeschlagen.');
      return;
    }
    router.push('/kunden/papierkorb');
  }

  async function createProcess() {
    setBusy(true);
    setError(null);
    const result = await apiFetch<{ process: { id: string } }>('/staff/processes', {
      method: 'POST',
      body: { customerId: params.id },
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Vorgang konnte nicht angelegt werden.');
      return;
    }
    router.push(`/vorgaenge/${result.data.process.id}`);
  }

  if (detail === null) {
    return (
      <main className="page">
        {error !== null ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted">Wird geladen …</p>
        )}
      </main>
    );
  }
  const { customer } = detail;
  const name =
    customer.type === 'organization'
      ? (customer.organizationName ?? 'Organisation')
      : `${customer.firstName ?? ''} ${customer.lastName ?? ''}`;

  return (
    <main className="page">
      <p>
        <Link href="/kunden">← Kunden</Link>
      </p>
      <h1>{name}</h1>
      {error !== null && <p className="error">{error}</p>}

      {editing ? (
        <div className="card">
          <h2>Kunden bearbeiten</h2>
          <CustomerForm
            initial={Object.fromEntries(
              Object.entries(customer).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
            )}
            submitLabel="Speichern"
            busy={busy}
            onSubmit={(values) => void save(values)}
          />
          <p>
            <button onClick={() => setEditing(false)}>Abbrechen</button>
          </p>
        </div>
      ) : (
        <div className="card">
          <h2>Stammdaten</h2>
          {customer.type === 'organization' && customer.contactPerson !== null && (
            <p>Ansprechpartner: {customer.contactPerson}</p>
          )}
          <p>E-Mail: {customer.email ?? '–'}</p>
          <p>Telefon: {customer.phone ?? '–'}</p>
          <p>
            Rechnungsadresse:{' '}
            {[customer.billingStreet, customer.billingPostalCode, customer.billingCity]
              .filter(Boolean)
              .join(', ') || '–'}
          </p>
          {customer.type === 'organization' && (
            <p className="muted">
              {[
                customer.vatId !== null ? `USt-ID: ${customer.vatId}` : null,
                customer.department !== null ? `Abteilung: ${customer.department}` : null,
                customer.costCenter !== null ? `Kostenstelle: ${customer.costCenter}` : null,
                customer.orderReference !== null ? `Referenz: ${customer.orderReference}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {hasPermission(me, 'customer.edit') && (
            <button onClick={() => setEditing(true)}>Bearbeiten</button>
          )}{' '}
          {hasPermission(me, 'process.create') && (
            <button className="primary" disabled={busy} onClick={() => void createProcess()}>
              Vorgang anlegen
            </button>
          )}{' '}
          {hasPermission(me, 'trash.manage') && detail.processes.length === 0 && (
            <button className="danger" disabled={busy} onClick={() => void moveToTrash()}>
              In den Papierkorb
            </button>
          )}
        </div>
      )}

      <LexwareContactBlock customerId={params.id} me={me} />

      {detail.voucher ? (
        <div className="card" data-testid="customer-voucher">
          <h2>Wiederkehrer-Gutschein</h2>
          <p>
            <span
              className={`badge ${detail.voucher.status === 'active' ? 'active' : detail.voucher.status === 'reserved' ? '' : 'locked'}`}
              data-testid="customer-voucher-status"
            >
              {detail.voucher.statusLabel}
              {detail.voucher.status === 'active' || detail.voucher.status === 'reserved'
                ? ` – gültig bis ${formatBerlinDate(detail.voucher.expiresAt)}`
                : ''}
            </span>{' '}
            <span className="muted" data-testid="customer-voucher-delivery">
              {detail.voucher.deliveryLabel}
            </span>
          </p>
          <p className="muted">
            20 % auf die Maschinenmiete eines neuen Mietvorgangs · Referenz{' '}
            <code data-testid="customer-voucher-reference">{detail.voucher.maskedReference}</code>
            {detail.voucher.originProcessNumber !== null && (
              <>
                {' · '}aus Vorgang{' '}
                <Link href={`/vorgaenge/${detail.voucher.originProcessId}`}>
                  {detail.voucher.originProcessNumber}
                </Link>
              </>
            )}
          </p>
          {/* Phase 12 (UI): Versandproblem + „Gutschein jetzt senden“ (Order §15). */}
          <VoucherDeliveryActions
            customerId={params.id}
            voucher={detail.voucher}
            me={me}
            testIdPrefix="customer-voucher"
            onChanged={load}
          />
        </div>
      ) : null}

      <div className="card">
        <h2>Vorgänge</h2>
        {detail.processes.length === 0 && <p className="muted">Keine sichtbaren Vorgänge.</p>}
        {detail.processes.map((process) => (
          <div className="list-row" key={process.id}>
            <div>
              <Link href={`/vorgaenge/${process.id}`}>{process.processNumber}</Link>
              <div className="muted">Event: {formatEventDate(process.eventDate)}</div>
            </div>
            <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
              {STATUS_LABELS[process.mainStatus]}
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}

/**
 * Phase 10 (Order §17, Vertrag §5): Lexware-Kontakt des Kunden. Nur sichtbar,
 * wenn die Lexware-Integration aktiv ist (Status-Route `enabled`; ohne
 * system.settings ersatzweise Provider „lexware“ aus /staff/accounting/status).
 * Verknüpfen/Anlegen sind kritische Aktionen mit Bestätigung; der Server
 * prüft Rechte und Eindeutigkeit – die UI mergt nie automatisch.
 */
function LexwareContactBlock({ customerId, me }: { customerId: string; me: Me | null }) {
  const [enabled, setEnabled] = useState(false);
  const [view, setView] = useState<CustomerLexwareContact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: 'link'; candidate: ContactCandidate } | { kind: 'create' } | null
  >(null);

  const canSettings = hasPermission(me, 'system.settings');
  const canView = canSettings || hasPermission(me, 'settlement.view');

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void (async () => {
      if (canSettings) {
        const status = await fetchLexwareStatus();
        if (status.data !== null) {
          if (!cancelled) setEnabled(status.data.enabled === true);
          return;
        }
      }
      const accounting = await fetchAccountingStatus();
      if (!cancelled && accounting.data !== null) {
        setEnabled(accounting.data.provider === 'lexware');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, canSettings]);

  const load = useCallback(async () => {
    const result = await fetchCustomerLexwareContact(customerId);
    if (result.data !== null) setView(result.data);
    else if (result.status !== 404) {
      setError(result.errorMessage ?? 'Lexware-Kontakt konnte nicht geladen werden.');
    }
  }, [customerId]);
  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  async function run(
    action: () => Promise<{
      ok: boolean;
      data: CustomerLexwareContact | null;
      errorMessage: string | null;
      errorCode: string | null;
    }>,
    okText: string,
  ): Promise<void> {
    setConfirm(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(
        result.errorCode === 'CONTACT_ALREADY_MAPPED'
          ? 'Dieser Lexware-Kontakt ist bereits einem anderen Kunden zugeordnet.'
          : (result.errorMessage ?? 'Aktion fehlgeschlagen.'),
      );
      await load();
      return;
    }
    if (result.data !== null) setView(result.data);
    else await load();
    setNotice(okText);
  }

  if (!enabled || !canView) return null;

  const mapping = view?.mapping ?? null;
  const linked = mapping !== null && mapping.status === 'linked';
  const review =
    !linked && (mapping?.status === 'review_required' || (view?.candidates.length ?? 0) > 0);
  const deeplink = view?.deeplink ?? null;

  return (
    <div className="card" data-testid="lexware-contact-block">
      <h2>Lexware-Kontakt</h2>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="success">{notice}</p>}
      <p>
        Status:{' '}
        <span
          className={`badge ${linked ? 'ok' : review ? 'locked' : ''}`}
          data-testid="lexware-contact-status"
        >
          {contactStatusLabel(view)}
        </span>
        {linked && mapping.lastSyncedAt !== undefined && mapping.lastSyncedAt !== null && (
          <span className="muted"> · zuletzt abgeglichen {formatBerlin(mapping.lastSyncedAt)}</span>
        )}
        {deeplink !== null && deeplink !== '' && (
          <>
            {' '}
            <a
              href={deeplink}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="lexware-contact-open"
            >
              In Lexware öffnen
            </a>
          </>
        )}
      </p>
      {review && (
        <>
          <p className="warning-red" role="status">
            Mehrere oder widersprüchliche Lexware-Kontakte gefunden – bitte den passenden Kontakt
            wählen oder einen neuen anlegen. Es wird nichts automatisch zusammengeführt.
          </p>
          <div data-testid="lexware-contact-candidates">
            {(view?.candidates ?? []).map((candidate) => (
              <div
                className="list-row"
                key={candidate.contactId}
                data-testid={`lexware-contact-candidate-${candidate.contactId}`}
              >
                <div>
                  <strong>{candidate.displayName}</strong>
                  <div className="muted">
                    {candidate.email ?? 'keine E-Mail'}
                    {candidate.reason !== undefined &&
                    candidate.reason !== null &&
                    candidate.reason !== ''
                      ? ` · ${candidate.reason}`
                      : ''}
                  </div>
                </div>
                {canSettings && (
                  <button
                    type="button"
                    data-testid={`lexware-contact-link-${candidate.contactId}`}
                    disabled={busy}
                    onClick={() => setConfirm({ kind: 'link', candidate })}
                  >
                    Verknüpfen
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {!linked && (
        <p className="muted">
          {review
            ? ''
            : 'Der Kontakt wird bei der ersten Rechnungsübertragung automatisch gesucht oder angelegt.'}
        </p>
      )}
      {!linked && canSettings && (
        <p>
          <button
            type="button"
            className={review ? 'primary' : undefined}
            data-testid="lexware-contact-create"
            disabled={busy}
            onClick={() => setConfirm({ kind: 'create' })}
          >
            Neuen Lexware-Kontakt anlegen
          </button>
        </p>
      )}
      {!linked && !canSettings && review && (
        <p className="muted">Die Zuordnung übernimmt eine Person mit Systemeinstellungs-Recht.</p>
      )}
      {confirm !== null && confirm.kind === 'link' && (
        <ConfirmDialog
          testId="lexware-contact-link-dialog"
          title="Lexware-Kontakt verknüpfen?"
          confirmLabel="Verknüpfen"
          confirmTestId="lexware-contact-link-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(
              () => linkLexwareContact(customerId, confirm.candidate.contactId),
              'Lexware-Kontakt verknüpft.',
            )
          }
        >
          <p>
            Der Kunde wird dauerhaft mit dem Lexware-Kontakt{' '}
            <strong>{confirm.candidate.displayName}</strong>
            {confirm.candidate.email !== undefined && confirm.candidate.email !== null
              ? ` (${confirm.candidate.email})`
              : ''}{' '}
            verknüpft. Künftige Rechnungen laufen auf diesen Kontakt.
          </p>
        </ConfirmDialog>
      )}
      {confirm !== null && confirm.kind === 'create' && (
        <ConfirmDialog
          testId="lexware-contact-create-dialog"
          title="Neuen Lexware-Kontakt anlegen?"
          confirmLabel="Kontakt anlegen"
          confirmTestId="lexware-contact-create-confirm"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(() => createLexwareContact(customerId), 'Lexware-Kontakt angelegt.')
          }
        >
          <p>
            In Lexware wird ein neuer Kontakt aus den aktuellen Stammdaten angelegt und mit diesem
            Kunden verknüpft. Vorhandene Lexware-Kontakte werden dabei nicht zusammengeführt.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function CustomerDetailPage() {
  return (
    <AuthGuard>
      <CustomerView />
    </AuthGuard>
  );
}
