'use client';

import {
  MUTATION_LABELS,
  type MutationPayload,
  type OfflineMachineSnapshot,
  type OfflineMutationType,
} from '@mietroyal/offline';
import { cleaningOverdue } from '@mietroyal/domain';
import type { ApiResult } from '../api';
import type { HandoverDetail, HandoverDocument, SlotView } from '../handover';
import type {
  DamageView,
  MachineCondition,
  ReturnDetail,
  ReturnDocument,
  ReturnListEntry,
  ReturnMachineView,
} from '../returns';
import { MACHINE_STATUS_LABELS, type MachineStatus } from '../warehouse';
import {
  candidateToSuggestion,
  isLocalId,
  localPhotoId,
  projectHandover,
  projectReturn,
  rawLocalId,
  type LocalHandoverDetail,
  type LocalMutation,
  type LocalReturnDetail,
  type LocalSnapshot,
} from './projection';
import { fromBase64, offlineRuntime, type OfflineRuntime } from './runtime';

/**
 * Offline-Router (Phase-8-Order §§15, 18, 19, 26–29): beantwortet die
 * BESTEHENDEN Staff-Routen lokal – Lesen aus Snapshot + lokalen Mutationen
 * (Projektion), Schreiben als typisierte Mutation in der Queue. Kein zweiter
 * Wizard, keine lokale Finanz-/Admin-Logik. Nicht modellierte Schreibrouten
 * ⇒ ONLINE_REQUIRED (§26). Online wird nur eingegriffen, wenn der Kontext
 * noch lokal ausstehende Änderungen hat (Reihenfolge, §29/§32).
 */
const UUID = '([0-9a-fA-F-]{36})';
const ANY = '([^/?]+)';

function ok<T>(data: T, status = 200): ApiResult<unknown> {
  return { ok: true, status, data, errorCode: null, errorMessage: null };
}

function fail(code: string, message: string, status = 400): ApiResult<unknown> {
  return { ok: false, status, data: null, errorCode: code, errorMessage: message };
}

const ONLINE_REQUIRED = fail(
  'ONLINE_REQUIRED',
  'Diese Aktion ist offline nicht verfügbar – bitte mit Verbindung erneut versuchen.',
  409,
);
const NOT_CACHED = fail(
  'OFFLINE_NOT_CACHED',
  'Dieser Vorgang ist auf diesem Gerät nicht für Offline-Nutzung gespeichert.',
  404,
);

const HANDOVER_DOCS = ['delivery_note', 'handover_protocol'];
const RETURN_DOCS = ['return_protocol'];

interface RouterContext {
  runtime: OfflineRuntime;
  offline: boolean;
  staff: { firstName: string; lastName: string };
  /** Rechte-Snapshot der Lease (nur Darstellung/UX-Vorprüfung – der Server prüft beim Sync erneut). */
  permissions: readonly string[];
  machines: () => Promise<OfflineMachineSnapshot[]>;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle(
    ctx: RouterContext,
    params: (string | undefined)[],
    query: URLSearchParams,
    body: unknown,
  ): Promise<ApiResult<unknown>>;
}

// ── Helfer ──────────────────────────────────────────────────────────────────

/** QR-Token aus dem POST-Body (`{ token }`) – nie protokollieren, nie in die URL. */
function qrTokenFrom(body: unknown): string {
  const input = body as { token?: unknown } | null;
  return typeof input?.token === 'string' ? input.token : '';
}

const MAIN_STATUSES = ['open', 'completed', 'reopened', 'cancelled'] as const;
type MainStatus = (typeof MAIN_STATUSES)[number];
function isMainStatus(value: string): value is MainStatus {
  return (MAIN_STATUSES as readonly string[]).includes(value);
}

/**
 * Antwort der Offline-Suche (Finalisierung §6): Form der Server-`SearchResults`
 * plus Maschinentreffer und `offline: true`. Rein im Speicher aus den
 * entschlüsselten Snapshots – kein Index, nichts persistiert.
 */
export interface OfflineSearchResults {
  customers: { id: string; displayName: string; email: string | null; phone: string | null }[];
  processes: {
    id: string;
    processNumber: string;
    mainStatus: MainStatus;
    eventDate: string | null;
    customerDisplayName: string;
  }[];
  machines: { id: string; machineCode: string; status: string }[];
  canViewCompleted: boolean;
  offline: true;
}

function berlinDayOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

function berlinDayPlus(dayIso: string, days: number): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

async function snapshotByBooking(ctx: RouterContext, bookingId: string) {
  return ctx.runtime.findBooking(bookingId);
}

async function mutationsFor(ctx: RouterContext, snapshot: LocalSnapshot): Promise<LocalMutation[]> {
  return ctx.runtime.mutationsForContext('booking', snapshot.bookingId);
}

async function loadHandover(
  ctx: RouterContext,
  snapshot: LocalSnapshot,
): Promise<LocalHandoverDetail | null> {
  return projectHandover(snapshot, await mutationsFor(ctx, snapshot), ctx.staff);
}

async function loadReturn(
  ctx: RouterContext,
  snapshot: LocalSnapshot,
): Promise<LocalReturnDetail | null> {
  const machines = await ctx.machines();
  return projectReturn(snapshot, await mutationsFor(ctx, snapshot), ctx.staff, (machineId) =>
    machines.find((m) => m.machineId === machineId),
  );
}

function handoverDocuments(snapshot: LocalSnapshot): HandoverDocument[] {
  return snapshot.documents
    .filter((d) => HANDOVER_DOCS.includes(d.type))
    .map((d) => ({ id: d.id, type: d.type, createdAt: d.createdAt, sha256: d.sha256 }));
}

function returnDocuments(snapshot: LocalSnapshot): ReturnDocument[] {
  return snapshot.documents
    .filter((d) => RETURN_DOCS.includes(d.type))
    .map((d) => ({ id: d.id, type: d.type, createdAt: d.createdAt, sha256: d.sha256 }));
}

/**
 * Basisstand (§33) als JSON: Vorgangsstatus + Terminversion laut Snapshot;
 * für Slot-Mutationen zusätzlich die lokal erwartete Maschine des Slots.
 */
function bookingBase(
  snapshot: LocalSnapshot,
  side: 'outbound' | 'return',
  extra: Record<string, unknown> = {},
): string {
  const appointment =
    side === 'return'
      ? (snapshot.appointments.find((a) => a.kind === 'return') ?? null)
      : (snapshot.appointments.find((a) => a.kind !== 'return') ?? null);
  const processStatus =
    snapshot.handover?.booking.processStatus ?? snapshot.return?.booking.processStatus ?? 'open';
  return JSON.stringify({
    processStatus,
    appointmentId: appointment?.id ?? null,
    appointmentVersion: appointment?.version ?? null,
    ...extra,
  });
}

