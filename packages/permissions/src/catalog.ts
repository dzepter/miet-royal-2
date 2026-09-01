/**
 * Zentraler, typisierter Berechtigungskatalog (PERMISSIONS.md hat Vorrang).
 *
 * Phase 1 definiert NUR Keys + Metadaten – auch für Fachbereiche, deren
 * Logik erst in späteren Phasen gebaut wird. Keine Fachlogik hier.
 *
 * `adminInfra: true` markiert reine Admin-Infrastruktur: Für Mitarbeitende
 * ohne dieses Recht wird die Funktion in der UI vollständig ausgeblendet.
 * Normale fachliche Funktionen (`adminInfra: false`) dürfen sichtbar, aber
 * gesperrt dargestellt werden – mit `defaultExplanation` als Standardtext,
 * den der Admin pro Funktion überschreiben kann (UX_RULES.md, PERMISSIONS.md
 * "UI").
 */

export const PERMISSION_CATEGORIES = [
  { key: 'employees', label: 'Mitarbeiter' },
  { key: 'customers', label: 'Kunden' },
  { key: 'processes', label: 'Vorgänge' },
  { key: 'offers', label: 'Angebote' },
  { key: 'pricing', label: 'Preise / Rabatte' },
  { key: 'calendar', label: 'Termine / Kalender' },
  { key: 'machines', label: 'Maschinen' },
  { key: 'inventory', label: 'Lager' },
  { key: 'handover', label: 'Ausgabe' },
  { key: 'returns', label: 'Rückgabe' },
  { key: 'damages', label: 'Schäden / Fehlteile' },
  { key: 'cancellation', label: 'Storno' },
  { key: 'settlement', label: 'Abrechnung' },
  { key: 'lexware', label: 'Lexware' },
  { key: 'communication', label: 'Kommunikation' },
  { key: 'cms', label: 'CMS / Website' },
  { key: 'demo', label: 'Demo / Training' },
  { key: 'system', label: 'Systemeinstellungen' },
] as const;

export type PermissionCategoryKey = (typeof PERMISSION_CATEGORIES)[number]['key'];

export interface PermissionDefinition {
  readonly key: string;
  readonly category: PermissionCategoryKey;
  readonly label: string;
  readonly defaultExplanation: string;
  readonly adminInfra: boolean;
}

const def = (
  key: string,
  category: PermissionCategoryKey,
  label: string,
  defaultExplanation: string,
  adminInfra = false,
) => ({ key, category, label, defaultExplanation, adminInfra }) as const;

