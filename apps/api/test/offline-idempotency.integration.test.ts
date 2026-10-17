/**
 * Phase-8-Finalisierung – Sync-Orchestrator:
 * - §3 Crash-/Replay-Idempotenz (Tests 17–25): Quittung bleibt nach einem Abbruch
 *   zwischen Fach-Commit und Quittung in „processing“ – ein Replay findet die
 *   bereits angewendete Wirkung operation-spezifisch wieder (client_mutation_id
 *   an neu erzeugten Fachobjekten, Zielzustand bei Updates) und quittiert
 *   „applied“ statt eines Konflikts; ohne nachweisbare Wirkung läuft die Mutation
 *   normal und genau einmal.
 * - §4 Konfliktdetails (Tests 26–30): verständliche Gegenüberstellung ohne
 *   Kundendaten und ohne Rechte-Keys.
 * - §8 Offline-Override (Tests 49–51): Override nur mit Grund, Recht und
 *   unveränderter Problemlage; harte Blocker nie übersteuerbar.
 *
 * Der Absturz wird deterministisch simuliert: Mutation normal synchronisieren
 * (applied), danach die Quittung per DB auf `processing` (älter als 2 Minuten,
 * ohne result_ref) zurücksetzen und dieselbe Mutation erneut senden.
 */
import { randomUUID } from 'node:crypto';
import {
  damagePhotos,
  documents,
  handoverPhotos,
  handoverSignatures,
  handovers,
  inventoryMovements,
  machineAssignmentOverrides,
  machineDamages,
  machines,
  missingAccessoryCases,
  offlineMutationReceipts,
  rentalReturns,
  returnPhotos,
  returnSignatures,
} from '@mietroyal/database';
import { PERMISSION_KEYS } from '@mietroyal/permissions';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { cancelBooking } from './cancellation-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  scheduledBooking,
} from './handover-helpers.ts';
import {
  DEVICE_B,
  offlineHelpers,
  truncateOfflineWorld,
  type MutationInput,
} from './offline-helpers.ts';
import { issuedBooking, jpegBytes, readyReturn, startedReturn } from './return-helpers.ts';
import { schedulingServiceFor } from './scheduling-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;
const h = offlineHelpers(() => ctx);

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateOfflineWorld(ctx);
});

/** Testkunde aus commerce-helpers – darf in keinem Konfliktdetail auftauchen (Test 30). */
const CUSTOMER_SECRETS = ['Klara', 'Kommerz', '0171 9998877', 'klara.kommerz@test.example'];

/**
 * Absturz zwischen Fach-Commit und Quittung simulieren: die bereits angewendete
 * Mutation steht wieder als veraltetes „processing“ ohne Ergebnis in der Quittung.
 */
async function crashAfterCommit(clientMutationId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE offline_mutation_receipts
       SET status = 'processing', processed_at = now() - interval '10 minutes',
           result_ref = NULL, error_code = NULL, message = NULL
     WHERE client_mutation_id = $1`,
    [clientMutationId],
  );
}

/** Veraltete „processing“-Quittung OHNE jede Fachwirkung (Absturz VOR dem Fach-Commit). */
async function crashBeforeCommit(
  clientMutationId: string,
  staffUserId: string,
  type: string,
  contextId: string,
  contextKind = 'booking',
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO offline_mutation_receipts
       (client_mutation_id, staff_user_id, device_id, app_env, operation_type, context_kind,
        context_id, status, result_ref, error_code, message, client_created_at, processed_at)
     VALUES ($1, $2, $3, 'development', $4, $5, $6, 'processing', NULL, NULL, NULL, now(),
             now() - interval '10 minutes')`,
    [clientMutationId, staffUserId, DEVICE_B, type, contextKind, contextId],
  );
}

async function receiptOf(clientMutationId: string) {
  const rows = await ctx.db
    .select()
    .from(offlineMutationReceipts)
    .where(eq(offlineMutationReceipts.clientMutationId, clientMutationId));
  return rows[0]!;
}

function expectRecovered(
  replay: { json: Record<string, unknown> },
  original: { json: Record<string, unknown> },
) {
  expect(replay.json.status).toBe('applied');
  expect(replay.json.deduplicated).toBe(true);
  expect(replay.json.resultRef).toEqual(original.json.resultRef);
  expect(replay.json.message).toBe('Bereits übernommen (Wiederaufnahme nach Unterbrechung).');
  expect(replay.json.details).toBeNull();
}

