import { lexwareIntegrationState } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { LexwareEventSubscription } from './client.ts';
import { LexwareBlockedError, type LexwareConnectionService } from './connection-service.ts';
import type { LexwareContext } from './context.ts';
import { LexwareApiError } from './errors.ts';

/**
 * Idempotente Einrichtung der Lexware-Event-Subscriptions (Order §54,
 * Vertrag §3). Benötigte Eventtypen laut docs/LEXWARE_API_NOTES.md.
 * Regeln: vorhandene Subscription mit gleicher callbackUrl wiederverwenden;
 * fremde Subscriptions (nicht von Miet-Royal angelegt bzw. andere URL) NIE
 * löschen; nur eigene Subscriptions mit veralteter Callback-URL werden
 * ersetzt. Ergebnis landet in `lexware_integration_state.subscriptions`.
 */
export const LEXWARE_REQUIRED_EVENT_TYPES = [
  'invoice.status.changed',
  'invoice.changed',
  'invoice.deleted',
  'payment.changed',
] as const;
/**
 * Früher von Miet-Royal angelegte Eventtypen, die nicht mehr benötigt werden
 * (Phase-10-Finalisierung A1: `token.revoked` betrifft laut Doku einen
 * widerrufenen OAuth-Refresh-Token; die Integration nutzt einen API-Key, dessen
 * Gesundheit über Profilprüfung/401/403 beurteilt wird). Nur die EIGENE
 * gespeicherte Subscription dieses Typs wird beim Setup entfernt.
 */
export const LEXWARE_RETIRED_EVENT_TYPES = ['token.revoked'] as const;
export type LexwareRequiredEventType = (typeof LEXWARE_REQUIRED_EVENT_TYPES)[number];

export interface LexwareSubscriptionSetupResult {
  created: string[];
  existing: string[];
  /** Eigene, nicht mehr benötigte Subscriptions (z. B. token.revoked), die entfernt wurden. */
  removed: string[];
  failed: { eventType: string; code: string }[];
  callbackUrl: string | null;
  webhookStatus: 'configured' | 'incomplete' | 'error';
}

/** Persistierte Form (keine fremden Subscriptions, keine Secrets). */
export interface StoredLexwareSubscription {
  subscriptionId: string;
  eventType: string;
  callbackUrl: string;
}

export class LexwareSubscriptionService {
  constructor(
    private readonly lexware: LexwareContext,
    private readonly connection: LexwareConnectionService,
  ) {}

  /** Eigene Subscriptions laut gespeichertem Stand (nie fremde). */
  async stored(): Promise<StoredLexwareSubscription[]> {
    const state = await this.connection.getState();
    return parseStored(state?.subscriptions);
  }

