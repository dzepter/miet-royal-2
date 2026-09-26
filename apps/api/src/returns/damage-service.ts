import { createHash, randomBytes } from 'node:crypto';
import {
  damageMarkers,
  damagePhotos,
  machineAssignments,
  machineDamages,
  machines,
  rentalReturns,
  returnMachines,
  staffUsers,
  technicalDefects,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type MachineDamage,
  products,
  processes,
} from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { visibleProcessesWhere, type ProcessVisibilityContext } from '../crm/visibility.ts';
import type {
  ExistingDamageProvider,
  ExistingDamageSnapshot,
} from '../handover/handover-service.ts';
import {
  embeddablePhotoLooksValid,
  imageExtension,
  imageMagicMatches,
  type ImageMimeType,
} from '../handover/media.ts';

/**
 * Zentrale Schadensdokumentation (Phase-7-Order §§26–40): Schäden sind
 * DOKUMENTATION – kein Geldbetrag, keine Kostenbewertung (Phase 9). Ein
 * Schaden braucht Schweregrad, Pflichtbeschreibung, ≥ 1 Markierung am
 * Maschinenschema (normalisiert 0..1) und ≥ 1 Foto (Foto/Marker werden bei
 * der Rückgabe-Finalisierung bzw. bei nachträglicher Feststellung sofort
 * verlangt). Nach der Finalisierung werden Rückgabeschäden zu „aktuellen
 * Schäden“ der Maschine; „nicht mehr aktuell“ blendet sie aus, löscht nie.
 */

export const SEVERITY_LABELS: Record<MachineDamage['severity'], string> = {
  light: 'leicht',
  medium: 'mittel',
  severe: 'schwer',
};

export const VIEW_LABELS: Record<'front' | 'back' | 'left' | 'right', string> = {
  front: 'Vorne',
  back: 'Hinten',
  left: 'Links',
  right: 'Rechts',
};

const PHOTO_MAX_BYTES = 6 * 1024 * 1024;

export interface DamageMarkerInput {
  view: 'front' | 'back' | 'left' | 'right';
  markerType: 'point' | 'area';
  x: number;
  y: number;
  width?: number | null | undefined;
  height?: number | null | undefined;
}

export interface DamageMarkerView {
  id: string;
  view: DamageMarkerInput['view'];
  viewLabel: string;
  markerType: DamageMarkerInput['markerType'];
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export interface DamageView {
  id: string;
  machineId: string;
  machineCode: string;
  /** Maschinentyp für die Asset-Schnittstelle des Schadensschemas (Order §30). */
  productSlug: string;
  returnId: string | null;
  returnMachineId: string | null;
  origin: MachineDamage['origin'];
  severity: MachineDamage['severity'];
  severityLabel: string;
  description: string;
  requiresFinancialReview: boolean;
  createdAt: string;
  createdByName: string | null;
  activatedAt: string | null;
  resolvedAt: string | null;
  current: boolean;
  markers: DamageMarkerView[];
  photos: { id: string; takenAt: string }[];
}

export interface TechnicalDefectView {
  id: string;
  machineId: string;
  returnId: string;
  processId: string;
  description: string;
  occurredAt: string;
  hasPhoto: boolean;
  requiresFinancialReview: boolean;
  createdByName: string | null;
  createdAt: string;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Markierungen serverseitig validieren (Order §§28/29/60): Ansicht, Typ, 0..1, Fläche innerhalb. */
export function validateMarkers(markers: readonly DamageMarkerInput[]): void {
  if (markers.length === 0) {
    throw new AuthError(
      'VALIDATION',
      'Bitte mindestens eine Markierung am Maschinenschema setzen.',
    );
  }
  for (const marker of markers) {
    if (!(marker.view in VIEW_LABELS)) {
      throw new AuthError('VALIDATION', 'Ungültige Ansicht für die Schadensmarkierung.');
    }
    if (!isUnitInterval(marker.x) || !isUnitInterval(marker.y)) {
      throw new AuthError(
        'VALIDATION',
        'Die Markierungskoordinaten müssen normalisiert im Bereich 0..1 liegen.',
      );
    }
    if (marker.markerType === 'area') {
      const width = marker.width ?? null;
      const height = marker.height ?? null;
      if (
        width === null ||
        height === null ||
        !isUnitInterval(width) ||
        !isUnitInterval(height) ||
        width <= 0 ||
        height <= 0 ||
        marker.x + width > 1 + 1e-9 ||
        marker.y + height > 1 + 1e-9
      ) {
        throw new AuthError(
          'VALIDATION',
          'Eine Flächenmarkierung braucht Breite und Höhe (0..1) und muss innerhalb des Schemas liegen.',
        );
      }
    } else if (marker.markerType !== 'point') {
      throw new AuthError('VALIDATION', 'Ungültiger Markierungstyp.');
    }
  }
}

/**
 * Reinigungsphase nach Rückgabe (Order §§37/38): Status Reinigung UND ein von
 * der Rückgabe-Finalisierung gesetzter Reinigungsbeginn. Nach „Gereinigt &
 * einsatzbereit“ (cleaning_since = null) oder einem anderen manuellen
 * Statuswechsel ist das Fenster geschlossen – auch wenn die Maschine später
 * manuell wieder auf „Reinigung“ gesetzt wird.
 */
export function postReturnWindowOpen(machine: {
  status: string;
  cleaningSince: Date | null;
}): boolean {
  return machine.status === 'cleaning' && machine.cleaningSince !== null;
}

export class DamageService implements ExistingDamageProvider {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
  ) {}

