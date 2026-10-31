/**
 * Phase 13: reine Touren-Fachlogik – Deadline-/Frühestbeginn-Regel, Puffer,
 * Bewertung einer Reihenfolge, Planer mit festen Ankern, Navigations-Links.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOUR_DEPARTURE_HOUR,
  TOUR_STOP_BUFFER_MINUTES_DEFAULT,
  defaultTourDeparture,
  evaluateOrder,
  navigationLinks,
  planWithAnchors,
  stopDeadline,
  stopEarliestStart,
  stopTimeWindow,
  tourStopState,
  type PlanStop,
  type TourPlanMatrix,
} from '../src/tours.ts';

const T0 = new Date('2026-06-10T06:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** Symmetrische Matrix aus Minutenabständen; null = unerreichbar. */
function matrixOf(minutes: (number | null)[][]): TourPlanMatrix {
  return {
    durationsSeconds: minutes.map((row) => row.map((m) => (m === null ? null : m * 60))),
    distancesMeters: minutes.map((row) => row.map((m) => (m === null ? null : m * 1000))),
  };
}

function stop(id: string, matrixIndex: number, overrides: Partial<PlanStop> = {}): PlanStop {
  return {
    id,
    matrixIndex,
    isPinned: false,
    bufferMinutes: TOUR_STOP_BUFFER_MINUTES_DEFAULT,
    startAt: null,
    endAt: null,
    label: `Stopp ${id}`,
    ...overrides,
  };
}

describe('Deadline-/Frühestbeginn-Regel je Terminart', () => {
  it('exakter Termin: Deadline = Frühestbeginn = Termin; Fenster: Deadline = Ende', () => {
    const exact = { startAt: at(60), endAt: null };
    expect(stopDeadline(exact)?.getTime()).toBe(at(60).getTime());
    expect(stopEarliestStart(exact)?.getTime()).toBe(at(60).getTime());
    expect(stopTimeWindow(exact)).toEqual({ earliest: at(60), latest: at(60) });
    const window = { startAt: at(60), endAt: at(120) };
    expect(stopDeadline(window)?.getTime()).toBe(at(120).getTime());
    expect(stopEarliestStart(window)?.getTime()).toBe(at(60).getTime());
    expect(stopTimeWindow(window)).toEqual({ earliest: at(60), latest: at(120) });
    expect(stopDeadline({ startAt: null, endAt: null })).toBeNull();
    expect(stopTimeWindow({ startAt: null, endAt: null })).toBeNull();
  });

  it('Standardpuffer ist 15 Minuten (zentral)', () => {
    expect(TOUR_STOP_BUFFER_MINUTES_DEFAULT).toBe(15);
  });

  it('Standard-Abfahrt: heute ⇒ jetzt, sonst 08:00 Berlin des Tourdatums', () => {
    const now = new Date('2026-06-10T09:30:00Z');
    expect(defaultTourDeparture('2026-06-10', now).getTime()).toBe(now.getTime());
    expect(DEFAULT_TOUR_DEPARTURE_HOUR).toBe(8);
    expect(defaultTourDeparture('2026-06-12', now).toISOString()).toBe('2026-06-12T06:00:00.000Z');
    expect(defaultTourDeparture('2026-01-12', now).toISOString()).toBe('2026-01-12T07:00:00.000Z');
  });

  it('Stopp-Zustand rein abgeleitet: done > skipped > arrived > open', () => {
    expect(
      tourStopState({ appointmentStatus: 'completed', skippedAt: at(1), arrivedAt: at(1) }),
    ).toBe('done');
    expect(
      tourStopState({ appointmentStatus: 'cancelled', skippedAt: null, arrivedAt: at(1) }),
    ).toBe('skipped');
    expect(
      tourStopState({ appointmentStatus: 'scheduled', skippedAt: at(1), arrivedAt: null }),
    ).toBe('skipped');
    expect(
      tourStopState({ appointmentStatus: 'scheduled', skippedAt: null, arrivedAt: at(1) }),
    ).toBe('arrived');
    expect(
      tourStopState({ appointmentStatus: 'scheduled', skippedAt: null, arrivedAt: null }),
    ).toBe('open');
  });
});

