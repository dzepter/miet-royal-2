import type { DemoScenario } from './context.ts';
import { voucherSituationFixture } from './fixtures/voucher-fixture.ts';
import {
  bookingAcceptedDeliveryScenario,
  bookingAcceptedPickupScenario,
  deliverySecondScenario,
  inquiryNewScenario,
  offerDraftScenario,
  offerSentScenario,
} from './scenarios/commerce.ts';
import { communicationScenario } from './scenarios/communication.ts';
import { customersScenario } from './scenarios/customers.ts';
import { foundationScenario, inventoryScenario } from './scenarios/foundation.ts';
import { finishingScenario, machinesScenario } from './scenarios/machines.ts';
import {
  handoverReadyScenario,
  rentalActiveScenario,
  returnDueScenario,
  returnOverdueScenario,
} from './scenarios/operations.ts';
import {
  cleaningPendingScenario,
  completedScenario,
  repeatSecondScenario,
  returnDamageScenario,
  returnMissingPartScenario,
  settlementReviewScenario,
} from './scenarios/returns.ts';
import { toursScenario } from './scenarios/tours.ts';

/**
 * Phase 14 (Order §10, Design §2): der kanonische Demo-Datensatz als
 * geordnete Szenarioliste. Die Reihenfolge ist fachlich bedingt (Konfiguration
 * und Lagerbestand vor Übergaben, Vorgänge vor Kommunikation/Touren) und
 * bestimmt zugleich die Vorgangsnummern (MR-<Jahr>-0001 = neue Anfrage usw.).
 *
 * Fixture-Schicht (Order W1.1): `voucher.situation` ist KEIN Fachpfad-Szenario,
 * sondern ein minimaler synthetischer Fixture-Zustand (fixtures/voucher-fixture.ts)
 * – der normale Gutscheinweg setzt eine erfolgreiche externe Buchhaltungs-
 * übertragung + Zahlungseingang voraus, die es in der Demo nie gibt (W1).
 * Trainingsbezug (Übungen/Pfade/Zuweisungen) liegt beim Trainingsmodul.
 */
export const CANONICAL_DEMO_SCENARIOS: readonly DemoScenario[] = [
  foundationScenario,
  inventoryScenario,
  customersScenario,
  inquiryNewScenario,
  offerDraftScenario,
  offerSentScenario,
  bookingAcceptedPickupScenario,
  bookingAcceptedDeliveryScenario,
  deliverySecondScenario,
  handoverReadyScenario,
  rentalActiveScenario,
  returnDueScenario,
  returnOverdueScenario,
  returnDamageScenario,
  returnMissingPartScenario,
  settlementReviewScenario,
  cleaningPendingScenario,
  completedScenario,
  repeatSecondScenario,
  voucherSituationFixture,
  communicationScenario,
  toursScenario,
  machinesScenario,
  finishingScenario,
];
