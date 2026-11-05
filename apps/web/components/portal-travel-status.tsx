'use client';

import { useEffect, useState } from 'react';
import {
  PORTAL_UI,
  portalFetch,
  type PortalTravelStatus,
  type PortalTravelStatusResponse,
} from '../lib/portal';

/**
 * „Unterwegs“-Badge (Order §21; Design §2.2): zeigt NUR den Zustand
 * `en_route` als Text + Symbol. Kein GPS, keine Karte, keine ETA, kein
 * Fahrername. Polling alle 30 s über GET /portal/bookings/:id/travel-status
 * (no-store), nur solange der Tab sichtbar ist. Kein WebSocket.
 */

export const TRAVEL_STATUS_POLL_MS = 30_000;

export function PortalTravelStatusBadge({
  bookingId,
  initialStatus,
  poll,
}: {
  bookingId: string;
  initialStatus: PortalTravelStatus;
  /** Polling nur für aktive Lieferbuchungen. */
  poll: boolean;
}) {
  const [status, setStatus] = useState<PortalTravelStatus>(initialStatus);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus, bookingId]);

  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await portalFetch<PortalTravelStatusResponse>(
          `/bookings/${encodeURIComponent(bookingId)}/travel-status`,
        );
        if (!cancelled && (response?.status === 'en_route' || response?.status === 'none')) {
          setStatus(response.status);
        }
      } catch {
        // Fehler beim Polling sind unkritisch – der letzte bekannte Stand bleibt.
      }
    };
    const timer = setInterval(() => void tick(), TRAVEL_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bookingId, poll]);

  if (status !== 'en_route') return null;
  return (
    <span
      data-testid="portal-travel-status"
      role="status"
      style={{
        display: 'inline-block',
        padding: '0.25rem 0.7rem',
        borderRadius: 999,
        border: '1px solid #4a76b8',
        background: '#eef3fb',
        fontWeight: 700,
      }}
    >
      <span aria-hidden="true">🚚 </span>
      {PORTAL_UI.EN_ROUTE}
    </span>
  );
}
