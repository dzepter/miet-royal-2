import type { Database } from '@mietroyal/database';
import {
  PostgresIntegrationRateLimiter,
  defaultRateLimitSleep,
} from '../integrations/rate-limiter.ts';

/**
 * Gemeinsamer Lexware-Rate-Limiter für API UND Worker (Order §11): Lexware
 * erlaubt 2 Requests/Sekunde pro Client. Phase 13 Final (§1.1): die Drossel
 * ist eine dünne Hülle um den generischen `PostgresIntegrationRateLimiter`
 * (Zeile provider = 'lexware' in `integration_rate_limits`, bisher
 * `lexware_rate_limit`): `reserveSlot()` reserviert in einer KURZEN
 * Transaktion (FOR UPDATE) den nächsten Slot (≥ 500 ms Abstand) und beendet
 * die Transaktion sofort; gewartet wird außerhalb jeder Transaktion. Mehrere
 * Prozesse teilen sich so logisch dieselbe Grenze. Kein Sleep unter
 * gehaltener Business-Sperre. Lexware setzt selbst keine globalen Pausen
 * (Retry-After behandelt der Client); eine dennoch gesetzte Pause wird wie
 * Wartezeit behandelt – nie als Fehler.
 */
export const LEXWARE_MIN_SLOT_INTERVAL_MS = 500;
export const LEXWARE_RATE_LIMIT_PROVIDER = 'lexware';

export interface LexwareThrottle {
  /** Wartet (außerhalb von Transaktionen), bis der reservierte Slot erreicht ist. */
  acquire(): Promise<void>;
}

export interface PostgresLexwareThrottleOptions {
  /** APP_ENV des Prozesses (informativ in der Limiter-Zeile). */
  environment: string;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PostgresLexwareThrottle implements LexwareThrottle {
  private readonly limiter: PostgresIntegrationRateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(db: Database, options: PostgresLexwareThrottleOptions) {
    this.sleep = options.sleep ?? defaultRateLimitSleep;
    this.limiter = new PostgresIntegrationRateLimiter(db, {
      provider: LEXWARE_RATE_LIMIT_PROVIDER,
      environment: options.environment,
      intervalMs: options.intervalMs ?? LEXWARE_MIN_SLOT_INTERVAL_MS,
      sleep: this.sleep,
    });
  }

  /**
   * Reserviert den nächsten Slot und gibt die Wartezeit in ms zurück (0 = sofort).
   * Bei einer (für Lexware nicht vorgesehenen) globalen Pause: Rest der Pause,
   * ohne Reservierung.
   */
  async reserveSlot(): Promise<number> {
    const reserved = await this.limiter.reserveSlot();
    return reserved.paused === null ? reserved.waitMs : reserved.paused.remainingMs;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const result = await this.limiter.acquire();
      if (result.paused === null) return;
      // Pause abwarten (außerhalb jeder Transaktion) und erneut reservieren.
      await this.sleep(Math.max(1, result.paused.remainingMs));
    }
  }
}

/** Für Unit-Tests/Fake: kein gemeinsamer Zustand, keine Wartezeit. */
export class NoopLexwareThrottle implements LexwareThrottle {
  async acquire(): Promise<void> {
    // bewusst leer
  }
}