export const PERMISSION_DEFINITIONS = [
  // Mitarbeiter (Admin-Infrastruktur)
  def(
    'employee.manage',
    'employees',
    'Mitarbeiter verwalten',
    'Nur Administratoren können Mitarbeiterkonten anlegen, sperren und verwalten.',
    true,
  ),
  def(
    'permission.manage',
    'employees',
    'Rechte & Rollen verwalten',
    'Nur Administratoren können Berechtigungen und Rollen ändern.',
    true,
  ),
  def(
    'device.revoke',
    'employees',
    'Geräte/Sitzungen abmelden',
    'Nur Administratoren können Geräte anderer Mitarbeitender abmelden.',
    true,
  ),

  // Kunden
  def(
    'customer.view',
    'customers',
    'Kunden ansehen',
    'Dir fehlt das Recht, Kundendaten einzusehen.',
  ),
  def(
    'customer.create',
    'customers',
    'Kunden anlegen',
    'Dir fehlt das Recht, neue Kunden anzulegen.',
  ),
  def(
    'customer.edit',
    'customers',
    'Kunden bearbeiten',
    'Dir fehlt das Recht, Kundendaten zu ändern.',
  ),

  // Vorgänge
  def(
    'process.view_all',
    'processes',
    'Alle Vorgänge sehen',
    'Dir fehlt das Recht, alle Vorgänge zu sehen.',
  ),
  def('process.create', 'processes', 'Vorgang anlegen', 'Dir fehlt das Recht, Vorgänge anzulegen.'),
  def(
    'process.edit',
    'processes',
    'Vorgang bearbeiten',
    'Dir fehlt das Recht, Vorgänge zu bearbeiten.',
  ),
  def(
    'process.complete',
    'processes',
    'Vorgang abschließen',
    'Dir fehlt das Recht, Vorgänge abzuschließen.',
  ),
  def(
    'process.view_completed',
    'processes',
    'Abgeschlossene Vorgänge sehen',
    'Dir fehlt das Recht, ältere abgeschlossene Vorgänge einzusehen.',
  ),
  def(
    'process.reassign',
    'processes',
    'Vorgang neu zuweisen',
    'Dir fehlt das Recht, Vorgänge neu zuzuweisen.',
  ),
  def(
    'process.cancel',
    'processes',
    'Vorgang stornieren',
    'Dir fehlt das Recht, Vorgänge zu stornieren.',
  ),
  def(
    'process.reopen_completed',
    'processes',
    'Abgeschlossenen Vorgang wieder öffnen',
    'Dir fehlt das Recht, abgeschlossene Vorgänge wieder zu öffnen.',
  ),

  // Angebote
  def('offer.create', 'offers', 'Angebot erstellen', 'Dir fehlt das Recht, Angebote zu erstellen.'),
  def(
    'offer.edit_draft',
    'offers',
    'Angebotsentwurf bearbeiten',
    'Dir fehlt das Recht, Angebotsentwürfe zu bearbeiten.',
  ),
  def('offer.send', 'offers', 'Angebot versenden', 'Dir fehlt das Recht, Angebote zu versenden.'),
  def(
    'offer.create_new_version',
    'offers',
    'Neue Angebotsversion erstellen',
    'Dir fehlt das Recht, neue Angebotsversionen zu erstellen.',
  ),
  def('offer.change_price', 'offers', 'Preis ändern', 'Dir fehlt das Recht, Preise zu ändern.'),
  def(
    'offer.apply_discount',
    'offers',
    'Rabatt anwenden',
    'Dir fehlt das Recht, Rabatte zu vergeben.',
  ),
  def(
    'offer.apply_special_price',
    'offers',
    'Sonderpreis vergeben',
    'Dir fehlt das Recht, Sonderpreise zu vergeben.',
  ),

  // Preise / Rabatte
  def(
    'discount.up_to_10',
    'pricing',
    'Rabatt bis 10 %',
    'Dir fehlt das Recht, Rabatte zu vergeben.',
  ),
  def(
    'discount.over_10_with_reason',
    'pricing',
    'Rabatt über 10 % (mit Grund)',
    'Rabatte über 10 % erfordern ein besonderes Recht und einen Grund.',
  ),
  def(
    'discount.over_20_request',
    'pricing',
    'Rabatt über 20 % anfragen',
    'Rabatte über 20 % müssen angefragt werden.',
  ),
  def(
    'discount.over_20_approve',
    'pricing',
    'Rabatt über 20 % freigeben',
    'Nur berechtigte Personen geben Rabatte über 20 % frei.',
  ),
  def('price.manage', 'pricing', 'Preise pflegen', 'Dir fehlt das Recht, Preise zu pflegen.'),

  // Termine / Kalender
  def(
    'booking.confirm',
    'calendar',
    'Buchung bestätigen',
    'Dir fehlt das Recht, Buchungen zu bestätigen.',
  ),
  def(
    'calendar.view_all',
    'calendar',
    'Gesamten Kalender sehen',
    'Dir fehlt das Recht, den gesamten Kalender zu sehen.',
  ),
  def(
    'calendar.drag_drop',
    'calendar',
    'Termine verschieben',
    'Dir fehlt das Recht, Termine zu verschieben.',
  ),
  def(
    'appointment.assign',
    'calendar',
    'Termin zuweisen',
    'Dir fehlt das Recht, Termine zuzuweisen.',
  ),
  def(
    'appointment.reassign_same_day',
    'calendar',
    'Termin am selben Tag neu zuweisen',
    'Dir fehlt das Recht, Termine kurzfristig neu zuzuweisen.',
  ),

  // Maschinen
  def(
    'machine.view',
    'machines',
    'Maschinen ansehen',
    'Dir fehlt das Recht, Maschinen einzusehen.',
  ),
  def(
    'machine.assign',
    'machines',
    'Maschine zuordnen',
    'Dir fehlt das Recht, Maschinen zuzuordnen.',
  ),
  def(
    'machine.change_status',
    'machines',
    'Maschinenstatus ändern',
    'Dir fehlt das Recht, den Maschinenstatus zu ändern.',
  ),
  def(
    'machine.block',
    'machines',
    'Maschine sperren',
    'Dir fehlt das Recht, Maschinen zu sperren.',
  ),
  def(
    'machine.override_block',
    'machines',
    'Maschinensperre übersteuern',
    'Das Übersteuern von Sperren erfordert ein besonderes Recht.',
  ),
  def(
    'machine.replace_reference_photo',
    'machines',
    'Referenzfoto ersetzen',
    'Dir fehlt das Recht, Referenzfotos zu ersetzen.',
  ),

  // Lager
  def('inventory.view', 'inventory', 'Lager ansehen', 'Dir fehlt das Recht, das Lager einzusehen.'),
  def(
    'inventory.add_stock',
    'inventory',
    'Wareneingang buchen',
    'Dir fehlt das Recht, Wareneingänge zu buchen.',
  ),
  def('inventory.issue', 'inventory', 'Ware ausgeben', 'Dir fehlt das Recht, Ware auszugeben.'),
  def(
    'inventory.return',
    'inventory',
    'Ware zurücknehmen',
    'Dir fehlt das Recht, Ware zurückzunehmen.',
  ),
  def(
    'inventory.count',
    'inventory',
    'Inventur durchführen',
    'Dir fehlt das Recht, Inventuren durchzuführen.',
  ),
  def(
    'inventory.approve_adjustment',
    'inventory',
    'Inventurdifferenz freigeben',
    'Inventurdifferenzen gibt nur eine berechtigte Person frei.',
  ),
  def(
    'inventory.view_movement_history',
    'inventory',
    'Lagerbewegungen ansehen',
    'Dir fehlt das Recht, die Bewegungshistorie zu sehen.',
  ),

  // Ausgabe
  def(
    'handover.perform',
    'handover',
    'Ausgabe durchführen',
    'Dir fehlt das Recht, Ausgaben durchzuführen.',
  ),
  def(
    'handover.correct_actual_time',
    'handover',
    'Ausgabezeit korrigieren',
    'Dir fehlt das Recht, Ausgabezeiten zu korrigieren.',
  ),

  // Rückgabe
  def(
    'return.perform',
    'returns',
    'Rückgabe durchführen',
    'Dir fehlt das Recht, Rückgaben durchzuführen.',
  ),
  def(
    'return.correct_actual_time',
    'returns',
    'Rückgabezeit korrigieren',
    'Dir fehlt das Recht, Rückgabezeiten zu korrigieren.',
  ),
  def(
    'return.mark_cleanup_issue',
    'returns',
    'Reinigungsmangel erfassen',
    'Dir fehlt das Recht, Reinigungsmängel zu erfassen.',
  ),

  // Schäden / Fehlteile
  def(
    'damage.document',
    'damages',
    'Schaden dokumentieren',
    'Dir fehlt das Recht, Schäden zu dokumentieren.',
  ),
  def(
    'damage.set_cost',
    'damages',
    'Schadenskosten festlegen',
    'Dir fehlt das Recht, Schadenskosten festzulegen.',
  ),
  def(
    'damage.edit_cost_before_lexware',
    'damages',
    'Schadenskosten vor Lexware ändern',
    'Dir fehlt das Recht, Schadenskosten zu ändern.',
  ),
  def(
    'missing_item.create',
    'damages',
    'Fehlteil anlegen',
    'Dir fehlt das Recht, Fehlteile anzulegen.',
  ),
  def(
    'missing_item.set_cost',
    'damages',
    'Fehlteilkosten festlegen',
    'Dir fehlt das Recht, Fehlteilkosten festzulegen.',
  ),
  def(
    'missing_item.resolve',
    'damages',
    'Fehlteil abschließen',
    'Dir fehlt das Recht, Fehlteile abzuschließen.',
  ),

  // Storno
  def(
    'booking.cancel',
    'cancellation',
    'Buchung stornieren',
    'Dir fehlt das Recht, Buchungen zu stornieren.',
  ),

  // Abrechnung (inkl. Anzahlung/Kaution)
  def(
    'settlement.view',
    'settlement',
    'Abrechnung ansehen',
    'Dir fehlt das Recht, Abrechnungen einzusehen.',
  ),
  def(
    'settlement.add_manual_charge',
    'settlement',
    'Manuelle Nachbelastung',
    'Dir fehlt das Recht, Nachbelastungen hinzuzufügen.',
  ),
  def(
    'settlement.release',
    'settlement',
    'Abrechnung freigeben',
    'Dir fehlt das Recht, Abrechnungen freizugeben.',
  ),
  def(
    'settlement.end_pre_notice_wait',
    'settlement',
    'Vorinformationsfrist vorzeitig beenden',
    'Das vorzeitige Beenden der Frist erfordert ein besonderes Recht.',
  ),
  def(
    'deposit.record_advance',
    'settlement',
    'Anzahlung erfassen',
    'Dir fehlt das Recht, Anzahlungen zu erfassen.',
  ),
  def(
    'deposit.record_security',
    'settlement',
    'Kaution erfassen',
    'Dir fehlt das Recht, Kautionen zu erfassen.',
  ),
  def(
    'deposit.retain_security',
    'settlement',
    'Kaution einbehalten',
    'Dir fehlt das Recht, Kautionen einzubehalten.',
  ),
  def(
    'deposit.refund_security',
    'settlement',
    'Kaution zurückzahlen',
    'Dir fehlt das Recht, Kautionen zurückzuzahlen.',
  ),

  // Lexware
  def(
    'lexware.manual_transfer',
    'lexware',
    'Manuelle Lexware-Übertragung',
    'Die manuelle Lexware-Übertragung erfordert ein besonderes Recht.',
  ),

  // Kommunikation
  def(
    'message.reply_customer',
    'communication',
    'Kunden antworten',
    'Dir fehlt das Recht, Kundennachrichten zu beantworten.',
  ),
  def(
    'email.approve_prepared',
    'communication',
    'Vorbereitete E-Mail freigeben',
    'Dir fehlt das Recht, vorbereitete E-Mails freizugeben.',
  ),
  def(
    'whatsapp.reply',
    'communication',
    'WhatsApp beantworten',
    'Dir fehlt das Recht, WhatsApp-Nachrichten zu beantworten.',
  ),

  // CMS / Website
  def('product.manage', 'cms', 'Produkte verwalten', 'Dir fehlt das Recht, Produkte zu verwalten.'),
  def(
    'cms.edit',
    'cms',
    'Website-Inhalte bearbeiten',
    'Dir fehlt das Recht, Website-Inhalte zu bearbeiten.',
  ),
  def(
    'cms.publish',
    'cms',
    'Website-Inhalte veröffentlichen',
    'Dir fehlt das Recht, Inhalte zu veröffentlichen.',
  ),

  // Demo / Training (Admin-Infrastruktur)
  def(
    'demo.manage',
    'demo',
    'Demo-Umgebung verwalten',
    'Nur Administratoren verwalten die Demo-Umgebung.',
    true,
  ),
  def(
    'training.manage',
    'demo',
    'Training verwalten',
    'Nur Administratoren verwalten Trainings.',
    true,
  ),

  // Systemeinstellungen (Admin-Infrastruktur)
  def(
    'trash.manage',
    'system',
    'Papierkorb verwalten',
    'Nur Administratoren verwalten den Papierkorb.',
    true,
  ),
  def(
    'system.settings',
    'system',
    'Systemeinstellungen ändern',
    'Nur Administratoren ändern Systemeinstellungen.',
    true,
  ),
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSION_DEFINITIONS)[number]['key'];

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSION_DEFINITIONS.map((d) => d.key),
);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEYS.has(value);
}

export function getPermissionDefinition(key: PermissionKey): PermissionDefinition {
  const found = PERMISSION_DEFINITIONS.find((d) => d.key === key);
  if (found === undefined) throw new Error(`Unbekannter Permission-Key: ${key}`);
  return found;
}

/**
 * "Admin" im Sinne der Letzter-Admin-Schutzregel: Wer ALLE diese Rechte
 * effektiv besitzt, kann Mitarbeitende und Rechte verwalten. Der letzte
 * aktive Mitarbeiter mit diesem Set darf weder gesperrt/deaktiviert noch
 * dieser Rechte beraubt werden.
 */
export const ADMIN_CRITICAL_PERMISSIONS = ['employee.manage', 'permission.manage'] as const;
