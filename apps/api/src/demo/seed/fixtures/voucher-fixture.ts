import { randomUUID } from 'node:crypto';
import {
  accountingTransfers,
  lexwareInvoiceMappings,
  processes,
  rentalReturns,
  settlements,
  vouchers,
} from '@mietroyal/database';
import { VOUCHER_TYPE_RETURNING_CUSTOMER, voucherExpiresAt } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { PayloadCrypto } from '../../../communication/payload-crypto.ts';
import { enqueueVoucherDelivery } from '../../../communication/voucher-delivery-job.ts';
import {
  codeSuffix,
  generateVoucherCode,
  hashVoucherCode,
} from '../../../voucher/voucher-codes.ts';
import { DEMO_MESSAGES, DemoError } from '../../types.ts';
import type { DemoScenario, DemoSeedContext } from '../context.ts';
import { DEMO_SEED_KEYS } from '../data.ts';

/**
 * Phase 14 – Fixture-Schicht des Demo-Seeds (Order W1.1, MASTER_SPEC §29).
 *
 * Der Wiedermieter-Gutschein entsteht im normalen Betrieb AUSSCHLIESSLICH über
 * `VoucherService.ensureVoucherForSettlement` – und der verlangt ein an die
 * Buchhaltung übertragenes Ursprungs-Settlement (`transferred`, Transfer
 * `succeeded`) mit Zahlungsstatus „bezahlt“. In der Demo gibt es diese
 * externe Übertragung nie (W1: Gateway `disabled`, kein Mock-Erfolg). Damit
 * der Anschauungszustand „Wiedermieter mit aktivem Gutschein“ trotzdem
 * existiert, erzeugt NUR diese Seed-Schicht einen minimalen synthetischen
 * Fixture-Zustand per direktem Insert in `vouchers`.
 *
 * Regeln (W1.1, verbindlich):
 * - nur `APP_ENV=demo` (sonst DemoError DEMO_ONLY) und nur innerhalb von
 *   `demo:seed` / `demo:reset` (die Fixture ist Teil der kanonischen
 *   Szenarioliste; keine öffentliche oder Staff-API erzeugt diesen Zustand);
 * - kein Faken des Accounting-Gateways: KEIN `accounting_transfer`, kein
 *   Status „success“, KEINE Providerreferenz, KEINE Rechnungsnummer, kein
 *   Lexware-Mapping, kein Webhook – das Ursprungs-Settlement bleibt
 *   `ready_for_accounting` („Bereit zur Buchhaltung“) und wird nicht angefasst;
 * - genau EIN aktiver Gutschein (`status='active'`, `delivery_status='pending'`),
 *   Code nur als SHA-256-Hash + Suffix + verschlüsselte Versandkopie
 *   (PayloadCrypto v2, Purpose `voucher-delivery`, wie der VoucherService) –
 *   der Klartext existiert nur in diesem Aufruf, wird nie geloggt, nie
 *   registriert, nie zurückgegeben; die Registry trägt nur `entity_id`;
 * - danach der NORMALE Versandweg: Job `voucher.delivery` (Mail in der Demo
 *   whitelist-geprüft und mit `[DEMO]`-Betreff ⇒ ohne Whitelist ehrlich
 *   `blocked`/`mail_not_configured`, kein Fake-Versand);
 * - die Voucher-Fachlogik (`validateForOffer`/`reserveForOffer`/`redeem`) bleibt
 *   unverändert – sie prüft Kunde, Status, Ablauf und Reservierung, nicht das
 *   Ursprungs-Settlement; außerhalb des Demo-Seeds gibt es weiterhin keinen
 *   manuellen „Gutschein erzeugen“-Sonderweg;
 * - kein Codepfad für production: die Fixture ist nur in der Demo-Szenarioliste
 *   verdrahtet und verweigert jede andere Umgebung.
 *
 * Ursprung: der abgeschlossene erste Vorgang des Wiedermieters
 * (`process.completed`: Buchung, finalisierte Rückgabe, Abrechnung ohne
 * Transfer). Aktivierung relativ zu `now` (Order §12): am Tag nach dem
 * Reinigungsende dieses Vorgangs, 09:00 Berlin; Ablauf über die Domain-Regel
 * `voucherExpiresAt` (12 Kalendermonate). Idempotent: existiert zum
 * Ursprungs-Settlement bereits ein Gutschein, wird nur registriert.
 */
