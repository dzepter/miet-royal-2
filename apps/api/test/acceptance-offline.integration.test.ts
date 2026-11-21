/**
 * Phase 18 – Abnahmeszenario E „Offline-Betrieb“ (Order Szenario 5; systemweit A Idempotenz,
 * B Concurrency, C Datenintegrität; Karte C §4.1/§4.3, Lücken §6.1-1/-7).
 *
 * EIN durchgehender Lauf auf frischer Datenbank (truncate nur in beforeAll) – die Schritte
 * bauen fachlich aufeinander auf wie ein echter Arbeitstag mit Offline-Gerät:
 * - E1 Lease + Paketminimalität (nur Name/Telefon/Lieferadresse, keine E-Mail-/Finanzschlüssel,
 *   Rechte-Snapshot nur operativ),
 * - E2 kompletter Offline-Übergabe-Lebenszyklus, danach Replay JEDER angewendeten Mutation
 *   (`deduplicated: true`, identische resultRef, keine zweite Wirkung),
 * - E3 bisherige Testlücke: DIESELBE clientMutationId gleichzeitig zweimal gesendet; dazu zwei
 *   Geräte, die denselben Vorgang gleichzeitig abschließen,
 * - E4 unterbrochener Lauf („processing“-Quittung): Wiederaufnahme genau einmal, frische
 *   Verarbeitung ⇒ 503 SYNC_IN_PROGRESS,
 * - E5 Serveränderung während der Offline-Arbeit ⇒ Konflikt, nie stilles Überschreiben
 *   (Übergabe UND Rückgabe), Quittungen/Details ohne Kundendaten,
 * - E6 Re-Autorisierung beim Sync (entzogenes Recht, fremde Umgebung + Security-Event),
 * - E7 Invarianten (keine processing-Quittung, genau eine ausgegebene Zuordnung je Maschine)
 *   und der systemweite Integritäts-Backstop (acceptance-integrity).
 *
 * Nur Fakes (Testkontext), keine echten Provider.
 */
import { randomUUID } from 'node:crypto';
import {
  documents,
  handovers,
  inventoryMovements,
  machineAssignments,
  machines,
  mailDeliveries,
  offlineMutationReceipts,
  rentalReturns,
} from '@mietroyal/database';
import { PERMISSION_KEYS, type PermissionKey } from '@mietroyal/permissions';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OFFLINE_RELEVANT_PERMISSIONS } from '../src/offline/lease-service.ts';
import { PROCESSING_STALE_MS } from '../src/offline/sync-service.ts';
import { documentStorageMismatches, integrityViolations } from './acceptance-integrity.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  DAYS,
  HOURS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  readyHandover,
  scheduledBooking,
  type ScheduledBooking,
} from './handover-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import {
  DEVICE,
  DEVICE_B,
  offlineHelpers,
  truncateOfflineWorld,
  type MutationInput,
} from './offline-helpers.ts';
import { schedulingServiceFor } from './scheduling-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;
const h = offlineHelpers(() => ctx);

/** Testkunde der Commerce-Welt – darf in keiner Quittung/keinem Konfliktdetail auftauchen. */
const CUSTOMER_SECRETS = ['Klara', 'Kommerz', '0171 9998877', 'klara.kommerz@test.example'];
const ADMIN_KEYS: PermissionKey[] = [
  'employee.manage',
  'permission.manage',
  'system.settings',
  'settlement.view',
];
const RECOVERED_MESSAGE = 'Bereits übernommen (Wiederaufnahme nach Unterbrechung).';

// ── Szenario-Zustand (die Schritte bauen aufeinander auf) ─────────────────
let admin: { id: string };
let staff: { user: { id: string }; cookie: string };
let bookingH1: ScheduledBooking; // E1/E2: Offline-Übergabe, E5c: Offline-Rückgabe
let bookingH2: ScheduledBooking; // E3a: gleiche clientMutationId gleichzeitig
let finalizeH2: MutationInput;
let finalizeH2ResultRef: unknown;
let bookingH5: ScheduledBooking; // E5/E6: Serveränderungen, Re-Autorisierung

interface SlotSnapshot {
  id: string;
  status: string;
  machine: { id: string; machineCode: string } | null;
  overrideStale: boolean;
}
interface HandoverSnapshot {
  handover: { status: string; recipientKind: string };
  slots: SlotSnapshot[];
}

type Package = Awaited<ReturnType<typeof h.packageFor>>;
type BookingSnapshot = Package['bookings'][number];

function snapshotOf(pkg: Package, bookingId: string): BookingSnapshot {
  const snapshot = pkg.bookings.find((b) => b.bookingId === bookingId);
  if (snapshot === undefined) throw new Error(`Buchung ${bookingId} fehlt im Paket`);
  return snapshot;
}

function handoverOf(snapshot: BookingSnapshot): HandoverSnapshot {
  if (snapshot.handover === null) throw new Error('Übergabesicht fehlt im Paket');
  return snapshot.handover as unknown as HandoverSnapshot;
}

/** Basisstand einer Buchungs-Mutation aus dem Paket (Ausgabetermin). */
function outboundBase(snapshot: BookingSnapshot) {
  const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
  return {
    processStatus: 'open',
    appointmentId: outbound.id,
    appointmentVersion: outbound.version,
  };
}

interface JsonEntry {
  path: string;
  key: string;
  value: unknown;
}

