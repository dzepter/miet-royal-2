import type { PermissionKey } from '@mietroyal/permissions';
import { TRAINING_MESSAGES } from './errors.ts';
import type { EvaluatorKey } from './evaluators.ts';

/**
 * Phase 14 (Training, Order §§33/35/50/51/60/69/70, Design §4.2): der
 * Trainingskatalog ist CODE. Er wird in JEDER Umgebung beim Start idempotent
 * in die eigene Datenbank gespiegelt (`TrainingCatalogService.sync`); Demo und
 * Live referenzieren Übungen ausschließlich über die stabilen Keys – es gibt
 * keinen gemeinsamen Store, keine Synchronisierung, keinen Cross-DB-Zugriff.
 *
 * Keys sind stabil und werden NIE umbenannt: ein inhaltlich neues Training
 * bekommt einen neuen Key (z. B. `return_complete_v2`, §47); Text-/Versions-
 * änderungen setzen bestandene Versuche nie zurück (§46). Statt zu löschen
 * wird `active: false` gesetzt (§71).
 *
 * `requiredPermissions` sind KEINE zusätzlichen Rechte (§55): sie prüfen nur
 * beim Start der Übung, ob der Mitarbeiter die Fachrechte für die beteiligten
 * Aktionen überhaupt besitzt – die Fachrouten prüfen ihre Rechte unverändert.
 */

export type TrainingPermissionRequirement =
  { anyOf: readonly PermissionKey[] } | { allOf: readonly PermissionKey[] };

export interface TrainingDefinitionSpec {
  key: string;
  version: number;
  title: string;
  objective: string;
  instructions: string;
  evaluatorKey: EvaluatorKey;
  active: boolean;
  /** Sicherer bekannter Staff-Pfad zum passenden Demo-Bereich (§72). */
  demoPath: string;
  /** Stabiler Seed-Schlüssel des Demo-Szenarios (§72); zur Laufzeit über die Registry aufgelöst. */
  seedKey: string;
  requiredPermissions: TrainingPermissionRequirement;
}

export interface TrainingPathItemSpec {
  definitionKey: string;
  sequence: number;
  required: boolean;
}

export interface TrainingPathSpec {
  key: string;
  title: string;
  description: string;
  active: boolean;
  items: readonly TrainingPathItemSpec[];
}

export interface TrainingCatalog {
  definitions: readonly TrainingDefinitionSpec[];
  paths: readonly TrainingPathSpec[];
}

