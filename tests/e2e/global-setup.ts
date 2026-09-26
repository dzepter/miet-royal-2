import { resetE2eDatabase } from './helpers/seed.ts';

/**
 * Basis-Seed vor dem Lauf (Server starten gegen eine gültige Datenbank).
 * Jede Spec setzt die Datenbank zusätzlich selbst zurück (helpers/seed.ts).
 */
export default function globalSetup(): void {
  resetE2eDatabase();
}
