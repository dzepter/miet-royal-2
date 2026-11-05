'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  PORTAL_MESSAGES,
  PORTAL_ROUTES,
  isUnauthenticated,
  portalErrorMessage,
  portalFetch,
  readTokenFromHash,
  stripFragmentFromLocation,
  type PortalReauthConsumeResponse,
} from '../../../../lib/portal';
import {
  ErrorBox,
  PortalMain,
  card,
  mutedStyle,
  primaryButton,
} from '../../../../components/portal-ui';

/**
 * Reauth-Bestätigung /konto/profil/bestaetigen (Order §32; Design §5): das
 * Token aus dem Fragment wird sofort aus der URL entfernt und nur im State
 * gehalten; der Klick „Änderung bestätigen“ verbraucht es per POST
 * /portal/auth/reauth/consume (nur mit derselben aktiven Session). Danach
 * zurück zum Profil mit `?bestaetigt=1` (keine Daten im Query).
 */
export default function PortalReauthConfirmPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await portalFetch<PortalReauthConsumeResponse>('/auth/reauth/consume', {
        method: 'POST',
        body: { token },
      });
      setToken(null);
      router.replace(`${PORTAL_ROUTES.profile}?bestaetigt=1`);
    } catch (caught) {
      setToken(null);
      setBusy(false);
      if (isUnauthenticated(caught)) {
        // Keine (gültige) Portal-Session in diesem Browser: der Link muss im
        // selben angemeldeten Browser geöffnet werden.
        setError(
          'Bitte öffne diesen Link in dem Browser, in dem du im Kundenbereich angemeldet bist, und fordere die Bestätigung bei Bedarf erneut an.',
        );
        return;
      }
      setError(portalErrorMessage(caught));
    }
  }

  return (
    <PortalMain testId="portal-reauth-page">
      <h1 style={{ fontSize: '1.4rem' }}>Änderung bestätigen</h1>
      {error !== null && <ErrorBox message={error} />}
      {!checked ? null : token !== null ? (
        <div style={card}>
          <p style={{ marginTop: 0 }}>
            Mit einem Klick bestätigst du, dass du Änderungen an deinem Profil vornehmen möchtest.
          </p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            style={primaryButton(busy)}
            data-testid="portal-reauth-confirm"
          >
            {busy ? 'Wird bestätigt …' : 'Änderung bestätigen'}
          </button>
          <p style={{ ...mutedStyle, fontSize: '0.85rem', marginBottom: 0 }}>
            Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.
          </p>
        </div>
      ) : (
        <div style={card} data-testid="portal-reauth-missing">
          <p style={{ marginTop: 0 }}>
            {error === null
              ? PORTAL_MESSAGES.TOKEN_INVALID
              : 'Du kannst im Profil einen neuen Bestätigungslink anfordern.'}
          </p>
          <p style={{ marginBottom: 0 }}>
            <Link
              href={PORTAL_ROUTES.profile}
              prefetch={false}
              data-testid="portal-reauth-to-profile"
            >
              Zurück zum Profil
            </Link>
          </p>
        </div>
      )}
    </PortalMain>
  );
}
