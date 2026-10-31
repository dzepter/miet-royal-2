import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig } from '@mietroyal/config';
import {
  demoDatasetState,
  integrationJobs,
  inventoryItems,
  machines,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger, StorageProvider } from '@mietroyal/integrations';
import { eq, inArray, sql } from 'drizzle-orm';
import { recordSecurityEvent } from '../auth/audit.ts';
import { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE } from '../communication/types.ts';
import type { OutboundMailGateway } from '../communication/types.ts';
import { enqueueDemoStorageCleanup } from '../jobs/demo.ts';
import type { RoutingGateway } from '../routing/types.ts';
import { DEMO_DATASET_VERSION, DEMO_RESET_STALE_MS, DemoDatasetService } from './dataset.ts';
import { DEMO_BUSINESS_JOB_TYPES } from './job-types.ts';
import { DemoSeedRegistry } from './registry.ts';
import { DEMO_RESET_GATE_CACHE_TTL_MS } from './reset-gate.ts';
import { DemoSeedService } from './seed/seed-service.ts';
import { DEMO_MESSAGES, DemoError, type DemoResetResult, type DemoResetRunner } from './types.ts';

/**
 * Phase 14 (Order §15–§20, Design §6): Demo-Reset – setzt ALLE Demo-
 * Geschäftsdaten auf den kanonischen Datensatz zurück. Mechanik:
 *
 * - Phase A (kurze Tx): Singleton-Zeile sperren, Advisory-Lock probieren,
 *   laufenden Reset erkennen (409 DEMO_RESET_RUNNING; stale > 10 min
 *   (`DEMO_RESET_STALE_MS`) darf neu starten), `reset_in_progress` setzen ⇒ ab
 *   jetzt greift das 503-Gate.
 * - Schutzfenster (Review F4): `settleDelayMs` (Default Gate-Cache-TTL + 200 ms)
 *   warten, damit API-/Worker-Caches ablaufen und bereits angenommene
 *   Anfragen committen, bevor gelöscht wird.
 * - Phase B (eine Tx, Advisory-Lock blockierend): Hook für Trainingsversuche
 *   (WARTET Trainingsschema), Business-Tabellen in expliziter FK-sicherer
 *   Reihenfolge löschen (kein CASCADE – Staff/Auth/Audit/Settings/Stammdaten
 *   bleiben unangetastet), Business-Jobs und vorgangsgebundene Retention-Jobs
 *   entfernen (Review F3), Maschinen/Lager per UPDATE auf den Stammzustand,
 *   Registry leeren, Vorgangsnummern-Sequenz neu starten. Scheitert die
 *   Transaktion an einer FK-Verletzung (SQLSTATE 23503 – eine parallel
 *   committete Kindzeile), wird sie genau EINMAL wiederholt (Review F4).
 *   Danach (außerhalb der Tx) Storage-Objekte in parallelen Batches entfernen
 *   (Review F7) – Fehler werden nur protokolliert.
 * - Phase C: kanonischer Seed (`DemoSeedService.seedCanonical`).
 * - Phase D (kurze Tx): Flag zurück, Version/Zeitpunkte setzen, neue
 *   Dataset-Epoch (Phase 14 offline epoch, Order §91).
 * - Security-Audit (Phase 14 reset, Order §31): `demo.reset_started` nach
 *   Phase A, `demo.reset_completed` nach Phase D, `demo.reset_failed` beim
 *   Abbruch – Details ausschließlich `{ resetRunId, datasetVersion, status,
 *   errorClass? }` (nie Zähler-Inhalte, nie Fehlermeldungen).
 * - Storage (Phase 14 reset, Order §22): Schlüssel, die beim Löschen
 *   scheitern, landen als Job `demo.storage_cleanup` (Payload
 *   `{ resetRunId, keys }`) in der Queue und werden vom Worker erneut
 *   gelöscht; der neue Datensatz bleibt konsistent (keine Zeile referenziert
 *   sie mehr), dauerhaftes Scheitern wird als `dead` sichtbar.
 *
 * Fehler in B/C/D lassen `reset_in_progress` gesetzt (Gate bleibt fail-closed),
 * markieren den Lauf aber sofort als abgelaufen (`resetStale`), damit ein
 * erneuter Reset ohne Wartezeit möglich ist. Nach einem Prozessabbruch
 * (Deploy/OOM) läuft das Flag nach `DEMO_RESET_STALE_MS` ab; früher löst nur
 * `pnpm demo:reset --force` (`releaseStaleReset`, Review F8) auf.
 */
