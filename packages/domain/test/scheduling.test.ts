/**
 * Phase-4-Fachregeln (reine Domainlogik): Zeitmodell/Validierung (Pflicht
 * 7/8), Wochenend-Vorschlag (Pflicht 9/10), effektive Zuständigkeit inkl.
 * Vertretung (Basis für 19–23/49/50), Überlappung (Basis 30/31),
 * Überfälligkeit (41/43) und Reminder-Fälligkeit – inkl. DST-Fällen.
 */
import { describe, expect, it } from 'vitest';
import {
  appointmentDueEnd,
  appointmentsOverlap,
  assertValidTimePosition,
  berlinDateOf,
  berlinDateTimeToUtc,
  isReminderDue,
  isReturnOverdue,
  isSameBerlinDay,
  resolveEffectiveAssigneeId,
  SchedulingRuleError,
  substitutionRangesOverlap,
  weekendStandardSuggestion,
} from '../src/scheduling.ts';

describe('Europe/Berlin-Zeitkonstruktion (Pflicht 7, DST-fest)', () => {
  it('Winter: 18:00 Berlin = 17:00 UTC', () => {
    const at = berlinDateTimeToUtc('2026-01-16', 18, 0);
    expect(at.toISOString()).toBe('2026-01-16T17:00:00.000Z');
    expect(berlinDateOf(at)).toBe('2026-01-16');
  });

  it('Sommer: 18:00 Berlin = 16:00 UTC (keine stille Verschiebung)', () => {
    const at = berlinDateTimeToUtc('2026-07-17', 18, 0);
    expect(at.toISOString()).toBe('2026-07-17T16:00:00.000Z');
  });

  it('Über die Sommerzeit-Umstellung hinweg bleibt die Wanduhrzeit korrekt', () => {
    // 2026: Umstellung am 29.03. – Freitag davor (27.03.) ist noch Winterzeit,
    // Sonntag (29.03.) 11:00 ist bereits Sommerzeit.
    expect(berlinDateTimeToUtc('2026-03-27', 18, 0).toISOString()).toBe('2026-03-27T17:00:00.000Z');
    expect(berlinDateTimeToUtc('2026-03-29', 11, 0).toISOString()).toBe('2026-03-29T09:00:00.000Z');
  });

  it('isSameBerlinDay nutzt Berliner Tagesgrenzen, nicht UTC', () => {
    // 23:30 Berlin am 01.09. = 21:30 UTC; 00:30 Berlin am 02.09. = 22:30 UTC.
    const lateEvening = berlinDateTimeToUtc('2026-09-01', 23, 30);
    const afterMidnight = berlinDateTimeToUtc('2026-09-02', 0, 30);
    expect(isSameBerlinDay(lateEvening, afterMidnight)).toBe(false);
    expect(isSameBerlinDay(lateEvening, berlinDateTimeToUtc('2026-09-01', 8, 0))).toBe(true);
  });
});

describe('Zeitposition (Pflicht 5/6/8)', () => {
  it('exakter Termin und Zeitfenster sind gültig', () => {
    const start = new Date('2026-09-04T16:00:00Z');
    expect(() => assertValidTimePosition(start, null)).not.toThrow();
    expect(() => assertValidTimePosition(start, new Date('2026-09-04T17:00:00Z'))).not.toThrow();
    expect(() => assertValidTimePosition(null, null)).not.toThrow();
  });

  it('Ende vor/gleich Beginn und Ende ohne Beginn werden abgelehnt', () => {
    const start = new Date('2026-09-04T16:00:00Z');
    expect(() => assertValidTimePosition(start, start)).toThrow(SchedulingRuleError);
    expect(() => assertValidTimePosition(start, new Date('2026-09-04T15:00:00Z'))).toThrow(
      SchedulingRuleError,
    );
    expect(() => assertValidTimePosition(null, start)).toThrow(SchedulingRuleError);
  });
});

