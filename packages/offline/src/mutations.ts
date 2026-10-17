/**
 * Offline-Mutationen (Phase-8-Order §§26–33, 63–69, 73): die abgeschlossene
 * Liste fachlicher Schreibaktionen, die offline erfasst und beim Sync über
 * die BESTEHENDEN Domainservices angewendet werden. Alles hier ist DOM-frei
 * und wird von Client UND Server (Sync-Orchestrator) genutzt.
 *
 * Grundsätze:
 * - Kein Finanz-/Admin-Zugriff offline (§26/§96): nur die hier gelisteten
 *   Typen sind strukturell möglich; alles andere lehnt `syncRequestSchema` ab.
 * - Jede Mutation trägt einen Basisstand (`baseVersion`), gegen den der
 *   Server Konflikte erkennt – kein Last-Write-Wins (§33/§73).
 * - Keine neuen Permission-Keys: `MUTATION_PERMISSIONS` bildet auf die
 *   bestehenden Keys ab; der Server prüft jede Mutation erneut (§74).
 * - Envelope-Schemata sind strict: Force-/Override-Flags auf Request- oder
 *   Mutationsebene existieren nicht (Test 91).
 */
import type { PermissionKey } from '@mietroyal/permissions';
import { z } from 'zod';

export const OFFLINE_MUTATION_TYPES = [
  'handover.assign',
  'handover.prepare',
  'handover.check_machine',
  'handover.photo',
  'handover.item_quantity',
  'handover.recipient',
  'handover.signature',
  'handover.finalize',
  'return.start',
  'return.returner',
  'return.accessory',
  'return.missing_item',
  'return.cleanliness',
  'return.cleanup_photo',
  'return.item_quantity',
  'return.damage',
  'return.damage_photo',
  'return.signature',
  'return.actual_time',
  'return.finalize',
  'machine.clean_complete',
] as const;
export type OfflineMutationType = (typeof OFFLINE_MUTATION_TYPES)[number];
export const offlineMutationTypeSchema = z.enum(OFFLINE_MUTATION_TYPES);

/** Neutrale Aktionsbezeichnungen für Sync-Übersicht und Konflikt-UI (keine Fachdaten). */
export const MUTATION_LABELS: Record<OfflineMutationType, string> = {
  'handover.assign': 'Maschine zugewiesen',
  'handover.prepare': 'Maschine vorbereitet',
  'handover.check_machine': 'Übergabeprüfung bestätigt',
  'handover.photo': 'Gesamtfoto erfasst',
  'handover.item_quantity': 'Ausgabemenge geändert',
  'handover.recipient': 'Empfänger bestimmt',
  'handover.signature': 'Unterschrift (Übergabe) erfasst',
  'handover.finalize': 'Übergabe abgeschlossen',
  'return.start': 'Rückgabe begonnen',
  'return.returner': 'Rückgabeperson bestimmt',
  'return.accessory': 'Zubehör vollständig bestätigt',
  'return.missing_item': 'Fehlteil erfasst',
  'return.cleanliness': 'Sauberkeitskontrolle erfasst',
  'return.cleanup_photo': 'Reinigungs-Beweisfoto erfasst',
  'return.item_quantity': 'Kommissionsrückgabe erfasst',
  'return.damage': 'Schaden erfasst',
  'return.damage_photo': 'Schadenfoto erfasst',
  'return.signature': 'Unterschrift (Rückgabe) erfasst',
  'return.actual_time': 'Rückgabezeit erfasst',
  'return.finalize': 'Rückgabe abgeschlossen',
  'machine.clean_complete': 'Gereinigt & einsatzbereit',
};

/**
 * Erforderliche Rechte je Mutation – 1:1 die Keys der bestehenden Online-
 * Routen (PERMISSIONS.md), keine neuen Keys. Der lokale Rechte-Snapshot
 * steuert nur die Darstellung; der Server prüft beim Sync gegen die
 * AKTUELLEN Rechte (entzogenes Recht ⇒ PERMISSION_REVOKED, §74).
 */