export const DEMO_RESET_ADVISORY_LOCK_KEY = 'demo-reset';

/** Review F4: Schutzfenster zwischen Phase A und Phase B (Gate-/Worker-Cache-TTL + Reserve). */
export const DEMO_RESET_SETTLE_DELAY_MS = DEMO_RESET_GATE_CACHE_TTL_MS + 200;
/** Review F4: kurze Pause vor der einen Wiederholung von Phase B nach SQLSTATE 23503. */
export const DEMO_RESET_FK_RETRY_DELAY_MS = 500;
/** Review F7: gleichzeitige Storage-Löschungen je Batch. */
export const DEMO_RESET_STORAGE_DELETE_CONCURRENCY = 10;

/**
 * Business-Tabellen in Löschreihenfolge (Kinder vor Eltern, Code-Map B §3.3):
 * 69 FK-gebundene + 4 FK-freie = 73 Tabellen. Zusammen mit der Behalten-Liste
 * unten decken sie alle Tabellen der Datenbank ab (Review-Prüfung R7).
 * Bewusst NICHT enthalten (Order §18, Code-Map B §3.5): staff_* (inkl.
 * Sessions, bekannte Geräte, Security-Events), push_subscriptions,
 * calendar_feed_tokens, offline_access_leases, system_settings,
 * accounting_tax_config, lexware_integration_state, terms_versions,
 * integration_rate_limits, inbound_mail_state, products, product_prices,
 * machines, inventory_items (nur UPDATE), staff_substitutions (Staff-Bindung,
 * in Order §17/§18 nicht genannt – bleibt konservativ erhalten), demo_*
 * (Zustand/Registry: Registry wird geleert, nicht gelöscht) und
 * integration_jobs (nur Business-Jobtypen, siehe unten).
 */
export const DEMO_BUSINESS_TABLES_DELETE_ORDER: readonly string[] = [
  // 1. Blätter – Rückgabe/Schäden
  'damage_markers',
  'damage_photos',
  'return_photos',
  'return_signatures',
  'return_inventory_items',
  'missing_accessory_cases',
  'technical_defects',
  // 1. Blätter – Übergabe
  'handover_machine_checks',
  'handover_photos',
  'handover_signatures',
  'delivery_packets',
  'machine_assignment_overrides',
  'machine_risk_incidents',
  'booking_pickup_representatives',
  // 1. Blätter – Abrechnung/Lexware
  'settlement_lines',
  'settlement_clarifications',
  'settlement_customer_notices',
  'lexware_invoice_mappings',
  'lexware_contact_mappings',
  'booking_advance_payments',
  'booking_security_deposits',
  // 1. Blätter – Gutschein
  'voucher_redemptions',
  // 1. Blätter – Kommunikation (Outbox/Belege; Push-Zustellungen hängen an Terminen)
  'inbound_mail_receipts',
  'message_photos',
  'whatsapp_events',
  'booking_customer_contacts',
  'appointment_reminders',
  'push_deliveries',
  'whatsapp_contacts',
  // 1. Blätter – Termine/Touren
  'appointment_overdue_incidents',
  'tour_delay_incidents',
  'tour_live_locations',
  // 1. Blätter – Angebote/Anfragen
  'offer_deliveries',
  'offer_line_items',
  'offer_version_selections',
  'inquiry_selections',
  'offer_access_tokens',
  // 1. Blätter – Vorgang
  'process_notes',
  'process_relations',
  // 1. Blätter – Lager
  'inventory_movements',
  'inventory_stocktake_items',
  'machine_blocks',
  // 2.
  'machine_damages',
  'tour_stops',
  'customer_action_tokens',
  'conversation_messages',
  'inventory_stocktakes',
  'vouchers',
  'accounting_transfers',
  'delivery_note_items',
  'order_confirmations',
  'inquiries',
  // 3.
  'return_machines',
  'tours',
  'mail_deliveries',
  'settlements',
  'cancellations',
  'delivery_notes',
  'booking_additions',
  // 4.
  'rental_returns',
  'handovers',
  'machine_assignments',
  // 5.
  'appointments',
  'documents',
  // 6.
  'bookings',
  // 7.
  'offer_versions',
  'offers',
  // 8.
  'processes',
  'customers',
  // Ohne FK-Bindung (Fingerprints, Cache, Webhook-Ereignisse, Offline-Quittungen)
  'appointment_conflict_suppressions',
  'geocoding_cache',
  'lexware_webhook_events',
  'offline_mutation_receipts',
];

