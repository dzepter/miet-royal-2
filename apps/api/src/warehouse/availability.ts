import {
  appointments,
  bookings,
  machineBlocks,
  machines,
  processes,
  products,
  type Database,
  type Machine,
  type MachineBlock,
  type Product,
} from '@mietroyal/database';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import {
  blockOverlaps,
  MACHINE_STATUS_LABELS,
  NOT_REGULARLY_AVAILABLE_STATUSES,
} from './machine-service.ts';

/**
 * Interne Maschinenverfügbarkeit (Phase-5-Order §§14–21): rechnet aus dem
 * TATSÄCHLICHEN physischen Bestand (Source of Truth) und den operativen
 * Phase-4-Terminen. Sie lehnt NIEMALS automatisch ab, storniert nichts und
 * ersetzt keinen Maschinentyp – sie liefert nur Einschätzungen, Gründe und
 * unverbindliche Alternativen. Der Mensch entscheidet.
 */

export interface DemandInterval {
  bookingId: string;
  processId: string;
  processNumber: string;
  /** Anzahl gebuchter Maschinen dieses Typs (Buchungs-Snapshot, ≥ 1). */
  quantity: number;
  from: Date;
  to: Date;
}

export interface UndeterminedBooking {
  bookingId: string;
  processNumber: string;
  reason: string;
}

export interface UnavailableMachine {
  machineId: string;
  machineCode: string;
  reason: string;
}

export interface AlternativeSuggestion {
  label: string;
  productSlug: string;
  quantity: number;
  available: boolean;
  note: string;
}

export interface AvailabilityCheck {
  status: 'available' | 'tight' | 'conflict';
  totalMachines: number;
  peakDemand: number;
  minUsable: number;
  /** Kleinste freie Reserve (einsetzbar − Bedarf) an einem Zeitpunkt im Intervall. */
  minFree: number;
  /** true, wenn Buchungen ohne vollständige Terminzeiten existieren. */
  notFullyCheckable: boolean;
  reasons: string[];
  unavailableMachines: UnavailableMachine[];
  undetermined: UndeterminedBooking[];
  alternatives: AlternativeSuggestion[];
}

export type MachineEligibility = 'eligible' | 'warning' | 'override_required';

export interface MachineSuggestionEntry {
  machineId: string;
  machineCode: string;
  status: Machine['status'];
  statusLabel: string;
  locationKind: Machine['locationKind'];
  purchaseDate: string | null;
  eligibility: MachineEligibility;
  reasons: string[];
}

export interface MachineSuggestion {
  preferred: MachineSuggestionEntry | null;
  preferredBasis: string | null;
  others: MachineSuggestionEntry[];
  warnings: string[];
}

/**
 * Bekannte, fachlich sinnvolle Alternativen (Order §19) – ausschließlich
 * als UNVERBINDLICHER Vorschlag; niemals automatische Umstellung, kein
 * automatischer Preis, keine Kundenkommunikation.
 */
const KNOWN_ALTERNATIVES: Record<string, { slug: string; quantity: number; label: string }[]> = {
  'slush-2x10': [{ slug: 'slush-1x10', quantity: 2, label: 'Zwei 1×10-L-Maschinen' }],
  'slush-2x8': [{ slug: 'slush-2x10', quantity: 1, label: 'Eine größere 2×10-L-Maschine' }],
};

export interface ProductMachineState {
  product: Product;
  rows: Machine[];
  blocks: MachineBlock[];
}

export class MachineAvailabilityService {
  constructor(private readonly db: Database) {}

  /** Physischer Bestand + offene Sperren eines Typs (Source of Truth, §16). */
  async loadState(productId: string, now: Date): Promise<ProductMachineState> {
    const productRows = await this.db.select().from(products).where(eq(products.id, productId));
    const product = productRows[0];
    if (product === undefined) throw new AuthError('NOT_FOUND', 'Produkt nicht gefunden.');
    const rows = await this.db
      .select()
      .from(machines)
      .where(eq(machines.productId, productId))
      .orderBy(asc(machines.machineCode));
    const machineIds = rows.map((row) => row.id);
    const blocks =
      machineIds.length === 0
        ? []
        : await this.db
            .select()
            .from(machineBlocks)
            .where(
              and(
                inArray(machineBlocks.machineId, machineIds),
                isNull(machineBlocks.liftedAt),
                sql`${machineBlocks.endsAt} > ${now}`,
              ),
            );
    return { product, rows, blocks };
  }

