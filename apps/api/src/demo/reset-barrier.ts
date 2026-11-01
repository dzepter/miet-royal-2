import pg from 'pg';
import { DEMO_MESSAGES, DemoError } from './types.ts';

/**
 * Phase 14 Final (Order §1–§5, Design A): verteilte Reset-Barrier der Demo-
 * Umgebung. Die Race-Sicherheit zwischen einem Demo-Reset und laufenden
 * Business-Mutationen (API-Requests, Jobhandler) beruht AUSSCHLIESSLICH auf
 * dieser Barrier – nicht auf Zeitfenstern:
 *
 * - Jede Business-Mutation (API: `isDemoGatedRequest`; Jobs: alle Typen außer
 *   `system.heartbeat`) hält über ihre GESAMTE Laufzeit einen SHARED Session-
 *   Advisory-Lock `pg_advisory_lock_shared(hashtext('demo-business-reset-barrier'))`.
 * - Der Reset hält zwischen Phase A (Flag committet) und dem Ende von Phase D
 *   den EXCLUSIVE Lock `pg_advisory_lock(hashtext(…))`. Er wartet damit, bis
 *   ALLE laufenden Shared-Inhaber beendet sind – über alle API-/Worker-
 *   Prozesse und Replikate hinweg (Session-Locks wirken DB-weit).
 * - Shared-Locks werden nur mit `pg_try_advisory_lock_shared` erworben:
 *   PostgreSQL meldet „nicht verfügbar“, sobald der Exclusive gehalten wird
 *   ODER ein Exclusive-Antrag wartet (Konflikt mit `waitMask`) – neue
 *   Mutationen werden also sofort mit 503/Defer abgewiesen, statt den
 *   gesamten Reset lang zu blockieren, und der Reset verhungert nie.
 * - Nach dem Erwerb des Shared-Locks prüft der Aufrufer `reset_in_progress`
 *   DIREKT (ohne Cache) auf derselben Verbindung: liest er `false`, lag sein
 *   Lock vor dem Flag-Commit der Phase A und damit vor dem Exclusive-Antrag
 *   des Resets; liest er `true`, gibt er den Lock frei und bricht ab. Es gibt
 *   kein Zeitfenster dazwischen.
 *
 * Alle Locks laufen über einen EIGENEN kleinen Pool (`lockPool`, Default 20
 * Verbindungen), getrennt vom Fach-Pool: eine Mutation hält während des
 * Handlers nie eine Fachverbindung nur für den Lock, und ein Fach-Pool mit
 * `max = 1` kann nicht deadlocken (RB15). Es laufen keine Transaktionen über
 * die Handlerlaufzeit; die Lock-Verbindung ist bis zum Release reserviert.
 * Stirbt ein Prozess, gibt PostgreSQL die Session-Locks mit der Verbindung
 * frei. Scheitert ein Unlock, wird die Verbindung verworfen
 * (`client.release(error)`), was den Lock ebenfalls auflöst.
 */

export const DEMO_RESET_BARRIER_LOCK_KEY = 'demo-business-reset-barrier';
/** Default-Größe des Lock-Pools (gleichzeitige Business-Mutationen je Prozess + Reset). */
export const DEMO_RESET_BARRIER_POOL_MAX = 20;
/** Default-Wartezeit des Resets auf laufende Mutationen; danach Abbruch (fail-closed). */
export const DEMO_RESET_BARRIER_TIMEOUT_MS = 120_000;
/** Wartezeit auf eine freie Lock-Verbindung (Pool ausgelastet) – nie unbegrenzt. */
export const DEMO_RESET_BARRIER_CONNECT_TIMEOUT_MS = 30_000;
/** SQLSTATE lock_not_available (lock_timeout überschritten). */
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03';

export interface DemoResetBarrierLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

/** Gehaltener Barrier-Lock; `release()` ist idempotent und wirft nie. */
export interface BarrierLease {
  readonly mode: 'shared' | 'exclusive';
  readonly released: boolean;
  release(): Promise<void>;
  /**
   * Direkte, ungecachte Abfrage von `demo_dataset_state.reset_in_progress` auf
   * der Lock-Verbindung (Zweitprüfung nach dem Erwerb des Shared-Locks).
   * Nach `release()` nicht mehr aufrufbar (Programmierfehler).
   */
  isResetInProgressUncached(): Promise<boolean>;
}

export interface DemoResetBarrierOptions {
  /** Verbindungs-URL der Demo-Datenbank (eigener Lock-Pool). */
  databaseUrl: string;
  /** Größe des Lock-Pools (Default `DEMO_RESET_BARRIER_POOL_MAX`). */
  lockPoolMax?: number | undefined;
  /** Nur Tests: fertiger Pool statt eigener Erzeugung (wird von `shutdown()` geschlossen). */
  lockPool?: pg.Pool | undefined;
  logger?: DemoResetBarrierLogger | undefined;
}

export interface DemoResetBarrierStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