/** Reihenfolge = Anzeige-Reihenfolge. */
export const TRAINING_DEFINITIONS: readonly TrainingDefinitionSpec[] = [
  {
    key: 'offer_send',
    version: 1,
    title: 'Angebot bearbeiten und versenden',
    objective: 'Du passt einen Angebotsentwurf an und versendest ihn per E-Mail an den Kunden.',
    instructions: [
      '1. Öffne den Demo-Vorgang mit dem Angebotsentwurf.',
      '2. Passe den Entwurf an (z. B. Menge, Zusatzartikel oder Lieferung).',
      '3. Versende das Angebot – die Demo sendet nur an freigegebene Testadressen.',
    ].join('\n'),
    evaluatorKey: 'offer_send',
    active: true,
    demoPath: '/vorgaenge',
    seedKey: 'process.offer.draft',
    requiredPermissions: { allOf: ['offer.edit_draft', 'offer.send'] },
  },
  {
    key: 'handover_complete',
    version: 1,
    title: 'Übergabe abschließen',
    objective: 'Du führst eine Maschinenausgabe vollständig durch und schließt sie ab.',
    instructions: [
      '1. Öffne die vorbereitete Ausgabe des Demo-Vorgangs.',
      '2. Prüfe die Maschine gemeinsam, erfasse Foto und Empfänger.',
      '3. Hole beide Unterschriften ein und schließe die Übergabe ab.',
    ].join('\n'),
    evaluatorKey: 'handover_complete',
    active: true,
    demoPath: '/ausgabe',
    seedKey: 'process.handover.ready',
    requiredPermissions: { allOf: ['handover.perform'] },
  },
  {
    key: 'return_complete',
    version: 1,
    title: 'Rückgabe abschließen',
    objective: 'Du nimmst eine Maschine zurück und schließt die Rückgabe vollständig ab.',
    instructions: [
      '1. Öffne die fällige Rückgabe des Demo-Vorgangs.',
      '2. Prüfe Zubehör und Sauberkeit, dokumentiere Auffälligkeiten.',
      '3. Hole beide Unterschriften ein und schließe die Rückgabe ab.',
    ].join('\n'),
    evaluatorKey: 'return_complete',
    active: true,
    demoPath: '/rueckgabe',
    seedKey: 'process.return.due',
    requiredPermissions: { allOf: ['return.complete'] },
  },
  {
    key: 'tour_complete',
    version: 1,
    title: 'Tour planen, starten und abschließen',
    objective: 'Du bereitest eine Liefertour vor, startest sie und beendest sie nach den Stopps.',
    instructions: [
      '1. Öffne die heutige Demo-Tour oder lege eine neue Tour mit Stopps an.',
      '2. Plane die Route bzw. markiere die Tour als bereit.',
      '3. Starte die Tour, arbeite die Stopps ab und beende sie.',
    ].join('\n'),
    evaluatorKey: 'tour_complete',
    active: true,
    demoPath: '/touren',
    seedKey: 'tour.today.multi_stop',
    requiredPermissions: { allOf: ['calendar.view'] },
  },
  {
    key: 'communication_reply',
    version: 1,
    title: 'Kundenkommunikation beantworten',
    objective: 'Du beantwortest eine offene Kundennachricht aus der Konversation des Vorgangs.',
    instructions: [
      '1. Öffne den Demo-Vorgang mit der unbeantworteten Kundennachricht.',
      '2. Schreibe eine Antwort per E-Mail oder WhatsApp (Demo: simuliert).',
      '3. Die Übung gilt als bestanden, sobald der Versand bestätigt ist.',
    ].join('\n'),
    evaluatorKey: 'communication_reply',
    active: true,
    demoPath: '/vorgaenge',
    seedKey: 'conversation.email.unanswered',
    requiredPermissions: { anyOf: ['message.reply_customer', 'whatsapp.reply'] },
  },
  {
    key: 'settlement_review',
    version: 1,
    title: 'Abrechnung prüfen (bis vor Buchhaltungsübertragung)',
    objective:
      'Du prüfst eine Abrechnung mit offenen Klärungen, bis sie bereit zur Buchhaltung ist.',
    instructions: [
      '1. Öffne die Abrechnung des Demo-Vorgangs mit offenen Klärungen.',
      '2. Entscheide die Klärungen (z. B. Schadenkosten) und prüfe die Positionen.',
      // Review-Fix F8 (Order §25/§79): Belastungen verlangen die Kundeninformation per Mail –
      // der Demo-Kunde dieses Szenarios trägt dafür die konfigurierte Demo-Testadresse.
      '3. Berechnest du Schaden- oder Fehlteilkosten, prüfe die Kundeninformation und wähle „Freigeben und senden“. Nach dem bestätigten Versand beendest du das Wartefenster („Jetzt freigeben“) oder erfasst die Kundenrückmeldung. Bei „Nicht berechnen“ entfällt dieser Schritt.',
      '4. Bringe die Abrechnung in den Zustand „Bereit zur Buchhaltung“.',
      TRAINING_MESSAGES.SETTLEMENT_DEMO_NOTE,
    ].join('\n'),
    evaluatorKey: 'settlement_review',
    active: true,
    demoPath: '/vorgaenge',
    seedKey: 'process.settlement.review',
    requiredPermissions: {
      anyOf: ['settlement.release', 'damage.set_cost', 'missing_item.set_cost'],
    },
  },
  {
    key: 'machine_clean_complete',
    version: 1,
    title: 'Maschine reinigen',
    objective: 'Du schließt die Reinigung einer zurückgegebenen Maschine ab.',
    instructions: [
      '1. Öffne die Maschine in Reinigung im Demo-Bereich.',
      '2. Schließe die Reinigung ab – die Maschine ist danach wieder einsatzbereit.',
    ].join('\n'),
    evaluatorKey: 'machine_clean_complete',
    active: true,
    demoPath: '/reinigung',
    seedKey: 'machine.cleaning',
    requiredPermissions: { allOf: ['machine.clean_complete'] },
  },
  {
    key: 'inventory_stocktake_approve',
    version: 1,
    title: 'Lagerzählung freigeben',
    objective: 'Du erfasst eine Lagerzählung mit Differenz und gibst die Bestandskorrektur frei.',
    instructions: [
      '1. Erfasse im Lager eine Zählung, bei der mindestens ein Bestand abweicht.',
      '2. Prüfe die Differenzen und gib die Zählung frei.',
    ].join('\n'),
    evaluatorKey: 'inventory_stocktake_approve',
    active: true,
    demoPath: '/lager',
    seedKey: 'inventory.stocktake.initial',
    requiredPermissions: { allOf: ['inventory.approve_adjustment'] },
  },
];