  /** Einsetzbare Maschinen zum Zeitpunkt t (Order §§16/17). */
  usableAt(state: ProductMachineState, t: Date): number {
    return state.rows.filter((machine) => {
      if (machine.status !== 'ready') return false;
      return !state.blocks.some(
        (block) =>
          block.machineId === machine.id &&
          block.startsAt.getTime() <= t.getTime() &&
          block.endsAt.getTime() > t.getTime(),
      );
    }).length;
  }

  private unavailableMachines(
    state: ProductMachineState,
    from: Date,
    to: Date,
  ): UnavailableMachine[] {
    const result: UnavailableMachine[] = [];
    for (const machine of state.rows) {
      if (NOT_REGULARLY_AVAILABLE_STATUSES.includes(machine.status)) {
        result.push({
          machineId: machine.id,
          machineCode: machine.machineCode,
          reason: `Status ${MACHINE_STATUS_LABELS[machine.status]}`,
        });
        continue;
      }
      if (machine.status !== 'ready') {
        result.push({
          machineId: machine.id,
          machineCode: machine.machineCode,
          reason: `Status ${MACHINE_STATUS_LABELS[machine.status]} (Fachprozess späterer Phasen)`,
        });
        continue;
      }
      const block = state.blocks.find(
        (candidate) => candidate.machineId === machine.id && blockOverlaps(candidate, from, to),
      );
      if (block !== undefined) {
        result.push({
          machineId: machine.id,
          machineCode: machine.machineCode,
          reason: `Gesperrt (${block.reason})`,
        });
      }
    }
    return result;
  }

  /**
   * Bedarf des Maschinentyps aus BESTÄTIGTEN Buchungen (Order §15): der
   * Mietzeitraum reicht vom Beginn des Abhol-/Liefertermins bis zum
   * geplanten Ende der Rückgabe. Fehlen Zeiten, wird KEINE falsche
   * Präzision erfunden – die Buchung erscheint als "noch nicht vollständig
   * prüfbar".
   */
  async demandForProduct(
    productId: string,
  ): Promise<{ determined: DemandInterval[]; undetermined: UndeterminedBooking[] }> {
    const bookingRows = await this.db
      .select({
        id: bookings.id,
        processId: bookings.processId,
        processNumber: processes.processNumber,
        mainStatus: processes.mainStatus,
        itemsSnapshot: bookings.itemsSnapshot,
      })
      .from(bookings)
      .innerJoin(processes, eq(processes.id, bookings.processId))
      .where(
        and(
          ne(processes.mainStatus, 'cancelled'),
          sql`${bookings.itemsSnapshot} @> ${JSON.stringify([{ kind: 'machine', productId }])}::jsonb`,
        ),
      );
    if (bookingRows.length === 0) return { determined: [], undetermined: [] };
    const appointmentRows = await this.db
      .select()
      .from(appointments)
      .where(
        and(
          inArray(
            appointments.bookingId,
            bookingRows.map((row) => row.id),
          ),
          ne(appointments.status, 'cancelled'),
        ),
      );
    const determined: DemandInterval[] = [];
    const undetermined: UndeterminedBooking[] = [];
    for (const booking of bookingRows) {
      const own = appointmentRows.filter((row) => row.bookingId === booking.id);
      const outbound = own.find((row) => row.kind === 'pickup' || row.kind === 'delivery');
      const inbound = own.find((row) => row.kind === 'return');
      const from = outbound?.startAt ?? null;
      const to = inbound === undefined ? null : (inbound.endAt ?? inbound.startAt);
      if (from === null || to === null) {
        // Nur offene Vorgänge als "nicht prüfbar" ausweisen (kein Rauschen
        // durch längst abgeschlossene Geschäfte).
        if (booking.mainStatus === 'open' || booking.mainStatus === 'reopened') {
          undetermined.push({
            bookingId: booking.id,
            processNumber: booking.processNumber,
            reason: 'Verfügbarkeit noch nicht vollständig prüfbar – Terminzeit fehlt.',
          });
        }
        continue;
      }
      if (to.getTime() <= from.getTime()) {
        undetermined.push({
          bookingId: booking.id,
          processNumber: booking.processNumber,
          reason: 'Terminzeiten unplausibel (Rückgabe vor Ausgabe) – bitte Termine prüfen.',
        });
        continue;
      }
      // Bestätigter Bedarf = ANZAHL gebuchter Maschinen (Snapshot-Menge),
      // nicht Anzahl Buchungen – eine Buchung über 2 Maschinen belegt 2.
      const items = (booking.itemsSnapshot ?? []) as {
        kind?: string;
        productId?: string;
        quantity?: number;
      }[];
      const machineItem = items.find(
        (item) => item.kind === 'machine' && item.productId === productId,
      );
      const quantity =
        machineItem !== undefined &&
        typeof machineItem.quantity === 'number' &&
        Number.isInteger(machineItem.quantity) &&
        machineItem.quantity > 0
          ? machineItem.quantity
          : 1;
      determined.push({
        bookingId: booking.id,
        processId: booking.processId,
        processNumber: booking.processNumber,
        quantity,
        from,
        to,
      });
    }
    return { determined, undetermined };
  }

