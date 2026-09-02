'use client';

/** Gemeinsame Typen/Labels des Maschinen-/Lagerbereichs (nur Darstellung). */

export type MachineStatus =
  'ready' | 'rented' | 'reserved' | 'cleaning' | 'repair' | 'out_of_service';

export type MachineLocationKind = 'warehouse' | 'customer' | 'staff' | 'repair' | 'other';

/** Status IMMER mit Icon UND Text (Order §5) – nie nur Farbe. */
export const MACHINE_STATUS_LABELS: Record<MachineStatus, string> = {
  ready: 'Einsatzbereit',
  rented: 'Vermietet',
  reserved: 'Reserviert',
  cleaning: 'Reinigung',
  repair: 'Reparatur',
  out_of_service: 'Außer Betrieb',
};

export const MACHINE_STATUS_ICONS: Record<MachineStatus, string> = {
  ready: '🟢',
  rented: '🔵',
  reserved: '🟠',
  cleaning: '🟡',
  repair: '🔴',
  out_of_service: '⚫',
};

/** Manuell setzbare Status (Order §6) – Reserviert/Vermietet kommen später
 *  aus den Fachprozessen und sind kein manueller Alltagsstatus. */
export const MANUAL_MACHINE_STATUSES: readonly MachineStatus[] = [
  'ready',
  'cleaning',
  'repair',
  'out_of_service',
];

export const MACHINE_LOCATION_LABELS: Record<MachineLocationKind, string> = {
  warehouse: 'Lager',
  customer: 'Kunde',
  staff: 'Mitarbeiter / unterwegs',
  repair: 'Reparatur',
  other: 'Sonstiger interner Standort',
};

export interface MachineListRow {
  id: string;
  machineCode: string;
  productId: string;
  productName: string;
  status: MachineStatus;
  statusLabel: string;
  locationKind: MachineLocationKind;
  locationLabel: string;
  locationNote: string | null;
  activeBlockReason: string | null;
  openBlockCount: number;
  notRegularlyAvailable: boolean;
}

export interface MachineDetail {
  id: string;
  machineCode: string;
  productId: string;
  productName: string;
  status: MachineStatus;
  statusLabel: string;
  locationKind: MachineLocationKind;
  locationLabel: string;
  locationNote: string | null;
  purchaseDate: string | null;
  weightGrams: number | null;
  carryPersons: number | null;
  hasReferencePhoto: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MachineBlockRow {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  active: boolean;
}

export interface InventoryItemRow {
  itemId: string;
  productId: string;
  productSlug: string;
  productName: string;
  saleUnit: string;
  productActive: boolean;
  currentStock: number | null;
  minStock: number | null;
  lowStock: boolean;
}

export interface StocktakeItemRow {
  itemId: string;
  productName: string;
  saleUnit: string;
  systemStock: number | null;
  countedStock: number;
  absoluteDifference: number | null;
  percentDifference: number | null;
}

export interface StocktakeRow {
  id: string;
  status: 'completed' | 'pending_approval' | 'approved';
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  items: StocktakeItemRow[];
}

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeRow['status'], string> = {
  completed: 'Abgeschlossen (keine Differenz)',
  pending_approval: 'Freigabe erforderlich',
  approved: 'Freigegeben',
};

/** Bestand oder ehrliches „Noch nicht erfasst“ (Order §27). */
export function stockLabel(item: Pick<InventoryItemRow, 'currentStock' | 'saleUnit'>): string {
  if (item.currentStock === null) return 'Noch nicht initial erfasst';
  return `${item.currentStock} × ${item.saleUnit}`;
}

export function percentLabel(value: number | null): string {
  if (value === null) return 'nicht berechenbar';
  return `${String(value).replace('.', ',')} %`;
}
