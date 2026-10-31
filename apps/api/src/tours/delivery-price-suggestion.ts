/**
 * Phase 13 (Order §9): Grenze für einen SPÄTEREN Lieferpreis-Vorschlag aus
 * Distanz/Fahrzeit. Bewusst leer: Es ist KEINE Fachregel definiert (kein
 * €/km, kein Mindest-/Zeitpreis), und der Buchungspreis bleibt unverändert.
 * Diese Funktion liefert daher immer `null` – sie darf nie still mit einer
 * erfundenen Formel gefüllt werden.
 */
export interface DeliveryPriceSuggestionInput {
  distanceMeters: number;
  durationSeconds: number;
}

export interface DeliveryPriceSuggestion {
  /** Integer-Cent – erst, wenn eine Fachregel definiert ist. */
  suggestedPriceCents: number;
  basis: string;
}

export function suggestDeliveryPrice(
  _input: DeliveryPriceSuggestionInput,
): DeliveryPriceSuggestion | null {
  // Keine Fachregel definiert (Order §9) – kein Vorschlag.
  return null;
}
