import { createHash } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import {
  appointments,
  bookings,
  damagePhotos,
  handoverPhotos,
  handoverSignatures,
  handovers,
  machineDamages,
  machines,
  missingAccessoryCases,
  offlineMutationReceipts,
  rentalReturns,
  returnPhotos,
  returnSignatures,
  type Database,
  type OfflineMutationReceipt,
} from '@mietroyal/database';
import {
  CONFLICT_LABELS,
  MUTATION_BASE_SCHEMAS,
  MUTATION_LABELS,
  MUTATION_PAYLOAD_SCHEMAS,
  MUTATION_PERMISSIONS,
  carriesCapturedTime,
  contextKindFor,
  type BookingBase,
  type ConflictCode,
  type ConflictDetails,
  type MediaPurpose,
  type MutationBase,
  type MutationPayload,
  type OfflineMutationType,
  type SyncOutcomeResponse,
  type SyncRequestInput,
} from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq } from 'drizzle-orm';
import { AuthError, type AuthenticatedContext, type StaffAuthService } from '../auth/service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import type { ProcessService } from '../crm/process-service.ts';
import { buildVisibilityContext, isProcessVisible } from '../crm/visibility.ts';
import type { AssignmentService, MachineEvaluation } from '../handover/assignment-service.ts';
import type { HandoverDetailView, HandoverService } from '../handover/handover-service.ts';
import { KeyedMutex } from '../handover/keyed-mutex.ts';
import type { DamageService } from '../returns/damage-service.ts';
import type { ReturnDetailView, ReturnService } from '../returns/return-service.ts';
import type { SchedulingService } from '../scheduling/scheduling-service.ts';
import { MACHINE_STATUS_LABELS, type MachineService } from '../warehouse/machine-service.ts';
import type { OfflineLeaseService } from './lease-service.ts';

/**
 * Sync-Orchestrator (Phase-8-Order §§28, 61–67, 73–76): jede Offline-
 * Mutation wird einzeln entgegengenommen, gegen Umgebung, Rechte (frisch
 * aus der Datenbank), Sichtbarkeit, Basisstand, Uhrzeit und Medien-Hashes
 * geprüft und dann über die BESTEHENDEN Domainservices ausgeführt – Lager,
 * PDFs, Maschinenstatus und Termine entstehen nur dort, genau einmal.
 *
 * Quittungen (`offline_mutation_receipts`, Order §63/§64) deduplizieren
 * dauerhaft: applied ⇒ gleiches Ergebnis ohne zweite Wirkung; conflict/
 * rejected ⇒ erneute Bewertung erlaubt. Zweiphasig: die Quittung wird VOR
 * der Fachmutation als `processing` reserviert – ein Abbruch dazwischen
 * führt nie zu einer stillen zweiten Ausführung (§28).
 *
 * Wiederaufnahme nach Abbruch (Phase-8-Finalisierung §3): bleibt eine
 * Quittung länger als PROCESSING_STALE_MS in `processing`, prüft `recover`
 * operation-spezifisch, ob die Fachwirkung bereits existiert – neu erzeugte
 * Fachobjekte tragen die erzeugende `client_mutation_id`, Zustandsänderungen
 * werden am Zielzustand erkannt. Nachweislich angewendet ⇒ `applied`
 * (dedupliziert); nicht nachweisbar ⇒ normale Ausführung.
 *
 * Kein Last-Write-Wins (§32): abweichender Serverstand ⇒ neutraler
 * Konfliktcode mit fachlich verständlichen Details (§4: kurze Sätze, nur
 * relevante Felder, Maschinencodes erlaubt, nie Kundendaten/Rechte-Keys);
 * der Mitarbeiter entscheidet online nach Prüfung.
 */

export interface OfflineSyncDeps {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  handover: HandoverService;
  returns: ReturnService;
  assignments: AssignmentService;
  damages: DamageService;
  processes: ProcessService;
  scheduling: SchedulingService;
  machines: MachineService;
  leases: OfflineLeaseService;
}

type ResultRef = Record<string, string>;

/** Fachlicher Konflikt – Serverstand weicht vom lokalen Basisstand ab (§§32/73). */
export class SyncConflict extends Error {
  constructor(
    readonly code: ConflictCode,
    message?: string,
    readonly details?: ConflictDetails,
  ) {
    super(message ?? CONFLICT_LABELS[code]);
    this.name = 'SyncConflict';
  }
}

/** Dauerhafte Ablehnung – Rechte, Struktur, Medien (§§74/75); kein automatischer Retry. */
export class SyncRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: ConflictDetails,
  ) {
    super(message);
    this.name = 'SyncRejected';
  }
}

/** Gleiche Mutations-ID wird gerade (in einem anderen Prozess) verarbeitet – später erneut. */
export class SyncInProgressError extends Error {
  constructor() {
    super('Diese Übertragung wird gerade verarbeitet – bitte gleich erneut versuchen.');
    this.name = 'SyncInProgressError';
  }
}

/** Nach dieser Frist gilt eine „processing“-Quittung als abgebrochen (Ergebnis unbekannt). */
export const PROCESSING_STALE_MS = 2 * 60_000;
/** Uhrzeit-Toleranz der Gerätezeit (§69, dokumentiert in TECH_DECISIONS). */
export const CLOCK_TOLERANCE_MS = 15 * 60_000;
/** Längste mögliche Offline-Phase (72-h-Lease) + Toleranz. */
export const MAX_OFFLINE_AGE_MS = 72 * 3_600_000 + CLOCK_TOLERANCE_MS;

const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_BYTES = 6 * 1024 * 1024;

interface DecodedMedia {
  mediaId: string;
  purpose: MediaPurpose;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sha256: string;
  bytes: Uint8Array;
}

/** Neutrale Meldung für Quittung/Client – nie Fachtexte der Domainservices (§63). */
function neutralMessage(error: AuthError): string {
  switch (error.code) {
    case 'CONFLICT':
    case 'NOT_FOUND':
      return CONFLICT_LABELS.SERVER_STATE_CHANGED;
    case 'FORBIDDEN':
      return 'Dafür fehlt dir (inzwischen) die erforderliche Berechtigung.';
    case 'VALIDATION':
      return 'Die Offline-Erfassung wurde serverseitig als ungültig abgelehnt.';
    default:
      return 'Die Offline-Erfassung konnte nicht übernommen werden.';
  }
}

/** Hinweis auf die Wiederaufnahme nach einem Abbruch (Order-Finalisierung §3). */
export const RECOVERED_MESSAGE = 'Bereits übernommen (Wiederaufnahme nach Unterbrechung).';

const ACTION_LOAD_SERVER_STATE = 'Serverstand laden und prüfen.';

/** Zeitpunkt für Konfliktdetails: Berliner Zeit „dd.mm.yyyy HH:MM“ (§4). */
function berlinTimeLabel(at: Date): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

function offlineLabel(type: OfflineMutationType): string {
  return `Offline erfasst: ${MUTATION_LABELS[type]}`;
}

/**
 * Standard-Details je Code (§4), wenn der Konflikt keine fachlich konkretere
 * Gegenüberstellung mitbringt. Nie Kundendaten, nie Rechte-Keys, keine JSON-Dumps.
 */
