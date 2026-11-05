import { cancellations, type Database } from '@mietroyal/database';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import {
  CancellationBlockedError,
  type CancellationService,
  type CancellationViewer,
} from '../cancellation/cancellation-service.ts';
import type { DueScanner } from '../communication/scan-due.ts';
import { PORTAL_MESSAGES, PortalError } from './types.ts';
import type { VisibleBooking } from './visibility.ts';
import type { PortalCancellationPreview } from './views.ts';

/**
 * Phase 15 (Order §38–§44, Design §2.4): Kundenstorno – NUR über den
 * bestehenden `CancellationService` (Phase-9-Regel, Sperren, Freigaben,
 * Gutschein, Buchhaltungspfad unverändert). Der Kunde ist der Actor
 * (`canceler_type = 'customer'`, keine Staff-ID); die Zugehörigkeit der Buchung
 * entscheidet die Visibility-Policy VOR dem Aufruf. Interne Blockertexte,
 * Ressourcenzähler oder Buchhaltungsdetails verlassen den Server nie – der
 * Kunde sieht ausschließlich `PORTAL_MESSAGES.CANCELLATION_BLOCKED`.
 */

/** Schnittstelle zum Storno-Service (schmal, damit Tests/Scanner sie leicht stellen können). */
export type PortalCancellationBackend = Pick<
  CancellationService,
  'preview' | 'cancel' | 'sendConfirmation'
>;

/** Der Kunde hat im Portal keine Staff-Rechte – Sicht ohne Referenzen/Interna. */
export const PORTAL_CANCELLATION_VIEWER: CancellationViewer = {
  permissions: new Set<string>(),
  isAdmin: false,
};

/** Backstop (Order §43): Bestätigungen von Kundenstornos, die nach dieser Karenz noch `prepared` sind. */
export const PORTAL_CANCELLATION_MAIL_BACKSTOP_GRACE_MS = 2 * 60 * 1000;
export const PORTAL_CANCELLATION_MAIL_BACKSTOP_BATCH = 50;

export interface PortalCancellationLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}

export interface PortalCancellationResult {
  cancellationId: string;
  /** true = diese Anfrage hat das Storno ausgelöst; false = bereits storniert (idempotent). */
  created: boolean;
}

export class PortalCancellationService {
  constructor(
    private readonly backend: PortalCancellationBackend,
    private readonly logger?: PortalCancellationLogger,
  ) {}

  /**
   * Vorschau (Order §39): Eventdatum, verbleibende Tage, Satz, reguläre
   * Maschinenmiet-Basis, exakte Gebühr. Blocker ⇒ `allowed:false` mit dem
   * neutralen Kundentext – nie interne Gründe, Maschinen oder Freigabezähler.
   */
  async preview(visible: VisibleBooking, now = new Date()): Promise<PortalCancellationPreview> {
    if (visible.portalState !== 'active') return blockedPreview();
    let preview;
    try {
      preview = await this.backend.preview(visible.process.id, now);
    } catch (error) {
      if (error instanceof AuthError) return blockedPreview();
      throw error;
    }
    const allowed = preview.blockers.length === 0;
    return {
      eventDate: preview.eventDate,
      remainingDays: preview.remainingDays,
      feePercent: preview.feePercent,
      baseCents: preview.baseCents,
      feeCents: preview.feeCents,
      allowed,
      blockedMessage: allowed ? null : PORTAL_MESSAGES.CANCELLATION_BLOCKED,
    };
  }

