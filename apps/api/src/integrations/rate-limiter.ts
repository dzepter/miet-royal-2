import { integrationRateLimits, type Database } from '@mietroyal/database';
import { eq, sql } from 'drizzle-orm';

/**
 * Phase 13 Final (§1): generische, PROZESSÜBERGREIFENDE Drossel für externe
 * Provider (Lexware, GraphHopper) – eine Zeile je Provider in
 * `integration_rate_limits`, geteilt von API, Worker und allen Replikaten
 * einer Umgebung (jede Umgebung hat ihre eigene Datenbank).
 *
 * Ablauf (Auftrag §1.2): `reserveSlot()` sperrt die Zeile in EINER kurzen
 * Transaktion (FOR UPDATE), prüft eine aktive Pause, reserviert sonst den
 * nächsten Slot (≥ intervalMs nach max(now, nextSlotAt)) und committet
 * sofort. Gewartet (`acquire()`) wird AUSSERHALB jeder Transaktion; der
 * HTTP-Request des Aufrufers läuft ebenfalls ohne DB-Sperre. Eine vom
 * Provider verhängte Pause (429 / Credit-Limit) persistiert `pause()`
 * global – alle Prozesse sehen sie beim nächsten Reservieren und scheitern
 * sofort (fail-fast; der Aufrufer entscheidet über den Fehlertyp, der
 * Limiter wirft nie selbst). Eine abgelaufene Pause wird beim Reservieren
 * implizit gelöscht.
 *
 * Zeitautorität ist die Datenbank (`now()`), damit API und Worker mit
 * abweichenden Uhren dieselbe Grenze sehen; `now` lässt sich nur für Tests
 * übersteuern. Es wird NIE ein Key, eine URL oder ein Request-Inhalt
 * gespeichert oder geloggt (G11) – die Zeile kennt nur Provider, Umgebung
 * und Zeitpunkte.
 */

export type RateLimitPauseKind = 'rate_limited' | 'credit_limited';

export interface RateLimitPause {
  until: Date;
  kind: RateLimitPauseKind;
  /** Rest der Pause aus Sicht der Zeitautorität des Limiters (≥ 0). */
  remainingMs: number;
}

export type ReserveSlotResult =
  { waitMs: number; paused: null } | { waitMs: null; paused: RateLimitPause };

export type AcquireResult =
  { waitedMs: number; paused: null } | { waitedMs: null; paused: RateLimitPause };

export interface IntegrationRateLimiter {
  readonly provider: string;
  /**
   * Reserviert den nächsten Slot (kurze Transaktion, keine Wartezeit) oder
   * meldet eine aktive Pause (dann wird NICHTS reserviert).
   */
  reserveSlot(now?: Date): Promise<ReserveSlotResult>;
  /** `reserveSlot` + Warten außerhalb jeder Transaktion; bei Pause kein Warten, kein Fehler. */
  acquire(now?: Date): Promise<AcquireResult>;
  /** Persistiert eine globale Pause – verlängert nur, verkürzt nie (bis `until`). */
  pause(until: Date, kind: RateLimitPauseKind): Promise<void>;
}

export interface PostgresIntegrationRateLimiterOptions {
  provider: string;
  /** APP_ENV des Prozesses – rein informativ in der Zeile. */
  environment: string;
  /** Mindestabstand zwischen zwei Requests dieses Providers (global). */
  intervalMs: number;
  /** Nur Tests: Warten instrumentieren. */
  sleep?: (ms: number) => Promise<void>;
}

