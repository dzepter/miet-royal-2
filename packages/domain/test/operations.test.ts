/**
 * Phase 8: operative Fachregeln (eine Implementierung für Server und
 * Offline-Projektion) – Übergabe-/Rückgabe-Blocker, Mischkanister-Grenze,
 * Lagerbestand, Reinigungs-Überfälligkeit und -Sortierung.
 */
import { describe, expect, it } from 'vitest';
import {
  CANISTERS_PER_CONTAINER_LIMIT,
  CLEANING_WARNING_HOURS,
  cleaningOverdue,
  handoverBlockers,
  returnBlockers,
  sortByCleaningPriority,
  type HandoverBlockerInput,
  type ReturnBlockerInput,
} from '../src/index.ts';

function completeHandover(): HandoverBlockerInput {
  return {
    processStatus: 'open',
    handoverStatus: 'draft',
    recipientKind: 'customer',
    recipientName: 'Klara Kommerz',
    slots: [
      {
        id: 'slot-1',
        slotNo: 1,
        productName: '1×10 L',
        status: 'prepared',
        machine: { id: 'm-1', machineCode: 'MR-10-01-01' },
        currentProblems: [],
        overrideStale: false,
      },
    ],
    machines: [{ assignmentId: 'slot-1', checked: true, photoCount: 1 }],
    items: [
      {
        kind: 'included',
        description: 'Becher (25 Stück)',
        unit: 'Pack',
        plannedQuantity: 1,
        actualQuantity: 1,
      },
    ],
    stock: [{ productName: 'Becher (25 Stück)', systemStock: 10, required: 1, sufficient: true }],
    customerSigned: true,
    staffSigned: true,
    containersTotal: 1,
  };
}

function completeReturn(): ReturnBlockerInput {
  return {
    returnStatus: 'draft',
    returnerKind: 'customer',
    returnerName: 'Klara Kommerz',
    machines: [
      {
        machineCode: 'MR-10-01-01',
        accessoryComplete: true,
        cleanlinessCheckedAt: '2026-09-28T10:00:00.000Z',
        cleanupRequired: false,
        cleanupPhotoCount: 0,
        damages: [],
      },
    ],
    customerSigned: true,
    staffSigned: true,
  };
}

