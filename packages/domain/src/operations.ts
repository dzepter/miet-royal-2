/**
 * Phase 8: operative Fachregeln von Übergabe, Rückgabe und Reinigung als
 * EINE autoritative Implementierung (CLAUDE.md), genutzt vom Server
 * (HandoverService/ReturnService) UND von der Offline-Projektion der
 * Staff-PWA. Die Eingabetypen beschreiben nur, was die Regel braucht;
 * die Texte sind die bisherigen Blocker-Texte der Phasen 6/7 (Order §§40/47).
 *
 * Reine Logik ohne Datenbank, ohne I/O, ohne Zeitzonenannahmen.
 */
import { CANISTERS_PER_CONTAINER_LIMIT } from './pricing.ts';

// ── Übergabe (Phase-6-Order §40) ────────────────────────────────────────────

export interface HandoverBlockerSlot {
  id: string;
  slotNo: number;
  productName: string;
  /** Zuordnungsstatus: open | assigned | prepared | issued | returned. */
  status: string;
  machine: { id: string; machineCode: string } | null;
  /** Aktuelle Problemlage der zugewiesenen Maschine (Server-Bewertung). */
  currentProblems: readonly { code: string; detail: string }[];
  /** Ein alter Override deckt die AKTUELLE Lage nicht mehr ab (Order §49). */
  overrideStale: boolean;
}

export interface HandoverBlockerMachine {
  assignmentId: string;
  checked: boolean;
  photoCount: number;
}

export interface HandoverBlockerItem {
  /** included | commission | purchase. */
  kind: string;
  description: string;
  unit: string;
  plannedQuantity: number;
  actualQuantity: number;
}

export interface HandoverBlockerStock {
  productName: string;
  systemStock: number | null;
  required: number;
  sufficient: boolean;
}

export interface HandoverBlockerInput {
  processStatus: string;
  /** draft | finalized. */
  handoverStatus: string;
  recipientKind: string | null;
  recipientName: string | null;
  slots: readonly HandoverBlockerSlot[];
  machines: readonly HandoverBlockerMachine[];
  items: readonly HandoverBlockerItem[];
  stock: readonly HandoverBlockerStock[];
  customerSigned: boolean;
  staffSigned: boolean;
  /** Gebuchte Behälter gesamt – Grundlage der Mischkanister-Grenze. */
  containersTotal: number;
}