export function defaultRateLimitSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PostgresIntegrationRateLimiter implements IntegrationRateLimiter {
  readonly provider: string;
  private readonly environment: string;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: Database,
    options: PostgresIntegrationRateLimiterOptions,
  ) {
    if (options.provider.trim() === '') throw new Error('IntegrationRateLimiter: provider fehlt');
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new Error('IntegrationRateLimiter: intervalMs ungültig');
    }
    this.provider = options.provider;
    this.environment = options.environment;
    this.intervalMs = options.intervalMs;
    this.sleep = options.sleep ?? defaultRateLimitSleep;
  }

  async reserveSlot(now?: Date): Promise<ReserveSlotResult> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(integrationRateLimits)
        .values({ provider: this.provider, environment: this.environment, nextSlotAt: new Date(0) })
        .onConflictDoNothing({ target: integrationRateLimits.provider });
      const rows = await tx
        .select({
          nextSlotAt: integrationRateLimits.nextSlotAt,
          pausedUntil: integrationRateLimits.pausedUntil,
          pauseKind: integrationRateLimits.pauseKind,
          now: sql<Date>`now()`,
        })
        .from(integrationRateLimits)
        .where(eq(integrationRateLimits.provider, this.provider))
        .for('update');
      const row = rows[0];
      if (row === undefined) throw new Error('integration_rate_limits: Zeile fehlt');
      const nowMs = now?.getTime() ?? new Date(row.now).getTime();
      const pausedUntilMs = row.pausedUntil === null ? null : new Date(row.pausedUntil).getTime();
      if (pausedUntilMs !== null && pausedUntilMs > nowMs) {
        // Aktive Pause: keine Reservierung – nur die Umgebung nachziehen (Migration 0028: 'unknown').
        await tx
          .update(integrationRateLimits)
          .set({ environment: this.environment, updatedAt: sql`now()` })
          .where(eq(integrationRateLimits.provider, this.provider));
        return {
          waitMs: null,
          paused: {
            until: new Date(pausedUntilMs),
            kind: row.pauseKind === 'credit_limited' ? 'credit_limited' : 'rate_limited',
            remainingMs: pausedUntilMs - nowMs,
          },
        };
      }
      const slotMs = Math.max(nowMs, new Date(row.nextSlotAt).getTime());
      await tx
        .update(integrationRateLimits)
        .set({
          environment: this.environment,
          nextSlotAt: new Date(slotMs + this.intervalMs),
          // Abgelaufene Pause implizit löschen (Check: beide null oder beide gesetzt).
          pausedUntil: null,
          pauseKind: null,
          updatedAt: sql`now()`,
        })
        .where(eq(integrationRateLimits.provider, this.provider));
      return { waitMs: Math.max(0, slotMs - nowMs), paused: null };
    });
  }

  async acquire(now?: Date): Promise<AcquireResult> {
    const reserved = await this.reserveSlot(now);
    if (reserved.paused !== null) return { waitedMs: null, paused: reserved.paused };
    // Warten AUSSERHALB der Transaktion (Commit ist erfolgt).
    if (reserved.waitMs > 0) await this.sleep(reserved.waitMs);
    return { waitedMs: reserved.waitMs, paused: null };
  }

  async pause(until: Date, kind: RateLimitPauseKind): Promise<void> {
    // Nur verlängern, nie verkürzen: eine längere bestehende Pause bleibt samt Art erhalten.
    await this.db
      .insert(integrationRateLimits)
      .values({
        provider: this.provider,
        environment: this.environment,
        nextSlotAt: new Date(0),
        pausedUntil: until,
        pauseKind: kind,
      })
      .onConflictDoUpdate({
        target: integrationRateLimits.provider,
        set: {
          environment: this.environment,
          pausedUntil: sql`CASE WHEN ${integrationRateLimits.pausedUntil} IS NULL OR ${integrationRateLimits.pausedUntil} < excluded.paused_until THEN excluded.paused_until ELSE ${integrationRateLimits.pausedUntil} END`,
          pauseKind: sql`CASE WHEN ${integrationRateLimits.pausedUntil} IS NULL OR ${integrationRateLimits.pausedUntil} < excluded.paused_until THEN excluded.pause_kind ELSE ${integrationRateLimits.pauseKind} END`,
          updatedAt: sql`now()`,
        },
      });
  }
}

export interface InMemoryIntegrationRateLimiterOptions {
  provider?: string;
  intervalMs: number;
  /** Nur Tests: Zeit/Schlaf injizierbar (dieselbe Uhr wie der Aufrufer verwenden). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Nur Unit-Tests/Fakes: dieselbe Schnittstelle ohne Datenbank, Zustand nur im
 * Prozess. Im Betrieb NIE verwenden (die Fabrik erzeugt für GraphHopper
 * ausschließlich den Postgres-Limiter).
 */
export class InMemoryIntegrationRateLimiter implements IntegrationRateLimiter {
  readonly provider: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlotAt = 0;
  private pausedUntil = 0;
  private pauseKind: RateLimitPauseKind = 'rate_limited';

  constructor(options: InMemoryIntegrationRateLimiterOptions) {
    this.provider = options.provider ?? 'in-memory';
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultRateLimitSleep;
  }

  async reserveSlot(now?: Date): Promise<ReserveSlotResult> {
    const nowMs = now?.getTime() ?? this.now();
    if (this.pausedUntil > nowMs) {
      return {
        waitMs: null,
        paused: {
          until: new Date(this.pausedUntil),
          kind: this.pauseKind,
          remainingMs: this.pausedUntil - nowMs,
        },
      };
    }
    this.pausedUntil = 0;
    const slotMs = Math.max(nowMs, this.nextSlotAt);
    this.nextSlotAt = slotMs + this.intervalMs;
    return { waitMs: Math.max(0, slotMs - nowMs), paused: null };
  }

  async acquire(now?: Date): Promise<AcquireResult> {
    const reserved = await this.reserveSlot(now);
    if (reserved.paused !== null) return { waitedMs: null, paused: reserved.paused };
    if (reserved.waitMs > 0) await this.sleep(reserved.waitMs);
    return { waitedMs: reserved.waitMs, paused: null };
  }

  async pause(until: Date, kind: RateLimitPauseKind): Promise<void> {
    if (until.getTime() > this.pausedUntil) {
      this.pausedUntil = until.getTime();
      this.pauseKind = kind;
    }
  }
}
