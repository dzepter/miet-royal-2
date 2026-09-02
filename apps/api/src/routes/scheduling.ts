import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { SubstitutionService } from '../scheduling/substitution-service.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein')
  // Plausibilitätsgrenze (Order §3/§49): fachlich unmögliche Jahre
  // verständlich ablehnen statt absurde Termine zu speichern.
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2020 && year <= 2100;
  }, 'liegt außerhalb des fachlich möglichen Zeitraums (2020–2100)');

const calendarQuery = z.object({
  from: isoDateTime,
  to: isoDateTime,
  scope: z.enum(['mine', 'all']).optional(),
  kinds: z.string().max(60).optional(),
  userId: uuidSchema.optional(),
});

const scheduleBody = z.object({
  startAt: isoDateTime.nullable(),
  endAt: isoDateTime.nullable().optional(),
  expectedVersion: z.number().int().min(1),
});

const assignBody = z.object({
  userId: uuidSchema,
  expectedVersion: z.number().int().min(1),
});

const resolveConflictBody = z.object({
  type: z.string().min(1).max(60),
  // Kapazitätskonflikte (Phase 5) umfassen ALLE Termine transitiv
  // überlappender Buchungen eines Typs – auch große Cluster müssen als
  // gelöst markierbar bleiben, daher großzügiger als Personen-Konflikte.
  appointmentIds: z.array(uuidSchema).min(2).max(200),
});

const substitutionBody = z.object({
  originalUserId: uuidSchema,
  substituteUserId: uuidSchema,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});

interface SchedulingRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
}