describe('Crash-Recovery Rückgabe (Order-Finalisierung §3; Tests 17–21, 23–25)', () => {
  it('Schaden, Fehlteil, Fotos und Unterschrift: Replay nach Abbruch liefert das bestehende Objekt (Tests 17–21, 25)', async () => {
    const { admin } = await h.adminSession();
    const world = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Recover');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const machine = snapshot.returnSeed!.machines[0]!;
    const bookingId = world.bookingId;
    const common = { assignmentId: machine.assignmentId, machineId: machine.machineId };

    // Rückgabe beginnen – auch hier: Abbruch nach Commit ⇒ Replay findet die Rückgabe.
    const startInput: MutationInput = {
      id: randomUUID(),
      type: 'return.start',
      contextId: bookingId,
      payload: {},
    };
    const start = await h.sync(staff.cookie, startInput);
    expect(start.json.status).toBe('applied');
    await crashAfterCommit(startInput.id!);
    expectRecovered(await h.sync(staff.cookie, startInput), start);
    expect(
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, bookingId)),
    ).toHaveLength(1);
    expect(
      (
        await h.sync(staff.cookie, {
          type: 'return.returner',
          contextId: bookingId,
          payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
        })
      ).json.status,
    ).toBe('applied');

    // Test 17/18: Schaden – Crash nach Commit, Replay ⇒ kein zweiter Schaden.
    const damageInput: MutationInput = {
      id: randomUUID(),
      type: 'return.damage',
      contextId: bookingId,
      payload: {
        ...common,
        severity: 'medium',
        description: 'Delle am Deckel',
        markers: [{ view: 'front', markerType: 'point', x: 0.5, y: 0.5 }],
        clientDamageId: randomUUID(),
      },
    };
    const damage = await h.sync(staff.cookie, damageInput);
    expect(damage.json.status).toBe('applied');
    const damageId = (damage.json.resultRef as { damageId: string }).damageId;
    await crashAfterCommit(damageInput.id!);
    expect((await receiptOf(damageInput.id!)).status).toBe('processing');
    const damageReplay = await h.sync(staff.cookie, damageInput);
    expectRecovered(damageReplay, damage);
    const damageRows = await ctx.db.select().from(machineDamages);
    expect(damageRows).toHaveLength(1);
    expect(damageRows[0]!.clientMutationId).toBe(damageInput.id);
    const damageReceipt = await receiptOf(damageInput.id!);
    expect(damageReceipt.status).toBe('applied');
    expect(damageReceipt.resultRef).toEqual({ damageId });

    // Test 19: Fehlteil.
    const missingInput: MutationInput = {
      id: randomUUID(),
      type: 'return.missing_item',
      contextId: bookingId,
      payload: { ...common, accessoryType: 'lid', missingQuantity: 1, description: null },
    };
    const missing = await h.sync(staff.cookie, missingInput);
    expect(missing.json.status).toBe('applied');
    await crashAfterCommit(missingInput.id!);
    expectRecovered(await h.sync(staff.cookie, missingInput), missing);
    const cases = await ctx.db.select().from(missingAccessoryCases);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.clientMutationId).toBe(missingInput.id);

    // Test 20: Reinigungs-Beweisfoto und Schadenfoto – kein zweites Fachobjekt, kein
    // zweites Storage-Objekt (Replay derselben Bytes).
    expect(
      (
        await h.sync(staff.cookie, {
          type: 'return.cleanliness',
          contextId: bookingId,
          payload: { ...common, emptied: false, rinsedTwice: true, nothingDismantled: true },
        })
      ).json.status,
    ).toBe('applied');
    const cleanupMedia = randomUUID();
    const cleanupInput: MutationInput = {
      id: randomUUID(),
      type: 'return.cleanup_photo',
      contextId: bookingId,
      payload: { ...common, mediaId: cleanupMedia },
      media: [
        {
          mediaId: cleanupMedia,
          purpose: 'return_cleanup_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    };
    const cleanup = await h.sync(staff.cookie, cleanupInput);
    expect(cleanup.json.status).toBe('applied');
    await crashAfterCommit(cleanupInput.id!);
    expectRecovered(await h.sync(staff.cookie, cleanupInput), cleanup);
    const cleanupRows = await ctx.db.select().from(returnPhotos);
    expect(cleanupRows).toHaveLength(1);
    expect(cleanupRows[0]!.clientMutationId).toBe(cleanupInput.id);
    expect(await ctx.storage.exists(cleanupRows[0]!.storageKey)).toBe(true);

    const damagePhotoMedia = randomUUID();
    const damagePhotoInput: MutationInput = {
      id: randomUUID(),
      type: 'return.damage_photo',
      contextId: bookingId,
      payload: { damageMutationId: damageInput.id, damageId: null, mediaId: damagePhotoMedia },
      media: [
        {
          mediaId: damagePhotoMedia,
          purpose: 'return_damage_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    };
    const damagePhoto = await h.sync(staff.cookie, damagePhotoInput);
    expect(damagePhoto.json.status).toBe('applied');
    await crashAfterCommit(damagePhotoInput.id!);
    expectRecovered(await h.sync(staff.cookie, damagePhotoInput), damagePhoto);
    const damagePhotoRows = await ctx.db.select().from(damagePhotos);
    expect(damagePhotoRows).toHaveLength(1);
    expect(damagePhotoRows[0]!.clientMutationId).toBe(damagePhotoInput.id);

    // Test 21: Unterschrift (Rückgabe) – Replay ersetzt NICHT erneut (gleicher Storage-Key).
    const sigMedia = randomUUID();
    const signatureInput: MutationInput = {
      id: randomUUID(),
      type: 'return.signature',
      contextId: bookingId,
      payload: { role: 'customer', mediaId: sigMedia },
      media: [
        {
          mediaId: sigMedia,
          purpose: 'return_signature',
          mimeType: 'image/png',
          bytes: pngBytes(),
        },
      ],
    };
    const signature = await h.sync(staff.cookie, signatureInput);
    expect(signature.json.status).toBe('applied');
    const signedBefore = await ctx.db.select().from(returnSignatures);
    expect(signedBefore).toHaveLength(1);
    await crashAfterCommit(signatureInput.id!);
    expectRecovered(await h.sync(staff.cookie, signatureInput), signature);
    const signedAfter = await ctx.db.select().from(returnSignatures);
    expect(signedAfter).toHaveLength(1);
    expect(signedAfter[0]!.id).toBe(signedBefore[0]!.id);
    expect(signedAfter[0]!.storageKey).toBe(signedBefore[0]!.storageKey);
    expect(signedAfter[0]!.clientMutationId).toBe(signatureInput.id);

    // Test 25: veraltetes „processing“ OHNE angewendete Wirkung ⇒ normale Ausführung, genau einmal.
    const unappliedDamage: MutationInput = {
      id: randomUUID(),
      type: 'return.damage',
      contextId: bookingId,
      payload: {
        ...common,
        severity: 'light',
        description: 'Kratzer seitlich',
        markers: [{ view: 'left', markerType: 'point', x: 0.2, y: 0.3 }],
        clientDamageId: randomUUID(),
      },
    };
    await crashBeforeCommit(unappliedDamage.id!, staff.user.id, 'return.damage', bookingId);
    const executed = await h.sync(staff.cookie, unappliedDamage);
    expect(executed.json.status).toBe('applied');
    expect(executed.json.deduplicated).toBe(false);
    expect(await ctx.db.select().from(machineDamages)).toHaveLength(2);
    // … und ein zweites Replay ist dann die normale Quittungs-Deduplikation.
    const again = await h.sync(staff.cookie, unappliedDamage);
    expect(again.json.deduplicated).toBe(true);
    expect(await ctx.db.select().from(machineDamages)).toHaveLength(2);
    // Keine Quittung bleibt in „processing“ zurück.
    const receipts = await ctx.db.select().from(offlineMutationReceipts);
    expect(receipts.filter((r) => r.status === 'processing')).toHaveLength(0);
  });

  it('Rückgabe-Finalisierung genau einmal: Protokoll, Lagerrücknahme, Maschine in Reinigung (Tests 23/24/25)', async () => {
    const { admin } = await h.adminSession();
    const world = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 3 }],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Final');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const seed = snapshot.returnSeed!;
    const machine = seed.machines[0]!;
    const commission = seed.items.find((i) => i.kind === 'commission')!;
    const bookingId = world.bookingId;
    const common = { assignmentId: machine.assignmentId, machineId: machine.machineId };
    expect(
      (await h.sync(staff.cookie, { type: 'return.start', contextId: bookingId, payload: {} })).json
        .status,
    ).toBe('applied');
    expect(
      (
        await h.sync(staff.cookie, {
          type: 'return.returner',
          contextId: bookingId,
          payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
        })
      ).json.status,
    ).toBe('applied');
    expect(
      (
        await h.sync(staff.cookie, {
          type: 'return.accessory',
          contextId: bookingId,
          payload: common,
        })
      ).json.status,
    ).toBe('applied');
    expect(
      (
        await h.sync(staff.cookie, {
          type: 'return.cleanliness',
          contextId: bookingId,
          payload: { ...common, emptied: true, rinsedTwice: true, nothingDismantled: true },
        })
      ).json.status,
    ).toBe('applied');
    // Update-Typ: Kommissionsrückgabe – Replay nach Abbruch erkennt den Zielzustand (Ist == Soll).
    const quantityInput: MutationInput = {
      id: randomUUID(),
      type: 'return.item_quantity',
      contextId: bookingId,
      payload: {
        deliveryNoteItemId: commission.deliveryNoteItemId,
        returnedUnopenedQuantity: 1,
        expectedIssuedQuantity: commission.issuedQuantity,
      },
    };
    const quantity = await h.sync(staff.cookie, quantityInput);
    expect(quantity.json.status).toBe('applied');
    await crashAfterCommit(quantityInput.id!);
    expectRecovered(await h.sync(staff.cookie, quantityInput), quantity);
    for (const role of ['customer', 'staff'] as const) {
      const sig = randomUUID();
      expect(
        (
          await h.sync(staff.cookie, {
            type: 'return.signature',
            contextId: bookingId,
            payload: { role, mediaId: sig },
            media: [
              {
                mediaId: sig,
                purpose: 'return_signature',
                mimeType: 'image/png',
                bytes: pngBytes(),
              },
            ],
          })
        ).json.status,
      ).toBe('applied');
    }
    const capturedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const finalizeInput: MutationInput = {
      id: randomUUID(),
      type: 'return.finalize',
      contextId: bookingId,
      createdAt: capturedAt,
      payload: { capturedAt, expectedMachines: [common] },
    };
    const finalize = await h.sync(staff.cookie, finalizeInput);
    expect(finalize.json.status).toBe('applied');
    const finalizeRef = finalize.json.resultRef as Record<string, string>;
    expect(typeof finalizeRef.protocolDocumentId).toBe('string');
    const movementsAfterFirst = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'return'));
    expect(movementsAfterFirst).toHaveLength(1);

    // Crash nach Commit ⇒ Replay: applied mit demselben resultRef (inkl. Protokoll), keine zweite
    // Finalisierung, keine zweite Lagerrücknahme (Test 24), genau ein Rückgabeprotokoll.
    await crashAfterCommit(finalizeInput.id!);
    const replay = await h.sync(staff.cookie, finalizeInput);
    expectRecovered(replay, finalize);
    expect((replay.json.resultRef as Record<string, string>).protocolDocumentId).toBe(
      finalizeRef.protocolDocumentId,
    );
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'return')),
    ).toHaveLength(1);
    const protocols = (
      await ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId))
    ).filter((d) => d.type === 'return_protocol');
    expect(protocols).toHaveLength(1);
    const ret = (
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, bookingId))
    )[0]!;
    expect(ret.status).toBe('finalized');
    expect(ret.actualReturnAt?.toISOString()).toBe(capturedAt);
    expect((await machineByCode(ctx.db, 'MR-10-01-02')).status).toBe('cleaning');
    expect((await receiptOf(finalizeInput.id!)).status).toBe('applied');

    // Zweite Mutation desselben Benutzers (anderes Gerät) mit veralteter „processing“-Quittung:
    // der Abschluss liegt nach der Reservierung und stammt vom selben Benutzer ⇒ als übernommen
    // quittiert (Zielzustand), ohne zweite Finalisierung oder Lagerbewegung.
    const otherDevice: MutationInput = { ...finalizeInput, id: randomUUID() };
    await crashBeforeCommit(otherDevice.id!, staff.user.id, 'return.finalize', bookingId);
    const other = await h.sync(staff.cookie, otherDevice, { deviceId: DEVICE_B });
    expect(other.json.status).toBe('applied');
    expect(other.json.deduplicated).toBe(true);
    expect(other.json.resultRef).toEqual(finalize.json.resultRef);
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'return')),
    ).toHaveLength(1);
    expect(
      (await ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId))).filter(
        (d) => d.type === 'return_protocol',
      ),
    ).toHaveLength(1);
  });

  it('Reinigungsabschluss: Replay nach Abbruch ⇒ applied; fremder Abschluss ⇒ normale Bewertung', async () => {
    const { admin } = await h.adminSession();
    const { world, services } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    await readyReturn(ctx, admin.id, services, world.bookingId);
    await services.returns.finalize(admin.id, world.bookingId);
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Clean');
    const before = await h.packageFor(staff.cookie);
    const first = before.machines.find((m) => m.machineCode === 'MR-10-01-01')!;
    const second = before.machines.find((m) => m.machineCode === 'MR-10-01-02')!;
    const input: MutationInput = {
      id: randomUUID(),
      type: 'machine.clean_complete',
      contextId: first.machineId,
      base: { machineUpdatedAt: null },
      payload: { expectedCleaningSince: first.cleaningSince },
    };
    const done = await h.sync(staff.cookie, input);
    expect(done.json.status).toBe('applied');
    await crashAfterCommit(input.id!);
    expectRecovered(await h.sync(staff.cookie, input), done);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    // Zweite Maschine: veraltete „processing“-Quittung des Mitarbeiters, Reinigung aber durch
    // eine ANDERE Person abgeschlossen ⇒ nicht die Wirkung dieser Mutation ⇒ normale Bewertung.
    const foreign: MutationInput = {
      id: randomUUID(),
      type: 'machine.clean_complete',
      contextId: second.machineId,
      base: { machineUpdatedAt: null },
      payload: { expectedCleaningSince: second.cleaningSince },
    };
    await crashBeforeCommit(
      foreign.id!,
      staff.user.id,
      'machine.clean_complete',
      second.machineId,
      'machine',
    );
    await services.returns.completeCleaning(admin.id, second.machineId);
    const again = await h.sync(staff.cookie, foreign);
    expect(again.json.status).toBe('conflict');
    expect(again.json.code).toBe('NOT_IN_CLEANING');
    expect((again.json.details as { server: string }).server).toContain('MR-10-01-02');
  });
});

