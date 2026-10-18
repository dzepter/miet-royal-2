/**
 * Strukturelle Absicherung der Offline-Mutationen (Order §§26/105/106/107/91):
 * nur gelistete Typen, strikte Envelopes ohne Force-/Override-Flags, Medien
 * mit SHA-256 und begrenzter Anzahl, Rechte ausschließlich aus dem
 * bestehenden Katalog.
 */
import { PERMISSION_KEYS } from '@mietroyal/permissions';
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_CODES,
  CONFLICT_LABELS,
  MEDIA_PURPOSES,
  MUTATION_BASE_SCHEMAS,
  MUTATION_LABELS,
  MUTATION_PAYLOAD_SCHEMAS,
  MUTATION_PERMISSIONS,
  OFFLINE_MUTATION_TYPES,
  carriesCapturedTime,
  contextKindFor,
  leaseRequestSchema,
  packageRequestSchema,
  syncRequestSchema,
} from '../src/shared.ts';

const UUID = '0f6a9d2e-1b3c-4d5e-8f70-1234567890ab';
const NOW = '2026-09-28T08:00:00.000Z';

interface LooseRequest {
  deviceId: string;
  environment: string;
  clientTime: string;
  mutation: Record<string, unknown>;
}

function validRequest(): LooseRequest {
  return {
    deviceId: UUID,
    environment: 'production',
    clientTime: NOW,
    mutation: {
      clientMutationId: UUID,
      type: 'handover.recipient',
      contextKind: 'booking',
      contextId: UUID,
      createdAt: NOW,
      baseVersion: '{}',
      payload: { kind: 'customer', name: null, phone: null },
      media: [],
    },
  };
}