export const TRAINING_PATHS: readonly TrainingPathSpec[] = [
  {
    key: 'rental_basics',
    title: 'Grundlagen Vermietung',
    description: 'Angebot, Ausgabe und Rückgabe – der Kernablauf einer Vermietung.',
    active: true,
    items: [
      { definitionKey: 'offer_send', sequence: 1, required: true },
      { definitionKey: 'handover_complete', sequence: 2, required: true },
      { definitionKey: 'return_complete', sequence: 3, required: true },
    ],
  },
  {
    key: 'delivery_tour',
    title: 'Lieferung & Tour',
    description: 'Eine Liefertour planen, fahren und abschließen.',
    active: true,
    items: [{ definitionKey: 'tour_complete', sequence: 1, required: true }],
  },
  {
    key: 'communication',
    title: 'Kommunikation',
    description: 'Kundennachrichten aus dem Vorgang heraus beantworten.',
    active: true,
    items: [{ definitionKey: 'communication_reply', sequence: 1, required: true }],
  },
  {
    key: 'settlement',
    title: 'Abrechnung',
    description: 'Abrechnungen prüfen und bis zur Buchhaltung vorbereiten.',
    active: true,
    items: [{ definitionKey: 'settlement_review', sequence: 1, required: true }],
  },
  {
    key: 'machines_warehouse',
    title: 'Maschinen & Lager',
    description: 'Reinigung abschließen und Lagerzählungen freigeben.',
    active: true,
    items: [
      { definitionKey: 'machine_clean_complete', sequence: 1, required: true },
      { definitionKey: 'inventory_stocktake_approve', sequence: 2, required: true },
    ],
  },
];

export const TRAINING_CATALOG: TrainingCatalog = {
  definitions: TRAINING_DEFINITIONS,
  paths: TRAINING_PATHS,
};

/**
 * Fester Feature-Katalog der Live-Sperren (Order §60, §100): Quelle ist
 * `features.ts` (Agent TRAINING-GATES); hier nur re-exportiert, damit der
 * gesamte Katalog (Übungen, Pfade, Features) über `catalog.ts` erreichbar ist.
 */
export {
  TRAINING_FEATURES,
  type TrainingFeatureKey,
  type TrainingFeatureSpec,
} from './features.ts';

const DEFINITION_ORDER = new Map(TRAINING_DEFINITIONS.map((spec, index) => [spec.key, index]));

/** Anzeige-Reihenfolge einer Definition (Katalogreihenfolge; unbekannte Keys hinten, alphabetisch). */
export function definitionOrderIndex(key: string): number {
  return DEFINITION_ORDER.get(key) ?? Number.MAX_SAFE_INTEGER;
}

export function definitionSpecFor(key: string): TrainingDefinitionSpec | null {
  return TRAINING_DEFINITIONS.find((spec) => spec.key === key) ?? null;
}

/** Rechteprüfung beim Start einer Übung (§55 – keine neuen Rechte, nur Vorbedingung). */
export function hasRequiredPermissions(
  requirement: TrainingPermissionRequirement,
  effective: ReadonlySet<PermissionKey>,
): boolean {
  if ('anyOf' in requirement) {
    return requirement.anyOf.length === 0 || requirement.anyOf.some((key) => effective.has(key));
  }
  return requirement.allOf.every((key) => effective.has(key));
}
