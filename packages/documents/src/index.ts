/**
 * Dokumenterzeugung: serverseitige PDF-Templates für Angebot,
 * Auftragsbestätigung (Phase 3), Lieferschein und Übergabeprotokoll
 * (Phase 6). Spätere Typen (Rückgabeprotokoll) nutzen dieselben Bausteine.
 */
export {
  formatEuro,
  renderDeliveryNotePdf,
  renderHandoverProtocolPdf,
  SignatureImageError,
  renderOfferPdf,
  renderOrderConfirmationPdf,
  type DeliveryNotePdfData,
  type HandoverProtocolPdfData,
  type HandoverSignatureBlock,
  type OfferPdfData,
  type OrderConfirmationPdfData,
  type PdfLineItem,
} from './pdf.ts';
