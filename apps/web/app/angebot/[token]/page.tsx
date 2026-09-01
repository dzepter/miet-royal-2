'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

/**
 * Sicherer öffentlicher Angebotszugang (Phase-3-Vorgaben Nr. 25/26/28/29):
 * kein Kundenkonto, Autorität ist ausschließlich das Token im Link. Der
 * Kunde sieht NUR die aktuelle Version seines Angebots; Annahme per
 * verbindlichem Button – ohne Unterschrift, ohne Checkbox.
 */

interface PublicLineItem {
  description: string;
  quantity: number;
  unit: string;
  agreedUnitPriceCents: number;
  totalCents: number;
  billingMode: 'fixed' | 'commission' | 'included';
}

interface PublicOffer {
  processNumber: string;
  versionNumber: number;
  status: string;
  customerSnapshot: { displayName?: string; email?: string } | null;
  eventSnapshot: {
    eventDate?: string;
    eventStart?: string | null;
    eventEnd?: string | null;
    fulfillment?: string;
  } | null;
  lineItems: PublicLineItem[];
  machineSubtotalCents: number | null;
  discountCents: number | null;
  fixedTotalCents: number | null;
  commissionMaxCents: number;
  expiresAt: string | null;
  acceptedAt: string | null;
  terms: { label: string; content: string; isTest: boolean } | null;
}

