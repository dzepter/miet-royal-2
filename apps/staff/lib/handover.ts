'use client';

import type { MachineLocationKind, MachineStatus } from './warehouse';

/** Gemeinsame Typen/Labels des Ausgabe-/Übergabebereichs (nur Darstellung). */

export type AssignmentStatus = 'open' | 'assigned' | 'prepared' | 'issued' | 'returned';

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  open: 'Keine Maschine zugewiesen',
  assigned: 'Zugewiesen',
  prepared: 'Vorbereitet',
  issued: 'Ausgegeben',
  returned: 'Zurückgegeben',
};

export interface MachineProblem {
  code: string;
  descriptor: string;
  label: string;
  detail: string;
  warningOnly: boolean;
  otherProcessNumber?: string;
  otherBookingId?: string;
  from?: string;
  to?: string;
}

export interface SlotView {
  id: string;
  slotNo: number;
  productId: string;
  productName: string;
  status: AssignmentStatus;
  machine: {
    id: string;
    machineCode: string;
    status: MachineStatus;
    statusLabel: string;
    locationKind: MachineLocationKind;
    locationLabel: string;
    locationNote: string | null;
  } | null;
  rentalFrom: string | null;
  rentalTo: string | null;
  assignedAt: string | null;
  preparedAt: string | null;
  issuedAt: string | null;
  override: {
    id: string;
    reason: string;
    problemSummary: string;
    confirmedByName: string | null;
    confirmedAt: string;
  } | null;
  currentProblems: MachineProblem[];
  overrideStale: boolean;
}

export interface SuggestionEntry {
  machineId: string;
  machineCode: string;
  status: MachineStatus;
  statusLabel: string;
  locationKind: MachineLocationKind;
  locationLabel: string;
  locationNote: string | null;
  purchaseDate: string | null;
  preferred: boolean;
  preferredBasis: string | null;
  eligibility: 'eligible' | 'warning' | 'override_required';
  problems: MachineProblem[];
  hardBlocked: boolean;
  overrideRequired: boolean;
}

export interface DeliveryNoteItemView {
  id: string;
  kind: 'included' | 'commission' | 'purchase';
  kindLabel: string;
  productId: string | null;
  inventoryItemId: string | null;
  description: string;
  unit: string;
  plannedQuantity: number;
  actualQuantity: number;
  unitPriceCents: number;
  billingMode: string;
  fromAddition: boolean;
}

export interface HandoverDetail {
  booking: {
    id: string;
    processId: string;
    processNumber: string;
    processStatus: string;
    customerName: string;
    customerEmail: string | null;
    customerPhone: string | null;
    eventDate: string | null;
    eventTimeLabel: string | null;
    fulfillment: 'pickup' | 'delivery';
    deliveryAddressLines: string[];
    onsiteContactName: string | null;
    onsiteContactPhone: string | null;
    pickupAddress: string | null;
    transportNotes: string[];
    machineTypeName: string | null;
    machineQuantity: number;
    containersTotal: number;
  };
  handover: {
    id: string;
    status: 'draft' | 'finalized';
    recipientKind: 'customer' | 'representative' | 'other' | null;
    recipientName: string | null;
    recipientPhone: string | null;
    finalizedAt: string | null;
    actualIssueAt: string | null;
    protocolDocumentId: string | null;
    appointment: {
      id: string;
      kind: string;
      status: string;
      startAt: string | null;
      endAt: string | null;
    } | null;
  };
  slots: SlotView[];
  deliveryNote: {
    id: string;
    status: string;
    documentId: string | null;
    items: DeliveryNoteItemView[];
  };
  additions: {
    id: string;
    description: string;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    billingMode: string;
    createdAt: string;
  }[];
  representative: {
    firstName: string;
    lastName: string;
    phone: string | null;
    changeableUntil: string | null;
  } | null;
  machines: {
    assignmentId: string;
    machineId: string | null;
    machineCode: string | null;
    checked: boolean;
    checkedAt: string | null;
    photos: { id: string; takenAt: string }[];
  }[];
  signatures: {
    customer: { signerName: string; signedAt: string } | null;
    staff: { signerName: string; signedAt: string } | null;
  };
  stock: {
    inventoryItemId: string;
    productName: string;
    systemStock: number | null;
    required: number;
    sufficient: boolean;
  }[];
  canisterLimit: number;
  blockers: string[];
  nextAction: 'assign' | 'prepare' | 'handover' | 'done';
  /** Phase 8: nur gesetzt, wenn die Sicht lokal aus dem Offline-Arbeitsbereich projiziert wurde. */
  offline?: OfflineViewFlags;
}

/**
 * Phase 8: Kennzeichen einer lokal projizierten Übergabe-/Rückgabesicht –
 * der Offline-Router hängt sie an, die Wizards zeigen daraus „offline
 * erfasst – Synchronisierung ausstehend“, offline gewählte Maschinen und die
 * Bestandswarnung (§24).
 */
export interface OfflineViewFlags {
  /** true = lokal abgeschlossen, Synchronisierung ausstehend (§15/§18). */
  pendingFinalize: boolean;
  capturedAt: string | null;
  /** Slots (Zuordnungs-IDs) mit offline gewählter Maschine (§16). */
  offlineChosenSlots: string[];
  pendingCount: number;
  conflictCount: number;
  /** Artikel, für die der letzte lokale Snapshot keinen ausreichenden Bestand kennt (§24). */
  stockRisk: string[];
}

export interface HandoverDocument {
  id: string;
  type: string;
  createdAt: string;
  sha256: string;
}

export const NEXT_ACTION_LABELS: Record<HandoverDetail['nextAction'], string> = {
  assign: 'Maschinen zuweisen',
  prepare: 'Ausgabe vorbereiten',
  handover: 'Übergabe starten',
  done: 'Übergabe abgeschlossen',
};

export interface DeliveryPacketView {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  /** Phase 12: queued = Mail in der Outbox, failed = Versand endgültig gescheitert. */
  status: 'ready' | 'queued' | 'sent' | 'failed';
  sentAt: string | null;
  documentIds: string[];
  createdAt: string;
}

/** Outbox-Status (Order §39): in Dev/Test sichtbar, nie „versendet“ ohne Gateway. */
export const PACKET_STATUS_LABELS: Record<string, string> = {
  ready: 'versandbereit',
  // Phase 12 (UI): Zustände der echten Mail-Outbox.
  queued: 'Versand eingeplant',
  sent: 'versendet',
  failed: 'Versand fehlgeschlagen',
};

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  delivery_note: 'Lieferschein',
  handover_protocol: 'Übergabeprotokoll',
  return_protocol: 'Rückgabeprotokoll',
};

export function formatBerlin(iso: string | null): string {
  if (iso === null) return '–';
  return new Date(iso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatEuroCents(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${euros.toLocaleString('de-DE')},${rest} €`;
}

/** Datei → Base64 (ohne data:-Präfix) für JSON-Uploads. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}
