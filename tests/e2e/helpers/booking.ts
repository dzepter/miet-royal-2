import { expect, type Page } from '@playwright/test';
import { WEB_ORIGIN } from './seed.ts';

export interface AcceptedBookingOptions {
  firstName: string;
  lastName: string;
  email: string;
  /** Label im Maschinentyp-Select der Anfrage. */
  machineLabel: '1×8 L' | '2×8 L' | '1×10 L' | '2×10 L';
  guestCount?: number;
  /** Gratis-Sirup Kirsche in Litern (Standard: keiner). */
  freeSyrupLiters?: number;
  /** Maschinenanzahl > 1 über den Angebots-Entwurf (Staff-API, gleiche Session). */
  machineQuantity?: number;
  /** Auftragsbestätigung freigeben + versenden (Phase 3). */
  confirmOrder?: boolean;
}

/**
 * Kunde + Vorgang + Anfrage + Angebot + Online-Annahme (+ optional AB-
 * Freigabe/-Versand) – ausschließlich über echte Wege der Staff-/Web-App.
 * Gemeinsamer Seed-Baustein der Specs (Phase-6-Finalisierung A3): jede
 * Spec legt ihre bestätigten Buchungen SELBST an.
 */
export async function acceptedBooking(
  staff: Page,
  customerPage: Page,
  options: AcceptedBookingOptions,
): Promise<{ processId: string; processNumber: string }> {
  await staff.goto('/kunden');
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await staff.getByLabel('Vorname').fill(options.firstName);
  await staff.getByLabel('Nachname').fill(options.lastName);
  await staff.getByLabel('E-Mail (optional)').fill(options.email);
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(
    staff.getByRole('heading', { name: `${options.firstName} ${options.lastName}` }),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Vorgang anlegen' }).click();
  const numberHeading = staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ });
  await expect(numberHeading).toBeVisible();
  const processNumber = (await numberHeading.innerText()).trim();
  const processId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;

  await staff.goto(`/vorgaenge/${processId}/anfrage`);
  const eventDate = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  await staff.getByLabel('Eventdatum').fill(eventDate);
  await staff.getByLabel('Gästezahl (exakt)').fill(String(options.guestCount ?? 30));
  await staff.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await staff.getByLabel('Gewünschter Maschinentyp').selectOption({ label: options.machineLabel });
  if (options.freeSyrupLiters !== undefined && options.freeSyrupLiters > 0) {
    await staff.getByLabel('Sirup Kirsche – gratis (L)').fill(String(options.freeSyrupLiters));
  }
  await staff.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(staff.getByText('Anfrage gespeichert.')).toBeVisible();

  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await staff.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  if (options.machineQuantity !== undefined) {
    const offer = (await (
      await staff.request.get(`/api/staff/processes/${processId}/offer`)
    ).json()) as {
      offer: { versions: { id: string; status: string }[] } | null;
    };
    const draft = offer.offer?.versions.find((version) => version.status === 'draft');
    expect(draft).toBeDefined();
    const patched = await staff.request.patch(`/api/staff/offer-versions/${draft!.id}`, {
      data: { machineQuantity: options.machineQuantity },
    });
    expect(patched.ok()).toBe(true);
    await staff.reload();
    await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  }
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = staff.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  const path = (await link.innerText()).trim();

  await customerPage.goto(`${WEB_ORIGIN}${path}`);
  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();

  if (options.confirmOrder === true) {
    await staff.goto(`/vorgaenge/${processId}/angebot`);
    await expect(staff.getByRole('heading', { name: 'Auftragsbestätigung' })).toBeVisible();
    await staff.getByRole('button', { name: 'Auftragsbestätigung freigeben' }).click();
    await expect(staff.getByText('Freigegeben')).toBeVisible();
    await staff.getByRole('button', { name: 'Auftragsbestätigung versenden' }).click();
    await expect(staff.getByText('Versendet', { exact: true })).toBeVisible();
  }
  return { processId, processNumber };
}
