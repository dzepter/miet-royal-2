/**
 * Phase 10 – gemeinsamer Rate-Limiter in PostgreSQL (Order §11; Pflichttests
 * 15–17): Slots mit ≥ 500 ms Abstand, zwei Prozesse teilen den Zustand,
 * während der Wartezeit ist KEINE Transaktion/Verbindung belegt.
 */
import { createDb, createPool } from '@mietroyal/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEXWARE_MIN_SLOT_INTERVAL_MS,
  PostgresLexwareThrottle,
} from '../src/lexware/rate-limiter.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE lexware_rate_limit');
});

describe('PostgresLexwareThrottle (§11)', () => {
  it('15. Fünf parallele Reservierungen erhalten Slots mit mindestens 500 ms Abstand', async () => {
    const throttle = new PostgresLexwareThrottle(ctx.db);
    const started = Date.now();
    const waits = await Promise.all(Array.from({ length: 5 }, () => throttle.reserveSlot()));
    const elapsed = Date.now() - started;
    const sorted = [...waits].sort((a, b) => a - b);
    // Erster Slot sofort, danach je ≥ 500 ms später. Die Wartezeiten sind
    // relativ zum jeweiligen Tx-Zeitpunkt, daher Toleranz = Gesamtlaufzeit.
    expect(sorted[0]).toBeLessThan(100);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(
        LEXWARE_MIN_SLOT_INTERVAL_MS - elapsed,
      );
    }
    // Absoluter Beleg: der nächste freie Slot liegt ≥ 5 × 500 ms nach dem Start.
    const row = await ctx.pool.query<{ ms: string }>(
      `SELECT (EXTRACT(EPOCH FROM next_slot_at) * 1000)::bigint::text AS ms FROM lexware_rate_limit WHERE id = 1`,
    );
    expect(Number(row.rows[0]!.ms)).toBeGreaterThanOrEqual(
      started + 5 * LEXWARE_MIN_SLOT_INTERVAL_MS - 50,
    );
    // Die Reservierung selbst wartet nicht (nur acquire() schläft).
    expect(elapsed).toBeLessThan(LEXWARE_MIN_SLOT_INTERVAL_MS);
  });

  it('16. Zwei Throttle-Instanzen auf getrennten Pools („zwei Prozesse“) teilen dieselbe Grenze', async () => {
    const poolB = createPool(ctx.config.databaseUrl, { max: 2 });
    try {
      const a = new PostgresLexwareThrottle(ctx.db);
      const b = new PostgresLexwareThrottle(createDb(poolB));
      const first = await a.reserveSlot();
      const second = await b.reserveSlot();
      const third = await a.reserveSlot();
      expect(first).toBeLessThan(100);
      expect(second).toBeGreaterThanOrEqual(LEXWARE_MIN_SLOT_INTERVAL_MS - 50);
      expect(third).toBeGreaterThanOrEqual(2 * LEXWARE_MIN_SLOT_INTERVAL_MS - 100);
    } finally {
      await poolB.end();
    }
  });

  it('17. Während der Wartezeit ist keine Transaktion offen und keine Verbindung belegt', async () => {
    // Pool mit genau EINER Verbindung: hielte acquire() eine Transaktion
    // während des Wartens, würde die parallele Abfrage bis zum Ende warten.
    const single = createPool(ctx.config.databaseUrl, { max: 1 });
    try {
      const throttle = new PostgresLexwareThrottle(createDb(single));
      await throttle.reserveSlot(); // Slot 1 sofort
      await throttle.reserveSlot(); // Slot 2 in ≥ 500 ms
      const acquiring = throttle.acquire(); // Slot 3: wartet ≈ 1000 ms
      await new Promise((resolve) => setTimeout(resolve, 50));
      const probeStart = Date.now();
      const idleInTx = await single.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'idle in transaction'`,
      );
      const probeMs = Date.now() - probeStart;
      expect(probeMs).toBeLessThan(300);
      expect(idleInTx.rows[0].n).toBe(0);
      const waitedStart = Date.now();
      await acquiring;
      expect(Date.now() - waitedStart).toBeGreaterThanOrEqual(400);
    } finally {
      await single.end();
    }
  });

  it('acquire() schläft außerhalb der Transaktion genau die reservierte Zeit', async () => {
    const sleeps: number[] = [];
    const throttle = new PostgresLexwareThrottle(ctx.db, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await throttle.acquire();
    await throttle.acquire();
    await throttle.acquire();
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(LEXWARE_MIN_SLOT_INTERVAL_MS - 50);
    expect(sleeps[1]).toBeGreaterThanOrEqual(2 * LEXWARE_MIN_SLOT_INTERVAL_MS - 100);
  });
});
