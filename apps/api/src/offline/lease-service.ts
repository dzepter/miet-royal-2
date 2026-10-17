import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import { offlineAccessLeases, type Database, type OfflineAccessLease } from '@mietroyal/database';
import type { LeaseGrant, OfflineEnvironment } from '@mietroyal/offline/shared';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { recordSecurityEvent, type SecurityEventInput } from '../auth/audit.ts';
import { decryptSecret, encryptSecret } from '../auth/crypto.ts';
import type { AuthenticatedContext } from '../auth/service.ts';

/**
 * Serverseitige Offline-Lease (Phase-8-Order §8): ein aktives Lease je
 * Benutzer × Gerät × Umgebung, maximal 72 h, Secret nur verschlüsselt
 * gespeichert. Das Lease-Secret ist Wrap B des lokalen Datenschlüssels –
 * es verlässt den Server nur über eine authentifizierte, entsperrte
 * Session. Widerruf/Deaktivierung greift beim nächsten Onlinekontakt
 * (kein Secret, kein Paket, kein Sync); lokale Daten werden dabei nicht
 * heimlich vernichtet (§39).
 */

export const OFFLINE_LEASE_MS = 72 * 3_600_000;

/** Ein Lease erhalten nur Konten mit operativen Rechten (Order §8). */
export const OFFLINE_ENABLING_PERMISSIONS: readonly PermissionKey[] = [
  'handover.view',
  'return.view',
  'machine.view',
];

/**
 * Rechte-Snapshot im Paket/Lease – ausschließlich operative Keys. Steuert
 * lokal nur die Darstellung; der Server prüft jede Mutation erneut (§74).
 * Admin-, Finanz- und Systemrechte sind offline grundsätzlich nicht
 * verfügbar (§26/§75) und werden deshalb nie übertragen.
 */
export const OFFLINE_RELEVANT_PERMISSIONS: readonly PermissionKey[] = [
  'process.view_all',
  'process.view_completed',
  'calendar.view',
  'calendar.view_all',
  'machine.view',
  'machine.assign',
  'machine.override_block',
  'machine.clean_complete',
  'inventory.view',
  'handover.view',
  'handover.prepare',
  'handover.perform',
  'handover.correct_actual_time',
  'delivery_note.edit',
  'return.view',
  'return.perform',
  'return.complete',
  'return.mark_cleanup_issue',
  'return.correct_actual_time',
  'missing_item.create',
  'damage.document',
  'offer.view',
];

/** Paket/Mutation stammt aus einer anderen Umgebung – harter Abbruch (Order §76). */
export class OfflineEnvironmentMismatchError extends Error {
  constructor(
    readonly clientEnvironment: string,
    readonly serverEnvironment: string,
  ) {
    super('Die Offline-Daten gehören zu einer anderen Umgebung und werden nicht übernommen.');
    this.name = 'OfflineEnvironmentMismatchError';
  }
}

export type SecurityAudit = (event: SecurityEventInput) => Promise<void>;

