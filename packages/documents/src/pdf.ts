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

// ── Phase 6: Lieferschein & Übergabeprotokoll (Order §§18/37/38) ──────────

export interface DeliveryNoteMachineLine {
  machineCode: string;
  typeName: string;
}

export interface DeliveryNoteItemLine {
  description: string;
  quantity: number;
  unit: string;
  /** „inklusive“ | „Kommission“ | „Kauf“ */
  kindLabel: string;
}

export interface DeliveryNotePdfData {
  processNumber: string;
  customerName: string;
  customerAddressLines: string[];
  eventDateLabel: string;
  eventTimeLabel: string | null;
  fulfillmentLabel: string;
  deliveryAddressLines: string[];
  scheduleLabel: string | null;
  machines: DeliveryNoteMachineLine[];
  items: DeliveryNoteItemLine[];
  createdAtLabel: string;
  /** Entwurf (Vorschau) oder finales Dokument. */
  isFinal: boolean;
}

export interface HandoverProtocolMachineSection {
  machineCode: string;
  typeName: string;
  checkedLabel: string;
  existingDamagesLines: string[];
  notes: string[];
}

export interface HandoverSignatureBlock {
  /** PNG-Bytes der gezeichneten Unterschrift. */
  png: Uint8Array;
  name: string;
  signedAtLabel: string;
}

export interface HandoverProtocolPdfData {
  processNumber: string;
  customerName: string;
  recipientLabel: string;
  eventDateLabel: string;
  fulfillmentLabel: string;
  machines: HandoverProtocolMachineSection[];
  itemLines: string[];
  customerSignature: HandoverSignatureBlock;
  staffSignature: HandoverSignatureBlock;
  finalizedAtLabel: string;
  /** Interne Dokumentkennung (Übergabe-ID) für die Integritätszuordnung. */
  documentReference: string;
}

function simpleTable(
  doc: PDFKit.PDFDocument,
  columns: { title: string; width: number; align?: 'left' | 'right' }[],
  rows: string[][],
): void {
  const startX = MARGIN;
  const rowHeight = 18;
  doc.font('Helvetica-Bold').fontSize(9);
  let y = doc.y;
  let x = startX;
  for (const column of columns) {
    doc.text(column.title, x, y, { width: column.width, align: column.align ?? 'left' });
    x += column.width;
  }
  y += rowHeight;
  doc
    .moveTo(startX, y - 4)
    .lineTo(startX + columns.reduce((sum, c) => sum + c.width, 0), y - 4)
    .strokeColor('#999999')
    .stroke();
  doc.font('Helvetica').fontSize(9);
  for (const row of rows) {
    const height = Math.max(
      rowHeight,
      ...row.map((cell, index) =>
        doc.heightOfString(cell, { width: columns[index]?.width ?? 100 }),
      ),
    );
    if (y + height > doc.page.height - MARGIN - 40) {
      doc.addPage();
      y = MARGIN;
    }
    x = startX;
    row.forEach((cell, index) => {
      const column = columns[index];
      if (column === undefined) return;
      doc.text(cell, x, y, { width: column.width, align: column.align ?? 'left' });
      x += column.width;
    });
    y += height + 4;
  }
  doc.y = y + 6;
  doc.x = MARGIN;
}

export function renderDeliveryNotePdf(data: DeliveryNotePdfData): Promise<Buffer> {
  return renderDocument((doc) => {
    header(doc, data.isFinal ? 'Lieferschein' : 'Lieferschein (Entwurf)', data.processNumber);
    doc.font('Helvetica-Bold').fontSize(10).text(data.customerName);
    doc.font('Helvetica').fontSize(10);
    for (const line of data.customerAddressLines) doc.text(line);
    doc.moveDown(0.6);
    doc.text(`Eventdatum: ${data.eventDateLabel}`);
    if (data.eventTimeLabel !== null) doc.text(`Zeitraum: ${data.eventTimeLabel}`);
    doc.text(`Abwicklung: ${data.fulfillmentLabel}`);
    for (const line of data.deliveryAddressLines) doc.text(line);
    if (data.scheduleLabel !== null) doc.text(data.scheduleLabel);
    doc.text(`Erstellt am: ${data.createdAtLabel}`);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Maschinen');
    doc.moveDown(0.3);
    simpleTable(
      doc,
      [
        { title: 'Maschinen-ID', width: 160 },
        { title: 'Typ', width: 335 },
      ],
      data.machines.map((machine) => [machine.machineCode, machine.typeName]),
    );

    doc.font('Helvetica-Bold').fontSize(11).text('Artikel');
    doc.moveDown(0.3);
    simpleTable(
      doc,
      [
        { title: 'Position', width: 275 },
        { title: 'Menge', width: 110, align: 'right' },
        { title: 'Art', width: 110, align: 'right' },
      ],
      data.items.map((item) => [item.description, `${item.quantity} ${item.unit}`, item.kindLabel]),
    );
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555555')
      .text(
        'Kommissionsartikel werden nach tatsächlichem Verbrauch abgerechnet (nur ungeöffnet zurückgabefähig). Kaufartikel verbleiben beim Kunden. Preise laut Auftragsbestätigung.',
      )
      .fillColor('#000000');
  }, `Lieferschein ${data.processNumber}`);
}

