/**
 * Phase 16 (PUBLIC): „Auswahl ⇒ PricingInput“ – EINE Stelle, die aus einer fachlichen
 * Auswahl (Maschine, Sirup-/Zubehör-Auswahl, Abholung/Lieferung) die Eingabe der
 * zentralen Preisengine `priceOffer` baut. Genutzt vom Angebot (OfferService, Produkte
 * per ID) und von der öffentlichen Konfigurator-Vorschau/-Anfrage (Produkte per Slug).
 *
 * Bewusst ohne Datenbank: Die Produktauflösung (inkl. wirksamem Preis zum
 * Berechnungszeitpunkt) liefert der Aufrufer über `PricingProductResolver`. Die
 * Inklusiv-Packs (25 Becher + 25 Strohhalme je Mietvorgang) werden hier über die
 * Domain-Slugs aufgelöst – kein Aufrufer kennt die Slugs selbst.
 *
 * Keine Fachregel wird hier geprüft: Gratis-Kontingent, Kanisterlimit, Kommission und
 * Inklusiv-Positionen entscheidet ausschließlich `priceOffer`.
 */

import {
  CUPS_PACK_SLUG,
  STRAWS_PACK_SLUG,
  type PricingInput,
  type PricingProduct,
  type PricingSelection,
  type SpecialPriceEntry,
} from './pricing.ts';

/** Fachliche Auswahl mit Produktreferenzen (`Ref` = Produkt-ID oder Slug, je Aufrufer). */
export interface PricingSelectionRequest<Ref> {
  machine: { ref: Ref; quantity: number } | null;
  selections: readonly { ref: Ref; role: 'free' | 'extra'; quantity: number }[];
  fulfillment: 'pickup' | 'delivery';
  deliveryPriceCents?: number | null;
  discount?: PricingInput['discount'];
  specialPrices?: readonly SpecialPriceEntry[];
  voucher?: PricingInput['voucher'];
}

/** Produktauflösung des Aufrufers (zum Berechnungszeitpunkt, mit wirksamem Listenpreis). */
export interface PricingProductResolver<Ref> {
  /** Produkt einer Auswahlposition; wirft, wenn es nicht auflösbar ist. */
  product(ref: Ref): Promise<PricingProduct>;
  /** Inklusiv-Pack per Slug; `null`, wenn es nicht (mehr) gepflegt ist. */
  includedPack(slug: string): Promise<PricingProduct | null>;
}

/**
 * Baut die `PricingInput` in fester Reihenfolge (Maschine, Auswahl in Eingabe-
 * reihenfolge, Becher, Strohhalme) – sequentiell, damit Aufrufer innerhalb EINER
 * Transaktion (eine Verbindung) auflösen können.
 */
export async function resolvePricingInput<Ref>(
  request: PricingSelectionRequest<Ref>,
  resolver: PricingProductResolver<Ref>,
): Promise<PricingInput> {
  const machine =
    request.machine === null
      ? null
      : {
          product: await resolver.product(request.machine.ref),
          quantity: request.machine.quantity,
        };
  const selections: PricingSelection[] = [];
  for (const selection of request.selections) {
    selections.push({
      product: await resolver.product(selection.ref),
      role: selection.role,
      quantity: selection.quantity,
    });
  }
  const cupsProduct = await resolver.includedPack(CUPS_PACK_SLUG);
  const strawsProduct = await resolver.includedPack(STRAWS_PACK_SLUG);
  return {
    machine,
    cupsProduct,
    strawsProduct,
    selections,
    fulfillment: request.fulfillment,
    ...(request.deliveryPriceCents === undefined
      ? {}
      : { deliveryPriceCents: request.deliveryPriceCents }),
    ...(request.discount === undefined ? {} : { discount: request.discount }),
    ...(request.specialPrices === undefined ? {} : { specialPrices: request.specialPrices }),
    ...(request.voucher === undefined ? {} : { voucher: request.voucher }),
  };
}
