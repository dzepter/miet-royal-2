/**
 * Serverseitige PDF-Erzeugung (Phase-3-Vorgaben Nr. 34/35): kein
 * Webseiten-Screenshot, sondern echte Dokumente aus den eingefrorenen
 * Snapshot-Daten. Neutrales, professionelles Template – finales
 * Miet-Royal-Branding folgt später.
 *
 * Steuerhinweis (Vorgabe Nr. 9): Die umsatzsteuerliche Behandlung ist noch
 * NICHT konfiguriert – es wird bewusst KEIN Steuersatz ausgewiesen.
 */
import PDFDocument from 'pdfkit';

export interface PdfLineItem {
  description: string;
  quantity: number;
  unit: string;
  agreedUnitPriceCents: number;
  totalCents: number;
  billingMode: 'fixed' | 'commission' | 'included';
}

export interface OfferPdfData {
  processNumber: string;
  versionNumber: number;
  customerName: string;
  customerAddressLines: string[];
  eventDateLabel: string;
  eventTimeLabel: string | null;
  fulfillmentLabel: string;
  lineItems: PdfLineItem[];
  machineSubtotalCents: number;
  discountCents: number;
  discountLabel: string | null;
  fixedTotalCents: number;
  commissionMaxCents: number;
  validUntilLabel: string | null;
  termsLabel: string | null;
  termsContent: string | null;
  createdAtLabel: string;
}

export interface OrderConfirmationPdfData {
  processNumber: string;
  customerName: string;
  customerAddressLines: string[];
  eventDateLabel: string;
  eventTimeLabel: string | null;
  fulfillmentLabel: string;
  /** Liefer-/Eventadresse (nur bei Lieferung, aus dem Buchungs-Snapshot). */
  deliveryAddressLines: string[];
  /** Zeitfenster (Liefer-/Abholfenster) aus dem Buchungs-Snapshot. */
  scheduleLines: string[];
  pickupAddress: string | null;
  transportNotes: string[];
  lineItems: PdfLineItem[];
  machineSubtotalCents: number;
  discountCents: number;
  discountLabel: string | null;
  fixedTotalCents: number;
  commissionMaxCents: number;
  acceptedAtLabel: string;
  createdAtLabel: string;
}

export function formatEuro(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const euros = Math.floor(absolute / 100);
  const rest = String(absolute % 100).padStart(2, '0');
  return `${sign}${euros.toLocaleString('de-DE')},${rest} €`;
}

const MARGIN = 50;

function renderDocument(build: (doc: PDFKit.PDFDocument) => void, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: title, Author: 'Miet-Royal' },
      // Unkomprimiert: Integritäts-/Inhaltsprüfungen (SHA-256, Tests) können
      // Metadaten und Text direkt im Bytestrom verifizieren.
      compress: false,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, heading: string, processNumber: string): void {
  doc.fontSize(20).font('Helvetica-Bold').text('Miet-Royal', { continued: false });
  doc.fontSize(9).font('Helvetica').fillColor('#555555').text('Slush-Maschinen-Vermietung');
  doc.moveDown(1.2);
  doc.fillColor('#000000').fontSize(16).font('Helvetica-Bold').text(heading);
  doc.fontSize(10).font('Helvetica').text(`Vorgang ${processNumber}`);
  doc.moveDown(0.8);
}

function itemsTable(doc: PDFKit.PDFDocument, items: PdfLineItem[]): void {
  const startX = MARGIN;
  const widths = { description: 250, quantity: 70, unitPrice: 85, total: 90 };
  const rowHeight = 18;

  doc.font('Helvetica-Bold').fontSize(9);
  let y = doc.y;
  doc.text('Position', startX, y, { width: widths.description });
  doc.text('Menge', startX + widths.description, y, { width: widths.quantity, align: 'right' });
  doc.text('Einzelpreis', startX + widths.description + widths.quantity, y, {
    width: widths.unitPrice,
    align: 'right',
  });
  doc.text('Gesamt', startX + widths.description + widths.quantity + widths.unitPrice, y, {
    width: widths.total,
    align: 'right',
  });
  y += rowHeight;
  doc
    .moveTo(startX, y - 4)
    .lineTo(startX + 495, y - 4)
    .strokeColor('#999999')
    .stroke();

  doc.font('Helvetica').fontSize(9);
  for (const item of items) {
    const descriptionHeight = doc.heightOfString(item.description, {
      width: widths.description,
    });
    if (y + descriptionHeight > doc.page.height - MARGIN - 40) {
      doc.addPage();
      y = MARGIN;
    }
    doc.text(item.description, startX, y, { width: widths.description });
    doc.text(`${item.quantity} ${item.unit}`, startX + widths.description, y, {
      width: widths.quantity,
      align: 'right',
    });
    const unitLabel =
      item.billingMode === 'included' ? 'inklusive' : formatEuro(item.agreedUnitPriceCents);
    const totalLabel =
      item.billingMode === 'included'
        ? '0,00 €'
        : item.billingMode === 'commission'
          ? `${formatEuro(item.totalCents)}*`
          : formatEuro(item.totalCents);
    doc.text(unitLabel, startX + widths.description + widths.quantity, y, {
      width: widths.unitPrice,
      align: 'right',
    });
    doc.text(totalLabel, startX + widths.description + widths.quantity + widths.unitPrice, y, {
      width: widths.total,
      align: 'right',
    });
    y += Math.max(rowHeight, descriptionHeight + 4);
  }
  doc.y = y + 6;
  doc.x = MARGIN;
}

