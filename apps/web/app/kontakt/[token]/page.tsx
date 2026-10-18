'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Kunden-Aktionslink „Abholperson ändern“ / „Kontakt vor Ort ändern“
 * (Phase 12, Order §20): Single-Purpose-Seite, kein Portal, kein Konto.
 * Autorität ist ausschließlich das Token im Link. Angezeigt werden nur
 * Vorgangsnummer, Terminart und -zeit sowie der aktuell hinterlegte Kontakt;
 * gespeichert werden Vorname, Nachname, Telefon. Jeder Fehlerfall des Links
 * (unbekannt, abgelaufen, ab 1 h vor Termin, storniert) ⇒ dieselbe neutrale
 * Meldung. Kein Tracking, keine externen Ressourcen.
 */

type Purpose = 'pickup_contact_update' | 'delivery_contact_update';

interface ActionView {
  purpose: Purpose;
  processNumber: string;
  appointmentAt: string;
  appointmentEndAt: string | null;
  current: { firstName: string; lastName: string; phone: string } | null;
}

const NOT_AVAILABLE = 'Dieser Link ist nicht verfügbar.';

const card: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e2e2',
  borderRadius: 8,
  padding: '1.25rem',
  marginBottom: '1rem',
};

const input: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.7rem 0.75rem',
  fontSize: '1rem',
  border: '1px solid #c8c8c8',
  borderRadius: 6,
  margin: '0.25rem 0 0.9rem',
};

function berlinDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function berlinTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function appointmentLabel(action: ActionView): string {
  const start = berlinDateTime(action.appointmentAt);
  if (action.appointmentEndAt === null) return `${start} Uhr`;
  return `${start}–${berlinTime(action.appointmentEndAt)} Uhr`;
}

function NotAvailable() {
  return (
    <main style={{ maxWidth: '36rem', margin: '10vh auto', padding: '1rem' }}>
      <div style={card} data-testid="contact-not-available">
        <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{NOT_AVAILABLE}</h1>
        <p style={{ marginBottom: 0, color: '#555' }}>
          Bei Fragen melde dich bitte direkt bei Miet-Royal.
        </p>
      </div>
    </main>
  );
}

