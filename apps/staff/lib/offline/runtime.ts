'use client';

import {
  ConnectivityEpoch,
  LeaseInvalidError,
  OFFLINE_LEASE_MAX_MS,
  OFFLINE_MIGRATIONS,
  OFFLINE_SCHEMA_VERSION,
  OfflineDb,
  OfflineStore,
  OfflineWorkspace,
  SyncEngine,
  offlineDbName,
  openOfflineDatabase,
  sha256Hex,
  type ConflictDetails,
  type ContextKind,
  type LeaseGrant,
  type LeaseState,
  type MediaPurpose,
  type MutationSummary,
  type OfflineBookingSnapshot,
  type OfflineMachineSnapshot,
  type OfflineMutationType,
  type OfflinePackage,
  type UnlockResult,
} from '@mietroyal/offline';
import type { HandoverDetail } from '../handover';
import type { ReturnDetail } from '../returns';
import {
  deviceId,
  readOfflineIdentity,
  writeOfflineIdentity,
  type OfflineIdentity,
} from './device';
import type { LocalMutation, LocalSnapshot } from './projection';
import { createSyncTransport } from './transport';

/**
 * Offline-Laufzeit der Staff-PWA (Phase-8-Order §§5–9, 30, 36–44, 77/78):
 * EIN Singleton je Tab, das den verschlüsselten Arbeitsbereich (IndexedDB je
 * Benutzer × Umgebung), Schlüssel/Lease, Arbeitspaket, Mutations-Queue und
 * Konnektivität kapselt. React-Komponenten sprechen nie direkt mit IndexedDB,
 * sondern über diese Laufzeit (Provider) bzw. den Offline-Router in apiFetch.
 */
export interface OfflineRuntimeState {
  initialized: boolean;
  identity: OfflineIdentity | null;
  /** Nur über den authentifizierten Health-Check beurteilt (§78). */
  connectivity: 'unknown' | 'online' | 'offline';
  unlocked: boolean;
  /** Offene Arbeit: pending + syncing + failed_retryable (nie Konflikte). */
  pending: number;
  /** Prüfung erforderlich: conflict + failed_permanent. */
  conflicts: number;
  syncing: boolean;
  lastSyncAt: string | null;
  lastPackageAt: string | null;
  lease: LeaseState | null;
  /** Ablauf der lokalen Lease (Klartext-Metadatum des Arbeitsbereichs). */
  leaseExpiresAt: string | null;
  permissions: string[];
  /** Hinweis bei knappem Speicher (§43) – null = keine Warnung. */
  storageWarning: string | null;
  /** Neue App-Version wartet (§72). */
  updateAvailable: boolean;
}

export interface PackagePayload {
  permissions: string[];
  inventory: OfflinePackage['inventory'];
  user: OfflinePackage['user'];
  lease: OfflinePackage['lease'];
  truncated: boolean;
  horizonFrom: string;
  horizonTo: string;
}

/** Nach jedem erfolgreichen Paketabruf (Provider cacht dann die Seiten-Shells vor). */
export const PACKAGE_REFRESHED_EVENT = 'mr-package-refreshed';
/** Session serverseitig ungültig/widerrufen (Provider → mr-unauthenticated → AuthGuard). */
export const OFFLINE_SESSION_INVALID_EVENT = 'mr-offline-session-invalid';

const STATUS_TIMEOUT_MS = 6_000;

interface ConnectivityResult {
  online: boolean;
  appLocked: boolean;
  unauthenticated: boolean;
}

export type AuthorizeOutcome =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'network' | 'rejected' | 'locked' | 'rekey_refused' };

/** Lokale Offline-Entsperrung: nach so vielen Fehlversuchen nur noch online (gestohlenes Gerät). */
const OFFLINE_UNLOCK_MAX_ATTEMPTS = 5;
const META_UNLOCK_FAILURES = 'unlock.failures';
/**
 * Monotone Uhr (Phase-8-Finalisierung, präzisierte Regel): `clock.serverMs` ist die
 * höchste je gesehene Serverzeit, `clock.maxSeenMs` die Untergrenze für `now()`.
 * Serverzeit aktualisiert beide. Lokale Zeit wird nur übernommen, wenn schon eine
 * Serverzeit bekannt ist, und höchstens bis `serverMs + 72 h`: eine zurückgestellte
 * Uhr verlängert kein Lease (Ablauf bleibt erkannt), eine grob vorgehende Uhr sperrt
 * das Gerät höchstens bis zum Ende der maximalen Lease-Laufzeit – eine neue Online-
 * Autorisierung (expiresAt = Server-Jetzt + 72 h > maxSeen) öffnet wieder.
 */
const META_CLOCK_SERVER = 'clock.serverMs';
const META_CLOCK_MAX_SEEN = 'clock.maxSeenMs';
const CONNECTIVITY_INTERVAL_MS = 60_000;
/** Aktivitätsmeldung an den Service Worker höchstens alle 30 s. */
const KEY_TOUCH_THROTTLE_MS = 30_000;
const SW_KEY_TIMEOUT_MS = 1_500;
/** Speicherwarnung ab 90 % Auslastung bzw. unter 50 MB freiem Platz. */
const STORAGE_WARN_RATIO = 0.9;
const STORAGE_WARN_MIN_FREE = 50 * 1024 * 1024;
/** Synchronisierte Mutationen/Medien erst nach dieser Frist bereinigen (§36). */
const CLEANUP_DELAY_MS = 60 * 60 * 1000;

/**
 * Flüchtige Schlüsselübergabe (§7/§38): Der entsperrte DEK liegt nur im
 * Arbeitsspeicher der Seite und – als structured-clone – im Speicher des
 * Service Workers, damit eine harte Navigation/ein Reload offline nicht
 * sofort das Passwort erneut verlangt. Nie in Storage/Cache/IndexedDB.
 */
function serviceWorkerController(): ServiceWorker | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.controller;
}

