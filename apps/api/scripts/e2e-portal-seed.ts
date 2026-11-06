/**
 * Phase 15 (E2E): Seed-Skript für die Kundenportal-Szenarien A–P – läuft als
 * Kindprozess der Spec (`pnpm --filter @mietroyal/api exec tsx
 * scripts/e2e-portal-seed.ts`, siehe tests/e2e/helpers/portal.ts) gegen die
 * per TEST_DATABASE_URL übergebene E2E-Datenbank (Sicherheitsstopp sonst; nie
 * dev/produktiv). Muster wie scripts/e2e-tours-seed.ts, nur additiv.
 *
 * Es nutzt AUSSCHLIESSLICH die bestehenden Test-Helfer/Fachservices der API
 * (apps/api/test: createTestContext, createTestCustomer, acceptedBookingFor-
 * Customer – echter Annahmepfad Anfrage → Angebot → Versand → Online-Annahme –,
 * SchedulingService.reschedule, OrderConfirmationService.approve,
 * readyHandover + HandoverService.finalize, TourService create/addStop/start,
 * CustomerService.moveToTrash, ProcessService.addNote). Bewusste, dokumentierte
 * Abkürzungen:
 * - Live-Standort der aktiven Tour (Szenario G) wird wie im Integrationstest-
 *   Helfer `setLiveLocation` direkt in `tour_live_locations` geschrieben – nur
 *   damit es serverseitig GPS-Daten gibt, die das Portal NICHT zeigen darf.
 * - Dokument-Bytes (Angebot, AB, Lieferschein, Übergabeprotokoll), die die
 *   Fachservices dieses Prozesses in den Test-Storage geschrieben haben, werden
 *   mit identischem Storage-Key (und damit identischer SHA-256) in das Storage
 *   der E2E-API kopiert (`E2E_PORTAL_INPUT.storageRoot`) – sonst könnte die
 *   API die Dokumente nicht ausliefern. Inhalt/Prüfsumme bleiben unverändert.
 *
 * Es entstehen KEINE Portal-Sessions und KEINE Magic Links: Anmeldungen laufen
 * im E2E ausschließlich über die echte Mail aus der SMTP-Senke.
 *
 * Eingabe: Umgebungsvariable E2E_PORTAL_INPUT (JSON, siehe PortalSeedInput in
 * tests/e2e/helpers/portal.ts); Ausgabe: genau eine JSON-Zeile auf stdout
 * (nur IDs, Vorgangsnummern, Daten – nie Tokens).
 */