/** Jobtypen mit Geschäfts-Payload (Code-Map B §3.6) – Infrastruktur-Jobs bleiben (Definition: `job-types.ts`). */
export { DEMO_BUSINESS_JOB_TYPES };

/** Spalten mit Storage-Keys gelöschter Objekte (Code-Map B §3.7). */
const DEMO_STORAGE_KEY_SOURCES: readonly { table: string; column: string }[] = [
  { table: 'documents', column: 'storage_key' },
  { table: 'handover_photos', column: 'storage_key' },
  { table: 'handover_signatures', column: 'storage_key' },
  { table: 'return_photos', column: 'storage_key' },
  { table: 'return_signatures', column: 'storage_key' },
  { table: 'damage_photos', column: 'storage_key' },
  { table: 'technical_defects', column: 'photo_storage_key' },
  { table: 'message_photos', column: 'storage_key' },
  { table: 'machines', column: 'reference_photo_key' },
];

const SEQUENCE_NAME = 'process_number_seq';

export interface DemoResetHooks {
  /**
   * WARTET Trainingsschema (Order §19): laufende Trainingsversuche vor dem
   * Löschen als `interrupted` mit Grund DEMO_DATA_RESET markieren (nie löschen;
   * bestandene bleiben bestanden). Läuft innerhalb der Phase-B-Transaktion.
   */
  beforeBusinessWipe?: ((tx: DatabaseTransaction) => Promise<void>) | undefined;
}

export interface DemoResetServiceDeps {
  db: Database;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  logger?: JobRunnerLogger | undefined;
  seed?: DemoSeedService | undefined;
  dataset?: DemoDatasetService | undefined;
  registry?: DemoSeedRegistry | undefined;
  hooks?: DemoResetHooks | undefined;
  /** Test-Injection für den Seed (FakeMailGateway / Routing-Fake). */
  mailGateway?: OutboundMailGateway | undefined;
  routingGateway?: RoutingGateway | undefined;
  /** Review F4: Schutzfenster zwischen Phase A und B (Default `DEMO_RESET_SETTLE_DELAY_MS`; Tests 0). */
  settleDelayMs?: number | undefined;
  /** Review F4: Pause vor der einen Wiederholung von Phase B nach SQLSTATE 23503 (Tests 0). */
  fkRetryDelayMs?: number | undefined;
  /** Review F7: gleichzeitige Storage-Löschungen (Default `DEMO_RESET_STORAGE_DELETE_CONCURRENCY`). */
  storageDeleteConcurrency?: number | undefined;
}

function rowCount(result: unknown): number {
  const count = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof count === 'number' ? count : 0;
}

/** SQLSTATE 23503 (foreign_key_violation) – direkt (pg) oder als `cause` (DrizzleQueryError). */
export function isForeignKeyViolation(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if ((candidate as { code?: unknown } | null | undefined)?.code === '23503') return true;
  }
  return false;
}

/**
 * Review F4: führt `run` aus und wiederholt es bei einer FK-Verletzung genau
 * einmal nach `delayMs` (eine parallel committete Kindzeile zwischen zwei
 * DELETEs der Phase B). Jeder andere Fehler und ein zweiter Fehlschlag werden
 * unverändert weitergereicht; die Wiederholung wird nur mit dem Code geloggt.
 */
