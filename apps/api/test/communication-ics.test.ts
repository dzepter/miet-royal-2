/**
 * Phase 12 (push+calendar): Unit-Tests der iCalendar-Formatierung
 * (RFC 5545 §3.1 Faltung, §3.3.11 TEXT-Escaping, VTIMEZONE, SEQUENCE).
 */
import { describe, expect, it } from 'vitest';
import {
  BERLIN_VTIMEZONE_LINES,
  buildIcsCalendar,
  buildIcsEventLines,
  escapeIcsText,
  foldIcsLine,
  formatBerlinLocal,
  formatUtc,
  unfoldIcs,
} from '../src/communication/calendar/ics.ts';

const encoder = new TextEncoder();
const octets = (line: string) => encoder.encode(line).length;

describe('ICS – Escaping (RFC 5545 §3.3.11)', () => {
  it('escaped Backslash, Semikolon, Komma und Zeilenumbruch – nicht den Doppelpunkt', () => {
    expect(escapeIcsText('a\\b;c,d\ne:f')).toBe('a\\\\b\\;c\\,d\\ne:f');
    expect(escapeIcsText('x\r\ny')).toBe('x\\ny');
  });
});

describe('ICS – Faltung (RFC 5545 §3.1)', () => {
  it('lässt kurze Zeilen unverändert', () => {
    expect(foldIcsLine('SUMMARY:kurz')).toEqual(['SUMMARY:kurz']);
  });

  it('faltet lange ASCII-Zeilen auf ≤ 75 Oktette mit führendem Leerzeichen', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldIcsLine(line);
    expect(folded.length).toBeGreaterThan(1);
    for (const part of folded) expect(octets(part)).toBeLessThanOrEqual(75);
    for (const part of folded.slice(1)) expect(part.startsWith(' ')).toBe(true);
    expect(folded.map((part, index) => (index === 0 ? part : part.slice(1))).join('')).toBe(line);
  });

  it('trennt nie innerhalb einer UTF-8-Sequenz (Umlaute/Emoji)', () => {
    const line = `SUMMARY:${'Rückgabe – ä'.repeat(20)}`;
    const folded = foldIcsLine(line);
    for (const part of folded) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      // Jeder Teil muss für sich gültiges UTF-8 sein (kein abgeschnittenes Zeichen).
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(part))).toBe(part);
    }
    expect(unfoldIcs(folded.join('\r\n') + '\r\n')).toEqual([line]);
  });
});

describe('ICS – Zeitformate', () => {
  it('formatiert UTC-Stempel und Berliner Wanduhrzeit (DST-fest)', () => {
    const summer = new Date('2026-07-10T10:00:00Z'); // CEST = UTC+2
    const winter = new Date('2026-01-10T10:00:00Z'); // CET = UTC+1
    expect(formatUtc(summer)).toBe('20260710T100000Z');
    expect(formatBerlinLocal(summer)).toBe('20260710T120000');
    expect(formatBerlinLocal(winter)).toBe('20260110T110000');
  });
});

describe('ICS – Kalenderobjekt', () => {
  it('enthält Pflichtfelder, VTIMEZONE Europe/Berlin, UID/SEQUENCE und nur CRLF-Zeilen ≤ 75 Oktette', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const text = buildIcsCalendar({
      displayName: 'Anna Admin',
      now,
      events: [
        {
          appointmentId: '11111111-1111-4111-8111-111111111111',
          kind: 'pickup',
          processNumber: 'MR-2026-1234',
          startAt: new Date('2026-10-20T16:00:00Z'),
          endAt: null,
          version: 3,
          appUrl: 'https://staff.example.de/vorgaenge/22222222-2222-4222-8222-222222222222/termine',
        },
      ],
    });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.includes('\n') && !text.includes('\r\n')).toBe(false);
    for (const raw of text.split('\r\n')) {
      expect(raw.includes('\n')).toBe(false);
      expect(octets(raw)).toBeLessThanOrEqual(75);
    }
    const lines = unfoldIcs(text);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('PRODID:-//Miet-Royal//Staff Calendar//DE');
    expect(lines).toContain('CALSCALE:GREGORIAN');
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines).toContain('NAME:Miet-Royal – Anna Admin');
    expect(lines).toContain('X-WR-CALNAME:Miet-Royal – Anna Admin');
    expect(lines).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(lines).toContain('X-PUBLISHED-TTL:PT1H');
    for (const tzLine of BERLIN_VTIMEZONE_LINES) expect(lines).toContain(tzLine);
    expect(lines).toContain('UID:11111111-1111-4111-8111-111111111111@miet-royal');
    expect(lines).toContain('DTSTAMP:20261018T120000Z');
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20261020T180000');
    expect(lines).toContain('DTEND;TZID=Europe/Berlin:20261020T190000');
    expect(lines).toContain('SEQUENCE:2');
    expect(lines).toContain('SUMMARY:Miet-Royal – Abholung MR-2026-1234');
    expect(
      lines.some((line) => line.startsWith('DESCRIPTION:Abholung MR-2026-1234\\nhttps://')),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('LOCATION'))).toBe(false);
    expect(lines.some((line) => line.startsWith('BEGIN:VALARM'))).toBe(false);
  });
});

describe('ICS URL-Property (RFC 5545 §3.8.4.6)', () => {
  it('URL nur bei absoluter Staff-Basis-URL; relative Links bleiben nur in DESCRIPTION', () => {
    const base = {
      appointmentId: '11111111-2222-4333-8444-555555555555',
      kind: 'pickup' as const,
      processNumber: 'MR-2026-1234',
      startAt: new Date('2026-11-02T09:00:00Z'),
      endAt: null,
      version: 1,
    };
    const now = new Date('2026-10-18T10:00:00Z');
    const relative = buildIcsEventLines({ ...base, appUrl: '/vorgaenge/x/termine' }, now);
    expect(relative.some((line) => line.startsWith('URL:'))).toBe(false);
    expect(relative.join('\n')).toContain('/vorgaenge/x/termine');
    const absolute = buildIcsEventLines(
      { ...base, appUrl: 'https://staff.example.de/vorgaenge/x/termine' },
      now,
    );
    expect(absolute).toContain('URL:https://staff.example.de/vorgaenge/x/termine');
  });
});
