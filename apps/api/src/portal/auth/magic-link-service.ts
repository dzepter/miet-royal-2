import type { AppConfig } from '@mietroyal/config';
import {
  customerPortalMagicLinks,
  customers,
  type Customer,
  type CustomerPortalMagicLinkPurpose,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, count, eq, gt, isNull, ne, sql } from 'drizzle-orm';
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
  PORTAL_LINK_THROTTLE_MAX,
  PORTAL_LINK_THROTTLE_WINDOW_MS,
  PORTAL_MAGIC_LINK_TTL_MS,
  PORTAL_MAGIC_LINK_VALID_MINUTES,
} from './constants.ts';
import { lockPortalCustomerAuth } from './locks.ts';
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
   * Phase 15 (Review R4): höchstens 5 Login-Links je Kunde in 15 min – darüber
   * still nichts (kein Link, kein Widerruf, keine Mail); die Route antwortet gleich.
   * Phase 15 (Review R6/R9): unter dem Kunden-Lock muss der Kunde noch aktiv sein UND
   * noch genau diese Adresse tragen – sonst kein Link (Rennen mit Papierkorb/E-Mail-Wechsel).
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
    const candidate = candidates[0]!;
    const created = await this.db.transaction(async (tx) => {
      // Phase 15 (Review R4/R6): Kunden-Lock zuerst – Zählung und Anlage sind damit exakt.
      await lockPortalCustomerAuth(tx, candidate.id);
      // Phase 15 (Review R9): parallel in den Papierkorb verschoben ⇒ kein neuer Link.
      // Phase 15 (Nachbesserung R6): Kunde unter dem Lock FRISCH lesen – hat ein E-Mail-Wechsel
      // die Adresse seit der Kandidatensuche geändert, entsteht kein Link an die alte Adresse
      // (Order §35: Login nur mit der neuen Adresse; fail-closed).
      const current = await this.activeCustomer(tx, candidate.id);
      if (current === null || current.email !== email) return 'none' as const;
      if (await this.throttled(tx, { customerId: current.id, purpose: 'login' }, now)) {
        return 'throttled' as const;
      }
      await this.revokeOpenLinks(tx, { customerId: current.id, purpose: 'login' }, now);
      const link = await this.insertLink(tx, { customerId: current.id, purpose: 'login' }, now);
      return { ...link, customer: current };
    });
    if (created === 'none' || created === 'throttled') {
      this.logger.info(
        created === 'throttled'
          ? { reason: created, purpose: 'login', customerId: candidate.id }
          : { reason: created },
        'portal.magic_link.skipped',
      );
      return;
    }
    const { token, linkId, customer } = created;
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
    // Phase 15 (Review R6): Consume + Session-Anlage unter demselben Kunden-Lock wie der
    // E-Mail-Wechsel. Ein paralleler Wechsel widerruft entweder vorher den Link (⇒ 401)
    // oder danach auch die hier angelegte Session – nie überlebt eine Session den Wechsel.
    const result = await this.db.transaction(async (tx) => {
      const customerId = await this.linkCustomerId(tx, token, 'login');
      if (customerId === null) return null;
      await lockPortalCustomerAuth(tx, customerId);
      const link = await this.consumeOpenLink(tx, { token, purpose: 'login' }, now);
      if (link === null) return null;
      // Gelöschter Kunde: Link bleibt verbraucht (Commit), Antwort 401 wie bisher.
      const customer = await this.activeCustomer(tx, link.customerId);
      if (customer === null) return null;
      const { token: sessionToken, session } = await this.sessions.create(
        customer.id,
        now,
        options.userAgentLabel ?? null,
        tx,
      );
      await recordSecurityEvent(tx, {
        type: 'portal.login',
        details: { customerId: customer.id, sessionId: session.id },
      });
      return {
        sessionToken,
        expiresAt: session.expiresAt,
        customerId: customer.id,
        sessionId: session.id,
      };
    });
    if (result === null) throw tokenInvalid();
    return result;
  }

  // ── Reauth (Order §32) ────────────────────────────────────────────────────

  async requestReauth(session: PortalSessionContext, now: Date = new Date()): Promise<void> {
    const customer = await this.activeCustomer(this.db, session.customerId);
    if (customer === null || customer.email === null) {
      // Session ohne aktiven Kunden/ohne Adresse: still (die Session-Prüfung meldet 401).
      this.logger.warn({ reason: 'no_recipient' }, 'portal.reauth.skipped');
      return;
    }
    const created = await this.db.transaction(async (tx) => {
      // Phase 15 (Review R4/R6): Kunden-Lock zuerst; höchstens 5 Reauth-Links je Session/15 min.
      await lockPortalCustomerAuth(tx, customer.id);
      if (
        await this.throttled(
          tx,
          { customerId: customer.id, sessionId: session.sessionId, purpose: 'reauth' },
          now,
        )
      ) {
        return null;
      }
      await this.revokeOpenLinks(tx, { sessionId: session.sessionId, purpose: 'reauth' }, now);
      return this.insertLink(
        tx,
        { customerId: customer.id, purpose: 'reauth', sessionId: session.sessionId },
        now,
      );
    });
    if (created === null) {
      this.logger.info(
        { reason: 'throttled', purpose: 'reauth', sessionId: session.sessionId },
        'portal.magic_link.skipped',
      );
      return;
    }
    const { token, linkId } = created;
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

  /**
   * Phase 15 (Review R8): kein Existenz-Orakel – ist die Adresse bei einem ANDEREN aktiven
   * Kunden hinterlegt, entsteht still kein Link und keine Mail; die Route antwortet identisch
   * (202 `EMAIL_CHANGE_REQUESTED`). Wie bei einer freien Adresse ersetzt die Anforderung
   * offene ältere Wechsel-Links (keine Unterscheidung über deren Gültigkeit). Die
   * Eindeutigkeit entscheidet endgültig der Consume (fail-closed). Ausnahmen bleiben:
   * eigene aktuelle Adresse / ungültiges Format ⇒ 400, ohne frische Reauth ⇒ 403.
   * Phase 15 (Review R4): höchstens 5 Wechsel-Links je Kunde in 15 min, darüber still nichts.
   * Auch eine belegte Adresse verbraucht dieses Kontingent (widerrufene Platzhalterzeile),
   * damit die Drossel nicht verrät, ob die Adresse einem anderen Kunden gehört.
   */
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
    const outcome = await this.db.transaction(async (tx) => {
      // Phase 15 (Review R6): Anforderungen je Kunde serialisiert ⇒ nie zwei offene Wechsel-Links.
      await lockPortalCustomerAuth(tx, customer.id);
      if (await this.throttled(tx, { customerId: customer.id, purpose: 'email_change' }, now)) {
        return 'throttled' as const;
      }
      await this.revokeOpenLinks(tx, { customerId: customer.id, purpose: 'email_change' }, now);
      // Phase 15 (Review R8): belegt ⇒ still kein Link (statt 400 PORTAL_EMAIL_UNAVAILABLE).
      if (await this.emailTakenByOther(tx, email, customer.id)) {
        // Phase 15 (Nachbesserung R8): nie versandte, sofort widerrufene Platzhalterzeile – sie
        // zählt für die Drossel genau wie ein echter Link (kein Seitenkanal über das Kontingent);
        // der Token verlässt diese Methode nie, die Zeile ist nicht konsumierbar.
        await this.insertLink(
          tx,
          {
            customerId: customer.id,
            purpose: 'email_change',
            sessionId: session.sessionId,
            proposedEmail: email,
            revoked: true,
          },
          now,
        );
        return 'unavailable' as const;
      }
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
    if (outcome === 'throttled' || outcome === 'unavailable') {
      this.logger.info(
        { reason: outcome, purpose: 'email_change', customerId: customer.id },
        'portal.magic_link.skipped',
      );
      return;
    }
    const { token, linkId } = outcome;
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
   * Commit des E-Mail-Wechsels: Phase 15 (Review R6) zuerst der Kunden-Lock (Link-Zeile
   * vorher OHNE Sperre gelesen, um die Kunden-ID zu kennen), dann Advisory-Lock je
   * Zieladresse (feste Reihenfolge Kunde → Adresse), atomares Consume,
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
          customerId: customerPortalMagicLinks.customerId,
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
      // Phase 15 (Review R6): Kunden-Lock VOR Adress-Lock und Zeilensperren – parallele
      // Consumes desselben Kunden warten hier statt sich zu verklemmen (vorher 40P01 ⇒ 500).
      await lockPortalCustomerAuth(tx, candidate.customerId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`portal-email-change:${proposedEmail}`}))`,
      );
      const link = await this.consumeOpenLink(tx, { token, purpose: 'email_change' }, now);
      if (link === null || link.sessionId === null || link.customerId !== candidate.customerId) {
        throw tokenInvalid();
      }
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

  /**
   * Phase 15 (Review R4): Wurden im Fenster (15 min) bereits ≥ 5 Links dieses Zwecks
   * für den Kunden (Reauth: für die Session) erzeugt? Zählt alle erzeugten Zeilen –
   * auch verbrauchte/widerrufene. Aufruf nur unter `lockPortalCustomerAuth`.
   */
  private async throttled(
    executor: DatabaseExecutor,
    filter: { customerId: string; sessionId?: string; purpose: CustomerPortalMagicLinkPurpose },
    now: Date,
  ): Promise<boolean> {
    const conditions = [
      eq(customerPortalMagicLinks.customerId, filter.customerId),
      eq(customerPortalMagicLinks.purpose, filter.purpose),
      gt(
        customerPortalMagicLinks.createdAt,
        new Date(now.getTime() - PORTAL_LINK_THROTTLE_WINDOW_MS),
      ),
    ];
    if (filter.sessionId !== undefined) {
      conditions.push(eq(customerPortalMagicLinks.sessionId, filter.sessionId));
    }
    const rows = await executor
      .select({ value: count() })
      .from(customerPortalMagicLinks)
      .where(and(...conditions));
    return (rows[0]?.value ?? 0) >= PORTAL_LINK_THROTTLE_MAX;
  }

  /** Phase 15 (Review R6): Kunden-ID eines Links OHNE Sperre (für den Kunden-Lock vor dem Consume). */
  private async linkCustomerId(
    executor: DatabaseExecutor,
    token: string,
    purpose: CustomerPortalMagicLinkPurpose,
  ): Promise<string | null> {
    const rows = await executor
      .select({ customerId: customerPortalMagicLinks.customerId })
      .from(customerPortalMagicLinks)
      .where(
        and(
          eq(customerPortalMagicLinks.tokenHash, sha256Hex(token)),
          eq(customerPortalMagicLinks.purpose, purpose),
        ),
      );
    return rows[0]?.customerId ?? null;
  }

  private async insertLink(
    executor: DatabaseExecutor,
    input: {
      customerId: string;
      purpose: CustomerPortalMagicLinkPurpose;
      sessionId?: string;
      proposedEmail?: string;
      /** Phase 15 (Nachbesserung R8): Zeile sofort widerrufen (Platzhalter, nie versandt). */
      revoked?: boolean;
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
        revokedAt: input.revoked === true ? now : null,
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