  /**
   * Verbindliches Storno (Order §40–§43). Doppelklick ⇒ der Service liefert die
   * vorhandene Stornozeile (idempotent, nie eine zweite Belastung). Blocker ⇒
   * `PortalError('CONFLICT','PORTAL_CANCELLATION_BLOCKED')`. Nach dem Commit
   * wird die Stornobestätigung automatisch eingereiht (Idempotenzschlüssel
   * `cancellation_confirmation:<id>`); scheitert das, bleibt das Storno gültig
   * und der Backstop-Scanner holt den Versand nach.
   */
  async cancel(visible: VisibleBooking, now = new Date()): Promise<PortalCancellationResult> {
    // Bereits storniert (erneuter Klick nach Netzabbruch/Reload): idempotent – nie
    // eine zweite Stornierung oder Belastung; die Bestätigung bleibt per Schlüssel einmalig.
    const existing = visible.cancellation;
    if (
      existing !== null &&
      (visible.portalState === 'cancelled_free' || visible.portalState === 'cancelled_fee')
    ) {
      if (existing.cancelerType === 'customer') await this.sendConfirmationSafely(existing.id, now);
      return { cancellationId: existing.id, created: false };
    }
    if (visible.portalState !== 'active') {
      throw new PortalError(
        'CONFLICT',
        'PORTAL_CANCELLATION_BLOCKED',
        PORTAL_MESSAGES.CANCELLATION_BLOCKED,
      );
    }
    const before = visible.cancellation;
    let view;
    try {
      view = await this.backend.cancel(
        visible.process.id,
        { id: null, type: 'customer' },
        PORTAL_CANCELLATION_VIEWER,
        now,
      );
    } catch (error) {
      if (error instanceof CancellationBlockedError || error instanceof AuthError) {
        // Interne Blocker-/Konflikttexte bleiben intern (Order §41).
        throw new PortalError(
          'CONFLICT',
          'PORTAL_CANCELLATION_BLOCKED',
          PORTAL_MESSAGES.CANCELLATION_BLOCKED,
        );
      }
      throw error;
    }
    const created = before === null && new Date(view.cancelledAt).getTime() === now.getTime();
    // Automatische Bestätigung NUR für Kundenstornos (Staff-Stornos behalten
    // ihre bewusste Sendeaktion). Idempotent – ein Doppelklick erzeugt keine Doppelmail.
    if (view.cancelerType === 'customer') {
      await this.sendConfirmationSafely(view.id, now);
    }
    return { cancellationId: view.id, created };
  }

  private async sendConfirmationSafely(cancellationId: string, now: Date): Promise<void> {
    try {
      await this.backend.sendConfirmation(cancellationId, now);
    } catch (error) {
      this.logger?.warn(
        { cancellationId, error: error instanceof Error ? error.name : 'unknown' },
        'Stornobestätigung konnte nicht sofort eingereiht werden – Backstop übernimmt',
      );
    }
  }
}

function blockedPreview(): PortalCancellationPreview {
  return {
    eventDate: null,
    remainingDays: null,
    feePercent: null,
    baseCents: null,
    feeCents: null,
    allowed: false,
    blockedMessage: PORTAL_MESSAGES.CANCELLATION_BLOCKED,
  };
}

/**
 * Backstop-Scanner `portal_cancellation_mail_backstop` (Order §43): Kundenstornos,
 * deren Bestätigung nach 2 Minuten noch `prepared` ist (Crash zwischen Commit
 * und Einreihen), werden über denselben idempotenten Pfad nachgereiht – max.
 * 50 je Lauf, keine Doppelmail (Transaktionsschlüssel). Wiedereröffnete
 * Vorgänge werden übersprungen (der Service lehnt sie ohnehin ab).
 */
export function createPortalCancellationMailBackstopScanner(deps: {
  db: Database;
  confirmations: Pick<CancellationService, 'sendConfirmation'>;
  logger?: PortalCancellationLogger;
}): DueScanner {
  return {
    name: 'portal_cancellation_mail_backstop',
    async scanDue(now: Date) {
      const cutoff = new Date(now.getTime() - PORTAL_CANCELLATION_MAIL_BACKSTOP_GRACE_MS);
      const due = await deps.db
        .select({ id: cancellations.id })
        .from(cancellations)
        .where(
          and(
            eq(cancellations.cancelerType, 'customer'),
            eq(cancellations.confirmationStatus, 'prepared'),
            isNull(cancellations.reopenedAt),
            lt(cancellations.cancelledAt, cutoff),
          ),
        )
        .orderBy(asc(cancellations.cancelledAt))
        .limit(PORTAL_CANCELLATION_MAIL_BACKSTOP_BATCH);
      let enqueued = 0;
      for (const row of due) {
        try {
          await deps.confirmations.sendConfirmation(row.id, now);
          enqueued += 1;
        } catch (error) {
          deps.logger?.warn(
            { cancellationId: row.id, error: error instanceof Error ? error.name : 'unknown' },
            'Backstop: Stornobestätigung konnte nicht eingereiht werden',
          );
        }
      }
      return { scanned: due.length, enqueued };
    },
  };
}
