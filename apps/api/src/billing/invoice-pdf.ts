import { microsToDecimal } from '@wacrm/shared';
import PDFDocument from 'pdfkit';

export interface InvoicePdfInput {
  number: string;
  issuedAt: Date;
  description: string;
  currency: string;
  subtotalMicros: number;
  taxMicros: number;
  taxRateBps: number;
  taxLabel: string | null;
  totalMicros: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  billTo: {
    name?: string | null;
    email?: string | null;
    address?: string | null;
    country?: string | null;
    taxId?: string | null;
  };
  seller: { name: string; address: string | null; taxId: string | null };
}

/** The currency code rather than a symbol: the built-in PDF fonts have no rupee sign. */
const money = (micros: number, currency: string) => {
  const [whole = '0', fraction = ''] = microsToDecimal(micros).split('.');
  const grouped = Number(whole).toLocaleString('en-US');
  return `${currency} ${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Built from the stored row, so the same invoice always renders the same figures. */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: input.number } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = 545;
    const taxName = input.taxLabel ?? 'Tax';

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(input.taxLabel ? 'Tax invoice' : 'Invoice', left);
    doc.font('Helvetica').fontSize(10).fillColor('#444444');
    doc.text(`Number: ${input.number}`);
    doc.text(`Date: ${day(input.issuedAt)}`);
    doc.moveDown(1.5);

    const top = doc.y;
    const block = (x: number, title: string, lines: (string | null | undefined)[]) => {
      doc.fillColor('#000000').font('Helvetica-Bold').text(title, x, top, { width: 230 });
      doc.font('Helvetica').fillColor('#444444');
      for (const line of lines) if (line) doc.text(line, x, undefined, { width: 230 });
      return doc.y;
    };
    const afterSeller = block(left, 'From', [
      input.seller.name,
      input.seller.address,
      input.seller.taxId ? `Tax ID: ${input.seller.taxId}` : null,
    ]);
    const afterBuyer = block(310, 'Bill to', [
      input.billTo.name,
      input.billTo.address,
      input.billTo.country,
      input.billTo.email,
      input.billTo.taxId ? `Tax ID: ${input.billTo.taxId}` : null,
    ]);
    doc.y = Math.max(afterSeller, afterBuyer) + 30;

    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000000');
      doc.text(label, left, y, { width: 320 });
      doc.text(value, 370, y, { width: right - 370, align: 'right' });
      doc.moveDown(0.6);
    };
    const rule = () => {
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.6);
    };

    row('Description', 'Amount', true);
    rule();
    const period =
      input.periodStart && input.periodEnd
        ? ` (${day(input.periodStart)} to ${day(input.periodEnd)})`
        : '';
    row(`${input.description}${period}`, money(input.subtotalMicros, input.currency));
    rule();
    row('Subtotal', money(input.subtotalMicros, input.currency));
    row(
      input.taxRateBps ? `${taxName} (${input.taxRateBps / 100}%)` : taxName,
      money(input.taxMicros, input.currency),
    );
    row('Total paid', money(input.totalMicros, input.currency), true);

    doc.end();
  });
}
