import { randomBytes } from 'node:crypto';
import {
  machineBlocks,
  machines,
  products,
  type Database,
  type Machine,
  type MachineBlock,
  type Product,
} from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Zentrale Maschinenverwaltung (Phase-5-Order §§3–13): ID-Vergabe,
 * Statusregeln, Standort, Sperren, QR-Identifier und Referenzfoto.
 * Alle Regeln leben HIER (keine verstreute React-Logik, Order §6).
 */

/** UI-Labels (Order §5) – Status ist nie nur Farbe. */
export const MACHINE_STATUS_LABELS: Record<Machine['status'], string> = {
  ready: 'Einsatzbereit',
  rented: 'Vermietet',
  reserved: 'Reserviert',
  cleaning: 'Reinigung',
  repair: 'Reparatur',
  out_of_service: 'Außer Betrieb',
};

export const MACHINE_LOCATION_LABELS: Record<Machine['locationKind'], string> = {
  warehouse: 'Lager',
  customer: 'Kunde',
  staff: 'Mitarbeiter / unterwegs',
  repair: 'Reparatur',
  other: 'Sonstiger interner Standort',
};

/**
 * Manuell setzbare Status (Order §6): Reserviert/Vermietet entstehen erst
 * durch die Fachprozesse späterer Phasen (Zuweisung/Ausgabe) – sie sind
 * bewusst KEIN manueller Alltagsstatus.
 */
export const MANUAL_MACHINE_STATUSES: readonly Machine['status'][] = [
  'ready',
  'cleaning',
  'repair',
  'out_of_service',
];

/** Status, in denen eine Maschine NICHT regulär einsetzbar ist (Order §17). */
export const NOT_REGULARLY_AVAILABLE_STATUSES: readonly Machine['status'][] = [
  'repair',
  'out_of_service',
  'cleaning',
];

const QR_TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;

/** Wirksame, nicht aufgehobene Sperre im Zeitraum [from, to)? */
export function blockOverlaps(
  block: Pick<MachineBlock, 'startsAt' | 'endsAt' | 'liftedAt'>,
  from: Date,
  to: Date,
): boolean {
  if (block.liftedAt !== null) return false;
  return block.startsAt.getTime() < to.getTime() && block.endsAt.getTime() > from.getTime();
}

export interface MachineWithProduct {
  machine: Machine;
  product: Product;
}