export default function ContactActionPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [action, setAction] = useState<ActionView | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Felder nur EINMAL aus dem Server-Stand vorbelegen: ein spätes oder doppeltes
  // Laden (z. B. langsame Antwort, doppelt ausgeführter Effekt) darf bereits
  // Eingetipptes nie überschreiben. Nach dem Speichern wird bewusst übernommen.
  const prefilled = useRef(false);
  const apply = useCallback((next: ActionView, mode: 'load' | 'saved') => {
    setAction(next);
    if (mode === 'load' && prefilled.current) return;
    prefilled.current = true;
    setFirstName(next.current?.firstName ?? '');
    setLastName(next.current?.lastName ?? '');
    setPhone(next.current?.phone ?? '');
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    let response: Response;
    try {
      response = await fetch(`/api/public/actions/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
    } catch {
      setLoadFailed(true);
      return;
    }
    if (response.status === 429) {
      setLoadFailed(true);
      return;
    }
    if (!response.ok) {
      setNotAvailable(true);
      return;
    }
    const body = (await response.json().catch(() => null)) as { action?: ActionView } | null;
    if (body?.action === undefined) {
      setNotAvailable(true);
      return;
    }
    apply(body.action, 'load');
  }, [apply, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    let response: Response;
    try {
      response = await fetch(`/api/public/actions/${encodeURIComponent(token)}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
        }),
      });
    } catch {
      setBusy(false);
      setError('Keine Verbindung. Bitte später erneut versuchen.');
      return;
    }
    setBusy(false);
    if (response.status === 404) {
      setNotAvailable(true);
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      action?: ActionView;
      error?: { message?: string };
    } | null;
    if (response.status === 400) {
      setError(body?.error?.message ?? 'Bitte Vorname, Nachname und Telefonnummer prüfen.');
      return;
    }
    if (response.status === 429) {
      setError('Zu viele Versuche. Bitte in einigen Minuten erneut versuchen.');
      return;
    }
    if (!response.ok || body?.action === undefined) {
      setError('Speichern ist fehlgeschlagen. Bitte später erneut versuchen.');
      return;
    }
    apply(body.action, 'saved');
    setSaved(true);
  }

  if (notAvailable) return <NotAvailable />;
  if (action === null) {
    return (
      <main style={{ maxWidth: '36rem', margin: '10vh auto', padding: '1rem' }}>
        {loadFailed ? (
          <div style={card}>
            <p style={{ marginTop: 0 }}>
              Die Seite konnte gerade nicht geladen werden. Bitte später erneut versuchen.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              style={{ padding: '0.6rem 1rem', fontSize: '1rem', cursor: 'pointer' }}
            >
              Erneut versuchen
            </button>
          </div>
        ) : (
          <p style={{ color: '#666' }}>Wird geladen …</p>
        )}
      </main>
    );
  }

  const pickup = action.purpose === 'pickup_contact_update';
  const kindLabel = pickup ? 'Abholung' : 'Lieferung';

  return (
    <main
      style={{ maxWidth: '36rem', margin: '2rem auto', padding: '0 1rem 3rem' }}
      data-testid="contact-page"
      data-purpose={action.purpose}
    >
      <h1 style={{ fontSize: '1.4rem' }}>
        {pickup ? 'Abholperson ändern' : 'Kontakt vor Ort ändern'}
      </h1>

      <div style={card}>
        <p style={{ marginTop: 0 }}>
          Vorgang <strong data-testid="contact-process-number">{action.processNumber}</strong>
        </p>
        <p style={{ marginBottom: 0 }}>
          <span data-testid="contact-appointment-kind">{kindLabel}</span>:{' '}
          <strong data-testid="contact-appointment-time">{appointmentLabel(action)}</strong>
        </p>
      </div>

      {saved && (
        <div
          style={{ ...card, borderColor: '#2e7d32', background: '#f1f8e9' }}
          role="status"
          data-testid="contact-saved"
        >
          <p style={{ margin: 0 }}>
            Danke! {pickup ? 'Die Abholperson' : 'Der Kontakt vor Ort'} ist gespeichert:{' '}
            <strong>
              {action.current?.firstName} {action.current?.lastName}
            </strong>
            , {action.current?.phone}.
          </p>
        </div>
      )}
      {error !== null && (
        <div
          style={{ ...card, borderColor: '#b3261e', background: '#fdecea' }}
          role="alert"
          data-testid="contact-error"
        >
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}

      <form style={card} onSubmit={(e) => void save(e)} data-testid="contact-form">
        <p style={{ marginTop: 0, color: '#555' }}>
          {pickup
            ? 'Wer holt die Maschine ab? Diese Person muss bei der Abholung erreichbar sein.'
            : 'Wer ist bei der Lieferung vor Ort erreichbar?'}
        </p>
        <label htmlFor="contact-first-name">Vorname</label>
        <input
          id="contact-first-name"
          data-testid="contact-first-name"
          style={input}
          autoComplete="given-name"
          maxLength={80}
          required
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <label htmlFor="contact-last-name">Nachname</label>
        <input
          id="contact-last-name"
          data-testid="contact-last-name"
          style={input}
          autoComplete="family-name"
          maxLength={80}
          required
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <label htmlFor="contact-phone">Telefonnummer</label>
        <input
          id="contact-phone"
          data-testid="contact-phone"
          style={input}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={30}
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <button
          type="submit"
          data-testid="contact-submit"
          disabled={busy}
          style={{
            background: '#1b5e20',
            color: '#ffffff',
            border: 'none',
            borderRadius: 6,
            padding: '0.85rem 1.4rem',
            fontSize: '1.05rem',
            cursor: busy ? 'wait' : 'pointer',
            width: '100%',
          }}
        >
          {busy ? 'Wird gespeichert …' : 'Speichern'}
        </button>
        <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 0 }}>
          Änderungen sind bis eine Stunde vor dem Termin möglich. Eine neue Angabe ersetzt die
          bisherige.
        </p>
      </form>
    </main>
  );
}
