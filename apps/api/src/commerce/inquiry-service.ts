import {
  inquiries,
  inquirySelections,
  processes,
  type Database,
  type DatabaseExecutor,
  type Inquiry,
} from '@mietroyal/database';
import {
  CANISTER_SLUG,
  CANISTERS_PER_CONTAINER_LIMIT,
  canisterLimitFor,
  LARGE_EVENT_GUEST_THRESHOLD,
  LARGE_EVENT_NOTE,
} from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { ProductService } from './product-service.ts';

/**
 * Interne Anfrage (Phase-3-Vorgabe Nr. 10–14): genau eine Anfrage je
 * Vorgang. KEINE Verfügbarkeitsentscheidung, NIEMALS automatische
 * Ablehnung – nur Erfassung. Das Kanisterlimit wird zentral geprüft
 * (Vorgabe Nr. 5), Gästezahlen ab 250 erzeugen nur einen internen Hinweis.
 *
 * Phase 16 (PUBLIC): Validierung + Schreiben liegen in `upsertWithin(executor, …)`,
 * damit die öffentliche Website-Anfrage Kunde → Vorgang → Anfrage → Auswahl in EINER
 * Transaktion anlegt (kein zweiter Pool-Zugriff). Staff-Pfad unverändert:
 * `upsertForProcess` = eigene Transaktion um `upsertWithin`.
 */

export interface InquirySelectionInput {
  productId: string;
  role: 'free' | 'extra';
  quantity: number;
}

export interface InquiryInput {
  eventDate?: string | null | undefined;
  eventStart?: Date | null | undefined;
  eventEnd?: Date | null | undefined;
  guestCount?: number | null | undefined;
  occasion?:
    | 'birthday'
    | 'wedding'
    | 'company_event'
    | 'club'
    | 'party'
    | 'school_kindergarten'
    | 'festival'
    | 'other'
    | null
    | undefined;
  machineProductId?: string | null | undefined;
  fulfillment?: 'pickup' | 'delivery' | undefined;
  deliveryStreet?: string | null | undefined;
  deliveryPostalCode?: string | null | undefined;
  deliveryCity?: string | null | undefined;
  deliveryWindowFrom?: Date | null | undefined;
  deliveryWindowTo?: Date | null | undefined;
  collectionWindowFrom?: Date | null | undefined;
  collectionWindowTo?: Date | null | undefined;
  onsiteContactName?: string | null | undefined;
  onsiteContactPhone?: string | null | undefined;
  selections?: readonly InquirySelectionInput[] | undefined;
}

export class InquiryService {
  private readonly productService: ProductService;

  constructor(private readonly db: Database) {
    this.productService = new ProductService(db);
  }

  async getForProcess(processId: string) {
    const rows = await this.db.select().from(inquiries).where(eq(inquiries.processId, processId));
    const inquiry = rows[0];
    if (inquiry === undefined) return null;
    const selections = await this.db
      .select()
      .from(inquirySelections)
      .where(eq(inquirySelections.inquiryId, inquiry.id));
    return { inquiry, selections, notes: this.notesFor(inquiry) };
  }

  /** Interner Hinweis – lehnt NIEMALS ab (Vorgabe Nr. 11/12). */
  private notesFor(inquiry: Inquiry): string[] {
    const notes: string[] = [];
    if (inquiry.guestCount !== null && inquiry.guestCount >= LARGE_EVENT_GUEST_THRESHOLD) {
      notes.push(LARGE_EVENT_NOTE);
    }
    return notes;
  }

  async upsertForProcess(actorId: string, processId: string, input: InquiryInput) {
    return this.db.transaction((tx) => this.upsertWithin(tx, actorId, processId, input));
  }

