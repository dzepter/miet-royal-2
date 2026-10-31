'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AuthGuard, useMe } from '../../../components/auth-guard';
import { OfflineActionHint, useOfflineNow } from '../../../components/communication';
import { apiFetch, hasPermission } from '../../../lib/api';
import { todayBerlinIso } from '../../../lib/scheduling';
import { createTour, tourErrorText } from '../../../lib/tours';

/**
 * Neue Tour (Phase 13, Design §13): Datum (Berlin) + Fahrer aus den aktiven
 * Mitarbeitern (bestehende Auswahl-Endpunkte, datenminimal). Nur calendar.manage.
 */
interface StaffOption {
  id: string;
  firstName: string;
  lastName: string;
}

function NewTourForm() {
  const me = useMe();
  const router = useRouter();
  const search = useSearchParams();
  const offlineNow = useOfflineNow();
  const canManage = hasPermission(me, 'calendar.manage');
  const presetDate = search.get('date');
  const [date, setDate] = useState(
    presetDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(presetDate) ? presetDate : todayBerlinIso(),
  );
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [driver, setDriver] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    void (async () => {
      // Aktive Mitarbeiter: Kalender-Auswahl (appointment.assign/substitution.manage/
      // calendar.view_all), sonst die CRM-Auswahl (process.view_all).
      let result = await apiFetch<{ staff: StaffOption[] }>('/staff/scheduling/staff-options');
      if (result.data === null && result.status === 403) {
        result = await apiFetch<{ staff: StaffOption[] }>('/staff/staff-options');
      }
      if (result.data !== null) {
        setStaff(result.data.staff);
        if (result.data.staff.length > 0 && me?.user.id !== undefined) {
          const mine = result.data.staff.find((user) => user.id === me.user.id);
          setDriver(mine?.id ?? '');
        }
      } else {
        setError(result.errorMessage ?? 'Die Mitarbeiterliste konnte nicht geladen werden.');
      }
    })();
  }, [canManage, me]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (driver === '') {
      setError('Bitte einen Fahrer auswählen.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createTour({ tourDate: date, assignedUserId: driver });
    setBusy(false);
    if (result.data !== null) {
      router.push(`/touren/${result.data.tour.id}`);
      return;
    }
    setError(tourErrorText(result, 'Die Tour konnte nicht angelegt werden.'));
  }

  if (!canManage) {
    return (
      <main className="page">
        <h1>Neue Tour</h1>
        <p className="error">Dafür fehlt dir die erforderliche Berechtigung.</p>
        <p>
          <Link href="/touren">Zurück zu den Touren</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Neue Tour</h1>
      <OfflineActionHint testId="tour-new-offline" />
      <form className="card" onSubmit={(event) => void submit(event)} data-testid="tour-new-form">
        <label htmlFor="tour-new-date">Datum</label>
        <input
          id="tour-new-date"
          type="date"
          required
          value={date}
          data-testid="tour-new-date"
          onChange={(event) => setDate(event.target.value)}
        />
        <label htmlFor="tour-new-driver">Fahrer</label>
        <select
          id="tour-new-driver"
          value={driver}
          data-testid="tour-new-driver"
          onChange={(event) => setDriver(event.target.value)}
        >
          <option value="">Bitte wählen …</option>
          {staff.map((user) => (
            <option key={user.id} value={user.id}>
              {user.lastName}, {user.firstName}
            </option>
          ))}
        </select>
        {error !== null && <p className="error">{error}</p>}
        <p>
          <button
            type="submit"
            className="primary"
            disabled={busy || offlineNow || driver === ''}
            data-testid="tour-new-submit"
          >
            Tour anlegen
          </button>{' '}
          <Link href="/touren" className="button-like">
            Abbrechen
          </Link>
        </p>
      </form>
    </main>
  );
}

export default function NewTourPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="muted">Wird geladen …</p>}>
        <NewTourForm />
      </Suspense>
    </AuthGuard>
  );
}