describe('Wochenend-Vorschlag (Pflicht 9/10)', () => {
  it('9. Samstags-Event: Freitag 18:00 davor, Sonntag 11:00 danach (Berlin)', () => {
    const suggestion = weekendStandardSuggestion({ eventDate: '2026-09-05' });
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.pickupAt.toISOString()).toBe('2026-09-04T16:00:00.000Z'); // Fr 18:00 MESZ
      expect(suggestion.returnAt.toISOString()).toBe('2026-09-06T09:00:00.000Z'); // So 11:00 MESZ
    }
  });

  it('10. Freitags-Event ohne Zeiten: Standard passt nicht → keine automatische Übernahme', () => {
    // Freitag 18:00 läge nicht vor dem Eventtag (Tagesbeginn 00:00).
    const suggestion = weekendStandardSuggestion({ eventDate: '2026-09-04' });
    expect(suggestion.ok).toBe(false);
    if (!suggestion.ok) expect(suggestion.reason).toContain('manuell');
  });

  it('Freitagabend-Event MIT Startzeit nach 18:00: Standard passt', () => {
    const suggestion = weekendStandardSuggestion({
      eventDate: '2026-09-04',
      eventStart: '2026-09-04T17:30:00.000Z', // 19:30 Berlin
      eventEnd: '2026-09-04T21:00:00.000Z',
    });
    expect(suggestion.ok).toBe(true);
  });

  it('Sonntags-Event, das nach 11:00 endet: Rückgabe läge nicht nach dem Event → ablehnen', () => {
    const suggestion = weekendStandardSuggestion({ eventDate: '2026-09-06' });
    expect(suggestion.ok).toBe(false);
  });
});

describe('Effektive Zuständigkeit inkl. Vertretung (Basis Pflicht 19–21)', () => {
  const sub = {
    originalUserId: 'anna',
    substituteUserId: 'bernd',
    startsAt: new Date('2026-09-07T00:00:00Z'),
    endsAt: new Date('2026-09-14T00:00:00Z'),
    endedEarlyAt: null,
  };

  it('während des Zeitraums geht die Zuständigkeit an die Vertretung', () => {
    expect(resolveEffectiveAssigneeId('anna', new Date('2026-09-10T10:00:00Z'), [sub])).toBe(
      'bernd',
    );
  });

  it('vor Beginn und nach Ende gilt der ursprüngliche Mitarbeiter', () => {
    expect(resolveEffectiveAssigneeId('anna', new Date('2026-09-06T10:00:00Z'), [sub])).toBe(
      'anna',
    );
    expect(resolveEffectiveAssigneeId('anna', new Date('2026-09-14T00:00:00Z'), [sub])).toBe(
      'anna',
    );
  });

  it('vorzeitiges Ende wirkt sofort', () => {
    const endedEarly = { ...sub, endedEarlyAt: new Date('2026-09-09T12:00:00Z') };
    expect(resolveEffectiveAssigneeId('anna', new Date('2026-09-09T12:00:00Z'), [endedEarly])).toBe(
      'anna',
    );
    expect(resolveEffectiveAssigneeId('anna', new Date('2026-09-09T11:59:00Z'), [endedEarly])).toBe(
      'bernd',
    );
  });

  it('andere Mitarbeiter sind von fremden Vertretungen unberührt', () => {
    expect(resolveEffectiveAssigneeId('carla', new Date('2026-09-10T10:00:00Z'), [sub])).toBe(
      'carla',
    );
    expect(resolveEffectiveAssigneeId(null, new Date('2026-09-10T10:00:00Z'), [sub])).toBeNull();
  });

  it('Überlappungsprüfung erkennt widersprüchliche Zeiträume (Basis Pflicht 18)', () => {
    const other = {
      originalUserId: 'anna',
      substituteUserId: 'carla',
      startsAt: new Date('2026-09-12T00:00:00Z'),
      endsAt: new Date('2026-09-20T00:00:00Z'),
      endedEarlyAt: null,
    };
    expect(substitutionRangesOverlap(sub, other)).toBe(true);
    const later = { ...other, startsAt: new Date('2026-09-14T00:00:00Z') };
    expect(substitutionRangesOverlap(sub, later)).toBe(false);
    // Vorzeitig beendete Vertretung blockiert den freigewordenen Zeitraum nicht.
    const endedEarly = { ...sub, endedEarlyAt: new Date('2026-09-09T00:00:00Z') };
    const following = { ...other, startsAt: new Date('2026-09-09T00:00:00Z') };
    expect(substitutionRangesOverlap(endedEarly, following)).toBe(false);
  });
});

