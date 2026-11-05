import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, mailDeliveries } from '@mietroyal/database';
import { PostgresJobQueue } from '@mietroyal/integrations';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { FakeMailGateway } from '../src/communication/mail/gateways.ts';
import { MailOutboxService } from '../src/communication/mail/outbox.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import type { MailDeliveryKind } from '../src/communication/types.ts';
import { PortalMagicLinkService } from '../src/portal/auth/magic-link-service.ts';
import { PortalProfileService } from '../src/portal/auth/profile-service.ts';
import { PortalSessionService } from '../src/portal/auth/session-service.ts';
import { portalSessionCookieName } from '../src/portal/guard.ts';
import { registerPortalAuthRoutes } from '../src/routes/portal-auth.ts';
import { registerPortalProfileRoutes } from '../src/routes/portal-profile.ts';
import {
  createTestContext,
  DEMO_TEST_AUTH_SECRET_KEY,
  DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
  destroyTestContext,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';

/**
 * Phase 15 (AUTH): Test-Helfer der Portal-Authentifizierung – für die eigenen
 * Tests und für BOOKING/CHAT/E2E. Magic-Link-Tokens werden AUSSCHLIESSLICH
 * in-process aus dem verschlüsselten Outbox-Secret gelesen (PayloadCrypto des
 * Testkontexts) – nie aus stdout, Dateien oder einer Reveal-Route (Order §66).
 */

export type PortalMagicLinkKind =
  'customer_portal_magic_link' | 'customer_portal_reauth' | 'customer_portal_email_change';

/** Cookie-Name der App des Kontexts (`mr_customer_session` in development, sonst `__Host-…`). */
export function portalCookieName(ctx: Pick<TestContext, 'config'>): string {
  return portalSessionCookieName(ctx.config.appEnv);
}

/** Portal-Tabellen leeren (vor CRM-/Auth-Resets aufrufen; FK auf customers). */
export async function truncatePortalTables(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE customer_portal_magic_links, customer_portal_sessions CASCADE');
}

/**
 * Token aus dem Outbox-Secret einer Zustellung entschlüsseln (in-process).
 * Liefert null, wenn kein Secret (mehr) gespeichert ist (z. B. nach Versand).
 */
export async function decryptPortalMailToken(
  ctx: Pick<TestContext, 'db' | 'communication'>,
  deliveryId: string,
): Promise<string | null> {
  const rows = await ctx.db
    .select({ ciphertext: mailDeliveries.secretPayloadCiphertext })
    .from(mailDeliveries)
    .where(eq(mailDeliveries.id, deliveryId));
  const ciphertext = rows[0]?.ciphertext ?? null;
  if (ciphertext === null) return null;
  const secrets = JSON.parse(
    ctx.communication.crypto.decrypt(ciphertext, 'mail-secret-payload', deliveryId),
  ) as Record<string, unknown>;
  const token = secrets.portalToken;
  return typeof token === 'string' ? token : null;
}

/** Jüngste Portal-Mail-Zustellung dieser Art (optional nur neuer als `afterId`-Zeile). */
export async function latestPortalMail(
  ctx: Pick<TestContext, 'db'>,
  kind: PortalMagicLinkKind | 'customer_portal_reply_notice',
  options: { notBefore?: Date } = {},
) {
  const rows = await ctx.db
    .select()
    .from(mailDeliveries)
    .where(eq(mailDeliveries.kind, kind satisfies MailDeliveryKind))
    .orderBy(desc(mailDeliveries.createdAt))
    .limit(1);
  const row = rows[0] ?? null;
  if (row === null) return null;
  if (options.notBefore !== undefined && row.createdAt.getTime() < options.notBefore.getTime()) {
    return null;
  }
  return row;
}

export interface MagicLinkRequestResult {
  statusCode: number;
  body: Record<string, unknown>;
  /** Klartext-Token (nur im Test-Prozess) oder null, wenn keine Mail entstand. */
  token: string | null;
  deliveryId: string | null;
  recipientEmail: string | null;
}

/**
 * `POST /portal/auth/request` und – falls eine Zustellung entstand – Token aus
 * dem Outbox-Secret. Antwort ist immer 202 neutral; `token === null` bedeutet
 * „kein Link“ (unbekannt, mehrdeutig, gelöscht).
 */
export async function requestMagicLink(
  ctx: Pick<TestContext, 'app' | 'db' | 'communication'>,
  email: string,
  options: { headers?: Record<string, string>; app?: FastifyInstance } = {},
): Promise<MagicLinkRequestResult> {
  const before = await latestPortalMail(ctx, 'customer_portal_magic_link');
  const response = await (options.app ?? ctx.app).inject({
    method: 'POST',
    url: '/portal/auth/request',
    payload: { email },
    headers: options.headers ?? {},
  });
  const after = await latestPortalMail(ctx, 'customer_portal_magic_link');
  const fresh = after !== null && (before === null || after.id !== before.id) ? after : null;
  return {
    statusCode: response.statusCode,
    body: response.statusCode === 204 ? {} : (response.json() as Record<string, unknown>),
    token: fresh === null ? null : await decryptPortalMailToken(ctx, fresh.id),
    deliveryId: fresh?.id ?? null,
    recipientEmail: fresh?.recipientEmail ?? null,
  };
}

/** Login-Magic-Link anfordern und den Token liefern (wirft, wenn keine Mail entstand). */
export async function requestMagicLinkToken(
  ctx: Pick<TestContext, 'app' | 'db' | 'communication'>,
  email: string,
): Promise<string> {
  const result = await requestMagicLink(ctx, email);
  if (result.token === null) {
    throw new Error(`Kein Magic Link entstanden (Status ${result.statusCode}).`);
  }
  return result.token;
}

/** Token des jüngsten Reauth- bzw. E-Mail-Wechsel-Links (nach dem jeweiligen Request aufrufen). */
export async function latestPortalMailToken(
  ctx: Pick<TestContext, 'db' | 'communication'>,
  kind: PortalMagicLinkKind,
): Promise<{ token: string; deliveryId: string; recipientEmail: string | null } | null> {
  const row = await latestPortalMail(ctx, kind);
  if (row === null) return null;
  const token = await decryptPortalMailToken(ctx, row.id);
  return token === null ? null : { token, deliveryId: row.id, recipientEmail: row.recipientEmail };
}

export interface PortalLogin {
  /** `cookie`-Header für app.inject (`<name>=<token>`). */
  cookie: string;
  sessionId: string;
  token: string;
  expiresAt: Date;
}

/**
 * Portal-Session für einen Kunden direkt über den Session-Service anlegen
 * (kein Mailweg) – für BOOKING/CHAT/E2E-Seeds. Liefert den Cookie-Header.
 */
export async function loginPortalCustomer(
  ctx: Pick<TestContext, 'db' | 'config'>,
  customerId: string,
  options: { now?: Date; userAgentLabel?: string | null } = {},
): Promise<string> {
  const login = await loginPortalCustomerSession(ctx, customerId, options);
  return login.cookie;
}

export async function loginPortalCustomerSession(
  ctx: Pick<TestContext, 'db' | 'config'>,
  customerId: string,
  options: { now?: Date; userAgentLabel?: string | null } = {},
): Promise<PortalLogin> {
  const sessions = new PortalSessionService(ctx.db);
  const { token, session } = await sessions.create(
    customerId,
    options.now ?? new Date(),
    options.userAgentLabel ?? 'Test',
  );
  return {
    cookie: `${portalCookieName(ctx)}=${token}`,
    sessionId: session.id,
    token,
    expiresAt: session.expiresAt,
  };
}

/** Login über den ECHTEN Magic-Link-Pfad (Request → Outbox-Secret → Consume) – liefert den Cookie-Header. */
export async function loginViaMagicLink(
  ctx: Pick<TestContext, 'app' | 'db' | 'communication' | 'config'>,
  email: string,
): Promise<{ cookie: string; token: string; response: Record<string, unknown> }> {
  const token = await requestMagicLinkToken(ctx, email);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/portal/auth/consume',
    payload: { token },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Magic-Link-Consume fehlgeschlagen (Status ${response.statusCode}).`);
  }
  const cookie = response.cookies.find((c) => c.name === portalCookieName(ctx));
  if (cookie === undefined) throw new Error('Kein Portal-Cookie gesetzt.');
  return {
    cookie: `${cookie.name}=${cookie.value}`,
    token,
    response: response.json() as Record<string, unknown>,
  };
}

// ── Testkontext mit Portal-Routen ────────────────────────────────────────────

export interface PortalTestContext extends TestContext {
  /** Hilfs-Pool des Fallbacks (null, wenn app.ts die Portal-Routen selbst registriert). */
  portalFallbackPool: pg.Pool | null;
}

/**
 * Testkontext, der die Portal-Auth-/Profil-Routen garantiert: sind sie in
 * app.ts noch nicht über `registerPortalModule` verdrahtet, registriert ein
 * kleiner Fallback-Plugin NUR die AUTH-Routen (gleiche Services, eigener Pool
 * auf derselben Datenbank, gleiche Konfiguration). Sobald app.ts verdrahtet
 * ist, bleibt der Fallback inaktiv (`hasRoute`).
 */
export async function createPortalTestContext(
  options: Parameters<typeof createTestContext>[0] = {},
): Promise<PortalTestContext> {
  const databaseUrl = options.databaseUrl ?? TEST_DATABASE_URL;
  const appEnv = options.appEnv ?? 'development';
  const config = loadConfig({
    APP_ENV: appEnv,
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: options.logLevel ?? 'error',
    ...(appEnv === 'demo'
      ? {
          STORAGE_DRIVER: 'fs',
          STORAGE_FS_ROOT: '/tmp/mietroyal-portal-test-unused',
          AUTH_SECRET_KEY: DEMO_TEST_AUTH_SECRET_KEY,
          COMMUNICATION_PAYLOAD_KEY: DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
        }
      : {}),
    ...(options.env ?? {}),
  });
  const fallback: { pool: pg.Pool | null } = { pool: null };
  const ctx = await createTestContext({
    ...options,
    beforeReady: (app) => {
      options.beforeReady?.(app);
      void app.register(async (instance) => {
        if (instance.hasRoute({ method: 'GET', url: '/portal/me' })) return;
        fallback.pool = createPool(databaseUrl, { max: 4 });
        const db = createDb(fallback.pool);
        const queue = new PostgresJobQueue(fallback.pool);
        const outbox = new MailOutboxService(
          db,
          config,
          new PayloadCrypto(config),
          new FakeMailGateway(),
          queue,
        );
        const sessions = new PortalSessionService(db);
        const magicLinks = new PortalMagicLinkService(db, outbox, config, sessions, {
          logger: instance.log,
        });
        registerPortalAuthRoutes(instance, {
          db,
          config,
          sessions,
          magicLinks,
          rateLimitEnabled: options.rateLimitEnabled ?? false,
        });
        registerPortalProfileRoutes(instance, {
          config,
          sessions,
          profile: new PortalProfileService(db),
        });
      });
    },
  });
  return { ...ctx, portalFallbackPool: fallback.pool };
}

export async function destroyPortalTestContext(ctx: PortalTestContext): Promise<void> {
  await destroyTestContext(ctx);
  if (ctx.portalFallbackPool !== null) await ctx.portalFallbackPool.end();
}