describe('Offline-Mutationen: Typen, Rechte, Basisstände', () => {
  it('lehnt Finanz-/Admin-Mutationen strukturell ab (§26/§105)', () => {
    expect(syncRequestSchema.safeParse(validRequest()).success).toBe(true);
    for (const type of [
      'settlement.discount',
      'settlement.release',
      'offer.change_price',
      'employee.manage',
      'process.cancel',
      'inventory.add_stock',
      'price.manage',
    ]) {
      const request = validRequest();
      request.mutation.type = type;
      request.mutation.payload = { amountCents: 1 };
      expect(syncRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(OFFLINE_MUTATION_TYPES).toHaveLength(21);
    expect(OFFLINE_MUTATION_TYPES.some((t) => /settlement|lexware|deposit|price/.test(t))).toBe(
      false,
    );
  });

  it('verlangt Medien mit SHA-256 und begrenzt die Anzahl je Mutation', () => {
    const media = {
      mediaId: UUID,
      purpose: 'handover_photo',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      dataBase64: 'AAAA',
    };
    const base = (): LooseRequest => ({
      deviceId: UUID,
      environment: 'production',
      clientTime: NOW,
      mutation: {
        clientMutationId: UUID,
        type: 'handover.photo',
        contextKind: 'booking',
        contextId: UUID,
        createdAt: NOW,
        baseVersion: null,
        payload: { assignmentId: UUID, machineId: UUID, mediaId: UUID },
        media: [media],
      },
    });
    expect(syncRequestSchema.safeParse(base()).success).toBe(true);

    const tooMany = base();
    tooMany.mutation.media = [media, media, media, media, media];
    expect(syncRequestSchema.safeParse(tooMany).success).toBe(false);

    const badHash = base();
    badHash.mutation.media = [{ ...media, sha256: 'ZZ'.repeat(32) }];
    expect(syncRequestSchema.safeParse(badHash).success).toBe(false);
    const shortHash = base();
    shortHash.mutation.media = [{ ...media, sha256: 'a'.repeat(63) }];
    expect(syncRequestSchema.safeParse(shortHash).success).toBe(false);

    const noHash = base();
    noHash.mutation.media = [
      { mediaId: UUID, purpose: 'handover_photo', mimeType: 'image/png', dataBase64: 'AAAA' },
    ];
    expect(syncRequestSchema.safeParse(noHash).success).toBe(false);

    const badPurpose = base();
    badPurpose.mutation.media = [{ ...media, purpose: 'settlement_receipt' }];
    expect(syncRequestSchema.safeParse(badPurpose).success).toBe(false);
    expect(MEDIA_PURPOSES).toHaveLength(5);

    const badMime = base();
    badMime.mutation.media = [{ ...media, mimeType: 'application/pdf' }];
    expect(syncRequestSchema.safeParse(badMime).success).toBe(false);
  });

  it('91. Envelope ist strict – Force-/Override-Flags auf Request- oder Mutationsebene werden abgelehnt', () => {
    const valid = validRequest();
    expect(syncRequestSchema.safeParse(valid).success).toBe(true);
    for (const flag of ['force', 'overwrite', 'ignoreBaseVersion', 'skipConflicts']) {
      expect(syncRequestSchema.safeParse({ ...valid, [flag]: true }).success).toBe(false);
      expect(
        syncRequestSchema.safeParse({ ...valid, mutation: { ...valid.mutation, [flag]: true } })
          .success,
      ).toBe(false);
    }
    // Umgebung ist Pflicht und abgeschlossen (§76).
    expect(syncRequestSchema.safeParse({ ...valid, environment: 'live' }).success).toBe(false);
    expect(packageRequestSchema.safeParse({ deviceId: UUID, environment: 'demo' }).success).toBe(
      true,
    );
    expect(
      packageRequestSchema.safeParse({ deviceId: UUID, environment: 'demo', force: true }).success,
    ).toBe(false);
    expect(
      packageRequestSchema.safeParse({
        deviceId: UUID,
        environment: 'demo',
        extraBookingIds: Array.from({ length: 21 }, () => UUID),
      }).success,
    ).toBe(false);
    expect(
      leaseRequestSchema.safeParse({ deviceId: UUID, environment: 'production' }).success,
    ).toBe(true);
    expect(
      leaseRequestSchema.safeParse({ deviceId: UUID, environment: 'production', ttlHours: 999 })
        .success,
    ).toBe(false);
  });

  it('Payload-Schemata sind strict: unbekannte Felder und Betragsfelder werden abgelehnt', () => {
    const recipient = MUTATION_PAYLOAD_SCHEMAS['handover.recipient'];
    expect(recipient.safeParse({ kind: 'other', name: 'Max', phone: null }).success).toBe(true);
    expect(
      recipient.safeParse({ kind: 'other', name: 'Max', phone: null, discountCents: 500 }).success,
    ).toBe(false);

    const damage = MUTATION_PAYLOAD_SCHEMAS['return.damage'];
    const marker = { view: 'front', markerType: 'point', x: 0.5, y: 0.5 };
    const damagePayload = {
      assignmentId: UUID,
      machineId: UUID,
      severity: 'light',
      description: 'Kratzer',
      markers: [marker],
      clientDamageId: UUID,
    };
    expect(damage.safeParse(damagePayload).success).toBe(true);
    expect(damage.safeParse({ ...damagePayload, costCents: 100 }).success).toBe(false);
    expect(damage.safeParse({ ...damagePayload, markers: [] }).success).toBe(false);
    expect(damage.safeParse({ ...damagePayload, markers: [{ ...marker, x: 1.5 }] }).success).toBe(
      false,
    );

    const damagePhoto = MUTATION_PAYLOAD_SCHEMAS['return.damage_photo'];
    expect(
      damagePhoto.safeParse({ damageMutationId: UUID, damageId: null, mediaId: UUID }).success,
    ).toBe(true);
    expect(
      damagePhoto.safeParse({ damageMutationId: null, damageId: UUID, mediaId: UUID }).success,
    ).toBe(true);
    expect(
      damagePhoto.safeParse({ damageMutationId: null, damageId: null, mediaId: UUID }).success,
    ).toBe(false);
    expect(
      damagePhoto.safeParse({ damageMutationId: UUID, damageId: UUID, mediaId: UUID }).success,
    ).toBe(false);

    const quantity = MUTATION_PAYLOAD_SCHEMAS['return.item_quantity'];
    expect(
      quantity.safeParse({
        deliveryNoteItemId: UUID,
        returnedUnopenedQuantity: 2,
        expectedIssuedQuantity: 3,
      }).success,
    ).toBe(true);
    expect(
      quantity.safeParse({
        deliveryNoteItemId: UUID,
        returnedUnopenedQuantity: 2.5,
        expectedIssuedQuantity: 3,
      }).success,
    ).toBe(false);

    expect(MUTATION_PAYLOAD_SCHEMAS['return.start'].safeParse({}).success).toBe(true);
    expect(MUTATION_PAYLOAD_SCHEMAS['return.start'].safeParse({ force: true }).success).toBe(false);

    const finalize = MUTATION_PAYLOAD_SCHEMAS['handover.finalize'];
    expect(
      finalize.safeParse({
        capturedAt: NOW,
        expectedSlots: [{ assignmentId: UUID, machineId: UUID }],
      }).success,
    ).toBe(true);
    expect(finalize.safeParse({ capturedAt: 'gestern', expectedSlots: [] }).success).toBe(false);
  });

  it('jeder Mutationstyp hat Bezeichnung, bestehende Rechte-Keys und ein Basisstand-Schema', () => {
    for (const type of OFFLINE_MUTATION_TYPES) {
      expect(MUTATION_LABELS[type].length).toBeGreaterThan(0);
      const keys = MUTATION_PERMISSIONS[type];
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(PERMISSION_KEYS.has(key)).toBe(true);
      expect(MUTATION_PAYLOAD_SCHEMAS[type]).toBeDefined();
      expect(MUTATION_BASE_SCHEMAS[type]).toBeDefined();
    }
    // Keine Admin-/Finanzrechte als Voraussetzung einer Offline-Mutation.
    const allKeys = new Set(Object.values(MUTATION_PERMISSIONS).flat());
    for (const key of allKeys) {
      expect(
        /^(settlement|deposit|lexware|employee|permission|system|price|voucher)\./.test(key),
      ).toBe(false);
    }
    // Basisstände: Buchungsmutationen tragen Vorgangsstatus + Terminversion, Slot-Mutationen die erwartete Maschine.
    const bookingBase = { processStatus: 'open', appointmentId: UUID, appointmentVersion: 3 };
    expect(MUTATION_BASE_SCHEMAS['handover.finalize'].safeParse(bookingBase).success).toBe(true);
    expect(MUTATION_BASE_SCHEMAS['handover.assign'].safeParse(bookingBase).success).toBe(false);
    expect(
      MUTATION_BASE_SCHEMAS['handover.assign'].safeParse({
        ...bookingBase,
        expectedMachineId: null,
      }).success,
    ).toBe(true);
    expect(
      MUTATION_BASE_SCHEMAS['machine.clean_complete'].safeParse({ machineUpdatedAt: NOW }).success,
    ).toBe(true);
    expect(MUTATION_BASE_SCHEMAS['machine.clean_complete'].safeParse(bookingBase).success).toBe(
      false,
    );
    // Konfliktcodes sind vollständig übersetzt.
    expect(CONFLICT_CODES).toHaveLength(14);
    for (const code of CONFLICT_CODES) expect(CONFLICT_LABELS[code].length).toBeGreaterThan(0);
  });

  it('contextKindFor und carriesCapturedTime', () => {
    expect(contextKindFor('machine.clean_complete')).toBe('machine');
    expect(contextKindFor('handover.assign')).toBe('booking');
    expect(contextKindFor('return.finalize')).toBe('booking');
    const timed = OFFLINE_MUTATION_TYPES.filter((type) => carriesCapturedTime(type));
    expect(timed).toEqual(['handover.finalize', 'return.actual_time', 'return.finalize']);
  });
});