export async function retryOnceOnForeignKeyViolation<T>(
  run: () => Promise<T>,
  options: { delayMs: number; logger?: JobRunnerLogger | undefined },
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    options.logger?.warn(
      { errorCode: '23503' },
      'Demo-Reset: FK-Verletzung in Phase B (parallele Mutation) – genau eine Wiederholung',
    );
    if (options.delayMs > 0) await sleep(options.delayMs);
    return run();
  }
}

/**
 * Review F7: Storage-Objekte in begrenzt parallelen Batches löschen. Fehler je
 * Objekt werden gezählt und nur mit der Fehlerklasse protokolliert (nie der
 * Schlüssel oder die Meldung), brechen aber nie ab.
 */
export async function deleteStorageObjectsInBatches(
  storage: Pick<StorageProvider, 'delete'>,
  keys: readonly string[],
  options: { concurrency?: number | undefined; logger?: JobRunnerLogger | undefined } = {},
): Promise<{ removed: number; failed: number; failedKeys: string[] }> {
  const size = Math.max(
    1,
    Math.floor(options.concurrency ?? DEMO_RESET_STORAGE_DELETE_CONCURRENCY),
  );
  let removed = 0;
  let failed = 0;
  const failedKeys: string[] = [];
  for (let offset = 0; offset < keys.length; offset += size) {
    const batch = keys.slice(offset, offset + size);
    const outcomes = await Promise.allSettled(batch.map((key) => storage.delete(key)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        removed += 1;
        return;
      }
      failed += 1;
      failedKeys.push(batch[index]!);
      options.logger?.warn(
        { errorName: outcome.reason instanceof Error ? outcome.reason.name : 'Error' },
        'Demo-Reset: Storage-Objekt konnte nicht entfernt werden',
      );
    });
  }
  return { removed, failed, failedKeys };
}

/** Phase 14 (reset, Order §31): technische Fehlerklasse fürs Audit – Name bzw. SQLSTATE, nie die Meldung. */
export function errorClassOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  for (const candidate of [code, causeCode]) {
    if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate))
      return `SQLSTATE_${candidate}`;
  }
  if (error instanceof Error && error.name !== '') return error.name;
  return typeof error;
}

