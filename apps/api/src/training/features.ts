import type { OfflineMutationType } from '@mietroyal/offline/shared';

/**
 * Phase 14 (Order §60, Design §4.5): fester Katalog der gate-fähigen Live-
 * Funktionen. Nur echte, bereits vorhandene Mutationen (§100) – keine Lese-
 * Routen, keine Admin-/Rechteverwaltung (§98/§99). Der Katalog ist Code:
 * Admins wählen je Feature höchstens eine Übung (`training_feature_requirements`),
 * neue Features entstehen nur hier – nie dynamisch aus der Datenbank.
 */
export const TRAINING_FEATURE_KEYS = [
  'offer.send',
  'handover.finalize',
  'return.finalize',
  'settlement.release',
  'tour.start',
  'tour.takeover',
  'machine.clean_complete',
  'inventory.stocktake_approve',
] as const;

export type TrainingFeatureKey = (typeof TRAINING_FEATURE_KEYS)[number];

export interface TrainingFeatureSpec {
  key: TrainingFeatureKey;
  /** Anzeigename in der Verwaltung („Live-Sperren“). */
  title: string;
  /** Welche Aktion(en) die Sperre serverseitig prüft – für die Admin-Ansicht. */
  description: string;
}

export const TRAINING_FEATURES: readonly TrainingFeatureSpec[] = [
  {
    key: 'offer.send',
    title: 'Angebot senden',
    description: 'Angebotsversion an den Kunden versenden.',
  },
  {
    key: 'handover.finalize',
    title: 'Übergabe abschließen',
    description: 'Übergabe finalisieren (online und per Offline-Sync).',
  },
  {
    key: 'return.finalize',
    title: 'Rückgabe abschließen',
    description: 'Rückgabe finalisieren (online und per Offline-Sync).',
  },
  {
    key: 'settlement.release',
    title: 'Abrechnung freigeben',
    description:
      'Kundeninformation freigeben und senden, Kundenrückmeldung erfassen, Abrechnung freigeben, Wartefenster beenden.',
  },
  {
    key: 'tour.start',
    title: 'Tour starten',
    description: 'Aktive Fahrt einer Tour beginnen.',
  },
  {
    key: 'tour.takeover',
    title: 'Tour übernehmen',
    description: 'Laufende Tour eines anderen Fahrers übernehmen.',
  },
  {
    key: 'machine.clean_complete',
    title: 'Reinigung abschließen',
    description: 'Maschine als gereinigt und einsatzbereit melden (online und per Offline-Sync).',
  },
  {
    key: 'inventory.stocktake_approve',
    title: 'Lagerzählung freigeben',
    description: 'Inventur mit Differenz freigeben (Bestandskorrektur).',
  },
];

export function isTrainingFeatureKey(value: string): value is TrainingFeatureKey {
  return (TRAINING_FEATURE_KEYS as readonly string[]).includes(value);
}

export function trainingFeatureSpec(key: TrainingFeatureKey): TrainingFeatureSpec {
  const spec = TRAINING_FEATURES.find((feature) => feature.key === key);
  if (spec === undefined) throw new Error(`Unbekanntes Training-Feature: ${key}`);
  return spec;
}

/**
 * Offline-Mutationen, die dieselbe Fachaktion wie eine gegatete Online-Route
 * auslösen (Design §4.5): der Sync prüft die Sperre nach der Rechteprüfung –
 * ein Offline-Client umgeht das Gate nicht (§65/§117).
 */
export const OFFLINE_MUTATION_FEATURES: Partial<Record<OfflineMutationType, TrainingFeatureKey>> = {
  'handover.finalize': 'handover.finalize',
  'return.finalize': 'return.finalize',
  'machine.clean_complete': 'machine.clean_complete',
};