describe('Überlappung (Basis Pflicht 30/31)', () => {
  const at = (iso: string) => new Date(iso);

  it('echte Fensterüberschneidung kollidiert, angrenzende Fenster nicht', () => {
    const a = { startAt: at('2026-09-04T14:00:00Z'), endAt: at('2026-09-04T15:00:00Z') };
    const b = { startAt: at('2026-09-04T14:30:00Z'), endAt: at('2026-09-04T15:30:00Z') };
    const c = { startAt: at('2026-09-04T15:00:00Z'), endAt: at('2026-09-04T16:00:00Z') };
    expect(appointmentsOverlap(a, b)).toBe(true);
    expect(appointmentsOverlap(a, c)).toBe(false);
  });

  it('exakter Termin im Fenster bzw. identischer Beginn kollidiert', () => {
    const window = { startAt: at('2026-09-04T14:00:00Z'), endAt: at('2026-09-04T15:00:00Z') };
    expect(appointmentsOverlap({ startAt: at('2026-09-04T14:30:00Z'), endAt: null }, window)).toBe(
      true,
    );
    expect(appointmentsOverlap({ startAt: at('2026-09-04T15:00:00Z'), endAt: null }, window)).toBe(
      false,
    );
    expect(
      appointmentsOverlap(
        { startAt: at('2026-09-04T18:00:00Z'), endAt: null },
        { startAt: at('2026-09-04T18:00:00Z'), endAt: null },
      ),
    ).toBe(true);
  });

  it('ungeplante Termine kollidieren nie', () => {
    expect(
      appointmentsOverlap(
        { startAt: null, endAt: null },
        { startAt: at('2026-09-04T14:00:00Z'), endAt: null },
      ),
    ).toBe(false);
  });
});

describe('Überfälligkeit & Reminder (Basis Pflicht 41/43/49)', () => {
  it('Rückgabe ist überfällig, wenn die geplante Zeit überschritten und nicht abgeschlossen ist', () => {
    const base = {
      kind: 'return' as const,
      status: 'scheduled' as const,
      startAt: new Date('2026-09-06T09:00:00Z'),
      endAt: null,
    };
    expect(isReturnOverdue(base, new Date('2026-09-06T09:01:00Z'))).toBe(true);
    expect(isReturnOverdue(base, new Date('2026-09-06T08:59:00Z'))).toBe(false);
    expect(
      isReturnOverdue({ ...base, status: 'completed' }, new Date('2026-09-07T00:00:00Z')),
    ).toBe(false);
    expect(isReturnOverdue({ ...base, kind: 'pickup' }, new Date('2026-09-07T00:00:00Z'))).toBe(
      false,
    );
    // Zeitfenster: erst NACH dem Fenster-Ende überfällig.
    const window = { ...base, endAt: new Date('2026-09-06T10:00:00Z') };
    expect(isReturnOverdue(window, new Date('2026-09-06T09:30:00Z'))).toBe(false);
    expect(isReturnOverdue(window, new Date('2026-09-06T10:00:01Z'))).toBe(true);
    expect(appointmentDueEnd(window)?.toISOString()).toBe('2026-09-06T10:00:00.000Z');
  });

  it('Reminder ist genau im Fenster [Beginn−60min, Beginn) fällig und nur solange ungesendet', () => {
    const appointment = {
      startAt: new Date('2026-09-04T16:00:00Z'),
      status: 'scheduled',
      reminderSentAt: null,
    };
    expect(isReminderDue(appointment, 60, new Date('2026-09-04T14:59:00Z'))).toBe(false);
    expect(isReminderDue(appointment, 60, new Date('2026-09-04T15:00:00Z'))).toBe(true);
    expect(isReminderDue(appointment, 60, new Date('2026-09-04T15:59:00Z'))).toBe(true);
    expect(isReminderDue(appointment, 60, new Date('2026-09-04T16:00:00Z'))).toBe(false);
    expect(
      isReminderDue(
        { ...appointment, reminderSentAt: new Date() },
        60,
        new Date('2026-09-04T15:30:00Z'),
      ),
    ).toBe(false);
    expect(
      isReminderDue({ startAt: null, status: 'scheduled', reminderSentAt: null }, 60, new Date()),
    ).toBe(false);
  });
});
