'use client';

import type { OfflineEnvironment } from '@mietroyal/offline';

/**
 * Geräteseitige Kennungen (Phase-8-Order §§8, 46, 77) in localStorage:
 * Geräte-ID (UUID, bindet die Offline-Lease an dieses Gerät), ein
 * Identitätshinweis für den Offline-Start (Benutzer-ID, Umgebung, Name –
 * keine Fachdaten, keine Rechte) und das Lager-/Tabletmodus-Flag. Alles
 * andere liegt verschlüsselt in IndexedDB.
 */
const DEVICE_KEY = 'mr.staff.deviceId';
const IDENTITY_KEY = 'mr.staff.offlineIdentity';
const WAREHOUSE_KEY = 'mr.staff.warehouseMode';

export interface OfflineIdentity {
  userId: string;
  environment: OfflineEnvironment;
  firstName: string;
  lastName: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (ältere WebViews): RFC-4122-v4 aus Zufallsbytes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let memoryDeviceId: string | null = null;

/** Stabile Geräte-ID (UUID) – einmal erzeugt, dauerhaft gespeichert. */
export function deviceId(): string {
  const store = storage();
  const existing = store?.getItem(DEVICE_KEY) ?? memoryDeviceId;
  if (existing !== null && existing !== undefined && existing !== '') return existing;
  const id = newUuid();
  memoryDeviceId = id;
  store?.setItem(DEVICE_KEY, id);
  return id;
}

const ENVIRONMENTS: readonly OfflineEnvironment[] = [
  'development',
  'staging',
  'demo',
  'production',
];

export function readOfflineIdentity(): OfflineIdentity | null {
  const raw = storage()?.getItem(IDENTITY_KEY);
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OfflineIdentity>;
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.environment !== 'string' ||
      !ENVIRONMENTS.includes(parsed.environment)
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      environment: parsed.environment,
      firstName: typeof parsed.firstName === 'string' ? parsed.firstName : '',
      lastName: typeof parsed.lastName === 'string' ? parsed.lastName : '',
    };
  } catch {
    return null;
  }
}

export function writeOfflineIdentity(identity: OfflineIdentity | null): void {
  const store = storage();
  if (identity === null) store?.removeItem(IDENTITY_KEY);
  else store?.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

/** Ereignis für alle Komponenten dieses Tabs (Navigation, Tablet-Seite), wenn der Modus wechselt. */
export const WAREHOUSE_MODE_EVENT = 'mr-warehouse-mode';

export function warehouseModeEnabled(): boolean {
  return storage()?.getItem(WAREHOUSE_KEY) === '1';
}

export function setWarehouseMode(enabled: boolean): void {
  const store = storage();
  if (enabled) store?.setItem(WAREHOUSE_KEY, '1');
  else store?.removeItem(WAREHOUSE_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WAREHOUSE_MODE_EVENT));
}