describe('Crash-Recovery Übergabe (Order-Finalisierung §3; Tests 20–22, 24 + Update-Typen)', () => {
  it('Zuweisung, Vorbereitung, Prüfung, Menge, Foto, Unterschrift und Abschluss genau einmal', async () => {
    const { admin } = await h.adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 3 }],
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Issue');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const slotId = (snapshot.handover!.slots as { id: string }[])[0]!.id;
    const candidate = snapshot.candidateMachines[slotId]!.find(
      (c) => !c.overrideRequired && !c.hardBlocked,
    )!;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const bookingId = world.bookingId;

    // Update-Typ handover.assign: Replay mit alter Basis (Slot war leer) wäre ohne Recovery
    // MACHINE_REASSIGNED – die Recovery erkennt den Zielzustand (Slot hat die Maschine).
    const assignInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.assign',
      contextId: bookingId,
      base: { ...base, expectedMachineId: null },
      payload: {
        assignmentId: slotId,
        machineId: candidate.machineId,
        override: null,
        situationFingerprint: candidate.situationFingerprint,
      },
    };
    const assign = await h.sync(staff.cookie, assignInput);
    expect(assign.json.status).toBe('applied');
    await crashAfterCommit(assignInput.id!);
    expectRecovered(await h.sync(staff.cookie, assignInput), assign);

    const prepareInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.prepare',
      contextId: bookingId,
      base: { ...base, expectedMachineId: candidate.machineId },
      payload: { assignmentId: slotId },
    };
    const prepare = await h.sync(staff.cookie, prepareInput);
    expect(prepare.json.status).toBe('applied');
    await crashAfterCommit(prepareInput.id!);
    expectRecovered(await h.sync(staff.cookie, prepareInput), prepare);
    expect(
      (await ctx.db.select().from(machines).where(eq(machines.id, candidate.machineId)))[0]!.status,
    ).toBe('reserved');

    const recipientInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.recipient',
      contextId: bookingId,
      base,
      payload: { kind: 'other', name: 'Vertretung Lager', phone: null },
    };
    const recipient = await h.sync(staff.cookie, recipientInput);
    expect(recipient.json.status).toBe('applied');
    await crashAfterCommit(recipientInput.id!);
    expectRecovered(await h.sync(staff.cookie, recipientInput), recipient);

    const checkInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.check_machine',
      contextId: bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId },
    };
    const check = await h.sync(staff.cookie, checkInput);
    expect(check.json.status).toBe('applied');
    await crashAfterCommit(checkInput.id!);
    expectRecovered(await h.sync(staff.cookie, checkInput), check);

    // Update-Typ Menge: Replay trägt die alte „erwartete“ Menge – ohne Recovery QUANTITY_CHANGED.
    const items = (
      snapshot.handover!.deliveryNote as {
        items: { id: string; kind: string; actualQuantity: number }[];
      }
    ).items;
    const item = items.find((i) => i.kind === 'commission')!;
    const quantityInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.item_quantity',
      contextId: bookingId,
      base,
      payload: {
        itemId: item.id,
        actualQuantity: 2,
        expectedPreviousQuantity: item.actualQuantity,
      },
    };
    const quantity = await h.sync(staff.cookie, quantityInput);
    expect(quantity.json.status).toBe('applied');
    await crashAfterCommit(quantityInput.id!);
    expectRecovered(await h.sync(staff.cookie, quantityInput), quantity);

    // Test 20: Gesamtfoto – ein Fachobjekt, ein Storage-Objekt.
    const photoMedia = randomUUID();
    const photoInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.photo',
      contextId: bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId, mediaId: photoMedia },
      media: [
        {
          mediaId: photoMedia,
          purpose: 'handover_photo',
          mimeType: 'image/png',
          bytes: pngBytes(),
        },
      ],
    };
    const photo = await h.sync(staff.cookie, photoInput);
    expect(photo.json.status).toBe('applied');
    await crashAfterCommit(photoInput.id!);
    expectRecovered(await h.sync(staff.cookie, photoInput), photo);
    const photoRows = await ctx.db.select().from(handoverPhotos);
    expect(photoRows).toHaveLength(1);
    expect(photoRows[0]!.clientMutationId).toBe(photoInput.id);
    expect(await ctx.storage.exists(photoRows[0]!.storageKey)).toBe(true);

    // Test 21: Unterschriften (Übergabe) – Replay ersetzt nicht erneut.
    for (const role of ['customer', 'staff'] as const) {
      const sig = randomUUID();
      const signatureInput: MutationInput = {
        id: randomUUID(),
        type: 'handover.signature',
        contextId: bookingId,
        base,
        payload: { role, mediaId: sig },
        media: [
          { mediaId: sig, purpose: 'handover_signature', mimeType: 'image/png', bytes: pngBytes() },
        ],
      };
      const signature = await h.sync(staff.cookie, signatureInput);
      expect(signature.json.status).toBe('applied');
      const rowBefore = (await ctx.db.select().from(handoverSignatures)).find(
        (s) => s.role === role,
      )!;
      await crashAfterCommit(signatureInput.id!);
      expectRecovered(await h.sync(staff.cookie, signatureInput), signature);
      const rowsAfter = (await ctx.db.select().from(handoverSignatures)).filter(
        (s) => s.role === role,
      );
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.storageKey).toBe(rowBefore.storageKey);
      expect(rowsAfter[0]!.clientMutationId).toBe(signatureInput.id);
    }
    expect(await ctx.db.select().from(handoverSignatures)).toHaveLength(2);

    // Test 22/24: Finalisierung genau einmal – ein Protokoll, eine Lagerausgabe, Maschine einmal vermietet.
    const capturedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const finalizeInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.finalize',
      contextId: bookingId,
      base,
      createdAt: capturedAt,
      payload: {
        capturedAt,
        expectedSlots: [{ assignmentId: slotId, machineId: candidate.machineId }],
      },
    };
    const finalize = await h.sync(staff.cookie, finalizeInput);
    expect(finalize.json.status).toBe('applied');
    const finalizeRef = finalize.json.resultRef as Record<string, string>;
    expect(typeof finalizeRef.protocolDocumentId).toBe('string');
    const issuesAfterFirst = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(issuesAfterFirst.length).toBeGreaterThan(0);
    await crashAfterCommit(finalizeInput.id!);
    const replay = await h.sync(staff.cookie, finalizeInput);
    expectRecovered(replay, finalize);
    expect((replay.json.resultRef as Record<string, string>).handoverId).toBe(
      finalizeRef.handoverId,
    );
    const handoverRows = await ctx.db
      .select()
      .from(handovers)
      .where(eq(handovers.bookingId, bookingId));
    expect(handoverRows).toHaveLength(1);
    expect(handoverRows[0]!.status).toBe('finalized');
    expect(handoverRows[0]!.actualIssueAt?.toISOString()).toBe(capturedAt);
    const protocols = (
      await ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId))
    ).filter((d) => d.type === 'handover_protocol');
    expect(protocols).toHaveLength(1);
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'issue')),
    ).toHaveLength(issuesAfterFirst.length);
    const machineRows = await ctx.db
      .select()
      .from(machines)
      .where(eq(machines.id, candidate.machineId));
    expect(machineRows[0]!.status).toBe('rented');
    expect((await receiptOf(finalizeInput.id!)).status).toBe('applied');
    expect(
      (await ctx.db.select().from(offlineMutationReceipts)).filter(
        (r) => r.status === 'processing',
      ),
    ).toHaveLength(0);
  });
});