describe('evaluateOrder – Zeiten, Wartezeiten, Puffer, Rückfahrt', () => {
  // 0 = Depot, 1 = A, 2 = B
  const matrix = matrixOf([
    [0, 10, 30],
    [10, 0, 15],
    [30, 15, 0],
  ]);

  it('rechnet Ankunft, Wartezeit bis zum Beginn, Puffer und Rückfahrt (Metriken je Abschnitt)', () => {
    const plan = evaluateOrder({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [stop('A', 1, { startAt: at(20), endAt: at(60) }), stop('B', 2)],
    });
    expect(plan.feasible).toBe(true);
    expect(plan.order).toEqual(['A', 'B']);
    const [a, b] = plan.visits;
    // Fahrt 10 min ⇒ 06:10, Fenster beginnt 06:20 ⇒ 10 min warten, Puffer 15 ⇒ Abfahrt 06:35.
    expect(a!.arrivalAt.getTime()).toBe(at(20).getTime());
    expect(a!.waitingSeconds).toBe(600);
    expect(a!.departureAt.getTime()).toBe(at(35).getTime());
    expect(a!.legDistanceMeters).toBe(10_000);
    expect(a!.legDurationSeconds).toBe(600);
    // B: 15 min Fahrt ⇒ 06:50, Puffer ⇒ 07:05; Rückfahrt 30 ⇒ 07:35.
    expect(b!.arrivalAt.getTime()).toBe(at(50).getTime());
    expect(b!.legDurationSeconds).toBe(900);
    expect(plan.returnLeg).toEqual({ distanceMeters: 30_000, durationSeconds: 1800 });
    expect(plan.plannedEndAt.getTime()).toBe(at(95).getTime());
    expect(plan.totalDistanceMeters).toBe(55_000);
    expect(plan.totalDurationSeconds).toBe(95 * 60);
  });

  it('Ankunft nach der Deadline ⇒ Konflikt mit verständlicher Meldung, keine Terminmutation', () => {
    const exact = stop('A', 2, {
      startAt: at(20),
      endAt: null,
      label: 'Liefertermin MR-2026-0001',
    });
    const plan = evaluateOrder({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [exact],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.conflicts).toEqual([
      {
        stopId: 'A',
        code: 'TIME_WINDOW_MISSED',
        message:
          'Liefertermin MR-2026-0001 ist nach dem vorherigen Stopp voraussichtlich nicht rechtzeitig erreichbar.',
      },
    ]);
    expect(exact.startAt?.getTime()).toBe(at(20).getTime());
  });

  it('Matrix-null ⇒ Stopp nicht erreichbar (Konflikt)', () => {
    const broken = matrixOf([
      [0, null],
      [null, 0],
    ]);
    const plan = evaluateOrder({
      matrix: broken,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [stop('A', 1)],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.conflicts[0]?.code).toBe('UNREACHABLE');
  });

  it('ohne Depot-Rückfahrt endet die Tour mit der Abfahrt am letzten Stopp', () => {
    const plan = evaluateOrder({
      matrix,
      originIndex: 0,
      depotIndex: null,
      departureAt: T0,
      provider: 'test',
      stops: [stop('A', 1, { bufferMinutes: 0 })],
    });
    expect(plan.returnLeg).toBeNull();
    expect(plan.plannedEndAt.getTime()).toBe(at(10).getTime());
  });
});

describe('planWithAnchors – feste Anker, flexible Segmente', () => {
  // 0 = Depot, 1 = nah (5), 2 = mittel (20), 3 = fern (40)
  const matrix = matrixOf([
    [0, 5, 20, 40],
    [5, 0, 15, 35],
    [20, 15, 0, 20],
    [40, 35, 20, 0],
  ]);

  it('ohne Pins wird die Gesamtabschlusszeit minimiert (deterministisch)', () => {
    const plan = planWithAnchors({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [stop('fern', 3), stop('nah', 1), stop('mittel', 2)],
    });
    expect(plan.order).toEqual(['nah', 'mittel', 'fern']);
    expect(plan.feasible).toBe(true);
  });

  it('gepinnte Stopps behalten ihre Position, nur flexible Segmente werden optimiert', () => {
    const plan = planWithAnchors({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [stop('fern', 3, { isPinned: true }), stop('mittel', 2), stop('nah', 1)],
    });
    expect(plan.order[0]).toBe('fern');
    // Nach „fern“ ist „mittel“ (20) näher als „nah“ (35) – Segment wird optimiert.
    expect(plan.order).toEqual(['fern', 'mittel', 'nah']);
  });

  it('harte Zeitfenster: exakter Termin wird als Anker eingehalten, Reihenfolge weicht aus', () => {
    // „nah“ muss exakt um +60 min bedient werden; „mittel“ ist frei.
    const plan = planWithAnchors({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [stop('nah', 1, { startAt: at(60), endAt: null }), stop('mittel', 2)],
    });
    expect(plan.feasible).toBe(true);
    const nah = plan.visits.find((v) => v.stopId === 'nah')!;
    expect(nah.arrivalAt.getTime()).toBe(at(60).getTime());
    // Vorher noch „mittel“ erledigen spart Zeit (20 + 15 + 15 Puffer = 50 < 60).
    expect(plan.order).toEqual(['mittel', 'nah']);
  });

  it('unmögliche Vorgaben ⇒ infeasible mit Konflikt je betroffenem Stopp', () => {
    const plan = planWithAnchors({
      matrix,
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops: [
        stop('fern', 3, { startAt: at(10), endAt: null, label: 'Liefertermin MR-1' }),
        stop('nah', 1, { startAt: at(2), endAt: at(3), label: 'Abholtermin MR-2' }),
      ],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.conflicts.map((c) => c.stopId).sort()).toEqual(['fern', 'nah']);
  });

  it('große flexible Segmente (> 7) nutzen Nächster-Nachbar + 2-opt deterministisch', () => {
    const n = 9;
    const minutes: number[][] = [];
    for (let i = 0; i <= n; i += 1) {
      minutes.push([]);
      for (let j = 0; j <= n; j += 1) minutes[i]!.push(Math.abs(i - j) * 7);
    }
    const stops = Array.from({ length: n }, (_, i) => stop(`s${n - i}`, n - i));
    const first = planWithAnchors({
      matrix: matrixOf(minutes),
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops,
    });
    const second = planWithAnchors({
      matrix: matrixOf(minutes),
      originIndex: 0,
      depotIndex: 0,
      departureAt: T0,
      provider: 'test',
      stops,
    });
    expect(first.order).toEqual(second.order);
    expect(first.order).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  });
});

describe('navigationLinks – nur Ziel, nie Name/Key', () => {
  it('Koordinate: Apple, geo-Intent und Google-Fallback', () => {
    const links = navigationLinks({ latitude: 49.9742, longitude: 8.2566 }, 'Lieferweg 12');
    expect(links).toEqual({
      apple: 'https://maps.apple.com/?daddr=49.9742,8.2566',
      android: 'geo:49.9742,8.2566?q=49.9742,8.2566',
      web: 'https://www.google.com/maps/dir/?api=1&destination=49.9742%2C8.2566',
    });
  });

  it('ohne Koordinate: Adresse URL-kodiert (funktioniert ohne Provider)', () => {
    const links = navigationLinks(null, 'Lieferweg 12, 55129 Mainz');
    expect(links?.apple).toBe('https://maps.apple.com/?daddr=Lieferweg%2012%2C%2055129%20Mainz');
    expect(links?.android).toBe('geo:0,0?q=Lieferweg%2012%2C%2055129%20Mainz');
    expect(links?.web).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=Lieferweg%2012%2C%2055129%20Mainz',
    );
    for (const link of Object.values(links!)) {
      expect(link).not.toMatch(/key=|Kunde|Telefon|MR-/);
    }
  });

  it('ohne Ziel kein Link', () => {
    expect(navigationLinks(null, null)).toBeNull();
    expect(navigationLinks(null, '  ')).toBeNull();
  });
});