  /**
   * Phase 16 (PUBLIC): Anlegen/Ändern innerhalb einer laufenden Transaktion – alle
   * Lese- und Schreibzugriffe über `executor`. `actorId = null` ⇒ system-/kundenseitige
   * Erzeugung (Website-Anfrage, `created_by` NULL). Dieselbe Validierung wie im Staff-Pfad.
   */
  async upsertWithin(
    executor: DatabaseExecutor,
    actorId: string | null,
    processId: string,
    input: InquiryInput,
  ): Promise<string> {
    const processRows = await executor
      .select({ id: processes.id, mainStatus: processes.mainStatus })
      .from(processes)
      .where(eq(processes.id, processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    if (process.mainStatus === 'completed' || process.mainStatus === 'cancelled') {
      throw new AuthError('CONFLICT', 'Der Vorgang ist für die Bearbeitung gesperrt.');
    }

    if (input.guestCount !== null && input.guestCount !== undefined) {
      if (!Number.isInteger(input.guestCount) || input.guestCount <= 0) {
        throw new AuthError('VALIDATION', 'Die Gästezahl muss eine positive ganze Zahl sein.');
      }
    }

    // Maschinentyp: nur aktive Maschinenprodukte für NEUE Auswahl.
    let machineContainers = 0;
    if (input.machineProductId !== null && input.machineProductId !== undefined) {
      const machine = await this.productService.getProduct(input.machineProductId, executor);
      if (machine.category !== 'machine') {
        throw new AuthError('VALIDATION', 'Das gewählte Produkt ist kein Maschinentyp.');
      }
      if (!machine.active) {
        throw new AuthError('VALIDATION', 'Dieser Maschinentyp ist deaktiviert und nicht wählbar.');
      }
      machineContainers = machine.containerCount ?? 0;
    }

    // Auswahl prüfen (aktive Produkte, Kanisterlimit, Gratis-Kontingent).
    const selections = input.selections ?? [];
    let canisterCount = 0;
    let freeLiters = 0;
    for (const selection of selections) {
      if (!Number.isInteger(selection.quantity) || selection.quantity <= 0) {
        throw new AuthError('VALIDATION', 'Mengen müssen positive ganze Zahlen sein.');
      }
      const product = await this.productService.getProduct(selection.productId, executor);
      if (!product.active) {
        throw new AuthError('VALIDATION', `„${product.name}“ ist deaktiviert und nicht wählbar.`);
      }
      if (selection.role === 'free') {
        if (product.category !== 'syrup') {
          throw new AuthError('VALIDATION', 'Nur Sirup kann Teil des Gratis-Kontingents sein.');
        }
        freeLiters += selection.quantity;
      }
      if (product.slug === CANISTER_SLUG) canisterCount += selection.quantity;
      if (product.category === 'machine') {
        throw new AuthError('VALIDATION', 'Maschinen werden über den Maschinentyp gewählt.');
      }
    }
    if (freeLiters > machineContainers) {
      throw new AuthError(
        'VALIDATION',
        machineContainers === 0
          ? 'Gratis-Sirup erfordert einen gewählten Maschinentyp.'
          : `Das Gratis-Sirup-Kontingent beträgt ${machineContainers} L (1 L je Behälter).`,
      );
    }
    const canisterLimit = canisterLimitFor(machineContainers);
    if (canisterCount > 0 && machineContainers === 0) {
      throw new AuthError('VALIDATION', 'Mischkanister erfordern einen gewählten Maschinentyp.');
    }
    if (canisterCount > canisterLimit) {
      throw new AuthError(
        'VALIDATION',
        `Maximal ${canisterLimit} Mischkanister möglich (${CANISTERS_PER_CONTAINER_LIMIT} je gebuchtem Behälter).`,
      );
    }

    const values = {
      eventDate: input.eventDate ?? null,
      eventStart: input.eventStart ?? null,
      eventEnd: input.eventEnd ?? null,
      guestCount: input.guestCount ?? null,
      occasion: input.occasion ?? null,
      machineProductId: input.machineProductId ?? null,
      fulfillment: input.fulfillment ?? ('pickup' as const),
      deliveryStreet: input.deliveryStreet ?? null,
      deliveryPostalCode: input.deliveryPostalCode ?? null,
      deliveryCity: input.deliveryCity ?? null,
      deliveryWindowFrom: input.deliveryWindowFrom ?? null,
      deliveryWindowTo: input.deliveryWindowTo ?? null,
      collectionWindowFrom: input.collectionWindowFrom ?? null,
      collectionWindowTo: input.collectionWindowTo ?? null,
      onsiteContactName: input.onsiteContactName ?? null,
      onsiteContactPhone: input.onsiteContactPhone ?? null,
    };

    const existing = await executor
      .select({ id: inquiries.id })
      .from(inquiries)
      .where(eq(inquiries.processId, processId));
    let inquiryId = existing[0]?.id;
    if (inquiryId === undefined) {
      const inserted = await executor
        .insert(inquiries)
        .values({ ...values, processId, createdBy: actorId })
        .returning({ id: inquiries.id });
      inquiryId = inserted[0]?.id;
      if (inquiryId === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
    } else {
      await executor
        .update(inquiries)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(inquiries.id, inquiryId));
      await executor.delete(inquirySelections).where(eq(inquirySelections.inquiryId, inquiryId));
    }
    for (const selection of selections) {
      await executor.insert(inquirySelections).values({
        inquiryId,
        productId: selection.productId,
        role: selection.role,
        quantity: selection.quantity,
      });
    }
    return inquiryId;
  }
}
