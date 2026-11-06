'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  PORTAL_ROUTES,
  PORTAL_UI,
  formatDate,
  isUnauthenticated,
  portalErrorMessage,
  portalFetch,
  type PortalBookingListResponse,
  type PortalBookingSummary,
  type PortalMeView,
} from '../../lib/portal';
import {
  CallButton,
  ErrorBox,
  Loading,
  PortalMain,
  StateBadge,
  card,
  mutedStyle,
  primaryButton,
  secondaryButton,
} from '../../components/portal-ui';

/**
 * Übersicht /konto (Order §15; Design §5): GET /portal/me + GET /portal/bookings.
 * 0 Buchungen ⇒ Hauptaktion „Neue Anfrage starten“; 1 ⇒ direkt zur Buchung;
 * >1 ⇒ Liste „Aktuelle Buchungen“ (Sortierung kommt von der API). Keine Historie.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; me: PortalMeView; bookings: PortalBookingSummary[] };

export default function PortalOverviewPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [me, list] = await Promise.all([
        portalFetch<PortalMeView>('/me'),
        portalFetch<PortalBookingListResponse>('/bookings'),
      ]);
      const bookings = Array.isArray(list?.bookings) ? list.bookings : [];
      const only = bookings.length === 1 ? bookings[0] : undefined;
      if (only !== undefined) {
        router.replace(PORTAL_ROUTES.booking(only.bookingId));
        return;
      }
      setState({ kind: 'ready', me, bookings });
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        router.replace(PORTAL_ROUTES.login);
        return;
      }
      setState({ kind: 'failed', message: portalErrorMessage(caught) });
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <PortalMain>
        <Loading />
      </PortalMain>
    );
  }
  if (state.kind === 'failed') {
    return (
      <PortalMain>
        <ErrorBox message={state.message}>
          <p style={{ margin: '0.75rem 0 0' }}>
            <button type="button" onClick={() => void load()} style={secondaryButton}>
              Erneut versuchen
            </button>
          </p>
        </ErrorBox>
      </PortalMain>
    );
  }

  const { me, bookings } = state;

  if (bookings.length === 0) {
    return (
      <PortalMain testId="portal-overview">
        <h1 style={{ fontSize: '1.4rem' }}>Hallo {me.customer.displayName}</h1>
        <div style={card} data-testid="portal-no-booking">
          <p style={{ marginTop: 0 }}>Aktuell liegt keine laufende Buchung für dich vor.</p>
          {me.links.newInquiryUrl !== null ? (
            <a
              href={me.links.newInquiryUrl}
              rel="noreferrer"
              data-testid="portal-new-inquiry"
              style={{
                ...primaryButton(),
                display: 'block',
                textAlign: 'center',
                textDecoration: 'none',
                boxSizing: 'border-box',
              }}
            >
              Neue Anfrage starten
            </a>
          ) : (
            <>
              <p style={{ marginBottom: '0.75rem' }} data-testid="portal-new-inquiry">
                {PORTAL_UI.NEW_INQUIRY_FALLBACK}
              </p>
              <CallButton phoneNumber={me.links.phoneNumber} />
            </>
          )}
        </div>
      </PortalMain>
    );
  }

  return (
    <PortalMain testId="portal-overview">
      <h1 style={{ fontSize: '1.4rem' }}>Aktuelle Buchungen</h1>
      <p style={mutedStyle}>Hallo {me.customer.displayName}, wähle eine Buchung aus.</p>
      <ul
        style={{ listStyle: 'none', padding: 0, margin: 0 }}
        data-testid="portal-booking-list"
        aria-label="Aktuelle Buchungen"
      >
        {bookings.map((booking) => (
          <li key={booking.bookingId} style={card} data-testid="portal-booking-item">
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: '0.5rem',
                alignItems: 'baseline',
              }}
            >
              <strong data-testid="portal-process-number">{booking.processNumber}</strong>
              <StateBadge state={booking.portalState} label={booking.stateLabel} />
            </div>
            <p style={{ margin: '0.5rem 0 0.25rem' }}>
              Eventdatum: <strong>{formatDate(booking.eventDate)}</strong>
              {booking.travelStatus === 'en_route' && (
                <span
                  data-testid="portal-travel-status"
                  style={{ marginLeft: '0.6rem', fontWeight: 600 }}
                >
                  <span aria-hidden="true">🚚 </span>
                  {PORTAL_UI.EN_ROUTE}
                </span>
              )}
            </p>
            <p style={{ margin: '0 0 0.75rem', ...mutedStyle }}>
              {booking.machines.length > 0 ? booking.machines.join(', ') : 'Maschine siehe Details'}
              {' · '}
              {booking.fulfillment === 'delivery' ? 'Lieferung' : 'Selbstabholung'}
            </p>
            <Link
              href={PORTAL_ROUTES.booking(booking.bookingId)}
              prefetch={false}
              data-testid="portal-booking-open"
              style={{
                ...secondaryButton,
                display: 'block',
                textAlign: 'center',
                textDecoration: 'none',
                boxSizing: 'border-box',
              }}
            >
              Buchung öffnen
            </Link>
          </li>
        ))}
      </ul>
    </PortalMain>
  );
}