/** Eine Unterschrift, die pdfkit nicht einbetten kann, ist keine Unterschrift. */
export class SignatureImageError extends Error {
  constructor(title: string) {
    super(`Die Unterschrift „${title}“ ist nicht darstellbar.`);
    this.name = 'SignatureImageError';
  }
}

function signatureBlock(
  doc: PDFKit.PDFDocument,
  title: string,
  block: HandoverSignatureBlock,
): void {
  const x = doc.x;
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).text(title, x, y);
  const imageY = doc.y + 4;
  try {
    doc.image(Buffer.from(block.png), x, imageY, { fit: [220, 80] });
  } catch {
    // Kein Platzhaltertext im finalen Protokoll (Order §37): Abbruch, die
    // Unterschrift muss erneut erfasst werden.
    throw new SignatureImageError(title);
  }
  doc.y = imageY + 84;
  doc.x = x;
  doc
    .moveTo(x, doc.y)
    .lineTo(x + 220, doc.y)
    .strokeColor('#333333')
    .stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).text(`${block.name} · ${block.signedAtLabel}`, x);
}

export function renderHandoverProtocolPdf(data: HandoverProtocolPdfData): Promise<Buffer> {
  return renderDocument((doc) => {
    header(doc, 'Übergabeprotokoll', data.processNumber);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Kunde: ${data.customerName}`);
    doc.text(`Übergabe an: ${data.recipientLabel}`);
    doc.text(`Eventdatum: ${data.eventDateLabel}`);
    doc.text(`Ausgabeart: ${data.fulfillmentLabel}`);
    doc.text(`Übergabe abgeschlossen am: ${data.finalizedAtLabel}`);
    doc.moveDown(1);

    for (const machine of data.machines) {
      if (doc.y > doc.page.height - MARGIN - 140) doc.addPage();
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(`Maschine ${machine.machineCode} – ${machine.typeName}`);
      doc.font('Helvetica').fontSize(9);
      doc.text(`Übergabeprüfung: ${machine.checkedLabel}`);
      doc.text('Bestehende Schäden:');
      for (const line of machine.existingDamagesLines) doc.text(`  • ${line}`);
      for (const note of machine.notes) doc.text(`  ${note}`);
      doc.moveDown(0.6);
    }

    doc.font('Helvetica-Bold').fontSize(11).text('Ausgegebene Artikel');
    doc.font('Helvetica').fontSize(9);
    if (data.itemLines.length === 0) doc.text('Keine Artikel.');
    for (const line of data.itemLines) doc.text(`  • ${line}`);
    doc.moveDown(1);

    if (doc.y > doc.page.height - MARGIN - 200) doc.addPage();
    const top = doc.y;
    doc.x = MARGIN;
    signatureBlock(doc, 'Unterschrift Kunde / Vertreter', data.customerSignature);
    const afterCustomer = doc.y;
    doc.x = MARGIN + 260;
    doc.y = top;
    signatureBlock(doc, 'Unterschrift Mitarbeiter', data.staffSignature);
    doc.y = Math.max(doc.y, afterCustomer) + 12;
    doc.x = MARGIN;

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555555')
      .text(
        `Dokumentkennung ${data.documentReference}. Dieses Dokument ist nach Unterzeichnung unveränderlich; die Integrität wird über einen serverseitig gespeicherten SHA-256-Hash gesichert.`,
      )
      .fillColor('#000000');
  }, `Übergabeprotokoll ${data.processNumber}`);
}
