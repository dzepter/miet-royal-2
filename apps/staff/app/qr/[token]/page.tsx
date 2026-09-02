'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthGuard } from '../../../components/auth-guard';
import { apiFetch } from '../../../lib/api';

/**
 * QR-Einstieg (Order §10): Mitarbeiter scannt den Maschinen-QR → nach
 * Staff-Login öffnet sich die richtige Maschine. Ungültige QR-Codes werden
 * neutral abgelehnt; ohne Berechtigung gibt es KEINE Maschinendaten.
 */
function QrResolveView() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void apiFetch<{ machineId: string }>(
      `/staff/machines/qr/${encodeURIComponent(params.token)}`,
    ).then((result) => {
      if (result.data !== null) {
        router.replace(`/maschinen/${result.data.machineId}`);
      } else {
        setFailed(true);
      }
    });
  }, [params.token, router]);

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
