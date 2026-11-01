/**
 * Phase 13 (E2E): Seed-Skript für die Touren-Szenarien – läuft als Kind-
 * prozess der Spec (`pnpm --filter @mietroyal/api exec tsx
 * scripts/e2e-tours-seed.ts`, siehe tests/e2e/helpers/tours.ts) gegen die per
 * TEST_DATABASE_URL übergebene E2E-Datenbank (Sicherheitsstopp sonst; nie
 * dev/produktiv). Muster wie scripts/e2e-seed.ts, nur additiv.
 *
 * Es nutzt AUSSCHLIESSLICH die bestehenden Test-Helfer der API
 * (apps/api/test: createTestContext, createAcceptedBooking – echter Annahme-
 * pfad Anfrage → Angebot → Online-Annahme –, SchedulingService.reschedule/
 * assign, createStaffWithPermissions) und keine Rohdaten-Abkürzungen für
 * Fachzustände. Einzige bewusste Abkürzungen (dokumentiert im E2E-Bericht):
 * - `complete`: fachlicher Terminabschluss wie Übergabe/Rückgabe über
 *   `SchedulingService.completeWithin` (derselbe Weg wie die Phase-13-
 *   Integrationstests, tours-helpers.ts `completeAppointment`).
 * - `travel-status`: `getCustomerTravelStatus(db, bookingId)` – der interne
 *   Status „Unterwegs“ hat laut Auftrag KEINEN Endpunkt (Szenario L).
 * - Liefer-/Depotadressen werden gesetzt wie in den Integrationstests
 *   (Termin-Snapshot bzw. `setStringSetting(pickup_exact_address)`).
 *
 * Eingabe: Umgebungsvariable E2E_TOURS_INPUT (JSON, siehe ToursSeedInput in
 * tests/e2e/helpers/tours.ts); Ausgabe: genau eine JSON-Zeile auf stdout.
 */
import { appointments } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { eq } from 'drizzle-orm';
import { PICKUP_EXACT_ADDRESS_KEY, setStringSetting } from '../src/crm/settings-service.ts';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';
import { getCustomerTravelStatus } from '../src/tours/travel-status.ts';
import { createTestContext, type TestContext } from '../test/auth-helpers.ts';
import { createStaffWithPermissions } from '../test/crm-helpers.ts';
import { createAcceptedBooking } from '../test/scheduling-helpers.ts';

interface SeedUser {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  permissions: PermissionKey[];
}

interface SeedTime {
  startAt: string;
  endAt?: string | null;
}

interface SeedBooking {
  key: string;
  fulfillment?: 'delivery' | 'pickup';
  customer?: { firstName: string; lastName: string };
  /** Lieferadresse im Termin-Snapshot (Default: „Lieferweg 12, 55129 Mainz“ aus dem Helfer). */
  address?: { street: string; postalCode: string; city: string };
  outbound?: SeedTime | null;
  inbound?: SeedTime | null;
  /** Termine (beide) dieser Person zuweisen (Key aus `users` oder 'admin'). */
  assignTo?: string;
}

type SeedInput =
  | {
      mode: 'seed';
      adminEmail: string;
      depotAddress?: string | null;
      users?: SeedUser[];
      bookings?: SeedBooking[];
    }
  | { mode: 'complete'; adminEmail: string; appointmentId: string }
  | { mode: 'travel-status'; bookingId: string };

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (!databaseUrl.includes('mietroyal_test')) {
  console.error(
    'Sicherheitsstopp: tours-seed-script läuft nur gegen eine mietroyal_test-Datenbank.',
  );
  process.exit(2);
}
const input = JSON.parse(process.env.E2E_TOURS_INPUT ?? '{}') as SeedInput;

