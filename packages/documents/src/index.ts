/**
 * Dokumenterzeugung: serverseitige PDF-Templates für Angebot,
 * Auftragsbestätigung (Phase 3), Lieferschein und Übergabeprotokoll
 * (Phase 6) und Rückgabeprotokoll (Phase 7) mit neutralem Maschinenschema.
 */
export {
  formatEuro,
  renderDeliveryNotePdf,
  renderHandoverProtocolPdf,
  renderReturnProtocolPdf,
  PhotoImageError,
  SignatureImageError,
  renderOfferPdf,
  renderOrderConfirmationPdf,
  type DeliveryNotePdfData,
  type HandoverProtocolPdfData,
  type HandoverSignatureBlock,
  type DamageMarkerShape,
  type DamageSketchData,
  type DamageSketchImages,
  type ReturnProtocolPdfData,
  type ReturnProtocolMachineSection,
  type ReturnProtocolDamage,
  type ReturnProtocolCommissionLine,
  type OfferPdfData,
  type OrderConfirmationPdfData,
  type PdfLineItem,
} from './pdf.ts';
