'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { apiFetch } from '../../lib/api';
import { formatEventDate, STATUS_BADGE_CLASS, STATUS_LABELS, type MainStatus } from '../../lib/crm';

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
}

function SearchView() {
  const [query, setQuery] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
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

  const empty =
    results !== null && results.customers.length === 0 && results.processes.length === 0;

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
            <span>Auch abgeschlossene Vorgänge durchsuchen</span>
          </label>
        )}
      </div>

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
            <div className="list-row" key={process.id}>
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