/** Terminart + Terminzeit laut Snapshot zum Erfassungszeitpunkt (Konfliktansicht, §4). */
function appointmentBasis(snapshot: LocalSnapshot, side: 'outbound' | 'return'): string | null {
  const appointment =
    side === 'return'
      ? (snapshot.appointments.find((a) => a.kind === 'return') ?? null)
      : (snapshot.appointments.find((a) => a.kind !== 'return') ?? null);
  if (appointment === null) return null;
  const kind =
    appointment.kind === 'return'
      ? 'Rückgabe'
      : appointment.kind === 'delivery'
        ? 'Lieferung'
        : 'Abholung / Ausgabe';
  const when =
    appointment.startAt !== null
      ? `${new Intl.DateTimeFormat('de-DE', {
          timeZone: 'Europe/Berlin',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(appointment.startAt))} Uhr`
      : 'ohne Uhrzeit';
  return `${kind} ${when}`;
}

function openIds(mutations: readonly LocalMutation[]): string[] {
  return mutations.filter((m) => m.status !== 'synced').map((m) => m.clientMutationId);
}

async function enqueueBooking<T extends OfflineMutationType>(
  ctx: RouterContext,
  snapshot: LocalSnapshot,
  type: T,
  payload: MutationPayload<T>,
  options: {
    baseVersion: string;
    detail?: string | null;
    mediaIds?: string[];
    dependsOn?: string[];
  },
): Promise<string> {
  return ctx.runtime.enqueue({
    type,
    contextKind: 'booking',
    contextId: snapshot.bookingId,
    payload,
    summary: {
      processNumber: snapshot.processNumber,
      actionLabel: MUTATION_LABELS[type],
      detail: options.detail ?? null,
      basis: appointmentBasis(snapshot, type.startsWith('return.') ? 'return' : 'outbound'),
    },
    baseVersion: options.baseVersion,
    mediaIds: options.mediaIds ?? [],
    dependsOn: options.dependsOn ?? [],
  });
}

function decodeUpload(body: unknown): { bytes: Uint8Array; mimeType: string } | null {
  const input = body as { dataBase64?: unknown; mimeType?: unknown } | null;
  if (typeof input?.dataBase64 !== 'string' || input.dataBase64 === '') return null;
  try {
    const bytes = fromBase64(input.dataBase64);
    if (bytes.length === 0 || bytes.length > 6 * 1024 * 1024) return null;
    return { bytes, mimeType: typeof input.mimeType === 'string' ? input.mimeType : 'image/png' };
  } catch {
    return null;
  }
}

function slotStatusIssued(slot: SlotView): boolean {
  return slot.status === 'issued';
}

/** Rückgabe-Listeneintrag (Spiegel von ReturnService.listOpen) aus dem lokalen Stand. */
function returnListEntry(
  snapshot: LocalSnapshot,
  detail: LocalReturnDetail | null,
  now: Date,
): ReturnListEntry | null {
  const started = detail !== null;
  if (!started && !snapshot.returnStartable) return null;
  if (detail?.return.status === 'finalized' && !detail.offline.pendingFinalize) return null;
  const todayIso = berlinDayOf(now.toISOString());
  const horizonIso = berlinDayPlus(todayIso, 3);
  const appointment = snapshot.appointments.find((a) => a.kind === 'return') ?? null;
  const planned = appointment?.startAt ?? null;
  const due = appointment?.endAt ?? appointment?.startAt ?? null;
  let group: ReturnListEntry['group'];
  if (planned === null) group = 'unscheduled';
  else if (due !== null && Date.parse(due) < now.getTime()) group = 'overdue';
  else if (berlinDayOf(planned) === todayIso) group = 'today';
  else if (berlinDayOf(planned) <= horizonIso) group = 'upcoming';
  else return null;
  const machineCodes =
    detail !== null
      ? detail.machines.map((m) => m.machineCode)
      : (snapshot.handover?.slots
          .filter(slotStatusIssued)
          .map((s) => s.machine?.machineCode ?? '–') ?? []);
  return {
    bookingId: snapshot.bookingId,
    processId: snapshot.processId,
    processNumber: snapshot.processNumber,
    customerName: snapshot.handover?.booking.customerName ?? snapshot.customer.name,
    fulfillment: snapshot.handover?.booking.fulfillment ?? detail?.booking.fulfillment ?? 'pickup',
    machineCodes,
    plannedAt: planned,
    plannedEndAt: appointment?.endAt ?? null,
    assigneeName: null,
    overdue: group === 'overdue',
    returnStatus: started ? 'draft' : 'none',
    group,
    offlinePendingFinalize: detail?.offline.pendingFinalize === true,
  };
}

function damageFromExisting(
  machine: OfflineMachineSnapshot,
  damage: OfflineMachineSnapshot['currentDamages'][number],
): DamageView {
  return {
    id: damage.id,
    machineId: machine.machineId,
    machineCode: machine.machineCode,
    productSlug: damage.productSlug,
    returnId: null,
    returnMachineId: null,
    origin: 'return',
    severity: damage.severity,
    severityLabel: damage.severityLabel,
    description: damage.description,
    requiresFinancialReview: true,
    createdAt: damage.createdAt,
    createdByName: null,
    activatedAt: damage.createdAt,
    resolvedAt: null,
    current: true,
    markers: damage.markers.map((marker, index) => ({
      id: `${damage.id}:${index}`,
      view: marker.view,
      viewLabel:
        marker.view === 'front'
          ? 'Vorne'
          : marker.view === 'back'
            ? 'Hinten'
            : marker.view === 'left'
              ? 'Links'
              : 'Rechts',
      markerType: marker.markerType,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
    })),
    photos: [],
  };
}

async function machineCondition(
  ctx: RouterContext,
  machine: OfflineMachineSnapshot,
): Promise<MachineCondition> {
  const mutations = await ctx.runtime.mutationsForContext('machine', machine.machineId);
  const pendingClean = mutations.some(
    (m) => m.type === 'machine.clean_complete' && m.status !== 'synced',
  );
  const now = new Date();
  return {
    productSlug: machine.productSlug ?? '',
    currentDamages: machine.currentDamages.map((d) => damageFromExisting(machine, d)),
    openMissingCases: [],
    technicalDefects: [],
    cleaning: {
      active: machine.status === 'cleaning',
      since: machine.cleaningSince,
      overdue: machine.status === 'cleaning' && cleaningOverdue(machine.cleaningSince, now),
      cleanedAt: null,
      cleanedBy: null,
    },
    postReturnFindingOpen: false,
    defectLinkOpen: false,
    offlinePendingCleanComplete: pendingClean,
  };
}

async function machineListRow(ctx: RouterContext, machine: OfflineMachineSnapshot) {
  const mutations = await ctx.runtime.mutationsForContext('machine', machine.machineId);
  const status = machine.status as MachineStatus;
  return {
    id: machine.machineId,
    machineCode: machine.machineCode,
    productId: null,
    productName: machine.machineTypeName ?? '',
    status,
    statusLabel: MACHINE_STATUS_LABELS[status] ?? machine.status,
    locationKind: 'other',
    locationLabel: 'Standort offline nicht verfügbar',
    locationNote: null,
    activeBlockReason: null,
    openBlockCount: 0,
    notRegularlyAvailable: machine.status !== 'ready',
    cleaningSince: machine.cleaningSince,
    offlinePendingCleanComplete: mutations.some(
      (m) => m.type === 'machine.clean_complete' && m.status !== 'synced',
    ),
  };
}