/** Alle Schlüssel/Werte eines JSON-Baums (Tiefenscan für Datenminimierung). */
function deepEntries(value: unknown, path = '$', out: JsonEntry[] = []): JsonEntry[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => deepEntries(item, `${path}[${index}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push({ path: `${path}.${key}`, key, value: child });
      deepEntries(child, `${path}.${key}`, out);
    }
  }
  return out;
}

/**
 * Schlüssel, die im Offline-Paket nie einen Wert tragen dürfen (Order §11 Datenminimierung):
 * E-Mail, Bank-/Steuer-/Rechnungsdaten, Beträge, Zugangsgeheimnisse. `billingMode` der
 * Lieferscheinposition (fixed/commission/included) ist eine Fachart, kein Rechnungsdatum.
 */
const FORBIDDEN_PACKAGE_KEYS =
  /^(.*e-?mail.*|iban|bic|vatid|taxid|taxnumber|costcenter|billing(?!mode$).*|amountcents|totalcents|depositcents|.*price|passwordhash|totp.*|qrtoken|leasesecret)$/i;
/**
 * Dokumentiertes, akzeptiertes Restrisiko (TECH_DECISIONS „Restrisiken“ (2)): die Preis-
 * Snapshots der Lieferscheinpositionen (`unitPriceCents`), weil die bestehenden Wizards sie
 * anzeigen – kein weiterer Betrags-Schlüssel darf im Paket erscheinen.
 */
const ALLOWED_CENTS_KEYS = ['unitPriceCents'];
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

async function issueMovementCount(): Promise<number> {
  return (
    await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'issue'))
  ).length;
}

async function documentsOf(bookingId: string) {
  return ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId));
}

async function handoverRow(bookingId: string) {
  const rows = await ctx.db.select().from(handovers).where(eq(handovers.bookingId, bookingId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function evidenceCounts(bookingId: string) {
  const result = await ctx.pool.query<{ checks: number; photos: number; signatures: number }>(
    `SELECT
       (SELECT count(*)::int FROM handover_machine_checks c JOIN handovers h ON h.id = c.handover_id WHERE h.booking_id = $1) AS checks,
       (SELECT count(*)::int FROM handover_photos p JOIN handovers h ON h.id = p.handover_id WHERE h.booking_id = $1) AS photos,
       (SELECT count(*)::int FROM handover_signatures s JOIN handovers h ON h.id = s.handover_id WHERE h.booking_id = $1) AS signatures`,
    [bookingId],
  );
  return result.rows[0]!;
}

async function sentProtocolMails(bookingId: string) {
  return (
    await ctx.db
      .select()
      .from(mailDeliveries)
      .where(
        and(eq(mailDeliveries.bookingId, bookingId), eq(mailDeliveries.kind, 'handover_protocol')),
      )
  ).filter((row) => row.status === 'sent');
}

async function receiptOf(clientMutationId: string) {
  const rows = await ctx.db
    .select()
    .from(offlineMutationReceipts)
    .where(eq(offlineMutationReceipts.clientMutationId, clientMutationId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function receiptCount(): Promise<number> {
  return (await ctx.db.select().from(offlineMutationReceipts)).length;
}

async function processingReceipts() {
  return (await ctx.db.select().from(offlineMutationReceipts)).filter(
    (r) => r.status === 'processing',
  );
}

/**
 * Abbruch ZWISCHEN Fach-Commit und Quittung simulieren (Muster offline-idempotency): die
 * bereits angewendete Mutation steht wieder als veraltetes „processing“ ohne Ergebnis da.
 */
async function crashAfterCommit(clientMutationId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE offline_mutation_receipts
       SET status = 'processing', processed_at = now() - make_interval(secs => $2),
           result_ref = NULL, error_code = NULL, message = NULL
     WHERE client_mutation_id = $1`,
    [clientMutationId, PROCESSING_STALE_MS / 1000 + 60],
  );
}

/** Frische „processing“-Reservierung (laufender Sync einer anderen Instanz) OHNE Fachwirkung. */
async function reserveProcessingNow(
  clientMutationId: string,
  staffUserId: string,
  type: string,
  contextId: string,
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO offline_mutation_receipts
       (client_mutation_id, staff_user_id, device_id, app_env, operation_type, context_kind,
        context_id, status, result_ref, error_code, message, client_created_at, processed_at)
     VALUES ($1, $2, $3, 'development', $4, 'booking', $5, 'processing', NULL, NULL, NULL, now(), now())`,
    [clientMutationId, staffUserId, DEVICE, type, contextId],
  );
}

async function ageProcessingReceipt(clientMutationId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE offline_mutation_receipts SET processed_at = now() - make_interval(secs => $2)
     WHERE client_mutation_id = $1 AND status = 'processing'`,
    [clientMutationId, PROCESSING_STALE_MS / 1000 + 60],
  );
}

function expectDeduplicated(
  replay: { json: Record<string, unknown> },
  original: { json: Record<string, unknown> },
) {
  expect(replay.json.status).toBe('applied');
  expect(replay.json.deduplicated).toBe(true);
  expect(replay.json.resultRef).toEqual(original.json.resultRef);
}

function expectNoCustomerData(text: string) {
  for (const secret of CUSTOMER_SECRETS) expect(text).not.toContain(secret);
  expect(text).not.toContain('dataBase64');
}

beforeAll(async () => {
  ctx = await createTestContext();
  await truncateOfflineWorld(ctx);
  const session = await h.adminSession();
  admin = session.admin;
  await initializeAllInventory(ctx, admin.id, 20);
  // Operative Kraft mit Offline-Gerät (zusätzliche Admin-/Finanzrechte beweisen den Rechte-Snapshot in E1).
  staff = await h.staffWith(admin.id, [...h.OPERATIVE, ...ADMIN_KEYS], 'Abnahme');
});
afterAll(async () => {
  await destroyTestContext(ctx);
});