function defaultDetails(
  type: OfflineMutationType,
  code: string,
  message: string | null,
): ConflictDetails {
  const offline = offlineLabel(type);
  const handover = type.startsWith('handover.');
  switch (code) {
    case 'PERMISSION_REVOKED':
    case 'FORBIDDEN':
      return {
        offline,
        server: 'Dafür fehlt dir inzwischen die Berechtigung.',
        action: 'Mit einer berechtigten Person klären oder verwerfen.',
      };
    case 'PROCESS_CANCELLED':
      return {
        offline,
        server: 'Der Vorgang wurde inzwischen storniert.',
        action: 'Erfassung prüfen und verwerfen, wenn sie nicht mehr gilt.',
      };
    case 'PROCESS_COMPLETED':
      return {
        offline,
        server: 'Der Vorgang wurde inzwischen abgeschlossen.',
        action: 'Erfassung prüfen und verwerfen, wenn sie nicht mehr gilt.',
      };
    case 'ALREADY_FINALIZED':
      return {
        offline,
        server: handover
          ? 'Die Übergabe wurde inzwischen abgeschlossen (anderes Gerät).'
          : 'Die Rückgabe wurde inzwischen abgeschlossen (anderes Gerät).',
        action: 'Serverstand laden und mit der lokalen Erfassung abgleichen.',
      };
    case 'DEPENDENCY_NOT_APPLIED':
      return {
        offline,
        server: 'Eine vorausgehende Erfassung wurde nicht übernommen.',
        action: 'Zuerst die vorausgehende Erfassung klären.',
      };
    case 'NOT_VISIBLE':
      return {
        offline,
        server: 'Der Vorgang ist für dich nicht (mehr) sichtbar.',
        action: 'Mit der Disposition klären oder verwerfen.',
      };
    case 'VALIDATION':
      return { offline, server: message, action: 'Erfassung prüfen und ggf. verwerfen.' };
    case 'MEDIA_HASH_MISMATCH':
      return { offline, server: message, action: 'Foto bzw. Unterschrift erneut erfassen.' };
    case 'CLOCK_IMPLAUSIBLE':
      return {
        offline,
        server: message,
        action: 'Gerätezeit prüfen und erneut synchronisieren.',
      };
    default:
      return { offline, server: message, action: ACTION_LOAD_SERVER_STATE };
  }
}