export const MUTATION_PERMISSIONS: Record<OfflineMutationType, readonly PermissionKey[]> = {
  'handover.assign': ['handover.view', 'process.view_all', 'machine.assign'],
  'handover.prepare': ['handover.view', 'process.view_all', 'handover.prepare'],
  'handover.check_machine': ['handover.view', 'process.view_all', 'handover.perform'],
  'handover.photo': ['handover.view', 'process.view_all', 'handover.perform'],
  'handover.item_quantity': ['handover.view', 'process.view_all', 'delivery_note.edit'],
  'handover.recipient': ['handover.view', 'process.view_all', 'handover.perform'],
  'handover.signature': ['handover.view', 'process.view_all', 'handover.perform'],
  'handover.finalize': ['handover.view', 'process.view_all', 'handover.perform'],
  'return.start': ['return.view', 'process.view_all', 'return.perform'],
  'return.returner': ['return.view', 'process.view_all', 'return.perform'],
  'return.accessory': ['return.view', 'process.view_all', 'return.perform'],
  'return.missing_item': ['return.view', 'process.view_all', 'missing_item.create'],
  'return.cleanliness': ['return.view', 'process.view_all', 'return.perform'],
  'return.cleanup_photo': ['return.view', 'process.view_all', 'return.perform'],
  'return.item_quantity': ['return.view', 'process.view_all', 'return.perform'],
  'return.damage': ['return.view', 'process.view_all', 'damage.document'],
  'return.damage_photo': ['return.view', 'process.view_all', 'damage.document'],
  'return.signature': ['return.view', 'process.view_all', 'return.perform'],
  'return.actual_time': ['return.view', 'process.view_all', 'return.correct_actual_time'],
  'return.finalize': ['return.view', 'process.view_all', 'return.complete'],
  'machine.clean_complete': ['machine.view', 'machine.clean_complete'],
};

/** Zweck eines lokal erfassten Mediums (Foto/Unterschrift) – bestimmt die Server-Ablage. */
export const MEDIA_PURPOSES = [
  'handover_photo',
  'handover_signature',
  'return_cleanup_photo',
  'return_damage_photo',
  'return_signature',
] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/** Umgebungs-ID (APP_ENV) – Paket und Mutation tragen sie; Mismatch ⇒ Hard-Reject (§76). */
export const OFFLINE_ENVIRONMENTS = ['development', 'staging', 'demo', 'production'] as const;
export type OfflineEnvironment = (typeof OFFLINE_ENVIRONMENTS)[number];
export const offlineEnvironmentSchema = z.enum(OFFLINE_ENVIRONMENTS);