describe('Szenario E – Offline-Betrieb (Phase 18)', () => {
  it('P18-E1. Lease und Arbeitspaket sind minimal: Kontakt nur Name/Telefon(/Lieferadresse), keine E-Mail-/Finanzschlüssel, Rechte-Snapshot nur operativ', async () => {
    bookingH1 = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * HOURS),
      to: new Date(Date.now() + 2 * DAYS),
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 3 }],
    });
    const delivery = await scheduledBooking(ctx, admin.id, {
      fulfillment: 'delivery',
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 2 * DAYS),
    });

    // Lease (72 h) nur für operative Konten; der Rechte-Snapshot enthält nie Admin-/Finanzrechte.
    const lease = await h.lease(staff.cookie);
    expect(lease.statusCode).toBe(200);
    const grant = lease.json() as { permissions: string[]; issuedAt: string; expiresAt: string };
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(72 * HOURS);
    for (const key of grant.permissions) expect(OFFLINE_RELEVANT_PERMISSIONS).toContain(key);
    for (const key of ADMIN_KEYS) expect(grant.permissions).not.toContain(key);

    const pkg = await h.packageFor(staff.cookie);
    expect(pkg.environment).toBe('development');
    expect(pkg.truncated).toBe(false);
    expect(pkg.permissions).toContain('handover.perform');
    for (const key of pkg.permissions) expect(OFFLINE_RELEVANT_PERMISSIONS).toContain(key);
    for (const key of ADMIN_KEYS) expect(pkg.permissions).not.toContain(key);

    // Kontaktdaten: exakt Name, Telefon, Lieferadresse (nur bei Lieferung).
    const pickup = snapshotOf(pkg, bookingH1.bookingId);
    expect(Object.keys(pickup.customer).sort()).toEqual(['deliveryAddressLines', 'name', 'phone']);
    expect(pickup.customer.name).toBe('Kommerz, Klara'); // Anzeigename, keine weiteren Stammdaten
    expect(pickup.customer.phone).toBe('0171 9998877');
    expect(pickup.customer.deliveryAddressLines).toEqual([]);
    expect(pickup.relevance).toContain('handover');
    expect(handoverOf(pickup).slots).toHaveLength(1);
    const delivered = snapshotOf(pkg, delivery.bookingId);
    expect(delivered.customer.deliveryAddressLines).toEqual(['Lieferweg 12', '55129 Mainz']);

    // Tiefenscan des gesamten Pakets: keine E-Mail-/Finanz-/Geheimnis-Schlüssel mit Wert.
    const entries = deepEntries(pkg);
    const leaking = entries.filter(
      (e) =>
        FORBIDDEN_PACKAGE_KEYS.test(e.key) &&
        e.value !== null &&
        e.value !== undefined &&
        e.value !== '',
    );
    expect(leaking.map((e) => `${e.path}=${String(e.value)}`)).toEqual([]);
    // Die Phase-6-Sicht trägt den Schlüssel `customerEmail` – im Paket immer null (package-service).
    const emailKeys = entries.filter((e) => e.key === 'customerEmail');
    expect(emailKeys.length).toBeGreaterThan(0);
    expect(emailKeys.every((e) => e.value === null)).toBe(true);
    // Beträge: ausschließlich der dokumentierte Preis-Snapshot der Lieferscheinpositionen.
    const centsKeys = [...new Set(entries.filter((e) => /cents$/i.test(e.key)).map((e) => e.key))];
    expect(centsKeys.length).toBeGreaterThan(0);
    expect(centsKeys.filter((key) => !ALLOWED_CENTS_KEYS.includes(key))).toEqual([]);
    // Kein String-Wert ist eine E-Mail-Adresse; keine Zugangsgeheimnisse im Rohtext.
    const emailValues = entries.filter(
      (e) => typeof e.value === 'string' && EMAIL_PATTERN.test(e.value),
    );
    expect(emailValues.map((e) => e.path)).toEqual([]);
    const raw = JSON.stringify(pkg);
    expect(raw).not.toContain('klara.kommerz@test.example');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('qrToken');
    expect(raw).not.toContain('leaseSecret');
    for (const machine of pkg.machines) expect(machine.qrHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('P18-E2. Offline-Übergabe-Lebenszyklus: alle Schritte applied; Replay JEDER Mutation ⇒ deduplicated, identische resultRef, keine zweite Wirkung', async () => {
    const machineM1 = await machineByCode(ctx.db, 'MR-10-01-01');
    const pkg = await h.packageFor(staff.cookie);
    const snapshot = snapshotOf(pkg, bookingH1.bookingId);
    const slotId = handoverOf(snapshot).slots[0]!.id;
    const candidate = snapshot.candidateMachines[slotId]!.find(
      (c) => c.machineId === machineM1.id,
    )!;
    expect(candidate.overrideRequired).toBe(false);
    expect(candidate.hardBlocked).toBe(false);
    const base = outboundBase(snapshot);
    const bookingId = bookingH1.bookingId;
    const photoMedia = randomUUID();
    const customerSig = randomUUID();
    const staffSig = randomUUID();
    // Erfasst vor 5 Minuten (offline), Mutation im selben Moment erstellt – wie der Client.
    const capturedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const chain: MutationInput[] = [
      {
        id: randomUUID(),
        type: 'handover.assign',
        contextId: bookingId,
        base: { ...base, expectedMachineId: null },
        payload: {
          assignmentId: slotId,
          machineId: machineM1.id,
          override: null,
          situationFingerprint: candidate.situationFingerprint,
        },
      },
      {
        id: randomUUID(),
        type: 'handover.prepare',
        contextId: bookingId,
        base: { ...base, expectedMachineId: machineM1.id },
        payload: { assignmentId: slotId },
      },
      {
        id: randomUUID(),
        type: 'handover.recipient',
        contextId: bookingId,
        base,
        payload: { kind: 'customer', name: null, phone: null },
      },
      {
        id: randomUUID(),
        type: 'handover.check_machine',
        contextId: bookingId,
        base,
        payload: { assignmentId: slotId, machineId: machineM1.id },
      },
      {
        id: randomUUID(),
        type: 'handover.photo',
        contextId: bookingId,
        base,
        payload: { assignmentId: slotId, machineId: machineM1.id, mediaId: photoMedia },
        media: [
          {
            mediaId: photoMedia,
            purpose: 'handover_photo',
            mimeType: 'image/png',
            bytes: pngBytes(),
          },
        ],
      },
      {
        id: randomUUID(),
        type: 'handover.signature',
        contextId: bookingId,
        base,
        payload: { role: 'customer', mediaId: customerSig },
        media: [
          {
            mediaId: customerSig,
            purpose: 'handover_signature',
            mimeType: 'image/png',
            bytes: pngBytes(),
          },
        ],
      },
      {
        id: randomUUID(),
        type: 'handover.signature',
        contextId: bookingId,
        base,
        payload: { role: 'staff', mediaId: staffSig },
        media: [
          {
            mediaId: staffSig,
            purpose: 'handover_signature',
            mimeType: 'image/png',
            bytes: pngBytes(),
          },
        ],
      },
      {
        id: randomUUID(),
        type: 'handover.finalize',
        contextId: bookingId,
        base,
        createdAt: capturedAt,
        payload: {
          capturedAt,
          expectedSlots: [{ assignmentId: slotId, machineId: machineM1.id }],
        },
      },
    ];

    // Erstübertragung in Erfassungsreihenfolge: jede Mutation genau einmal angewendet.
    const originals: { json: Record<string, unknown> }[] = [];
    for (const input of chain) {
      const outcome = await h.sync(staff.cookie, input);
      expect(outcome.response.statusCode).toBe(200);
      expect(outcome.json.status).toBe('applied');
      expect(outcome.json.deduplicated).toBe(false);
      originals.push(outcome);
    }
    await settleMailJobs(ctx);

    // Serverzustand nach der Finalisierung.
    const finalized = await handoverRow(bookingId);
    expect(finalized.status).toBe('finalized');
    expect(finalized.finalizedBy).toBe(staff.user.id);
    expect(finalized.actualIssueAt?.toISOString()).toBe(capturedAt);
    expect((await documentsOf(bookingId)).map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
    ]);
    const issuesBefore = await issueMovementCount();
    expect(issuesBefore).toBeGreaterThan(0);
    const evidenceBefore = await evidenceCounts(bookingId);
    expect(evidenceBefore).toEqual({ checks: 1, photos: 1, signatures: 2 });
    expect(await sentProtocolMails(bookingId)).toHaveLength(1);
    const mailsBefore = (await ctx.db.select().from(mailDeliveries)).length;
    const receiptsBefore = await receiptCount();
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('rented');

    // Replay JEDER angewendeten Mutation (Retry des Geräts nach Verbindungsabbruch).
    for (const [index, input] of chain.entries()) {
      const replay = await h.sync(staff.cookie, input);
      expect(replay.response.statusCode).toBe(200);
      expectDeduplicated(replay, originals[index]!);
    }
    // Keine zweite Wirkung: Zähler unverändert.
    expect(await issueMovementCount()).toBe(issuesBefore);
    expect(await documentsOf(bookingId)).toHaveLength(2);
    expect(await evidenceCounts(bookingId)).toEqual(evidenceBefore);
    expect((await ctx.db.select().from(mailDeliveries)).length).toBe(mailsBefore);
    expect(await sentProtocolMails(bookingId)).toHaveLength(1);
    expect(await receiptCount()).toBe(receiptsBefore);
    expect((await handoverRow(bookingId)).finalizedAt?.toISOString()).toBe(
      finalized.finalizedAt?.toISOString(),
    );
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('rented');
    expect(await processingReceipts()).toHaveLength(0);
    for (const receipt of await ctx.db.select().from(offlineMutationReceipts)) {
      expectNoCustomerData(JSON.stringify(receipt));
    }
  });

  it('P18-E3. Gleichzeitiger Doppel-Upload DERSELBEN clientMutationId ⇒ genau eine Anwendung; zwei Geräte ⇒ genau eine Finalisierung, Verlierer ALREADY_FINALIZED', async () => {
    // (a) Bisherige Testlücke (Karte C §6.1-1): dieselbe Finalisierungs-Mutation wird vom selben
    // Gerät zweimal GLEICHZEITIG gesendet (z. B. Retry bei vermeintlichem Timeout).
    bookingH2 = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * HOURS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    await readyHandover(ctx, admin.id, bookingH2.bookingId, ['MR-10-01-02']);
    const machineM2 = await machineByCode(ctx.db, 'MR-10-01-02');
    let pkg = await h.packageFor(staff.cookie);
    let snapshot = snapshotOf(pkg, bookingH2.bookingId);
    let slot = handoverOf(snapshot).slots[0]!;
    expect(slot.machine?.id).toBe(machineM2.id);
    const capturedAtH2 = new Date(Date.now() - 2 * 60_000).toISOString();
    finalizeH2 = {
      id: randomUUID(),
      type: 'handover.finalize',
      contextId: bookingH2.bookingId,
      base: outboundBase(snapshot),
      createdAt: capturedAtH2,
      payload: {
        capturedAt: capturedAtH2,
        expectedSlots: [{ assignmentId: slot.id, machineId: machineM2.id }],
      },
    };
    const issuesBefore = await issueMovementCount();
    const [first, second] = await Promise.all([
      h.sync(staff.cookie, finalizeH2),
      h.sync(staff.cookie, finalizeH2),
    ]);
    const outcomes = [first, second];
    const applied = outcomes.filter(
      (r) =>
        r.response.statusCode === 200 &&
        r.json.status === 'applied' &&
        r.json.deduplicated === false,
    );
    expect(applied).toHaveLength(1);
    finalizeH2ResultRef = applied[0]!.json.resultRef;
    expect((finalizeH2ResultRef as { handoverId: string }).handoverId).toMatch(/^[0-9a-f-]{36}$/);
    const other = outcomes.find((r) => r !== applied[0])!;
    // Beide Ausgänge sind per Design zulässig: innerhalb EINER API-Instanz serialisiert der
    // KeyedMutex je Mutations-ID ⇒ `applied, deduplicated: true`; über Instanzen hinweg sieht
    // der zweite Upload die frische „processing“-Quittung ⇒ 503 SYNC_IN_PROGRESS + Retry-After.
    const otherKind = other.response.statusCode === 200 ? 'deduplicated' : 'in_progress';
    expect(['deduplicated', 'in_progress']).toContain(otherKind);
    if (otherKind === 'deduplicated') {
      expectDeduplicated(other, applied[0]!);
    } else {
      expect(other.response.statusCode).toBe(503);
      expect((other.json.error as { code: string }).code).toBe('SYNC_IN_PROGRESS');
      expect(other.response.headers['retry-after']).toBe('5');
    }
    // Fachwirkung genau einmal.
    const h2 = await handoverRow(bookingH2.bookingId);
    expect(h2.status).toBe('finalized');
    expect(h2.finalizedBy).toBe(staff.user.id);
    expect((await documentsOf(bookingH2.bookingId)).map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
    ]);
    const issuesAfter = await issueMovementCount();
    expect(issuesAfter).toBeGreaterThan(issuesBefore);
    expect((await receiptOf(finalizeH2.id!)).status).toBe('applied');
    expect(await processingReceipts()).toHaveLength(0);
    // Späterer sequenzieller Retry derselben ID bleibt wirkungslos.
    expectDeduplicated(await h.sync(staff.cookie, finalizeH2), applied[0]!);
    expect(await issueMovementCount()).toBe(issuesAfter);
    expect(await documentsOf(bookingH2.bookingId)).toHaveLength(2);
    expect((await machineByCode(ctx.db, 'MR-10-01-02')).status).toBe('rented');

    // (b) Zwei Geräte schließen denselben Vorgang GLEICHZEITIG mit eigenen IDs ab (§67).
    const bookingH3 = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * HOURS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    await readyHandover(ctx, admin.id, bookingH3.bookingId, ['MR-10-01-03']);
    const machineM3 = await machineByCode(ctx.db, 'MR-10-01-03');
    expect((await h.lease(staff.cookie, DEVICE_B)).statusCode).toBe(200);
    pkg = await h.packageFor(staff.cookie);
    snapshot = snapshotOf(pkg, bookingH3.bookingId);
    slot = handoverOf(snapshot).slots[0]!;
    const capturedAtH3 = new Date(Date.now() - 60_000).toISOString();
    const finalizeA: MutationInput = {
      id: randomUUID(),
      type: 'handover.finalize',
      contextId: bookingH3.bookingId,
      base: outboundBase(snapshot),
      createdAt: capturedAtH3,
      payload: {
        capturedAt: capturedAtH3,
        expectedSlots: [{ assignmentId: slot.id, machineId: machineM3.id }],
      },
    };
    const finalizeB: MutationInput = { ...finalizeA, id: randomUUID() };
    const issuesBeforeH3 = await issueMovementCount();
    const [deviceA, deviceB] = await Promise.all([
      h.sync(staff.cookie, finalizeA),
      h.sync(staff.cookie, finalizeB, { deviceId: DEVICE_B }),
    ]);
    const pair = [deviceA, deviceB];
    expect(pair.filter((r) => r.json.status === 'applied')).toHaveLength(1);
    const loser = pair.find((r) => r.json.status === 'conflict')!;
    expect(loser.json.code).toBe('ALREADY_FINALIZED');
    expect(loser.json.resultRef).toBeNull();
    expect((await handoverRow(bookingH3.bookingId)).status).toBe('finalized');
    expect(await documentsOf(bookingH3.bookingId)).toHaveLength(2);
    const issuesAfterH3 = await issueMovementCount();
    expect(issuesAfterH3).toBeGreaterThan(issuesBeforeH3);
    // Verlierer-Retry („Erneut anwenden“) bewertet neu – bleibt Konflikt, keine zweite Wirkung.
    const loserInput = loser === deviceA ? finalizeA : finalizeB;
    const retried = await h.sync(staff.cookie, loserInput, {
      deviceId: loser === deviceA ? DEVICE : DEVICE_B,
    });
    expect(retried.json.status).toBe('conflict');
    expect(retried.json.code).toBe('ALREADY_FINALIZED');
    expect(await issueMovementCount()).toBe(issuesAfterH3);
    expect(await documentsOf(bookingH3.bookingId)).toHaveLength(2);
    const receiptA = await receiptOf(finalizeA.id!);
    const receiptB = await receiptOf(finalizeB.id!);
    expect([receiptA.status, receiptB.status].sort()).toEqual(['applied', 'conflict']);
    expect([receiptA.errorCode, receiptB.errorCode].filter(Boolean)).toEqual(['ALREADY_FINALIZED']);
    expect(await processingReceipts()).toHaveLength(0);
    await settleMailJobs(ctx);
    expect(await sentProtocolMails(bookingH2.bookingId)).toHaveLength(1);
    expect(await sentProtocolMails(bookingH3.bookingId)).toHaveLength(1);
  });

  it('P18-E4. Unterbrochener Lauf: veraltete processing-Quittung ⇒ Wiederaufnahme ohne zweite Wirkung; frische processing-Quittung ⇒ 503 SYNC_IN_PROGRESS, danach genau eine Ausführung', async () => {
    // (a) Absturz zwischen Fach-Commit und Quittung der Finalisierung aus E3a: Replay findet die
    // bereits erfolgte Wirkung (Abschluss nach Reservierung, durch denselben Benutzer) wieder.
    const docsBefore = await documentsOf(bookingH2.bookingId);
    const issuesBefore = await issueMovementCount();
    const mailsBefore = (await ctx.db.select().from(mailDeliveries)).length;
    await crashAfterCommit(finalizeH2.id!);
    expect((await receiptOf(finalizeH2.id!)).status).toBe('processing');
    const recovered = await h.sync(staff.cookie, finalizeH2);
    expect(recovered.response.statusCode).toBe(200);
    expect(recovered.json.status).toBe('applied');
    expect(recovered.json.deduplicated).toBe(true);
    expect(recovered.json.message).toBe(RECOVERED_MESSAGE);
    expect(recovered.json.resultRef).toEqual(finalizeH2ResultRef);
    const receipt = await receiptOf(finalizeH2.id!);
    expect(receipt.status).toBe('applied');
    expect(receipt.errorCode).toBeNull();
    expect(receipt.resultRef).toEqual(finalizeH2ResultRef);
    expect(await documentsOf(bookingH2.bookingId)).toHaveLength(docsBefore.length);
    expect(await issueMovementCount()).toBe(issuesBefore);
    expect((await ctx.db.select().from(mailDeliveries)).length).toBe(mailsBefore);
    expect((await handoverRow(bookingH2.bookingId)).status).toBe('finalized');
    // Normale Quittungs-Deduplikation danach.
    expect((await h.sync(staff.cookie, finalizeH2)).json.deduplicated).toBe(true);

    // (b) Eine andere Instanz verarbeitet die Mutation GERADE (frische Reservierung < 2 min):
    // kein stilles Doppelausführen, sondern 503 mit Retry-After – später genau eine Ausführung.
    const bookingH4 = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * HOURS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const services = handoverServicesFor(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const machineM4 = await machineByCode(ctx.db, 'MR-10-01-04');
    const slotH4 = (await services.handover.detail(bookingH4.bookingId)).slots[0]!;
    await services.assignments.assign(admin.id, effective, slotH4.id, machineM4.id, null);
    const pkg = await h.packageFor(staff.cookie);
    const snapshot = snapshotOf(pkg, bookingH4.bookingId);
    const check: MutationInput = {
      id: randomUUID(),
      type: 'handover.check_machine',
      contextId: bookingH4.bookingId,
      base: outboundBase(snapshot),
      payload: { assignmentId: slotH4.id, machineId: machineM4.id },
    };
    await reserveProcessingNow(check.id!, staff.user.id, check.type, bookingH4.bookingId);
    const inProgress = await h.sync(staff.cookie, check);
    expect(inProgress.response.statusCode).toBe(503);
    expect((inProgress.json.error as { code: string }).code).toBe('SYNC_IN_PROGRESS');
    expect(inProgress.response.headers['retry-after']).toBe('5');
    expect((await evidenceCounts(bookingH4.bookingId)).checks).toBe(0);
    expect((await receiptOf(check.id!)).status).toBe('processing');
    // Reservierung veraltet (Instanz ist nachweislich nicht mehr aktiv) und ohne Wirkung ⇒
    // normale Ausführung genau einmal, danach Deduplikation.
    await ageProcessingReceipt(check.id!);
    const executed = await h.sync(staff.cookie, check);
    expect(executed.json.status).toBe('applied');
    expect(executed.json.deduplicated).toBe(false);
    expect((await evidenceCounts(bookingH4.bookingId)).checks).toBe(1);
    expectDeduplicated(await h.sync(staff.cookie, check), executed);
    expect((await evidenceCounts(bookingH4.bookingId)).checks).toBe(1);
    expect((await receiptOf(check.id!)).status).toBe('applied');
    expect(await processingReceipts()).toHaveLength(0);
  });

  it('P18-E5. Serveränderung während der Offline-Arbeit ⇒ Konflikt statt stillem Überschreiben: MACHINE_REASSIGNED, MACHINE_UNAVAILABLE, Rückgabe APPOINTMENT_CHANGED/SERVER_STATE_CHANGED', async () => {
    const services = handoverServicesFor(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const collected: { response: Record<string, unknown>; id: string }[] = [];
    const conflict = async (input: MutationInput, code: string) => {
      const outcome = await h.sync(staff.cookie, input);
      expect(outcome.response.statusCode).toBe(200);
      expect(outcome.json.status).toBe('conflict');
      expect(outcome.json.code).toBe(code);
      expect(outcome.json.resultRef).toBeNull();
      const details = outcome.json.details as { offline: unknown; server: string; action: string };
      expect(details.server).toBeTruthy();
      expect(details.action).toBeTruthy();
      collected.push({ response: outcome.json, id: outcome.id });
      return outcome;
    };

    // (a) Das Gerät kennt Maschine M5 im Slot; der Server hat inzwischen M6 zugewiesen.
    bookingH5 = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * HOURS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const machineM1 = await machineByCode(ctx.db, 'MR-10-01-01'); // seit E2 an H1 ausgegeben
    const machineM5 = await machineByCode(ctx.db, 'MR-10-01-05');
    const machineM6 = await machineByCode(ctx.db, 'MR-10-01-06');
    const slotH5 = (await services.handover.detail(bookingH5.bookingId)).slots[0]!;
    await services.assignments.assign(admin.id, effective, slotH5.id, machineM5.id, null);
    const pkg = await h.packageFor(staff.cookie); // Offline-Stand: M5 zugewiesen
    const snapshot = snapshotOf(pkg, bookingH5.bookingId);
    expect(handoverOf(snapshot).slots[0]!.machine?.id).toBe(machineM5.id);
    const base = outboundBase(snapshot);
    await services.assignments.assign(admin.id, effective, slotH5.id, machineM6.id, null);
    const staleCheck = await conflict(
      {
        type: 'handover.check_machine',
        contextId: bookingH5.bookingId,
        base,
        payload: { assignmentId: slotH5.id, machineId: machineM5.id },
      },
      'MACHINE_REASSIGNED',
    );
    expect((staleCheck.json.details as { server: string }).server).toContain('MR-10-01-06');
    await conflict(
      {
        type: 'handover.assign',
        contextId: bookingH5.bookingId,
        base: { ...base, expectedMachineId: machineM5.id },
        payload: {
          assignmentId: slotH5.id,
          machineId: machineM5.id,
          override: null,
          situationFingerprint: null,
        },
      },
      'MACHINE_REASSIGNED',
    );
    // Serverstand unverändert: M6 bleibt zugewiesen, nichts wurde geprüft.
    const afterReassign = await services.handover.detail(bookingH5.bookingId);
    expect(afterReassign.slots[0]!.machine?.id).toBe(machineM6.id);
    expect(afterReassign.machines[0]!.checked).toBe(false);

    // (b) Offline gewählte Maschine ist inzwischen an einen anderen Vorgang ausgegeben (hart).
    const unavailable = await conflict(
      {
        type: 'handover.assign',
        contextId: bookingH5.bookingId,
        base: { ...base, expectedMachineId: machineM6.id },
        payload: {
          assignmentId: slotH5.id,
          machineId: machineM1.id,
          override: null,
          situationFingerprint: null,
        },
      },
      'MACHINE_UNAVAILABLE',
    );
    expect((unavailable.json.details as { server: string }).server).toContain('MR-10-01-01');
    expect((await services.handover.detail(bookingH5.bookingId)).slots[0]!.machine?.id).toBe(
      machineM6.id,
    );
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('rented');
    const issuedH1 = await ctx.db
      .select()
      .from(machineAssignments)
      .where(eq(machineAssignments.bookingId, bookingH1.bookingId));
    expect(issuedH1.map((a) => a.status)).toEqual(['issued']);

    // (c) Offline begonnene Rückgabe (H1): Server verschiebt den Rückgabetermin bzw. die
    // Maschinenmenge passt nicht mehr ⇒ Abschluss wird abgewiesen, Rückgabe bleibt offen.
    const returnPkg = await h.packageFor(staff.cookie);
    const h1 = snapshotOf(returnPkg, bookingH1.bookingId);
    expect(h1.returnStartable).toBe(true);
    const seedMachine = h1.returnSeed!.machines[0]!;
    const returnAppointment = h1.appointments.find((a) => a.kind === 'return')!;
    const returnBase = {
      processStatus: 'open',
      appointmentId: returnAppointment.id,
      appointmentVersion: returnAppointment.version,
    };
    const started = await h.sync(staff.cookie, {
      type: 'return.start',
      contextId: bookingH1.bookingId,
      base: returnBase,
      payload: {},
    });
    expect(started.json.status).toBe('applied');
    await schedulingServiceFor(ctx).reschedule(admin.id, returnAppointment.id, {
      startAt: new Date(Date.now() + 4 * DAYS),
      endAt: null,
      expectedVersion: returnAppointment.version,
    });
    const capturedAt = new Date().toISOString();
    const appointmentChanged = await conflict(
      {
        type: 'return.finalize',
        contextId: bookingH1.bookingId,
        base: returnBase,
        payload: {
          capturedAt,
          expectedMachines: [
            { assignmentId: seedMachine.assignmentId, machineId: seedMachine.machineId },
          ],
        },
      },
      'APPOINTMENT_CHANGED',
    );
    expect((appointmentChanged.json.details as { server: string }).server).toContain('Rückgabe');
    await conflict(
      {
        type: 'return.finalize',
        contextId: bookingH1.bookingId,
        base: { ...returnBase, appointmentVersion: returnAppointment.version + 1 },
        payload: { capturedAt, expectedMachines: [] },
      },
      'SERVER_STATE_CHANGED',
    );
    const returnRows = await ctx.db
      .select()
      .from(rentalReturns)
      .where(eq(rentalReturns.bookingId, bookingH1.bookingId));
    expect(returnRows).toHaveLength(1);
    expect(returnRows[0]!.status).not.toBe('finalized');
    expect((await documentsOf(bookingH1.bookingId)).map((d) => d.type)).not.toContain(
      'return_protocol',
    );
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'return')),
    ).toHaveLength(0);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('rented');

    // Jeder Konflikt hinterlässt eine `conflict`-Quittung mit Code – ohne Kundendaten.
    expect(collected).toHaveLength(5);
    for (const entry of collected) {
      const receipt = await receiptOf(entry.id);
      expect(receipt.status).toBe('conflict');
      expect(receipt.errorCode).toBe(entry.response.code);
      expect(receipt.resultRef).toBeNull();
      expectNoCustomerData(JSON.stringify(receipt));
      expectNoCustomerData(JSON.stringify(entry.response));
    }
    const allReceipts = await ctx.db.select().from(offlineMutationReceipts);
    expectNoCustomerData(JSON.stringify(allReceipts));
  });

  it('P18-E6. Re-Autorisierung beim Sync: entzogenes Recht ⇒ rejected PERMISSION_REVOKED ohne Rechte-Key; fremde Umgebung ⇒ 409 ENVIRONMENT_MISMATCH + Security-Event', async () => {
    const services = handoverServicesFor(ctx);
    const pkg = await h.packageFor(staff.cookie);
    const base = outboundBase(snapshotOf(pkg, bookingH5.bookingId));
    const recipientBefore = (await services.handover.detail(bookingH5.bookingId)).handover;

    // Zweite operative Kraft holt Paket, verliert danach das Übergaberecht (Rolle ersetzt).
    const revoked = await h.staffWith(admin.id, h.OPERATIVE, 'Entzogen');
    expect((await h.lease(revoked.cookie, DEVICE_B)).statusCode).toBe(200);
    expect((await h.pkg(revoked.cookie, {}, DEVICE_B)).statusCode).toBe(200);
    const viewerRole = await ctx.admin.createRole(admin.id, {
      name: 'Nur Lesen (Abnahme E6)',
      permissionKeys: ['process.view_all', 'handover.view'],
    });
    await ctx.admin.setUserRoles(admin.id, revoked.user.id, [viewerRole]);
    const denied = await h.sync(
      revoked.cookie,
      {
        type: 'handover.recipient',
        contextId: bookingH5.bookingId,
        base,
        payload: { kind: 'other', name: 'Abholer', phone: null },
      },
      { deviceId: DEVICE_B },
    );
    expect(denied.response.statusCode).toBe(200);
    expect(denied.json.status).toBe('rejected');
    expect(denied.json.code).toBe('PERMISSION_REVOKED');
    const deniedText = JSON.stringify(denied.json);
    for (const key of PERMISSION_KEYS) expect(deniedText).not.toContain(key);
    const deniedReceipt = await receiptOf(denied.id);
    expect(deniedReceipt.status).toBe('rejected');
    expect(deniedReceipt.errorCode).toBe('PERMISSION_REVOKED');
    const recipientAfter = (await services.handover.detail(bookingH5.bookingId)).handover;
    expect(recipientAfter.recipientKind).toBe(recipientBefore.recipientKind);
    expect(recipientAfter.recipientName).toBe(recipientBefore.recipientName);

    // Mutation einer fremden Umgebung: harte Ablehnung ohne Quittung, protokolliert ohne Fachdaten.
    const receiptsBefore = await receiptCount();
    const foreign = await h.sync(
      staff.cookie,
      {
        type: 'handover.recipient',
        contextId: bookingH5.bookingId,
        base,
        payload: { kind: 'customer', name: null, phone: null },
      },
      { environment: 'production' },
    );
    expect(foreign.response.statusCode).toBe(409);
    expect((foreign.json.error as { code: string }).code).toBe('ENVIRONMENT_MISMATCH');
    expect(await receiptCount()).toBe(receiptsBefore);
    const events = await h.securityEvents('offline.environment_mismatch');
    expect(events).toHaveLength(1);
    expect(events[0]!.targetUserId).toBe(staff.user.id);
    expect(events[0]!.details).toEqual({
      clientEnvironment: 'production',
      serverEnvironment: 'development',
    });
    expectNoCustomerData(JSON.stringify(events[0]));
  });

  it('P18-E7. Invarianten des Szenarios: keine processing-Quittung, Status/Fehlercode konsistent, genau eine ausgegebene Zuordnung je Maschine; Integritäts-Backstop ohne Befund', async () => {
    const receipts = await ctx.db.select().from(offlineMutationReceipts);
    // E2: 8 (Kette), E3: 3 (gleiche ID 1×, zwei Geräte 2×), E4: 1, E5: 6 (Start + 5 Konflikte),
    // E6: 1 (rejected); Replays und 409/503-Antworten erzeugen keine Quittung.
    expect(receipts).toHaveLength(19);
    expect(receipts.filter((r) => r.status === 'processing')).toHaveLength(0);
    for (const receipt of receipts) {
      if (receipt.status === 'applied') {
        expect(receipt.errorCode).toBeNull();
        expect(receipt.message).toBeNull();
      } else {
        expect(['conflict', 'rejected']).toContain(receipt.status);
        expect(receipt.errorCode).not.toBeNull();
        expect(receipt.resultRef).toBeNull();
      }
      expect(receipt.appEnv).toBe('development');
      expect([DEVICE, DEVICE_B]).toContain(receipt.deviceId);
    }
    // Genau eine `issued`-Zuordnung je Maschine; jede davon auf einer vermieteten Maschine.
    const issued = await ctx.pool.query<{ machine_id: string; n: number; status: string }>(
      `SELECT ma.machine_id, count(*)::int AS n, min(m.status) AS status
         FROM machine_assignments ma JOIN machines m ON m.id = ma.machine_id
        WHERE ma.status = 'issued' GROUP BY ma.machine_id`,
    );
    expect(issued.rows).toHaveLength(3); // H1, H2, H3
    for (const row of issued.rows) {
      expect(row.n).toBe(1);
      expect(row.status).toBe('rented');
    }
    const rented = await ctx.db.select().from(machines).where(eq(machines.status, 'rented'));
    expect(rented).toHaveLength(3);

    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
  });
});