describe('Übergabe-Blocker (Order §40, eine Implementierung)', () => {
  it('vollständige Übergabe hat keine Blocker; Vorgangsstatus und Finalisierung', () => {
    expect(handoverBlockers(completeHandover())).toEqual([]);
    expect(handoverBlockers({ ...completeHandover(), processStatus: 'cancelled' })).toEqual([
      'Der Vorgang ist storniert.',
    ]);
    expect(handoverBlockers({ ...completeHandover(), processStatus: 'completed' })).toEqual([
      'Der Vorgang ist bereits abgeschlossen – bitte zuerst wieder öffnen.',
    ]);
    // Bereits finalisiert: keine Blocker mehr, unabhängig vom Rest.
    expect(
      handoverBlockers({
        ...completeHandover(),
        handoverStatus: 'finalized',
        processStatus: 'cancelled',
        customerSigned: false,
      }),
    ).toEqual([]);
  });

  it('Maschinen-Slots: Zuweisung, Vorbereitung, harte Problemlage, veralteter Override, Prüfung, Foto, Doppelzuweisung', () => {
    const input = completeHandover();
    input.slots = [
      {
        id: 'slot-1',
        slotNo: 1,
        productName: '1×10 L',
        status: 'open',
        machine: null,
        currentProblems: [],
        overrideStale: false,
      },
      {
        id: 'slot-2',
        slotNo: 2,
        productName: '1×10 L',
        status: 'assigned',
        machine: { id: 'm-2', machineCode: 'MR-10-01-02' },
        currentProblems: [
          { code: 'issued_elsewhere', detail: 'Aktuell an MR-2026-0001 ausgegeben.' },
        ],
        overrideStale: true,
      },
      {
        id: 'slot-3',
        slotNo: 3,
        productName: '1×10 L',
        status: 'prepared',
        machine: { id: 'm-2', machineCode: 'MR-10-01-02' },
        currentProblems: [{ code: 'blocked', detail: 'Gesperrt.' }],
        overrideStale: true,
      },
    ];
    input.machines = [{ assignmentId: 'slot-3', checked: true, photoCount: 1 }];
    expect(handoverBlockers(input)).toEqual([
      'Maschine 1 (1×10 L): noch keine konkrete Maschine zugewiesen.',
      'Maschine MR-10-01-02: noch nicht als vorbereitet markiert (Order §10 – Vorbereitung → Reserviert).',
      'Maschine MR-10-01-02: Aktuell an MR-2026-0001 ausgegeben.',
      'Maschine MR-10-01-02: Übergabeprüfung noch nicht bestätigt.',
      'Maschine MR-10-01-02: Gesamtfoto fehlt.',
      'Maschine MR-10-01-02: Die Problemlage hat sich seit der Zuweisung geändert – bitte erneut prüfen und bewusst bestätigen.',
      'Dieselbe Maschine ist mehreren Slots dieser Buchung zugeordnet – bitte je Slot eine eigene Maschine wählen.',
    ]);
    expect(handoverBlockers({ ...completeHandover(), slots: [], machines: [] })).toEqual([
      'Die Buchung enthält keine Maschine.',
    ]);
    // Ausgegebene Slots gelten als vorbereitet.
    const issued = completeHandover();
    issued.slots[0]!.status = 'issued';
    expect(handoverBlockers(issued)).toEqual([]);
  });

  it('Inklusivpositionen über Planmenge, Empfänger und Unterschriften', () => {
    const input = completeHandover();
    input.items = [
      {
        kind: 'included',
        description: 'Becher (25 Stück)',
        unit: 'Pack',
        plannedQuantity: 1,
        actualQuantity: 2,
      },
      {
        kind: 'commission',
        description: 'Sirup Kirsche',
        unit: 'Flasche',
        plannedQuantity: 1,
        actualQuantity: 5,
      },
    ];
    input.recipientKind = null;
    input.recipientName = null;
    input.customerSigned = false;
    input.staffSigned = false;
    expect(handoverBlockers(input)).toEqual([
      'Becher (25 Stück): inklusive nur bis 1 Pack – mehr als Zusatzposition erfassen.',
      'Kunde oder Vertreter für die Übergabe noch nicht bestimmt.',
      'Unterschrift Kunde/Vertreter fehlt.',
      'Unterschrift Mitarbeiter fehlt.',
    ]);
    // Empfängerart ohne Namen zählt als nicht bestimmt.
    expect(
      handoverBlockers({ ...completeHandover(), recipientKind: 'other', recipientName: '' }),
    ).toEqual(['Kunde oder Vertreter für die Übergabe noch nicht bestimmt.']);
  });

  it('Mischkanister-Grenze: je gebuchtem Behälter maximal CANISTERS_PER_CONTAINER_LIMIT', () => {
    const input = completeHandover();
    input.containersTotal = 2;
    input.items = [
      {
        kind: 'purchase',
        description: 'Mischkanister',
        unit: 'Stück',
        plannedQuantity: 2,
        actualQuantity: 2 * CANISTERS_PER_CONTAINER_LIMIT,
      },
    ];
    expect(handoverBlockers(input)).toEqual([]);
    input.items[0]!.actualQuantity = 2 * CANISTERS_PER_CONTAINER_LIMIT + 1;
    expect(handoverBlockers(input)).toEqual([
      `Maximal ${2 * CANISTERS_PER_CONTAINER_LIMIT} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
    ]);
  });

  it('Lagerbestand: unzureichender oder nicht erfasster Systembestand blockiert', () => {
    const input = completeHandover();
    input.stock = [
      { productName: 'Sirup Kirsche', systemStock: 2, required: 5, sufficient: false },
      { productName: 'Strohhalme (25 Stück)', systemStock: null, required: 1, sufficient: false },
      { productName: 'Becher (25 Stück)', systemStock: 10, required: 1, sufficient: true },
    ];
    expect(handoverBlockers(input)).toEqual([
      'Lagerbestand prüfen: Sirup Kirsche – System 2, benötigt 5.',
      'Lagerbestand prüfen: Strohhalme (25 Stück) – System nicht erfasst, benötigt 1.',
    ]);
  });
});

describe('Rückgabe-Blocker (Order §47, eine Implementierung)', () => {
  it('vollständige Rückgabe ohne Blocker; finalisiert ⇒ keine Blocker', () => {
    expect(returnBlockers(completeReturn())).toEqual([]);
    expect(
      returnBlockers({ ...completeReturn(), returnStatus: 'finalized', customerSigned: false }),
    ).toEqual([]);
    expect(returnBlockers({ ...completeReturn(), machines: [] })).toEqual([
      'Keine ausgegebene Maschine – Rückgabe nicht möglich.',
    ]);
  });

  it('Rückgabeperson, Zubehör, Sauberkeit, Reinigungsfoto, Schadenfoto/-markierung, Unterschriften', () => {
    const input = completeReturn();
    input.returnerKind = 'representative';
    input.returnerName = '   ';
    input.machines = [
      {
        machineCode: 'MR-10-01-01',
        accessoryComplete: null,
        cleanlinessCheckedAt: null,
        cleanupRequired: true,
        cleanupPhotoCount: 0,
        damages: [
          { description: 'Kratzer am Gehäuse', photoCount: 0, markerCount: 0 },
          { description: 'Riss im Deckel', photoCount: 1, markerCount: 2 },
        ],
      },
      {
        machineCode: 'MR-10-01-02',
        accessoryComplete: false,
        cleanlinessCheckedAt: '2026-09-28T10:00:00.000Z',
        cleanupRequired: true,
        cleanupPhotoCount: 1,
        damages: [],
      },
    ];
    input.customerSigned = false;
    input.staffSigned = false;
    expect(returnBlockers(input)).toEqual([
      'Rückgabeperson (Kunde oder Vertreter) noch nicht bestimmt.',
      'Maschine MR-10-01-01: Zubehörkontrolle noch nicht bestätigt.',
      'Maschine MR-10-01-01: Rückgabevorbereitung (entleert / zweimal gespült / nichts demontiert) noch nicht geprüft.',
      'Maschine MR-10-01-01: Beweisfoto für die Reinigungsgebühr fehlt.',
      'Schaden „Kratzer am Gehäuse“ an MR-10-01-01: mindestens ein Foto fehlt.',
      'Schaden „Kratzer am Gehäuse“ an MR-10-01-01: Markierung am Schema fehlt.',
      'Unterschrift Kunde / Vertreter fehlt.',
      'Unterschrift Mitarbeiter fehlt.',
    ]);
  });
});

describe('Reinigung (Order §§51–53): Überfälligkeit und Priorität', () => {
  it('cleaningOverdue: > 24 h in Reinigung; sortByCleaningPriority: überfällig zuerst, dann älteste', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    const hours = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    expect(CLEANING_WARNING_HOURS).toBe(24);
    expect(cleaningOverdue(null, now)).toBe(false);
    expect(cleaningOverdue(hours(24), now)).toBe(false);
    expect(cleaningOverdue(hours(24.01), now)).toBe(true);
    expect(cleaningOverdue('kein-datum', now)).toBe(false);

    const machines = [
      { machineCode: 'A', cleaningSince: hours(2) },
      { machineCode: 'B', cleaningSince: null },
      { machineCode: 'C', cleaningSince: hours(30) },
      { machineCode: 'D', cleaningSince: hours(5) },
      { machineCode: 'E', cleaningSince: hours(48) },
    ];
    const sorted = sortByCleaningPriority(machines, now);
    expect(sorted.map((m) => m.machineCode)).toEqual(['E', 'C', 'D', 'A', 'B']);
    // Eingabe bleibt unverändert.
    expect(machines.map((m) => m.machineCode)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
