import { lexwareRateLimit, type Database } from '@mietroyal/database';
import { sql } from 'drizzle-orm';

/**
 * Gemeinsamer Lexware-Rate-Limiter für API UND Worker (Order §11): Lexware
 * erlaubt 2 Requests/Sekunde pro Client. Eine einzige Zeile in
 * `lexware_rate_limit` trägt den frühesten Zeitpunkt des nächsten Requests.
 * `reserveSlot()` reserviert in einer KURZEN Transaktion (FOR UPDATE) den
 * nächsten Slot (≥ 500 ms Abstand) und beendet die Transaktion sofort;
 * gewartet wird außerhalb jeder Transaktion. Mehrere Prozesse teilen sich so
 * logisch dieselbe Grenze. Kein Sleep unter gehaltener Business-Sperre.
 */
export const LEXWARE_MIN_SLOT_INTERVAL_MS = 500;

export interface LexwareThrottle {
  /** Wartet (außerhalb von Transaktionen), bis der reservierte Slot erreicht ist. */
  acquire(): Promise<void>;
}

export class PostgresLexwareThrottle implements LexwareThrottle {
  constructor(
    private readonly db: Database,
    private readonly options: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  /** Reserviert den nächsten Slot und gibt die Wartezeit in ms zurück (0 = sofort). */
  async reserveSlot(): Promise<number> {
    const interval = this.options.intervalMs ?? LEXWARE_MIN_SLOT_INTERVAL_MS;
    return this.db.transaction(async (tx) => {
      await tx
        .insert(lexwareRateLimit)
        .values({ id: 1, nextSlotAt: new Date(0) })
        .onConflictDoNothing({ target: lexwareRateLimit.id });
      const rows = await tx
        .select({
          nextSlotAt: lexwareRateLimit.nextSlotAt,
          now: sql<Date>`now()`,
        })
        .from(lexwareRateLimit)
        .where(sql`${lexwareRateLimit.id} = 1`)
        .for('update');
      const row = rows[0];
      if (row === undefined) throw new Error('lexware_rate_limit: Zeile fehlt');
      const nowMs = new Date(row.now).getTime();
      const slotMs = Math.max(nowMs, new Date(row.nextSlotAt).getTime());
      await tx
        .update(lexwareRateLimit)
        .set({ nextSlotAt: new Date(slotMs + interval) })
        .where(sql`${lexwareRateLimit.id} = 1`);
      return Math.max(0, slotMs - nowMs);
    });
  }

  async acquire(): Promise<void> {
    const waitMs = await this.reserveSlot();
    if (waitMs > 0) await (this.options.sleep ?? defaultSleep)(waitMs);
  }
}

/** Für Unit-Tests/Fake: kein gemeinsamer Zustand, keine Wartezeit. */
export class NoopLexwareThrottle implements LexwareThrottle {
  async acquire(): Promise<void> {
    // bewusst leer
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