/** Kontextart einer Mutation: Vorgang (Buchung) oder Maschine. */
export const CONTEXT_KINDS = ['booking', 'machine'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

const uuidSchema = z.uuid();
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const damageMarkerSchema = z.strictObject({
  view: z.enum(['front', 'back', 'left', 'right']),
  markerType: z.enum(['point', 'area']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1).nullable().optional(),
  height: z.number().min(0).max(1).nullable().optional(),
});

/**
 * Basisstand je Vorgang (§33): Vorgangsstatus und Terminversion laut
 * lokalem Snapshot – abweichender Serverstand ⇒ Konflikt statt Overwrite.
 */
const bookingBaseSchema = z.strictObject({
  processStatus: z.string().max(40),
  appointmentId: uuidSchema.nullable(),
  appointmentVersion: z.number().int().nullable(),
});
/** Basisstand für Slot-Mutationen: zusätzlich die lokal erwartete Maschine des Slots. */
const slotBaseSchema = bookingBaseSchema.extend({
  expectedMachineId: uuidSchema.nullable(),
});

/** Fachliche Payloads je Mutationstyp – strict, nur die vom Domainservice benötigten Felder. */
export const MUTATION_PAYLOAD_SCHEMAS = {
  'handover.assign': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    /** Bewusste Bestätigung einer Problemlage (Order §45) – der Server rechnet die Lage neu. */
    override: z.strictObject({ reason: z.string().min(1).max(500) }).nullable(),
    /** Problemlage laut Paket; andere Lage beim Sync ⇒ SITUATION_CHANGED (§49). */
    situationFingerprint: z.string().max(2000).nullable(),
  }),
  'handover.prepare': z.strictObject({ assignmentId: uuidSchema }),
  'handover.check_machine': z.strictObject({ assignmentId: uuidSchema, machineId: uuidSchema }),
  'handover.photo': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    mediaId: uuidSchema,
  }),
  'handover.item_quantity': z.strictObject({
    itemId: uuidSchema,
    actualQuantity: z.number().int().min(0).max(10_000),
    /** Menge laut lokalem Stand – anderer Serverwert ⇒ QUANTITY_CHANGED. */
    expectedPreviousQuantity: z.number().int().min(0).max(10_000),
  }),
  'handover.recipient': z.strictObject({
    kind: z.enum(['customer', 'representative', 'other']),
    name: z.string().max(200).nullable(),
    phone: z.string().max(40).nullable(),
  }),
  'handover.signature': z.strictObject({
    role: z.enum(['customer', 'staff']),
    mediaId: uuidSchema,
  }),
  'handover.finalize': z.strictObject({
    /** Erfassungszeit der Übergabe am Gerät (Uhrzeit-Plausibilität §69). */
    capturedAt: isoDateTimeSchema,
    /** Slots mit lokal erwarteter Maschine – Abweichung ⇒ MACHINE_REASSIGNED. */
    expectedSlots: z
      .array(z.strictObject({ assignmentId: uuidSchema, machineId: uuidSchema }))
      .max(50),
  }),
  'return.start': z.strictObject({}),
  'return.returner': z.strictObject({
    kind: z.enum(['customer', 'representative', 'other']),
    firstName: z.string().max(100).nullable(),
    lastName: z.string().max(100).nullable(),
    phone: z.string().max(40).nullable(),
  }),
  'return.accessory': z.strictObject({ assignmentId: uuidSchema, machineId: uuidSchema }),
  'return.missing_item': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    accessoryType: z.enum(['lid', 'drip_tray']),
    missingQuantity: z.number().int().min(1).max(10),
    description: z.string().max(500).nullable(),
  }),
  'return.cleanliness': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    emptied: z.boolean(),
    rinsedTwice: z.boolean(),
    nothingDismantled: z.boolean(),
  }),
  'return.cleanup_photo': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    mediaId: uuidSchema,
  }),
  'return.item_quantity': z.strictObject({
    deliveryNoteItemId: uuidSchema,
    returnedUnopenedQuantity: z.number().int().min(0).max(10_000),
    /** Ausgegebene Menge laut lokalem Stand – anderer Serverwert ⇒ QUANTITY_CHANGED. */
    expectedIssuedQuantity: z.number().int().min(0).max(10_000),
  }),
  'return.damage': z.strictObject({
    assignmentId: uuidSchema,
    machineId: uuidSchema,
    severity: z.enum(['light', 'medium', 'severe']),
    description: z.string().min(1).max(2000),
    markers: z.array(damageMarkerSchema).min(1).max(20),
    /** Lokale Schadens-ID: verknüpft Schadenfotos vor dem Sync (§29). */
    clientDamageId: uuidSchema,
  }),
  'return.damage_photo': z
    .strictObject({
      /** Schaden, der selbst noch als lokale Mutation aussteht (Abhängigkeit). */
      damageMutationId: uuidSchema.nullable(),
      /** Bereits serverseitig bekannter Schaden (aus dem Paket). */
      damageId: uuidSchema.nullable(),
      mediaId: uuidSchema,
    })
    .refine(
      (value) => (value.damageMutationId === null) !== (value.damageId === null),
      'Genau eine Schadensreferenz (lokale Mutation ODER Server-Schaden) ist erforderlich.',
    ),
  'return.signature': z.strictObject({
    role: z.enum(['customer', 'staff']),
    mediaId: uuidSchema,
  }),
  'return.actual_time': z.strictObject({ actualReturnAt: isoDateTimeSchema }),
  'return.finalize': z.strictObject({
    /** Erfassungszeit der Rückgabe am Gerät (Uhrzeit-Plausibilität §69). */
    capturedAt: isoDateTimeSchema,
    /** Maschinen der Rückgabe laut lokalem Stand – Abweichung ⇒ SERVER_STATE_CHANGED. */
    expectedMachines: z
      .array(z.strictObject({ assignmentId: uuidSchema, machineId: uuidSchema }))
      .max(50),
  }),
  'machine.clean_complete': z.strictObject({
    /** Reinigungsbeginn laut lokalem Stand – anderer Wert = anderer Reinigungszyklus (§25). */
    expectedCleaningSince: isoDateTimeSchema.nullable(),
  }),
} as const satisfies Record<OfflineMutationType, z.ZodType>;