function euro(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100).toLocaleString('de-DE')},${String(abs % 100).padStart(2, '0')} €`;
}

function formatDate(value: string | null): string {
  if (value === null) return '–';
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  return new Date(value).toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const card: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e2e2',
  borderRadius: 8,
  padding: '1.25rem',
  marginBottom: '1rem',
};

export default function PublicOfferPage() {
  const params = useParams<{ token: string }>();
  const [offer, setOffer] = useState<PublicOffer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justAccepted, setJustAccepted] = useState(false);
  const [recheckRequested, setRecheckRequested] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/public/offers/${params.token}`);
    if (!response.ok) {
      setNotFound(true);
      return;
    }
    const body = (await response.json()) as { offer: PublicOffer };
    setOffer(body.offer);
  }, [params.token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/public/offers/${params.token}/accept`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? 'Die Annahme ist fehlgeschlagen. Bitte erneut versuchen.');
      await load();
      return;
    }
    setJustAccepted(true);
    await load();
  }

  async function requestRecheck() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/public/offers/${params.token}/recheck`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      setError('Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.');
      return;
    }
    setRecheckRequested(true);
    await load();
  }

  if (notFound) {
    return (
      <main style={{ maxWidth: '40rem', margin: '10vh auto', padding: '1rem' }}>
        <div style={card}>
          <h1 style={{ fontSize: '1.25rem' }}>Angebot nicht verfügbar</h1>
          <p>Dieser Link ist ungültig oder das Angebot ist nicht mehr abrufbar.</p>
        </div>
      </main>
    );
  }
  if (offer === null) {
    return (
      <main style={{ maxWidth: '40rem', margin: '10vh auto', padding: '1rem' }}>
        <p style={{ color: '#666' }}>Angebot wird geladen …</p>
      </main>
    );
  }

  const accepted = offer.status === 'accepted';
  const expired = offer.status === 'expired';
  const recheck = offer.status === 'recheck_requested' || recheckRequested;
  const acceptable = offer.status === 'sent';

  return (
    <main style={{ maxWidth: '44rem', margin: '2rem auto', padding: '0 1rem 3rem' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Miet-Royal-Angebot</h1>
      <p style={{ color: '#555' }}>
        Vorgang {offer.processNumber} · Version {offer.versionNumber}
        {offer.customerSnapshot?.displayName ? ` · für ${offer.customerSnapshot.displayName}` : ''}
      </p>

      {(accepted || justAccepted) && (
        <div style={{ ...card, borderColor: '#2e7d32', background: '#f1f8e9' }}>
          <h2 style={{ marginTop: 0 }}>Vielen Dank!</h2>
          <p>Dein Angebot wurde verbindlich angenommen.</p>
          <p style={{ color: '#555' }}>
            Die Auftragsbestätigung folgt nach Prüfung/Freigabe durch Miet-Royal.
          </p>
        </div>
      )}
      {expired && !recheck && (
        <div style={{ ...card, borderColor: '#e65100', background: '#fff3e0' }}>
          <h2 style={{ marginTop: 0 }}>Angebot abgelaufen</h2>
          <p>
            Die Gültigkeit dieses Angebots ist abgelaufen. Du kannst eine erneute Prüfung anfragen –
            wir melden uns dann bei dir.
          </p>
          <button
            onClick={() => void requestRecheck()}
            disabled={busy}
            style={{ padding: '0.6rem 1rem', fontSize: '1rem', cursor: 'pointer' }}
          >
            Erneute Prüfung anfragen
          </button>
        </div>
      )}
      {recheck && (
        <div style={{ ...card, background: '#eef3fb', borderColor: '#4a76b8' }}>
          <p style={{ margin: 0 }}>
            Deine Anfrage zur erneuten Prüfung ist eingegangen. Miet-Royal meldet sich bei dir.
          </p>
        </div>
      )}
      {error !== null && (
        <div style={{ ...card, borderColor: '#b3261e', background: '#fdecea' }}>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Eventdaten</h2>
        <p>Eventdatum: {offer.eventSnapshot?.eventDate ?? '–'}</p>
        {(offer.eventSnapshot?.eventStart || offer.eventSnapshot?.eventEnd) && (
          <p>
            Zeitraum: {formatTime(offer.eventSnapshot?.eventStart)} bis{' '}
            {formatTime(offer.eventSnapshot?.eventEnd)} Uhr
          </p>
        )}
        <p>
          Abwicklung:{' '}
          {offer.eventSnapshot?.fulfillment === 'delivery'
            ? 'Lieferung (individuell geprüft)'
            : 'Selbstabholung'}
        </p>
        {offer.expiresAt !== null && !accepted && (
          <p>
            <strong>Gültig bis: {formatDate(offer.expiresAt)}</strong>
          </p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Positionen</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: '0.4rem 0' }}>Position</th>
                <th style={{ textAlign: 'right' }}>Menge</th>
                <th style={{ textAlign: 'right' }}>Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {offer.lineItems.map((item, index) => (
                <tr key={index} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0' }}>{item.description}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {item.quantity} {item.unit}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {item.billingMode === 'included'
                      ? 'inklusive'
                      : item.billingMode === 'commission'
                        ? `${euro(item.totalCents)}*`
                        : euro(item.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {offer.discountCents !== null && offer.discountCents > 0 && (
          <p style={{ textAlign: 'right', margin: '0.6rem 0 0' }}>
            Rabatt: -{euro(offer.discountCents)}
          </p>
        )}
        <p style={{ textAlign: 'right', fontSize: '1.15rem', fontWeight: 700 }}>
          Fester Angebotswert: {euro(offer.fixedTotalCents ?? 0)}
        </p>
        {offer.commissionMaxCents > 0 && (
          <p style={{ color: '#555', fontSize: '0.85rem', textAlign: 'right' }}>
            * Kommissionsartikel – Abrechnung nach tatsächlichem Verbrauch, erfolgt nach der
            Rückgabe (maximal {euro(offer.commissionMaxCents)}). Ungeöffnete Sirupflaschen werden
            nicht berechnet.
          </p>
        )}
      </div>

      <div style={card}>
        <p style={{ margin: 0 }}>
          <a href={`/api/public/offers/${params.token}/pdf`} target="_blank" rel="noreferrer">
            Angebot als PDF ansehen/herunterladen
          </a>
        </p>
        {offer.terms !== null && (
          <p style={{ margin: '0.6rem 0 0' }}>
            <button
              onClick={() => setShowTerms((value) => !value)}
              style={{
                background: 'none',
                border: 'none',
                color: '#0b57d0',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Mietbedingungen {offer.terms.isTest ? '(TEST-Platzhalter) ' : ''}
              {showTerms ? 'ausblenden' : 'anzeigen'}
            </button>
          </p>
        )}
        {showTerms && offer.terms !== null && (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              fontSize: '0.85rem',
              color: '#444',
              marginTop: '0.6rem',
            }}
          >
            {offer.terms.content}
          </pre>
        )}
      </div>

      {acceptable && (
        <div style={{ ...card, textAlign: 'center' }}>
          <button
            onClick={() => void accept()}
            disabled={busy}
            style={{
              background: '#1b5e20',
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '0.9rem 1.6rem',
              fontSize: '1.05rem',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Wird verarbeitet …' : 'Angebot verbindlich annehmen'}
          </button>
          <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 0 }}>
            Mit dem Klick nimmst du das Angebot verbindlich an.
          </p>
        </div>
      )}
    </main>
  );
}
