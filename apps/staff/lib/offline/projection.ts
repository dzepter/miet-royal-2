'use client';

import { handoverBlockers, returnBlockers } from '@mietroyal/domain';
import type {
  MutationPayload,
  MutationStatus,
  OfflineBookingSnapshot,
  OfflineCandidateMachine,
  OfflineMachineSnapshot,
  OfflineMutationType,
} from '@mietroyal/offline';
import type {
  HandoverDetail,
  MachineProblem,
  OfflineViewFlags,
  SlotView,
  SuggestionEntry,
} from '../handover';
import {
  ACCESSORY_LABELS,
  SEVERITY_LABELS,
  VIEW_LABELS,
  type DamageView,
  type MissingCaseView,
  type ReturnDetail,
  type ReturnItemView,
  type ReturnMachineView,
} from '../returns';
import { MACHINE_LOCATION_LABELS, MACHINE_STATUS_LABELS } from '../warehouse';

/**
 * Lokale Projektion (Phase-8-Order §§15–22, 31–34): wendet die noch nicht
 * synchronisierten Mutationen eines Vorgangs auf den Server-Snapshot an, damit
 * die BESTEHENDEN Wizards offline dieselbe Sicht wie online sehen. Kein
 * zweiter Regelsatz: Blocker kommen aus `@mietroyal/domain`
 * (handoverBlockers/returnBlockers) – derselben Funktion wie im Server.
 * Finanzbeträge werden lokal NIE autoritativ berechnet (§22): die
 * Reinigungsgebühr bleibt `null` („Betrag wird bei der Synchronisierung
 * serverseitig ermittelt“).
 */
export type LocalSnapshot = OfflineBookingSnapshot<HandoverDetail, ReturnDetail>;

export interface LocalMutation {
  clientMutationId: string;
  type: string;
  status: MutationStatus;
  createdAt: string;
  /** Serverseitige Verarbeitungszeit laut Quittung (nur synchronisierte Mutationen). */
  syncedAt: string | null;
  payload: unknown;
  mediaIds: string[];
}

export type LocalHandoverDetail = HandoverDetail & { offline: OfflineViewFlags };
export type LocalReturnDetail = ReturnDetail & { offline: OfflineViewFlags };

/** Präfix lokaler (noch nicht serverseitig vergebener) IDs – Fotos, Schäden, Fehlteile. */
export const LOCAL_ID_PREFIX = 'local:';

export const CLEANUP_FEE_PENDING_TEXT =
  'Betrag wird bei der Synchronisierung serverseitig ermittelt';

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

export function localId(raw: string): string {
  return `${LOCAL_ID_PREFIX}${raw}`;
}

export function rawLocalId(id: string): string | null {
  return isLocalId(id) ? id.slice(LOCAL_ID_PREFIX.length) : null;
}

/** Anzeige-ID eines lokal gespeicherten Fotos/einer Unterschrift (PhotoThumb lädt die Bytes aus dem Store). */
export function localPhotoId(mediaId: string): string {
  return localId(mediaId);
}

