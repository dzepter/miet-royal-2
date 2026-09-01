import {
  ADMIN_CRITICAL_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  isPermissionKey,
  type PermissionKey,
} from './catalog.ts';

/**
 * Ein individueller Override (Allow ODER Deny), optional zeitlich befristet.
 * Befristete Sonderrechte sind Allows mit validFrom/validUntil
 * (PERMISSIONS.md "Temporäre Rechte", DATA_MODEL.md "UserPermission").
 */
export interface PermissionOverride {
  permissionKey: string;
  effect: 'allow' | 'deny';
  /** inklusiv; null = ab sofort */
  validFrom: Date | null;
  /** exklusiv; null = unbefristet */
  validUntil: Date | null;
}

export function isOverrideActive(override: PermissionOverride, now: Date): boolean {
  if (override.validFrom !== null && now < override.validFrom) return false;
  if (override.validUntil !== null && now >= override.validUntil) return false;
  return true;
}

/**
 * Serverseitig eindeutige Berechnung der effektiven Rechte:
 *
 *   (Rollenrechte ∪ aktuell gültige individuelle Allows)
 *   ∖ aktuell gültige individuelle Denies
 *
 * Präzedenz: **Deny gewinnt immer** – auch gegenüber einem gleichzeitig
 * gültigen befristeten Allow. PERMISSIONS.md definiert keine Präzedenz;
 * Deny-gewinnt ist die sicherheitskonservative Standardinterpretation und
 * ist in docs/TECH_DECISIONS.md dokumentiert. Befristete Sonderrechte
 * wirken ausschließlich innerhalb ihres Zeitfensters – die Prüfung erfolgt
 * bei jeder Berechnung gegen `now`, es ist kein Background-Job nötig.
 *
 * Unbekannte Keys (z. B. aus alten Datenständen) werden ignoriert –
 * es kann nie ein Recht entstehen, das der Katalog nicht kennt.
 */
export function computeEffectivePermissions(input: {
  rolePermissionKeys: readonly string[];
  overrides: readonly PermissionOverride[];
  now: Date;
}): ReadonlySet<PermissionKey> {
  const effective = new Set<PermissionKey>();

  for (const key of input.rolePermissionKeys) {
    if (isPermissionKey(key)) effective.add(key);
  }
  for (const override of input.overrides) {
    if (override.effect !== 'allow') continue;
    if (!isOverrideActive(override, input.now)) continue;
    if (isPermissionKey(override.permissionKey)) effective.add(override.permissionKey);
  }
  for (const override of input.overrides) {
    if (override.effect !== 'deny') continue;
    if (!isOverrideActive(override, input.now)) continue;
    if (isPermissionKey(override.permissionKey)) effective.delete(override.permissionKey);
  }

  return effective;
}

/** Besitzt dieses effektive Rechteset die volle Admin-Fähigkeit? */
export function hasAdminCapability(effective: ReadonlySet<PermissionKey>): boolean {
  return ADMIN_CRITICAL_PERMISSIONS.every((key) => effective.has(key));
}

/**
 * Vollständiges Rechteset eines SYSTEMADMINS (Phase-2-Finalisierung):
 * dynamisch ALLE aktuell im zentralen Katalog definierten Rechte – neue
 * Keys späterer Phasen gelten damit automatisch, ohne Rollenpflege.
 * Individuelle Deny-Overrides wirken auf Systemadmins bewusst NICHT
 * (sie könnten den Systemadmin sonst versehentlich entmachten).
 *
 * `definitions` ist parametrisierbar, damit Tests die Zukunftssicherheit
 * mit einem synthetisch erweiterten Katalog belegen können.
 */
export function fullPermissionSet(
  definitions: readonly { key: string }[] = PERMISSION_DEFINITIONS,
): ReadonlySet<PermissionKey> {
  return new Set(definitions.map((definition) => definition.key)) as ReadonlySet<PermissionKey>;
}