export class OfflineSyncService {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: OfflineSyncDeps) {}

  async process(
    context: AuthenticatedContext,
    input: SyncRequestInput,
    now = new Date(),
  ): Promise<SyncOutcomeResponse> {
    this.deps.leases.assertEnvironment(input.environment);
    const { mutation } = input;
    // Je Kontext (Vorgang/Maschine) UND je Mutations-ID serialisieren: zwei Geräte,
    // die denselben Vorgang gleichzeitig abschließen, laufen nacheinander – das
    // zweite sieht „bereits abgeschlossen“ statt eines scheinbaren Erfolgs (§67).
    return this.mutex.run(`offline-context:${mutation.contextKind}:${mutation.contextId}`, () =>
      this.mutex.run(`offline-mutation:${mutation.clientMutationId}`, async () => {
        const existing = await this.receipt(mutation.clientMutationId);
        if (existing !== null) {
          if (existing.staffUserId !== context.user.id) {
            const message = 'Diese Mutations-ID gehört zu einem anderen Benutzer.';
            return this.finish(context, input, now, {
              status: 'rejected',
              code: 'FORBIDDEN',
              message,
              resultRef: null,
              details: {
                offline: offlineLabel(mutation.type),
                server: message,
                action: 'Erfassung verwerfen.',
              },
              deduplicated: false,
              persist: false,
            });
          }
          if (
            existing.operationType !== mutation.type ||
            existing.contextKind !== mutation.contextKind ||
            existing.contextId !== mutation.contextId
          ) {
            // Eine Mutations-ID steht für genau EINE Aktion (§63/§64) – Wiederverwendung
            // mit anderem Typ/Kontext würde die Quittung entwerten.
            const message = 'Diese Mutations-ID wurde bereits für eine andere Aktion verwendet.';
            return this.finish(context, input, now, {
              status: 'rejected',
              code: 'VALIDATION',
              message,
              resultRef: null,
              details: defaultDetails(mutation.type, 'VALIDATION', message),
              deduplicated: false,
              persist: false,
            });
          }
          if (existing.status === 'applied') {
            return {
              status: 'applied',
              resultRef: (existing.resultRef as ResultRef | null) ?? null,
              code: null,
              message: null,
              details: null,
              deduplicated: true,
              processedAt: existing.processedAt.toISOString(),
              serverTime: now.toISOString(),
            };
          }
          if (existing.status === 'processing') {
            if (now.getTime() - existing.processedAt.getTime() < PROCESSING_STALE_MS) {
              throw new SyncInProgressError();
            }
            // Abbruch zwischen Fachmutation und Quittung (§28/§3): NIE still erneut ausführen.
            // Operation-spezifische Wiederaufnahme – ist die Wirkung nachweislich vorhanden,
            // wird sie als bereits übernommen quittiert; sonst normale Ausführung.
            const recovered = await this.recover(
              mutation.type,
              mutation.payload,
              mutation.baseVersion,
              mutation.contextId,
              mutation.clientMutationId,
              now,
            );
            if (recovered !== null) {
              return this.finish(context, input, now, {
                status: 'applied',
                code: null,
                message: RECOVERED_MESSAGE,
                resultRef: recovered,
                details: null,
                deduplicated: true,
                persist: true,
              });
            }
          }
          // conflict/rejected (oder nicht nachweisbar angewendet): erneute Bewertung (Order §64).
        }

        // Phase 1: Quittung VOR der Fachmutation reservieren – ein Abbruch danach
        // hinterlässt nie eine unquittierte, aber ausgeführte Mutation.
        await this.reserve(context, input, now);
        try {
          const resultRef = await this.execute(context, input, now);
          return await this.finish(context, input, now, {
            status: 'applied',
            code: null,
            message: null,
            resultRef,
            details: null,
            deduplicated: false,
            persist: true,
          });
        } catch (error) {
          if (error instanceof SyncConflict) {
            return this.finish(context, input, now, {
              status: 'conflict',
              code: error.code,
              message: error.message,
              resultRef: null,
              details: error.details ?? defaultDetails(mutation.type, error.code, error.message),
              deduplicated: false,
              persist: true,
            });
          }
          if (error instanceof SyncRejected) {
            return this.finish(context, input, now, {
              status: 'rejected',
              code: error.code,
              message: error.message,
              resultRef: null,
              details: error.details ?? defaultDetails(mutation.type, error.code, error.message),
              deduplicated: false,
              persist: true,
            });
          }
          if (error instanceof AuthError) {
            // CONFLICT/NOT_FOUND: Serverzustand hat sich geändert (§32); FORBIDDEN/VALIDATION: dauerhaft.
            const conflict = error.code === 'CONFLICT' || error.code === 'NOT_FOUND';
            const code = conflict ? 'SERVER_STATE_CHANGED' : error.code;
            const message = neutralMessage(error);
            return this.finish(context, input, now, {
              status: conflict ? 'conflict' : 'rejected',
              code,
              message,
              resultRef: null,
              details: defaultDetails(mutation.type, code, message),
              deduplicated: false,
              persist: true,
            });
          }
          throw error;
        }
      }),
    );
  }

  // ── Quittungen ───────────────────────────────────────────────────────────

  private async receipt(clientMutationId: string): Promise<OfflineMutationReceipt | null> {
    const rows = await this.deps.db
      .select()
      .from(offlineMutationReceipts)
      .where(eq(offlineMutationReceipts.clientMutationId, clientMutationId));
    return rows[0] ?? null;
  }

  private receiptValues(context: AuthenticatedContext, input: SyncRequestInput, now: Date) {
    return {
      clientMutationId: input.mutation.clientMutationId,
      staffUserId: context.user.id,
      deviceId: input.deviceId,
      appEnv: this.deps.config.appEnv,
      operationType: input.mutation.type,
      contextKind: input.mutation.contextKind,
      contextId: input.mutation.contextId,
      clientCreatedAt: new Date(input.mutation.createdAt),
      processedAt: now,
    };
  }

  private async reserve(
    context: AuthenticatedContext,
    input: SyncRequestInput,
    now: Date,
  ): Promise<void> {
    const values = {
      ...this.receiptValues(context, input, now),
      status: 'processing' as const,
      resultRef: null,
      errorCode: null,
      message: null,
    };
    await this.deps.db
      .insert(offlineMutationReceipts)
      .values(values)
      .onConflictDoUpdate({ target: offlineMutationReceipts.clientMutationId, set: values });
  }

  private async finish(
    context: AuthenticatedContext,
    input: SyncRequestInput,
    now: Date,
    outcome: {
      status: 'applied' | 'conflict' | 'rejected';
      code: string | null;
      message: string | null;
      resultRef: ResultRef | null;
      details: ConflictDetails | null;
      deduplicated: boolean;
      persist: boolean;
    },
  ): Promise<SyncOutcomeResponse> {
    if (outcome.persist) {
      const values = {
        ...this.receiptValues(context, input, now),
        status: outcome.status,
        resultRef: outcome.resultRef,
        errorCode: outcome.status === 'applied' ? null : (outcome.code ?? 'UNKNOWN'),
        message: outcome.status === 'applied' ? null : outcome.message,
      };
      await this.deps.db
        .insert(offlineMutationReceipts)
        .values(values)
        .onConflictDoUpdate({ target: offlineMutationReceipts.clientMutationId, set: values });
    }
    return {
      status: outcome.status,
      resultRef: outcome.resultRef,
      code: outcome.code,
      message: outcome.message,
      details: outcome.status === 'applied' ? null : outcome.details,
      deduplicated: outcome.deduplicated,
      processedAt: now.toISOString(),
      serverTime: now.toISOString(),
    };
  }

  // ── Ausführung ───────────────────────────────────────────────────────────

  private async execute(
    context: AuthenticatedContext,
    input: SyncRequestInput,
    now: Date,
  ): Promise<ResultRef> {
    const { mutation } = input;
    const type = mutation.type;
    if (contextKindFor(type) !== mutation.contextKind) {
      throw new SyncRejected('VALIDATION', 'Kontextart passt nicht zum Mutationstyp.');
    }
    const payloadParse = MUTATION_PAYLOAD_SCHEMAS[type].safeParse(mutation.payload);
    if (!payloadParse.success) {
      throw new SyncRejected('VALIDATION', 'Die Offline-Erfassung ist strukturell ungültig.');
    }
    if (mutation.baseVersion === null) {
      // Ohne Basisstand keine Fachmutation: die Konfliktprüfungen (§33) wären abschaltbar.
      throw new SyncRejected('VALIDATION', 'Basisstand fehlt.');
    }
    let parsedBase: unknown;
    try {
      parsedBase = JSON.parse(mutation.baseVersion);
    } catch {
      throw new SyncRejected('VALIDATION', 'Basisstand ungültig.');
    }
    const baseParse = MUTATION_BASE_SCHEMAS[type].safeParse(parsedBase);
    if (!baseParse.success) throw new SyncRejected('VALIDATION', 'Basisstand ungültig.');
    const base: unknown = baseParse.data;

    // Rechte JEDER Mutation frisch prüfen (Order §74) – nie aus dem Offline-Snapshot.
    const effective = await this.deps.auth.effectivePermissions(context.user.id);
    for (const key of MUTATION_PERMISSIONS[type]) {
      if (!effective.has(key)) {
        throw new SyncRejected(
          'PERMISSION_REVOKED',
          'Dafür fehlt dir (inzwischen) die erforderliche Berechtigung.',
        );
      }
    }

    // Uhrzeit-Plausibilität (Order §69): 15 Minuten Toleranz, dokumentiert in TECH_DECISIONS.
    if (carriesCapturedTime(type)) {
      const skew = Math.abs(Date.parse(input.clientTime) - now.getTime());
      const created = Date.parse(mutation.createdAt);
      // Die getragene Erfassungszeit selbst (tatsächliche Ausgabe-/Rückgabezeit) darf weder
      // in der Zukunft liegen noch älter sein als die längste mögliche Offline-Phase.
      const carried = payloadParse.data as { capturedAt?: string; actualReturnAt?: string };
      const captured = Date.parse(carried.capturedAt ?? carried.actualReturnAt ?? '');
      if (
        skew > CLOCK_TOLERANCE_MS ||
        created > now.getTime() + CLOCK_TOLERANCE_MS ||
        created < now.getTime() - MAX_OFFLINE_AGE_MS ||
        !Number.isFinite(captured) ||
        captured > now.getTime() + CLOCK_TOLERANCE_MS ||
        captured < now.getTime() - MAX_OFFLINE_AGE_MS
      ) {
        const server =
          skew > CLOCK_TOLERANCE_MS
            ? `Gerätezeit weicht um ca. ${Math.round(skew / 60_000)} Minuten ab.`
            : 'Die erfasste Zeit liegt in der Zukunft oder zu weit zurück.';
        throw new SyncConflict('CLOCK_IMPLAUSIBLE', undefined, {
          offline: Number.isFinite(captured)
            ? `Offline erfasst: ${MUTATION_LABELS[type]} um ${berlinTimeLabel(new Date(captured))}`
            : offlineLabel(type),
          server,
          action: 'Gerätezeit prüfen und erneut synchronisieren.',
        });
      }
    }

    // Die getragene Erfassungszeit wird beim Abschluss zur tatsächlichen Ausgabe-/Rückgabezeit.
    // Ein echter Client setzt sie im Moment der Erfassung (= Erstellzeit der Mutation). Weicht
    // sie darüber hinaus ab, ist das fachlich eine Zeitkorrektur und verlangt – wie online –
    // das Korrekturrecht; sonst könnte ein manipulierter Client die Zeit rückdatieren.
    if (type === 'handover.finalize' || type === 'return.finalize') {
      const carried = payloadParse.data as { capturedAt: string };
      const drift = Math.abs(Date.parse(carried.capturedAt) - Date.parse(mutation.createdAt));
      const correctionKey =
        type === 'handover.finalize'
          ? 'handover.correct_actual_time'
          : 'return.correct_actual_time';
      if (drift > CLOCK_TOLERANCE_MS && !effective.has(correctionKey)) {
        throw new SyncRejected(
          'PERMISSION_REVOKED',
          'Die erfasste Zeit weicht von der Erfassung ab – für eine Zeitkorrektur fehlt das Recht.',
        );
      }
    }

    const media = this.decodeMedia(input);
    const actorId = context.user.id;
    const payload = payloadParse.data;

    if (type === 'machine.clean_complete') {
      return this.cleanComplete(
        actorId,
        mutation.contextId,
        payload as MutationPayload<'machine.clean_complete'>,
        base as MutationBase<'machine.clean_complete'>,
        now,
      );
    }
    return this.bookingMutation(
      actorId,
      effective,
      type,
      mutation.contextId,
      payload,
      base,
      media,
      now,
      mutation.clientMutationId,
    );
  }

  /** Maschinencode für Konfliktdetails (§4: Maschinencodes sind erlaubt, keine Kundendaten). */
  private async machineCodeOf(machineId: string | null): Promise<string> {
    if (machineId === null) return 'keine Maschine';
    const rows = await this.deps.db
      .select({ code: machines.machineCode })
      .from(machines)
      .where(eq(machines.id, machineId));
    return rows[0]?.code ?? 'unbekannte Maschine';
  }

  /** MACHINE_REASSIGNED mit konkreter Differenz: offline erwartete vs. aktuelle Maschine. */
  private async machineReassigned(
    offline: string,
    currentMachineCode: string | null,
    subject = 'Der Slot',
  ): Promise<SyncConflict> {
    return new SyncConflict('MACHINE_REASSIGNED', undefined, {
      offline,
      server:
        currentMachineCode === null
          ? `${subject} ist inzwischen keiner Maschine mehr zugeordnet.`
          : `${subject} ist inzwischen Maschine ${currentMachineCode} zugeordnet.`,
      action: 'Serverstand laden und Zuweisung prüfen.',
    });
  }

  /** Problemlage einer Maschine als neutrale Labels (keine Vorgangsnummern anderer Kunden). */
  private situationLabels(evaluation: MachineEvaluation): string {
    const labels = [
      ...new Set(evaluation.problems.filter((p) => !p.warningOnly).map((p) => p.label)),
    ];
    return labels.length === 0 ? 'keine Einschränkung mehr' : labels.join(', ');
  }

  /** Medien dekodieren und Hash prüfen (§75): Mismatch ⇒ rejected, nie still übernommen. */
  private decodeMedia(input: SyncRequestInput): Map<string, DecodedMedia> {
    const result = new Map<string, DecodedMedia>();
    for (const item of input.mutation.media) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(item.dataBase64, 'base64'));
      } catch {
        throw new SyncRejected('VALIDATION', 'Medium konnte nicht gelesen werden.');
      }
      const limit =
        item.purpose === 'handover_signature' || item.purpose === 'return_signature'
          ? SIGNATURE_MAX_BYTES
          : PHOTO_MAX_BYTES;
      if (bytes.length === 0 || bytes.length > limit) {
        throw new SyncRejected('VALIDATION', 'Medium ist leer oder zu groß.');
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== item.sha256) {
        throw new SyncRejected(
          'MEDIA_HASH_MISMATCH',
          'Die Prüfsumme eines Fotos/einer Unterschrift stimmt nicht – Übertragung abgelehnt.',
        );
      }
      if (result.has(item.mediaId)) {
        throw new SyncRejected('VALIDATION', 'Doppelte Medien-ID in einer Mutation.');
      }
      result.set(item.mediaId, {
        mediaId: item.mediaId,
        purpose: item.purpose,
        mimeType: item.mimeType,
        sha256: digest,
        bytes,
      });
    }
    return result;
  }

  private mediaFor(
    media: Map<string, DecodedMedia>,
    mediaId: string,
    purpose: MediaPurpose,
  ): DecodedMedia {
    const file = media.get(mediaId);
    if (file === undefined) {
      throw new SyncRejected('VALIDATION', 'Das referenzierte Foto/die Unterschrift fehlt.');
    }
    if (file.purpose !== purpose) {
      throw new SyncRejected('VALIDATION', 'Medienzweck passt nicht zur Aktion.');
    }
    return file;
  }

  private embeddable(file: DecodedMedia): 'image/jpeg' | 'image/png' {
    if (file.mimeType === 'image/webp') {
      throw new SyncRejected('VALIDATION', 'Fotos im Protokoll müssen JPEG oder PNG sein.');
    }
    return file.mimeType;
  }

  // ── Vorgangsbezogene Mutationen ──────────────────────────────────────────

  private async bookingMutation(
    actorId: string,
    effective: ReadonlySet<PermissionKey>,
    type: Exclude<OfflineMutationType, 'machine.clean_complete'>,
    bookingId: string,
    payload: unknown,
    base: unknown,
    media: Map<string, DecodedMedia>,
    now: Date,
    operationId: string,
  ): Promise<ResultRef> {
    const bookingRows = await this.deps.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    const booking = bookingRows[0];
    if (booking === undefined) throw new SyncConflict('NOT_VISIBLE');
    const process = await this.deps.processes.getProcess(booking.processId);
    const visibility = buildVisibilityContext(
      effective,
      await getCompletedVisibilityDays(this.deps.db),
      now,
    );
    if (!isProcessVisible(process, visibility)) throw new SyncConflict('NOT_VISIBLE');
    if (process.mainStatus === 'cancelled') throw new SyncConflict('PROCESS_CANCELLED');
    if (type.startsWith('handover.') && process.mainStatus === 'completed') {
      throw new SyncConflict('PROCESS_COMPLETED');
    }

    if (type.startsWith('handover.')) {
      const detail = await this.deps.handover.detail(bookingId, now);
      if (detail.handover.status === 'finalized') throw new SyncConflict('ALREADY_FINALIZED');
      return this.handoverMutation(
        actorId,
        effective,
        type,
        bookingId,
        detail,
        payload,
        base,
        media,
        now,
        operationId,
      );
    }
    return this.returnMutation(
      actorId,
      effective,
      type,
      bookingId,
      payload,
      base,
      media,
      now,
      operationId,
    );
  }

  /** Basisstand des Termins (§33): geänderte Version ⇒ APPOINTMENT_CHANGED mit neuer Zeit. */
  private async assertAppointmentUnchanged(base: BookingBase): Promise<void> {
    if (base.appointmentId === null) return;
    const rows = await this.deps.db
      .select({
        version: appointments.version,
        status: appointments.status,
        kind: appointments.kind,
        startAt: appointments.startAt,
      })
      .from(appointments)
      .where(eq(appointments.id, base.appointmentId));
    const row = rows[0];
    if (row === undefined || row.version !== base.appointmentVersion) {
      // Der Client kennt die alte Terminzeit aus seinem Snapshot – `offline` bleibt null (§4).
      let server: string;
      if (row === undefined) {
        server = 'Der Termin existiert nicht mehr.';
      } else {
        const kind = row.kind === 'return' ? 'Rückgabe' : 'Ausgabe';
        server =
          row.status === 'cancelled'
            ? `${kind}-Termin wurde inzwischen abgesagt.`
            : row.startAt === null
              ? `${kind} inzwischen ohne feste Zeit geplant.`
              : `${kind} inzwischen auf ${berlinTimeLabel(row.startAt)} geändert.`;
      }
      throw new SyncConflict('APPOINTMENT_CHANGED', undefined, {
        offline: null,
        server,
        action: 'Serverstand laden und Termin prüfen.',
      });
    }
  }

  private async handoverMutation(
    actorId: string,
    effective: ReadonlySet<PermissionKey>,
    type: OfflineMutationType,
    bookingId: string,
    detail: HandoverDetailView,
    payload: unknown,
    base: unknown,
    media: Map<string, DecodedMedia>,
    now: Date,
    operationId: string,
  ): Promise<ResultRef> {
    const slotOf = (assignmentId: string) => {
      const slot = detail.slots.find((s) => s.id === assignmentId);
      if (slot === undefined) throw new SyncRejected('VALIDATION', 'Zuordnung nicht gefunden.');
      return slot;
    };
    const assertSlotMachine = async (assignmentId: string, machineId: string) => {
      const slot = slotOf(assignmentId);
      if ((slot.machine?.id ?? null) !== machineId) {
        throw await this.machineReassigned(
          `Offline-Grundlage: Maschine ${await this.machineCodeOf(machineId)}`,
          slot.machine?.machineCode ?? null,
        );
      }
      return slot;
    };
    const slotTaken = (status: string): SyncConflict =>
      new SyncConflict('SERVER_STATE_CHANGED', undefined, {
        offline: offlineLabel(type),
        server:
          status === 'issued'
            ? 'Die Maschine dieses Slots ist inzwischen ausgegeben.'
            : 'Die Maschine dieses Slots ist inzwischen zurückgegeben.',
        action: ACTION_LOAD_SERVER_STATE,
      });

    switch (type) {
      case 'handover.assign': {
        const p = payload as MutationPayload<'handover.assign'>;
        const b = base as MutationBase<'handover.assign'>;
        const slot = slotOf(p.assignmentId);
        const chosenCode = await this.machineCodeOf(p.machineId);
        const offline =
          p.override === null
            ? `Offline gewählt: ${chosenCode}`
            : `Offline gewählt: ${chosenCode} (mit Bestätigung der Problemlage)`;
        if ((slot.machine?.id ?? null) !== b.expectedMachineId) {
          throw await this.machineReassigned(
            `${offline}; Grundlage: ${await this.machineCodeOf(b.expectedMachineId)}`,
            slot.machine?.machineCode ?? null,
          );
        }
        if (slot.status === 'issued' || slot.status === 'returned') throw slotTaken(slot.status);
        if (slot.machine?.id === p.machineId)
          return { assignmentId: slot.id, machineId: p.machineId };
        const assignment = await this.deps.assignments.assignmentById(p.assignmentId);
        const interval = await this.deps.assignments.rentalIntervalFor(bookingId);
        const evaluation = await this.deps.assignments.evaluateMachine(
          p.machineId,
          { ...assignment, rentalFrom: interval.from, rentalTo: interval.to },
          now,
        );
        if (evaluation.hardBlocked) {
          const code = evaluation.machineCode;
          // Harte Blocker sind ausschließlich „an anderen Vorgang ausgegeben“ und „vermietet“.
          const server = evaluation.problems.some((pr) => pr.code === 'issued_elsewhere')
            ? `Maschine ${code} ist inzwischen an einen anderen Vorgang ausgegeben.`
            : `Maschine ${code} ist inzwischen vermietet (Status „${MACHINE_STATUS_LABELS.rented}“).`;
          throw new SyncConflict('MACHINE_UNAVAILABLE', undefined, {
            offline,
            server,
            action: 'Serverstand laden und eine andere Maschine wählen.',
          });
        }
        if (
          (p.situationFingerprint !== null &&
            evaluation.situationFingerprint !== p.situationFingerprint) ||
          (evaluation.overrideRequired && p.override === null)
        ) {
          throw new SyncConflict('SITUATION_CHANGED', undefined, {
            offline,
            server: `Die Problemlage von ${evaluation.machineCode} hat sich geändert: ${this.situationLabels(evaluation)}.`,
            action: 'Serverstand laden und Problemlage erneut prüfen.',
          });
        }
        const view = await this.deps.assignments.assign(
          actorId,
          effective,
          p.assignmentId,
          p.machineId,
          p.override,
          now,
        );
        return { assignmentId: view.id, machineId: p.machineId };
      }
      case 'handover.prepare': {
        const p = payload as MutationPayload<'handover.prepare'>;
        const b = base as MutationBase<'handover.prepare'>;
        const slot = slotOf(p.assignmentId);
        if ((slot.machine?.id ?? null) !== b.expectedMachineId || slot.machine === null) {
          throw await this.machineReassigned(
            `Offline-Grundlage: Maschine ${await this.machineCodeOf(b.expectedMachineId)}`,
            slot.machine?.machineCode ?? null,
          );
        }
        if (slot.status === 'prepared') return { assignmentId: slot.id };
        if (slot.status === 'issued' || slot.status === 'returned') throw slotTaken(slot.status);
        await this.deps.assignments.prepare(actorId, p.assignmentId, now);
        return { assignmentId: slot.id };
      }
      case 'handover.check_machine': {
        const p = payload as MutationPayload<'handover.check_machine'>;
        await assertSlotMachine(p.assignmentId, p.machineId);
        await this.deps.handover.checkMachine(actorId, bookingId, p.assignmentId, now);
        return { assignmentId: p.assignmentId };
      }
      case 'handover.photo': {
        const p = payload as MutationPayload<'handover.photo'>;
        await assertSlotMachine(p.assignmentId, p.machineId);
        const file = this.mediaFor(media, p.mediaId, 'handover_photo');
        // Foto-Dedup per SHA-256 (§28): dieselben Bytes erzeugen kein zweites Fachobjekt.
        const dup = await this.deps.db
          .select({ id: handoverPhotos.id })
          .from(handoverPhotos)
          .where(
            and(
              eq(handoverPhotos.handoverId, detail.handover.id),
              eq(handoverPhotos.assignmentId, p.assignmentId),
              eq(handoverPhotos.sha256, file.sha256),
            ),
          );
        if (dup[0] !== undefined) return { photoId: dup[0].id };
        const { photoId } = await this.deps.handover.addPhoto(
          actorId,
          bookingId,
          p.assignmentId,
          { bytes: file.bytes, mimeType: file.mimeType },
          now,
          operationId,
        );
        return { photoId };
      }
      case 'handover.item_quantity': {
        const p = payload as MutationPayload<'handover.item_quantity'>;
        const item = detail.deliveryNote.items.find((i) => i.id === p.itemId);
        if (item === undefined) {
          throw new SyncConflict('SERVER_STATE_CHANGED', undefined, {
            offline: `Offline erfasst: Menge ${p.actualQuantity}`,
            server: 'Die Lieferscheinposition existiert serverseitig nicht mehr.',
            action: ACTION_LOAD_SERVER_STATE,
          });
        }
        if (item.actualQuantity === p.actualQuantity) return { itemId: item.id };
        if (item.actualQuantity !== p.expectedPreviousQuantity) {
          throw new SyncConflict('QUANTITY_CHANGED', undefined, {
            offline: `Offline erfasst: Menge ${p.actualQuantity} (Grundlage: Menge ${p.expectedPreviousQuantity})`,
            server: `Serverseitig inzwischen Menge ${item.actualQuantity}.`,
            action: 'Menge am Serverstand prüfen und erneut erfassen.',
          });
        }
        await this.deps.handover.updateItemQuantity(bookingId, p.itemId, p.actualQuantity, now);
        return { itemId: item.id };
      }
      case 'handover.recipient': {
        const p = payload as MutationPayload<'handover.recipient'>;
        await this.deps.handover.setRecipient(
          bookingId,
          { kind: p.kind, name: p.name, phone: p.phone },
          now,
        );
        return { bookingId };
      }
      case 'handover.signature': {
        const p = payload as MutationPayload<'handover.signature'>;
        const file = this.mediaFor(media, p.mediaId, 'handover_signature');
        // Mitarbeiter-Identität kommt ausschließlich aus der Session (§21).
        await this.deps.handover.sign(actorId, bookingId, p.role, file.bytes, now, operationId);
        return { bookingId, role: p.role };
      }
      case 'handover.finalize': {
        const p = payload as MutationPayload<'handover.finalize'>;
        await this.assertAppointmentUnchanged(base as BookingBase);
        for (const expected of p.expectedSlots) {
          const slot = slotOf(expected.assignmentId);
          if ((slot.machine?.id ?? null) !== expected.machineId) {
            throw await this.machineReassigned(
              `Offline-Grundlage: Maschine ${await this.machineCodeOf(expected.machineId)}`,
              slot.machine?.machineCode ?? null,
            );
          }
        }
        if (detail.blockers.length > 0) {
          throw new SyncConflict(
            'SERVER_STATE_CHANGED',
            'Der Serverstand erfüllt die Vorbedingungen des Abschlusses nicht mehr – bitte prüfen.',
            {
              offline: offlineLabel(type),
              server: `Der Serverstand erfüllt die Vorbedingungen des Abschlusses nicht mehr (${detail.blockers.length} offen).`,
              action: 'Serverstand laden und fehlende Schritte nachholen.',
            },
          );
        }
        const view = await this.deps.handover.finalize(
          actorId,
          bookingId,
          { actualIssueAt: new Date(p.capturedAt) },
          now,
        );
        const ref: ResultRef = { bookingId, handoverId: view.handover.id };
        if (view.handover.protocolDocumentId !== null) {
          ref.protocolDocumentId = view.handover.protocolDocumentId;
        }
        return ref;
      }
      default:
        throw new SyncRejected('VALIDATION', 'Unbekannter Mutationstyp.');
    }
  }

  private async returnMutation(
    actorId: string,
    effective: ReadonlySet<PermissionKey>,
    type: OfflineMutationType,
    bookingId: string,
    payload: unknown,
    base: unknown,
    media: Map<string, DecodedMedia>,
    now: Date,
    operationId: string,
  ): Promise<ResultRef> {
    const existing = await this.deps.returns.returnFor(bookingId);
    if (type === 'return.start') {
      if (existing !== null) return { returnId: existing.id };
      const created = await this.deps.returns.start(actorId, bookingId, now);
      return { returnId: created.id };
    }
    // Alle weiteren Rückgabe-Mutationen setzen die (offline zuerst erfasste) Rückgabe voraus.
    if (existing === null) {
      throw new SyncConflict('DEPENDENCY_NOT_APPLIED', undefined, {
        offline: offlineLabel(type),
        server: 'Die Rückgabe wurde serverseitig noch nicht begonnen.',
        action: 'Zuerst „Rückgabe begonnen“ übertragen bzw. klären.',
      });
    }
    const detail: ReturnDetailView = await this.deps.returns.detail(bookingId, now);
    if (detail.return.status === 'finalized') throw new SyncConflict('ALREADY_FINALIZED');
    const machineOf = async (assignmentId: string, machineId: string) => {
      const rm = detail.machines.find((m) => m.assignmentId === assignmentId);
      if (rm === undefined)
        throw new SyncRejected('VALIDATION', 'Rückgabeabschnitt nicht gefunden.');
      if (rm.machineId !== machineId) {
        throw await this.machineReassigned(
          `Offline-Grundlage: Maschine ${await this.machineCodeOf(machineId)}`,
          rm.machineCode,
          'Der Rückgabeabschnitt',
        );
      }
      return rm;
    };

    switch (type) {
      case 'return.returner': {
        const p = payload as MutationPayload<'return.returner'>;
        await this.deps.returns.setReturner(
          actorId,
          bookingId,
          { kind: p.kind, firstName: p.firstName, lastName: p.lastName, phone: p.phone },
          now,
        );
        return { returnId: existing.id };
      }
      case 'return.accessory': {
        const p = payload as MutationPayload<'return.accessory'>;
        const rm = await machineOf(p.assignmentId, p.machineId);
        if (rm.accessoryComplete === true) return { returnMachineId: rm.id };
        await this.deps.returns.confirmAccessoriesComplete(actorId, bookingId, rm.id, now);
        return { returnMachineId: rm.id };
      }
      case 'return.missing_item': {
        const p = payload as MutationPayload<'return.missing_item'>;
        const rm = await machineOf(p.assignmentId, p.machineId);
        const { caseId } = await this.deps.returns.addMissingCase(
          actorId,
          bookingId,
          rm.id,
          {
            accessoryType: p.accessoryType,
            missingQuantity: p.missingQuantity,
            description: p.description,
          },
          now,
          operationId,
        );
        return { caseId };
      }
      case 'return.cleanliness': {
        const p = payload as MutationPayload<'return.cleanliness'>;
        const rm = await machineOf(p.assignmentId, p.machineId);
        await this.deps.returns.checkCleanliness(
          actorId,
          effective,
          bookingId,
          rm.id,
          {
            emptied: p.emptied,
            rinsedTwice: p.rinsedTwice,
            nothingDismantled: p.nothingDismantled,
          },
          now,
        );
        return { returnMachineId: rm.id };
      }
      case 'return.cleanup_photo': {
        const p = payload as MutationPayload<'return.cleanup_photo'>;
        const rm = await machineOf(p.assignmentId, p.machineId);
        const file = this.mediaFor(media, p.mediaId, 'return_cleanup_photo');
        const mimeType = this.embeddable(file);
        const dup = await this.deps.db
          .select({ id: returnPhotos.id })
          .from(returnPhotos)
          .where(
            and(eq(returnPhotos.returnMachineId, rm.id), eq(returnPhotos.sha256, file.sha256)),
          );
        if (dup[0] !== undefined) return { photoId: dup[0].id };
        const { photoId } = await this.deps.returns.addCleanupPhoto(
          actorId,
          bookingId,
          rm.id,
          { bytes: file.bytes, mimeType },
          now,
          operationId,
        );
        return { photoId };
      }
      case 'return.item_quantity': {
        const p = payload as MutationPayload<'return.item_quantity'>;
        const item = detail.items.find((i) => i.deliveryNoteItemId === p.deliveryNoteItemId);
        const offline = `Offline erfasst: ${p.returnedUnopenedQuantity} ungeöffnet zurück (Grundlage: ${p.expectedIssuedQuantity} ausgegeben)`;
        if (item === undefined) {
          throw new SyncConflict('SERVER_STATE_CHANGED', undefined, {
            offline,
            server: 'Die Kommissionsposition existiert serverseitig nicht mehr.',
            action: ACTION_LOAD_SERVER_STATE,
          });
        }
        if (item.issuedQuantity !== p.expectedIssuedQuantity) {
          throw new SyncConflict('QUANTITY_CHANGED', undefined, {
            offline,
            server: `Serverseitig inzwischen ${item.issuedQuantity} ausgegeben.`,
            action: 'Menge am Serverstand prüfen und erneut erfassen.',
          });
        }
        if (p.returnedUnopenedQuantity > item.issuedQuantity) {
          throw new SyncRejected(
            'VALIDATION',
            'Es können nicht mehr ungeöffnete Einheiten zurückgegeben werden als ausgegeben wurden.',
          );
        }
        if (item.returnedUnopenedQuantity === p.returnedUnopenedQuantity)
          return { itemId: item.id };
        await this.deps.returns.setReturnedQuantity(
          actorId,
          bookingId,
          item.id,
          p.returnedUnopenedQuantity,
          now,
        );
        return { itemId: item.id };
      }
      case 'return.damage': {
        const p = payload as MutationPayload<'return.damage'>;
        const rm = await machineOf(p.assignmentId, p.machineId);
        const { damageId } = await this.deps.returns.addDamage(
          actorId,
          bookingId,
          rm.id,
          {
            severity: p.severity,
            description: p.description,
            markers: p.markers.map((marker) => ({
              view: marker.view,
              markerType: marker.markerType,
              x: marker.x,
              y: marker.y,
              width: marker.width ?? null,
              height: marker.height ?? null,
            })),
          },
          now,
          operationId,
        );
        return { damageId };
      }
      case 'return.damage_photo': {
        const p = payload as MutationPayload<'return.damage_photo'>;
        let damageId = p.damageId;
        if (p.damageMutationId !== null) {
          // Der Schaden selbst war eine lokale Mutation: nur über eine angewendete
          // Quittung desselben Benutzers auflösbar (§29).
          const receipt = await this.receipt(p.damageMutationId);
          const ref = (receipt?.resultRef ?? null) as ResultRef | null;
          if (
            receipt === null ||
            receipt.staffUserId !== actorId ||
            receipt.status !== 'applied' ||
            receipt.operationType !== 'return.damage' ||
            typeof ref?.damageId !== 'string'
          ) {
            throw new SyncConflict('DEPENDENCY_NOT_APPLIED', undefined, {
              offline: offlineLabel(type),
              server: 'Der zugehörige Schaden wurde serverseitig nicht übernommen.',
              action: 'Zuerst die Schadenserfassung klären.',
            });
          }
          damageId = ref.damageId;
        }
        if (damageId === null) throw new SyncRejected('VALIDATION', 'Schadensreferenz fehlt.');
        const damage = detail.machines.flatMap((m) => m.damages).find((d) => d.id === damageId);
        if (damage === undefined) {
          throw new SyncConflict('SERVER_STATE_CHANGED', undefined, {
            offline: offlineLabel(type),
            server: 'Der zugehörige Schaden existiert in dieser Rückgabe nicht mehr.',
            action: ACTION_LOAD_SERVER_STATE,
          });
        }
        const file = this.mediaFor(media, p.mediaId, 'return_damage_photo');
        const mimeType = this.embeddable(file);
        const dup = await this.deps.db
          .select({ id: damagePhotos.id })
          .from(damagePhotos)
          .where(and(eq(damagePhotos.damageId, damageId), eq(damagePhotos.sha256, file.sha256)));
        if (dup[0] !== undefined) return { damageId, photoId: dup[0].id };
        const { photoId } = await this.deps.damages.addPhoto(
          actorId,
          damageId,
          { bytes: file.bytes, mimeType },
          now,
          operationId,
        );
        return { damageId, photoId };
      }
      case 'return.signature': {
        const p = payload as MutationPayload<'return.signature'>;
        const file = this.mediaFor(media, p.mediaId, 'return_signature');
        // Mitarbeiter-Identität kommt ausschließlich aus der Session (§21).
        await this.deps.returns.sign(actorId, bookingId, p.role, file.bytes, now, operationId);
        return { returnId: existing.id, role: p.role };
      }
      case 'return.actual_time': {
        const p = payload as MutationPayload<'return.actual_time'>;
        await this.deps.returns.setDraftActualReturnAt(
          actorId,
          bookingId,
          new Date(p.actualReturnAt),
          now,
        );
        return { returnId: existing.id };
      }
      case 'return.finalize': {
        const p = payload as MutationPayload<'return.finalize'>;
        await this.assertAppointmentUnchanged(base as BookingBase);
        if (p.expectedMachines.length !== detail.machines.length) {
          throw new SyncConflict('SERVER_STATE_CHANGED', undefined, {
            offline: `Offline erfasst: Rückgabe mit ${p.expectedMachines.length} Maschine(n)`,
            server: `Die Rückgabe umfasst serverseitig ${detail.machines.length} Maschine(n).`,
            action: ACTION_LOAD_SERVER_STATE,
          });
        }
        for (const expected of p.expectedMachines)
          await machineOf(expected.assignmentId, expected.machineId);
        if (detail.blockers.length > 0) {
          throw new SyncConflict(
            'SERVER_STATE_CHANGED',
            'Der Serverstand erfüllt die Vorbedingungen des Abschlusses nicht mehr – bitte prüfen.',
            {
              offline: offlineLabel(type),
              server: `Der Serverstand erfüllt die Vorbedingungen des Abschlusses nicht mehr (${detail.blockers.length} offen).`,
              action: 'Serverstand laden und fehlende Schritte nachholen.',
            },
          );
        }
        // Tatsächliche Rückgabezeit = Erfassungszeit am Gerät (plausibilisiert), sofern
        // nicht bereits eine explizite Rückgabezeit (return.actual_time) gesetzt wurde.
        if (detail.return.draftActualReturnAt === null) {
          await this.deps.returns.setDraftActualReturnAt(
            actorId,
            bookingId,
            new Date(p.capturedAt),
            now,
          );
        }
        const view = await this.deps.returns.finalize(actorId, bookingId, now);
        const ref: ResultRef = { bookingId, returnId: view.return.id };
        if (view.return.protocolDocumentId !== null) {
          ref.protocolDocumentId = view.return.protocolDocumentId;
        }
        return ref;
      }
      default:
        throw new SyncRejected('VALIDATION', 'Unbekannter Mutationstyp.');
    }
  }

  // ── Wiederaufnahme nach Abbruch (Order-Finalisierung §3) ─────────────────

  /**
   * Prüft operation-spezifisch, ob die Wirkung einer Mutation mit veralteter
   * `processing`-Quittung bereits existiert. Insert-Typen über die am Fachobjekt
   * gespeicherte `client_mutation_id`, Zustandsänderungen über den Zielzustand,
   * Finalisierungen/Reinigungsabschluss zusätzlich über Akteur und Zeitpunkt nach
   * der Reservierung (ein Abschluss durch ein ANDERES Gerät zählt nicht als
   * Wirkung dieser Mutation). Liefert den ResultRef wie bei Erfolg oder null.
   * Der Basisstand ist hier bewusst unerheblich: maßgeblich ist, ob genau diese
   * Mutation gewirkt hat – nicht, ob sie heute noch anwendbar wäre.
   */
  private async recover(
    type: OfflineMutationType,
    payload: unknown,
    base: string | null,
    contextId: string,
    clientMutationId: string,
    now: Date,
  ): Promise<ResultRef | null> {
    void base;
    const parsed = MUTATION_PAYLOAD_SCHEMAS[type].safeParse(payload);
    if (!parsed.success) return null;
    const receipt = await this.receipt(clientMutationId);
    if (receipt === null) return null;
    const reservedAt = receipt.processedAt;
    const actorId = receipt.staffUserId;
    const p = parsed.data;
    const byMutation = <T extends { id: string }>(rows: T[]): T | null => rows[0] ?? null;

    try {
      if (type === 'machine.clean_complete') {
        const rows = await this.deps.db.select().from(machines).where(eq(machines.id, contextId));
        const machine = rows[0];
        if (machine === undefined) return null;
        const completedAfterReservation =
          machine.cleanedAt !== null && machine.cleanedAt.getTime() >= reservedAt.getTime();
        if (
          machine.status === 'ready' &&
          completedAfterReservation &&
          machine.cleanedBy === actorId
        ) {
          return { machineId: machine.id, status: machine.status };
        }
        return null;
      }

      if (type.startsWith('handover.')) {
        const handoverRows = await this.deps.db
          .select()
          .from(handovers)
          .where(eq(handovers.bookingId, contextId));
        const handover = handoverRows[0];
        if (handover === undefined) return null;
        switch (type) {
          case 'handover.photo': {
            const row = byMutation(
              await this.deps.db
                .select({ id: handoverPhotos.id })
                .from(handoverPhotos)
                .where(eq(handoverPhotos.clientMutationId, clientMutationId)),
            );
            return row === null ? null : { photoId: row.id };
          }
          case 'handover.signature': {
            const sp = p as MutationPayload<'handover.signature'>;
            const row = byMutation(
              await this.deps.db
                .select({ id: handoverSignatures.id })
                .from(handoverSignatures)
                .where(eq(handoverSignatures.clientMutationId, clientMutationId)),
            );
            return row === null ? null : { bookingId: contextId, role: sp.role };
          }
          case 'handover.finalize': {
            if (
              handover.status !== 'finalized' ||
              handover.finalizedBy !== actorId ||
              handover.finalizedAt === null ||
              handover.finalizedAt.getTime() < reservedAt.getTime()
            ) {
              return null;
            }
            const ref: ResultRef = { bookingId: contextId, handoverId: handover.id };
            if (handover.protocolDocumentId !== null) {
              ref.protocolDocumentId = handover.protocolDocumentId;
            }
            return ref;
          }
          default:
            break;
        }
        const detail = await this.deps.handover.detail(contextId, now);
        switch (type) {
          case 'handover.assign': {
            const ap = p as MutationPayload<'handover.assign'>;
            const slot = detail.slots.find((s) => s.id === ap.assignmentId);
            return slot?.machine?.id === ap.machineId
              ? { assignmentId: slot.id, machineId: ap.machineId }
              : null;
          }
          case 'handover.prepare': {
            const pp = p as MutationPayload<'handover.prepare'>;
            const slot = detail.slots.find((s) => s.id === pp.assignmentId);
            const prepared =
              slot !== undefined &&
              slot.machine !== null &&
              (slot.status === 'prepared' ||
                slot.status === 'issued' ||
                slot.status === 'returned');
            return prepared ? { assignmentId: slot.id } : null;
          }
          case 'handover.check_machine': {
            const cp = p as MutationPayload<'handover.check_machine'>;
            const entry = detail.machines.find((m) => m.assignmentId === cp.assignmentId);
            return entry !== undefined && entry.checked && entry.machineId === cp.machineId
              ? { assignmentId: cp.assignmentId }
              : null;
          }
          case 'handover.item_quantity': {
            const qp = p as MutationPayload<'handover.item_quantity'>;
            const item = detail.deliveryNote.items.find((i) => i.id === qp.itemId);
            return item !== undefined && item.actualQuantity === qp.actualQuantity
              ? { itemId: item.id }
              : null;
          }
          case 'handover.recipient': {
            const rp = p as MutationPayload<'handover.recipient'>;
            if (detail.handover.recipientKind !== rp.kind) return null;
            if (rp.kind === 'other') {
              const name = (rp.name ?? '').trim();
              const phone = (rp.phone ?? '').trim() === '' ? null : (rp.phone ?? '').trim();
              if (detail.handover.recipientName !== name) return null;
              if ((detail.handover.recipientPhone ?? null) !== phone) return null;
            }
            return { bookingId: contextId };
          }
          default:
            return null;
        }
      }

      // Rückgabe-Mutationen
      const returnRows = await this.deps.db
        .select()
        .from(rentalReturns)
        .where(eq(rentalReturns.bookingId, contextId));
      const ret = returnRows[0];
      if (ret === undefined) return null;
      switch (type) {
        case 'return.start':
          return { returnId: ret.id };
        case 'return.missing_item': {
          const row = byMutation(
            await this.deps.db
              .select({ id: missingAccessoryCases.id })
              .from(missingAccessoryCases)
              .where(eq(missingAccessoryCases.clientMutationId, clientMutationId)),
          );
          return row === null ? null : { caseId: row.id };
        }
        case 'return.cleanup_photo': {
          const row = byMutation(
            await this.deps.db
              .select({ id: returnPhotos.id })
              .from(returnPhotos)
              .where(eq(returnPhotos.clientMutationId, clientMutationId)),
          );
          return row === null ? null : { photoId: row.id };
        }
        case 'return.damage': {
          const row = byMutation(
            await this.deps.db
              .select({ id: machineDamages.id })
              .from(machineDamages)
              .where(eq(machineDamages.clientMutationId, clientMutationId)),
          );
          return row === null ? null : { damageId: row.id };
        }
        case 'return.damage_photo': {
          const rows = await this.deps.db
            .select({ id: damagePhotos.id, damageId: damagePhotos.damageId })
            .from(damagePhotos)
            .where(eq(damagePhotos.clientMutationId, clientMutationId));
          const row = rows[0];
          return row === undefined ? null : { damageId: row.damageId, photoId: row.id };
        }
        case 'return.signature': {
          const sp = p as MutationPayload<'return.signature'>;
          const row = byMutation(
            await this.deps.db
              .select({ id: returnSignatures.id })
              .from(returnSignatures)
              .where(eq(returnSignatures.clientMutationId, clientMutationId)),
          );
          return row === null ? null : { returnId: ret.id, role: sp.role };
        }
        case 'return.returner': {
          const rp = p as MutationPayload<'return.returner'>;
          if (ret.returnerKind !== rp.kind) return null;
          if (rp.kind === 'other') {
            const name = `${(rp.firstName ?? '').trim()} ${(rp.lastName ?? '').trim()}`;
            if (ret.returnerName !== name || (ret.returnerPhone ?? '') !== (rp.phone ?? '').trim())
              return null;
          }
          return { returnId: ret.id };
        }
        case 'return.actual_time': {
          const tp = p as MutationPayload<'return.actual_time'>;
          const wanted = new Date(tp.actualReturnAt).getTime();
          const matches =
            ret.draftActualReturnAt?.getTime() === wanted ||
            ret.actualReturnAt?.getTime() === wanted;
          return matches ? { returnId: ret.id } : null;
        }
        case 'return.finalize': {
          if (
            ret.status !== 'finalized' ||
            ret.finalizedBy !== actorId ||
            ret.finalizedAt === null ||
            ret.finalizedAt.getTime() < reservedAt.getTime()
          ) {
            return null;
          }
          const ref: ResultRef = { bookingId: contextId, returnId: ret.id };
          if (ret.protocolDocumentId !== null) ref.protocolDocumentId = ret.protocolDocumentId;
          return ref;
        }
        default:
          break;
      }
      const detail = await this.deps.returns.detail(contextId, now);
      switch (type) {
        case 'return.accessory': {
          const ap = p as MutationPayload<'return.accessory'>;
          const rm = detail.machines.find((m) => m.assignmentId === ap.assignmentId);
          return rm !== undefined && rm.machineId === ap.machineId && rm.accessoryComplete === true
            ? { returnMachineId: rm.id }
            : null;
        }
        case 'return.cleanliness': {
          const cp = p as MutationPayload<'return.cleanliness'>;
          const rm = detail.machines.find((m) => m.assignmentId === cp.assignmentId);
          const same =
            rm !== undefined &&
            rm.machineId === cp.machineId &&
            rm.cleanlinessCheckedAt !== null &&
            rm.emptied === cp.emptied &&
            rm.rinsedTwice === cp.rinsedTwice &&
            rm.nothingDismantled === cp.nothingDismantled;
          return same ? { returnMachineId: rm.id } : null;
        }
        case 'return.item_quantity': {
          const qp = p as MutationPayload<'return.item_quantity'>;
          const item = detail.items.find((i) => i.deliveryNoteItemId === qp.deliveryNoteItemId);
          return item !== undefined && item.returnedUnopenedQuantity === qp.returnedUnopenedQuantity
            ? { itemId: item.id }
            : null;
        }
        default:
          return null;
      }
    } catch (error) {
      // Nicht nachweisbar (z. B. Vorgang nicht mehr lesbar) ⇒ normale Ausführung entscheidet.
      if (error instanceof AuthError) return null;
      throw error;
    }
  }

  // ── Reinigung ────────────────────────────────────────────────────────────

  private async cleanComplete(
    actorId: string,
    machineId: string,
    payload: MutationPayload<'machine.clean_complete'>,
    base: MutationBase<'machine.clean_complete'>,
    now: Date,
  ): Promise<ResultRef> {
    const { machine } = await this.deps.machines.byId(machineId);
    const offline =
      payload.expectedCleaningSince === null
        ? offlineLabel('machine.clean_complete')
        : `${offlineLabel('machine.clean_complete')} (Reinigung seit ${berlinTimeLabel(new Date(payload.expectedCleaningSince))})`;
    if (machine.status !== 'cleaning') {
      throw new SyncConflict('NOT_IN_CLEANING', undefined, {
        offline,
        server: `Maschine ${machine.machineCode} ist inzwischen „${MACHINE_STATUS_LABELS[machine.status]}“.`,
        action: 'Maschinenstatus prüfen; die Erfassung ist vermutlich überholt.',
      });
    }
    const cleaningSince = machine.cleaningSince?.toISOString() ?? null;
    const expected =
      payload.expectedCleaningSince === null
        ? null
        : new Date(payload.expectedCleaningSince).toISOString();
    // Anderer Reinigungsbeginn = anderer Zyklus (§25): kein stilles Überschreiben.
    if (cleaningSince !== expected) {
      throw new SyncConflict('CLEANING_CYCLE_CHANGED', undefined, {
        offline,
        server:
          machine.cleaningSince === null
            ? `Maschine ${machine.machineCode} ist inzwischen in einem neuen Reinigungszyklus.`
            : `Maschine ${machine.machineCode} ist inzwischen in einem neuen Reinigungszyklus (seit ${berlinTimeLabel(machine.cleaningSince)}).`,
        action: 'Serverstand laden und den aktuellen Reinigungszyklus prüfen.',
      });
    }
    // base.machineUpdatedAt ist nur Basisstand-Pflicht (§33); maßgeblich für den
    // Reinigungszyklus ist ausschließlich der Reinigungsbeginn.
    void base;
    const updated = await this.deps.returns.completeCleaning(actorId, machineId, now);
    return { machineId: updated.id, status: updated.status };
  }
}