/** Vorbedingungen der Übergabe-Finalisierung (Order §40) – leer = abschließbar. */
export function handoverBlockers(input: HandoverBlockerInput): string[] {
  const blockers: string[] = [];
  if (input.handoverStatus === 'finalized') return blockers;
  if (input.processStatus === 'cancelled') blockers.push('Der Vorgang ist storniert.');
  if (input.processStatus === 'completed') {
    blockers.push('Der Vorgang ist bereits abgeschlossen – bitte zuerst wieder öffnen.');
  }
  for (const item of input.items) {
    if (item.kind === 'included' && item.actualQuantity > item.plannedQuantity) {
      blockers.push(
        `${item.description}: inklusive nur bis ${item.plannedQuantity} ${item.unit} – mehr als Zusatzposition erfassen.`,
      );
    }
  }
  if (input.slots.length === 0) blockers.push('Die Buchung enthält keine Maschine.');
  for (const slot of input.slots) {
    if (slot.machine === null) {
      blockers.push(
        `Maschine ${slot.slotNo} (${slot.productName}): noch keine konkrete Maschine zugewiesen.`,
      );
      continue;
    }
    if (slot.status !== 'prepared' && slot.status !== 'issued') {
      blockers.push(
        `Maschine ${slot.machine.machineCode}: noch nicht als vorbereitet markiert (Order §10 – Vorbereitung → Reserviert).`,
      );
    }
    const hard = slot.currentProblems.find(
      (p) => p.code === 'issued_elsewhere' || p.code === 'status_rented',
    );
    if (hard !== undefined) {
      blockers.push(`Maschine ${slot.machine.machineCode}: ${hard.detail}`);
    } else if (slot.overrideStale) {
      blockers.push(
        `Maschine ${slot.machine.machineCode}: Die Problemlage hat sich seit der Zuweisung geändert – bitte erneut prüfen und bewusst bestätigen.`,
      );
    }
    const machineView = input.machines.find((m) => m.assignmentId === slot.id);
    if (machineView === undefined || !machineView.checked) {
      blockers.push(`Maschine ${slot.machine.machineCode}: Übergabeprüfung noch nicht bestätigt.`);
    }
    if (machineView === undefined || machineView.photoCount === 0) {
      blockers.push(`Maschine ${slot.machine.machineCode}: Gesamtfoto fehlt.`);
    }
  }
  const machineIds = input.slots
    .map((slot) => slot.machine?.id)
    .filter((id): id is string => id !== undefined);
  if (new Set(machineIds).size !== machineIds.length) {
    blockers.push(
      'Dieselbe Maschine ist mehreren Slots dieser Buchung zugeordnet – bitte je Slot eine eigene Maschine wählen.',
    );
  }
  const canisterActual = input.items
    .filter((item) => item.kind === 'purchase')
    .reduce((sum, item) => sum + item.actualQuantity, 0);
  const canisterLimit = input.containersTotal * CANISTERS_PER_CONTAINER_LIMIT;
  if (canisterActual > canisterLimit) {
    blockers.push(
      `Maximal ${canisterLimit} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
    );
  }
  for (const entry of input.stock) {
    if (!entry.sufficient) {
      blockers.push(
        `Lagerbestand prüfen: ${entry.productName} – System ${entry.systemStock === null ? 'nicht erfasst' : entry.systemStock}, benötigt ${entry.required}.`,
      );
    }
  }
  if (input.recipientKind === null || (input.recipientName ?? '') === '') {
    blockers.push('Kunde oder Vertreter für die Übergabe noch nicht bestimmt.');
  }
  if (!input.customerSigned) blockers.push('Unterschrift Kunde/Vertreter fehlt.');
  if (!input.staffSigned) blockers.push('Unterschrift Mitarbeiter fehlt.');
  return blockers;
}

// ── Rückgabe (Phase-7-Order §47) ────────────────────────────────────────────

export interface ReturnBlockerDamage {
  description: string;
  photoCount: number;
  markerCount: number;
}

export interface ReturnBlockerMachine {
  machineCode: string;
  /** null = Zubehörkontrolle noch nicht bestätigt. */
  accessoryComplete: boolean | null;
  cleanlinessCheckedAt: string | null;
  cleanupRequired: boolean;
  cleanupPhotoCount: number;
  damages: readonly ReturnBlockerDamage[];
}

export interface ReturnBlockerInput {
  /** draft | finalized. */
  returnStatus: string;
  returnerKind: string | null;
  returnerName: string | null;
  machines: readonly ReturnBlockerMachine[];
  customerSigned: boolean;
  staffSigned: boolean;
}

/** Vorbedingungen der Rückgabe-Finalisierung (Order §47) – leer = abschließbar. */
export function returnBlockers(input: ReturnBlockerInput): string[] {
  if (input.returnStatus === 'finalized') return [];
  const blockers: string[] = [];
  if (input.machines.length === 0) {
    blockers.push('Keine ausgegebene Maschine – Rückgabe nicht möglich.');
  }
  if (input.returnerKind === null || (input.returnerName ?? '').trim() === '') {
    blockers.push('Rückgabeperson (Kunde oder Vertreter) noch nicht bestimmt.');
  }
  for (const m of input.machines) {
    if (m.accessoryComplete === null) {
      blockers.push(`Maschine ${m.machineCode}: Zubehörkontrolle noch nicht bestätigt.`);
    }
    if (m.cleanlinessCheckedAt === null) {
      blockers.push(
        `Maschine ${m.machineCode}: Rückgabevorbereitung (entleert / zweimal gespült / nichts demontiert) noch nicht geprüft.`,
      );
    }
    if (m.cleanupRequired && m.cleanupPhotoCount === 0) {
      blockers.push(`Maschine ${m.machineCode}: Beweisfoto für die Reinigungsgebühr fehlt.`);
    }
    for (const damage of m.damages) {
      if (damage.photoCount === 0) {
        blockers.push(
          `Schaden „${damage.description}“ an ${m.machineCode}: mindestens ein Foto fehlt.`,
        );
      }
      if (damage.markerCount === 0) {
        blockers.push(
          `Schaden „${damage.description}“ an ${m.machineCode}: Markierung am Schema fehlt.`,
        );
      }
    }
  }
  if (!input.customerSigned) blockers.push('Unterschrift Kunde / Vertreter fehlt.');
  if (!input.staffSigned) blockers.push('Unterschrift Mitarbeiter fehlt.');
  return blockers;
}

// ── Reinigung (Phase-7-Order §§51–53) ───────────────────────────────────────

/** Länger als 24 h nach Rückgabe noch in Reinigung ⇒ Warnung/„zuerst, rot“. */
export const CLEANING_WARNING_HOURS = 24;

/** Zeitabhängig abgeleitet (kein Job): Reinigung läuft länger als 24 h. */
export function cleaningOverdue(cleaningSince: string | null, now: Date): boolean {
  if (cleaningSince === null) return false;
  const since = Date.parse(cleaningSince);
  if (Number.isNaN(since)) return false;
  return now.getTime() - since > CLEANING_WARNING_HOURS * 3_600_000;
}

/**
 * Reinigungsliste: überfällige Maschinen zuerst, danach die am längsten in
 * Reinigung befindliche (ältester Reinigungsbeginn) zuerst; Maschinen ohne
 * Reinigungsbeginn am Ende. Stabil, verändert die Eingabe nicht.
 */
export function sortByCleaningPriority<T extends { cleaningSince: string | null }>(
  machines: readonly T[],
  now: Date,
): T[] {
  const rank = (machine: T): [number, number] => {
    const overdue = cleaningOverdue(machine.cleaningSince, now) ? 0 : 1;
    const since =
      machine.cleaningSince === null ? Number.POSITIVE_INFINITY : Date.parse(machine.cleaningSince);
    return [overdue, Number.isNaN(since) ? Number.POSITIVE_INFINITY : since];
  };
  return machines
    .map((machine, index) => ({ machine, index, rank: rank(machine) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
    .map((entry) => entry.machine);
}
