import type { AppConfig } from '@mietroyal/config';
import {
  customerPortalMagicLinks,
  customers,
  type Customer,
  type CustomerPortalMagicLinkPurpose,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { recordSecurityEvent } from '../../auth/audit.ts';
import { generateToken, sha256Hex } from '../../auth/crypto.ts';
import { AuthError } from '../../auth/service.ts';
import { mailSalutation } from '../../communication/transactional/keys.ts';
import type { MailEnqueueInput, MailEnqueueResult } from '../../communication/types.ts';
import { normalizeEmailAddress } from '../../crm/normalize.ts';
import { isWellFormedPortalToken } from '../guard.ts';
import { PORTAL_MESSAGES, PortalError, type PortalSessionContext } from '../types.ts';
import {
  isReauthFresh,
  PORTAL_MAGIC_LINK_TTL_MS,
  PORTAL_MAGIC_LINK_VALID_MINUTES,
} from './constants.ts';
import type { PortalSessionService } from './session-service.ts';
import { portalCustomerName } from './views.ts';

/** Outbox-Schnittstelle, die der Service braucht (MailOutboxService erfüllt sie). */
export interface PortalMailOutbox {
  enqueueAndSchedule(input: MailEnqueueInput): Promise<MailEnqueueResult>;
}

export interface PortalAuthLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const NOOP_LOGGER: PortalAuthLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Wie CRM: Adresse muss ein `@` enthalten und höchstens 320 Zeichen lang sein. */
const EMAIL_MAX_LENGTH = 320;

function tokenInvalid(): PortalError {
  return new PortalError('INVALID_TOKEN', 'PORTAL_TOKEN_INVALID', PORTAL_MESSAGES.TOKEN_INVALID);
}

/**
 * Phase 15 (Order §4–§7, §32–§35): Magic Links für Anmeldung, Reauth und
 * E-Mail-Wechsel. Tokens: 32 Zufallsbytes base64url; die DB kennt NUR den
 * SHA-256-Hex; der Klartext reist ausschließlich im verschlüsselten Mail-Secret
 * (`secrets.portalToken`) in die Vorlage. Consume ist ein atomares
 * `UPDATE … RETURNING` (genau ein Gewinner bei parallelen Versuchen).
 * Dieser Service loggt nie Adressen oder Tokens – nur IDs, Zwecke und Codes.
 */
export class PortalMagicLinkService {
  private readonly logger: PortalAuthLogger;

  constructor(
    private readonly db: Database,
    private readonly outbox: PortalMailOutbox | null,
    private readonly config: AppConfig,
    private readonly sessions: PortalSessionService,
    options: { logger?: PortalAuthLogger | undefined } = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  // ── Anmeldung (Order §4/§6) ───────────────────────────────────────────────

  /**
   * Niemals enumerierend: 0 oder >1 aktive Kunden mit dieser Adresse ⇒ kein
   * Link (nur Log ohne Adresse). Genau 1 ⇒ ältere offene Login-Links widerrufen,
   * neuer Link, Mail über die Outbox (Gateway nie in der Transaktion).
   */
  async requestLogin(emailRaw: string, now: Date = new Date()): Promise<void> {
    const email = normalizeEmailAddress(emailRaw);
    if (email === null || !email.includes('@') || email.length > EMAIL_MAX_LENGTH) {
      this.logger.info({ reason: 'invalid' }, 'portal.magic_link.skipped');
      return;
    }
    const candidates = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.email, email), isNull(customers.deletedAt)))
      .limit(2);
    if (candidates.length !== 1) {
      this.logger.info(
        { reason: candidates.length === 0 ? 'none' : 'ambiguous' },
        'portal.magic_link.skipped',
      );
      return;
    }
    const customer = candidates[0]!;
    const { token, linkId } = await this.db.transaction(async (tx) => {
      await this.revokeOpenLinks(tx, { customerId: customer.id, purpose: 'login' }, now);
      return this.insertLink(tx, { customerId: customer.id, purpose: 'login' }, now);
    });
    await this.sendLinkMail({
      kind: 'customer_portal_magic_link',
      customer,
      recipientEmail: email,
      token,
      linkId,
    });
  }

  /** Konsumiert einen Login-Link und legt die Session an. */
  async consumeLogin(
    token: string,
    now: Date = new Date(),
    options: { userAgentLabel?: string | null } = {},
  ): Promise<{ sessionToken: string; expiresAt: Date; customerId: string; sessionId: string }> {
    if (!isWellFormedPortalToken(token)) throw tokenInvalid();
    const link = await this.consumeOpenLink(this.db, { token, purpose: 'login' }, now);
    if (link === null) throw tokenInvalid();
    const customer = await this.activeCustomer(this.db, link.customerId);
    if (customer === null) throw tokenInvalid();
    const { token: sessionToken, session } = await this.sessions.create(
      customer.id,
      now,
      options.userAgentLabel ?? null,
    );
    await recordSecurityEvent(this.db, {
      type: 'portal.login',
      details: { customerId: customer.id, sessionId: session.id },
    });
    return {
      sessionToken,
      expiresAt: session.expiresAt,
      customerId: customer.id,
      sessionId: session.id,
    };
  }

  // ── Reauth (Order §32) ────────────────────────────────────────────────────

  async requestReauth(session: PortalSessionContext, now: Date = new Date()): Promise<void> {
    const customer = await this.activeCustomer(this.db, session.customerId);
    if (customer === null || customer.email === null) {
      // Session ohne aktiven Kunden/ohne Adresse: still (die Session-Prüfung meldet 401).
      this.logger.warn({ reason: 'no_recipient' }, 'portal.reauth.skipped');
      return;
    }
    const { token, linkId } = await this.db.transaction(async (tx) => {
      await this.revokeOpenLinks(tx, { sessionId: session.sessionId, purpose: 'reauth' }, now);
      return this.insertLink(
        tx,
        { customerId: customer.id, purpose: 'reauth', sessionId: session.sessionId },
        now,
      );
    });
    await this.sendLinkMail({
      kind: 'customer_portal_reauth',
      customer,
      recipientEmail: customer.email,
      token,
      linkId,
    });
  }

  /** Nur der Link DIESER Session zählt; setzt `reauthenticated_at`, nie `expires_at`. */
  async consumeReauth(
    token: string,
    session: PortalSessionContext,
    now: Date = new Date(),
  ): Promise<{ reauthenticatedAt: Date }> {
    if (!isWellFormedPortalToken(token)) throw tokenInvalid();
    const link = await this.consumeOpenLink(
      this.db,
      { token, purpose: 'reauth', sessionId: session.sessionId },
      now,
    );
    if (link === null || link.customerId !== session.customerId) throw tokenInvalid();
    await this.sessions.markReauthenticated(session.sessionId, now);
    return { reauthenticatedAt: now };
  }

  // ── E-Mail-Wechsel (Order §34/§35) ────────────────────────────────────────

  async requestEmailChange(
    session: PortalSessionContext,
    newEmailRaw: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (!isReauthFresh(session.reauthenticatedAt, now)) {
      throw new PortalError('FORBIDDEN', 'PORTAL_REAUTH_REQUIRED', PORTAL_MESSAGES.REAUTH_REQUIRED);
    }
    const email = normalizeEmailAddress(newEmailRaw);
    if (email === null || !email.includes('@') || email.length > EMAIL_MAX_LENGTH) {
      throw new AuthError('VALIDATION', 'Bitte eine gültige E-Mail-Adresse angeben.');
    }
    const customer = await this.activeCustomer(this.db, session.customerId);
    if (customer === null) throw tokenInvalid();
    if (customer.email === email) {
      throw new PortalError(
        'VALIDATION',
        'PORTAL_EMAIL_UNAVAILABLE',
        PORTAL_MESSAGES.EMAIL_UNAVAILABLE,
      );
    }
    if (await this.emailTakenByOther(this.db, email, customer.id)) {
      throw new PortalError(
        'VALIDATION',
        'PORTAL_EMAIL_UNAVAILABLE',
        PORTAL_MESSAGES.EMAIL_UNAVAILABLE,
      );
    }
    const { token, linkId } = await this.db.transaction(async (tx) => {
      await this.revokeOpenLinks(tx, { customerId: customer.id, purpose: 'email_change' }, now);
      return this.insertLink(
        tx,
        {
          customerId: customer.id,
          purpose: 'email_change',
          sessionId: session.sessionId,
          proposedEmail: email,
        },
        now,
      );
    });
    // An die NEUE Adresse; in demo blockiert ggf. die Whitelist (Status blocked) – Antwort bleibt neutral.
    await this.sendLinkMail({
      kind: 'customer_portal_email_change',
      customer,
      recipientEmail: email,
      token,
      linkId,
    });
  }

  /**
   * Commit des E-Mail-Wechsels: Advisory-Lock je Zieladresse, atomares Consume,
   * anfordernde Session muss noch gültig sein, Eindeutigkeit ERNEUT geprüft
   * (fail-closed ⇒ Rollback + CONFLICT). Danach: Adresse setzen, ALLE Sessions
   * und offenen Links des Kunden widerrufen. Kein Cookie nötig: der Link ist an
   * Kunde + Session + Token gebunden und darf auf einem anderen Gerät geöffnet werden.
   */
  async consumeEmailChange(token: string, now: Date = new Date()): Promise<{ changed: true }> {
    if (!isWellFormedPortalToken(token)) throw tokenInvalid();
    const tokenHash = sha256Hex(token);
    const customerId = await this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({
          id: customerPortalMagicLinks.id,
          proposedEmail: customerPortalMagicLinks.proposedEmail,
        })
        .from(customerPortalMagicLinks)
        .where(
          and(
            eq(customerPortalMagicLinks.tokenHash, tokenHash),
            eq(customerPortalMagicLinks.purpose, 'email_change'),
          ),
        );
      const candidate = candidates[0];
      if (candidate === undefined || candidate.proposedEmail === null) throw tokenInvalid();
      const proposedEmail = candidate.proposedEmail;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`portal-email-change:${proposedEmail}`}))`,
      );
      const link = await this.consumeOpenLink(tx, { token, purpose: 'email_change' }, now);
      if (link === null || link.sessionId === null) throw tokenInvalid();
      const session = await this.sessions.byId(link.sessionId, tx);
      if (
        session === null ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.customerId !== link.customerId
      ) {
        throw tokenInvalid();
      }
      const customer = await this.activeCustomer(tx, link.customerId, { forUpdate: true });
      if (customer === null) throw tokenInvalid();
      if (await this.emailTakenByOther(tx, proposedEmail, customer.id)) {
        throw new PortalError(
          'CONFLICT',
          'PORTAL_EMAIL_UNAVAILABLE',
          PORTAL_MESSAGES.EMAIL_UNAVAILABLE,
        );
      }
      const updated = await tx
        .update(customers)
        .set({ email: proposedEmail, updatedAt: now })
        .where(and(eq(customers.id, customer.id), isNull(customers.deletedAt)))
        .returning({ id: customers.id });
      if (updated.length === 0) throw tokenInvalid();
      const revokedSessions = await this.sessions.revokeAllForCustomer(customer.id, now, tx);
      await this.revokeOpenLinks(tx, { customerId: customer.id }, now);
      await recordSecurityEvent(tx, {
        type: 'portal.email_changed',
        details: { customerId: customer.id },
      });
      await recordSecurityEvent(tx, {
        type: 'portal.sessions_revoked',
        details: { customerId: customer.id, count: revokedSessions, reason: 'email_changed' },
      });
      return customer.id;
    });
    this.logger.info({ customerId }, 'portal.email_changed');
    return { changed: true };
  }

  // ── Interna ───────────────────────────────────────────────────────────────

  private async activeCustomer(
    executor: DatabaseExecutor,
    customerId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Customer | null> {
    const query = executor
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
    const rows = options.forUpdate === true ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  private async emailTakenByOther(
    executor: DatabaseExecutor,
    email: string,
    customerId: string,
  ): Promise<boolean> {
    const rows = await executor
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.email, email), isNull(customers.deletedAt), ne(customers.id, customerId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async insertLink(
    executor: DatabaseExecutor,
    input: {
      customerId: string;
      purpose: CustomerPortalMagicLinkPurpose;
      sessionId?: string;
      proposedEmail?: string;
    },
    now: Date,
  ): Promise<{ token: string; linkId: string }> {
    const token = generateToken();
    const inserted = await executor
      .insert(customerPortalMagicLinks)
      .values({
        customerId: input.customerId,
        purpose: input.purpose,
        tokenHash: sha256Hex(token),
        sessionId: input.sessionId ?? null,
        proposedEmail: input.proposedEmail ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PORTAL_MAGIC_LINK_TTL_MS),
      })
      .returning({ id: customerPortalMagicLinks.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Magic Link konnte nicht angelegt werden.');
    return { token, linkId: row.id };
  }

  /** Offene (nicht verbrauchte, nicht widerrufene) Links widerrufen – optional je Zweck/Session. */
  private async revokeOpenLinks(
    executor: DatabaseExecutor,
    filter: { customerId?: string; sessionId?: string; purpose?: CustomerPortalMagicLinkPurpose },
    now: Date,
  ): Promise<void> {
    const conditions = [
      isNull(customerPortalMagicLinks.consumedAt),
      isNull(customerPortalMagicLinks.revokedAt),
    ];
    if (filter.customerId !== undefined) {
      conditions.push(eq(customerPortalMagicLinks.customerId, filter.customerId));
    }
    if (filter.sessionId !== undefined) {
      conditions.push(eq(customerPortalMagicLinks.sessionId, filter.sessionId));
    }
    if (filter.purpose !== undefined) {
      conditions.push(eq(customerPortalMagicLinks.purpose, filter.purpose));
    }
    await executor
      .update(customerPortalMagicLinks)
      .set({ revokedAt: now })
      .where(and(...conditions));
  }

  /**
   * Atomarer One-time-Consume: `UPDATE … SET consumed_at = now WHERE token_hash
   * AND purpose AND offen AND nicht abgelaufen [AND session_id] RETURNING`.
   * Postgres serialisiert konkurrierende UPDATEs derselben Zeile und prüft die
   * WHERE-Bedingung erneut ⇒ genau ein Gewinner.
   */
  private async consumeOpenLink(
    executor: DatabaseExecutor,
    input: { token: string; purpose: CustomerPortalMagicLinkPurpose; sessionId?: string },
    now: Date,
  ): Promise<{ id: string; customerId: string; sessionId: string | null } | null> {
    const conditions = [
      eq(customerPortalMagicLinks.tokenHash, sha256Hex(input.token)),
      eq(customerPortalMagicLinks.purpose, input.purpose),
      isNull(customerPortalMagicLinks.consumedAt),
      isNull(customerPortalMagicLinks.revokedAt),
      gt(customerPortalMagicLinks.expiresAt, now),
    ];
    if (input.sessionId !== undefined) {
      conditions.push(eq(customerPortalMagicLinks.sessionId, input.sessionId));
    }
    const updated = await executor
      .update(customerPortalMagicLinks)
      .set({ consumedAt: now })
      .where(and(...conditions))
      .returning({
        id: customerPortalMagicLinks.id,
        customerId: customerPortalMagicLinks.customerId,
        sessionId: customerPortalMagicLinks.sessionId,
      });
    return updated[0] ?? null;
  }

  /** Mail über die Outbox (nach Commit). Fehler werden nur geloggt – die öffentliche Antwort bleibt neutral. */
  private async sendLinkMail(input: {
    kind: 'customer_portal_magic_link' | 'customer_portal_reauth' | 'customer_portal_email_change';
    customer: Customer;
    recipientEmail: string;
    token: string;
    linkId: string;
  }): Promise<void> {
    if (this.outbox === null) {
      this.logger.warn(
        { kind: input.kind, linkId: input.linkId, code: 'MAIL_NOT_CONFIGURED' },
        'portal.magic_link.mail_unavailable',
      );
      return;
    }
    const displayName = portalCustomerName(input.customer);
    try {
      const result = await this.outbox.enqueueAndSchedule({
        kind: input.kind,
        customerId: input.customer.id,
        recipient: { email: input.recipientEmail, name: displayName === '' ? null : displayName },
        context: {
          salutation: mailSalutation(displayName),
          validMinutes: PORTAL_MAGIC_LINK_VALID_MINUTES,
        },
        secrets: { portalToken: input.token },
        idempotencyKey: `${input.kind}:${input.linkId}`,
      });
      this.logger.info(
        {
          kind: input.kind,
          linkId: input.linkId,
          deliveryId: result.deliveryId,
          status: result.status,
        },
        'portal.magic_link.enqueued',
      );
    } catch (error) {
      this.logger.error(
        {
          kind: input.kind,
          linkId: input.linkId,
          errorClass: error instanceof Error ? error.name : 'unknown',
        },
        'portal.magic_link.mail_failed',
      );
    }
  }
}
