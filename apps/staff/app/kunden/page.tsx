'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthGuard, useMe } from '../../components/auth-guard';
import { apiFetch, hasPermission } from '../../lib/api';

interface CustomerRow {
  id: string;
  type: 'private' | 'organization';
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  email: string | null;
  phone: string | null;
  openProcessCount: number;
}

interface DuplicateWarning {
  customerId: string;
  displayName: string;
  reason: 'email' | 'phone' | 'name';
}

const REASON_LABEL: Record<DuplicateWarning['reason'], string> = {
  email: 'gleiche E-Mail',
  phone: 'gleiche Telefonnummer',
  name: 'sehr ähnlicher Name',
};

export function CustomerForm({
  initial,
  submitLabel,
  onSubmit,
  busy,
}: {
  initial?: Partial<Record<string, string>>;
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => void;
  busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    type: initial?.type ?? 'private',
    firstName: initial?.firstName ?? '',
    lastName: initial?.lastName ?? '',
    organizationName: initial?.organizationName ?? '',
    contactPerson: initial?.contactPerson ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    billingStreet: initial?.billingStreet ?? '',
    billingPostalCode: initial?.billingPostalCode ?? '',
    billingCity: initial?.billingCity ?? '',
    vatId: initial?.vatId ?? '',
    department: initial?.department ?? '',
    costCenter: initial?.costCenter ?? '',
    orderReference: initial?.orderReference ?? '',
  });
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const isOrg = values.type === 'organization';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
      }}
    >
      <label htmlFor="c-type">Kundentyp</label>
      <select id="c-type" value={values.type} onChange={set('type')}>
        <option value="private">Privatperson</option>
        <option value="organization">Firma / Verein / Organisation</option>
      </select>
      {isOrg && (
        <>
          <label htmlFor="c-org">Organisations-/Firmenname</label>
          <input
            id="c-org"
            value={values.organizationName}
            onChange={set('organizationName')}
            required
          />
          <label htmlFor="c-contact">Ansprechpartner (optional)</label>
          <input id="c-contact" value={values.contactPerson} onChange={set('contactPerson')} />
        </>
      )}
      <div className="grid-2">
        <div>
          <label htmlFor="c-first">Vorname{isOrg ? ' (optional)' : ''}</label>
          <input
            id="c-first"
            value={values.firstName}
            onChange={set('firstName')}
            required={!isOrg}
          />
        </div>
        <div>
          <label htmlFor="c-last">Nachname{isOrg ? ' (optional)' : ''}</label>
          <input id="c-last" value={values.lastName} onChange={set('lastName')} required={!isOrg} />
        </div>
      </div>
      <div className="grid-2">
        <div>
          <label htmlFor="c-email">E-Mail (optional)</label>
          <input id="c-email" type="email" value={values.email} onChange={set('email')} />
        </div>
        <div>
          <label htmlFor="c-phone">Telefon (optional)</label>
          <input id="c-phone" value={values.phone} onChange={set('phone')} />
        </div>
      </div>
      <label htmlFor="c-street">Rechnungsadresse: Straße (optional)</label>
      <input id="c-street" value={values.billingStreet} onChange={set('billingStreet')} />
      <div className="grid-2">
        <div>
          <label htmlFor="c-plz">PLZ</label>
          <input id="c-plz" value={values.billingPostalCode} onChange={set('billingPostalCode')} />
        </div>
        <div>
          <label htmlFor="c-city">Ort</label>
          <input id="c-city" value={values.billingCity} onChange={set('billingCity')} />
        </div>
      </div>
      {isOrg && (
        <>
          <div className="grid-2">
            <div>
              <label htmlFor="c-vat">USt-ID (optional)</label>
              <input id="c-vat" value={values.vatId} onChange={set('vatId')} />
            </div>
            <div>
              <label htmlFor="c-dep">Abteilung (optional)</label>
              <input id="c-dep" value={values.department} onChange={set('department')} />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label htmlFor="c-cost">Kostenstelle (optional)</label>
              <input id="c-cost" value={values.costCenter} onChange={set('costCenter')} />
            </div>
            <div>
              <label htmlFor="c-ref">Bestellnummer/Referenz (optional)</label>
              <input id="c-ref" value={values.orderReference} onChange={set('orderReference')} />
            </div>
          </div>
        </>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}

function cleanPayload(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
}

function CustomerList() {
  const me = useMe();
  const router = useRouter();
  const [customersList, setCustomersList] = useState<CustomerRow[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateWarning[] | null>(null);
  const [pending, setPending] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await apiFetch<{ customers: CustomerRow[] }>('/staff/customers');
    if (result.data !== null) setCustomersList(result.data.customers);
    else setError(result.errorMessage ?? 'Kunden konnten nicht geladen werden.');
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(values: Record<string, string>, ignoreDuplicates: boolean) {
    setBusy(true);
    setError(null);
    const payload = cleanPayload(values);

    if (!ignoreDuplicates) {
      const check = await apiFetch<{ duplicates: DuplicateWarning[] }>(
        '/staff/customers/duplicate-check',
        { method: 'POST', body: payload },
      );
      if ((check.data?.duplicates.length ?? 0) > 0) {
        // Warnen, nicht blockieren: der Mitarbeiter entscheidet bewusst.
        setDuplicates(check.data!.duplicates);
        setPending(values);
        setBusy(false);
        return;
      }
    }

    const result = await apiFetch<{ customer: { id: string } }>('/staff/customers', {
      method: 'POST',
      body: payload,
    });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Anlegen fehlgeschlagen.');
      return;
    }
    router.push(`/kunden/${result.data.customer.id}`);
  }

  return (
    <main className="page">
      <h1>Kunden</h1>
      {error !== null && <p className="error">{error}</p>}
      {hasPermission(me, 'trash.manage') && (
        <p>
          <Link href="/kunden/papierkorb">Papierkorb</Link>
        </p>
      )}

      {duplicates !== null && pending !== null && (
        <div className="card" role="alert">
          <h2>Mögliche Dubletten gefunden</h2>
          <p className="muted">
            Es gibt ähnliche Kunden. Du kannst trotzdem anlegen – eine Zusammenführung geschieht nie
            automatisch.
          </p>
          {duplicates.map((d) => (
            <div className="list-row" key={d.customerId}>
              <Link href={`/kunden/${d.customerId}`}>{d.displayName}</Link>
              <span className="badge">{REASON_LABEL[d.reason]}</span>
            </div>
          ))}
          <p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setDuplicates(null);
                void create(pending, true);
              }}
            >
              Trotzdem anlegen
            </button>{' '}
            <button
              onClick={() => {
                setDuplicates(null);
                setPending(null);
              }}
            >
              Abbrechen
            </button>
          </p>
        </div>
      )}

      {hasPermission(me, 'customer.create') && (
        <div className="card">
          {showCreate ? (
            <>
              <h2>Neuen Kunden anlegen</h2>
              <CustomerForm
                submitLabel="Kunde anlegen"
                busy={busy}
                onSubmit={(values) => void create(values, false)}
              />
              <p>
                <button onClick={() => setShowCreate(false)}>Abbrechen</button>
              </p>
            </>
          ) : (
            <button className="primary" onClick={() => setShowCreate(true)}>
              Kunde anlegen
            </button>
          )}
        </div>
      )}

      <div className="card">
        {customersList.length === 0 && (
          <p className="muted">
            Noch keine Kunden. Lege den ersten Kunden an, um Vorgänge zu erstellen.
          </p>
        )}
        {customersList.map((customer) => (
          <div className="list-row" key={customer.id}>
            <div>
              <Link href={`/kunden/${customer.id}`}>
                {customer.type === 'organization'
                  ? customer.organizationName
                  : `${customer.lastName}, ${customer.firstName}`}
              </Link>
              <div className="muted">{customer.email ?? customer.phone ?? '–'}</div>
            </div>
            {customer.openProcessCount > 0 && (
              <span className="badge active">
                {customer.openProcessCount} offene{customer.openProcessCount === 1 ? 'r' : ''}{' '}
                Vorgang
                {customer.openProcessCount === 1 ? '' : 'e'}
              </span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

export default function CustomersPage() {
  return (
    <AuthGuard>
      <CustomerList />
    </AuthGuard>
  );
}
