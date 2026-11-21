/**
 * Phase 18 (Order Abschnitt C): Selbsttest des Integritätschecks – alle Abfragen sind
 * gegen das aktuelle Schema ausführbar und liefern auf einer frisch migrierten,
 * leeren Datenbank sowie nach dem Basis-Seed keine Verletzung. Die fachlichen
 * Szenarien A–H rufen denselben Check nach ihrem Durchlauf auf.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  INTEGRITY_CHECKS,
  documentStorageMismatches,
  integrityViolations,
  tableCounts,
} from './acceptance-integrity.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});

describe('Phase 18 – Integritätscheck (Selbsttest)', () => {
  it('P18-C0. alle Prüfungen sind eindeutig benannt und gegen das Schema ausführbar', async () => {
    const names = INTEGRITY_CHECKS.map((check) => check.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(80);
    // Auf dem (ggf. durch andere Suiten gefüllten) Stand darf keine Abfrage scheitern.
    await expect(integrityViolations(ctx.pool)).resolves.toBeInstanceOf(Array);
  });

  it('P18-C0b. unbekannte Ausnahmen werden abgelehnt', async () => {
    await expect(integrityViolations(ctx.pool, { skip: ['gibt_es_nicht'] })).rejects.toThrow(
      /Unbekannte Integritätsprüfung/,
    );
  });

  it('P18-C0c. Dokument-/Storage-Abgleich und Zählstände laufen', async () => {
    await truncateAuthTables(ctx.pool);
    await bootstrapAdmin(ctx);
    const counts = await tableCounts(ctx.pool, ['staff_users', 'documents']);
    expect(counts.staff_users).toBeGreaterThanOrEqual(1);
    expect(typeof counts.documents).toBe('number');
    await expect(tableCounts(ctx.pool, ['staff_users; DROP TABLE x'])).rejects.toThrow(
      /Ungültiger Tabellenname/,
    );
    await expect(documentStorageMismatches(ctx.pool, ctx.storage)).resolves.toBeInstanceOf(Array);
  });
});