  // ── Anlegen (innerhalb einer Rückgabe-Transaktion oder als Nachtrag) ───

  /**
   * Schaden innerhalb einer fremden Transaktion anlegen (Rückgabe-Entwurf
   * unter Rückgabesperre). Fotos folgen als eigene Uploads; die
   * Finalisierung verlangt ≥ 1 Foto je Schaden.
   */
  async insertWithin(
    tx: DatabaseTransaction,
    input: {
      actorId: string;
      machineId: string;
      returnId: string;
      returnMachineId: string;
      severity: MachineDamage['severity'];
      description: string;
      markers: readonly DamageMarkerInput[];
      origin: MachineDamage['origin'];
      activatedAt: Date | null;
      now: Date;
    },
  ): Promise<string> {
    const description = input.description.trim();
    if (description === '') {
      throw new AuthError('VALIDATION', 'Für einen Schaden ist eine Beschreibung Pflicht.');
    }
    if (!(input.severity in SEVERITY_LABELS)) {
      throw new AuthError('VALIDATION', 'Schweregrad muss leicht, mittel oder schwer sein.');
    }
    validateMarkers(input.markers);
    const inserted = await tx
      .insert(machineDamages)
      .values({
        machineId: input.machineId,
        returnId: input.returnId,
        returnMachineId: input.returnMachineId,
        origin: input.origin,
        severity: input.severity,
        description,
        requiresFinancialReview: true,
        createdBy: input.actorId,
        createdAt: input.now,
        activatedAt: input.activatedAt,
      })
      .returning({ id: machineDamages.id });
    const damageId = inserted[0]!.id;
    for (const marker of input.markers) {
      await tx.insert(damageMarkers).values({
        damageId,
        view: marker.view,
        markerType: marker.markerType,
        x: marker.x,
        y: marker.y,
        width: marker.markerType === 'area' ? (marker.width ?? null) : null,
        height: marker.markerType === 'area' ? (marker.height ?? null) : null,
        createdAt: input.now,
      });
    }
    return damageId;
  }