  /**
   * Kapazitätsprüfung für einen Zeitraum (Order §§14–18): verfügbar /
   * knapp / Kapazitätskonflikt – als WARNUNG, nie als Blockade.
   */
  async checkProduct(
    productId: string,
    interval: { from: Date; to: Date },
    options: { withAlternatives?: boolean } = {},
    now = new Date(),
  ): Promise<AvailabilityCheck> {
    const state = await this.loadState(productId, now);
    const { determined, undetermined } = await this.demandForProduct(productId);
    const relevant = determined.filter(
      (demand) =>
        demand.from.getTime() < interval.to.getTime() &&
        demand.to.getTime() > interval.from.getTime(),
    );

    // Kritische Zeitpunkte: Bedarfstarts, Sperrbeginne und der
    // Intervallbeginn – dazwischen sind beide Funktionen konstant.
    const instants = new Set<number>([interval.from.getTime()]);
    for (const demand of relevant) {
      const t = Math.max(demand.from.getTime(), interval.from.getTime());
      if (t < interval.to.getTime()) instants.add(t);
    }
    for (const block of state.blocks) {
      const t = Math.max(block.startsAt.getTime(), interval.from.getTime());
      if (t < interval.to.getTime()) instants.add(t);
    }

    let peakDemand = 0;
    let minUsable = this.usableAt(state, interval.from);
    let maxShortage = 0;
    let minFree = Number.POSITIVE_INFINITY;
    // Für den Warntext: Bedarf und Einsetzbarkeit am ENGPASS-Zeitpunkt –
    // niemals Maximalwerte verschiedener Zeitpunkte mischen.
    let demandAtWorst = 0;
    let usableAtWorst = 0;
    for (const instantMs of instants) {
      const t = new Date(instantMs);
      const demandAt = relevant
        .filter((demand) => demand.from.getTime() <= instantMs && demand.to.getTime() > instantMs)
        .reduce((sum, demand) => sum + demand.quantity, 0);
      const usable = this.usableAt(state, t);
      peakDemand = Math.max(peakDemand, demandAt);
      minUsable = Math.min(minUsable, usable);
      if (demandAt - usable > maxShortage) {
        maxShortage = demandAt - usable;
        demandAtWorst = demandAt;
        usableAtWorst = usable;
      }
      minFree = Math.min(minFree, usable - demandAt);
    }
    if (!Number.isFinite(minFree)) minFree = this.usableAt(state, interval.from);

    // Kein Bestand einsetzbar = Konflikt, auch OHNE konkurrierende Buchung
    // (alle Maschinen in Reparatur/außer Betrieb/gesperrt): "verfügbar"
    // wäre für jede Anfrage in diesem Zeitraum falsch.
    const zeroUsable = minUsable === 0;
    const status: AvailabilityCheck['status'] =
      maxShortage > 0 || zeroUsable
        ? 'conflict'
        : minFree === 0 && peakDemand > 0
          ? 'tight'
          : 'available';

    const reasons: string[] = [];
    if (maxShortage > 0) {
      reasons.push(
        `Kapazitätskonflikt: Für ${state.product.name} werden zeitweise bis zu ${demandAtWorst} Maschinen benötigt, aber nur ${usableAtWorst} sind einsetzbar.`,
      );
    } else if (zeroUsable) {
      reasons.push(
        `Kapazitätskonflikt: Für ${state.product.name} ist im Zeitraum keine Maschine einsetzbar.`,
      );
    } else if (status === 'tight') {
      reasons.push(
        `Knapp: Für ${state.product.name} ist im Zeitraum keine freie Reserve vorhanden.`,
      );
    }
    const unavailable = this.unavailableMachines(state, interval.from, interval.to);
    for (const entry of unavailable) {
      reasons.push(`${entry.machineCode}: ${entry.reason}`);
    }
    for (const entry of undetermined) {
      reasons.push(`${entry.processNumber}: ${entry.reason}`);
    }

    const alternatives: AlternativeSuggestion[] = [];
    if (options.withAlternatives !== false && status !== 'available') {
      for (const alternative of KNOWN_ALTERNATIVES[state.product.slug] ?? []) {
        const altRows = await this.db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.slug, alternative.slug));
        const altId = altRows[0]?.id;
        if (altId === undefined) continue;
        const altCheck = await this.checkProduct(altId, interval, { withAlternatives: false }, now);
        alternatives.push({
          label: alternative.label,
          productSlug: alternative.slug,
          quantity: alternative.quantity,
          // "verfügbar" = im Zeitraum bleiben zu JEDEM Zeitpunkt mindestens
          // `quantity` Maschinen frei, nachdem der bestehende Bedarf
          // gedeckt ist (minFree statt Mischung getrennter Maxima).
          available: altCheck.status !== 'conflict' && altCheck.minFree >= alternative.quantity,
          note: 'Mögliche Alternative – über Änderung und Preis entscheidet ein Mitarbeiter.',
        });
      }
    }

    return {
      status,
      totalMachines: state.rows.length,
      peakDemand,
      minUsable,
      minFree,
      notFullyCheckable: undetermined.length > 0,
      reasons,
      unavailableMachines: unavailable,
      undetermined,
      alternatives,
    };
  }

  /**
   * Auswahlvorschlag für Phase 6 (Order §§20/21): reine Vorschlagsfunktion
   * ohne Assignment. Bevorzugt wird das älteste BEKANNTE Kaufdatum;
   * unbekannte Kaufdaten werden nicht erfunden (deterministischer Fallback:
   * Maschinen-ID). Der Standort ist Zusatzinformation und ersetzt die
   * Präferenz nicht. Blockierte Maschinen liefern override_required –
   * der spätere bewusste Override (Phase 6) bleibt möglich.
   */
  async suggestMachines(
    productId: string,
    interval: { from: Date; to: Date } | null,
    now = new Date(),
  ): Promise<MachineSuggestion> {
    const state = await this.loadState(productId, now);
    const from = interval?.from ?? now;
    const to = interval?.to ?? now;
    const entries: MachineSuggestionEntry[] = state.rows.map((machine) => {
      const reasons: string[] = [];
      let eligibility: MachineEligibility = 'eligible';
      if (machine.status === 'cleaning') {
        eligibility = 'warning';
        reasons.push('Aktuell in Reinigung (kein Freigabezeitpunkt bekannt).');
      } else if (machine.status !== 'ready') {
        eligibility = 'override_required';
        reasons.push(`Status ${MACHINE_STATUS_LABELS[machine.status]}.`);
      }
      const block = state.blocks.find(
        (candidate) => candidate.machineId === machine.id && blockOverlaps(candidate, from, to),
      );
      if (block !== undefined) {
        eligibility = 'override_required';
        reasons.push(
          `Gesperrt ${block.startsAt.toISOString()}–${block.endsAt.toISOString()}: ${block.reason}`,
        );
      }
      return {
        machineId: machine.id,
        machineCode: machine.machineCode,
        status: machine.status,
        statusLabel: MACHINE_STATUS_LABELS[machine.status],
        locationKind: machine.locationKind,
        purchaseDate: machine.purchaseDate,
        eligibility,
        reasons,
      };
    });

    const rank = (entry: MachineSuggestionEntry) =>
      entry.eligibility === 'eligible' ? 0 : entry.eligibility === 'warning' ? 1 : 2;
    entries.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      // Fachliche Präferenz: ältestes BEKANNTES Kaufdatum zuerst; ohne
      // Kaufdatum deterministisch nach Maschinen-ID (Order §20).
      if (a.purchaseDate !== null && b.purchaseDate !== null && a.purchaseDate !== b.purchaseDate) {
        return a.purchaseDate < b.purchaseDate ? -1 : 1;
      }
      if (a.purchaseDate !== null && b.purchaseDate === null) return -1;
      if (a.purchaseDate === null && b.purchaseDate !== null) return 1;
      return a.machineCode.localeCompare(b.machineCode);
    });

    const preferred = entries.find((entry) => entry.eligibility === 'eligible') ?? null;
    const warnings: string[] = [];
    if (interval !== null) {
      const check = await this.checkProduct(productId, interval, {}, now);
      warnings.push(...check.reasons);
    }
    return {
      preferred,
      preferredBasis:
        preferred === null
          ? null
          : preferred.purchaseDate !== null
            ? 'Ältestes bekanntes Kaufdatum'
            : 'Kaufdatum unbekannt – deterministisch nach Maschinen-ID',
      others: entries.filter((entry) => entry !== preferred),
      warnings,
    };
  }
}
