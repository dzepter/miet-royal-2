import {
  staffPasswordResetTokens,
  staffPermissionExplanations,
  staffRecoveryCodes,
  staffRolePermissions,
  staffRoles,
  staffSecurityEvents,
  staffSessions,
  staffUserPermissionOverrides,
  staffUserRoles,
  staffUsers,
  type DatabaseExecutor,
  type StaffUser,
} from '@mietroyal/database';
import { isPermissionKey } from '@mietroyal/permissions';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { recordSecurityEvent } from './audit.ts';
import { generateToken, sha256Hex } from './crypto.ts';
import { hashPassword, validateNewPassword } from './passwords.ts';
import { AuthError, normalizeEmail, type StaffAuthService } from './service.ts';

/** Einrichtungs-Link für neue Mitarbeitende: 7 Tage gültig. */
export const EMPLOYEE_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LAST_ADMIN_MESSAGE =
  'Nicht möglich: Es muss immer mindestens ein aktiver Systemadministrator bestehen bleiben.';

/**
 * Schutzregel „letzter aktiver Admin“ (Phase-1-Vorgabe Nr. 2):
 * Nach JEDER Mutation, die Status oder Rechte betrifft, wird innerhalb der
 * Transaktion geprüft, ob noch mindestens ein aktiver Mitarbeiter die
 * kritischen Admin-Rechte effektiv besitzt. Falls nicht, wirft die Prüfung
 * und die Transaktion wird zurückgerollt – die Änderung passiert nie.
 */
/**
 * Schutzregel „letzter aktiver Systemadmin" (Phase-2-Finalisierung):
 * Nach JEDER Mutation, die Status, Rollen oder die Systemrolle betrifft,
 * prüft dieselbe Transaktion, ob noch mindestens ein AKTIVER Mitarbeiter
 * Mitglied einer Systemrolle (is_system_admin) ist. Die Eigenschaft ist
 * strukturell (nicht zeitbefristet, nicht durch Denies aushebelbar) –
 * Override-Grenzzeitpunkte spielen daher keine Rolle mehr.
 */