export function mediaIdFromLocalPhotoId(id: string): string | null {
  return rawLocalId(id);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Welche lokalen Mutationen auf den Snapshot anzuwenden sind: alle offenen,
 * dazu synchronisierte, die der Server NACH dem Snapshot verarbeitet hat
 * (Serverzeit gegen Serverzeit – die Gerätezeit ist nur Input, §68; ohne
 * Quittung Rückfall auf die Erfassungszeit). Konfliktierte Mutationen (und
 * ihr fachliches Kind, das Schadenfoto) gelten lokal NICHT mehr als
 * angewendet (§34 – die Seite zeigt den Serverstand, die Konflikt-UI das
 * offline Erfasste).
 */
export function applicableMutations(
  snapshot: { snapshotAt: string },
  mutations: readonly LocalMutation[],
): LocalMutation[] {
  const conflicted = new Set(
    mutations
      .filter((m) => m.status === 'conflict' || m.status === 'failed_permanent')
      .map((m) => m.clientMutationId),
  );
  return mutations.filter((m) => {
    if (conflicted.has(m.clientMutationId)) return false;
    const parentRef = (m.payload as { damageMutationId?: string | null }).damageMutationId;
    if (
      m.type === 'return.damage_photo' &&
      parentRef !== null &&
      parentRef !== undefined &&
      conflicted.has(parentRef)
    ) {
      return false;
    }
    return (
      m.status !== 'synced' ||
      Date.parse(m.syncedAt ?? m.createdAt) > Date.parse(snapshot.snapshotAt)
    );
  });
}

export function flagsFor(
  mutations: readonly LocalMutation[],
  finalizeType: OfflineMutationType,
): OfflineViewFlags {
  const finalize = mutations.find((m) => m.type === finalizeType && m.status !== 'synced');
  return {
    pendingFinalize: finalize !== undefined,
    capturedAt: finalize?.createdAt ?? null,
    offlineChosenSlots: [],
    stockRisk: [],
    pendingCount: mutations.filter(
      (m) => m.status === 'pending' || m.status === 'syncing' || m.status === 'failed_retryable',
    ).length,
    conflictCount: mutations.filter(
      (m) => m.status === 'conflict' || m.status === 'failed_permanent',
    ).length,
  };
}

export function staffName(staff: { firstName: string; lastName: string }): string {
  return `${staff.firstName} ${staff.lastName}`.trim();
}

function toMachineProblem(problem: OfflineCandidateMachine['problems'][number]): MachineProblem {
  return {
    code: problem.code,
    descriptor: problem.descriptor,
    label: problem.label,
    detail: problem.detail,
    warningOnly: problem.warningOnly,
  };
}

/** Kandidaten-Maschine des Pakets als Vorschlagseintrag der Ausgabe-Seite (nur Darstellung). */
export function candidateToSuggestion(candidate: OfflineCandidateMachine): SuggestionEntry {
  return {
    machineId: candidate.machineId,
    machineCode: candidate.machineCode,
    status: 'ready',
    statusLabel: MACHINE_STATUS_LABELS.ready,
    locationKind: 'warehouse',
    locationLabel: MACHINE_LOCATION_LABELS.warehouse,
    locationNote: null,
    purchaseDate: null,
    preferred: false,
    preferredBasis: null,
    eligibility: candidate.hardBlocked
      ? 'override_required'
      : candidate.overrideRequired
        ? 'override_required'
        : candidate.problems.length > 0
          ? 'warning'
          : 'eligible',
    problems: candidate.problems.map(toMachineProblem),
    hardBlocked: candidate.hardBlocked,
    overrideRequired: candidate.overrideRequired,
  };
}

// ── Übergabe ────────────────────────────────────────────────────────────────

/**
 * Übergabe-Detail aus Snapshot + lokalen Mutationen. `null`, wenn das Paket
 * keine Übergabesicht enthält (kein handover.view).
 */
export function projectHandover(
  snapshot: LocalSnapshot,
  mutations: readonly LocalMutation[],
  staff: { firstName: string; lastName: string },
): LocalHandoverDetail | null {
  if (snapshot.handover === null) return null;
  const detail = clone(snapshot.handover);
  const applied = applicableMutations(snapshot, mutations);
  const flags = flagsFor(mutations, 'handover.finalize');
  const slotOf = (assignmentId: string): SlotView | undefined =>
    detail.slots.find((slot) => slot.id === assignmentId);
  const machineViewOf = (assignmentId: string) =>
    detail.machines.find((m) => m.assignmentId === assignmentId);

  for (const mutation of applied) {
    switch (mutation.type as OfflineMutationType) {
      case 'handover.assign': {
        const p = mutation.payload as MutationPayload<'handover.assign'>;
        const slot = slotOf(p.assignmentId);
        if (slot === undefined) break;
        const candidate = (snapshot.candidateMachines[p.assignmentId] ?? []).find(
          (c) => c.machineId === p.machineId,
        );
        slot.machine = {
          id: p.machineId,
          machineCode: candidate?.machineCode ?? '–',
          status: 'reserved',
          statusLabel: MACHINE_STATUS_LABELS.reserved,
          locationKind: 'warehouse',
          locationLabel: MACHINE_LOCATION_LABELS.warehouse,
          locationNote: null,
        };
        slot.status = 'assigned';
        slot.assignedAt = mutation.createdAt;
        slot.preparedAt = null;
        slot.currentProblems = (candidate?.problems ?? []).map(toMachineProblem);
        slot.overrideStale = false;
        slot.override =
          p.override === null
            ? null
            : {
                id: localId(mutation.clientMutationId),
                reason: p.override.reason,
                problemSummary: slot.currentProblems.map((problem) => problem.label).join(', '),
                confirmedByName: staffName(staff),
                confirmedAt: mutation.createdAt,
              };
        const view = machineViewOf(p.assignmentId);
        if (view !== undefined) {
          view.machineId = p.machineId;
          view.machineCode = slot.machine.machineCode;
          view.checked = false;
          view.checkedAt = null;
          view.photos = [];
        } else {
          detail.machines.push({
            assignmentId: p.assignmentId,
            machineId: p.machineId,
            machineCode: slot.machine.machineCode,
            checked: false,
            checkedAt: null,
            photos: [],
          });
        }
        if (!flags.offlineChosenSlots.includes(p.assignmentId))
          flags.offlineChosenSlots.push(p.assignmentId);
        break;
      }
      case 'handover.prepare': {
        const p = mutation.payload as MutationPayload<'handover.prepare'>;
        const slot = slotOf(p.assignmentId);
        if (slot === undefined || slot.machine === null) break;
        slot.status = 'prepared';
        slot.preparedAt = mutation.createdAt;
        break;
      }
      case 'handover.check_machine': {
        const p = mutation.payload as MutationPayload<'handover.check_machine'>;
        const view = machineViewOf(p.assignmentId);
        if (view === undefined) break;
        view.checked = true;
        view.checkedAt = mutation.createdAt;
        break;
      }
      case 'handover.photo': {
        const p = mutation.payload as MutationPayload<'handover.photo'>;
        const view = machineViewOf(p.assignmentId);
        if (view === undefined) break;
        view.photos.push({ id: localPhotoId(p.mediaId), takenAt: mutation.createdAt });
        break;
      }
      case 'handover.item_quantity': {
        const p = mutation.payload as MutationPayload<'handover.item_quantity'>;
        const item = detail.deliveryNote.items.find((entry) => entry.id === p.itemId);
        if (item !== undefined) item.actualQuantity = p.actualQuantity;
        break;
      }
      case 'handover.recipient': {
        const p = mutation.payload as MutationPayload<'handover.recipient'>;
        detail.handover.recipientKind = p.kind;
        detail.handover.recipientName =
          p.kind === 'customer'
            ? detail.booking.customerName
            : p.kind === 'representative'
              ? detail.representative === null
                ? null
                : `${detail.representative.firstName} ${detail.representative.lastName}`.trim()
              : p.name;
        detail.handover.recipientPhone =
          p.kind === 'customer'
            ? detail.booking.customerPhone
            : p.kind === 'representative'
              ? (detail.representative?.phone ?? null)
              : p.phone;
        break;
      }
      case 'handover.signature': {
        const p = mutation.payload as MutationPayload<'handover.signature'>;
        const signer =
          p.role === 'staff' ? staffName(staff) : (detail.handover.recipientName ?? '');
        detail.signatures[p.role] = { signerName: signer, signedAt: mutation.createdAt };
        break;
      }
      case 'handover.finalize':
        // Lokal NIE final (§15): Status bleibt Entwurf, Kennzeichen „offline erfasst“.
        detail.handover.actualIssueAt = detail.handover.actualIssueAt ?? mutation.createdAt;
        break;
      default:
        break;
    }
  }

  // Lagerbedarf je Artikel nach lokal geänderten Mengen neu zusammenzählen (nur Anzeige, §23).
  for (const entry of detail.stock) {
    const required = detail.deliveryNote.items
      .filter((item) => item.inventoryItemId === entry.inventoryItemId)
      .reduce((sum, item) => sum + item.actualQuantity, 0);
    entry.required = required;
    entry.sufficient = entry.systemStock !== null && entry.systemStock >= required;
  }

  detail.blockers = handoverBlockers({
    processStatus: detail.booking.processStatus,
    handoverStatus: detail.handover.status,
    recipientKind: detail.handover.recipientKind,
    recipientName: detail.handover.recipientName,
    slots: detail.slots.map((slot) => ({
      id: slot.id,
      slotNo: slot.slotNo,
      productName: slot.productName,
      status: slot.status,
      machine:
        slot.machine === null
          ? null
          : { id: slot.machine.id, machineCode: slot.machine.machineCode },
      currentProblems: slot.currentProblems,
      overrideStale: slot.overrideStale,
    })),
    machines: detail.machines.map((m) => ({
      assignmentId: m.assignmentId,
      checked: m.checked,
      photoCount: m.photos.length,
    })),
    items: detail.deliveryNote.items,
    // §24: knapper Bestand laut Snapshot ist offline KEIN Blocker – starke Warnung und
    // Konfliktrisiko; der Server prüft den Bestand beim Sync autoritativ.
    stock: [],
    customerSigned: detail.signatures.customer !== null,
    staffSigned: detail.signatures.staff !== null,
    containersTotal: detail.booking.containersTotal,
  });
  flags.stockRisk = detail.stock.filter((entry) => !entry.sufficient).map((e) => e.productName);

  const allAssigned = detail.slots.length > 0 && detail.slots.every((s) => s.machine !== null);
  const allPrepared =
    allAssigned && detail.slots.every((s) => s.status === 'prepared' || s.status === 'issued');
  detail.nextAction =
    detail.handover.status === 'finalized'
      ? 'done'
      : !allAssigned
        ? 'assign'
        : !allPrepared
          ? 'prepare'
          : 'handover';

  return { ...detail, offline: flags };
}

// ── Rückgabe ────────────────────────────────────────────────────────────────

function itemKindLabel(kind: ReturnItemView['kind']): string {
  return kind === 'commission' ? 'Kommission' : 'inklusive';
}

/** Spiegel der serverseitigen Ableitung (ReturnService): nur Kommission ist abrechenbar, Preis = Snapshot. */
export function recomputeItem(item: ReturnItemView): void {
  const chargeable =
    item.kind === 'commission'
      ? Math.max(0, item.issuedQuantity - item.returnedUnopenedQuantity)
      : 0;
  item.chargeableQuantity = chargeable;
  item.chargeableAmountCents =
    item.kind === 'commission' ? chargeable * item.unitPriceSnapshotCents : 0;
}

export type MachineInfoLookup = (machineId: string) => OfflineMachineSnapshot | undefined;

/**
 * Rückgabe-Entwurf, wie ihn `ReturnService.start` serverseitig anlegen würde –
 * aus der Rückgabe-Saat des Pakets (ausgegebene Maschinen + Positionen) und den
 * Übergabe-/Kontaktdaten des Snapshots. Nur für `return.start` offline.
 */
export function localDraftFromSeed(
  snapshot: LocalSnapshot,
  startedAt: string,
  machineInfo: MachineInfoLookup,
): ReturnDetail | null {
  const seed = snapshot.returnSeed;
  if (seed === null) return null;
  const handover = snapshot.handover;
  const containers = handover?.booking.containersTotal ?? 0;
  const returnAppointment = snapshot.appointments.find((a) => a.kind === 'return') ?? null;
  const machines: ReturnMachineView[] = seed.machines.map((entry, index) => {
    const slot = handover?.slots.find((s) => s.id === entry.assignmentId);
    const info = machineInfo(entry.machineId);
    const existing = snapshot.existingDamages[entry.machineId] ?? [];
    return {
      id: localId(entry.assignmentId),
      assignmentId: entry.assignmentId,
      slotNo: slot?.slotNo ?? index + 1,
      machineId: entry.machineId,
      machineCode: slot?.machine?.machineCode ?? info?.machineCode ?? '–',
      machineStatus: info?.status ?? slot?.machine?.status ?? 'rented',
      machineStatusLabel: MACHINE_STATUS_LABELS.rented,
      typeName:
        info?.machineTypeName ?? slot?.productName ?? handover?.booking.machineTypeName ?? '',
      productSlug: info?.productSlug ?? existing[0]?.productSlug ?? '',
      expectedLids: containers,
      expectedDripTrays: containers,
      accessoryComplete: null,
      accessoryCheckedAt: null,
      emptied: null,
      rinsedTwice: null,
      nothingDismantled: null,
      cleanlinessCheckedAt: null,
      cleanupRequired: false,
      cleanupFeeCents: null,
      cleanupReason: null,
      cleanupPhotos: [],
      damages: [],
      missingCases: [],
      returnedAt: null,
    };
  });
  const items: ReturnItemView[] = seed.items.map((entry) => {
    const source = handover?.deliveryNote.items.find((i) => i.id === entry.deliveryNoteItemId);
    const kind = (
      entry.kind === 'commission' || entry.kind === 'purchase' ? entry.kind : 'included'
    ) as ReturnItemView['kind'];
    const item: ReturnItemView = {
      id: localId(entry.deliveryNoteItemId),
      deliveryNoteItemId: entry.deliveryNoteItemId,
      inventoryItemId: source?.inventoryItemId ?? null,
      kind,
      kindLabel: itemKindLabel(kind),
      description: source?.description ?? '',
      unit: source?.unit ?? '',
      issuedQuantity: entry.issuedQuantity,
      returnedUnopenedQuantity: 0,
      unitPriceSnapshotCents: source?.unitPriceCents ?? 0,
      chargeableQuantity: 0,
      chargeableAmountCents: 0,
    };
    recomputeItem(item);
    return item;
  });
  return {
    booking: {
      id: snapshot.bookingId,
      processId: snapshot.processId,
      processNumber: snapshot.processNumber,
      processStatus: handover?.booking.processStatus ?? 'open',
      customerName: handover?.booking.customerName ?? snapshot.customer.name,
      customerEmail: null,
      fulfillment: handover?.booking.fulfillment ?? 'pickup',
      machineTypeName: handover?.booking.machineTypeName ?? null,
      machineQuantity: handover?.booking.machineQuantity ?? machines.length,
    },
    return: {
      id: localId(snapshot.bookingId),
      status: 'draft',
      returnerKind: null,
      returnerName: null,
      returnerPhone: null,
      startedAt,
      finalizedAt: null,
      draftActualReturnAt: null,
      actualReturnAt: null,
      originalActualReturnAt: null,
      correctedActualReturnAt: null,
      correctedAt: null,
      protocolDocumentId: null,
      appointment:
        returnAppointment === null
          ? null
          : {
              id: returnAppointment.id,
              status: 'scheduled',
              startAt: returnAppointment.startAt,
              endAt: returnAppointment.endAt,
              overdue:
                (returnAppointment.endAt ?? returnAppointment.startAt) !== null &&
                Date.parse(returnAppointment.endAt ?? returnAppointment.startAt ?? '') <
                  Date.parse(startedAt),
            },
    },
    representative: handover?.representative ?? null,
    machines,
    items,
    signatures: { customer: null, staff: null },
    summary: {
      withoutComplaint: false,
      cleanupMachines: 0,
      cleanupFeeTotalCents: 0,
      damages: 0,
      missingCases: 0,
      commissionChargeableCents: 0,
      lines: [],
    },
    blockers: [],
    nextAction: 'returner',
  };
}

/**
 * Rückgabe-Detail aus Snapshot + lokalen Mutationen. `null`, wenn weder der
 * Server eine Rückgabe kennt noch lokal `return.start` erfasst wurde.
 */
export function projectReturn(
  snapshot: LocalSnapshot,
  mutations: readonly LocalMutation[],
  staff: { firstName: string; lastName: string },
  machineInfo: MachineInfoLookup = () => undefined,
): LocalReturnDetail | null {
  const applied = applicableMutations(snapshot, mutations);
  const flags = flagsFor(mutations, 'return.finalize');
  let detail: ReturnDetail | null = snapshot.return === null ? null : clone(snapshot.return);
  if (detail === null) {
    const start = applied.find((m) => m.type === 'return.start');
    if (start === undefined) return null;
    detail = localDraftFromSeed(snapshot, start.createdAt, machineInfo);
    if (detail === null) return null;
  }
  const current = detail;
  const machineByAssignment = (assignmentId: string): ReturnMachineView | undefined =>
    current.machines.find((m) => m.assignmentId === assignmentId);

  for (const mutation of applied) {
    switch (mutation.type as OfflineMutationType) {
      case 'return.returner': {
        const p = mutation.payload as MutationPayload<'return.returner'>;
        current.return.returnerKind = p.kind;
        current.return.returnerName =
          p.kind === 'customer'
            ? current.booking.customerName
            : p.kind === 'representative'
              ? current.representative === null
                ? null
                : `${current.representative.firstName} ${current.representative.lastName}`.trim()
              : `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
        current.return.returnerPhone = p.kind === 'other' ? p.phone : null;
        break;
      }
      case 'return.accessory': {
        const p = mutation.payload as MutationPayload<'return.accessory'>;
        const machine = machineByAssignment(p.assignmentId);
        if (machine === undefined) break;
        machine.accessoryComplete = true;
        machine.accessoryCheckedAt = mutation.createdAt;
        break;
      }
      case 'return.missing_item': {
        const p = mutation.payload as MutationPayload<'return.missing_item'>;
        const machine = machineByAssignment(p.assignmentId);
        if (machine === undefined) break;
        const missing: MissingCaseView = {
          id: localId(mutation.clientMutationId),
          returnId: current.return.id,
          returnMachineId: machine.id,
          machineId: machine.machineId,
          machineCode: machine.machineCode,
          processId: current.booking.processId,
          processNumber: current.booking.processNumber,
          accessoryType: p.accessoryType,
          accessoryLabel: ACCESSORY_LABELS[p.accessoryType],
          missingQuantity: p.missingQuantity,
          description: p.description,
          status: 'open',
          requiresFinancialReview: true,
          followUpOpenedAt: null,
          createdAt: mutation.createdAt,
          resolvedAt: null,
        };
        machine.missingCases.push(missing);
        // Fehlteil erfasst = Zubehörkontrolle durchgeführt, Ergebnis unvollständig.
        machine.accessoryComplete = false;
        machine.accessoryCheckedAt = mutation.createdAt;
        break;
      }
      case 'return.cleanliness': {
        const p = mutation.payload as MutationPayload<'return.cleanliness'>;
        const machine = machineByAssignment(p.assignmentId);
        if (machine === undefined) break;
        machine.emptied = p.emptied;
        machine.rinsedTwice = p.rinsedTwice;
        machine.nothingDismantled = p.nothingDismantled;
        machine.cleanlinessCheckedAt = mutation.createdAt;
        const failed = [
          !p.emptied ? 'nicht entleert' : null,
          !p.rinsedTwice ? 'nicht zweimal gespült' : null,
          !p.nothingDismantled ? 'Teile demontiert' : null,
        ].filter((entry): entry is string => entry !== null);
        machine.cleanupRequired = failed.length > 0;
        // Betrag ausschließlich serverseitig (§17/§22) – lokal unbekannt.
        machine.cleanupFeeCents = null;
        machine.cleanupReason = failed.length > 0 ? failed.join(', ') : null;
        break;
      }
      case 'return.cleanup_photo': {
        const p = mutation.payload as MutationPayload<'return.cleanup_photo'>;
        const machine = machineByAssignment(p.assignmentId);
        if (machine === undefined) break;
        machine.cleanupPhotos.push({ id: localPhotoId(p.mediaId), takenAt: mutation.createdAt });
        break;
      }
      case 'return.item_quantity': {
        const p = mutation.payload as MutationPayload<'return.item_quantity'>;
        const item = current.items.find((i) => i.deliveryNoteItemId === p.deliveryNoteItemId);
        if (item === undefined) break;
        item.returnedUnopenedQuantity = p.returnedUnopenedQuantity;
        recomputeItem(item);
        break;
      }
      case 'return.damage': {
        const p = mutation.payload as MutationPayload<'return.damage'>;
        const machine = machineByAssignment(p.assignmentId);
        if (machine === undefined) break;
        const damage: DamageView = {
          id: localId(mutation.clientMutationId),
          machineId: machine.machineId,
          machineCode: machine.machineCode,
          productSlug: machine.productSlug,
          returnId: current.return.id,
          returnMachineId: machine.id,
          origin: 'return',
          severity: p.severity,
          severityLabel: SEVERITY_LABELS[p.severity],
          description: p.description,
          requiresFinancialReview: true,
          createdAt: mutation.createdAt,
          createdByName: staffName(staff),
          activatedAt: null,
          resolvedAt: null,
          current: false,
          markers: p.markers.map((marker, index) => ({
            id: `${localId(mutation.clientMutationId)}:${index}`,
            view: marker.view,
            viewLabel: VIEW_LABELS[marker.view],
            markerType: marker.markerType,
            x: marker.x,
            y: marker.y,
            width: marker.width ?? null,
            height: marker.height ?? null,
          })),
          photos: [],
        };
        machine.damages.push(damage);
        break;
      }
      case 'return.damage_photo': {
        const p = mutation.payload as MutationPayload<'return.damage_photo'>;
        const targetId = p.damageMutationId !== null ? localId(p.damageMutationId) : p.damageId;
        const damage = current.machines.flatMap((m) => m.damages).find((d) => d.id === targetId);
        if (damage === undefined) break;
        damage.photos.push({ id: localPhotoId(p.mediaId), takenAt: mutation.createdAt });
        break;
      }
      case 'return.signature': {
        const p = mutation.payload as MutationPayload<'return.signature'>;
        const signer = p.role === 'staff' ? staffName(staff) : (current.return.returnerName ?? '');
        current.signatures[p.role] = { signerName: signer, signedAt: mutation.createdAt };
        break;
      }
      case 'return.actual_time': {
        const p = mutation.payload as MutationPayload<'return.actual_time'>;
        current.return.draftActualReturnAt = p.actualReturnAt;
        break;
      }
      case 'return.finalize':
        // Lokal NIE final (§18): Entwurf bleibt, Kennzeichen „offline erfasst“.
        break;
      default:
        break;
    }
  }

  // Zusammenfassung (nur Zähler/Texte – keine lokal berechneten Gebühren).
  const damageCount = current.machines.reduce((sum, m) => sum + m.damages.length, 0);
  const missingCount = current.machines.reduce((sum, m) => sum + m.missingCases.length, 0);
  const cleanupMachines = current.machines.filter((m) => m.cleanupRequired).length;
  current.summary.damages = damageCount;
  current.summary.missingCases = missingCount;
  current.summary.cleanupMachines = cleanupMachines;
  current.summary.commissionChargeableCents = current.items.reduce(
    (sum, item) => sum + item.chargeableAmountCents,
    0,
  );
  current.summary.withoutComplaint =
    current.machines.length > 0 &&
    current.machines.every((m) => m.accessoryComplete === true && !m.cleanupRequired) &&
    damageCount === 0 &&
    missingCount === 0;
  const lines: string[] = [];
  for (const m of current.machines) {
    for (const damage of m.damages) {
      lines.push(
        `Schaden ${m.machineCode} (${damage.severityLabel}): ${damage.description} – finanzielle Klärung erforderlich`,
      );
    }
    for (const missing of m.missingCases) {
      lines.push(
        `Fehlteil ${m.machineCode}: ${missing.missingQuantity} × ${missing.accessoryLabel} – finanzielle Klärung später erforderlich`,
      );
    }
    if (m.cleanupRequired) {
      lines.push(
        `Reinigungsgebühr ${m.machineCode}: ${m.cleanupReason ?? ''} – ${CLEANUP_FEE_PENDING_TEXT}`,
      );
    }
  }
  current.summary.lines = lines;

  current.blockers = returnBlockers({
    returnStatus: current.return.status,
    returnerKind: current.return.returnerKind,
    returnerName: current.return.returnerName,
    machines: current.machines.map((m) => ({
      machineCode: m.machineCode,
      accessoryComplete: m.accessoryComplete,
      cleanlinessCheckedAt: m.cleanlinessCheckedAt,
      cleanupRequired: m.cleanupRequired,
      cleanupPhotoCount: m.cleanupPhotos.length,
      damages: m.damages.map((damage) => ({
        description: damage.description,
        photoCount: damage.photos.length,
        markerCount: damage.markers.length,
      })),
    })),
    customerSigned: current.signatures.customer !== null,
    staffSigned: current.signatures.staff !== null,
  });

  const returnerSet =
    current.return.returnerKind !== null && (current.return.returnerName ?? '').trim() !== '';
  const checksDone =
    current.machines.every(
      (m) => m.accessoryComplete !== null && m.cleanlinessCheckedAt !== null,
    ) &&
    current.machines.every(
      (m) =>
        (!m.cleanupRequired || m.cleanupPhotos.length > 0) &&
        m.damages.every((d) => d.photos.length > 0),
    );
  current.nextAction =
    current.return.status === 'finalized'
      ? 'done'
      : !returnerSet
        ? 'returner'
        : !checksDone
          ? 'checks'
          : current.signatures.customer === null || current.signatures.staff === null
            ? 'sign'
            : 'finalize';

  return { ...current, offline: flags };
}
