/**
 * Positionen der kombinierten Kundeninformation vor Schaden-/Fehlteil-
 * belastung (Phase-9-Vorgabe §25). Der Text selbst (Betreff, Sätze, Beträge,
 * Hinweis auf das Rückgabeprotokoll, keine Drohformulierung, keine MwSt-Texte)
 * kommt seit Phase 19 (P19-F8) aus der Mailvorlage
 * `settlement_damage_missing_notice` – eine Quelle für Vorschau und Versand
 * (`previewSettlementNotice` in communication/transactional/mailers.ts).
 * Beträge sind Integer-Cent aus dem Settlement; hier wird nichts berechnet.
 */

export interface NoticePosition {
  lineId: string;
  type: 'damage_charge' | 'missing_item_charge';
  description: string;
  amountCents: number;
}