export class OfflineLeaseService {
  private readonly audit: SecurityAudit;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    audit?: SecurityAudit,
  ) {
    this.audit = audit ?? ((event) => recordSecurityEvent(db, event));
  }

  get environment(): OfflineEnvironment {
    return this.config.appEnv;
  }

  /** Umgebungs-ID des Clients muss exakt der Server-Umgebung entsprechen (§76). */
  assertEnvironment(environment: string): void {
    if (environment !== this.config.appEnv) {
      throw new OfflineEnvironmentMismatchError(environment, this.config.appEnv);
    }
  }

  /** Offline-Berechtigung: mindestens ein operatives Recht (Order §8). */
  hasOfflineAccess(effective: ReadonlySet<PermissionKey>): boolean {
    return OFFLINE_ENABLING_PERMISSIONS.some((key) => effective.has(key));
  }

  /** Rechte-Snapshot für Paket/Lease: effektive Rechte ∩ offline-relevante Keys. */
  offlinePermissions(effective: ReadonlySet<PermissionKey>): string[] {
    return OFFLINE_RELEVANT_PERMISSIONS.filter((key) => effective.has(key)).sort();
  }

  /**
   * Lease ausstellen oder verlängern (Upsert auf das aktive Lease). Jede
   * Verlängerung erzeugt ein NEUES Secret (der Client wickelt den DEK neu
   * ein) und setzt die 72-h-Frist neu; die Lease-ID bleibt erhalten.
   */
  async issue(
    context: AuthenticatedContext,
    deviceId: string,
    environment: string,
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<LeaseGrant> {
    this.assertEnvironment(environment);
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + OFFLINE_LEASE_MS);
    const encrypted = encryptSecret(secret, this.config.auth.secretKey);
    const existing = await this.activeLeaseRow(context.user.id, deviceId);
    let lease: OfflineAccessLease;
    if (existing === null) {
      const inserted = await this.db
        .insert(offlineAccessLeases)
        .values({
          staffUserId: context.user.id,
          sessionId: context.session.id,
          deviceId,
          appEnv: this.config.appEnv,
          leaseSecretEncrypted: encrypted,
          issuedAt: now,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      lease = inserted[0]!;
      await this.audit({
        type: 'offline.lease_issued',
        actorUserId: context.user.id,
        targetUserId: context.user.id,
        sessionId: context.session.id,
        details: { leaseId: lease.id, deviceId, environment: this.config.appEnv },
      });
    } else {
      const updated = await this.db
        .update(offlineAccessLeases)
        .set({
          sessionId: context.session.id,
          leaseSecretEncrypted: encrypted,
          issuedAt: now,
          expiresAt,
          renewedAt: now,
          updatedAt: now,
        })
        .where(eq(offlineAccessLeases.id, existing.id))
        .returning();
      lease = updated[0]!;
      await this.audit({
        type: 'offline.lease_renewed',
        actorUserId: context.user.id,
        targetUserId: context.user.id,
        sessionId: context.session.id,
        details: { leaseId: lease.id, deviceId, environment: this.config.appEnv },
      });
    }
    return {
      leaseId: lease.id,
      userId: context.user.id,
      environment: this.config.appEnv,
      deviceId,
      issuedAt: lease.issuedAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
      leaseSecret: secret,
      permissions: this.offlinePermissions(effective),
      firstName: context.user.firstName,
      lastName: context.user.lastName,
    };
  }

  /** Nicht widerrufenes Lease (unabhängig vom Ablauf) – internes Upsert-Ziel. */
  private async activeLeaseRow(
    userId: string,
    deviceId: string,
  ): Promise<OfflineAccessLease | null> {
    const rows = await this.db
      .select()
      .from(offlineAccessLeases)
      .where(
        and(
          eq(offlineAccessLeases.staffUserId, userId),
          eq(offlineAccessLeases.deviceId, deviceId),
          eq(offlineAccessLeases.appEnv, this.config.appEnv),
          isNull(offlineAccessLeases.revokedAt),
        ),
      );
    return rows[0] ?? null;
  }

  /** Aktives, nicht abgelaufenes Lease des Benutzers für dieses Gerät. */
  async activeLease(
    userId: string,
    deviceId: string,
    now = new Date(),
  ): Promise<OfflineAccessLease | null> {
    const rows = await this.db
      .select()
      .from(offlineAccessLeases)
      .where(
        and(
          eq(offlineAccessLeases.staffUserId, userId),
          eq(offlineAccessLeases.deviceId, deviceId),
          eq(offlineAccessLeases.appEnv, this.config.appEnv),
          isNull(offlineAccessLeases.revokedAt),
          gt(offlineAccessLeases.expiresAt, now),
        ),
      );
    return rows[0] ?? null;
  }

  /**
   * Aktuelles Lease-Secret für die stille Online-Entsperrung des lokalen
   * Workspace (Reload ohne Passwort). Nur bei gültigem Lease UND gültiger,
   * nicht gesperrter Session – ein widerrufener/gesperrter Benutzer kommt
   * hier nie an (Order §39).
   */
  async currentSecret(
    userId: string,
    deviceId: string,
    environment: string,
    now = new Date(),
  ): Promise<{ leaseId: string; leaseSecret: string; expiresAt: string } | null> {
    this.assertEnvironment(environment);
    const lease = await this.activeLease(userId, deviceId, now);
    if (lease === null) return null;
    return {
      leaseId: lease.id,
      leaseSecret: decryptSecret(lease.leaseSecretEncrypted, this.config.auth.secretKey),
      expiresAt: lease.expiresAt.toISOString(),
    };
  }

  /** Lease eines Geräts widerrufen (Logout, Administration). true = es gab ein aktives Lease. */
  async revokeForDevice(
    actorUserId: string,
    userId: string,
    deviceId: string,
    environment: string,
    reason: string,
    now = new Date(),
  ): Promise<boolean> {
    this.assertEnvironment(environment);
    const updated = await this.db
      .update(offlineAccessLeases)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(offlineAccessLeases.staffUserId, userId),
          eq(offlineAccessLeases.deviceId, deviceId),
          eq(offlineAccessLeases.appEnv, this.config.appEnv),
          isNull(offlineAccessLeases.revokedAt),
        ),
      )
      .returning({ id: offlineAccessLeases.id });
    const lease = updated[0];
    if (lease === undefined) return false;
    await this.audit({
      type: 'offline.lease_revoked',
      actorUserId,
      targetUserId: userId,
      details: { leaseId: lease.id, deviceId, environment: this.config.appEnv, reason },
    });
    return true;
  }

  /** Paketabruf protokollieren (Betriebsinformation, keine Fachdaten). */
  async touchPackage(leaseId: string, now = new Date()): Promise<void> {
    await this.db
      .update(offlineAccessLeases)
      .set({
        lastPackageAt: now,
        packageSeq: sql`${offlineAccessLeases.packageSeq} + 1`,
        updatedAt: now,
      })
      .where(eq(offlineAccessLeases.id, leaseId));
  }
}