export class MachineService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
  ) {}

  private async machineProduct(productId: string): Promise<Product> {
    const rows = await this.db.select().from(products).where(eq(products.id, productId));
    const product = rows[0];
    if (product === undefined) throw new AuthError('NOT_FOUND', 'Produkt nicht gefunden.');
    if (
      product.category !== 'machine' ||
      product.containerVolumeLiters === null ||
      product.containerCount === null
    ) {
      throw new AuthError(
        'VALIDATION',
        'Physische Maschinen gibt es nur für buchbare Maschinentypen.',
      );
    }
    return product;
  }

  /** Präfix laut ID-Schema (Order §3): MR-[Liter]-[Behälter]. */
  private codePrefix(product: Product): string {
    const volume = product.containerVolumeLiters!;
    const count = product.containerCount!;
    // Das ID-Schema ist zweistellig (MR-XX-YY-…); größere Werte würden den
    // DB-Formatcheck verletzen → verständliche Validierung statt 500.
    if (volume < 1 || volume > 99 || count < 1 || count > 99) {
      throw new AuthError(
        'VALIDATION',
        'Maschinen-IDs unterstützen nur Liter- und Behälterwerte von 1 bis 99.',
      );
    }
    const pad = (value: number) => String(value).padStart(2, '0');
    return `MR-${pad(volume)}-${pad(count)}`;
  }

  /**
   * Neue physische Maschine (Order §3): nächste freie Laufnummer je Typ,
   * serverseitig und race-sicher (Advisory-Lock je Präfix + Unique-Index).
   * Kaufdatum/Gewicht bleiben NULL, wenn unbekannt – nichts erfinden.
   */
  async createMachine(
    input: { productId: string; purchaseDate?: string | null; weightGrams?: number | null },
    now = new Date(),
  ): Promise<Machine> {
    const product = await this.machineProduct(input.productId);
    const prefix = this.codePrefix(product);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'machine-code:' + prefix}))`);
      const rows = await tx
        .select({ code: machines.machineCode })
        .from(machines)
        .where(sql`${machines.machineCode} LIKE ${prefix + '-%'}`);
      // Keine Wiederverwendung: immer max(Laufnummer)+1, auch wenn ältere
      // Nummern (theoretisch) fehlen sollten.
      const maxSeq = rows.reduce((max, row) => {
        const seq = Number(row.code.slice(prefix.length + 1));
        return Number.isFinite(seq) && seq > max ? seq : max;
      }, 0);
      const machineCode = `${prefix}-${String(maxSeq + 1).padStart(2, '0')}`;
      const inserted = await tx
        .insert(machines)
        .values({
          machineCode,
          productId: product.id,
          purchaseDate: input.purchaseDate ?? null,
          weightGrams: input.weightGrams ?? null,
          qrToken: randomBytes(24).toString('hex'),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted[0]!;
    });
  }

  async byId(machineId: string): Promise<MachineWithProduct> {
    const rows = await this.db
      .select({ machine: machines, product: products })
      .from(machines)
      .innerJoin(products, eq(products.id, machines.productId))
      .where(eq(machines.id, machineId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
    return row;
  }

  /**
   * QR-Auflösung (Order §10): opaker Token → Maschine. Ungültige oder
   * unbekannte Tokens werden NEUTRAL abgelehnt (kein Oracle); der Token
   * selbst wird nie geloggt.
   */
  async byQrToken(token: string): Promise<MachineWithProduct | null> {
    if (!QR_TOKEN_PATTERN.test(token)) return null;
    const rows = await this.db
      .select({ machine: machines, product: products })
      .from(machines)
      .innerJoin(products, eq(products.id, machines.productId))
      .where(eq(machines.qrToken, token));
    return rows[0] ?? null;
  }

  async list(): Promise<MachineWithProduct[]> {
    return this.db
      .select({ machine: machines, product: products })
      .from(machines)
      .innerJoin(products, eq(products.id, machines.productId))
      .orderBy(asc(machines.machineCode));
  }

  /** Stammdaten (Order §4): NUR Kaufdatum/Gewicht – die Maschinen-ID und
   *  der Typ sind nach Vergabe unveränderbar (Order §3). */
  async updateMasterData(
    machineId: string,
    input: { purchaseDate?: string | null | undefined; weightGrams?: number | null | undefined },
    now = new Date(),
  ): Promise<Machine> {
    const updated = await this.db
      .update(machines)
      .set({
        ...(input.purchaseDate !== undefined ? { purchaseDate: input.purchaseDate } : {}),
        ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
        updatedAt: now,
      })
      .where(eq(machines.id, machineId))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
    return row;
  }

  /** Zentrale Statusregel (Order §6). */
  async setStatus(
    machineId: string,
    status: Machine['status'],
    now = new Date(),
  ): Promise<Machine> {
    if (!MANUAL_MACHINE_STATUSES.includes(status)) {
      throw new AuthError(
        'VALIDATION',
        '„Reserviert“ und „Vermietet“ werden durch die Fachprozesse späterer Phasen gesetzt und sind kein manueller Status.',
      );
    }
    const updated = await this.db
      .update(machines)
      .set({ status, updatedAt: now })
      .where(eq(machines.id, machineId))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
    return row;
  }

  /** Zentrale Standortlogik (Order §8) – auch spätere Phasen nutzen SIE. */
  async setLocation(
    machineId: string,
    input: { locationKind: Machine['locationKind']; locationNote?: string | null },
    now = new Date(),
  ): Promise<Machine> {
    const note = input.locationNote?.trim() ?? null;
    const updated = await this.db
      .update(machines)
      .set({
        locationKind: input.locationKind,
        locationNote: note === '' ? null : note,
        updatedAt: now,
      })
      .where(eq(machines.id, machineId))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
    return row;
  }

  // ── Sperren (Order §§12/13) ─────────────────────────────────────────────

  async createBlock(
    machineId: string,
    actorId: string,
    input: { startsAt: Date; endsAt: Date; reason: string },
  ): Promise<MachineBlock> {
    await this.byId(machineId);
    const reason = input.reason.trim();
    if (reason === '') {
      throw new AuthError('VALIDATION', 'Für eine Maschinensperre ist ein Grund Pflicht.');
    }
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new AuthError('VALIDATION', 'Das Sperr-Ende muss nach dem Beginn liegen.');
    }
    const inserted = await this.db
      .insert(machineBlocks)
      .values({
        machineId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason,
        createdBy: actorId,
      })
      .returning();
    return inserted[0]!;
  }

  /** Aufheben ohne Pflichtbegründung (Order §13); Datensatz bleibt. */
  async liftBlock(blockId: string, actorId: string, now = new Date()): Promise<void> {
    const updated = await this.db
      .update(machineBlocks)
      .set({ liftedAt: now, liftedBy: actorId })
      .where(
        and(
          eq(machineBlocks.id, blockId),
          isNull(machineBlocks.liftedAt),
          sql`${machineBlocks.endsAt} > ${now}`,
        ),
      )
      .returning({ id: machineBlocks.id });
    if (updated.length === 0) {
      throw new AuthError('CONFLICT', 'Diese Sperre ist bereits aufgehoben oder abgelaufen.');
    }
  }

  /** Aktive/zukünftige (nicht aufgehobene) Sperren einer Maschine. */
  async openBlocks(machineId: string, now = new Date()): Promise<MachineBlock[]> {
    return this.db
      .select()
      .from(machineBlocks)
      .where(
        and(
          eq(machineBlocks.machineId, machineId),
          isNull(machineBlocks.liftedAt),
          sql`${machineBlocks.endsAt} > ${now}`,
        ),
      )
      .orderBy(asc(machineBlocks.startsAt));
  }

  /** Alle offenen Sperren (für Listen/Verfügbarkeit). */
  async allOpenBlocks(now = new Date()): Promise<MachineBlock[]> {
    return this.db
      .select()
      .from(machineBlocks)
      .where(and(isNull(machineBlocks.liftedAt), sql`${machineBlocks.endsAt} > ${now}`))
      .orderBy(asc(machineBlocks.startsAt));
  }

  // ── Referenzfoto (Order §9) ─────────────────────────────────────────────

  /**
   * Ersetzen ohne Foto-Historie: neue Datei speichern, dann die Referenz
   * unter Zeilensperre umsetzen (serialisiert parallele Ersetzungen: der
   * jeweils verdrängte Key wird gezielt gelöscht, es bleibt kein dauerhaft
   * verwaistes Objekt zurück), altes Objekt danach best effort entfernen
   * (privater Storage; Zugriff ausschließlich über die authentifizierte API).
   */
  async replaceReferencePhoto(
    machineId: string,
    input: { bytes: Uint8Array; mimeType: string },
    now = new Date(),
  ): Promise<void> {
    const extension =
      input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
    await this.byId(machineId);
    const key = `machines/${machineId}/reference-${randomBytes(8).toString('hex')}.${extension}`;
    await this.storage.put(key, input.bytes, { contentType: input.mimeType });
    const previousKey = await this.db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({ referencePhotoKey: machines.referencePhotoKey })
        .from(machines)
        .where(eq(machines.id, machineId))
        .for('no key update');
      const locked = lockedRows[0];
      if (locked === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
      await tx
        .update(machines)
        .set({ referencePhotoKey: key, referencePhotoMime: input.mimeType, updatedAt: now })
        .where(eq(machines.id, machineId));
      return locked.referencePhotoKey;
    });
    if (previousKey !== null && previousKey !== key) {
      try {
        await this.storage.delete(previousKey);
      } catch {
        // Best effort – ein verwaistes Objekt ist unkritisch, die Referenz
        // zeigt bereits auf das neue Foto.
      }
    }
  }

  async referencePhotoBytes(
    machineId: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const { machine } = await this.byId(machineId);
    if (machine.referencePhotoKey === null) return null;
    const bytes = await this.storage.get(machine.referencePhotoKey);
    return { bytes, mimeType: machine.referencePhotoMime ?? 'image/jpeg' };
  }
}