describe('Konfliktdetails (Order-Finalisierung §4; Tests 26–30)', () => {
  it('zeigen konkrete Differenzen ohne Kundendaten und ohne Rechte-Keys', async () => {
    const { admin } = await h.adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'Details');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const slotId = (snapshot.handover!.slots as { id: string }[])[0]!.id;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const services = handoverServicesFor(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const machineA = await machineByCode(ctx.db, 'MR-10-01-01');
    const machineB = await machineByCode(ctx.db, 'MR-10-01-02');
    const collected: unknown[] = [];
    const details = (r: { json: Record<string, unknown> }) => {
      collected.push(r.json.details);
      return r.json.details as {
        offline: string | null;
        server: string | null;
        action: string | null;
      };
    };

    // Test 26: Maschinenkonflikt – beide Maschinencodes sichtbar.
    await services.assignments.assign(admin.id, effective, slotId, machineB.id, null);
    const reassigned = await h.sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: null },
      payload: {
        assignmentId: slotId,
        machineId: machineA.id,
        override: null,
        situationFingerprint: null,
      },
    });
    expect(reassigned.json.code).toBe('MACHINE_REASSIGNED');
    const reassignedDetails = details(reassigned);
    expect(reassignedDetails.offline).toContain('MR-10-01-01');
    expect(reassignedDetails.server).toContain('MR-10-01-02');
    expect(reassignedDetails.action).toBeTruthy();
    const staleCheck = await h.sync(staff.cookie, {
      type: 'handover.check_machine',
      contextId: world.bookingId,
      base,
      payload: { assignmentId: slotId, machineId: machineA.id },
    });
    expect(staleCheck.json.code).toBe('MACHINE_REASSIGNED');
    expect(details(staleCheck).offline).toContain('MR-10-01-01');
    expect(details(staleCheck).server).toContain('MR-10-01-02');
    // Inzwischen anderweitig ausgegeben: Code der Maschine, aber keine fremde Vorgangsnummer.
    await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-03'],
      to: new Date(Date.now() + 3 * DAYS),
      skipInventoryInit: true,
    });
    const rented = await machineByCode(ctx.db, 'MR-10-01-03');
    const unavailable = await h.sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: machineB.id },
      payload: {
        assignmentId: slotId,
        machineId: rented.id,
        override: null,
        situationFingerprint: null,
      },
    });
    expect(unavailable.json.code).toBe('MACHINE_UNAVAILABLE');
    expect(details(unavailable).server).toContain('MR-10-01-03');
    expect(details(unavailable).server).toContain('anderen Vorgang');
    expect(details(unavailable).server).not.toMatch(/MR-\d{4}-\d+/); // keine Vorgangsnummer
    // Problemlage geändert: neutrale Problemlabels.
    const situation = await h.sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: machineB.id },
      payload: {
        assignmentId: slotId,
        machineId: machineA.id,
        override: null,
        situationFingerprint: 'f'.repeat(64),
      },
    });
    expect(situation.json.code).toBe('SITUATION_CHANGED');
    expect(details(situation).server).toContain('MR-10-01-01');
    expect(details(situation).server).toContain('Problemlage');
    // Mengenkonflikt: beide Mengen.
    const items = (
      snapshot.handover!.deliveryNote as { items: { id: string; actualQuantity: number }[] }
    ).items;
    const anyItem = items[0]!;
    const quantity = await h.sync(staff.cookie, {
      type: 'handover.item_quantity',
      contextId: world.bookingId,
      base,
      payload: {
        itemId: anyItem.id,
        actualQuantity: anyItem.actualQuantity + 1,
        expectedPreviousQuantity: anyItem.actualQuantity + 5,
      },
    });
    expect(quantity.json.code).toBe('QUANTITY_CHANGED');
    expect(details(quantity).offline).toContain(`Menge ${anyItem.actualQuantity + 1}`);
    expect(details(quantity).server).toContain(`Menge ${anyItem.actualQuantity}.`);

    // Test 27: Terminänderung – neue Zeit in Berliner Zeit, `offline` null.
    const newStart = new Date(Date.now() + 2 * DAYS);
    newStart.setUTCSeconds(0, 0);
    await schedulingServiceFor(ctx).reschedule(admin.id, outbound.id, {
      startAt: newStart,
      endAt: null,
      expectedVersion: outbound.version,
    });
    const expectedLabel = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(newStart)
      .replace(', ', ' ');
    const appointment = await h.sync(staff.cookie, {
      type: 'handover.finalize',
      contextId: world.bookingId,
      base,
      payload: { capturedAt: new Date().toISOString(), expectedSlots: [] },
    });
    expect(appointment.json.code).toBe('APPOINTMENT_CHANGED');
    expect(details(appointment).offline).toBeNull();
    expect(details(appointment).server).toContain('Ausgabe');
    expect(details(appointment).server).toContain(expectedLabel);
    // Uhrzeit-Unplausibilität: Abweichung in Minuten.
    const skewed = await h.sync(
      staff.cookie,
      {
        type: 'handover.finalize',
        contextId: world.bookingId,
        base,
        payload: { capturedAt: new Date().toISOString(), expectedSlots: [] },
      },
      { clientTime: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    );
    expect(skewed.json.code).toBe('CLOCK_IMPLAUSIBLE');
    expect(details(skewed).server).toMatch(/ca\. 18\d Minuten/);

    // Test 29: Rechte-Entzug – kein Rechte-Key in den Details; Aktionsbezeichnung sichtbar.
    const limited = await h.staffWith(admin.id, ['process.view_all', 'handover.view'], 'Limited');
    expect((await h.lease(limited.cookie, DEVICE_B)).statusCode).toBe(200);
    const revoked = await h.sync(
      limited.cookie,
      {
        type: 'handover.recipient',
        contextId: world.bookingId,
        base,
        payload: { kind: 'customer', name: null, phone: null },
      },
      { deviceId: DEVICE_B },
    );
    expect(revoked.json.status).toBe('rejected');
    expect(revoked.json.code).toBe('PERMISSION_REVOKED');
    expect(details(revoked).offline).toContain('Empfänger bestimmt');
    expect(details(revoked).server).toContain('Berechtigung');
    expect(details(revoked).action).toBeTruthy();
    const revokedText = JSON.stringify(revoked.json);
    for (const key of PERMISSION_KEYS) expect(revokedText).not.toContain(key);

    // Test 28: Storno – klare Ursache.
    await cancelBooking(ctx, admin.id, world.processId);
    const cancelled = await h.sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: world.bookingId,
      base,
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(cancelled.json.code).toBe('PROCESS_CANCELLED');
    expect(details(cancelled).server).toContain('storniert');
    expect(details(cancelled).offline).toContain('Empfänger bestimmt');

    // Test 30: keine Kundendaten in irgendeinem Konfliktdetail, in Antworten oder Quittungen.
    expect(collected.length).toBeGreaterThanOrEqual(8);
    const everything = [
      JSON.stringify(collected),
      ...(await ctx.db.select().from(offlineMutationReceipts)).map((r) =>
        JSON.stringify({ m: r.message, e: r.errorCode, r: r.resultRef }),
      ),
    ].join('\n');
    for (const secret of CUSTOMER_SECRETS) expect(everything).not.toContain(secret);
    for (const key of PERMISSION_KEYS) expect(JSON.stringify(collected)).not.toContain(key);
    // Jeder Konflikt trägt Details mit Handlungsempfehlung; keine JSON-Dumps.
    for (const entry of collected as { server: string | null; action: string | null }[]) {
      expect(entry).not.toBeNull();
      expect(entry.action).toBeTruthy();
      expect(entry.server).not.toContain('{');
    }
  });

  it('Rückgabe- und Reinigungskonflikte tragen Details (Maschinenstatus, Abhängigkeit, Abschluss)', async () => {
    const { admin } = await h.adminSession();
    const { world, services } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
    });
    const staff = await h.staffWith(admin.id, h.OPERATIVE, 'RetDetails');
    const before = await h.packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const machine = (snapshot.return as { machines: { assignmentId: string; machineId: string }[] })
      .machines[0]!;
    // Abhängigkeit (Rückgabe nicht begonnen) auf fremder Buchung ⇒ NOT_VISIBLE-Details.
    const unknown = await h.sync(staff.cookie, {
      type: 'return.returner',
      contextId: randomUUID(),
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(unknown.json.code).toBe('NOT_VISIBLE');
    expect((unknown.json.details as { server: string }).server).toContain('sichtbar');
    // Abschluss durch anderes Gerät ⇒ ALREADY_FINALIZED mit Details.
    await readyReturn(ctx, admin.id, services, world.bookingId);
    await services.returns.finalize(admin.id, world.bookingId);
    const late = await h.sync(staff.cookie, {
      type: 'return.cleanliness',
      contextId: world.bookingId,
      payload: {
        assignmentId: machine.assignmentId,
        machineId: machine.machineId,
        emptied: true,
        rinsedTwice: true,
        nothingDismantled: true,
      },
    });
    expect(late.json.code).toBe('ALREADY_FINALIZED');
    const lateDetails = late.json.details as { offline: string; server: string; action: string };
    expect(lateDetails.offline).toContain('Sauberkeitskontrolle');
    expect(lateDetails.server).toContain('Rückgabe wurde inzwischen abgeschlossen');
    // Reinigung: Maschine nicht mehr in Reinigung ⇒ Status im Detail.
    await services.returns.completeCleaning(admin.id, machine.machineId);
    const notCleaning = await h.sync(staff.cookie, {
      type: 'machine.clean_complete',
      contextId: machine.machineId,
      base: { machineUpdatedAt: null },
      payload: { expectedCleaningSince: null },
    });
    expect(notCleaning.json.code).toBe('NOT_IN_CLEANING');
    expect((notCleaning.json.details as { server: string }).server).toContain('MR-10-01-01');
    expect((notCleaning.json.details as { server: string }).server).toContain('Einsatzbereit');
    const all = JSON.stringify([unknown.json, late.json, notCleaning.json]);
    for (const secret of CUSTOMER_SECRETS) expect(all).not.toContain(secret);
  });
});

