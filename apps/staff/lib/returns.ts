/** Phase 7: Typen und Labels der Rückgabe (Spiegel der API-Sichten). */

export type ReturnerKind = 'customer' | 'representative' | 'other';

export const RETURNER_LABELS: Record<ReturnerKind, string> = {
  customer: 'Kunde selbst',
  representative: 'Hinterlegte Abholperson',
  other: 'Sonstige Rückgabeperson',
};

export type DamageSeverity = 'light' | 'medium' | 'severe';
export const SEVERITY_LABELS: Record<DamageSeverity, string> = {
  light: 'leicht',
  medium: 'mittel',
  severe: 'schwer',
};

export type DamageViewSide = 'front' | 'back' | 'left' | 'right';
export const VIEW_LABELS: Record<DamageViewSide, string> = {
  front: 'Vorne',
  back: 'Hinten',
  left: 'Links',
  right: 'Rechts',
};

export type AccessoryType = 'lid' | 'drip_tray';
export const ACCESSORY_LABELS: Record<AccessoryType, string> = {
  lid: 'Deckel',
  drip_tray: 'Tropfschale',
};

export interface DamageMarkerShape {
  view: DamageViewSide;
  markerType: 'point' | 'area';
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export interface DamageMarkerView extends DamageMarkerShape {
  id: string;
  viewLabel: string;
}

export interface DamageView {
  id: string;
  machineId: string;
  machineCode: string;
  productSlug: string;
  returnId: string | null;
  returnMachineId: string | null;
  origin: 'return' | 'post_return_finding';
  severity: DamageSeverity;
  severityLabel: string;
  description: string;
  requiresFinancialReview: boolean;
  createdAt: string;
  createdByName: string | null;
  activatedAt: string | null;
  resolvedAt: string | null;
  current: boolean;
  markers: DamageMarkerView[];
  photos: { id: string; takenAt: string }[];
}

export interface MissingCaseView {
  id: string;
  returnId: string;
  returnMachineId: string;
  machineId: string;
  machineCode: string;
  processId: string;
  processNumber: string;
  accessoryType: AccessoryType;
  accessoryLabel: string;
  missingQuantity: number;
  description: string | null;
  status: 'open' | 'resolved';
  requiresFinancialReview: boolean;
  followUpOpenedAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReturnMachineView {
  id: string;
  assignmentId: string;
  slotNo: number;
  machineId: string;
  machineCode: string;
  machineStatus: string;
  machineStatusLabel: string;
  typeName: string;
  productSlug: string;
  expectedLids: number;
  expectedDripTrays: number;
  accessoryComplete: boolean | null;
  accessoryCheckedAt: string | null;
  emptied: boolean | null;
  rinsedTwice: boolean | null;
  nothingDismantled: boolean | null;
  cleanlinessCheckedAt: string | null;
  cleanupRequired: boolean;
  cleanupFeeCents: number | null;
  cleanupReason: string | null;
  cleanupPhotos: { id: string; takenAt: string }[];
  damages: DamageView[];
  missingCases: MissingCaseView[];
  returnedAt: string | null;
}

export interface ReturnItemView {
  id: string;
  deliveryNoteItemId: string;
  inventoryItemId: string | null;
  kind: 'included' | 'commission' | 'purchase';
  kindLabel: string;
  description: string;
  unit: string;
  issuedQuantity: number;
  returnedUnopenedQuantity: number;
  unitPriceSnapshotCents: number;
  chargeableQuantity: number;
  chargeableAmountCents: number;
}

export interface ReturnDetail {
  booking: {
    id: string;
    processId: string;
    processNumber: string;
    processStatus: string;
    customerName: string;
    customerEmail: string | null;
    fulfillment: 'pickup' | 'delivery';
    machineTypeName: string | null;
    machineQuantity: number;
  };
  return: {
    id: string;
    status: 'draft' | 'finalized';
    returnerKind: ReturnerKind | null;
    returnerName: string | null;
    returnerPhone: string | null;
    startedAt: string;
    finalizedAt: string | null;
    draftActualReturnAt: string | null;
    actualReturnAt: string | null;
    originalActualReturnAt: string | null;
    correctedActualReturnAt: string | null;
    correctedAt: string | null;
    protocolDocumentId: string | null;
    appointment: {
      id: string;
      status: string;
      startAt: string | null;
      endAt: string | null;
      overdue: boolean;
    } | null;
  };
  representative: { firstName: string; lastName: string } | null;
  machines: ReturnMachineView[];
  items: ReturnItemView[];
  signatures: {
    customer: { signerName: string; signedAt: string } | null;
    staff: { signerName: string; signedAt: string } | null;
  };
  summary: {
    withoutComplaint: boolean;
    cleanupMachines: number;
    cleanupFeeTotalCents: number;
    damages: number;
    missingCases: number;
    commissionChargeableCents: number;
    lines: string[];
  };
  blockers: string[];
  nextAction: 'returner' | 'checks' | 'sign' | 'finalize' | 'done';
}

export const RETURN_NEXT_ACTION_LABELS: Record<ReturnDetail['nextAction'], string> = {
  returner: 'Rückgabeperson bestimmen',
  checks: 'Maschinen prüfen',
  sign: 'Unterschriften einholen',
  finalize: 'Rückgabe abschließen',
  done: 'Rückgabe abgeschlossen',
};

export interface ReturnListEntry {
  bookingId: string;
  processId: string;
  processNumber: string;
  customerName: string;
  fulfillment: 'pickup' | 'delivery';
  machineCodes: string[];
  plannedAt: string | null;
  plannedEndAt: string | null;
  assigneeName: string | null;
  overdue: boolean;
  returnStatus: 'none' | 'draft';
  group: 'overdue' | 'today' | 'upcoming' | 'unscheduled';
}

export interface CleaningWarning {
  machineId: string;
  machineCode: string;
  cleaningSince: string;
  hoursInCleaning: number;
}

export interface TechnicalDefectView {
  id: string;
  machineId: string;
  returnId: string;
  processId: string;
  description: string;
  occurredAt: string;
  hasPhoto: boolean;
  requiresFinancialReview: boolean;
  createdByName: string | null;
  createdAt: string;
}

export interface MachineCondition {
  productSlug: string;
  currentDamages: DamageView[];
  openMissingCases: MissingCaseView[];
  technicalDefects: TechnicalDefectView[];
  cleaning: {
    active: boolean;
    since: string | null;
    overdue: boolean;
    cleanedAt: string | null;
    cleanedBy: string | null;
  };
  postReturnFindingOpen: boolean;
  defectLinkOpen: boolean;
}

export interface ReturnDocument {
  id: string;
  type: string;
  createdAt: string;
  sha256: string;
}

export interface ReturnResolved {
  bookingId: string;
  processId: string;
  processNumber: string;
  machineCode: string;
}
