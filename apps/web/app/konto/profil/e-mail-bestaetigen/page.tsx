'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  PORTAL_MESSAGES,
  PORTAL_ROUTES,
  portalErrorMessage,
  portalFetch,
  readTokenFromHash,
  stripFragmentFromLocation,
  type PortalEmailChangeConsumeResponse,
} from '../../../../lib/portal';
import {
  ErrorBox,
  InfoBox,
  PortalMain,
  card,
  mutedStyle,
  primaryButton,
} from '../../../../components/portal-ui';

/**
 * Bestätigung der neuen E-Mail-Adresse /konto/profil/e-mail-bestaetigen
 * (Order §34–§35; Design §1.2/§5): Token aus dem Fragment ⇒ sofort aus der URL
 * entfernt, nur im State. Klick „Neue E-Mail-Adresse bestätigen“ ⇒ POST
 * /portal/auth/email-change/consume (ohne Session-Zwang – darf auf einem
 * anderen Gerät geöffnet werden). Erfolg ⇒ alle Sessions sind widerrufen,
 * Text EMAIL_CHANGED + Link zur Anmeldung.
 */
export default function PortalEmailChangeConfirmPage() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const found = readTokenFromHash(window.location.hash);
    if (window.location.hash !== '') stripFragmentFromLocation();
    // Phase 15 (E2E-Fix): idempotent wie /konto/anmelden – React StrictMode (development)
    // führt den Effekt doppelt aus; der zweite Lauf sieht das bereits entfernte Fragment
    // und darf das gelesene Token nicht wieder auf null setzen.
    if (found !== null) setToken(found);
    setChecked(true);
  }, []);

  async function confirm() {
    if (busy || token === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await portalFetch<PortalEmailChangeConsumeResponse>(
        '/auth/email-change/consume',
        { method: 'POST', body: { token } },
      );
      setToken(null);
      setDone(
        typeof response?.message === 'string' && response.message !== ''
          ? response.message
          : PORTAL_MESSAGES.EMAIL_CHANGED,
      );
    } catch (caught) {
      setToken(null);
      setError(portalErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalMain testId="portal-email-change-page">
      <h1 style={{ fontSize: '1.4rem' }}>Neue E-Mail-Adresse bestätigen</h1>

      {done !== null && (
        <InfoBox tone="success" testId="portal-email-changed">
          <span>{done}</span>
          <p style={{ margin: '0.75rem 0 0' }}>
            <Link
              href={PORTAL_ROUTES.login}
              prefetch={false}
              data-testid="portal-email-changed-login"
              style={{ fontWeight: 600 }}
            >
              Zur Anmeldung
            </Link>
          </p>
        </InfoBox>
      )}

      {error !== null && (
        <ErrorBox message={error}>
          <p style={{ margin: '0.75rem 0 0' }}>
            <Link href={PORTAL_ROUTES.login} prefetch={false}>
              Zur Anmeldung
            </Link>
          </p>
        </ErrorBox>
      )}

      {checked && done === null && token !== null && (
        <div style={card}>
          <p style={{ marginTop: 0 }}>
            Mit einem Klick bestätigst du deine neue E-Mail-Adresse. Danach meldest du dich mit der
            neuen Adresse neu an.
          </p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            style={primaryButton(busy)}
            data-testid="portal-email-change-confirm"
          >
            {busy ? 'Wird bestätigt …' : 'Neue E-Mail-Adresse bestätigen'}
          </button>
          <p style={{ ...mutedStyle, fontSize: '0.85rem', marginBottom: 0 }}>
            Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.
          </p>
        </div>
      )}

      {checked && done === null && token === null && error === null && (
        <div style={card} data-testid="portal-email-change-missing">
          <p style={{ marginTop: 0 }}>{PORTAL_MESSAGES.TOKEN_INVALID}</p>
          <p style={{ marginBottom: 0 }}>
            <Link href={PORTAL_ROUTES.profile} prefetch={false}>
              Zum Profil
            </Link>
          </p>
        </div>
      )}
    </PortalMain>
  );
}
