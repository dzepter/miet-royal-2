'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { apiFetch } from '../../../lib/api';

/**
 * QR-Einstieg (Order §10): Mitarbeiter scannt den Maschinen-QR → nach
 * Staff-Login öffnet sich die richtige Maschine. Ungültige QR-Codes werden
 * neutral abgelehnt; ohne Berechtigung gibt es KEINE Maschinendaten.
 * Phase-8-Finalisierung: Der Token wird einmal aus der Route gelesen, sofort
 * aus der Adressleiste entfernt (kein Verlauf-/Screenshot-Leak) und nur als
 * POST-Body aufgelöst – nie in einer URL, nie in `console.*`.
 */
function QrResolveView() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // Token nur einmal übernehmen – nach replaceState liefert die Route ihn nicht mehr.
  const tokenRef = useRef<string | null>(null);
  if (tokenRef.current === null && typeof params.token === 'string' && params.token !== '') {
    tokenRef.current = params.token;
  }

  useEffect(() => {
    const token = tokenRef.current;
    if (token === null) {
      setFailed(true);
      return;
    }
    // Token sofort aus der Adressleiste entfernen (Deep-Link bleibt als Einstieg erhalten).
    try {
      window.history.replaceState(window.history.state, '', '/');
    } catch {
      // Ohne History-API bleibt nur die Weiterleitung unten.
    }
    let cancelled = false;
    void apiFetch<{ machineId: string }>('/staff/machines/qr/resolve', {
      method: 'POST',
      body: { token },
    }).then((result) => {
      if (cancelled) return;
      if (result.data !== null) {
        router.replace(`/maschinen/${result.data.machineId}`);
      } else {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="page">
      {failed ? (
        <div className="card">
          <h1>QR-Code nicht gültig</h1>
          <p className="muted">
            Dieser QR-Code konnte nicht zugeordnet werden oder dir fehlt die Berechtigung.
          </p>
          <p>
            <Link href="/">Zur Startseite</Link>
          </p>
        </div>
      ) : (
        <p className="muted">Maschine wird geöffnet …</p>
      )}
    </main>
  );
}

export default function QrResolvePage() {
  return (
    <AuthGuard>
      <QrResolveView />
    </AuthGuard>
  );
}
