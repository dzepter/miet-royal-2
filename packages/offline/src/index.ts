/**
 * @mietroyal/offline – Offline-Arbeitsbereich der Staff-PWA (Phase 8):
 * verschlüsselter IndexedDB-Store, Schlüsselmodell, Lease, Mutations-Queue.
 * Der DOM-freie Teil (Schemata/Wire-Typen) liegt in ./shared.
 */
export type * from './records.ts';
export * from './shared.ts';
export * from './crypto.ts';
export * from './db.ts';
export * from './store.ts';
export {
  OfflineWorkspace,
  WorkspaceRekeyRefusedError,
  computeLeaseMac,
  type AuthorizeOptions,
  type LeaseState,
  type UnlockFailureReason,
  type UnlockResult,
  type WorkspaceIdentity,
  type WorkspaceOptions,
} from './workspace.ts';
export * from './lease-claim.ts';
export * from './queue.ts';
export * from './connectivity.ts';