function totals(
  doc: PDFKit.PDFDocument,
  data: {
    machineSubtotalCents?: number;
    discountCents: number;
    discountLabel?: string | null;
    fixedTotalCents: number;
    commissionMaxCents: number;
  },
): void {
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10);
  if (data.discountCents > 0) {
    if (data.machineSubtotalCents !== undefined) {
      doc.text(`Maschinenmiete: ${formatEuro(data.machineSubtotalCents)}`, { align: 'right' });
    }
    doc.text(
      `Rabatt${data.discountLabel ? ` (${data.discountLabel})` : ''}: -${formatEuro(data.discountCents)}`,
      { align: 'right' },
    );
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(`Fester Angebotswert: ${formatEuro(data.fixedTotalCents)}`, { align: 'right' });
  if (data.commissionMaxCents > 0) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#555555')
      .text(
        `* Kommissionsartikel (Abrechnung nach tatsächlichem Verbrauch, erfolgt nach der Rückgabe), maximal: ${formatEuro(
          data.commissionMaxCents,
        )}. Ungeöffnete Sirupflaschen werden nicht berechnet.`,
        { align: 'right' },
      )
      .fillColor('#000000');
  }
  doc.moveDown(0.5);
}

export function renderOfferPdf(data: OfferPdfData): Promise<Buffer> {
  return renderDocument((doc) => {
    header(doc, `Angebot – Version ${data.versionNumber}`, data.processNumber);
    doc.font('Helvetica-Bold').fontSize(10).text(data.customerName);
    doc.font('Helvetica').fontSize(10);
    for (const line of data.customerAddressLines) doc.text(line);
    doc.moveDown(0.6);
    doc.text(`Eventdatum: ${data.eventDateLabel}`);
    if (data.eventTimeLabel !== null) doc.text(`Zeitraum: ${data.eventTimeLabel}`);
    doc.text(`Abwicklung: ${data.fulfillmentLabel}`);
    doc.text(`Erstellt am: ${data.createdAtLabel}`);
    doc.moveDown(1);

    itemsTable(doc, data.lineItems);
    totals(doc, data);

    if (data.validUntilLabel !== null) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`Dieses Angebot ist gültig bis ${data.validUntilLabel}.`);
    }
    doc.moveDown(0.8);
    if (data.termsContent !== null) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(`Mietbedingungen${data.termsLabel ? ` (${data.termsLabel})` : ''}`);
      doc.font('Helvetica').fontSize(8).fillColor('#555555').text(data.termsContent);
      doc.fillColor('#000000');
    }
  }, `Angebot ${data.processNumber} V${data.versionNumber}`);
}

export function renderOrderConfirmationPdf(data: OrderConfirmationPdfData): Promise<Buffer> {
  return renderDocument((doc) => {
    header(doc, 'Auftragsbestätigung', data.processNumber);
    doc.font('Helvetica-Bold').fontSize(10).text(data.customerName);
    doc.font('Helvetica').fontSize(10);
    for (const line of data.customerAddressLines) doc.text(line);
    doc.moveDown(0.6);
    doc.text(`Eventdatum: ${data.eventDateLabel}`);
    if (data.eventTimeLabel !== null) doc.text(`Zeitraum: ${data.eventTimeLabel}`);
    doc.text(`Abwicklung: ${data.fulfillmentLabel}`);
    for (const line of data.deliveryAddressLines) doc.text(line);
    for (const line of data.scheduleLines) doc.text(line);
    doc.text(`Angebot verbindlich angenommen am: ${data.acceptedAtLabel}`);
    doc.text(`Erstellt am: ${data.createdAtLabel}`);
    doc.moveDown(1);

    itemsTable(doc, data.lineItems);
    totals(doc, {
      machineSubtotalCents: data.machineSubtotalCents,
      discountCents: data.discountCents,
      discountLabel: data.discountLabel,
      fixedTotalCents: data.fixedTotalCents,
      commissionMaxCents: data.commissionMaxCents,
    });

    if (data.pickupAddress !== null) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(10).text('Abholadresse');
      doc.font('Helvetica').fontSize(10).text(data.pickupAddress);
    }
    if (data.transportNotes.length > 0) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(10).text('Transporthinweise');
      doc.font('Helvetica').fontSize(9);
      for (const note of data.transportNotes) doc.text(`• ${note}`);
    }
  }, `Auftragsbestätigung ${data.processNumber}`);
}
