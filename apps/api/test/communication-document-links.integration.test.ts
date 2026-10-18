/**
 * Phase 12 (transactional) – Customer Document Link (Order §13): Token nur
 * als Hash, genau ein unveränderliches Dokument, neutrales 404 (unbekannt /
 * abgelaufen / widerrufen), Nutzung gezählt, IP-Rate-Limit, Token nie im
 * Serverlog (Pfad maskiert), kein Dokumentzugriff ohne Token.
 */
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { customerActionTokens, documents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskLoggedPath } from '../src/app.ts';
import {
  CustomerDocumentLinkService,
  DOCUMENT_LINK_VALIDITY_DAYS,
  hashDocumentToken,
} from '../src/communication/document-links.ts';
import { DocumentService } from '../src/commerce/document-service.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE customer_action_tokens, mail_deliveries CASCADE');
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  // Zuletzt: der Commerce-Reset seedet die Preise neu (Auth-Reset leert product_prices per CASCADE).
  await truncateCommerceTables(ctx.pool);
  logLines.length = 0;
});

function service(): CustomerDocumentLinkService {
  return new CustomerDocumentLinkService(ctx.db, new DocumentService(ctx.db, ctx.storage));
}

/** Finales Angebots-PDF als unveränderliches Dokument (einfachste Dokumentquelle). */
async function finalDocument() {
  const { admin } = await adminSession(ctx);
  const world = await createCommerceWorld(ctx, admin.id);
  const services = commerceServices(ctx);
  const { versionId } = await services.offers.createOffer(admin.id, world.processId);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  await services.offers.send(admin.id, versionId, effective);
  const rows = await ctx.db.select().from(documents).where(eq(documents.offerVersionId, versionId));
  return { document: rows[0]!, world };
}

async function fetchDocument(token: string) {
  return ctx.app.inject({ method: 'GET', url: `/public/documents/${token}` });
}

describe('Customer Document Link (Order §13)', () => {
  it('Token: 32 Byte base64url, nur SHA-256-Hash in der DB, Kontext (Vorgang/Kunde/Dokument) gebunden, Ablauf 90 Tage', async () => {
    const { document, world } = await finalDocument();
    const now = new Date();
    const link = await service().issue(
      { documentId: document.id, processId: world.processId, customerId: world.customerId },
      undefined,
      now,
    );
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt.getTime() - now.getTime()).toBe(
      DOCUMENT_LINK_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows = await ctx.db.select().from(customerActionTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'document_view',
      tokenHash: createHash('sha256').update(link.token).digest('hex'),
      processId: world.processId,
      customerId: world.customerId,
      documentId: document.id,
      useCount: 0,
      revokedAt: null,
    });
    expect(hashDocumentToken(link.token)).toBe(rows[0]!.tokenHash);
    expect(JSON.stringify(rows)).not.toContain(link.token);
  });

  it('Gültiges Token liefert GENAU das Dokument (inline PDF, no-store) und zählt die Nutzung; Dokument bleibt unverändert', async () => {
    const { document, world } = await finalDocument();
    const link = await service().issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
    });
    const first = await fetchDocument(link.token);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/pdf');
    expect(first.headers['content-disposition']).toContain('inline');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(createHash('sha256').update(first.rawPayload).digest('hex')).toBe(document.sha256);
    await fetchDocument(link.token);
    const row = (await ctx.db.select().from(customerActionTokens))[0]!;
    expect(row.useCount).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
    const reread = await ctx.db.select().from(documents).where(eq(documents.id, document.id));
    expect(reread[0]!.sha256).toBe(document.sha256);
  });

  it('Unbekanntes, abgelaufenes, widerrufenes oder falsch geformtes Token ⇒ identisch neutrales 404 ohne Details', async () => {
    const { document, world } = await finalDocument();
    const links = service();
    const valid = await links.issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
    });
    const expired = await links.issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const revoked = await links.issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
    });
    expect(await links.revokeForDocument(document.id)).toBe(3);
    const second = await links.issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
    });
    const bodies = new Set<string>();
    for (const token of [
      valid.token,
      expired.token,
      revoked.token,
      'A'.repeat(43),
      'kurz',
      `${second.token}x`,
    ]) {
      const response = await fetchDocument(token);
      expect(response.statusCode, token).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).not.toMatch(/abgelaufen|widerrufen|expired|revoked/i);
      bodies.add(JSON.stringify({ ...body.error, correlationId: null }));
    }
    expect(bodies.size).toBe(1);
    expect((await fetchDocument(second.token)).statusCode).toBe(200);
    const rows = await ctx.db.select().from(customerActionTokens);
    expect(rows.filter((r) => r.useCount > 0)).toHaveLength(1);
  });

  it('Rate-Limit: die öffentliche Dokumentroute ist IP-limitiert (30/min, neutrale 404 davor)', async () => {
    const limited = await createTestContext({ rateLimitEnabled: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        const response = await limited.app.inject({
          method: 'GET',
          url: `/public/documents/${'B'.repeat(43)}`,
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(statuses[30]).toBe(429);
    } finally {
      await destroyTestContext(limited);
    }
  });

  it('Der Token erscheint nie im Serverlog (Pfad maskiert) – weder bei Treffer noch bei Fehlversuch', async () => {
    const { document, world } = await finalDocument();
    const link = await service().issue({
      documentId: document.id,
      processId: world.processId,
      customerId: world.customerId,
    });
    await fetchDocument(link.token);
    await fetchDocument('C'.repeat(43));
    const log = logText();
    expect(log).toContain('/public/documents/***');
    expect(log).not.toContain(link.token);
    expect(log).not.toContain('C'.repeat(43));
    expect(maskLoggedPath(`/public/documents/${link.token}?x=1`)).toBe('/public/documents/***');
  });

  it('Ohne Token kein Dokumentzugriff: die Staff-Dokumentroute verlangt weiterhin Login', async () => {
    const { document } = await finalDocument();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
    });
    expect(response.statusCode).toBe(401);
  });
});
