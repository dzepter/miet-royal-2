/**
 * Dokumenterzeugung (Phase 3): serverseitige PDF-Templates für Angebot und
 * Auftragsbestätigung. Spätere Typen (Lieferschein, Übergabe-/
 * Rückgabeprotokoll) nutzen dieselben Bausteine.
 */
export {
  formatEuro,
  renderOfferPdf,
  renderOrderConfirmationPdf,
  type OfferPdfData,
  type OrderConfirmationPdfData,
  type PdfLineItem,
} from './pdf.ts';
