/**
 * Seed für die E2E-Smokes: leere Auth-Tabellen + ein Bootstrap-Admin.
 * Ausschließlich synthetische Testdaten; läuft gegen die per DATABASE_URL
 * übergebene TESTdatenbank (niemals dev/produktiv aufrufen).
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

export const E2E_ADMIN_EMAIL = 'admin@e2e.example';
export const E2E_ADMIN_PASSWORD = 'e2e-admin-passwort-1';
export const E2E_SELLER_EMAIL = 'verkauf@e2e.example';
export const E2E_SELLER_PASSWORD = 'e2e-verkauf-passwort-1';

const config = loadConfig();
if (!config.databaseUrl.includes('mietroyal_test')) {
  console.error('Sicherheitsstopp: e2e-seed läuft nur gegen die mietroyal_test-Datenbank.');
  process.exit(2);
}

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  await runMigrations(db);
  await pool.query('TRUNCATE process_notes, processes, customers, system_settings CASCADE');
  await pool.query(
    `TRUNCATE staff_security_events, staff_user_permission_overrides, staff_user_roles,
     staff_role_permissions, staff_roles, staff_recovery_codes,
     staff_password_reset_tokens, staff_login_challenges, staff_sessions,
     staff_permission_explanations, staff_users CASCADE`,
  );
  // Phase 3: Commerce-Reset auf den Seed-Zustand der Migration 0007.
  await pool.query(
    `TRUNCATE offer_deliveries, documents, order_confirmations, bookings,
     offer_access_tokens, offer_line_items, offer_version_selections,
     offer_versions, offers, inquiry_selections, inquiries, terms_versions CASCADE`,
  );
  await pool.query(
    `DELETE FROM product_prices WHERE effective_from <> TIMESTAMPTZ '2020-01-01 00:00:00+00'`,
  );
  await pool.query(`UPDATE products SET active = true`);
  // TRUNCATE staff_users CASCADE leert product_prices mit (FK created_by) –
  // die Seed-Preise der Migration 0007 wiederherstellen:
  await pool.query(
    `INSERT INTO product_prices (product_id, price_cents, effective_from)
     SELECT p.id, v.price_cents, TIMESTAMPTZ '2020-01-01 00:00:00+00'
     FROM (VALUES
       ('slush-1x8', 6000), ('slush-2x8', 10000), ('slush-1x10', 7500), ('slush-2x10', 12000),
       ('sirup-wassermelone', 1200), ('sirup-kirsche', 1200), ('sirup-waldmeister', 1200),
       ('sirup-blaue-himbeere', 1200), ('becher-25', 250), ('strohhalme-25', 200),
       ('mischkanister-6l', 500)
     ) AS v(slug, price_cents)
     JOIN products p ON p.slug = v.slug
     WHERE NOT EXISTS (
       SELECT 1 FROM product_prices pp
       WHERE pp.product_id = p.id AND pp.effective_from = TIMESTAMPTZ '2020-01-01 00:00:00+00'
     )`,
  );
  // Abhol-Einstellungen (system_settings wurde geleert): öffentlicher Bereich
  // + SYNTHETISCHE exakte Abholadresse (nur Testdaten, Vorgabe Nr. 13/33).
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES
     ('pickup_public_area', '"Mainz-Hechtsheim"'::jsonb),
     ('pickup_exact_address', '"Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)"'::jsonb)
     ON CONFLICT (key) DO NOTHING`,
  );
  // TEST-Mietbedingungen (Platzhalter, klar als TEST markiert – Nr. 27).
  await pool.query(
    `INSERT INTO terms_versions (label, content, is_test) VALUES
     ('TEST-Platzhalter v1', 'TEST – Dies ist ein Platzhalter, kein echter Rechtstext.', true)
     ON CONFLICT (label) DO NOTHING`,
  );
  // Phase 5: Warehouse auf den Seed-Stand der Migration 0010 zurücksetzen.
  // (Die Auth-Truncates oben haben Sperren/Bewegungen/Inventuren bereits
  // mit abgeräumt – hier bleiben Maschinen-/Artikelzustand.)
  await pool.query(
    `DELETE FROM machines WHERE machine_code NOT IN (
       'MR-08-01-01','MR-08-01-02','MR-08-02-01',
       'MR-10-01-01','MR-10-01-02','MR-10-01-03','MR-10-01-04','MR-10-01-05','MR-10-01-06',
       'MR-10-02-01','MR-10-02-02')`,
  );
  await pool.query(
    `UPDATE machines SET status = 'ready', location_kind = 'warehouse', location_note = NULL,
     purchase_date = NULL, weight_grams = NULL, reference_photo_key = NULL,
     reference_photo_mime = NULL`,
  );
  await pool.query(`UPDATE inventory_items SET current_stock = NULL, min_stock = NULL`);
  // Synthetische QR-Basis-URL (Order §11 – dev/test dürfen das).
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES
     ('staff_app_base_url', '"http://127.0.0.1:3102"'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const auth = new StaffAuthService(db, config, new NoopMailAdapter());
  const admin = new StaffAdminService(auth);
  const adminUser = await admin.bootstrapFirstAdmin({
    firstName: 'Erika',
    lastName: 'E2E',
    email: E2E_ADMIN_EMAIL,
    password: E2E_ADMIN_PASSWORD,
  });

  // Verkaufs-Mitarbeiter für Szenario F: darf >20 % Rabatt BEANTRAGEN
  // (discount.over_20_request), aber NICHT freigeben (kein over_20_approve).
  const seller = await admin.createEmployee(adminUser.id, {
    firstName: 'Viktor',
    lastName: 'Verkauf',
    email: E2E_SELLER_EMAIL,
  });
  await auth.resetPassword(seller.setupToken, E2E_SELLER_PASSWORD);
  const salesRoleId = await admin.createRole(adminUser.id, {
    name: 'E2E-Verkauf',
    permissionKeys: [
      'process.view_all',
      'customer.view',
      'product.view',
      'inquiry.view',
      'inquiry.create',
      'inquiry.edit',
      'offer.view',
      'offer.create',
      'offer.edit_draft',
      'offer.send',
      'offer.apply_discount',
      'discount.up_to_10',
      'discount.over_10_with_reason',
      'discount.over_20_request',
      // Phase 4: Kalenderzugriff ("Meine Termine", Übernahmebestätigung).
      'calendar.view',
    ],
  });
  await admin.setUserRoles(adminUser.id, seller.user.id, [salesRoleId]);

  console.log('E2E-Seed fertig: Admin admin@e2e.example + Verkauf verkauf@e2e.example angelegt.');
} finally {
  await pool.end();
}