import {
  appointments,
  documents,
  type Appointment,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { berlinDateOf, berlinDateTimeToUtc } from '@mietroyal/domain';
import { FilesystemStorageProvider } from '@mietroyal/integrations';
import type { PermissionKey } from '@mietroyal/permissions';
import { eq, inArray } from 'drizzle-orm';
import { SchedulingService } from '../src/scheduling/scheduling-service.ts';
import { TourService } from '../src/tours/tour-service.ts';
import { createTestContext, type TestContext } from '../test/auth-helpers.ts';
import {
  commerceServices,
  inquiryServiceFor,
  productServiceFor,
} from '../test/commerce-helpers.ts';
import {
  adminVisibilityCtx,
  createStaffWithPermissions,
  createTestCustomer,
  customerServiceFor,
  processServiceFor,
} from '../test/crm-helpers.ts';
import {
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
} from '../test/handover-helpers.ts';
import { settleMailJobs } from '../test/mail-job-helpers.ts';
import { acceptedBookingForCustomer } from '../test/portal-test-helpers.ts';

interface SeedCustomer {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Kunde danach in den Papierkorb (deleted_at) – Szenario B. */
  trashed?: boolean;
}

interface SeedTourDriver {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

interface SeedBooking {
  key: string;
  customer: string;
  fulfillment?: 'pickup' | 'delivery';
  /** Eventdatum = heute (Berlin) + N Tage. */
  eventInDays: number;
  machineSlug?: string;
  /** Abholung exakt (Vortag 10:00 Berlin), Rückgabe als Fenster (Folgetag 10:00–12:00 Berlin). */
  plannedAppointments?: boolean;
  /** Freigegebene Auftragsbestätigung (Dokument „Auftragsbestätigung“). */
  approveOrderConfirmation?: boolean;
  /** Finalisierte Übergabe mit dieser Seed-Maschine (Lieferschein, Übergabeprotokoll, Storno-Blocker). */
  issuedMachineCode?: string;
  /** Interne Vorgangsnotiz (darf im Portal nie erscheinen). */
  internalNote?: string;
  /** Lieferung HEUTE im Fenster + aktive Tour des Fahrers mit genau diesem Stopp. */
  activeTour?: {
    windowStart: string;
    windowEnd: string;
    driver: SeedTourDriver;
    location: { latitude: number; longitude: number };
  };
}

interface SeedInquiry {
  key: string;
  customer: string;
  /** Angebot versenden (aber NICHT annehmen). */
  sendOffer?: boolean;
}

interface SeedInput {
  adminEmail: string;
  /** Storage-Wurzel der E2E-API (Dokument-Bytes werden dorthin kopiert). */
  storageRoot: string;
  customers: SeedCustomer[];
  bookings?: SeedBooking[];
  inquiries?: SeedInquiry[];
}

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (!databaseUrl.includes('mietroyal_test')) {
  console.error(
    'Sicherheitsstopp: portal-seed-script läuft nur gegen eine mietroyal_test-Datenbank.',
  );
  process.exit(2);
}
const input = JSON.parse(process.env.E2E_PORTAL_INPUT ?? '{}') as SeedInput;

const DAY_MS = 86_400_000;

/** ISO-Tag „heute (Berlin) + days“. */
function berlinDayInDays(days: number): string {
  const [y, m, d] = berlinDateOf(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

function shiftDay(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

async function adminIdByEmail(ctx: TestContext, email: string): Promise<string> {
  const rows = await ctx.pool.query<{ id: string }>(
    'SELECT id FROM staff_users WHERE lower(email) = lower($1)',
    [email],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error(`Admin ${email} nicht gefunden`);
  return id;
}

async function bookingAppointments(executor: DatabaseExecutor, bookingId: string) {
  const rows = await executor
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId));
  const outbound = rows.find((row) => row.kind === 'pickup' || row.kind === 'delivery');
  const inbound = rows.find((row) => row.kind === 'return');
  if (outbound === undefined || inbound === undefined) {
    throw new Error(`Termine der Buchung ${bookingId} fehlen`);
  }
  return { outbound, inbound };
}

async function reschedule(
  scheduling: SchedulingService,
  adminId: string,
  appointment: Appointment,
  startAt: Date,
  endAt: Date | null,
): Promise<void> {
  await scheduling.reschedule(adminId, appointment.id, {
    startAt,
    endAt,
    expectedVersion: appointment.version,
  });
}

async function run(ctx: TestContext) {
  const adminId = await adminIdByEmail(ctx, input.adminEmail);
  const scheduling = new SchedulingService(ctx.db);
  const effective = await ctx.auth.effectivePermissions(adminId);

  const customers: Record<string, { id: string; email: string }> = {};
  for (const customer of input.customers) {
    const created = await createTestCustomer(ctx, adminId, {
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
    });
    if (customer.trashed === true) {
      await customerServiceFor(ctx).moveToTrash(adminId, created.id);
    }
    customers[customer.key] = { id: created.id, email: customer.email };
  }
  const customerId = (key: string): string => {
    const found = customers[key];
    if (found === undefined) throw new Error(`Unbekannter Kunde ${key}`);
    return found.id;
  };

  const bookings: Record<string, unknown> = {};
  const tours: Record<string, { tourId: string; driverId: string }> = {};
  const processIds: string[] = [];
  let inventoryReady = false;

  for (const booking of input.bookings ?? []) {
    const fulfillment = booking.fulfillment ?? 'pickup';
    const eventDate = berlinDayInDays(booking.eventInDays);
    const booked = await acceptedBookingForCustomer(ctx, adminId, customerId(booking.customer), {
      eventDate,
      fulfillment,
      ...(booking.machineSlug === undefined ? {} : { machineSlug: booking.machineSlug }),
    });
    processIds.push(booked.processId);
    const { outbound, inbound } = await bookingAppointments(ctx.db, booked.bookingId);

    if (booking.plannedAppointments === true) {
      // Exakter Termin vs. Zeitfenster (Order §18): Abholung exakt, Rückgabe als Fenster.
      await reschedule(
        scheduling,
        adminId,
        outbound,
        berlinDateTimeToUtc(shiftDay(eventDate, -1), 10, 0),
        null,
      );
      await reschedule(
        scheduling,
        adminId,
        inbound,
        berlinDateTimeToUtc(shiftDay(eventDate, 1), 10, 0),
        berlinDateTimeToUtc(shiftDay(eventDate, 1), 12, 0),
      );
    }

    if (booking.approveOrderConfirmation === true) {
      const services = commerceServices(ctx);
      const confirmation = await services.confirmations.byBookingId(booked.bookingId);
      if (confirmation === null) throw new Error(`AB der Buchung ${booking.key} fehlt`);
      await services.confirmations.approve(adminId, confirmation.id);
    }

    if (booking.issuedMachineCode !== undefined) {
      // Wie test/return-helpers.ts issuedBooking: Termine morgen/übermorgen+1, Übergabe final.
      const now = Date.now();
      await reschedule(scheduling, adminId, outbound, new Date(now + DAY_MS), null);
      await reschedule(scheduling, adminId, inbound, new Date(now + 3 * DAY_MS), null);
      if (!inventoryReady) {
        await initializeAllInventory(ctx, adminId, 20);
        inventoryReady = true;
      }
      await readyHandover(ctx, adminId, booked.bookingId, [booking.issuedMachineCode]);
      await handoverServicesFor(ctx).handover.finalize(adminId, booked.bookingId);
      await settleMailJobs(ctx); // Übergabeprotokoll-Mail im Test-Runner (nicht an die Senke)
    }

    if (booking.internalNote !== undefined) {
      await processServiceFor(ctx).addNote(
        booked.processId,
        adminId,
        booking.internalNote,
        adminVisibilityCtx(),
      );
    }

    if (booking.activeTour !== undefined) {
      if (fulfillment !== 'delivery') throw new Error('Aktive Tour nur für Lieferbuchungen');
      const spec = booking.activeTour;
      await reschedule(
        scheduling,
        adminId,
        outbound,
        new Date(spec.windowStart),
        new Date(spec.windowEnd),
      );
      const driverPermissions: PermissionKey[] = ['calendar.view'];
      const driver = await createStaffWithPermissions(ctx, adminId, {
        firstName: spec.driver.firstName,
        lastName: spec.driver.lastName,
        email: spec.driver.email,
        password: spec.driver.password,
        permissionKeys: driverPermissions,
      });
      const tourService = new TourService(ctx.db);
      const tour = await tourService.create(adminId, {
        tourDate: berlinDateOf(new Date()),
        assignedUserId: driver.user.id,
      });
      await tourService.addStop(adminId, tour.id, { appointmentId: outbound.id }, effective);
      const started = await tourService.start(driver.user.id, tour.id);
      if (started.tour.status !== 'active') throw new Error('Tour wurde nicht gestartet');
      await ctx.pool.query(
        `INSERT INTO tour_live_locations (tour_id, user_id, latitude, longitude, accuracy_meters, observed_at, received_at)
         VALUES ($1, $2, $3, $4, 20, now(), now())
         ON CONFLICT (tour_id) DO UPDATE SET latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude, observed_at = EXCLUDED.observed_at, received_at = now()`,
        [tour.id, driver.user.id, spec.location.latitude, spec.location.longitude],
      );
      tours[booking.key] = { tourId: tour.id, driverId: driver.user.id };
    }

    bookings[booking.key] = {
      bookingId: booked.bookingId,
      processId: booked.processId,
      processNumber: booked.processNumber,
      customerId: customerId(booking.customer),
      eventDate,
    };
  }

  const inquiries: Record<string, { processId: string; processNumber: string }> = {};
  for (const inquiry of input.inquiries ?? []) {
    const process = await processServiceFor(ctx).createProcess(adminId, {
      customerId: customerId(inquiry.customer),
    });
    processIds.push(process.id);
    const machine = await productServiceFor(ctx).getProductBySlug('slush-1x8');
    await inquiryServiceFor(ctx).upsertForProcess(adminId, process.id, {
      eventDate: berlinDayInDays(45),
      guestCount: 20,
      occasion: 'birthday',
      machineProductId: machine.id,
      fulfillment: 'pickup',
      selections: [],
    });
    if (inquiry.sendOffer === true) {
      const services = commerceServices(ctx);
      const { versionId } = await services.offers.createOffer(adminId, process.id);
      await services.offers.send(adminId, versionId, effective);
      await settleMailJobs(ctx); // Angebotsmail im Test-Runner (nicht an die Senke)
    }
    inquiries[inquiry.key] = { processId: process.id, processNumber: process.processNumber };
  }

  // Dokument-Bytes mit identischem Key in das Storage der E2E-API kopieren (siehe Kopf).
  let copiedDocuments = 0;
  if (processIds.length > 0) {
    const target = new FilesystemStorageProvider(input.storageRoot);
    const rows = await ctx.db
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(inArray(documents.processId, processIds));
    for (const row of rows) {
      await target.put(row.storageKey, await ctx.storage.get(row.storageKey), {
        contentType: 'application/pdf',
      });
      copiedDocuments += 1;
    }
  }

  return { customers, bookings, inquiries, tours, copiedDocuments };
}

const ctx = await createTestContext();
try {
  const output = await run(ctx);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  await ctx.app.close();
  await ctx.pool.end();
}
process.exit(0);
