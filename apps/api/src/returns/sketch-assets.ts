import type { DamageSketchImages } from '@mietroyal/documents';

/**
 * Asset-Schnittstelle für Schadensgrafiken (Order §30): je Produkt-Slug
 * (Maschinentyp) und Ansicht eine eigene Grafik (PNG/JPEG). Solange keine
 * finalen Miet-Royal-Zeichnungen vorliegen, bleibt die Tabelle leer und PDF
 * wie Staff-UI zeichnen den neutralen schematischen Platzhalter. Die
 * Markierungsdaten (normalisierte Koordinaten) sind davon unabhängig – echte
 * Grafiken werden später ohne Datenmigration hinterlegt.
 */
export const MACHINE_SKETCH_ASSETS: Readonly<Record<string, DamageSketchImages>> = {};

export function sketchImagesFor(productSlug: string | null): DamageSketchImages | undefined {
  if (productSlug === null) return undefined;
  return MACHINE_SKETCH_ASSETS[productSlug];
}