async function tryAdvisoryLock(tx: DatabaseExecutor): Promise<boolean> {
  const locked = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${DEMO_RESET_ADVISORY_LOCK_KEY})) AS locked`,
  );
  return (locked as { rows?: { locked?: unknown }[] }).rows?.[0]?.locked === true;
}

export class DemoResetService implements DemoResetRunner {
  private readonly dataset: DemoDatasetService;
  private readonly registry: DemoSeedRegistry;
  private readonly seed: DemoSeedService;
  private readonly logger: JobRunnerLogger | undefined;
  private readonly settleDelayMs: number;
  private readonly fkRetryDelayMs: number;

  constructor(private readonly deps: DemoResetServiceDeps) {
    this.dataset = deps.dataset ?? new DemoDatasetService(deps.db);
    this.registry = deps.registry ?? new DemoSeedRegistry(deps.db);
    this.seed =
      deps.seed ??
      new DemoSeedService({
        db: deps.db,
        config: deps.config,
        storage: deps.storage,
        queue: deps.queue,
        logger: deps.logger,
        dataset: this.dataset,
        registry: this.registry,
        mailGateway: deps.mailGateway,
        routingGateway: deps.routingGateway,
      });
    this.logger = deps.logger;
    this.settleDelayMs = Math.max(0, deps.settleDelayMs ?? DEMO_RESET_SETTLE_DELAY_MS);
    this.fkRetryDelayMs = Math.max(0, deps.fkRetryDelayMs ?? DEMO_RESET_FK_RETRY_DELAY_MS);
  }

  async reset(input: {
    actorId: string | null;
    sessionId?: string | null | undefined;
    now?: Date | undefined;
  }): Promise<DemoResetResult> {
    if (this.deps.config.appEnv !== 'demo') {
      throw new DemoError('FORBIDDEN', 'DEMO_ONLY', DEMO_MESSAGES.DEMO_ONLY);
    }
    const now = input.now ?? new Date();
    const startedAt = Date.now();
    // Der Fachaktor des Seeds muss existieren, BEVOR gelöscht wird (sonst bliebe
    // die Demo leer und gesperrt).
    const seedActor = await this.seed.resolveActor(input.actorId);
    // Phase 14 (reset, Order §31): ein Lauf = eine resetRunId (Audit + Storage-Nachbereinigung).
    const resetRunId = randomUUID();
    const audit = (
      status: 'started' | 'completed' | 'failed',
      errorClass?: string,
    ): Promise<void> =>
      recordSecurityEvent(this.deps.db, {
        type: `demo.reset_${status}`,
        actorUserId: input.actorId,
        sessionId: input.sessionId ?? null,
        details: {
          resetRunId,
          datasetVersion: DEMO_DATASET_VERSION,
          status,
          ...(errorClass === undefined ? {} : { errorClass }),
        },
      });

    await this.begin(input.actorId, now); // Phase A
    let deleted: Record<string, number>;
    let seeded: Record<string, number>;
    try {
      await audit('started');
      // Review F4: Schutzfenster – Gate-/Worker-Caches (TTL 1 s) laufen ab und
      // bereits angenommene Anfragen committen, bevor Phase B löscht.
      if (this.settleDelayMs > 0) await sleep(this.settleDelayMs);
      const wiped = await retryOnceOnForeignKeyViolation(() => this.wipe(now), {
        delayMs: this.fkRetryDelayMs,
        logger: this.logger,
      }); // Phase B
      deleted = wiped.deleted;
      await this.deleteStorageObjects(wiped.storageKeys, resetRunId);
      const result = await this.seed.seedCanonical({
        actorId: seedActor.seedActorId,
        requestedBy: input.actorId,
        now,
      }); // Phase C
      seeded = result.seeded;
      await this.deps.db.transaction((tx) =>
        this.dataset.endReset(tx, {
          datasetVersion: DEMO_DATASET_VERSION,
          actorId: input.actorId,
          now,
        }),
      ); // Phase D
    } catch (error) {
      await this.markInterrupted();
      // Order §31: nur die technische Fehlerklasse, nie die Meldung (könnte Werte zitieren).
      await audit('failed', errorClassOf(error)).catch((auditError: unknown) => {
        this.logger?.error(
          { errorName: auditError instanceof Error ? auditError.name : 'Error' },
          'Demo-Reset: Audit demo.reset_failed konnte nicht geschrieben werden',
        );
      });
      this.logger?.error(
        { resetRunId, errorName: error instanceof Error ? error.name : 'Error' },
        'Demo-Reset unterbrochen – Flag bleibt gesetzt, erneuter Reset möglich',
      );
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    const deletedRows = Object.values(deleted).reduce((sum, value) => sum + value, 0);
    await audit('completed');
    this.logger?.info(
      { resetRunId, durationMs, deletedRows, ...prefixKeys('seeded', seeded) },
      'Demo-Reset abgeschlossen',
    );
    return {
      ok: true,
      datasetVersion: DEMO_DATASET_VERSION,
      seededAt: now,
      durationMs,
      deleted,
      seeded,
    };
  }

  /**
   * Review F8 – NUR für die CLI (`pnpm demo:reset --force`): ein hängender Reset
   * (Flag gesetzt, aber kein Prozess hält den Advisory-Lock – z. B. nach einem
   * Prozessabbruch in Phase B/C) wird sofort als abgelaufen markiert, damit
   * `reset()` ohne Wartezeit neu starten darf. Hält ein anderer Prozess den
   * Lock (Phase B läuft tatsächlich), bleibt es bei DEMO_RESET_RUNNING. Das
   * Flag selbst bleibt gesetzt (Gate fail-closed), bis der neue Reset
   * abgeschlossen ist. Rückgabe: ob ein hängendes Flag vorlag.
   */
  async releaseStaleReset(now = new Date()): Promise<boolean> {
    if (this.deps.config.appEnv !== 'demo') {
      throw new DemoError('FORBIDDEN', 'DEMO_ONLY', DEMO_MESSAGES.DEMO_ONLY);
    }
    return this.deps.db.transaction(async (tx) => {
      const row = await this.dataset.lockRow(tx);
      if (!(await tryAdvisoryLock(tx))) {
        throw new DemoError('CONFLICT', 'DEMO_RESET_RUNNING', DEMO_MESSAGES.DEMO_RESET_RUNNING, {
          resetStartedAt: row.resetStartedAt?.toISOString() ?? null,
        });
      }
      if (!row.resetInProgress) return false;
      await tx
        .update(demoDatasetState)
        .set({
          resetStartedAt: new Date(now.getTime() - DEMO_RESET_STALE_MS - 1000),
          updatedAt: now,
        })
        .where(eq(demoDatasetState.id, 1));
      this.logger?.warn(
        { resetStartedAt: row.resetStartedAt?.toISOString() ?? null },
        'Demo-Reset: hängender Reset per --force als abgelaufen markiert',
      );
      return true;
    });
  }

  /** Phase A: Serialisierung und Flag (kurze Transaktion). */
  private async begin(actorId: string | null, now: Date): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const row = await this.dataset.lockRow(tx);
      const acquired = await tryAdvisoryLock(tx);
      const running =
        row.resetInProgress &&
        row.resetStartedAt !== null &&
        now.getTime() - row.resetStartedAt.getTime() < DEMO_RESET_STALE_MS;
      if (!acquired || running) {
        throw new DemoError('CONFLICT', 'DEMO_RESET_RUNNING', DEMO_MESSAGES.DEMO_RESET_RUNNING, {
          resetStartedAt: row.resetStartedAt?.toISOString() ?? null,
        });
      }
      await this.dataset.beginReset(tx, { actorId, now });
    });
  }

  /** Phase B: Business-Daten löschen (eine Transaktion unter Advisory-Lock). */
  private async wipe(
    now: Date,
  ): Promise<{ deleted: Record<string, number>; storageKeys: string[] }> {
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${DEMO_RESET_ADVISORY_LOCK_KEY}))`,
      );
      // WARTET Trainingsschema: laufende Trainingsversuche ⇒ interrupted/DEMO_DATA_RESET.
      if (this.deps.hooks?.beforeBusinessWipe !== undefined) {
        await this.deps.hooks.beforeBusinessWipe(tx);
      }
      const storageKeys = await this.collectStorageKeys(tx);
      const deleted: Record<string, number> = {};
      for (const table of DEMO_BUSINESS_TABLES_DELETE_ORDER) {
        const result = await tx.execute(sql`DELETE FROM ${sql.identifier(table)}`);
        deleted[table] = rowCount(result);
      }
      // Business-Jobs (pending/dead/succeeded) entfernen; laufende (processing)
      // bleiben – ihre Handler enden bei fehlenden Daten still (idempotent).
      const jobs = await tx
        .delete(integrationJobs)
        .where(
          sql`${inArray(integrationJobs.type, [...DEMO_BUSINESS_JOB_TYPES])} AND ${integrationJobs.status} IN ('pending', 'dead', 'succeeded')`,
        )
        .returning({ id: integrationJobs.id });
      // Review F3: vorgangsgebundene Retention-Jobs (`scope: 'photos'`, Payload mit
      // Vorgangs-ID des alten Datensatzes) ebenfalls entfernen – sonst wächst die
      // Tabelle je Reset um verwaiste Jobs. Der tägliche Backstop
      // (`scope: 'backstop'`) und laufende Jobs bleiben.
      const retentionJobs = await tx
        .delete(integrationJobs)
        .where(
          sql`${integrationJobs.type} = ${COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE} AND ${integrationJobs.payload}->>'scope' = 'photos' AND ${integrationJobs.status} IN ('pending', 'dead', 'succeeded')`,
        )
        .returning({ id: integrationJobs.id });
      deleted['integration_jobs'] = jobs.length + retentionJobs.length;
      // Stammzustand (nur UPDATE, keine Löschung von Stammdaten).
      const machineRows = await tx
        .update(machines)
        .set({
          status: 'ready',
          locationKind: 'warehouse',
          locationNote: null,
          purchaseDate: null,
          weightGrams: null,
          referencePhotoKey: null,
          referencePhotoMime: null,
          cleaningSince: null,
          cleanedAt: null,
          cleanedBy: null,
          updatedAt: now,
        })
        .returning({ id: machines.id });
      deleted['machines_reset'] = machineRows.length;
      const itemRows = await tx
        .update(inventoryItems)
        .set({ currentStock: null, minStock: null, updatedAt: now })
        .returning({ id: inventoryItems.id });
      deleted['inventory_items_reset'] = itemRows.length;
      deleted['demo_seed_entities'] = await this.registry.clear(tx);
      // Demo-Entscheidung (Design §6): deterministische Vorgangsnummern nach
      // jedem Reset (MR-<Jahr>-0001 …). Nur in der Demo – Live-Sequenzen laufen
      // nie zurück (MASTER_SPEC §3).
      await tx.execute(sql`ALTER SEQUENCE ${sql.identifier(SEQUENCE_NAME)} RESTART WITH 1`);
      return { deleted, storageKeys };
    });
  }

  private async collectStorageKeys(tx: DatabaseExecutor): Promise<string[]> {
    const keys = new Set<string>();
    for (const source of DEMO_STORAGE_KEY_SOURCES) {
      const result = await tx.execute(
        sql`SELECT ${sql.identifier(source.column)} AS key FROM ${sql.identifier(source.table)} WHERE ${sql.identifier(source.column)} IS NOT NULL`,
      );
      const rows = (result as { rows?: { key?: unknown }[] }).rows ?? [];
      for (const row of rows) if (typeof row.key === 'string' && row.key !== '') keys.add(row.key);
    }
    return [...keys];
  }

  /**
   * Storage-Objekte der gelöschten Zeilen entfernen – parallel in Batches,
   * Fehler nur loggen (Design §6, Review F7). Phase 14 (reset, Order §22):
   * fehlgeschlagene Schlüssel als Job `demo.storage_cleanup` nachreihen; die
   * Datenbank referenziert sie bereits nicht mehr (zweiphasig, nie atomar).
   */
  private async deleteStorageObjects(keys: readonly string[], resetRunId: string): Promise<void> {
    if (keys.length === 0) return;
    const { removed, failed, failedKeys } = await deleteStorageObjectsInBatches(
      this.deps.storage,
      keys,
      { concurrency: this.deps.storageDeleteConcurrency, logger: this.logger },
    );
    this.logger?.info({ removed, failed }, 'Demo-Reset: Storage-Objekte entfernt');
    if (failedKeys.length === 0) return;
    try {
      const jobIds = await enqueueDemoStorageCleanup(this.deps.queue, {
        resetRunId,
        keys: failedKeys,
      });
      this.logger?.warn(
        { resetRunId, failed: failedKeys.length, jobs: jobIds.length },
        'Demo-Reset: Storage-Nachbereinigung als Job eingereiht',
      );
    } catch (error) {
      // Der Reset bleibt erfolgreich (neuer Datensatz konsistent); nur sichtbar machen.
      this.logger?.error(
        { resetRunId, errorName: error instanceof Error ? error.name : 'Error' },
        'Demo-Reset: Storage-Nachbereinigung konnte nicht eingereiht werden',
      );
    }
  }

  /**
   * Abbruch in B/C/D: Flag bleibt gesetzt (Gate fail-closed, Daten evtl.
   * inkonsistent), der Lauf wird aber sofort als „abgelaufen“ markiert
   * (`reset_started_at` um die Stale-Spanne zurückdatiert): Status zeigt
   * „Letzter Reset unterbrochen – erneut zurücksetzen“ (`resetStale`), und
   * Phase A lässt den nächsten Reset ohne Wartezeit zu – auch mit demselben
   * injizierten `now` (Zeit läuft monoton, nie relativ zur Prozessuhr).
   */
  private async markInterrupted(): Promise<void> {
    try {
      await this.deps.db
        .update(demoDatasetState)
        .set({
          resetStartedAt: sql`${demoDatasetState.resetStartedAt} - (${DEMO_RESET_STALE_MS}::bigint * interval '1 millisecond')`,
          updatedAt: new Date(),
        })
        .where(eq(demoDatasetState.id, 1));
    } catch (error) {
      this.logger?.error(
        { errorName: error instanceof Error ? error.name : 'Error' },
        'Demo-Reset: Abbruch konnte nicht markiert werden',
      );
    }
  }
}

function prefixKeys(prefix: string, counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) out[`${prefix}_${key}`] = value;
  return out;
}