/** Basisstand-Schemata je Mutationstyp (JSON in `baseVersion`, Pflicht beim Sync). */
export const MUTATION_BASE_SCHEMAS = {
  'handover.assign': slotBaseSchema,
  'handover.prepare': slotBaseSchema,
  'handover.check_machine': bookingBaseSchema,
  'handover.photo': bookingBaseSchema,
  'handover.item_quantity': bookingBaseSchema,
  'handover.recipient': bookingBaseSchema,
  'handover.signature': bookingBaseSchema,
  'handover.finalize': bookingBaseSchema,
  'return.start': bookingBaseSchema,
  'return.returner': bookingBaseSchema,
  'return.accessory': bookingBaseSchema,
  'return.missing_item': bookingBaseSchema,
  'return.cleanliness': bookingBaseSchema,
  'return.cleanup_photo': bookingBaseSchema,
  'return.item_quantity': bookingBaseSchema,
  'return.damage': bookingBaseSchema,
  'return.damage_photo': bookingBaseSchema,
  'return.signature': bookingBaseSchema,
  'return.actual_time': bookingBaseSchema,
  'return.finalize': bookingBaseSchema,
  'machine.clean_complete': z.strictObject({ machineUpdatedAt: isoDateTimeSchema.nullable() }),
} as const satisfies Record<OfflineMutationType, z.ZodType>;

export type MutationPayload<T extends OfflineMutationType> = z.infer<
  (typeof MUTATION_PAYLOAD_SCHEMAS)[T]
>;
export type MutationBase<T extends OfflineMutationType> = z.infer<
  (typeof MUTATION_BASE_SCHEMAS)[T]
>;
export type BookingBase = z.infer<typeof bookingBaseSchema>;
export type SlotBase = z.infer<typeof slotBaseSchema>;
export type DamageMarkerPayload = z.infer<typeof damageMarkerSchema>;

export function contextKindFor(type: OfflineMutationType): ContextKind {
  return type.startsWith('machine.') ? 'machine' : 'booking';
}

/** Mutationen, die eine Erfassungszeit tragen und deshalb der Uhrzeit-Plausibilität unterliegen (§69). */
export function carriesCapturedTime(type: OfflineMutationType): boolean {
  return (
    type === 'handover.finalize' || type === 'return.finalize' || type === 'return.actual_time'
  );
}

// ── Wire-Schemata (Client → Server) ─────────────────────────────────────────

export const syncMediaSchema = z.strictObject({
  mediaId: uuidSchema,
  purpose: z.enum(MEDIA_PURPOSES),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** SHA-256 der Bytes – Server prüft den Hash (Mismatch ⇒ rejected) und dedupliziert. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  dataBase64: z.string().min(1),
});
export type SyncMediaInput = z.infer<typeof syncMediaSchema>;

export const syncMutationSchema = z.strictObject({
  clientMutationId: uuidSchema,
  type: offlineMutationTypeSchema,
  contextKind: z.enum(CONTEXT_KINDS),
  contextId: uuidSchema,
  createdAt: isoDateTimeSchema,
  /** JSON-Basisstand (MUTATION_BASE_SCHEMAS) – ohne Basisstand keine Fachmutation. */
  baseVersion: z.string().max(4000).nullable(),
  payload: z.unknown(),
  media: z.array(syncMediaSchema).max(4),
});
export type SyncMutationInput = z.infer<typeof syncMutationSchema>;

export const syncRequestSchema = z.strictObject({
  deviceId: uuidSchema,
  environment: offlineEnvironmentSchema,
  /** Gerätezeit beim Senden (UTC) – Uhrzeit-Plausibilität (§69). */
  clientTime: isoDateTimeSchema,
  mutation: syncMutationSchema,
});
export type SyncRequestInput = z.infer<typeof syncRequestSchema>;

