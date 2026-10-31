import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Phase 13 Final (§1): gemeinsamer, prozessübergreifender Rate-Limit-Zustand
 * je externem Provider und Umgebung – genutzt von API, Worker und allen
 * Replikaten. `nextSlotAt` ist der früheste Zeitpunkt des nächsten Requests
 * (Slot wird in einer KURZEN Transaktion reserviert, gewartet wird außerhalb);
 * `pausedUntil`/`pauseKind` tragen eine vom Provider verhängte Pause (429 /
 * Credit-Limit), die alle Prozesse gleichermaßen sehen (fail-fast).
 * Lexware nutzt dieselbe Tabelle (provider = 'lexware', bisher
 * `lexware_rate_limit`). Es wird NIE ein Key, eine URL oder ein Request-Inhalt
 * gespeichert.
 */
export const integrationRateLimits = pgTable(
  'integration_rate_limits',
  {
    /** z. B. 'lexware', 'graphhopper'. */
    provider: text('provider').primaryKey(),
    /** APP_ENV der Zeile – rein informativ (jede Umgebung hat ihre eigene DB). */
    environment: text('environment').notNull(),
    nextSlotAt: timestamp('next_slot_at', { withTimezone: true }).notNull().defaultNow(),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    /** 'rate_limited' | 'credit_limited' – nur während einer aktiven Pause. */
    pauseKind: text('pause_kind'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      'integration_rate_limits_pause_check',
      sql`("paused_until" IS NULL) = ("pause_kind" IS NULL)`,
    ),
    check(
      'integration_rate_limits_pause_kind_check',
      sql`"pause_kind" IS NULL OR "pause_kind" IN ('rate_limited', 'credit_limited')`,
    ),
  ],
);

export type IntegrationRateLimitRow = typeof integrationRateLimits.$inferSelect;