/** Ausgegebene Maschine → Vorgang mit laufender/offener Rückgabe (QR-Kontext). */
async function returnContextForMachine(ctx: RouterContext, machineId: string) {
  for (const snapshot of await ctx.runtime.listBookings()) {
    const detail = await loadReturn(ctx, snapshot);
    const inReturn = detail?.machines.some((m) => m.machineId === machineId) === true;
    const issued =
      snapshot.handover?.slots.some((s) => slotStatusIssued(s) && s.machine?.id === machineId) ===
      true;
    if (
      (inReturn || (issued && snapshot.returnStartable)) &&
      detail?.return.status !== 'finalized'
    ) {
      return snapshot;
    }
  }
  return null;
}

// ── Routen ──────────────────────────────────────────────────────────────────

const routes: Route[] = [
  // ── Lesen: Übergabe ──────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/processes/${UUID}/handover$`),
    async handle(ctx, [processId]) {
      const snapshot = await ctx.runtime.findBookingByProcess(processId!);
      if (snapshot === null) return NOT_CACHED;
      return ok({ detail: await loadHandover(ctx, snapshot) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/handover/${UUID}$`),
    async handle(ctx, [bookingId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const detail = await loadHandover(ctx, snapshot);
      if (detail === null) return NOT_CACHED;
      return ok({ detail, documents: handoverDocuments(snapshot) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/staff\/handover\/day$/,
    async handle(ctx, _params, query) {
      const day = query.get('date') ?? berlinDayOf(new Date().toISOString());
      const entries = [];
      for (const snapshot of await ctx.runtime.listBookings()) {
        if (snapshot.handover === null) continue;
        const detail = await loadHandover(ctx, snapshot);
        if (detail === null) continue;
        if (detail.handover.status === 'finalized' && !detail.offline.pendingFinalize) continue;
        const appointment = snapshot.appointments.find((a) => a.kind !== 'return') ?? null;
        const startAt = appointment?.startAt ?? null;
        const unscheduled = appointment === null || startAt === null;
        if (!unscheduled) {
          if (berlinDayOf(startAt) !== day) continue;
        } else if (
          detail.booking.processStatus !== 'open' &&
          detail.booking.processStatus !== 'reopened'
        ) {
          continue;
        }
        const preparedCount = detail.slots.filter(
          (s) => s.status === 'prepared' || s.status === 'issued',
        ).length;
        entries.push({
          bookingId: snapshot.bookingId,
          processId: snapshot.processId,
          processNumber: snapshot.processNumber,
          customerName: detail.booking.customerName,
          fulfillment: detail.booking.fulfillment,
          machineTypeName: detail.booking.machineTypeName,
          machineQuantity: detail.booking.machineQuantity,
          appointmentKind: appointment?.kind ?? null,
          startAt,
          endAt: appointment?.endAt ?? null,
          assigneeName: null,
          handoverStatus: detail.handover.status,
          preparation:
            detail.slots.length === 0 || preparedCount === 0
              ? 'none'
              : preparedCount < detail.slots.length
                ? 'partial'
                : 'prepared',
          unscheduled,
          offlinePendingFinalize: detail.offline.pendingFinalize,
        });
      }
      entries.sort((a, b) => (a.startAt ?? '9').localeCompare(b.startAt ?? '9'));
      return ok({ date: day, entries });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/handover/${UUID}/slots/${UUID}/suggestion$`),
    async handle(ctx, [bookingId, assignmentId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const candidates = snapshot.candidateMachines[assignmentId!] ?? [];
      return ok({
        preferredBasis: null,
        entries: candidates.map(candidateToSuggestion),
        warnings: ['Vorschlag aus dem lokalen Arbeitspaket (Stand der letzten Synchronisierung).'],
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/handover/${UUID}/slots/${UUID}/evaluate$`),
    async handle(ctx, [bookingId, assignmentId], query) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const machineId = query.get('machineId') ?? '';
      const candidate = (snapshot.candidateMachines[assignmentId!] ?? []).find(
        (c) => c.machineId === machineId,
      );
      if (candidate === undefined)
        return fail('NOT_FOUND', 'Diese Maschine ist offline nicht als Kandidat bekannt.', 404);
      return ok({
        machineId: candidate.machineId,
        machineCode: candidate.machineCode,
        productMatches: true,
        problems: candidate.problems,
        hardBlocked: candidate.hardBlocked,
        overrideRequired: candidate.overrideRequired,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/staff\/handover-addition-products$/,
    async handle() {
      // Zusatzpositionen sind offline nicht modelliert (§26) – leere Auswahl, keine Fehlermeldung.
      return ok({ products: [] });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/processes/${UUID}/delivery-packets$`),
    async handle() {
      return ok({ packets: [] });
    },
  },

  // ── Schreiben: Übergabe ──────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/handover/${UUID}/slots/${UUID}/assign$`),
    async handle(ctx, [bookingId, assignmentId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.handover.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Übergabe ist bereits abgeschlossen.', 409);
      const input = body as { machineId?: string; override?: { reason?: string } | null };
      const slot = detail.slots.find((s) => s.id === assignmentId);
      if (slot === undefined) return fail('NOT_FOUND', 'Zuordnung nicht gefunden.', 404);
      if (slot.status === 'issued')
        return fail('CONFLICT', 'Die Maschine dieses Slots ist bereits ausgegeben.', 409);
      const candidate = (snapshot.candidateMachines[assignmentId!] ?? []).find(
        (c) => c.machineId === input.machineId,
      );
      if (candidate === undefined)
        return fail('NOT_FOUND', 'Diese Maschine ist offline nicht als Kandidat bekannt.', 404);
      if (candidate.hardBlocked)
        return fail(
          'CONFLICT',
          `Maschine ${candidate.machineCode} ist an einen anderen Vorgang ausgegeben und physisch nicht verfügbar.`,
          409,
        );
      const reason = input.override?.reason?.trim() ?? '';
      if (candidate.overrideRequired && reason === '')
        return fail(
          'OVERRIDE_REQUIRED',
          'Diese Zuweisung erfordert eine bewusste Bestätigung mit Begründung.',
        );
      // Override offline nur mit dem Recht im lokalen Rechte-Snapshot (Finalisierung §8);
      // der Server prüft beim Sync erneut gegen die Datenbank.
      if (
        (candidate.overrideRequired || reason !== '') &&
        !ctx.permissions.includes('machine.override_block')
      )
        return fail(
          'FORBIDDEN',
          'Dafür fehlt dir die Berechtigung – online mit berechtigter Person klären.',
          403,
        );
      const serverSlot = snapshot.handover?.slots.find((s) => s.id === assignmentId) ?? null;
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.assign',
        {
          assignmentId: assignmentId!,
          machineId: candidate.machineId,
          override: reason === '' ? null : { reason },
          situationFingerprint: candidate.situationFingerprint,
        },
        {
          detail: candidate.machineCode,
          baseVersion: bookingBase(snapshot, 'outbound', {
            expectedMachineId: serverSlot?.machine?.id ?? null,
          }),
        },
      );
      const projected = await loadHandover(ctx, snapshot);
      return ok({ slot: projected?.slots.find((s) => s.id === assignmentId) ?? null });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/handover/${UUID}/slots/${UUID}/prepare$`),
    async handle(ctx, [bookingId, assignmentId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      const slot = detail.slots.find((s) => s.id === assignmentId);
      if (slot === undefined || slot.machine === null)
        return fail('VALIDATION', 'Zuerst eine Maschine zuweisen.');
      if (slot.status === 'prepared' || slot.status === 'issued') return ok({ slot });
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.prepare',
        { assignmentId: assignmentId! },
        {
          detail: slot.machine.machineCode,
          baseVersion: bookingBase(snapshot, 'outbound', { expectedMachineId: slot.machine.id }),
        },
      );
      const projected = await loadHandover(ctx, snapshot);
      return ok({ slot: projected?.slots.find((s) => s.id === assignmentId) ?? null });
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/staff/handover/${UUID}/items/${UUID}$`),
    async handle(ctx, [bookingId, itemId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.handover.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Übergabe ist bereits abgeschlossen.', 409);
      const item = detail.deliveryNote.items.find((i) => i.id === itemId);
      if (item === undefined) return fail('NOT_FOUND', 'Position nicht gefunden.', 404);
      const input = body as { actualQuantity?: unknown };
      const quantity = input.actualQuantity;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0)
        return fail('VALIDATION', 'Die Menge muss eine ganze Zahl ≥ 0 sein.');
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.item_quantity',
        {
          itemId: itemId!,
          actualQuantity: quantity,
          expectedPreviousQuantity: item.actualQuantity,
        },
        { detail: item.description, baseVersion: bookingBase(snapshot, 'outbound') },
      );
      return ok({ updated: true });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/staff/handover/${UUID}/recipient$`),
    async handle(ctx, [bookingId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.handover.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Übergabe ist bereits abgeschlossen.', 409);
      const input = body as {
        kind?: 'customer' | 'representative' | 'other';
        name?: string | null;
        phone?: string | null;
      };
      if (input.kind !== 'customer' && input.kind !== 'representative' && input.kind !== 'other')
        return fail('VALIDATION', 'Empfängerart fehlt.');
      if (input.kind === 'other' && (input.name ?? '').trim() === '')
        return fail('VALIDATION', 'Name der Empfangsperson fehlt.');
      if (input.kind === 'representative' && detail.representative === null)
        return fail('VALIDATION', 'Für diesen Vorgang ist keine Abholperson hinterlegt.');
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.recipient',
        { kind: input.kind, name: input.name ?? null, phone: input.phone ?? null },
        { baseVersion: bookingBase(snapshot, 'outbound') },
      );
      return ok({ saved: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/handover/${UUID}/machines/${UUID}/check$`),
    async handle(ctx, [bookingId, assignmentId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      const slot = detail.slots.find((s) => s.id === assignmentId);
      if (slot === undefined || slot.machine === null)
        return fail('VALIDATION', 'Dem Slot ist keine Maschine zugewiesen.');
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.check_machine',
        { assignmentId: assignmentId!, machineId: slot.machine.id },
        { detail: slot.machine.machineCode, baseVersion: bookingBase(snapshot, 'outbound') },
      );
      return ok({ checked: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/handover/${UUID}/machines/${UUID}/photos$`),
    async handle(ctx, [bookingId, assignmentId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      const slot = detail.slots.find((s) => s.id === assignmentId);
      if (slot === undefined || slot.machine === null)
        return fail('VALIDATION', 'Dem Slot ist keine Maschine zugewiesen.');
      const upload = decodeUpload(body);
      if (upload === null)
        return fail('VALIDATION', 'Das Foto muss zwischen 1 Byte und 6 MB groß sein.');
      const media = await ctx.runtime.storeMedia({
        purpose: 'handover_photo',
        mimeType: upload.mimeType,
        bytes: upload.bytes,
        contextKind: 'booking',
        contextId: snapshot.bookingId,
      });
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.photo',
        { assignmentId: assignmentId!, machineId: slot.machine.id, mediaId: media.mediaId },
        {
          detail: slot.machine.machineCode,
          baseVersion: bookingBase(snapshot, 'outbound'),
          mediaIds: [media.mediaId],
        },
      );
      return ok({ photoId: localPhotoId(media.mediaId) });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/staff/handover/${UUID}/signatures/(customer|staff)$`),
    async handle(ctx, [bookingId, role], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadHandover(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.handover.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Übergabe ist bereits abgeschlossen.', 409);
      if (role === 'customer' && detail.handover.recipientKind === null)
        return fail('VALIDATION', 'Bitte zuerst die Empfangsperson bestimmen.');
      const upload = decodeUpload(body);
      if (upload === null)
        return fail('VALIDATION', 'Die Unterschrift konnte nicht gelesen werden.');
      const media = await ctx.runtime.storeMedia({
        purpose: 'handover_signature',
        mimeType: 'image/png',
        bytes: upload.bytes,
        contextKind: 'booking',
        contextId: snapshot.bookingId,
      });
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.signature',
        { role: role as 'customer' | 'staff', mediaId: media.mediaId },
        {
          detail: role === 'customer' ? 'Kunde/Vertreter' : 'Mitarbeiter',
          baseVersion: bookingBase(snapshot, 'outbound'),
          mediaIds: [media.mediaId],
        },
      );
      return ok({ signed: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/handover/${UUID}/finalize$`),
    async handle(ctx, [bookingId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const mutations = await mutationsFor(ctx, snapshot);
      const detail = projectHandover(snapshot, mutations, ctx.staff);
      if (detail === null) return NOT_CACHED;
      if (detail.handover.status === 'finalized')
        return fail('CONFLICT', 'Die Übergabe ist bereits abgeschlossen.', 409);
      if (detail.offline.pendingFinalize)
        return ok({ detail, documents: handoverDocuments(snapshot) });
      if (detail.blockers.length > 0)
        return fail('VALIDATION', `Noch offen: ${detail.blockers.join(' ')}`, 409);
      await enqueueBooking(
        ctx,
        snapshot,
        'handover.finalize',
        {
          capturedAt: new Date().toISOString(),
          expectedSlots: detail.slots
            .filter((s) => s.machine !== null)
            .map((s) => ({ assignmentId: s.id, machineId: s.machine!.id })),
        },
        {
          baseVersion: bookingBase(snapshot, 'outbound'),
          // Medien/Erfassungen VOR der Finalisierung (§29).
          dependsOn: openIds(mutations),
        },
      );
      return ok({
        detail: await loadHandover(ctx, snapshot),
        documents: handoverDocuments(snapshot),
      });
    },
  },

  // ── Lesen: Rückgabe ──────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/staff\/returns$/,
    async handle(ctx) {
      const now = new Date();
      const entries: ReturnListEntry[] = [];
      for (const snapshot of await ctx.runtime.listBookings()) {
        const entry = returnListEntry(snapshot, await loadReturn(ctx, snapshot), now);
        if (entry !== null) entries.push(entry);
      }
      const order: Record<ReturnListEntry['group'], number> = {
        overdue: 0,
        today: 1,
        upcoming: 2,
        unscheduled: 3,
      };
      entries.sort(
        (a, b) =>
          order[a.group] - order[b.group] || (a.plannedAt ?? '').localeCompare(b.plannedAt ?? ''),
      );
      return ok({ entries });
    },
  },
  {
    method: 'POST',
    pattern: /^\/staff\/returns\/resolve-qr$/,
    async handle(ctx, _params, _query, body) {
      const machine = await ctx.runtime.findMachineByQrToken(qrTokenFrom(body));
      if (machine === null) return fail('NOT_FOUND', 'Dieser QR-Code ist nicht gültig.', 404);
      const snapshot = await returnContextForMachine(ctx, machine.machineId);
      if (snapshot === null)
        return fail(
          'NOT_FOUND',
          'Für diese Maschine ist offline keine offene Rückgabe bekannt.',
          404,
        );
      return ok({
        bookingId: snapshot.bookingId,
        processId: snapshot.processId,
        processNumber: snapshot.processNumber,
        machineCode: machine.machineCode,
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/processes/${UUID}/return$`),
    async handle(ctx, [processId]) {
      const snapshot = await ctx.runtime.findBookingByProcess(processId!);
      if (snapshot === null) return NOT_CACHED;
      const detail = await loadReturn(ctx, snapshot);
      return ok({
        detail,
        bookingId: snapshot.bookingId,
        canStart: detail !== null || snapshot.returnStartable,
        documents: returnDocuments(snapshot),
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/returns/${UUID}$`),
    async handle(ctx, [bookingId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const detail = await loadReturn(ctx, snapshot);
      if (detail === null) return fail('NOT_FOUND', 'Rückgabe nicht gefunden.', 404);
      return ok({ detail, documents: returnDocuments(snapshot) });
    },
  },

  // ── Schreiben: Rückgabe ──────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/start$`),
    async handle(ctx, [bookingId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const existing = await loadReturn(ctx, snapshot);
      if (existing !== null) return ok({ detail: existing, documents: returnDocuments(snapshot) });
      if (!snapshot.returnStartable || snapshot.returnSeed === null)
        return fail('VALIDATION', 'Für diesen Vorgang ist keine Maschine ausgegeben.');
      await enqueueBooking(
        ctx,
        snapshot,
        'return.start',
        {},
        {
          baseVersion: bookingBase(snapshot, 'return'),
        },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/staff/returns/${UUID}/returner$`),
    async handle(ctx, [bookingId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadReturn(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409);
      const input = body as {
        kind?: 'customer' | 'representative' | 'other';
        firstName?: string;
        lastName?: string;
        phone?: string;
      };
      if (input.kind !== 'customer' && input.kind !== 'representative' && input.kind !== 'other')
        return fail('VALIDATION', 'Rückgabeperson fehlt.');
      if (input.kind === 'representative' && detail.representative === null)
        return fail('VALIDATION', 'Für diesen Vorgang ist keine Abholperson hinterlegt.');
      if (
        input.kind === 'other' &&
        ((input.firstName ?? '').trim() === '' || (input.lastName ?? '').trim() === '')
      )
        return fail('VALIDATION', 'Vor- und Nachname der Rückgabeperson fehlen.');
      await enqueueBooking(
        ctx,
        snapshot,
        'return.returner',
        {
          kind: input.kind,
          firstName: input.kind === 'other' ? (input.firstName?.trim() ?? null) : null,
          lastName: input.kind === 'other' ? (input.lastName?.trim() ?? null) : null,
          phone:
            input.kind === 'other' && (input.phone ?? '').trim() !== ''
              ? input.phone!.trim()
              : null,
        },
        { baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/machines/${ANY}/accessories$`),
    async handle(ctx, [bookingId, returnMachineId]) {
      const found = await returnMachine(ctx, bookingId!, returnMachineId!);
      if ('error' in found) return found.error;
      const { snapshot, machine } = found;
      await enqueueBooking(
        ctx,
        snapshot,
        'return.accessory',
        { assignmentId: machine.assignmentId, machineId: machine.machineId },
        { detail: machine.machineCode, baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/machines/${ANY}/missing$`),
    async handle(ctx, [bookingId, returnMachineId], _q, body) {
      const found = await returnMachine(ctx, bookingId!, returnMachineId!);
      if ('error' in found) return found.error;
      const { snapshot, machine } = found;
      const input = body as {
        accessoryType?: 'lid' | 'drip_tray';
        missingQuantity?: number;
        description?: string | null;
      };
      if (input.accessoryType !== 'lid' && input.accessoryType !== 'drip_tray')
        return fail('VALIDATION', 'Zubehörart fehlt.');
      const quantity = input.missingQuantity;
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      )
        return fail('VALIDATION', 'Die Anzahl muss zwischen 1 und 10 liegen.');
      // Vorprüfung gegen das Soll aus dem Paket – die verbindliche Regel läuft beim Sync
      // (ReturnService); hier nur, damit die Erfassung nicht erst beim Sync scheitert.
      const expected =
        input.accessoryType === 'lid' ? machine.expectedLids : machine.expectedDripTrays;
      const already = machine.missingCases
        .filter((c) => c.accessoryType === input.accessoryType)
        .reduce((sum, c) => sum + c.missingQuantity, 0);
      if (already + quantity > expected)
        return fail(
          'VALIDATION',
          `Für diese Maschine sind ${expected} × ${input.accessoryType === 'lid' ? 'Deckel' : 'Tropfschale'} vorgesehen – mehr kann nicht fehlen.`,
        );
      await enqueueBooking(
        ctx,
        snapshot,
        'return.missing_item',
        {
          assignmentId: machine.assignmentId,
          machineId: machine.machineId,
          accessoryType: input.accessoryType,
          missingQuantity: quantity,
          description: (input.description ?? '').trim() === '' ? null : input.description!.trim(),
        },
        { detail: machine.machineCode, baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/staff/returns/${UUID}/missing/${ANY}$`),
    async handle(ctx, [bookingId, id]) {
      const mutationId = rawLocalId(id ?? '');
      if (mutationId === null) return ONLINE_REQUIRED;
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      await ctx.runtime.discard(mutationId);
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/machines/${ANY}/cleanliness$`),
    async handle(ctx, [bookingId, returnMachineId], _q, body) {
      const found = await returnMachine(ctx, bookingId!, returnMachineId!);
      if ('error' in found) return found.error;
      const { snapshot, machine } = found;
      const input = body as {
        emptied?: unknown;
        rinsedTwice?: unknown;
        nothingDismantled?: unknown;
      };
      if (
        typeof input.emptied !== 'boolean' ||
        typeof input.rinsedTwice !== 'boolean' ||
        typeof input.nothingDismantled !== 'boolean'
      )
        return fail('VALIDATION', 'Alle drei Prüfpunkte müssen beantwortet werden.');
      await enqueueBooking(
        ctx,
        snapshot,
        'return.cleanliness',
        {
          assignmentId: machine.assignmentId,
          machineId: machine.machineId,
          emptied: input.emptied,
          rinsedTwice: input.rinsedTwice,
          nothingDismantled: input.nothingDismantled,
        },
        { detail: machine.machineCode, baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/machines/${ANY}/photos$`),
    async handle(ctx, [bookingId, returnMachineId], _q, body) {
      const found = await returnMachine(ctx, bookingId!, returnMachineId!);
      if ('error' in found) return found.error;
      const { snapshot, machine } = found;
      const upload = decodeUpload(body);
      if (upload === null)
        return fail('VALIDATION', 'Das Foto muss zwischen 1 Byte und 6 MB groß sein.');
      if (upload.mimeType !== 'image/jpeg' && upload.mimeType !== 'image/png')
        return fail('VALIDATION', 'Beweisfotos nur als JPEG oder PNG.');
      const media = await ctx.runtime.storeMedia({
        purpose: 'return_cleanup_photo',
        mimeType: upload.mimeType,
        bytes: upload.bytes,
        contextKind: 'booking',
        contextId: snapshot.bookingId,
      });
      await enqueueBooking(
        ctx,
        snapshot,
        'return.cleanup_photo',
        {
          assignmentId: machine.assignmentId,
          machineId: machine.machineId,
          mediaId: media.mediaId,
        },
        {
          detail: machine.machineCode,
          baseVersion: bookingBase(snapshot, 'return'),
          mediaIds: [media.mediaId],
        },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/staff/returns/${UUID}/items/${ANY}$`),
    async handle(ctx, [bookingId, itemId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadReturn(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409);
      const item = detail.items.find((i) => i.id === itemId || i.deliveryNoteItemId === itemId);
      if (item === undefined) return fail('NOT_FOUND', 'Position nicht gefunden.', 404);
      const input = body as { returnedUnopenedQuantity?: unknown };
      const quantity = input.returnedUnopenedQuantity;
      // Lokale Plausibilität (§20, Test 53): nie mehr zurück als ausgegeben – der Server prüft erneut.
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > item.issuedQuantity
      ) {
        return fail(
          'VALIDATION',
          `Rückgabemenge muss zwischen 0 und ${item.issuedQuantity} liegen (ausgegebene Menge).`,
        );
      }
      await enqueueBooking(
        ctx,
        snapshot,
        'return.item_quantity',
        {
          deliveryNoteItemId: item.deliveryNoteItemId,
          returnedUnopenedQuantity: quantity,
          expectedIssuedQuantity: item.issuedQuantity,
        },
        { detail: item.description, baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/machines/${ANY}/damages$`),
    async handle(ctx, [bookingId, returnMachineId], _q, body) {
      const found = await returnMachine(ctx, bookingId!, returnMachineId!);
      if ('error' in found) return found.error;
      const { snapshot, machine } = found;
      const input = body as {
        severity?: 'light' | 'medium' | 'severe';
        description?: string;
        markers?: MutationPayload<'return.damage'>['markers'];
      };
      if (input.severity !== 'light' && input.severity !== 'medium' && input.severity !== 'severe')
        return fail('VALIDATION', 'Schwere des Schadens fehlt.');
      const description = (input.description ?? '').trim();
      if (description === '') return fail('VALIDATION', 'Beschreibung des Schadens fehlt.');
      if (!Array.isArray(input.markers) || input.markers.length === 0)
        return fail('VALIDATION', 'Mindestens eine Markierung am Schema ist erforderlich.');
      const mutationId = await enqueueBooking(
        ctx,
        snapshot,
        'return.damage',
        {
          assignmentId: machine.assignmentId,
          machineId: machine.machineId,
          severity: input.severity,
          description,
          markers: input.markers.map((m) => ({
            view: m.view,
            markerType: m.markerType,
            x: m.x,
            y: m.y,
            width: m.width ?? null,
            height: m.height ?? null,
          })),
          clientDamageId: crypto.randomUUID(),
        },
        { detail: machine.machineCode, baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({
        damageId: `local:${mutationId}`,
        detail: await loadReturn(ctx, snapshot),
        documents: returnDocuments(snapshot),
      });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/staff/returns/${UUID}/damages/${ANY}$`),
    async handle(ctx, [bookingId, id]) {
      const mutationId = rawLocalId(id ?? '');
      if (mutationId === null) return ONLINE_REQUIRED;
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      // Schadenfotos des lokalen Schadens mitverwerfen (fachliche Kinder, §29).
      const mutations = await mutationsFor(ctx, snapshot);
      for (const m of mutations) {
        const payload = m.payload as { damageMutationId?: string | null };
        if (m.type === 'return.damage_photo' && payload.damageMutationId === mutationId)
          await ctx.runtime.discard(m.clientMutationId);
      }
      await ctx.runtime.discard(mutationId);
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/damages/${ANY}/photos$`),
    async handle(ctx, [damageId], _q, body) {
      // Buchung über den Schaden finden (lokal erfasst oder aus dem Paket).
      let snapshot: LocalSnapshot | null = null;
      let detail: LocalReturnDetail | null = null;
      for (const candidate of await ctx.runtime.listBookings()) {
        const projected = await loadReturn(ctx, candidate);
        if (projected?.machines.some((m) => m.damages.some((d) => d.id === damageId)) === true) {
          snapshot = candidate;
          detail = projected;
          break;
        }
      }
      if (snapshot === null || detail === null)
        return fail('NOT_FOUND', 'Schaden offline nicht gefunden.', 404);
      if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409);
      const upload = decodeUpload(body);
      if (upload === null)
        return fail('VALIDATION', 'Das Foto muss zwischen 1 Byte und 6 MB groß sein.');
      if (upload.mimeType !== 'image/jpeg' && upload.mimeType !== 'image/png')
        return fail('VALIDATION', 'Schadenfotos nur als JPEG oder PNG.');
      const media = await ctx.runtime.storeMedia({
        purpose: 'return_damage_photo',
        mimeType: upload.mimeType,
        bytes: upload.bytes,
        contextKind: 'booking',
        contextId: snapshot.bookingId,
      });
      const damageMutationId = rawLocalId(damageId ?? '');
      const machine = detail.machines.find((m) => m.damages.some((d) => d.id === damageId));
      await enqueueBooking(
        ctx,
        snapshot,
        'return.damage_photo',
        {
          damageMutationId,
          damageId: damageMutationId === null ? damageId! : null,
          mediaId: media.mediaId,
        },
        {
          detail: machine?.machineCode ?? null,
          baseVersion: bookingBase(snapshot, 'return'),
          mediaIds: [media.mediaId],
          dependsOn: damageMutationId === null ? [] : [damageMutationId],
        },
      );
      return ok({ photoId: localPhotoId(media.mediaId) });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/staff/returns/${UUID}/signatures/(customer|staff)$`),
    async handle(ctx, [bookingId, role], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadReturn(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
        return fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409);
      if (role === 'customer' && detail.return.returnerKind === null)
        return fail('VALIDATION', 'Bitte zuerst die Rückgabeperson bestimmen.');
      const upload = decodeUpload(body);
      if (upload === null)
        return fail('VALIDATION', 'Die Unterschrift konnte nicht gelesen werden.');
      const media = await ctx.runtime.storeMedia({
        purpose: 'return_signature',
        mimeType: 'image/png',
        bytes: upload.bytes,
        contextKind: 'booking',
        contextId: snapshot.bookingId,
      });
      await enqueueBooking(
        ctx,
        snapshot,
        'return.signature',
        { role: role as 'customer' | 'staff', mediaId: media.mediaId },
        {
          detail: role === 'customer' ? 'Kunde/Vertreter' : 'Mitarbeiter',
          baseVersion: bookingBase(snapshot, 'return'),
          mediaIds: [media.mediaId],
        },
      );
      return ok({ signed: true });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/staff/returns/${UUID}/actual-return-time$`),
    async handle(ctx, [bookingId], _q, body) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      const detail = snapshot === null ? null : await loadReturn(ctx, snapshot);
      if (snapshot === null || detail === null) return NOT_CACHED;
      // Korrektur nach Abschluss ist offline nicht modelliert (§26).
      if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
        return ONLINE_REQUIRED;
      const input = body as { actualReturnAt?: unknown };
      if (
        typeof input.actualReturnAt !== 'string' ||
        Number.isNaN(Date.parse(input.actualReturnAt))
      )
        return ONLINE_REQUIRED;
      await enqueueBooking(
        ctx,
        snapshot,
        'return.actual_time',
        { actualReturnAt: new Date(input.actualReturnAt).toISOString() },
        { baseVersion: bookingBase(snapshot, 'return') },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/returns/${UUID}/finalize$`),
    async handle(ctx, [bookingId]) {
      const snapshot = await snapshotByBooking(ctx, bookingId!);
      if (snapshot === null) return NOT_CACHED;
      const mutations = await mutationsFor(ctx, snapshot);
      const machines = await ctx.machines();
      const detail = projectReturn(snapshot, mutations, ctx.staff, (machineId) =>
        machines.find((m) => m.machineId === machineId),
      );
      if (detail === null) return fail('NOT_FOUND', 'Rückgabe nicht gefunden.', 404);
      if (detail.return.status === 'finalized')
        return fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409);
      if (detail.offline.pendingFinalize)
        return ok({ detail, documents: returnDocuments(snapshot) });
      if (detail.blockers.length > 0)
        return fail('VALIDATION', `Noch offen: ${detail.blockers.join(' ')}`, 409);
      await enqueueBooking(
        ctx,
        snapshot,
        'return.finalize',
        {
          capturedAt: detail.return.draftActualReturnAt ?? new Date().toISOString(),
          expectedMachines: detail.machines.map((m) => ({
            assignmentId: m.assignmentId,
            machineId: m.machineId,
          })),
        },
        { baseVersion: bookingBase(snapshot, 'return'), dependsOn: openIds(mutations) },
      );
      return ok({ detail: await loadReturn(ctx, snapshot), documents: returnDocuments(snapshot) });
    },
  },

  // ── Maschinen ────────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/staff\/machines$/,
    async handle(ctx) {
      const rows = [];
      for (const machine of await ctx.machines()) rows.push(await machineListRow(ctx, machine));
      return ok({ machines: rows });
    },
  },
  {
    method: 'POST',
    pattern: /^\/staff\/machines\/qr\/resolve$/,
    async handle(ctx, _params, _query, body) {
      const machine = await ctx.runtime.findMachineByQrToken(qrTokenFrom(body));
      if (machine === null) return fail('NOT_FOUND', 'Dieser QR-Code ist nicht gültig.', 404);
      return ok({ machineId: machine.machineId, machineCode: machine.machineCode });
    },
  },

  // ── Suche (Finalisierung §6): nur offline, im Speicher über die entschlüsselten Snapshots ──
  {
    method: 'GET',
    pattern: /^\/staff\/search$/,
    async handle(ctx, _params, query) {
      if (!ctx.offline) return ONLINE_REQUIRED;
      const needle = (query.get('q') ?? '').trim().toLowerCase();
      const processes: OfflineSearchResults['processes'] = [];
      const machines: OfflineSearchResults['machines'] = [];
      if (needle.length >= 2) {
        const matches = (value: string | null | undefined) =>
          typeof value === 'string' && value.toLowerCase().includes(needle);
        for (const snapshot of await ctx.runtime.listBookings()) {
          if (!matches(snapshot.processNumber) && !matches(snapshot.customer.name)) continue;
          const status =
            snapshot.handover?.booking.processStatus ??
            snapshot.return?.booking.processStatus ??
            'open';
          processes.push({
            id: snapshot.processId,
            processNumber: snapshot.processNumber,
            mainStatus: isMainStatus(status) ? status : 'open',
            eventDate: snapshot.handover?.booking.eventDate ?? null,
            customerDisplayName: snapshot.customer.name,
          });
        }
        for (const machine of await ctx.machines()) {
          if (!matches(machine.machineCode)) continue;
          machines.push({
            id: machine.machineId,
            machineCode: machine.machineCode,
            status: machine.status,
          });
        }
        processes.sort((a, b) => a.processNumber.localeCompare(b.processNumber));
        machines.sort((a, b) => a.machineCode.localeCompare(b.machineCode));
      }
      const results: OfflineSearchResults = {
        customers: [],
        processes,
        machines,
        canViewCompleted: false,
        offline: true,
      };
      return ok(results);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/machines/${UUID}$`),
    async handle(ctx, [machineId]) {
      const machine = (await ctx.machines()).find((m) => m.machineId === machineId);
      if (machine === undefined) return NOT_CACHED;
      const status = machine.status as MachineStatus;
      return ok({
        machine: {
          id: machine.machineId,
          machineCode: machine.machineCode,
          productId: null,
          productName: machine.machineTypeName ?? '',
          status,
          statusLabel: MACHINE_STATUS_LABELS[status] ?? machine.status,
          locationKind: 'other',
          locationLabel: 'Standort offline nicht verfügbar',
          locationNote: null,
          purchaseDate: null,
          weightGrams: null,
          carryPersons: null,
          hasReferencePhoto: false,
          createdAt: machine.updatedAt,
          updatedAt: machine.updatedAt,
        },
        blocks: [],
        availability: {
          status: 'unknown',
          reasons: ['Verfügbarkeitsprüfung offline nicht möglich.'],
          notFullyCheckable: true,
        },
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/staff/machines/${UUID}/condition$`),
    async handle(ctx, [machineId]) {
      const machine = (await ctx.machines()).find((m) => m.machineId === machineId);
      if (machine === undefined) return NOT_CACHED;
      return ok(await machineCondition(ctx, machine));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/staff/machines/${UUID}/clean-complete$`),
    async handle(ctx, [machineId]) {
      const machine = (await ctx.machines()).find((m) => m.machineId === machineId);
      if (machine === undefined) return NOT_CACHED;
      if (machine.status !== 'cleaning')
        return fail('NOT_IN_CLEANING', 'Die Maschine ist nicht (mehr) in Reinigung.', 409);
      const mutations = await ctx.runtime.mutationsForContext('machine', machine.machineId);
      if (mutations.some((m) => m.type === 'machine.clean_complete' && m.status !== 'synced'))
        return ok({
          machine: { id: machine.machineId, status: machine.status },
          offlinePending: true,
        });
      await ctx.runtime.enqueue({
        type: 'machine.clean_complete',
        contextKind: 'machine',
        contextId: machine.machineId,
        payload: { expectedCleaningSince: machine.cleaningSince },
        summary: {
          processNumber: null,
          actionLabel: MUTATION_LABELS['machine.clean_complete'],
          detail: machine.machineCode,
        },
        baseVersion: JSON.stringify({ machineUpdatedAt: machine.updatedAt }),
      });
      return ok({
        machine: { id: machine.machineId, status: machine.status },
        offlinePending: true,
      });
    },
  },
];

/** Rückgabe-Maschine (lokale oder Server-ID) eines Vorgangs auflösen. */
async function returnMachine(
  ctx: RouterContext,
  bookingId: string,
  returnMachineId: string,
): Promise<
  { snapshot: LocalSnapshot; machine: ReturnMachineView } | { error: ApiResult<unknown> }
> {
  const snapshot = await snapshotByBooking(ctx, bookingId);
  const detail = snapshot === null ? null : await loadReturn(ctx, snapshot);
  if (snapshot === null || detail === null)
    return { error: fail('OFFLINE_NOT_CACHED', 'Rückgabe offline nicht verfügbar.', 404) };
  if (detail.return.status === 'finalized' || detail.offline.pendingFinalize)
    return { error: fail('CONFLICT', 'Die Rückgabe ist bereits abgeschlossen.', 409) };
  const machine = detail.machines.find(
    (m) => m.id === returnMachineId || m.assignmentId === returnMachineId,
  );
  if (machine === undefined)
    return { error: fail('NOT_FOUND', 'Maschine der Rückgabe nicht gefunden.', 404) };
  return { snapshot, machine };
}

/** Kontexte mit lokal ausstehenden Mutationen bleiben lokal, bis sie synchronisiert sind. */
async function contextHasPending(runtime: OfflineRuntime, path: string): Promise<boolean> {
  const booking = /^\/staff\/(?:handover|returns)\/([0-9a-fA-F-]{36})/.exec(path)?.[1];
  const process = /^\/staff\/processes\/([0-9a-fA-F-]{36})/.exec(path)?.[1];
  const machine = /^\/staff\/machines\/([0-9a-fA-F-]{36})/.exec(path)?.[1];
  const damage = /^\/staff\/damages\/(local:[^/]+)/.exec(path)?.[1];
  let contextId: string | null = booking ?? null;
  let kind: 'booking' | 'machine' = 'booking';
  if (process !== undefined) {
    contextId = (await runtime.findBookingByProcess(process))?.bookingId ?? null;
  } else if (machine !== undefined) {
    contextId = machine;
    kind = 'machine';
  } else if (damage !== undefined) {
    // Lokal erfasster Schaden: sein Vorgang hat per Definition ausstehende Änderungen.
    return true;
  }
  if (contextId === null) return false;
  const mutations = await runtime.mutationsForContext(kind, contextId);
  return mutations.some((m) => m.status !== 'synced');
}

export function isLocalReference(id: string): boolean {
  return isLocalId(id);
}

/**
 * Einstiegspunkt für apiFetch: null = normal an den Server weiterreichen.
 * Offline werden alle bekannten operativen Routen lokal beantwortet; online
 * nur solche, deren Kontext noch lokal ausstehende Änderungen hat (damit die
 * Reihenfolge der Erfassungen erhalten bleibt).
 */
export async function routeOffline(
  path: string,
  method: string,
  body: unknown,
): Promise<ApiResult<unknown> | null> {
  const runtime = offlineRuntime();
  const inFlight = runtime.initInFlight();
  if (inFlight !== null) await inFlight.catch(() => undefined);
  let state = runtime.snapshot;
  if (!state.initialized || !runtime.unlocked || state.identity === null) return null;
  if (state.connectivity === 'unknown') {
    // Direkt nach dem Seitenstart ist die Erreichbarkeit noch nicht geprüft: erst prüfen,
    // dann entscheiden – sonst würde ein online erreichbarer Server mit dem (ggf. veralteten
    // oder unvollständigen) lokalen Stand beantwortet.
    await runtime.checkConnectivity(false).catch(() => undefined);
    state = runtime.snapshot;
    if (!runtime.unlocked || state.identity === null) return null;
  }
  const identity = state.identity;
  const [pathname, queryString] = path.split('?', 2);
  const route = routes.find((r) => r.method === method && r.pattern.test(pathname ?? ''));
  const offline = state.connectivity !== 'online';
  if (route === undefined) {
    if (offline && method !== 'GET' && pathname?.startsWith('/staff/') === true)
      return ONLINE_REQUIRED;
    if (
      !offline &&
      method !== 'GET' &&
      pathname?.startsWith('/staff/') === true &&
      (await contextHasPending(runtime, pathname))
    ) {
      // Nicht offline modellierte Schreibaktion in einem Kontext mit ausstehenden
      // Offline-Änderungen: Reihenfolge wahren, erst synchronisieren (§29/§32).
      return fail(
        'OFFLINE_PENDING_CONTEXT',
        'Für diesen Vorgang sind noch Offline-Änderungen ausstehend – bitte zuerst synchronisieren (Synchronisierung prüfen).',
        409,
      );
    }
    return null;
  }
  if (!offline && !(await contextHasPending(runtime, pathname ?? ''))) return null;
  const params = route.pattern.exec(pathname ?? '')?.slice(1) ?? [];
  let machinesCache: Promise<OfflineMachineSnapshot[]> | null = null;
  const ctx: RouterContext = {
    runtime,
    offline,
    staff: { firstName: identity.firstName, lastName: identity.lastName },
    permissions: state.permissions,
    machines: () => {
      if (machinesCache === null) machinesCache = runtime.listMachines();
      return machinesCache;
    },
  };
  try {
    return await route.handle(ctx, params, new URLSearchParams(queryString ?? ''), body);
  } catch {
    return fail('OFFLINE_ERROR', 'Die Offline-Erfassung konnte lokal nicht gespeichert werden.');
  }
}

export type { HandoverDetail, ReturnDetail };