export const packageRequestSchema = z.strictObject({
  deviceId: uuidSchema,
  environment: offlineEnvironmentSchema,
  /** Bewusst zusätzlich für Offline geöffnete Vorgänge (§10) – gleiche Rechteprüfung. */
  extraBookingIds: z.array(uuidSchema).max(20).optional(),
  /** Dokumente (PDF-Bytes) einschließen – Default true; false für schnelle Aktualisierung. */
  includeDocuments: z.boolean().optional(),
});
export type PackageRequestInput = z.infer<typeof packageRequestSchema>;

export const leaseRequestSchema = z.strictObject({
  deviceId: uuidSchema,
  environment: offlineEnvironmentSchema,
});
export type LeaseRequestInput = z.infer<typeof leaseRequestSchema>;

// ── Konflikte (Server → Client) ─────────────────────────────────────────────

/** Neutrale Konfliktcodes (§73): keine Fachdaten, für die Konflikt-UI übersetzbar. */
export const CONFLICT_CODES = [
  'PROCESS_CANCELLED',
  'PROCESS_COMPLETED',
  'ALREADY_FINALIZED',
  'MACHINE_REASSIGNED',
  'MACHINE_UNAVAILABLE',
  'SITUATION_CHANGED',
  'APPOINTMENT_CHANGED',
  'QUANTITY_CHANGED',
  'CLEANING_CYCLE_CHANGED',
  'NOT_IN_CLEANING',
  'CLOCK_IMPLAUSIBLE',
  'SERVER_STATE_CHANGED',
  'DEPENDENCY_NOT_APPLIED',
  'NOT_VISIBLE',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

export const CONFLICT_LABELS: Record<ConflictCode, string> = {
  PROCESS_CANCELLED: 'Vorgang wurde zwischenzeitlich storniert.',
  PROCESS_COMPLETED: 'Vorgang wurde zwischenzeitlich abgeschlossen.',
  ALREADY_FINALIZED: 'Bereits abgeschlossen – vermutlich von einem anderen Gerät.',
  MACHINE_REASSIGNED: 'Die Maschine wurde zwischenzeitlich anders zugewiesen.',
  MACHINE_UNAVAILABLE: 'Die Maschine ist inzwischen anderweitig ausgegeben oder gesperrt.',
  SITUATION_CHANGED: 'Die Problemlage der Maschine hat sich geändert – bitte erneut prüfen.',
  APPOINTMENT_CHANGED: 'Der Termin wurde zwischenzeitlich geändert.',
  QUANTITY_CHANGED: 'Die Menge wurde zwischenzeitlich serverseitig geändert.',
  CLEANING_CYCLE_CHANGED: 'Ein anderer Reinigungszyklus ist inzwischen aktiv.',
  NOT_IN_CLEANING: 'Die Maschine ist nicht (mehr) in Reinigung.',
  CLOCK_IMPLAUSIBLE: 'Gerätezeit prüfen – die erfasste Zeit ist nicht plausibel.',
  SERVER_STATE_CHANGED: 'Der Serverstand hat sich geändert – bitte prüfen.',
  DEPENDENCY_NOT_APPLIED: 'Eine vorausgehende Erfassung wurde nicht übernommen.',
  NOT_VISIBLE: 'Der Vorgang ist für dich nicht (mehr) sichtbar.',
};

export type SyncOutcomeStatus = 'applied' | 'conflict' | 'rejected';

/**
 * Antwort des Sync-Endpunkts je Mutation (§§63/64). `resultRef` enthält nur
 * technische Referenzen (IDs), nie Fachdaten; `deduplicated` markiert ein
 * Replay einer bereits angewendeten Mutation (identische Antwort, keine
 * zweite Wirkung).
 */
export interface SyncOutcomeResponse {
  status: SyncOutcomeStatus;
  resultRef: Record<string, string> | null;
  /** Konflikt-/Ablehnungscode (CONFLICT_CODES bzw. PERMISSION_REVOKED, VALIDATION, …). */
  code: string | null;
  message: string | null;
  deduplicated: boolean;
  processedAt: string;
  serverTime: string;
}

/**
 * Kurzbeschreibung einer lokalen Mutation für Sync-Übersicht/Konflikt-UI.
 * Nur Vorgangsnummer, Aktionsbezeichnung und ein technisches Detail
 * (z. B. Maschinencode, Artikelbezeichnung) – keine Kundendaten.
 */
export interface MutationSummary {
  processNumber: string | null;
  actionLabel: string;
  detail: string | null;
}
