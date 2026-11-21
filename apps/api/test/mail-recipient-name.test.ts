/**
 * Phase 19 (P19-F12): Kundenmails sprachen mit dem Listen-Anzeigenamen der Staff-App an
 * („Hallo Kommerz, Klara,“). `mailRecipientName` liefert für Anrede und Empfängerzeile die
 * natürliche Reihenfolge bzw. den Organisationsnamen – aus Kundenzeile wie aus Buchungs-Snapshot.
 */
import { describe, expect, it } from 'vitest';
import { mailRecipientName, mailSalutation } from '../src/communication/transactional/keys.ts';

describe('Phase 19 (P19-F12) – Anrede-Name aus Stammdaten/Snapshot', () => {
  it('Privatkunde ⇒ „Vorname Nachname“, nie „Nachname, Vorname“', () => {
    const snapshot = {
      type: 'private',
      displayName: 'Kommerz, Klara',
      firstName: 'Klara',
      lastName: 'Kommerz',
      organizationName: null,
      email: 'klara.kommerz@test.example',
    };
    expect(mailRecipientName(snapshot)).toBe('Klara Kommerz');
    expect(mailSalutation(mailRecipientName(snapshot))).toBe('Hallo Klara Kommerz,');
  });

  it('Organisation ⇒ Organisationsname; fehlende Namensteile ⇒ Rest; nur displayName ⇒ displayName; nichts ⇒ null', () => {
    expect(
      mailRecipientName({
        type: 'organization',
        organizationName: 'Verein, e. V.',
        firstName: 'A',
        lastName: 'B',
      }),
    ).toBe('Verein, e. V.');
    expect(mailRecipientName({ type: 'private', firstName: null, lastName: 'Kommerz' })).toBe(
      'Kommerz',
    );
    expect(mailRecipientName({ type: 'private', firstName: ' Klara\n', lastName: ' ' })).toBe(
      'Klara',
    );
    expect(mailRecipientName({ displayName: 'Nur Anzeige' })).toBe('Nur Anzeige');
    expect(mailRecipientName({ type: 'private', firstName: '', lastName: '' })).toBeNull();
    expect(mailRecipientName(null)).toBeNull();
    expect(mailRecipientName('Kommerz, Klara')).toBeNull();
    expect(mailSalutation(mailRecipientName({}))).toBe('Hallo,');
  });
});