  async byId(damageId: string, executor: DatabaseExecutor = this.db): Promise<MachineDamage> {
    const rows = await executor
      .select()
      .from(machineDamages)
      .where(eq(machineDamages.id, damageId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Schaden nicht gefunden.');
    return row;
  }

  /**
   * Foto zu einem Schaden: nur solange der Schaden noch bearbeitbar ist –
   * Rückgabeschaden im Entwurf ODER nachträgliche Feststellung, solange die
   * Maschine noch in Reinigung ist. Fotos sind JPEG/PNG (sie erscheinen im
   * Rückgabeprotokoll), privat, integritätsgesichert, ohne Kundendaten im
   * Schlüssel (Order §31).
   */
  async addPhoto(
    actorId: string,
    damageId: string,
    input: { bytes: Uint8Array; mimeType: ImageMimeType },
    now = new Date(),
  ): Promise<{ photoId: string }> {
    const damage = await this.byId(damageId);
    this.assertEmbeddablePhoto(input.bytes, input.mimeType);
    const key = `damages/${damage.id}/${randomBytes(8).toString('hex')}.${imageExtension(input.mimeType)}`;
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    await this.storage.put(key, input.bytes, { contentType: input.mimeType });
    try {
      return await this.db.transaction(async (tx) => {
        // Sperrreihenfolge wie Entwurfs-Mutationen/Finalisierung bzw. Nachtrag/
        // Reinigungsabschluss: erst die führende Zeile (Rückgabe bzw. Maschine),
        // dann der Schaden – ein Foto kann so nicht mehr NACH dem Fingerprint-
        // Recheck der Finalisierung (bzw. nach „Gereinigt“) hinzukommen.
        if (damage.origin === 'return') {
          await tx
            .select({ id: rentalReturns.id })
            .from(rentalReturns)
            .where(eq(rentalReturns.id, damage.returnId ?? ''))
            .for('no key update');
        } else {
          await tx
            .select({ id: machines.id })
            .from(machines)
            .where(eq(machines.id, damage.machineId))
            .for('no key update');
        }
        const locked = await this.lockDamage(tx, damageId);
        await this.assertEditable(tx, locked);
        const inserted = await tx
          .insert(damagePhotos)
          .values({
            damageId: locked.id,
            machineId: locked.machineId,
            storageKey: key,
            mimeType: input.mimeType,
            byteSize: input.bytes.length,
            sha256,
            takenBy: actorId,
            takenAt: now,
          })
          .returning({ id: damagePhotos.id });
        return { photoId: inserted[0]!.id };
      });
    } catch (error) {
      await this.deleteKeys([key]);
      throw error;
    }
  }

  /** Schaden (nur im Rückgabe-Entwurf) samt Markierungen/Fotos entfernen. */
  async deleteDraftDamage(
    tx: DatabaseTransaction,
    damageId: string,
    returnId: string,
  ): Promise<string[]> {
    const locked = await this.lockDamage(tx, damageId);
    if (locked.returnId !== returnId || locked.origin !== 'return') {
      throw new AuthError('NOT_FOUND', 'Schaden nicht gefunden.');
    }
    const photos = await tx
      .delete(damagePhotos)
      .where(eq(damagePhotos.damageId, damageId))
      .returning({ storageKey: damagePhotos.storageKey });
    await tx.delete(damageMarkers).where(eq(damageMarkers.damageId, damageId));
    await tx.delete(machineDamages).where(eq(machineDamages.id, damageId));
    return photos.map((row) => row.storageKey);
  }

  // ── Nachträgliche Feststellung (Order §§37/38) ───────────────────────────

  /**
   * Nach der Rückgabe entdeckter äußerer Schaden: nur solange die Maschine
   * noch 🟡 Reinigung hat und ein finalisierter Rückgabevorgang existiert;
   * Beschreibung, Schweregrad, Markierung UND Foto sind in EINEM Schritt
   * Pflicht. Das unterschriebene Rückgabeprotokoll bleibt unverändert – der
   * Schaden ist als `post_return_finding` gekennzeichnet und sofort aktuell.
   */
  async createPostReturnFinding(
    actorId: string,
    machineId: string,
    input: {
      severity: MachineDamage['severity'];
      description: string;
      markers: readonly DamageMarkerInput[];
      photo: { bytes: Uint8Array; mimeType: ImageMimeType };
    },
    now = new Date(),
  ): Promise<{ damageId: string; returnId: string }> {
    if (input.description.trim() === '') {
      throw new AuthError('VALIDATION', 'Für einen Schaden ist eine Beschreibung Pflicht.');
    }
    validateMarkers(input.markers);
    this.assertEmbeddablePhoto(input.photo.bytes, input.photo.mimeType);
    const key = `damages/post-return/${machineId}-${randomBytes(8).toString('hex')}.${imageExtension(input.photo.mimeType)}`;
    const sha256 = createHash('sha256').update(input.photo.bytes).digest('hex');
    await this.storage.put(key, input.photo.bytes, { contentType: input.photo.mimeType });
    try {
      return await this.db.transaction(async (tx) => {
        // Serialisiert mit „Gereinigt & einsatzbereit“ (sperrt dieselbe Zeile).
        const machineRows = await tx
          .select()
          .from(machines)
          .where(eq(machines.id, machineId))
          .for('no key update');
        const machine = machineRows[0];
        if (machine === undefined) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
        const last = await this.lastFinalizedReturnMachine(tx, machineId);
        // Fenster nur in der Reinigungsphase NACH DER RÜCKGABE (cleaning_since wird
        // ausschließlich von der Rückgabe-Finalisierung gesetzt); ein später manuell
        // gesetzter Status „Reinigung“ öffnet es nicht erneut (Order §§37/38).
        if (
          !postReturnWindowOpen(machine) ||
          last === null ||
          !(await this.notReissuedSince(tx, machineId, last.finalizedAt))
        ) {
          throw new AuthError(
            'CONFLICT',
            'Die Maschine ist nicht mehr in Reinigung – ein nachträglicher Kundenschaden zum letzten Rückgabevorgang ist nicht mehr möglich.',
          );
        }
        const damageId = await this.insertWithin(tx, {
          actorId,
          machineId,
          returnId: last.returnId,
          returnMachineId: last.id,
          severity: input.severity,
          description: input.description,
          markers: input.markers,
          origin: 'post_return_finding',
          activatedAt: now,
          now,
        });
        await tx.insert(damagePhotos).values({
          damageId,
          machineId,
          storageKey: key,
          mimeType: input.photo.mimeType,
          byteSize: input.photo.bytes.length,
          sha256,
          takenBy: actorId,
          takenAt: now,
        });
        return { damageId, returnId: last.returnId };
      });
    } catch (error) {
      await this.deleteKeys([key]);
      throw error;
    }
  }

  /**
   * Zielvorgang eines Nachtrags/Defekts (letzter finalisierter Return der
   * Maschine) – für die Sichtbarkeitsprüfung der Routen VOR dem Schreiben.
   */
  async postReturnTarget(
    machineId: string,
  ): Promise<{ returnId: string; processId: string } | null> {
    const rows = await this.db
      .select({ returnId: rentalReturns.id, processId: rentalReturns.processId })
      .from(returnMachines)
      .innerJoin(rentalReturns, eq(rentalReturns.id, returnMachines.returnId))
      .where(and(eq(returnMachines.machineId, machineId), eq(rentalReturns.status, 'finalized')))
      .orderBy(desc(rentalReturns.finalizedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Letzter finalisierter Rückgabeabschnitt dieser Maschine (null = nie zurückgegeben). */
  private async lastFinalizedReturnMachine(executor: DatabaseExecutor, machineId: string) {
    const rows = await executor
      .select({ rm: returnMachines, finalizedAt: rentalReturns.finalizedAt })
      .from(returnMachines)
      .innerJoin(rentalReturns, eq(rentalReturns.id, returnMachines.returnId))
      .where(and(eq(returnMachines.machineId, machineId), eq(rentalReturns.status, 'finalized')))
      .orderBy(desc(rentalReturns.finalizedAt))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.finalizedAt === null) return null;
    return { ...row.rm, finalizedAt: row.finalizedAt };
  }

  // ── Aktuelle Schäden / Auflösen (Order §§33/34/61) ───────────────────────

  async currentForMachine(
    machineId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<DamageView[]> {
    return this.views(
      and(
        eq(machineDamages.machineId, machineId),
        isNotNull(machineDamages.activatedAt),
        isNull(machineDamages.resolvedAt),
      ),
      executor,
    );
  }

  async forReturn(returnId: string, executor: DatabaseExecutor = this.db): Promise<DamageView[]> {
    return this.views(eq(machineDamages.returnId, returnId), executor);
  }

  /**
   * Phase-6-Schnittstelle: aktuelle Schäden als eingefrorener Snapshot für
   * das Übergabeprotokoll (Schema + Text, keine Fotos; Order §35).
   */
  async existingDamagesFor(
    machineId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<ExistingDamageSnapshot[]> {
    const current = await this.currentForMachine(machineId, executor);
    return current.map((damage) => ({
      id: damage.id,
      productSlug: damage.productSlug,
      severity: damage.severity,
      severityLabel: damage.severityLabel,
      description: damage.description,
      createdAt: damage.createdAt,
      markers: damage.markers.map((marker) => ({
        view: marker.view,
        markerType: marker.markerType,
        x: marker.x,
        y: marker.y,
        width: marker.width,
        height: marker.height,
      })),
      summary: `${damage.severityLabel}: ${damage.description} (${damage.markers
        .map(
          (marker) => `${marker.viewLabel} ${marker.markerType === 'area' ? 'Bereich' : 'Punkt'}`,
        )
        .join(', ')})`,
    }));
  }

  /** „Nicht mehr aktuell“ – nur für aktuelle Schäden; historische Daten bleiben. */
  async resolveCurrent(actorId: string, damageId: string, now = new Date()): Promise<void> {
    const updated = await this.db
      .update(machineDamages)
      .set({ resolvedAt: now, resolvedBy: actorId })
      .where(
        and(
          eq(machineDamages.id, damageId),
          isNotNull(machineDamages.activatedAt),
          isNull(machineDamages.resolvedAt),
        ),
      )
      .returning({ id: machineDamages.id });
    if (updated.length === 0) {
      await this.byId(damageId);
      throw new AuthError('CONFLICT', 'Dieser Schaden ist kein aktueller Schaden mehr.');
    }
  }

  // ── Fotos ────────────────────────────────────────────────────────────────

  async photoMeta(
    photoId: string,
  ): Promise<{ machineId: string; returnId: string | null; mimeType: string }> {
    const rows = await this.db
      .select({
        machineId: damagePhotos.machineId,
        returnId: machineDamages.returnId,
        mimeType: damagePhotos.mimeType,
      })
      .from(damagePhotos)
      .innerJoin(machineDamages, eq(machineDamages.id, damagePhotos.damageId))
      .where(eq(damagePhotos.id, photoId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    return row;
  }

  async photoBytes(photoId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const rows = await this.db.select().from(damagePhotos).where(eq(damagePhotos.id, photoId));
    const photo = rows[0];
    if (photo === undefined) throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    const bytes = await this.storage.get(photo.storageKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== photo.sha256) {
      throw new AuthError('CONFLICT', 'Foto-Integritätsprüfung fehlgeschlagen.');
    }
    return { bytes, mimeType: photo.mimeType };
  }

  /** Fotobytes aller Fotos eines Schadens (für das Rückgabeprotokoll). */
  async photosBytesFor(damageId: string): Promise<Uint8Array[]> {
    const rows = await this.db
      .select()
      .from(damagePhotos)
      .where(eq(damagePhotos.damageId, damageId))
      .orderBy(asc(damagePhotos.takenAt));
    const result: Uint8Array[] = [];
    for (const row of rows) {
      const bytes = await this.storage.get(row.storageKey);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== row.sha256) {
        throw new AuthError('CONFLICT', 'Foto-Integritätsprüfung fehlgeschlagen.');
      }
      result.push(bytes);
    }
    return result;
  }

  // ── Technische Defekte (Order §§39/40) ───────────────────────────────────

  /**
   * Interner technischer Defekt: mit dem letzten finalisierten Rückgabe-
   * vorgang der Maschine verknüpft, solange sie seitdem nicht erneut
   * ausgegeben wurde. Keine Kundenbelastung, kein Betrag.
   */
  async addTechnicalDefect(
    actorId: string,
    machineId: string,
    input: {
      description: string;
      occurredAt?: Date | null | undefined;
      photo?: { bytes: Uint8Array; mimeType: ImageMimeType } | null | undefined;
    },
    now = new Date(),
  ): Promise<{ defectId: string; hint: string }> {
    const description = input.description.trim();
    if (description === '') {
      throw new AuthError('VALIDATION', 'Bitte den technischen Defekt beschreiben.');
    }
    let photoKey: string | null = null;
    let photoSha: string | null = null;
    if (input.photo !== null && input.photo !== undefined) {
      if (
        input.photo.bytes.length === 0 ||
        input.photo.bytes.length > PHOTO_MAX_BYTES ||
        !imageMagicMatches(input.photo.bytes, input.photo.mimeType)
      ) {
        throw new AuthError(
          'VALIDATION',
          'Das Foto muss ein JPEG-, PNG- oder WebP-Bild (max. 6 MB) sein und zum Bildtyp passen.',
        );
      }
      photoKey = `technical-defects/${machineId}-${randomBytes(8).toString('hex')}.${imageExtension(input.photo.mimeType)}`;
      photoSha = createHash('sha256').update(input.photo.bytes).digest('hex');
      await this.storage.put(photoKey, input.photo.bytes, { contentType: input.photo.mimeType });
    }
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'machine-assign:' + machineId}))`,
        );
        const machineRows = await tx
          .select({ id: machines.id })
          .from(machines)
          .where(eq(machines.id, machineId));
        if (machineRows.length === 0) throw new AuthError('NOT_FOUND', 'Maschine nicht gefunden.');
        const last = await this.lastFinalizedReturnMachine(tx, machineId);
        if (last === null || !(await this.notReissuedSince(tx, machineId, last.finalizedAt))) {
          throw new AuthError(
            'CONFLICT',
            'Kein Rückgabevorgang, dem der Defekt zugeordnet werden kann: Die Maschine wurde seit der letzten Rückgabe erneut ausgegeben oder noch nie zurückgegeben.',
          );
        }
        const returnRows = await tx
          .select({ processId: rentalReturns.processId })
          .from(rentalReturns)
          .where(eq(rentalReturns.id, last.returnId));
        const inserted = await tx
          .insert(technicalDefects)
          .values({
            machineId,
            returnId: last.returnId,
            processId: returnRows[0]!.processId,
            description,
            occurredAt: input.occurredAt ?? now,
            photoStorageKey: photoKey,
            photoMimeType: input.photo?.mimeType ?? null,
            photoByteSize: input.photo?.bytes.length ?? null,
            photoSha256: photoSha,
            requiresFinancialReview: false,
            createdBy: actorId,
            createdAt: now,
          })
          .returning({ id: technicalDefects.id });
        return {
          defectId: inserted[0]!.id,
          hint: 'Maschine ggf. in Reparatur setzen (Status „Reparatur“ über die Maschinenansicht).',
        };
      });
    } catch (error) {
      if (photoKey !== null) await this.deleteKeys([photoKey]);
      throw error;
    }
  }

  /** Seit der Rückgabe keine erneute Ausgabe (Order §40)? */
  private async notReissuedSince(
    executor: DatabaseExecutor,
    machineId: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await executor
      .select({ id: machineAssignments.id })
      .from(machineAssignments)
      .where(
        and(
          eq(machineAssignments.machineId, machineId),
          or(
            eq(machineAssignments.status, 'issued'),
            and(isNotNull(machineAssignments.issuedAt), gt(machineAssignments.issuedAt, since)),
          ),
        ),
      )
      .limit(1);
    return rows.length === 0;
  }

  /** Technische Defekte (intern, mit Vorgangsbezug) – Vorgänge nur innerhalb der Sichtbarkeitsregel. */
  async technicalDefectsFor(
    machineId: string,
    visibility?: ProcessVisibilityContext | null,
  ): Promise<TechnicalDefectView[]> {
    if (visibility === null) return [];
    const rows = await this.db
      .select({
        defect: technicalDefects,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(technicalDefects)
      .innerJoin(processes, eq(processes.id, technicalDefects.processId))
      .leftJoin(staffUsers, eq(staffUsers.id, technicalDefects.createdBy))
      .where(
        and(
          eq(technicalDefects.machineId, machineId),
          visibility === undefined ? undefined : visibleProcessesWhere(visibility),
        ),
      )
      .orderBy(desc(technicalDefects.createdAt))
      .limit(20);
    return rows.map(({ defect, firstName, lastName }) => ({
      id: defect.id,
      machineId: defect.machineId,
      returnId: defect.returnId,
      processId: defect.processId,
      description: defect.description,
      occurredAt: defect.occurredAt.toISOString(),
      hasPhoto: defect.photoStorageKey !== null,
      requiresFinancialReview: defect.requiresFinancialReview,
      createdByName: firstName === null ? null : `${firstName} ${lastName ?? ''}`.trim(),
      createdAt: defect.createdAt.toISOString(),
    }));
  }

  /** Ist das Defekt-Fenster für diese Maschine offen (letzte Rückgabe, nicht erneut ausgegeben)? */
  async defectLinkOpen(machineId: string): Promise<boolean> {
    const last = await this.lastFinalizedReturnMachine(this.db, machineId);
    if (last === null) return false;
    return this.notReissuedSince(this.db, machineId, last.finalizedAt);
  }

  async technicalDefectPhoto(defectId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const rows = await this.db
      .select()
      .from(technicalDefects)
      .where(eq(technicalDefects.id, defectId));
    const defect = rows[0];
    if (
      defect === undefined ||
      defect.photoStorageKey === null ||
      defect.photoMimeType === null ||
      defect.photoSha256 === null
    ) {
      throw new AuthError('NOT_FOUND', 'Foto nicht gefunden.');
    }
    const bytes = await this.storage.get(defect.photoStorageKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== defect.photoSha256) {
      throw new AuthError('CONFLICT', 'Foto-Integritätsprüfung fehlgeschlagen.');
    }
    return { bytes, mimeType: defect.photoMimeType };
  }

  // ── intern ───────────────────────────────────────────────────────────────

  private assertEmbeddablePhoto(bytes: Uint8Array, mimeType: string): void {
    if (!embeddablePhotoLooksValid(bytes, mimeType, PHOTO_MAX_BYTES)) {
      throw new AuthError(
        'VALIDATION',
        'Das Foto muss ein darstellbares JPEG- oder PNG-Bild (max. 6 MB) sein und zum angegebenen Bildtyp passen.',
      );
    }
  }

  private async lockDamage(tx: DatabaseTransaction, damageId: string): Promise<MachineDamage> {
    const rows = await tx
      .select()
      .from(machineDamages)
      .where(eq(machineDamages.id, damageId))
      .for('no key update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Schaden nicht gefunden.');
    return row;
  }

  /** Bearbeitbar: Rückgabeschaden im Entwurf ODER Nachtrag, solange Maschine in Reinigung. */
  private async assertEditable(tx: DatabaseTransaction, damage: MachineDamage): Promise<void> {
    if (damage.origin === 'return') {
      const rows = await tx
        .select({ status: rentalReturns.status })
        .from(rentalReturns)
        .where(eq(rentalReturns.id, damage.returnId ?? ''));
      if (rows[0]?.status !== 'draft') {
        throw new AuthError(
          'CONFLICT',
          'Die Rückgabe ist bereits abgeschlossen – dieser Schaden ist unveränderlich.',
        );
      }
      return;
    }
    const rows = await tx
      .select({ status: machines.status, cleaningSince: machines.cleaningSince })
      .from(machines)
      .where(eq(machines.id, damage.machineId));
    const machine = rows[0];
    if (machine === undefined || !postReturnWindowOpen(machine)) {
      throw new AuthError(
        'CONFLICT',
        'Die Maschine ist nicht mehr in Reinigung – der Nachtrag ist abgeschlossen.',
      );
    }
  }

  private async views(where: ReturnType<typeof eq> | undefined, executor: DatabaseExecutor) {
    const rows = await executor
      .select({
        damage: machineDamages,
        machineCode: machines.machineCode,
        productSlug: products.slug,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(machineDamages)
      .innerJoin(machines, eq(machines.id, machineDamages.machineId))
      .innerJoin(products, eq(products.id, machines.productId))
      .leftJoin(staffUsers, eq(staffUsers.id, machineDamages.createdBy))
      .where(where)
      .orderBy(asc(machineDamages.createdAt));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.damage.id);
    const markerRows = await executor
      .select()
      .from(damageMarkers)
      .where(inArray(damageMarkers.damageId, ids))
      .orderBy(asc(damageMarkers.createdAt));
    const photoRows = await executor
      .select({
        id: damagePhotos.id,
        damageId: damagePhotos.damageId,
        takenAt: damagePhotos.takenAt,
      })
      .from(damagePhotos)
      .where(inArray(damagePhotos.damageId, ids))
      .orderBy(asc(damagePhotos.takenAt));
    return rows.map(({ damage, machineCode, productSlug, firstName, lastName }): DamageView => ({
      id: damage.id,
      machineId: damage.machineId,
      machineCode,
      productSlug,
      returnId: damage.returnId,
      returnMachineId: damage.returnMachineId,
      origin: damage.origin,
      severity: damage.severity,
      severityLabel: SEVERITY_LABELS[damage.severity],
      description: damage.description,
      requiresFinancialReview: damage.requiresFinancialReview,
      createdAt: damage.createdAt.toISOString(),
      createdByName: firstName === null ? null : `${firstName} ${lastName ?? ''}`.trim(),
      activatedAt: damage.activatedAt?.toISOString() ?? null,
      resolvedAt: damage.resolvedAt?.toISOString() ?? null,
      current: damage.activatedAt !== null && damage.resolvedAt === null,
      markers: markerRows
        .filter((marker) => marker.damageId === damage.id)
        .map((marker) => ({
          id: marker.id,
          view: marker.view,
          viewLabel: VIEW_LABELS[marker.view],
          markerType: marker.markerType,
          x: marker.x,
          y: marker.y,
          width: marker.width,
          height: marker.height,
        })),
      photos: photoRows
        .filter((photo) => photo.damageId === damage.id)
        .map((photo) => ({ id: photo.id, takenAt: photo.takenAt.toISOString() })),
    }));
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // best effort – verwaistes Objekt ist unkritisch
      }
    }
  }
}