export async function assertActiveAdminRemains(executor: DatabaseExecutor): Promise<void> {
  // Nebenläufigkeitsschutz (Write-Skew): Ein transaktionsweiter Advisory-Lock
  // serialisiert alle invariantenrelevanten Mutationen. Die zweite von zwei
  // konkurrierenden Transaktionen wartet hier, sieht danach (READ COMMITTED,
  // frischer Statement-Snapshot) die committeten Änderungen der ersten und
  // schlägt korrekt fehl, statt gemeinsam den letzten Systemadmin zu entfernen.
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext('staff_admin_invariant'))`);

  const rows = await executor
    .select({ userId: staffUserRoles.userId })
    .from(staffUserRoles)
    .innerJoin(staffRoles, eq(staffUserRoles.roleId, staffRoles.id))
    .innerJoin(staffUsers, eq(staffUserRoles.userId, staffUsers.id))
    .where(and(eq(staffRoles.isSystemAdmin, true), eq(staffUsers.status, 'active')))
    .limit(1);
  if (rows.length === 0) throw new AuthError('LAST_ADMIN', LAST_ADMIN_MESSAGE);
}

function assertValidPermissionKeys(keys: readonly string[]): void {
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      throw new AuthError('VALIDATION', `Unbekannte Berechtigung: ${key}`);
    }
  }
}

/**
 * Admin-Operationen auf Mitarbeitenden, Rollen und Rechten. Die
 * Berechtigungsprüfung (employee.manage / permission.manage / device.revoke)
 * passiert in den Routen – hier liegen Fachablauf, Letzter-Admin-Schutz und
 * Audit.
 */
export class StaffAdminService {
  private readonly auth: StaffAuthService;

  constructor(auth: StaffAuthService) {
    this.auth = auth;
  }

  private get db() {
    return this.auth.db;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  /**
   * Erster Admin – ausschließlich über diesen Weg, niemals hardcodiert.
   * Nur erlaubt, solange noch KEIN Mitarbeiterkonto existiert.
   */
  async bootstrapFirstAdmin(input: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  }): Promise<StaffUser> {
    const problem = validateNewPassword(input.password);
    if (problem !== null) throw new AuthError('VALIDATION', problem);
    const email = normalizeEmail(input.email);
    if (email === '' || !email.includes('@')) {
      throw new AuthError('VALIDATION', 'Bitte eine gültige E-Mail-Adresse angeben.');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: staffUsers.id }).from(staffUsers).limit(1);
      if (existing.length > 0) {
        throw new AuthError(
          'CONFLICT',
          'Bootstrap nicht möglich: Es existieren bereits Mitarbeiterkonten.',
        );
      }
      const inserted = await tx
        .insert(staffUsers)
        .values({
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email,
          passwordHash,
        })
        .returning();
      const admin = inserted[0];
      if (admin === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');

      // Systemrolle: Rechte kommen DYNAMISCH aus dem Katalog
      // (is_system_admin), nicht aus staff_role_permissions – neue Keys
      // späterer Phasen gelten damit automatisch.
      const roleRows = await tx
        .insert(staffRoles)
        .values({ name: 'Administrator', isSystemAdmin: true })
        .returning({ id: staffRoles.id });
      const roleId = roleRows[0]?.id;
      if (roleId === undefined) throw new AuthError('CONFLICT', 'Rollen-Anlage fehlgeschlagen.');
      await tx.insert(staffUserRoles).values({ userId: admin.id, roleId });
      return admin;
    });

    await recordSecurityEvent(this.db, {
      type: 'employee.created',
      targetUserId: user.id,
      details: { bootstrap: true, role: 'Administrator' },
    });
    return user;
  }

  // ── Mitarbeiter ──────────────────────────────────────────────────────────

  /**
   * Neues Mitarbeiterkonto: startet ohne nutzbares Passwort. Der Admin erhält
   * einmalig einen Einrichtungs-Link (Reset-Token, 7 Tage), den er der Person
   * übergibt; darüber setzt sie ihr eigenes Passwort.
   */
  async createEmployee(
    actorId: string,
    input: { firstName: string; lastName: string; email: string },
  ): Promise<{ user: StaffUser; setupToken: string }> {
    const email = normalizeEmail(input.email);
    if (email === '' || !email.includes('@')) {
      throw new AuthError('VALIDATION', 'Bitte eine gültige E-Mail-Adresse angeben.');
    }
    if (input.firstName.trim() === '' || input.lastName.trim() === '') {
      throw new AuthError('VALIDATION', 'Vor- und Nachname sind erforderlich.');
    }
    const existing = await this.auth.findUserByEmail(email);
    if (existing !== undefined) {
      throw new AuthError('CONFLICT', 'Für diese E-Mail existiert bereits ein Konto.');
    }

    // Zufälliges, niemandem bekanntes Startpasswort – Login ist erst nach
    // dem Setzen eines eigenen Passworts über den Einrichtungs-Link möglich.
    const passwordHash = await hashPassword(generateToken());
    const inserted = await this.db
      .insert(staffUsers)
      .values({
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email,
        passwordHash,
      })
      .returning();
    const user = inserted[0];
    if (user === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');

    const setupToken = generateToken();
    await this.db.insert(staffPasswordResetTokens).values({
      userId: user.id,
      tokenHash: sha256Hex(setupToken),
      expiresAt: new Date(Date.now() + EMPLOYEE_SETUP_TOKEN_TTL_MS),
    });

    await recordSecurityEvent(this.db, {
      type: 'employee.created',
      actorUserId: actorId,
      targetUserId: user.id,
    });
    return { user, setupToken };
  }

  /**
   * Admin-Reset-Weg: erzeugt für ein bestehendes Konto einen einmaligen
   * Passwort-Reset-Link (60 min gültig), den der Admin der Person sicher
   * übergibt. Das ist der Wiederherstellungspfad, solange es keine echte
   * Mail-Infrastruktur gibt (staging/demo/production).
   */
  async issuePasswordResetLink(
    actorId: string,
    targetUserId: string,
  ): Promise<{ resetToken: string }> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (target.status !== 'active') {
      throw new AuthError('CONFLICT', 'Nur für aktive Konten möglich.');
    }
    const resetToken = generateToken();
    await this.db.insert(staffPasswordResetTokens).values({
      userId: targetUserId,
      tokenHash: sha256Hex(resetToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await recordSecurityEvent(this.db, {
      type: 'password.reset_link_issued',
      actorUserId: actorId,
      targetUserId,
    });
    return { resetToken };
  }

  /** Status ändern; Sperren/Deaktivieren widerruft sofort ALLE Sessions. */
  async setUserStatus(
    actorId: string,
    targetUserId: string,
    status: 'active' | 'locked' | 'disabled',
  ): Promise<void> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (target.status === status) return;

    await this.db.transaction(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ status, updatedAt: new Date() })
        .where(eq(staffUsers.id, targetUserId));
      if (status !== 'active') await assertActiveAdminRemains(tx);
    });

    if (status !== 'active') {
      await this.auth.revokeAllSessions(targetUserId, `user_${status}`, actorId);
    }
    const eventType =
      status === 'locked'
        ? 'employee.locked'
        : status === 'disabled'
          ? 'employee.disabled'
          : 'employee.reactivated';
    await recordSecurityEvent(this.db, {
      type: eventType,
      actorUserId: actorId,
      targetUserId,
      details: { previousStatus: target.status },
    });
  }

  // ── Rollen ───────────────────────────────────────────────────────────────

  async createRole(
    actorId: string,
    input: { name: string; permissionKeys: readonly string[] },
  ): Promise<string> {
    const name = input.name.trim();
    if (name === '') throw new AuthError('VALIDATION', 'Der Rollenname darf nicht leer sein.');
    assertValidPermissionKeys(input.permissionKeys);
    const existing = await this.db.select().from(staffRoles).where(eq(staffRoles.name, name));
    if (existing.length > 0) {
      throw new AuthError('CONFLICT', 'Eine Rolle mit diesem Namen existiert bereits.');
    }

    const roleId = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(staffRoles).values({ name }).returning({ id: staffRoles.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new AuthError('CONFLICT', 'Rollen-Anlage fehlgeschlagen.');
      for (const key of new Set(input.permissionKeys)) {
        await tx.insert(staffRolePermissions).values({ roleId: id, permissionKey: key });
      }
      return id;
    });
    await recordSecurityEvent(this.db, {
      type: 'permission.role_created',
      actorUserId: actorId,
      details: { roleName: name, permissionCount: new Set(input.permissionKeys).size },
    });
    return roleId;
  }

  async updateRole(
    actorId: string,
    roleId: string,
    input: { name?: string | undefined; permissionKeys?: readonly string[] | undefined },
  ): Promise<void> {
    const existing = await this.db.select().from(staffRoles).where(eq(staffRoles.id, roleId));
    const role = existing[0];
    if (role === undefined) throw new AuthError('NOT_FOUND', 'Rolle nicht gefunden.');
    if (role.isSystemAdmin) {
      throw new AuthError(
        'CONFLICT',
        'Die Systemrolle kann nicht bearbeitet werden – ihre Rechte kommen dynamisch aus dem Katalog.',
      );
    }
    if (input.permissionKeys !== undefined) assertValidPermissionKeys(input.permissionKeys);
    const newName = input.name?.trim();
    if (newName !== undefined && newName === '') {
      throw new AuthError('VALIDATION', 'Der Rollenname darf nicht leer sein.');
    }

    await this.db.transaction(async (tx) => {
      if (newName !== undefined && newName !== role.name) {
        await tx
          .update(staffRoles)
          .set({ name: newName, updatedAt: new Date() })
          .where(eq(staffRoles.id, roleId));
      }
      if (input.permissionKeys !== undefined) {
        await tx.delete(staffRolePermissions).where(eq(staffRolePermissions.roleId, roleId));
        for (const key of new Set(input.permissionKeys)) {
          await tx.insert(staffRolePermissions).values({ roleId, permissionKey: key });
        }
      }
      await assertActiveAdminRemains(tx);
    });
    await recordSecurityEvent(this.db, {
      type: 'permission.role_updated',
      actorUserId: actorId,
      details: { roleName: newName ?? role.name },
    });
  }

  async deleteRole(actorId: string, roleId: string): Promise<void> {
    const existing = await this.db.select().from(staffRoles).where(eq(staffRoles.id, roleId));
    const role = existing[0];
    if (role === undefined) throw new AuthError('NOT_FOUND', 'Rolle nicht gefunden.');
    if (role.isSystemAdmin) {
      throw new AuthError('CONFLICT', 'Die Systemrolle kann nicht gelöscht werden.');
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(staffRoles).where(eq(staffRoles.id, roleId));
      await assertActiveAdminRemains(tx);
    });
    await recordSecurityEvent(this.db, {
      type: 'permission.role_deleted',
      actorUserId: actorId,
      details: { roleName: role.name },
    });
  }

  /** Rollenzuweisung eines Mitarbeiters komplett setzen. */
  async setUserRoles(
    actorId: string,
    targetUserId: string,
    roleIds: readonly string[],
  ): Promise<void> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    const uniqueRoleIds = [...new Set(roleIds)];
    const systemRoleIds = new Set<string>();
    for (const roleId of uniqueRoleIds) {
      const role = await this.db.select().from(staffRoles).where(eq(staffRoles.id, roleId));
      const found = role[0];
      if (found === undefined) throw new AuthError('NOT_FOUND', 'Rolle nicht gefunden.');
      if (found.isSystemAdmin) systemRoleIds.add(found.id);
    }

    // Ernennen/Entziehen der Systemadmin-Eigenschaft darf ausschließlich ein
    // bereits berechtigter Systemadmin (Phase-2-Finalisierung) – nicht jeder
    // Inhaber von permission.manage.
    const currentSystemMembership = await this.db
      .select({ roleId: staffUserRoles.roleId })
      .from(staffUserRoles)
      .innerJoin(staffRoles, eq(staffUserRoles.roleId, staffRoles.id))
      .where(and(eq(staffUserRoles.userId, targetUserId), eq(staffRoles.isSystemAdmin, true)));
    const wasSystemAdmin = currentSystemMembership.length > 0;
    const becomesSystemAdmin = systemRoleIds.size > 0;
    const membershipChanges = wasSystemAdmin !== becomesSystemAdmin;
    if (membershipChanges && !(await this.auth.isSystemAdmin(actorId))) {
      throw new AuthError(
        'FORBIDDEN',
        'Nur ein Systemadmin darf die Systemadmin-Eigenschaft vergeben oder entziehen.',
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(staffUserRoles).where(eq(staffUserRoles.userId, targetUserId));
      for (const roleId of uniqueRoleIds) {
        await tx.insert(staffUserRoles).values({ userId: targetUserId, roleId });
      }
      await assertActiveAdminRemains(tx);
    });
    await recordSecurityEvent(this.db, {
      type: 'permission.roles_changed',
      actorUserId: actorId,
      targetUserId,
      details: { roleCount: uniqueRoleIds.length },
    });
    if (membershipChanges) {
      // Sicherheitskritische Änderung: eigenes Audit-Ereignis.
      await recordSecurityEvent(this.db, {
        type: becomesSystemAdmin
          ? 'permission.system_admin_granted'
          : 'permission.system_admin_revoked',
        actorUserId: actorId,
        targetUserId,
        details: {},
      });
    }
  }

  // ── Individuelle Overrides / befristete Sonderrechte ────────────────────

  async addOverride(
    actorId: string,
    targetUserId: string,
    input: {
      permissionKey: string;
      effect: 'allow' | 'deny';
      validFrom?: Date;
      validUntil?: Date;
    },
  ): Promise<string> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    if (!isPermissionKey(input.permissionKey)) {
      throw new AuthError('VALIDATION', `Unbekannte Berechtigung: ${input.permissionKey}`);
    }
    if (
      input.validFrom !== undefined &&
      input.validUntil !== undefined &&
      input.validUntil.getTime() <= input.validFrom.getTime()
    ) {
      throw new AuthError('VALIDATION', 'Das Ende muss nach dem Beginn liegen.');
    }

    const overrideId = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(staffUserPermissionOverrides)
        .values({
          userId: targetUserId,
          permissionKey: input.permissionKey,
          effect: input.effect,
          validFrom: input.validFrom ?? null,
          validUntil: input.validUntil ?? null,
          createdBy: actorId,
        })
        .returning({ id: staffUserPermissionOverrides.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
      // Unbedingt prüfen: auch ein (befristeter) Allow ändert die Zeitachse
      // der Invariante; die Prüfung ist billig und deckt alle Fälle ab.
      await assertActiveAdminRemains(tx);
      return id;
    });
    await recordSecurityEvent(this.db, {
      type: 'permission.override_added',
      actorUserId: actorId,
      targetUserId,
      details: {
        permissionKey: input.permissionKey,
        effect: input.effect,
        temporary: input.validFrom !== undefined || input.validUntil !== undefined,
      },
    });
    return overrideId;
  }

  async removeOverride(actorId: string, overrideId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(staffUserPermissionOverrides)
        .where(eq(staffUserPermissionOverrides.id, overrideId))
        .returning();
      const row = deleted[0];
      if (row === undefined) throw new AuthError('NOT_FOUND', 'Override nicht gefunden.');
      await assertActiveAdminRemains(tx);
      await recordSecurityEvent(tx, {
        type: 'permission.override_removed',
        actorUserId: actorId,
        targetUserId: row.userId,
        details: { permissionKey: row.permissionKey, effect: row.effect },
      });
    });
  }

  // ── 2FA-Verwaltung ───────────────────────────────────────────────────────

  async setTotpRequirement(
    actorId: string,
    targetUserId: string,
    required: boolean,
  ): Promise<void> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    await this.db
      .update(staffUsers)
      .set({ totpRequired: required, updatedAt: new Date() })
      .where(eq(staffUsers.id, targetUserId));
    await recordSecurityEvent(this.db, {
      type: 'twofa.requirement_changed',
      actorUserId: actorId,
      targetUserId,
      details: { required },
    });
  }

  /** 2FA bei verlorenem Gerät zurücksetzen (Secret + Recovery-Codes löschen). */
  async resetTotp(actorId: string, targetUserId: string): Promise<void> {
    const target = await this.auth.findUserById(targetUserId);
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    await this.db.transaction(async (tx) => {
      await tx
        .update(staffUsers)
        .set({
          totpEnabled: false,
          totpSecretEnc: null,
          totpPendingSecretEnc: null,
          updatedAt: new Date(),
        })
        .where(eq(staffUsers.id, targetUserId));
      await tx.delete(staffRecoveryCodes).where(eq(staffRecoveryCodes.userId, targetUserId));
    });
    await recordSecurityEvent(this.db, {
      type: 'twofa.reset',
      actorUserId: actorId,
      targetUserId,
    });
  }

  // ── Erklärtexte (Phase-1-Vorgabe Nr. 13, bewusst klein) ─────────────────

  async setPermissionExplanation(
    actorId: string,
    permissionKey: string,
    explanation: string,
  ): Promise<void> {
    if (!isPermissionKey(permissionKey)) {
      throw new AuthError('VALIDATION', `Unbekannte Berechtigung: ${permissionKey}`);
    }
    const text = explanation.trim();
    if (text === '') {
      await this.db
        .delete(staffPermissionExplanations)
        .where(eq(staffPermissionExplanations.permissionKey, permissionKey));
    } else {
      await this.db
        .insert(staffPermissionExplanations)
        .values({ permissionKey, explanation: text, updatedBy: actorId })
        .onConflictDoUpdate({
          target: staffPermissionExplanations.permissionKey,
          set: { explanation: text, updatedBy: actorId, updatedAt: new Date() },
        });
    }
    await recordSecurityEvent(this.db, {
      type: 'permission.explanation_updated',
      actorUserId: actorId,
      details: { permissionKey },
    });
  }

  // ── Abfragen für die Admin-UI ────────────────────────────────────────────

  async listUsers() {
    return this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        email: staffUsers.email,
        status: staffUsers.status,
        totpRequired: staffUsers.totpRequired,
        totpEnabled: staffUsers.totpEnabled,
        createdAt: staffUsers.createdAt,
      })
      .from(staffUsers)
      .orderBy(staffUsers.lastName, staffUsers.firstName);
  }

  async getUserDetail(userId: string) {
    const user = await this.auth.findUserById(userId);
    if (user === undefined) throw new AuthError('NOT_FOUND', 'Mitarbeiter nicht gefunden.');
    const roles = await this.db
      .select({ id: staffRoles.id, name: staffRoles.name, isSystemAdmin: staffRoles.isSystemAdmin })
      .from(staffUserRoles)
      .innerJoin(staffRoles, eq(staffUserRoles.roleId, staffRoles.id))
      .where(eq(staffUserRoles.userId, userId));
    const overrides = await this.db
      .select()
      .from(staffUserPermissionOverrides)
      .where(eq(staffUserPermissionOverrides.userId, userId))
      .orderBy(desc(staffUserPermissionOverrides.createdAt));
    const sessions = await this.listUserSessions(userId);
    const effectivePermissions = [...(await this.auth.effectivePermissions(userId))];
    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        status: user.status,
        totpRequired: user.totpRequired,
        totpEnabled: user.totpEnabled,
        createdAt: user.createdAt,
      },
      roles,
      overrides,
      sessions,
      effectivePermissions,
    };
  }

  async listUserSessions(userId: string) {
    return this.db
      .select({
        id: staffSessions.id,
        deviceLabel: staffSessions.deviceLabel,
        createdAt: staffSessions.createdAt,
        lastActivityAt: staffSessions.lastActivityAt,
        revokedAt: staffSessions.revokedAt,
      })
      .from(staffSessions)
      .where(eq(staffSessions.userId, userId))
      .orderBy(desc(staffSessions.lastActivityAt));
  }

  async listRoles() {
    const roles = await this.db.select().from(staffRoles).orderBy(staffRoles.name);
    const permissions = await this.db.select().from(staffRolePermissions);
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      isSystemAdmin: role.isSystemAdmin,
      permissionKeys: permissions
        .filter((p) => p.roleId === role.id)
        .map((p) => p.permissionKey)
        .sort(),
    }));
  }

  async listExplanations() {
    return this.db.select().from(staffPermissionExplanations);
  }

  async listSecurityEvents(targetUserId?: string, limit = 100) {
    const filter =
      targetUserId === undefined
        ? undefined
        : or(
            eq(staffSecurityEvents.targetUserId, targetUserId),
            and(
              eq(staffSecurityEvents.actorUserId, targetUserId),
              isNull(staffSecurityEvents.targetUserId),
            ),
          );
    return this.db
      .select()
      .from(staffSecurityEvents)
      .where(filter)
      .orderBy(desc(staffSecurityEvents.createdAt))
      .limit(Math.min(limit, 500));
  }
}
