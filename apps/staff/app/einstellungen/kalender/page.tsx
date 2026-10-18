'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { apiFetch } from '../../../lib/api';

/**
 * Einstellungen → Kalender (Phase 12, Order §33): privater, schreibgeschützter
 * ICS-Feed je Mitarbeiter für Apple Kalender & Co. Der Link wird genau
 * einmal angezeigt (nur der Hash liegt auf dem Server); „Neu erzeugen“ macht
 * den alten Link sofort ungültig.
 */
interface FeedStatus {
  configured: boolean;
  createdAt: string | null;
  regeneratedAt: string | null;
  lastAccessAt: string | null;
}

interface FeedCreated {
  url: string;
  absolute: boolean;
  regenerated: boolean;
  hint: string | null;
}

function formatDate(value: string | null): string {
  if (value === null) return '–';
  return new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function CalendarSettings() {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [created, setCreated] = useState<FeedCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<FeedStatus>('/staff/calendar/feed');
    if (result.data !== null) setStatus(result.data);
    else setError(result.errorMessage ?? 'Kalender-Einstellungen konnten nicht geladen werden.');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await apiFetch<FeedCreated>('/staff/calendar/feed', { method: 'POST' });
    setBusy(false);
    if (!result.ok || result.data === null) {
      setError(result.errorMessage ?? 'Der Feed-Link konnte nicht erzeugt werden.');
      return;
    }
    setCreated(result.data);
    await load();
  }

  async function copy() {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setError('Kopieren nicht möglich – bitte den Link markieren und manuell kopieren.');
    }
  }

  return (
    <main className="page">
      <h1>Kalender</h1>
      <p className="muted">
        <Link href="/konto">← Mein Konto</Link>
      </p>
      <div className="card">
        <h2>Mein Kalender-Feed (ICS)</h2>
        <p className="muted">
          Ein privater, schreibgeschützter Kalender mit deinen Abhol-, Liefer- und Rückgabeterminen
          (inkl. Vertretungen). Er enthält nur Terminart, Vorgangsnummer und den Link in die
          Staff-App – keine Kundendaten. Miet-Royal bleibt die führende Quelle; Änderungen im
          Kalender-Programm wirken nicht zurück.
        </p>
        {error !== null && <p className="error">{error}</p>}
        {status !== null && status.configured && created === null && (
          <p className="muted">
            Feed eingerichtet am {formatDate(status.createdAt)}
            {status.regeneratedAt !== null &&
              ` · neu erzeugt am ${formatDate(status.regeneratedAt)}`}
            {' · letzter Abruf: '}
            {formatDate(status.lastAccessAt)}
          </p>
        )}
        {created !== null && (
          <div className="warning-red">
            <p>
              <strong>Dieser Link ist privat – nicht weitergeben.</strong> Wer ihn kennt, sieht
              deine Termine. Er wird nur jetzt einmal angezeigt.
            </p>
            <p className="code-box" data-testid="calendar-feed-url">
              {created.url}
            </p>
            {created.hint !== null && <p className="muted">{created.hint}</p>}
            <button type="button" onClick={() => void copy()}>
              {copied ? 'Kopiert' : 'Link kopieren'}
            </button>
          </div>
        )}
        {status !== null && !status.configured && (
          <button
            className="primary"
            type="button"
            data-testid="calendar-feed-generate"
            disabled={busy}
            onClick={() => void generate()}
          >
            Feed-Link erzeugen
          </button>
        )}
        {status !== null && status.configured && (
          <button
            type="button"
            data-testid="calendar-feed-regenerate"
            disabled={busy}
            onClick={() => setConfirmRegenerate(true)}
          >
            Feed-Link neu erzeugen
          </button>
        )}
      </div>
      <div className="card">
        <h2>Anleitung</h2>
        <p className="muted">
          Der Kalender wird als Abonnement eingebunden und vom Gerät regelmäßig aktualisiert; das
          Intervall bestimmt das Kalender-Programm. Es werden keine Apple-ID-Daten oder Passwörter
          benötigt.
        </p>
        <h3>iPhone / iPad</h3>
        <ol>
          <li>Einstellungen → Apps → Kalender → Accounts → Account hinzufügen → Andere.</li>
          <li>„Kalenderabo hinzufügen“ wählen und den kopierten Link einfügen.</li>
          <li>Ohne Benutzername/Passwort speichern – der Link ist der Zugang.</li>
        </ol>
        <h3>Mac</h3>
        <ol>
          <li>Kalender-App → Ablage → Neues Kalenderabonnement.</li>
          <li>
            Link einfügen und abonnieren; unter „Informationen“ die automatische Aktualisierung
            wählen.
          </li>
        </ol>
        <p className="muted">
          Hinweis: Diese Bedienschritte sind allgemeine Hinweise; verbindlich ist die Dokumentation
          des jeweiligen Geräts.
        </p>
      </div>
      {confirmRegenerate && (
        <ConfirmDialog
          testId="calendar-feed-regenerate-dialog"
          title="Feed-Link neu erzeugen?"
          confirmLabel="Neu erzeugen"
          confirmTestId="calendar-feed-regenerate-confirm"
          busy={busy}
          danger
          onCancel={() => setConfirmRegenerate(false)}
          onConfirm={() => {
            setConfirmRegenerate(false);
            void generate();
          }}
        >
          <p>
            Der bisherige Link wird sofort ungültig. Abonnements müssen neu eingerichtet werden.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

export default function CalendarSettingsPage() {
  return (
    <AuthGuard>
      <CalendarSettings />
    </AuthGuard>
  );
}
