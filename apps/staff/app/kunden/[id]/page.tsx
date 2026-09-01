'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { apiFetch, hasPermission } from '../../../lib/api';
import {
  formatEventDate,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type ProcessRow,
} from '../../../lib/crm';
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

export default function CustomerDetailPage() {
  return (
    <AuthGuard>
      <CustomerView />
    </AuthGuard>
  );
}
