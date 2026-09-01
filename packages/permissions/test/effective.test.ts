import { describe, expect, it } from 'vitest';
import {
  ADMIN_CRITICAL_PERMISSIONS,
  computeEffectivePermissions,
  hasAdminCapability,
  PERMISSION_CATEGORIES,
  PERMISSION_DEFINITIONS,
  type PermissionOverride,
} from '../src/index.ts';

const NOW = new Date('2026-09-01T12:00:00Z');

const allow = (key: string, from: Date | null = null, until: Date | null = null) =>
  ({ permissionKey: key, effect: 'allow', validFrom: from, validUntil: until }) as const;
const deny = (key: string, from: Date | null = null, until: Date | null = null) =>
  ({ permissionKey: key, effect: 'deny', validFrom: from, validUntil: until }) as const;

describe('Katalog', () => {
  it('hat eindeutige Keys und nur gültige Kategorien', () => {
    const keys = PERMISSION_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    const categories = new Set(PERMISSION_CATEGORIES.map((c) => c.key));
    for (const d of PERMISSION_DEFINITIONS) expect(categories.has(d.category)).toBe(true);
  });

  it('enthält die Kern-Keys aus PERMISSIONS.md', () => {
    const keys = new Set<string>(PERMISSION_DEFINITIONS.map((d) => d.key));
    for (const k of [
      'employee.manage',
      'permission.manage',
      'device.revoke',
      'offer.change_price',
      'machine.override_block',
      'settlement.release',
      'lexware.manual_transfer',
      'booking.cancel',
      'system.settings',
    ]) {
      expect(keys.has(k)).toBe(true);
    }
  });
});

describe('computeEffectivePermissions', () => {
  it('Rollenrechte gelten (Permission-Allow über Rolle)', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: ['offer.create', 'customer.view'],
      overrides: [],
      now: NOW,
    });
    expect(set.has('offer.create')).toBe(true);
    expect(set.has('customer.view')).toBe(true);
    expect(set.has('offer.change_price')).toBe(false);
  });

  it('individueller Allow-Override ergänzt Rollenrechte', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: ['customer.view'],
      overrides: [allow('offer.change_price')],
      now: NOW,
    });
    expect(set.has('offer.change_price')).toBe(true);
  });

  it('individueller Deny-Override entzieht ein Rollenrecht', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: ['offer.create', 'offer.send'],
      overrides: [deny('offer.send')],
      now: NOW,
    });
    expect(set.has('offer.create')).toBe(true);
    expect(set.has('offer.send')).toBe(false);
  });

  it('Deny gewinnt auch gegen gleichzeitig gültigen befristeten Allow', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: [],
      overrides: [
        allow('settlement.release', null, new Date('2026-12-31T00:00:00Z')),
        deny('settlement.release'),
      ],
      now: NOW,
    });
    expect(set.has('settlement.release')).toBe(false);
  });

  it('befristetes Sonderrecht gilt innerhalb der Laufzeit', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: [],
      overrides: [
        allow(
          'discount.over_20_approve',
          new Date('2026-09-01T00:00:00Z'),
          new Date('2026-09-08T00:00:00Z'),
        ),
      ],
      now: NOW,
    });
    expect(set.has('discount.over_20_approve')).toBe(true);
  });

  it('befristetes Sonderrecht gilt nach Ablauf nicht mehr (Grenze exklusiv)', () => {
    const overrides: PermissionOverride[] = [
      allow(
        'discount.over_20_approve',
        new Date('2026-08-01T00:00:00Z'),
        new Date('2026-09-01T12:00:00Z'), // == NOW → bereits abgelaufen
      ),
    ];
    const set = computeEffectivePermissions({ rolePermissionKeys: [], overrides, now: NOW });
    expect(set.has('discount.over_20_approve')).toBe(false);
  });

  it('befristetes Sonderrecht gilt vor Beginn nicht', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: [],
      overrides: [allow('discount.over_20_approve', new Date('2026-09-02T00:00:00Z'), null)],
      now: NOW,
    });
    expect(set.has('discount.over_20_approve')).toBe(false);
  });

  it('abgelaufener Deny wirkt nicht mehr', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: ['offer.send'],
      overrides: [deny('offer.send', null, new Date('2026-08-01T00:00:00Z'))],
      now: NOW,
    });
    expect(set.has('offer.send')).toBe(true);
  });

  it('ignoriert unbekannte Keys vollständig', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: ['gibt.es_nicht'],
      overrides: [allow('auch.nicht')],
      now: NOW,
    });
    expect(set.size).toBe(0);
  });
});

describe('hasAdminCapability', () => {
  it('erfordert alle kritischen Admin-Rechte', () => {
    const full = computeEffectivePermissions({
      rolePermissionKeys: [...ADMIN_CRITICAL_PERMISSIONS],
      overrides: [],
      now: NOW,
    });
    expect(hasAdminCapability(full)).toBe(true);

    const partial = computeEffectivePermissions({
      rolePermissionKeys: ['employee.manage'],
      overrides: [],
      now: NOW,
    });
    expect(hasAdminCapability(partial)).toBe(false);
  });

  it('Deny auf ein kritisches Recht entzieht die Admin-Fähigkeit', () => {
    const set = computeEffectivePermissions({
      rolePermissionKeys: [...ADMIN_CRITICAL_PERMISSIONS],
      overrides: [deny('permission.manage')],
      now: NOW,
    });
    expect(hasAdminCapability(set)).toBe(false);
  });
});