export function registerSchedulingRoutes(
  app: FastifyInstance,
  options: SchedulingRouteOptions,
): void {
  const { db, auth, config } = options;
  const scheduling = new SchedulingService(db);
  const substitutions = new SubstitutionService(db);
  const processService = new ProcessService(db);

  /**
   * Sichtbarkeit eines Einzeltermins (Pflichttest 54, IDOR): mit
   * calendar.view_all alles; sonst nur Termine, bei denen der Betrachter
   * zugewiesener ODER effektiver Mitarbeiter ist – alles andere neutral 404.
   */
  const requireVisibleAppointment = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    appointmentId: string,
  ): Promise<boolean> => {
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      if (effective.has('calendar.view_all')) return true;
      const entry = await scheduling.entryById(appointmentId);
      if (
        entry.assignedUserId === context.user.id ||
        entry.effectiveAssigneeId === context.user.id
      ) {
        return true;
      }
      sendError(request, reply, 404, 'NOT_FOUND', 'Termin nicht gefunden.');
      return false;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  // ── Heute & Kalender (Order §§13/14/22) ────────────────────────────────

  app.get('/staff/today', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const effective = await auth.effectivePermissions(context.user.id);
    const scope = effective.has('calendar.view_all') ? 'all' : 'mine';
    return { scope, ...(await scheduling.todayView(context.user.id, scope)) };
  });

  app.get('/staff/calendar', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const query = parseOrThrow(calendarQuery, request.query, 'query');
    const effective = await auth.effectivePermissions(context.user.id);
    const viewAll = effective.has('calendar.view_all');
    // "Alle Termine" und der Mitarbeiterfilter sind serverseitig an
    // calendar.view_all gebunden (Pflichttests 53/58).
    const scope = query.scope ?? (viewAll ? 'all' : 'mine');
    if ((scope === 'all' || query.userId !== undefined) && !viewAll) {
      sendError(request, reply, 403, 'FORBIDDEN', 'Dir fehlt das Recht für den Gesamtkalender.');
      return;
    }
    const kinds = query.kinds
      ?.split(',')
      .filter((kind): kind is 'pickup' | 'return' | 'delivery' =>
        ['pickup', 'return', 'delivery'].includes(kind),
      );
    const entries = await scheduling.listCalendar(context.user.id, {
      from: new Date(query.from),
      to: new Date(query.to),
      scope,
      kinds,
      userId: query.userId,
    });
    return { scope, entries };
  });

  app.get('/staff/appointments/open', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const effective = await auth.effectivePermissions(context.user.id);
    const scope = effective.has('calendar.view_all') ? 'all' : 'mine';
    return { entries: await scheduling.listOrganizationalOpen(context.user.id, scope) };
  });

  app.get('/staff/appointments/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      return { entry: await scheduling.entryById(params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Zeit festlegen / verschieben (Order §§3/16/27) ─────────────────────

  app.patch('/staff/appointments/:id/schedule', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.drag_drop'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(scheduleBody, request.body);
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      const updated = await scheduling.reschedule(context.user.id, params.id, {
        startAt: body.startAt === null ? null : new Date(body.startAt),
        endAt: body.endAt === null || body.endAt === undefined ? null : new Date(body.endAt),
        expectedVersion: body.expectedVersion,
      });
      return { updated: true, version: updated.version };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/appointments/:id/assign', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'appointment.assign'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(assignBody, request.body);
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const updated = await scheduling.assign(
        context.user.id,
        params.id,
        { userId: body.userId, expectedVersion: body.expectedVersion },
        effective,
      );
      return { updated: true, version: updated.version };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** "Termin übernommen" – identitätsgebunden (Order §11). */
  app.post('/staff/appointments/:id/acknowledge', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    // Neutrale 404 für fremde IDs (kein Existenz-Orakel, Pflichttest 54).
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      await scheduling.acknowledge(context.user.id, params.id);
      return { acknowledged: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Interner Planungsabschluss (Order §30) – ehrlich benannt, kein Protokoll. */
  app.post('/staff/appointments/:id/complete', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(z.object({ expectedVersion: z.number().int().min(1) }), request.body);
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      await scheduling.complete(context.user.id, params.id, body.expectedVersion);
      return { completed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** "Kunde kontaktiert" bei überfälliger Rückgabe (Order §26). */
  app.post('/staff/appointments/:id/customer-contacted', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      await scheduling.markCustomerContacted(context.user.id, params.id);
      return { marked: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Konflikte (Order §§18–20) ──────────────────────────────────────────

  /**
   * "Konflikt gelöst": jeder aktive Mitarbeiter mit Sicht auf die
   * betroffenen Termine – bewusst KEIN Adminrecht, kein Kommentar, kein
   * Audit-Event. Der Fingerprint wird serverseitig berechnet.
   */
  app.post('/staff/conflicts/resolve', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const body = parseOrThrow(resolveConflictBody, request.body);
    for (const appointmentId of body.appointmentIds) {
      if (!(await requireVisibleAppointment(request, reply, context, appointmentId))) return;
    }
    try {
      const substitutionRows = await scheduling.listForConflictCheck(body.appointmentIds);
      await scheduling.conflicts.resolve(
        { appointments: substitutionRows },
        body.type,
        body.appointmentIds,
      );
      return { resolved: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'CONFLICT_NOT_FOUND') {
        sendError(
          request,
          reply,
          404,
          'NOT_FOUND',
          'Dieser Konflikt besteht auf dem aktuellen Stand nicht.',
        );
        return;
      }
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Terminplanung im Vorgang (Order §§4–6) ─────────────────────────────

  /** Zentrale Vorgangs-Sichtbarkeitsregel der Phase 2 – auch für Termindaten. */
  const visibilityCtxFor = async (userId: string) => {
    const effective = await auth.effectivePermissions(userId);
    return buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
  };

  app.get('/staff/processes/:id/appointments', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      // Sichtbarkeitsregel wie im CRM: unsichtbare Vorgänge = neutrale 404
      // (kein Oracle, keine Termindaten außerhalb des Sichtfensters).
      await processService.getVisibleProcess(params.id, await visibilityCtxFor(context.user.id));
      return { entries: await scheduling.listForProcess(params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/appointments/weekend-standard', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.drag_drop'))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await processService.getVisibleProcess(params.id, await visibilityCtxFor(context.user.id));
      return await scheduling.applyWeekendStandard(context.user.id, params.id);
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Vertretungen (Order §12) ───────────────────────────────────────────

  app.get('/staff/substitutions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'substitution.manage'))) return;
    return { substitutions: await substitutions.list() };
  });

  app.post('/staff/substitutions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'substitution.manage'))) return;
    const body = parseOrThrow(substitutionBody, request.body);
    try {
      const created = await substitutions.create(context.user.id, {
        originalUserId: body.originalUserId,
        substituteUserId: body.substituteUserId,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
      });
      return { substitution: created };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/substitutions/:id/end', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'substitution.manage'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await substitutions.endEarly(params.id);
      return { ended: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Aktive Mitarbeiter für Zuweisungs-/Vertretungsauswahl (datenminimal). */
  app.get('/staff/scheduling/staff-options', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const effective = await auth.effectivePermissions(context.user.id);
    if (
      !effective.has('appointment.assign') &&
      !effective.has('substitution.manage') &&
      !effective.has('calendar.view_all')
    ) {
      sendError(request, reply, 403, 'FORBIDDEN', 'Dir fehlt das Recht für diese Auswahl.');
      return;
    }
    return { staff: await processService.listAssignableStaff() };
  });
}
