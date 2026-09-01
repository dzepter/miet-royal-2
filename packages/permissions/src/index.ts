/**
 * Granulares Rechtesystem (PERMISSIONS.md hat Vorrang).
 *
 * Enthält den typisierten Berechtigungskatalog (Keys + Metadaten für alle
 * Fachbereiche, auch spätere Phasen) und die pure, serverseitig eindeutige
 * Berechnung effektiver Rechte. Jede kritische Aktion wird serverseitig
 * geprüft – ausgeblendete Buttons sind kein Berechtigungsschutz (CLAUDE.md).
 */
export {
  ADMIN_CRITICAL_PERMISSIONS,
  getPermissionDefinition,
  isPermissionKey,
  PERMISSION_CATEGORIES,
  PERMISSION_DEFINITIONS,
  PERMISSION_KEYS,
  type PermissionCategoryKey,
  type PermissionDefinition,
  type PermissionKey,
} from './catalog.ts';
export {
  computeEffectivePermissions,
  hasAdminCapability,
  isOverrideActive,
  type PermissionOverride,
} from './effective.ts';