describe('Offline-Override Server-Nachweis (Order-Finalisierung §8; Tests 49–51)', () => {
  it('Override nur mit Grund, Recht und unveränderter Problemlage; harte Blocker nie', async () => {
    const { admin } = await h.adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const from = new Date(Date.now() + 3_600_000);
    const to = new Date(Date.now() + 2 * DAYS);
    // Buchung B belegt Maschine A im selben Zeitraum ⇒ Kollision (übersteuerbar).
    const bookingB = await scheduledBooking(ctx, admin.id, { from, to });
    const services = handoverServicesFor(ctx);
    const adminEffective = await ctx.auth.effectivePermissions(admin.id);
    const machineA = await machineByCode(ctx.db, 'MR-10-01-01');
    const slotB = (await services.handover.detail(bookingB.bookingId)).slots[0]!.id;
    await services.assignments.assign(admin.id, adminEffective, slotB, machineA.id, null);
    const booking = await scheduledBooking(ctx, admin.id, { from, to });
    const booking2 = await scheduledBooking(ctx, admin.id, { from, to });

    const overrider = await h.staffWith(
      admin.id,
      [...h.OPERATIVE, 'machine.override_block'],
      'Override',
    );
    const plain = await h.staffWith(admin.id, h.OPERATIVE, 'Plain');
    const pkgOverrider = await h.packageFor(overrider.cookie);
    expect((await h.lease(plain.cookie, DEVICE_B)).statusCode).toBe(200);
    const snapshot = pkgOverrider.bookings.find((b) => b.bookingId === booking.bookingId)!;
    const slotId = (snapshot.handover!.slots as { id: string }[])[0]!.id;
    const candidate = snapshot.candidateMachines[slotId]!.find((c) => c.machineId === machineA.id)!;
    expect(candidate.overrideRequired).toBe(true);
    expect(candidate.hardBlocked).toBe(false);
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
      expectedMachineId: null,
    };
    const payload = (
      override: { reason: string } | null,
      fingerprint = candidate.situationFingerprint,
    ) => ({
      assignmentId: slotId,
      machineId: machineA.id,
      override,
      situationFingerprint: fingerprint,
    });

    // Ohne Override-Recht: serverseitig abgelehnt, keine Zuweisung, kein Rechte-Key im Detail.
    const noRight = await h.sync(
      plain.cookie,
      {
        type: 'handover.assign',
        contextId: booking.bookingId,
        base,
        payload: payload({ reason: 'Kunde wartet' }),
      },
      { deviceId: DEVICE_B },
    );
    expect(noRight.json.status).toBe('rejected');
    expect(noRight.json.code).toBe('FORBIDDEN');
    for (const key of PERMISSION_KEYS) expect(JSON.stringify(noRight.json)).not.toContain(key);
    expect((await services.handover.detail(booking.bookingId)).slots[0]!.machine).toBeNull();
    // Ohne Grund: strukturell ungültig.
    const noReason = await h.sync(overrider.cookie, {
      type: 'handover.assign',
      contextId: booking.bookingId,
      base,
      payload: payload({ reason: '' }),
    });
    expect(noReason.json.status).toBe('rejected');
    expect(noReason.json.code).toBe('VALIDATION');
    // Problemlage ohne Override ⇒ SITUATION_CHANGED (keine stille Zuweisung).
    const noOverride = await h.sync(overrider.cookie, {
      type: 'handover.assign',
      contextId: booking.bookingId,
      base,
      payload: payload(null),
    });
    expect(noOverride.json.status).toBe('conflict');
    expect(noOverride.json.code).toBe('SITUATION_CHANGED');
    expect((noOverride.json.details as { server: string }).server).toContain('Zeitliche Kollision');
    expect((await services.handover.detail(booking.bookingId)).slots[0]!.machine).toBeNull();

    // Test 49: Override mit Grund und unverändertem Fingerprint ⇒ applied, Override protokolliert.
    const applied = await h.sync(overrider.cookie, {
      type: 'handover.assign',
      contextId: booking.bookingId,
      base,
      payload: payload({ reason: 'Kunde wartet, Rückgabe der Vorbuchung früher vereinbart' }),
    });
    expect(applied.json.status).toBe('applied');
    expect((await services.handover.detail(booking.bookingId)).slots[0]!.machine?.id).toBe(
      machineA.id,
    );
    const overrides = await ctx.db.select().from(machineAssignmentOverrides);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.confirmedBy).toBe(overrider.user.id);
    expect(overrides[0]!.situationFingerprint).toBe(candidate.situationFingerprint);

    // Test 50: Serversituation inzwischen geändert (neue Sperre ⇒ anderer Fingerprint) ⇒
    // SITUATION_CHANGED trotz Override – Override deckt die neue Lage nicht.
    const snapshot2 = pkgOverrider.bookings.find((b) => b.bookingId === booking2.bookingId)!;
    const slot2 = (snapshot2.handover!.slots as { id: string }[])[0]!.id;
    const candidate2 = snapshot2.candidateMachines[slot2]!.find(
      (c) => c.machineId === machineA.id,
    )!;
    expect(candidate2.overrideRequired).toBe(true);
    await services.machineService.createBlock(machineA.id, admin.id, {
      startsAt: from,
      endsAt: to,
      reason: 'Wartung eingeplant',
    });
    const outbound2 = snapshot2.appointments.find((a) => a.kind !== 'return')!;
    const changed = await h.sync(overrider.cookie, {
      type: 'handover.assign',
      contextId: booking2.bookingId,
      base: { ...base, appointmentId: outbound2.id, appointmentVersion: outbound2.version },
      payload: {
        assignmentId: slot2,
        machineId: machineA.id,
        override: { reason: 'Kunde wartet' },
        situationFingerprint: candidate2.situationFingerprint,
      },
    });
    expect(changed.json.status).toBe('conflict');
    expect(changed.json.code).toBe('SITUATION_CHANGED');
    expect((changed.json.details as { server: string }).server).toContain('Gesperrt');
    expect((await services.handover.detail(booking2.bookingId)).slots[0]!.machine).toBeNull();
    expect(await ctx.db.select().from(machineAssignmentOverrides)).toHaveLength(1);

    // Test 51: harter Blocker (an anderen Vorgang ausgegeben) ⇒ MACHINE_UNAVAILABLE, nie angewendet.
    await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-03'],
      to: new Date(Date.now() + 3 * DAYS),
      skipInventoryInit: true,
    });
    const rented = await machineByCode(ctx.db, 'MR-10-01-03');
    const hard = await h.sync(overrider.cookie, {
      type: 'handover.assign',
      contextId: booking2.bookingId,
      base: { ...base, appointmentId: outbound2.id, appointmentVersion: outbound2.version },
      payload: {
        assignmentId: slot2,
        machineId: rented.id,
        override: { reason: 'Trotzdem' },
        situationFingerprint: null,
      },
    });
    expect(hard.json.status).toBe('conflict');
    expect(hard.json.code).toBe('MACHINE_UNAVAILABLE');
    expect((hard.json.details as { server: string }).server).toContain('MR-10-01-03');
    expect((await services.handover.detail(booking2.bookingId)).slots[0]!.machine).toBeNull();
    expect(await ctx.db.select().from(machineAssignmentOverrides)).toHaveLength(1);
    expect((await machineByCode(ctx.db, 'MR-10-01-03')).status).toBe('rented');
  });
});