function errorContext(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: typeof code === 'string' ? code : null,
  };
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === SQLSTATE_LOCK_NOT_AVAILABLE;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class DemoResetBarrier {
  private readonly pool: pg.Pool;
  private readonly logger: DemoResetBarrierLogger | undefined;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: DemoResetBarrierOptions) {
    this.logger = options.logger;
    this.pool =
      options.lockPool ??
      new pg.Pool({
        connectionString: options.databaseUrl,
        max: Math.max(2, Math.floor(options.lockPoolMax ?? DEMO_RESET_BARRIER_POOL_MAX)),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: DEMO_RESET_BARRIER_CONNECT_TIMEOUT_MS,
      });
    // Eine sterbende Idle-Verbindung darf den Prozess nie beenden (wie createPool).
    this.pool.on('error', (error) => {
      this.logger?.warn(
        errorContext(error),
        'Demo-Reset-Barrier: Idle-Lock-Verbindung verloren – Pool verbindet bei Bedarf neu',
      );
    });
  }

  /** Pool der Lock-Verbindungen (z. B. für den Lauf-Lock des Resets). */
  get lockPool(): pg.Pool {
    return this.pool;
  }

  /** Zähler des Lock-Pools (RB14: nach Abschluss aller Vorgänge totalCount === idleCount). */
  stats(): DemoResetBarrierStats {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Shared-Lock OHNE Warten: `null`, wenn der Reset den Exclusive hält oder
   * darauf wartet (Business-Mutation ⇒ 503 bzw. Job-Defer).
   */
  async tryAcquireShared(): Promise<BarrierLease | null> {
    const client = await this.pool.connect();
    let locked: boolean;
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock_shared(hashtext($1)) AS locked',
        [DEMO_RESET_BARRIER_LOCK_KEY],
      );
      locked = result.rows[0]?.locked === true;
    } catch (error) {
      client.release(toError(error));
      throw error;
    }
    if (!locked) {
      client.release();
      return null;
    }
    return this.leaseOf(client, 'shared');
  }

  /**
   * Shared-Lock MIT Warten (hinter einem wartenden Exclusive eingereiht) – für
   * Aufrufer, die lieber auf das Ende eines Resets warten als abzubrechen.
   */
  async acquireShared(): Promise<BarrierLease> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [
        DEMO_RESET_BARRIER_LOCK_KEY,
      ]);
    } catch (error) {
      client.release(toError(error));
      throw error;
    }
    return this.leaseOf(client, 'shared');
  }

  /**
   * Exclusive-Lock des Resets: wartet, bis alle Shared-Inhaber beendet sind.
   * `timeoutMs` (Default `DEMO_RESET_BARRIER_TIMEOUT_MS`) begrenzt das Warten
   * über `SET LOCAL lock_timeout` in einer kurzen Transaktion (der Session-
   * Lock bleibt nach COMMIT bestehen); Ablauf ⇒
   * `DemoError('CONFLICT','DEMO_RESET_BARRIER_TIMEOUT')`, kein Lock gehalten.
   */
  async acquireExclusive(options: { timeoutMs?: number | undefined } = {}): Promise<BarrierLease> {
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? DEMO_RESET_BARRIER_TIMEOUT_MS));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        // Parameter in SET sind nicht bindbar; der Wert ist eine geprüfte Ganzzahl.
        await client.query(`SET LOCAL lock_timeout = ${timeoutMs}`);
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [DEMO_RESET_BARRIER_LOCK_KEY]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (isLockTimeout(error)) {
        // Transaktion ist zurückgerollt, kein Lock gehalten – Verbindung bleibt brauchbar.
        client.release();
        throw new DemoError(
          'CONFLICT',
          'DEMO_RESET_BARRIER_TIMEOUT',
          DEMO_MESSAGES.DEMO_RESET_BARRIER_TIMEOUT,
          { timeoutMs },
        );
      }
      client.release(toError(error));
      throw error;
    }
    return this.leaseOf(client, 'exclusive');
  }

  /** Direkte Abfrage des Flags über eine kurz entliehene Lock-Pool-Verbindung (kein Cache). */
  async isResetInProgressUncached(): Promise<boolean> {
    const result = await this.pool.query<{ reset_in_progress: boolean }>(
      'SELECT reset_in_progress FROM demo_dataset_state WHERE id = 1',
    );
    return result.rows[0]?.reset_in_progress === true;
  }

  /** Lock-Pool schließen (app.onClose / Worker-Shutdown); idempotent. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.pool.end().catch((error: unknown) => {
        this.logger?.warn(errorContext(error), 'Demo-Reset-Barrier: Lock-Pool-Ende fehlgeschlagen');
      });
    }
    return this.shutdownPromise;
  }

  private leaseOf(client: pg.PoolClient, mode: 'shared' | 'exclusive'): BarrierLease {
    const unlockSql =
      mode === 'shared'
        ? 'SELECT pg_advisory_unlock_shared(hashtext($1)) AS unlocked'
        : 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked';
    let released = false;
    let releasing: Promise<void> | null = null;
    const logger = this.logger;
    const release = async (): Promise<void> => {
      try {
        const result = await client.query<{ unlocked: boolean }>(unlockSql, [
          DEMO_RESET_BARRIER_LOCK_KEY,
        ]);
        if (result.rows[0]?.unlocked !== true) {
          // Darf nicht vorkommen (Lock wurde auf dieser Session erworben) – Verbindung verwerfen.
          logger?.warn(
            { mode },
            'Demo-Reset-Barrier: Unlock ohne gehaltenen Lock – Verbindung verworfen',
          );
          client.release(new Error('demo reset barrier: unlock without held lock'));
          return;
        }
        client.release();
      } catch (error) {
        // Verbindung verwerfen ⇒ PostgreSQL gibt den Session-Lock frei.
        logger?.warn(
          { mode, ...errorContext(error) },
          'Demo-Reset-Barrier: Unlock fehlgeschlagen – Verbindung verworfen',
        );
        client.release(toError(error));
      }
    };
    return {
      mode,
      get released() {
        return released;
      },
      release: () => {
        if (releasing === null) {
          released = true;
          releasing = release();
        }
        return releasing;
      },
      isResetInProgressUncached: async () => {
        if (released) {
          throw new Error('DemoResetBarrier: Lease bereits freigegeben');
        }
        const result = await client.query<{ reset_in_progress: boolean }>(
          'SELECT reset_in_progress FROM demo_dataset_state WHERE id = 1',
        );
        return result.rows[0]?.reset_in_progress === true;
      },
    };
  }
}