async function adminIdByEmail(ctx: TestContext, email: string): Promise<string> {
  const rows = await ctx.pool.query<{ id: string }>(
    'SELECT id FROM staff_users WHERE lower(email) = lower($1)',
    [email],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error(`Admin ${email} nicht gefunden`);
  return id;
}

async function appointmentById(ctx: TestContext, id: string) {
  const rows = await ctx.db.select().from(appointments).where(eq(appointments.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error(`Termin ${id} nicht gefunden`);
  return row;
}

function appointmentOut(row: { id: string; kind: string; version: number; status: string }) {
  return { id: row.id, kind: row.kind, version: row.version, status: row.status };
}

async function runSeed(ctx: TestContext, seed: Extract<SeedInput, { mode: 'seed' }>) {
  const adminId = await adminIdByEmail(ctx, seed.adminEmail);
  const scheduling = new SchedulingService(ctx.db);
  const effective = await ctx.auth.effectivePermissions(adminId);
  if (seed.depotAddress !== undefined && seed.depotAddress !== null) {
    await setStringSetting(ctx.db, adminId, PICKUP_EXACT_ADDRESS_KEY, seed.depotAddress);
  }
  const users: Record<string, { id: string; email: string }> = {
    admin: { id: adminId, email: seed.adminEmail },
  };
  for (const user of seed.users ?? []) {
    const created = await createStaffWithPermissions(ctx, adminId, {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      password: user.password,
      permissionKeys: user.permissions,
    });
    users[user.key] = { id: created.user.id, email: user.email };
  }
  const bookings: Record<string, unknown> = {};
  for (const booking of seed.bookings ?? []) {
    const fulfillment = booking.fulfillment ?? 'delivery';
    const booked = await createAcceptedBooking(ctx, adminId, { fulfillment, eventInDays: 30 });
    if (booking.customer !== undefined) {
      await ctx.pool.query('UPDATE customers SET first_name = $1, last_name = $2 WHERE id = $3', [
        booking.customer.firstName,
        booking.customer.lastName,
        booked.customerId,
      ]);
    }
    await scheduling.ensureAppointmentsForBooking(booked.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, booked.bookingId));
    const outboundKind = fulfillment === 'delivery' ? 'delivery' : 'pickup';
    const outbound = rows.find((row) => row.kind === outboundKind);
    const inbound = rows.find((row) => row.kind === 'return');
    if (outbound === undefined || inbound === undefined) {
      throw new Error(`Termine der Buchung ${booking.key} fehlen`);
    }
    if (booking.address !== undefined && fulfillment === 'delivery') {
      for (const row of [outbound, inbound]) {
        await ctx.db
          .update(appointments)
          .set({ locationSnapshot: booking.address })
          .where(eq(appointments.id, row.id));
      }
    }
    const times: [typeof outbound, SeedTime | null | undefined][] = [
      [outbound, booking.outbound],
      [inbound, booking.inbound],
    ];
    for (const [row, time] of times) {
      if (time === undefined) continue;
      const startAt = time === null ? null : new Date(time.startAt);
      const endAt =
        time === null || time.endAt === undefined || time.endAt === null
          ? null
          : new Date(time.endAt);
      // Phase 14: ungültige Fenster (z. B. beide Enden auf 23:59 geklemmt) klar benennen,
      // statt mit der generischen Regelverletzung des SchedulingService zu scheitern.
      if (startAt !== null && endAt !== null && endAt.getTime() <= startAt.getTime()) {
        throw new Error(
          `E2E-Touren-Seed: Zeitfenster von ${booking.key}/${row.kind} ist ungültig ` +
            `(${startAt.toISOString()} – ${endAt.toISOString()}, Ende ≤ Beginn). Resttag zu kurz? ` +
            'Termine über fitTodayTimeline/todayWindow (tests/e2e/helpers/tours.ts) anlegen.',
        );
      }
      const current = await appointmentById(ctx, row.id);
      await scheduling.reschedule(adminId, row.id, {
        startAt,
        endAt,
        expectedVersion: current.version,
      });
    }
    if (booking.assignTo !== undefined) {
      const target = users[booking.assignTo];
      if (target === undefined) throw new Error(`Unbekannter Nutzer ${booking.assignTo}`);
      for (const row of [outbound, inbound]) {
        const current = await appointmentById(ctx, row.id);
        await scheduling.assign(
          adminId,
          row.id,
          { userId: target.id, expectedVersion: current.version },
          effective,
        );
      }
    }
    const processRows = await ctx.pool.query<{ process_number: string }>(
      'SELECT process_number FROM processes WHERE id = $1',
      [booked.processId],
    );
    bookings[booking.key] = {
      processId: booked.processId,
      processNumber: processRows.rows[0]?.process_number ?? '',
      bookingId: booked.bookingId,
      customerId: booked.customerId,
      outbound: appointmentOut(await appointmentById(ctx, outbound.id)),
      inbound: appointmentOut(await appointmentById(ctx, inbound.id)),
    };
  }
  return { users, bookings };
}

const ctx = await createTestContext();
try {
  let output: unknown;
  if (input.mode === 'seed') {
    output = await runSeed(ctx, input);
  } else if (input.mode === 'complete') {
    const adminId = await adminIdByEmail(ctx, input.adminEmail);
    const scheduling = new SchedulingService(ctx.db);
    await ctx.db.transaction((tx) => scheduling.completeWithin(tx, adminId, input.appointmentId));
    output = { completed: appointmentOut(await appointmentById(ctx, input.appointmentId)) };
  } else if (input.mode === 'travel-status') {
    output = await getCustomerTravelStatus(ctx.db, input.bookingId);
  } else {
    throw new Error('Unbekannter Modus');
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  await ctx.app.close();
  await ctx.pool.end();
}
process.exit(0);
