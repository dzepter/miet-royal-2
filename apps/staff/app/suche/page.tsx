'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';
import { useOffline } from '../../lib/offline/provider';
import { formatEventDate, STATUS_BADGE_CLASS, STATUS_LABELS, type MainStatus } from '../../lib/crm';
import { MACHINE_STATUS_LABELS } from '../../lib/warehouse';

interface SearchResponse {
  customers: { id: string; displayName: string; email: string | null; phone: string | null }[];
  processes: {
    id: string;
    processNumber: string;
    mainStatus: MainStatus;
    eventDate: string | null;
    customerDisplayName: string;
  }[];
  canViewCompleted: boolean;
  /** Offline-Router (Finalisierung §6): Maschinentreffer aus dem lokalen Arbeitspaket. */
  machines?: { id: string; machineCode: string; status: string }[];
  /** true = Suche lief nur im lokal geladenen Arbeitspaket (kein Serverkontakt). */
  offline?: boolean;
}

function SearchView() {
  const [query, setQuery] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const offline = useOffline();
  const offlineNow = offline?.state.connectivity === 'offline';
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      setSearching(true);
      void apiFetch<SearchResponse>(
        `/staff/search?q=${encodeURIComponent(trimmed)}&includeCompleted=${includeCompleted ? 'true' : 'false'}`,
      ).then((result) => {
        setSearching(false);
        if (result.data !== null) {
          setResults(result.data);
          setError(null);
        } else {
          setError(result.errorMessage ?? 'Die Suche ist fehlgeschlagen.');
        }
      });
    }, 250);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query, includeCompleted]);

  const machines = results?.machines ?? [];
  const empty =
    results !== null &&
    results.customers.length === 0 &&
    results.processes.length === 0 &&
    machines.length === 0;

  return (
    <main className="page">
      <h1>Suche</h1>
      {error !== null && <p className="error">{error}</p>}
      <div className="card">
        <label htmlFor="search-q">
          Vorgangsnummer, Name, Firma, E-Mail, Telefon oder Eventdatum
        </label>
        <input
          id="search-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="z. B. MR-2026-0001, Meier, 0171…, 12.08.2026"
          autoFocus
        />
        {(results?.canViewCompleted ?? false) && (
          <label className="perm-item" style={{ display: 'inline-flex' }}>
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
            />
            <span>Auch abgeschlossene und stornierte Vorgänge durchsuchen</span>
          </label>
        )}
      </div>

      {(offlineNow || results?.offline === true) && (
        <p className="offline-banner" data-testid="search-offline-hint">
          Offline: Suche nur im geladenen Arbeitspaket
        </p>
      )}
      {query.trim().length > 0 && query.trim().length < 2 && (
        <p className="muted">Bitte mindestens 2 Zeichen eingeben.</p>
      )}
      {searching && <p className="muted">Suche läuft …</p>}
      {empty && !searching && (
        <p className="muted">Keine Treffer. Tipp: Teilbegriffe reichen – auch mit Tippfehlern.</p>
      )}

      {results !== null && results.processes.length > 0 && (
        <div className="card">
          <h2>Vorgänge</h2>
          {results.processes.map((process) => (
            <div
              className="list-row"
              key={process.id}
              data-testid={`search-process-${process.processNumber}`}
            >
              <div>
                <Link href={`/vorgaenge/${process.id}`}>
                  <strong>{process.processNumber}</strong>
                </Link>{' '}
                · {process.customerDisplayName}
                <div className="muted">Event: {formatEventDate(process.eventDate)}</div>
              </div>
              <span className={`badge ${STATUS_BADGE_CLASS[process.mainStatus]}`}>
                {STATUS_LABELS[process.mainStatus]}
              </span>
            </div>
          ))}
        </div>
      )}

      {machines.length > 0 && (
        <div className="card">
          <h2>Maschinen</h2>
          {machines.map((machine) => (
            <div
              className="list-row"
              key={machine.id}
              data-testid={`search-machine-${machine.machineCode}`}
            >
              <div>
                <Link href={`/maschinen/${machine.id}`}>
                  <strong>{machine.machineCode}</strong>
                </Link>
              </div>
              <span className="badge">
                {(MACHINE_STATUS_LABELS as Record<string, string | undefined>)[machine.status] ??
                  machine.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {results !== null && results.customers.length > 0 && (
        <div className="card">
          <h2>Kunden</h2>
          {results.customers.map((customer) => (
            <div className="list-row" key={customer.id}>
              <div>
                <Link href={`/kunden/${customer.id}`}>{customer.displayName}</Link>
                <div className="muted">{customer.email ?? customer.phone ?? '–'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default function SearchPage() {
  return (
    <AuthGuard>
      <SearchView />
    </AuthGuard>
  );
}