function serviceWorkerPost(message: { type: string; key?: CryptoKey }): void {
  const controller = serviceWorkerController();
  if (controller === null) return;
  try {
    controller.postMessage(message);
  } catch {
    // Nicht klonbar/kein Worker: dann gilt schlicht die Passwort-Entsperrung.
  }
}

async function serviceWorkerKey(): Promise<CryptoKey | null> {
  const controller = serviceWorkerController();
  if (controller === null) return null;
  return new Promise<CryptoKey | null>((resolve) => {
    const channel = new MessageChannel();
    const finish = (key: CryptoKey | null) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(key);
    };
    const timer = setTimeout(() => finish(null), SW_KEY_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<{ key?: unknown }>) => {
      const key = event.data?.key;
      finish(key instanceof CryptoKey ? key : null);
    };
    try {
      controller.postMessage({ type: 'GET_KEY' }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/** Standard-Base64 (Dokumente/Uploads der bestehenden Wizards) → Bytes. */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Optional gepinnter Ed25519-Verifikationsschlüssel des Servers (öffentlich, kein
 * Secret; zur Build-Zeit eingebettet). Ungesetzt gilt der im Lease-Grant gelieferte
 * Schlüssel – siehe docs/TECH_DECISIONS.md (Client-Lease-Verifikation).
 */
function trustedLeaseVerificationKey(): string | null {
  // Bevorzugt aus der Staff-Server-Umgebung (STAFF_OFFLINE_LEASE_VERIFICATION_KEY → Meta-Tag im
  // Layout, zur Laufzeit je Umgebung), sonst zur Build-Zeit eingebettet.
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="mr-offline-lease-key"]');
    const content = meta?.getAttribute('content')?.trim() ?? '';
    if (content !== '') return content;
  }
  const value = process.env.NEXT_PUBLIC_OFFLINE_LEASE_VERIFICATION_KEY;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** In staging/production gilt eine Lease nur gegen den hinterlegten Serverschlüssel (fail-closed). */
function leasePinningRequired(environment: string): boolean {
  return environment === 'production' || environment === 'staging';
}

type Listener = (state: OfflineRuntimeState) => void;

export interface LocalMutationRow extends LocalMutation {
  seq: number;
  contextKind: ContextKind;
  contextId: string;
  summary: MutationSummary;
  lastErrorCode: string | null;
  retryCount: number;
  nextAttemptAt: string | null;
  /** JSON-Basisstand (§33) – Client-Fallback der Konfliktdarstellung (z. B. Termin-ID). */
  baseVersion: string | null;
}

export interface ConflictView {
  code: string;
  status: 'conflict' | 'rejected';
  processedAt: string;
  message: string;
  serverState: unknown;
  /** Fachliche Gegenüberstellung des Servers (§4) – null, wenn nicht geliefert. */
  details: ConflictDetails | null;
}

/** Zähler für die Logout-Warnung (§38): offene/zu prüfende Erfassungen und nicht hochgeladene Medien. */
export interface PendingSummary {
  mutations: number;
  media: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class OfflineRuntime {
  private db: OfflineDb | null = null;
  private store: OfflineStore | null = null;
  private workspace: OfflineWorkspace | null = null;
  private engine: SyncEngine | null = null;
  private listeners = new Set<Listener>();
  private connectivityTimer: number | null = null;
  private monitorBound = false;
  private lastKeyTouchAt = 0;
  private persistenceRequested = false;
  private initPromise: { key: string; promise: Promise<void> } | null = null;
  private packageRefresh: Promise<boolean> | null = null;
  private connectivityCheck: { epoch: number; promise: Promise<ConnectivityResult> } | null = null;
  /** Offline-Übergänge zählen: späte Antworten älterer Prüfungen melden kein „online“ mehr. */
  private readonly connectivityEpoch = new ConnectivityEpoch();
  private clockMaxSeenMs = 0;
  private clockServerMs = 0;
  private syncRequested = false;
  private state: OfflineRuntimeState = {
    initialized: false,
    identity: null,
    connectivity: 'unknown',
    unlocked: false,
    pending: 0,
    conflicts: 0,
    syncing: false,
    lastSyncAt: null,
    lastPackageAt: null,
    lease: null,
    leaseExpiresAt: null,
    permissions: [],
    storageWarning: null,
    updateAvailable: false,
  };

  get snapshot(): OfflineRuntimeState {
    return this.state;
  }

  /** IndexedDB + WebCrypto vorhanden (sonst läuft die App rein online). */
  get available(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof indexedDB !== 'undefined' &&
      typeof crypto !== 'undefined' &&
      crypto.subtle !== undefined
    );
  }

  get identity(): OfflineIdentity | null {
    return this.state.identity;
  }

  get unlocked(): boolean {
    return this.workspace?.unlocked === true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<OfflineRuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  setUpdateAvailable(updateAvailable: boolean): void {
    this.emit({ updateAvailable });
  }

  // ── Arbeitsbereich (§§5, 77) ─────────────────────────────────────────────

  /** Arbeitsbereich für Benutzer × Umgebung öffnen (Datenbank je Namespace, §77). */
  async init(identity: OfflineIdentity): Promise<void> {
    if (!this.available) return;
    const key = `${identity.environment}:${identity.userId}`;
    if (
      this.state.initialized &&
      this.state.identity?.userId === identity.userId &&
      this.state.identity.environment === identity.environment
    ) {
      return;
    }
    // Gleichzeitige Initialisierungen (Login-Priming + AuthGuard) teilen sich EINE Öffnung.
    if (this.initPromise !== null && this.initPromise.key === key) return this.initPromise.promise;
    const promise = this.openWorkspace(identity).finally(() => {
      if (this.initPromise?.key === key) this.initPromise = null;
    });
    this.initPromise = { key, promise };
    return promise;
  }

  /** Laufende Initialisierung (für den Offline-Router: erst abwarten, dann entscheiden). */
  initInFlight(): Promise<void> | null {
    return this.initPromise?.promise ?? null;
  }

  private async openWorkspace(identity: OfflineIdentity): Promise<void> {
    this.close();
    const raw = await openOfflineDatabase(
      offlineDbName(identity.environment, identity.userId),
      OFFLINE_SCHEMA_VERSION,
      OFFLINE_MIGRATIONS,
    );
    this.db = new OfflineDb(raw);
    this.store = new OfflineStore(this.db);
    this.workspace = new OfflineWorkspace(
      this.store,
      {
        userId: identity.userId,
        environment: identity.environment,
        deviceId: deviceId(),
      },
      // Monotone Zeit: Lease-Ablauf gegen die höchste je gesehene Zeit prüfen (§103).
      () => new Date(Math.max(Date.now(), this.clockMaxSeenMs)),
      {
        trustedVerificationKey: trustedLeaseVerificationKey(),
        requireTrustedKey: leasePinningRequired(identity.environment),
      },
    );
    const seen = await this.store.getMeta(META_CLOCK_MAX_SEEN);
    const server = await this.store.getMeta(META_CLOCK_SERVER);
    this.clockMaxSeenMs = typeof seen === 'number' ? seen : 0;
    this.clockServerMs = typeof server === 'number' ? server : 0;
    await this.noteClock(Date.now(), 'local');
    this.engine = new SyncEngine(
      this.store,
      createSyncTransport({ deviceId: deviceId(), environment: identity.environment }),
      { cleanupDelayMs: CLEANUP_DELAY_MS },
    );
    writeOfflineIdentity(identity);
    this.emit({ initialized: true, identity, unlocked: false });
    await this.refreshCounts();
    this.bindMonitor();
    // Flüchtiger Schlüssel aus dem Service Worker (nach Reload/harter Navigation):
    // wird nur übernommen, wenn die Lease-MAC mit genau diesem Schlüssel stimmt.
    const volatile = await serviceWorkerKey();
    if (volatile !== null && this.workspace !== null) {
      const result = await this.workspace.unlockWithKey(volatile);
      if (result.ok) await this.afterUnlock();
      else serviceWorkerPost({ type: 'CLEAR_KEY' });
    }
  }

  close(): void {
    this.workspace?.lock();
    this.db?.close();
    this.db = null;
    this.store = null;
    this.workspace = null;
    this.engine = null;
    this.emit({ initialized: false, unlocked: false, lease: null, leaseExpiresAt: null });
  }

  // ── Konnektivität (§78) ─────────────────────────────────────────────────

  private bindMonitor(): void {
    if (this.monitorBound || typeof window === 'undefined') return;
    this.monitorBound = true;
    window.addEventListener('online', () => void this.checkConnectivity(true));
    window.addEventListener('offline', () => {
      this.connectivityEpoch.bump();
      this.emit({ connectivity: 'offline' });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.checkConnectivity(true);
    });
    this.connectivityTimer = window.setInterval(() => {
      void this.noteClock(Date.now(), 'local');
      void this.checkConnectivity(false);
    }, CONNECTIVITY_INTERVAL_MS);
  }

  /**
   * Echte Erreichbarkeit über den authentifizierten Statusendpunkt (verlängert
   * die Aktivität NICHT). navigator.onLine ist nur ein Hinweis.
   */
  async checkConnectivity(triggerSync = false): Promise<ConnectivityResult> {
    // Gleichzeitige Prüfungen (Provider, Offline-Router, Timer) teilen sich EINEN Aufruf –
    // außer die laufende Prüfung stammt aus einer Epoche vor dem letzten Offline-Übergang:
    // deren Ergebnis ist veraltet, ein online-Event braucht eine frische Prüfung.
    const epoch = this.connectivityEpoch.value;
    if (this.connectivityCheck !== null && this.connectivityCheck.epoch === epoch) {
      return this.connectivityCheck.promise;
    }
    const entry = {
      epoch,
      promise: this.runConnectivityCheck(triggerSync, epoch).finally(() => {
        if (this.connectivityCheck === entry) this.connectivityCheck = null;
      }),
    };
    this.connectivityCheck = entry;
    return entry.promise;
  }

  private async runConnectivityCheck(
    triggerSync: boolean,
    epoch: number,
  ): Promise<ConnectivityResult> {
    const offlineResult: ConnectivityResult = {
      online: false,
      appLocked: false,
      unauthenticated: false,
    };
    // Zwischen Start und Auswertung offline gegangen (offline-Event erhöht die Epoche
    // oder der Browser meldet offline)? Dann darf diese Antwort den Zustand nicht mehr
    // auf „online“ setzen und keinen Sync starten. Nur bei navigator.onLine === false
    // wird „offline“ gemeldet – bei bloß überholter Epoche hat das Event das bereits
    // getan, und eine jüngere Prüfung darf nicht nachträglich überschrieben werden.
    const wentOffline = (): boolean => {
      const navigatorOnLine = typeof navigator === 'undefined' ? undefined : navigator.onLine;
      if (!this.connectivityEpoch.isStale(epoch, navigatorOnLine)) return false;
      if (navigatorOnLine === false) this.emit({ connectivity: 'offline' });
      return true;
    };
    if (wentOffline()) return offlineResult;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(
        `/api/staff/offline/status?deviceId=${encodeURIComponent(deviceId())}`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (wentOffline()) return offlineResult;
      const online = response.status < 500;
      const unauthenticated = response.status === 401;
      let appLocked = false;
      if (response.ok) {
        const body = (await response.json()) as { appLocked?: boolean; serverTime?: string };
        appLocked = body.appLocked === true;
        if (typeof body.serverTime === 'string') await this.noteClock(Date.parse(body.serverTime));
      } else if (unauthenticated) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        appLocked = body?.error?.code === 'APP_LOCKED';
      }
      // Auch das Lesen der Antwort und das Persistieren der Serverzeit sind asynchron:
      // erst unmittelbar vor dem Statuswechsel entscheiden, ob die Antwort noch gilt.
      if (wentOffline()) return offlineResult;
      const previous = this.state.connectivity;
      this.emit({ connectivity: online ? 'online' : 'offline' });
      if (unauthenticated && !appLocked) {
        // Session serverseitig widerrufen/abgelaufen: Offline-Arbeitsbereich sofort sperren
        // (§39) – lokale Daten bleiben verschlüsselt erhalten; AuthGuard leitet zur Anmeldung.
        this.lock();
        if (typeof window !== 'undefined')
          window.dispatchEvent(new Event(OFFLINE_SESSION_INVALID_EVENT));
        return { online, appLocked, unauthenticated: true };
      }
      // Verbindung wiederhergestellt (Event ODER 60-s-Prüfung): automatisch synchronisieren (§30/§42).
      if (online && (triggerSync || previous !== 'online') && this.unlocked && !appLocked) {
        void this.sync(false);
      }
      return { online, appLocked, unauthenticated: false };
    } catch {
      // Fehlgeschlagen/abgebrochen: „offline“ nur melden, wenn keine jüngere Prüfung
      // (nach einem Offline→Online-Übergang) den Zustand inzwischen bestimmt.
      if (!wentOffline()) this.emit({ connectivity: 'offline' });
      return offlineResult;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Schlüssel / Lease (§§6–8) ────────────────────────────────────────────

  private requireStore(): OfflineStore {
    if (this.store === null) throw new Error('Offline-Arbeitsbereich nicht initialisiert.');
    return this.store;
  }

  private requireWorkspace(): OfflineWorkspace {
    if (this.workspace === null) throw new Error('Offline-Arbeitsbereich nicht initialisiert.');
    return this.workspace;
  }

  /** Online autorisierte Einrichtung/Erneuerung: Lease vom Server, Schlüssel-Wraps lokal. */
  async authorizeOnline(password: string | null): Promise<boolean> {
    return (await this.authorizeOnlineDetailed(password)).ok;
  }

  /** Wie `authorizeOnline`, mit Grund – der Sperrbildschirm unterscheidet Netz/Rekey. */
  async authorizeOnlineDetailed(password: string | null): Promise<AuthorizeOutcome> {
    const identity = this.state.identity;
    if (identity === null || this.workspace === null) return { ok: false, reason: 'unavailable' };
    if (!this.unlocked && password !== null && (await this.workspace.record()) !== undefined) {
      // Bestehenden DEK zuerst über das noch gültige Lease-Secret (Wrap B) wiederherstellen –
      // die Lease-Erneuerung unten rotiert das Secret. So bleibt der Schlüssel auch nach einem
      // Passwortwechsel erhalten und Wrap A wird unten mit dem neuen Passwort erneuert.
      await this.unlockSilently();
    }
    let response: Response;
    try {
      response = await fetch('/api/staff/offline/lease', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId(), environment: identity.environment }),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!response.ok) return { ok: false, reason: 'rejected' };
    const grant = (await response.json()) as LeaseGrant;
    await this.noteClock(Date.parse(grant.issuedAt));
    const existing = await this.workspace.record();
    if (!this.unlocked && existing !== undefined && password === null) {
      // Gesperrter, bereits eingerichteter Arbeitsbereich ohne Passwort: NIE still
      // neu verschlüsseln (alte Fachdaten/Pending-Daten würden unlesbar) – die
      // Entsperrung läuft über den Sperrbildschirm (Passwort → Wrap A).
      return { ok: false, reason: 'locked' };
    }
    try {
      await this.workspace.authorizeOnline(grant, password, {
        allowNewDek: existing === undefined || !(await this.hasPendingWork()),
      });
    } catch (error) {
      // Ungültig signierter/fremder/abgelaufener Lease-Claim (§1): nicht übernommen.
      if (error instanceof LeaseInvalidError) return { ok: false, reason: 'rejected' };
      // Schlüssel nicht wiederherstellbar (z. B. geändertes Passwort) bei
      // ausstehenden Daten: keine Neuverschlüsselung, Daten bleiben erhalten.
      return { ok: false, reason: 'rekey_refused' };
    }
    await this.setUnlockFailures(0);
    const named = { ...identity, firstName: grant.firstName, lastName: grant.lastName };
    writeOfflineIdentity(named);
    this.shareKeyVolatile();
    this.emit({
      unlocked: true,
      lease: await this.workspace.leaseState(),
      leaseExpiresAt: grant.expiresAt,
      permissions: grant.permissions,
      identity: named,
    });
    await this.refreshCounts();
    return { ok: true };
  }

  /** Nach Passwortänderung: Wrap A mit dem neuen Passwort erneuern (nur entsperrt). */
  async rewrapPassword(password: string): Promise<void> {
    if (this.workspace === null || !this.unlocked) return;
    try {
      await this.workspace.rewrapWithPassword(password);
    } catch {
      // Ohne Erneuerung greift die nächste Online-Anmeldung (Wrap B → neues Wrap A).
    }
  }

  /**
   * Monotone Uhr festhalten (siehe META_CLOCK_*): Serverzeit (Lease, Paket, Status)
   * aktualisiert `serverMs` und `maxSeen`; lokale Zeit hebt `maxSeen` nur bis
   * `serverMs + 72 h` an und nur, wenn bereits eine Serverzeit bekannt ist.
   */
  async noteClock(ms: number, source: 'server' | 'local' = 'server'): Promise<void> {
    if (!Number.isFinite(ms)) return;
    const persist = async (key: string, value: number) => {
      if (this.store === null) return;
      try {
        await this.store.setMeta(key, value, new Date().toISOString());
      } catch {
        // Meta nicht persistierbar: die In-Memory-Grenze gilt bis zum Neuladen.
      }
    };
    if (source === 'server') {
      if (ms > this.clockServerMs) {
        this.clockServerMs = ms;
        await persist(META_CLOCK_SERVER, ms);
      }
      if (ms > this.clockMaxSeenMs) {
        this.clockMaxSeenMs = ms;
        await persist(META_CLOCK_MAX_SEEN, ms);
      }
      return;
    }
    if (this.clockServerMs <= 0) return;
    const bounded = Math.min(ms, this.clockServerMs + OFFLINE_LEASE_MAX_MS);
    if (bounded <= this.clockMaxSeenMs) return;
    this.clockMaxSeenMs = bounded;
    await persist(META_CLOCK_MAX_SEEN, bounded);
  }

  private async unlockFailures(): Promise<number> {
    const value = await this.store?.getMeta(META_UNLOCK_FAILURES);
    return typeof value === 'number' ? value : 0;
  }

  private async setUnlockFailures(count: number): Promise<void> {
    if (this.store === null) return;
    try {
      await this.store.setMeta(META_UNLOCK_FAILURES, count, new Date().toISOString());
    } catch {
      // Zähler nicht persistierbar – Entsperrung bleibt möglich.
    }
  }

  /** Stille Entsperrung online mit dem Lease-Secret (Reload ohne Passwort). */
  async unlockSilently(): Promise<boolean> {
    const identity = this.state.identity;
    if (identity === null || this.workspace === null) return false;
    if (this.unlocked) return true;
    const record = await this.workspace.record();
    if (record === undefined || record.lease === null) return false;
    let response: Response;
    try {
      response = await fetch(
        `/api/staff/offline/lease/secret?deviceId=${encodeURIComponent(deviceId())}&environment=${encodeURIComponent(identity.environment)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
    } catch {
      return false;
    }
    if (response.status === 404 || response.status === 403) {
      // Lease serverseitig abgelaufen/widerrufen: Wrap B lokal entfernen – ab jetzt öffnet
      // nur noch das Passwort (Wrap A) oder eine neue Online-Autorisierung (§39).
      await this.workspace.invalidateLease();
      this.emit({ lease: null, leaseExpiresAt: null });
      return false;
    }
    if (!response.ok) return false;
    const secret = (await response.json()) as { leaseId: string; leaseSecret: string };
    const result = await this.workspace.unlockWithLeaseSecret(secret.leaseId, secret.leaseSecret);
    if (!result.ok) return false;
    await this.afterUnlock();
    return true;
  }

  /** Lokale Offline-Entsperrung mit dem Passwort (Wrap A, PBKDF2) – ohne Server (§7). */
  async unlockOffline(password: string): Promise<UnlockResult> {
    if (this.workspace === null) return { ok: false, reason: 'no_workspace' } as UnlockResult;
    // Gerätezeit als monotone Untergrenze festhalten (gedeckelt auf Serverzeit + 72 h).
    await this.noteClock(Date.now(), 'local');
    const failures = await this.unlockFailures();
    if (failures >= OFFLINE_UNLOCK_MAX_ATTEMPTS) {
      return { ok: false, reason: 'too_many_attempts' };
    }
    const result = await this.workspace.unlockWithPassword(password);
    if (result.ok) {
      await this.setUnlockFailures(0);
      await this.afterUnlock();
      return result;
    }
    if (result.reason === 'wrong_password') await this.setUnlockFailures(failures + 1);
    return result;
  }

  private async afterUnlock(): Promise<void> {
    const workspace = this.requireWorkspace();
    const record = await workspace.record();
    this.shareKeyVolatile();
    this.emit({
      unlocked: true,
      lease: await workspace.leaseState(),
      leaseExpiresAt: record?.lease?.expiresAt ?? null,
      permissions: record?.lease?.permissions ?? [],
    });
    await this.refreshCounts();
  }

  private shareKeyVolatile(): void {
    const key = this.workspace?.currentKey() ?? null;
    if (key === null) return;
    this.lastKeyTouchAt = Date.now();
    serviceWorkerPost({ type: 'SET_KEY', key });
  }

  /** Nutzeraktivität (AuthGuard): hält den flüchtigen Schlüssel im Service Worker lebendig. */
  touchActivity(): void {
    if (!this.unlocked) return;
    const now = Date.now();
    if (now - this.lastKeyTouchAt < KEY_TOUCH_THROTTLE_MS) return;
    this.lastKeyTouchAt = now;
    serviceWorkerPost({ type: 'TOUCH_KEY' });
  }

  /** Sperren (App-Sperre): Schlüssel aus dem Speicher entfernen – auch im Service Worker. */
  lock(): void {
    this.workspace?.lock();
    serviceWorkerPost({ type: 'CLEAR_KEY' });
    this.emit({ unlocked: false });
  }

  async hasWorkspace(): Promise<boolean> {
    const record = await this.workspace?.record();
    return record !== undefined && record.wrappedByPassword !== null;
  }

  /** Offene oder zu prüfende Mutationen vorhanden (Logout-Warnung, Update-Sperre, Rekey-Schutz). */
  async hasPendingWork(): Promise<boolean> {
    if (this.store === null) return false;
    const counts = await this.store.countByStatus();
    return (
      counts.pending +
        counts.syncing +
        counts.failed_retryable +
        counts.conflict +
        counts.failed_permanent >
      0
    );
  }

  /** Logout-/Verwerfen-Dialog: Erfassungen (pending + Konflikte) und Fotos/Unterschriften, die noch nicht hochgeladen sind. */
  async pendingSummary(): Promise<PendingSummary> {
    if (this.store === null) return { mutations: 0, media: 0 };
    const counts = await this.store.countByStatus();
    return {
      mutations:
        counts.pending +
        counts.syncing +
        counts.failed_retryable +
        counts.conflict +
        counts.failed_permanent,
      media: await this.store.countPendingMedia(),
    };
  }

  async refreshCounts(): Promise<void> {
    if (this.store === null) return;
    const counts = await this.store.countByStatus();
    // Paketstand aus dem Store (Klartext-Metadaten) – nach Reload kein unnötiger Neuabruf.
    const packages = await this.store.listPackageRecords();
    const latest = packages.reduce<string | null>(
      (max, p) => (max === null || p.serverTime > max ? p.serverTime : max),
      null,
    );
    const record = await this.workspace?.record();
    this.emit({
      pending: counts.pending + counts.syncing + counts.failed_retryable,
      conflicts: counts.conflict + counts.failed_permanent,
      lastPackageAt: latest ?? this.state.lastPackageAt,
      leaseExpiresAt: record?.lease?.expiresAt ?? this.state.leaseExpiresAt,
    });
  }

  // ── Arbeitspaket (§§9–12) ────────────────────────────────────────────────

  /**
   * Arbeitspaket vom Server holen und lokal übernehmen. Gleichzeitige Aufrufe
   * (automatisch bei Onlinekontakt + manuell) teilen sich EINEN Abruf: zwei
   * verschränkte Ingests würden sich sonst gegenseitig als „veraltet“ bereinigen.
   */
  refreshPackage(extraBookingIds: string[] = []): Promise<boolean> {
    if (this.packageRefresh !== null) return this.packageRefresh;
    const run = this.refreshPackageNow(extraBookingIds).finally(() => {
      this.packageRefresh = null;
    });
    this.packageRefresh = run;
    return run;
  }

  private async refreshPackageNow(extraBookingIds: string[]): Promise<boolean> {
    const identity = this.state.identity;
    if (identity === null || this.store === null || !this.unlocked) return false;
    let response: Response;
    try {
      response = await fetch('/api/staff/offline/package', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceId(),
          environment: identity.environment,
          extraBookingIds,
          includeDocuments: true,
        }),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const pkg = (await response.json()) as OfflinePackage<HandoverDetail, ReturnDetail>;
    if (pkg.environment !== identity.environment) return false;
    await this.noteClock(Date.parse(pkg.serverTime));
    await this.ingest(pkg);
    await this.requestPersistence();
    await this.checkStorage();
    this.emit({
      lastPackageAt: pkg.serverTime,
      permissions: pkg.permissions,
      leaseExpiresAt: pkg.lease.expiresAt,
    });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PACKAGE_REFRESHED_EVENT));
    return true;
  }

  private async ingest(pkg: OfflinePackage<HandoverDetail, ReturnDetail>): Promise<void> {
    const store = this.requireStore();
    const payload: PackagePayload = {
      permissions: pkg.permissions,
      inventory: pkg.inventory,
      user: pkg.user,
      lease: pkg.lease,
      truncated: pkg.truncated,
      horizonFrom: pkg.horizonFrom,
      horizonTo: pkg.horizonTo,
    };
    await store.putPackage(
      {
        packageId: pkg.packageId,
        environment: pkg.environment,
        createdAt: pkg.serverTime,
        serverTime: pkg.serverTime,
        horizonFrom: pkg.horizonFrom,
        horizonTo: pkg.horizonTo,
        expiresAt: pkg.expiresAt,
        bookingIds: pkg.bookings.map((b) => b.bookingId),
        machineIds: pkg.machines.map((m) => m.machineId),
      },
      payload,
    );
    await store.putBookings(
      pkg.bookings.map((booking) => ({
        record: {
          bookingId: booking.bookingId,
          processId: booking.processId,
          packageId: pkg.packageId,
          relevantDay: booking.days[0] ?? null,
          updatedAt: booking.snapshotAt,
        },
        payload: booking,
      })),
    );
    await store.putMachines(
      pkg.machines.map((machine) => ({
        record: {
          machineId: machine.machineId,
          qrHash: machine.qrHash,
          packageId: pkg.packageId,
          updatedAt: machine.updatedAt,
        },
        payload: machine,
      })),
    );
    for (const document of pkg.documents) {
      if (await store.hasDocument(document.id)) continue;
      await store.putDocument(
        {
          documentId: document.id,
          bookingId: document.bookingId,
          type: document.type,
          byteSize: document.byteSize,
          createdAt: document.createdAt,
          sha256: document.sha256,
        },
        fromBase64(document.dataBase64),
      );
    }
    await this.cleanupStale(pkg.packageId);
  }

  /** Veraltete Snapshots/Maschinen/Dokumente/Pakete ohne Pending-Bezug entfernen (§37). */
  private async cleanupStale(currentPackageId: string): Promise<void> {
    const store = this.requireStore();
    const mutations = await store.listMutationRecords();
    const busy = new Set(
      mutations.filter((m) => m.status !== 'synced').map((m) => `${m.contextKind}:${m.contextId}`),
    );
    const staleBookings = (await store.listBookingRecords())
      .filter((b) => b.packageId !== currentPackageId && !busy.has(`booking:${b.bookingId}`))
      .map((b) => b.bookingId);
    if (staleBookings.length > 0) await store.deleteBookings(staleBookings);
    const keptBookings = new Set((await store.listBookingRecords()).map((b) => b.bookingId));
    const staleDocuments = (await store.listDocumentRecords())
      .filter((d) => !keptBookings.has(d.bookingId))
      .map((d) => d.documentId);
    if (staleDocuments.length > 0) await store.deleteDocuments(staleDocuments);
    const staleMachines = (await store.listMachineRecords())
      .filter((m) => m.packageId !== currentPackageId && !busy.has(`machine:${m.machineId}`))
      .map((m) => m.machineId);
    if (staleMachines.length > 0) await store.deleteMachines(staleMachines);
    const stalePackages = (await store.listPackageRecords())
      .filter((p) => p.packageId !== currentPackageId)
      .map((p) => p.packageId);
    if (stalePackages.length > 0) await store.deletePackages(stalePackages);
  }

  /** Aktuelles Paket (neuester Serverstand) mit entschlüsseltem Payload. */
  private async currentPackage(): Promise<{
    packageId: string;
    serverTime: string;
    payload: PackagePayload;
  } | null> {
    if (this.store === null || !this.unlocked) return null;
    const packages = await this.store.listPackageRecords();
    const latest = packages.reduce<(typeof packages)[number] | null>(
      (max, p) => (max === null || p.serverTime > max.serverTime ? p : max),
      null,
    );
    if (latest === null) return null;
    const record = await this.store.getPackage<PackagePayload>(latest.packageId);
    if (record === null) return null;
    return { packageId: latest.packageId, serverTime: latest.serverTime, payload: record.payload };
  }

  /** Einzelnen Vorgang vom Server neu laden (Konflikt-UI „Serverstand laden“). */
  async refreshBooking(bookingId: string): Promise<boolean> {
    if (this.store === null || !this.unlocked) return false;
    let response: Response;
    try {
      response = await fetch(`/api/staff/offline/bookings/${encodeURIComponent(bookingId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
    const raw = asRecord(body);
    const snapshot = (
      raw !== null && typeof raw.bookingId === 'string' ? raw : (raw?.booking ?? null)
    ) as OfflineBookingSnapshot<HandoverDetail, ReturnDetail> | null;
    if (snapshot === null) return false;
    const existing = (await this.store.listBookingRecords()).find(
      (b) => b.bookingId === snapshot.bookingId,
    );
    const packageId = existing?.packageId ?? (await this.currentPackage())?.packageId ?? 'extra';
    await this.store.putBookings([
      {
        record: {
          bookingId: snapshot.bookingId,
          processId: snapshot.processId,
          packageId,
          relevantDay: snapshot.days[0] ?? null,
          updatedAt: snapshot.snapshotAt,
        },
        payload: snapshot,
      },
    ]);
    return true;
  }

  async findBooking(bookingId: string): Promise<LocalSnapshot | null> {
    if (this.store === null || !this.unlocked) return null;
    return (await this.store.getBooking<LocalSnapshot>(bookingId))?.payload ?? null;
  }

  async findBookingByProcess(processId: string): Promise<LocalSnapshot | null> {
    if (this.store === null || !this.unlocked) return null;
    const rows = await this.store.listBookings<LocalSnapshot>();
    return rows.find((row) => row.processId === processId)?.payload ?? null;
  }

  async listBookings(): Promise<LocalSnapshot[]> {
    if (this.store === null || !this.unlocked) return [];
    return (await this.store.listBookings<LocalSnapshot>()).map((row) => row.payload);
  }

  /** Maschinen-Snapshots des Pakets (nur mit machine.view enthalten), entschlüsselt. */
  async listMachines(): Promise<OfflineMachineSnapshot[]> {
    if (this.store === null || !this.unlocked) return [];
    return (await this.store.listMachines<OfflineMachineSnapshot>()).map((row) => row.payload);
  }

  /** Lager-/Rechte-Metadaten des aktuellen Pakets. */
  async packageInfo(): Promise<PackagePayload | null> {
    return (await this.currentPackage())?.payload ?? null;
  }

  /** QR offline: SHA-256 des (kleingeschriebenen) Tokens gegen den Hash-Index (§28). */
  async findMachineByQrToken(token: string): Promise<OfflineMachineSnapshot | null> {
    if (this.store === null || !this.unlocked) return null;
    const hash = await sha256Hex(token.trim().toLowerCase());
    const hit = await this.store.findMachineByQrHash<OfflineMachineSnapshot>(hash);
    return hit?.payload ?? null;
  }

  // ── Sync (§§30, 36, 42) ──────────────────────────────────────────────────

  async sync(force: boolean): Promise<void> {
    if (this.engine === null || !this.unlocked) return;
    if (this.state.syncing) {
      // Läuft bereits: nach dem Lauf erneut versuchen (neu eingereihte Mutationen, §30/§42).
      this.syncRequested = true;
      return;
    }
    if (this.state.connectivity === 'offline' && !force) return;
    this.emit({ syncing: true });
    try {
      const before = (await this.requireStore().listMutationRecords()).filter(
        (m) => m.status !== 'synced',
      );
      const result = await this.engine.runOnce({ force });
      if (result.sessionInvalid) {
        this.lock();
        this.emit({ syncing: false });
        await this.refreshCounts();
        window.dispatchEvent(new Event(OFFLINE_SESSION_INVALID_EVENT));
        return;
      }
      if (result.applied > 0 || result.conflicts > 0 || result.rejected > 0) {
        const touched = new Set(before.map((m) => `${m.contextKind}:${m.contextId}`));
        for (const key of touched) {
          const [kind, id] = key.split(':') as [ContextKind, string | undefined];
          if (kind === 'booking' && id !== undefined) await this.refreshBooking(id);
        }
        if (result.applied > 0) await this.refreshPackage();
      }
      if (result.transientFailures > 0 && result.applied === 0) {
        await this.checkConnectivity(false);
      }
      await this.engine.cleanupSynced();
      this.emit({ lastSyncAt: new Date().toISOString() });
    } finally {
      this.emit({ syncing: false });
      await this.refreshCounts();
      if (this.syncRequested) {
        this.syncRequested = false;
        void this.sync(false);
      }
    }
  }

  async retry(clientMutationId: string): Promise<void> {
    await this.engine?.retryMutation(clientMutationId);
    await this.refreshCounts();
    if (this.state.connectivity === 'online') void this.sync(false);
  }

  async discard(clientMutationId: string): Promise<string[]> {
    const removed = (await this.engine?.discardMutation(clientMutationId)) ?? [];
    await this.refreshCounts();
    return removed;
  }

  async mutationsForContext(contextKind: ContextKind, contextId: string): Promise<LocalMutation[]> {
    if (this.store === null || !this.unlocked) return [];
    const rows = await this.store.listMutationsForContext(contextKind, contextId);
    const result: LocalMutation[] = [];
    for (const row of rows) {
      const receipt =
        row.status === 'synced' ? await this.store.getReceipt(row.clientMutationId) : undefined;
      result.push({
        clientMutationId: row.clientMutationId,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt,
        syncedAt: receipt?.processedAt ?? null,
        payload: row.payload,
        mediaIds: row.mediaIds,
      });
    }
    return result;
  }

  async listMutations(): Promise<LocalMutationRow[]> {
    if (this.store === null || !this.unlocked) return [];
    const rows = await this.store.listMutations();
    return rows
      .map((row) => ({
        clientMutationId: row.clientMutationId,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt,
        syncedAt: null,
        payload: row.payload,
        mediaIds: row.mediaIds,
        seq: row.seq,
        contextKind: row.contextKind,
        contextId: row.contextId,
        summary: row.summary,
        lastErrorCode: row.lastErrorCode,
        retryCount: row.retryCount,
        nextAttemptAt: row.nextAttemptAt,
        baseVersion: row.baseVersion,
      }))
      .sort((a, b) => a.seq - b.seq);
  }

  /** Konflikt-/Ablehnungsdetails (entschlüsselt) einer Mutation – null ohne Konflikt. */
  async getConflict(clientMutationId: string): Promise<ConflictView | null> {
    if (this.store === null || !this.unlocked) return null;
    const record = await this.store.getConflict(clientMutationId);
    if (record === null) return null;
    return {
      code: record.code,
      status: record.status,
      processedAt: record.processedAt,
      message: record.payload.message ?? '',
      serverState: record.payload.serverState ?? null,
      details: record.payload.details ?? null,
    };
  }

  /** Mutation einreihen (Offline-Router). Liefert die clientMutationId. */
  async enqueue(input: {
    type: OfflineMutationType;
    contextKind: ContextKind;
    contextId: string;
    payload: unknown;
    summary: MutationSummary;
    baseVersion: string | null;
    mediaIds?: string[];
    dependsOn?: string[];
  }): Promise<string> {
    const store = this.requireStore();
    const clientMutationId = crypto.randomUUID();
    await store.enqueueMutation({
      clientMutationId,
      type: input.type,
      contextKind: input.contextKind,
      contextId: input.contextId,
      payload: input.payload,
      summary: input.summary,
      createdAt: new Date().toISOString(),
      dependsOn: input.dependsOn ?? [],
      mediaIds: input.mediaIds ?? [],
      baseVersion: input.baseVersion,
    });
    await this.refreshCounts();
    if (this.state.connectivity === 'online') void this.sync(false);
    return clientMutationId;
  }

  /** Foto/Unterschrift verschlüsselt ablegen (vor der zugehörigen Mutation). */
  async storeMedia(input: {
    purpose: MediaPurpose;
    mimeType: string;
    bytes: Uint8Array;
    contextKind: ContextKind;
    contextId: string;
  }): Promise<{ mediaId: string; sha256: string }> {
    const store = this.requireStore();
    const mediaId = crypto.randomUUID();
    const sha256 = await sha256Hex(input.bytes);
    await store.putMedia({
      mediaId,
      purpose: input.purpose,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256,
      contextKind: input.contextKind,
      contextId: input.contextId,
      createdAt: new Date().toISOString(),
    });
    void this.checkStorage();
    return { mediaId, sha256 };
  }

  async getMediaBytes(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (this.store === null || !this.unlocked) return null;
    const entry = await this.store.getMediaBytes(mediaId);
    return entry === null ? null : { bytes: entry.bytes, mimeType: entry.record.mimeType };
  }

  async hasDocument(documentId: string): Promise<boolean> {
    if (this.store === null) return false;
    return this.store.hasDocument(documentId);
  }

  async getDocumentBytes(documentId: string): Promise<Uint8Array | null> {
    if (this.store === null || !this.unlocked) return null;
    return (await this.store.getDocumentBytes(documentId))?.bytes ?? null;
  }

  // ── Speicher (§§43/44) ───────────────────────────────────────────────────

  private async requestPersistence(): Promise<void> {
    if (this.persistenceRequested) return;
    this.persistenceRequested = true;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist !== undefined) {
        await navigator.storage.persist();
      }
    } catch {
      // Ablehnung ist kein Fehler.
    }
  }

  private async checkStorage(): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return;
    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage ?? 0;
      const quota = estimate.quota ?? 0;
      if (quota <= 0) return;
      const free = quota - usage;
      const warn = usage / quota >= STORAGE_WARN_RATIO || free < STORAGE_WARN_MIN_FREE;
      this.emit({
        storageWarning: warn
          ? `Speicher knapp: noch ca. ${Math.max(0, Math.round(free / (1024 * 1024)))} MB frei – bitte synchronisieren.`
          : null,
      });
    } catch {
      // Keine Abschätzung möglich: keine Warnung.
    }
  }

  // ── Abmelden (§§38/39) ───────────────────────────────────────────────────

  /** Lokale Fachdaten vollständig löschen (Logout ohne Pending, §38). */
  async wipe(): Promise<void> {
    if (this.store !== null) await this.store.wipeAll();
    this.workspace?.lock();
    serviceWorkerPost({ type: 'CLEAR_KEY' });
    serviceWorkerPost({ type: 'CLEAR_PAGES' });
    writeOfflineIdentity(null);
    this.emit({
      unlocked: false,
      pending: 0,
      conflicts: 0,
      lease: null,
      leaseExpiresAt: null,
      permissions: [],
      lastPackageAt: null,
    });
  }

  async revokeLeaseOnline(): Promise<void> {
    const identity = this.state.identity;
    if (identity === null) return;
    try {
      await fetch('/api/staff/offline/lease/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId(), environment: identity.environment }),
      });
    } catch {
      // Offline: Widerruf greift beim nächsten Onlinekontakt/Lease-Ablauf.
    }
  }
}

let singleton: OfflineRuntime | null = null;

export function offlineRuntime(): OfflineRuntime {
  if (singleton === null) singleton = new OfflineRuntime();
  return singleton;
}

export function cachedIdentity(): OfflineIdentity | null {
  return readOfflineIdentity();
}