  async setup(): Promise<LexwareSubscriptionSetupResult> {
    const client = this.lexware.client;
    if (client === null) {
      throw new LexwareBlockedError(
        'LEXWARE_NOT_CONFIGURED',
        'Buchhaltungsintegration nicht konfiguriert',
      );
    }
    const callbackUrl = this.lexware.config.lexware.webhookCallbackUrl;
    const now = new Date();
    if (callbackUrl === null) {
      // Gespeicherte eigene Subscription-IDs bleiben erhalten (sonst gälten
      // sie später als „fremd“ und würden nie ersetzt) – nur Status setzen.
      await this.persistStatus('incomplete', now);
      return {
        created: [],
        existing: [],
        removed: [],
        failed: LEXWARE_REQUIRED_EVENT_TYPES.map((eventType) => ({
          eventType,
          code: 'LEXWARE_CALLBACK_URL_MISSING',
        })),
        callbackUrl: null,
        webhookStatus: 'incomplete',
      };
    }

    const own = await this.stored();
    const ownIds = new Set(own.map((s) => s.subscriptionId));
    let remote: LexwareEventSubscription[];
    try {
      remote = (await client.listEventSubscriptions()).data.content;
    } catch (error) {
      await this.handleFailure(error, now);
      throw error;
    }

    const created: string[] = [];
    const existing: string[] = [];
    const failed: { eventType: string; code: string }[] = [];
    const resulting: StoredLexwareSubscription[] = [];
    const removed: string[] = [];

    // Eigene, nicht mehr benötigte Subscriptions (nur per gespeicherter ID – nie fremde).
    for (const eventType of LEXWARE_RETIRED_EVENT_TYPES) {
      const retired = remote.filter(
        (s) => s.eventType === eventType && ownIds.has(s.subscriptionId),
      );
      for (const s of retired) {
        try {
          await client.deleteEventSubscription(s.subscriptionId);
          removed.push(eventType);
        } catch (error) {
          if (error instanceof LexwareApiError && error.kind === 'not_found') continue;
          if (error instanceof LexwareApiError && error.kind === 'unauthorized') {
            await this.handleFailure(error, now);
            throw error;
          }
          failed.push({ eventType, code: codeOf(error) });
        }
      }
    }

    for (const eventType of LEXWARE_REQUIRED_EVENT_TYPES) {
      const match = remote.find((s) => s.eventType === eventType && s.callbackUrl === callbackUrl);
      if (match !== undefined) {
        existing.push(eventType);
        resulting.push({ subscriptionId: match.subscriptionId, eventType, callbackUrl });
        continue;
      }
      // Eigene Subscription mit alter Callback-URL: ersetzen (nur die eigene!).
      const stale = remote.filter(
        (s) =>
          s.eventType === eventType &&
          s.callbackUrl !== callbackUrl &&
          ownIds.has(s.subscriptionId),
      );
      let replaceFailed = false;
      for (const s of stale) {
        try {
          await client.deleteEventSubscription(s.subscriptionId);
        } catch (error) {
          if (error instanceof LexwareApiError && error.kind === 'not_found') continue;
          replaceFailed = true;
          failed.push({ eventType, code: codeOf(error) });
          break;
        }
      }
      if (replaceFailed) continue;
      try {
        const result = await client.createEventSubscription({ eventType, callbackUrl });
        created.push(eventType);
        resulting.push({ subscriptionId: result.data.id, eventType, callbackUrl });
      } catch (error) {
        if (error instanceof LexwareApiError && error.kind === 'conflict') {
          // Zwischenzeitlich angelegt (z. B. paralleler Lauf): Stand erneut lesen.
          const again = await this.findRemote(eventType, callbackUrl);
          if (again !== null) {
            existing.push(eventType);
            resulting.push({ subscriptionId: again.subscriptionId, eventType, callbackUrl });
            continue;
          }
        }
        if (error instanceof LexwareApiError && error.kind === 'unauthorized') {
          await this.handleFailure(error, now);
          throw error;
        }
        failed.push({ eventType, code: codeOf(error) });
      }
    }

    const webhookStatus = failed.length === 0 ? 'configured' : 'incomplete';
    await this.persist(resulting, webhookStatus, now);
    this.lexware.logger.info(
      {
        lexware: {
          action: 'subscriptions_setup',
          created: created.length,
          existing: existing.length,
          removed: removed.length,
          failed: failed.map((f) => `${f.eventType}:${f.code}`),
          status: webhookStatus,
        },
      },
      'Lexware-Event-Subscriptions geprüft',
    );
    return { created, existing, removed, failed, callbackUrl, webhookStatus };
  }

  private async findRemote(
    eventType: string,
    callbackUrl: string,
  ): Promise<LexwareEventSubscription | null> {
    const client = this.lexware.client;
    if (client === null) return null;
    try {
      const list = (await client.listEventSubscriptions()).data.content;
      return list.find((s) => s.eventType === eventType && s.callbackUrl === callbackUrl) ?? null;
    } catch {
      return null;
    }
  }

  private async handleFailure(error: unknown, now: Date): Promise<void> {
    if (error instanceof LexwareApiError && error.kind === 'unauthorized') {
      await this.connection.markDisconnected(error.code);
    }
    await this.lexware.db
      .update(lexwareIntegrationState)
      .set({ webhookStatus: 'error', webhooksCheckedAt: now, updatedAt: now })
      .where(eq(lexwareIntegrationState.environment, this.lexware.config.appEnv));
  }

  private async persistStatus(
    webhookStatus: 'configured' | 'incomplete' | 'error',
    now: Date,
  ): Promise<void> {
    await this.lexware.db
      .insert(lexwareIntegrationState)
      .values({
        environment: this.lexware.config.appEnv,
        webhookStatus,
        webhooksCheckedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: lexwareIntegrationState.environment,
        set: { webhookStatus, webhooksCheckedAt: now, updatedAt: now },
      });
  }

  private async persist(
    subscriptions: StoredLexwareSubscription[],
    webhookStatus: 'configured' | 'incomplete' | 'error',
    now: Date,
  ): Promise<void> {
    await this.lexware.db
      .insert(lexwareIntegrationState)
      .values({
        environment: this.lexware.config.appEnv,
        subscriptions,
        webhookStatus,
        webhooksCheckedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: lexwareIntegrationState.environment,
        set: { subscriptions, webhookStatus, webhooksCheckedAt: now, updatedAt: now },
      });
  }
}

export function parseStored(value: unknown): StoredLexwareSubscription[] {
  if (!Array.isArray(value)) return [];
  const out: StoredLexwareSubscription[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.subscriptionId === 'string' &&
      typeof e.eventType === 'string' &&
      typeof e.callbackUrl === 'string'
    ) {
      out.push({
        subscriptionId: e.subscriptionId,
        eventType: e.eventType,
        callbackUrl: e.callbackUrl,
      });
    }
  }
  return out;
}

function codeOf(error: unknown): string {
  return error instanceof LexwareApiError ? error.code : 'LEXWARE_ERROR';
}