export const voucherSituationFixture: DemoScenario = {
  name: 'voucher.situation (fixture)',
  async run(ctx) {
    assertDemoFixtureAllowed(ctx);
    const customerId = await ctx.resolve(DEMO_SEED_KEYS.customerPrivateRepeat);
    const processId = await ctx.resolve(DEMO_SEED_KEYS.processCompleted);
    const origin = await loadFixtureOrigin(ctx, processId, customerId);

    const existing = await ctx.db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(eq(vouchers.originSettlementId, origin.settlementId));
    const existingId = existing[0]?.id;
    if (existingId !== undefined) {
      await ctx.register(DEMO_SEED_KEYS.voucherSituation, 'voucher', existingId);
      return;
    }

    const voucherId = randomUUID();
    // Klartext nur hier – weder geloggt noch registriert noch zurückgegeben.
    const code = generateVoucherCode();
    const activatedAt = ctx.clock.at(-11, 9, 0);
    await ctx.db.insert(vouchers).values({
      id: voucherId,
      voucherType: VOUCHER_TYPE_RETURNING_CUSTOMER,
      customerId,
      originProcessId: processId,
      originBookingId: origin.bookingId,
      originReturnId: origin.returnId,
      originSettlementId: origin.settlementId,
      discountPercent: 20,
      codeHash: hashVoucherCode(code),
      codeSuffix: codeSuffix(code),
      status: 'active',
      activatedAt,
      expiresAt: voucherExpiresAt(activatedAt),
      deliveryStatus: 'pending',
      deliveryProblemCode: null,
      deliveryCodeCiphertext: new PayloadCrypto(ctx.config).encrypt(
        code,
        'voucher-delivery',
        voucherId,
      ),
      version: 1,
      createdAt: activatedAt,
      updatedAt: activatedAt,
    });
    await ctx.register(DEMO_SEED_KEYS.voucherSituation, 'voucher', voucherId);
    // Normaler Versandweg (Phase 12): Outbox mit Demo-Whitelist – kein Fake-Versand.
    await enqueueVoucherDelivery(ctx.services.communication.queue, voucherId);
  },
};

/** Fixture nur in der Demo (W1.1) – zusätzlich zum Env-Guard des Seed-Services. */
function assertDemoFixtureAllowed(ctx: Pick<DemoSeedContext, 'config'>): void {
  if (ctx.config.appEnv !== 'demo') {
    throw new DemoError('FORBIDDEN', 'DEMO_ONLY', DEMO_MESSAGES.DEMO_ONLY);
  }
}

/**
 * Ursprungsdaten des Fixture-Gutscheins aus dem abgeschlossenen Vorgang des
 * Wiedermieters. Fail-closed: existiert zu diesem Settlement ein
 * `accounting_transfer` oder ein Lexware-Mapping oder ist es übertragen, wird
 * abgebrochen – die Fixture darf nie neben einer (angeblichen) externen
 * Übertragung stehen.
 */
async function loadFixtureOrigin(
  ctx: Pick<DemoSeedContext, 'db'>,
  processId: string,
  customerId: string,
): Promise<{ bookingId: string; returnId: string; settlementId: string }> {
  const processRows = await ctx.db
    .select({ customerId: processes.customerId })
    .from(processes)
    .where(eq(processes.id, processId));
  if (processRows[0]?.customerId !== customerId) {
    throw new Error(
      'Demo-Seed (voucher.situation): Ursprungsvorgang gehört nicht dem Wiedermieter',
    );
  }
  const settlementRows = await ctx.db
    .select({
      id: settlements.id,
      bookingId: settlements.bookingId,
      returnId: settlements.returnId,
      status: settlements.status,
      accountingTransferId: settlements.accountingTransferId,
      accountingReference: settlements.accountingReference,
    })
    .from(settlements)
    .where(eq(settlements.processId, processId));
  const settlement = settlementRows[0];
  if (settlement === undefined) {
    throw new Error('Demo-Seed (voucher.situation): Abrechnung des Ursprungsvorgangs fehlt');
  }
  if (
    settlement.status === 'transferred' ||
    settlement.accountingTransferId !== null ||
    settlement.accountingReference !== null
  ) {
    throw new Error(
      'Demo-Seed (voucher.situation): Ursprungs-Abrechnung trägt eine Buchhaltungsübertragung – in der Demo unzulässig (W1)',
    );
  }
  const transferRows = await ctx.db
    .select({ id: accountingTransfers.id })
    .from(accountingTransfers)
    .where(eq(accountingTransfers.settlementId, settlement.id));
  if (transferRows.length > 0) {
    throw new Error(
      'Demo-Seed (voucher.situation): accounting_transfer zum Ursprungs-Settlement vorhanden – in der Demo unzulässig (W1)',
    );
  }
  const mappingRows = await ctx.db
    .select({ id: lexwareInvoiceMappings.id })
    .from(lexwareInvoiceMappings)
    .limit(1);
  if (mappingRows.length > 0) {
    throw new Error('Demo-Seed (voucher.situation): Lexware-Mapping in der Demo unzulässig (W1)');
  }
  const returnRows = await ctx.db
    .select({ status: rentalReturns.status })
    .from(rentalReturns)
    .where(eq(rentalReturns.id, settlement.returnId));
  if (returnRows[0]?.status !== 'finalized') {
    throw new Error('Demo-Seed (voucher.situation): Ursprungs-Rückgabe ist nicht finalisiert');
  }
  return {
    bookingId: settlement.bookingId,
    returnId: settlement.returnId,
    settlementId: settlement.id,
  };
}
