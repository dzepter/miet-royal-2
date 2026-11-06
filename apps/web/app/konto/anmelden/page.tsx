'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  PORTAL_MESSAGES,
  PORTAL_ROUTES,
  portalErrorMessage,
  portalFetch,
  readTokenFromHash,
  stripFragmentFromLocation,
  type PortalConsumeResponse,
  type PortalMessageResponse,
} from '../../../lib/portal';
import {
  ErrorBox,
  InfoBox,
  PortalMain,
  card,
  inputStyle,
  labelStyle,
  mutedStyle,
  primaryButton,
} from '../../../components/portal-ui';

/**
 * Anmeldung per Magic Link (Order §4, §7; Design §5):
 * - Formular ⇒ POST /portal/auth/request ⇒ IMMER derselbe neutrale Text.
 * - Link `/konto/anmelden#token=…`: das Fragment wird beim Laden gelesen,
 *   SOFORT per history.replaceState aus der Adresszeile entfernt und nur im
 *   React-State gehalten (nie Storage/Cookie/URL/Konsole). Erst der Klick auf
 *   „Kundenbereich öffnen“ verbraucht das Token per POST – kein GET-Consume,
 *   damit Mail-Scanner den Link nicht verbrauchen.
 */

type Phase = 'form' | 'requested' | 'token';

export default function PortalLoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('form');
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [neutral, setNeutral] = useState<string | null>(null);

  useEffect(() => {
    const found = readTokenFromHash(window.location.hash);
    if (window.location.hash !== '') stripFragmentFromLocation();
    if (found !== null) {
      setToken(found);
      setPhase('token');
    }
  }, []);

  async function requestLink(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await portalFetch<PortalMessageResponse>('/auth/request', {
        method: 'POST',
        body: { email: email.trim() },
      });
      setNeutral(
        typeof response?.message === 'string' && response.message !== ''
          ? response.message
          : PORTAL_MESSAGES.MAGIC_LINK_REQUESTED,
      );
      setPhase('requested');
    } catch (caught) {
      setError(portalErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    if (busy || token === null) return;
    setBusy(true);
    setError(null);
    try {
      await portalFetch<PortalConsumeResponse>('/auth/consume', {
        method: 'POST',
        body: { token },
      });
      setToken(null);
      router.replace(PORTAL_ROUTES.home);
    } catch (caught) {
      // Token ist verbraucht/ungültig ⇒ aus dem Speicher entfernen, Formular zeigen.
      setToken(null);
      setPhase('form');
      setError(portalErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <PortalMain testId="portal-login-page">
      <h1 style={{ fontSize: '1.4rem' }}>Dein Kundenbereich</h1>

      {error !== null && <ErrorBox message={error} />}

      {phase === 'token' && token !== null && (
        <div style={card} data-testid="portal-login-token-card">
          <p style={{ marginTop: 0 }}>
            Dein Anmeldelink wurde erkannt. Mit einem Klick öffnest du deinen Kundenbereich.
          </p>
          <button
            type="button"
            onClick={() => void openPortal()}
            disabled={busy}
            style={primaryButton(busy)}
            data-testid="portal-login-open"
          >
            {busy ? 'Wird geöffnet …' : 'Kundenbereich öffnen'}
          </button>
          <p style={{ ...mutedStyle, fontSize: '0.85rem', marginBottom: 0 }}>
            Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.
          </p>
        </div>
      )}

      {phase === 'requested' && (
        <InfoBox tone="success" testId="portal-login-neutral">
          <span>{neutral ?? PORTAL_MESSAGES.MAGIC_LINK_REQUESTED}</span>
          <p style={{ ...mutedStyle, fontSize: '0.9rem', margin: '0.6rem 0 0' }}>
            Der Link ist 15 Minuten gültig. Keine E-Mail erhalten? Prüfe den Spam-Ordner oder
            fordere unten einen neuen Link an.
          </p>
        </InfoBox>
      )}

      {phase !== 'token' && (
        <form style={card} onSubmit={(e) => void requestLink(e)} data-testid="portal-login-form">
          <p style={{ marginTop: 0, ...mutedStyle }}>
            Gib die E-Mail-Adresse ein, mit der du bei Miet-Royal gebucht hast. Wir schicken dir
            einen Anmeldelink – ganz ohne Passwort.
          </p>
          <label htmlFor="portal-login-email" style={labelStyle}>
            E-Mail-Adresse
          </label>
          <input
            id="portal-login-email"
            data-testid="portal-login-email"
            style={inputStyle}
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={320}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            style={primaryButton(busy)}
            data-testid="portal-login-submit"
          >
            {busy ? 'Wird gesendet …' : 'Anmeldelink anfordern'}
          </button>
        </form>
      )}
    </PortalMain>
  );
}
