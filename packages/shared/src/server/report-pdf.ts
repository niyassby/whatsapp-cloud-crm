import PDFDocument from 'pdfkit';
import { formatCell, type ReportDto, reportCurrency, reportTables, reportTitle } from '../reports';

/**
 * A report as a PDF, landscape, one section per table. Uses the built-in Helvetica, so
 * non-Latin text (Hindi names, for example) does not render; the CSV keeps every character.
 */
export function renderReportPdf(report: ReportDto, workspace: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = reportTitle(report);
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 36,
      info: { Title: title },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = reportCurrency(report);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    doc.font('Helvetica-Bold').fontSize(16).text(title);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#555555')
      .text(`${workspace} · times in ${report.period.timezone}`)
      .fillColor('#000000')
      .moveDown(1);

    for (const table of reportTables(report)) {
      if (doc.y > bottom() - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(table.title, left).moveDown(0.3);
      // The first column holds names, so it gets more room.
      const first = Math.min(200, width * 0.28);
      const rest = (width - first) / Math.max(1, table.columns.length - 1);
      const colX = table.columns.map((_, i) => (i === 0 ? left : left + first + (i - 1) * rest));
      const colW = table.columns.map((_, i) => (i === 0 ? first : rest));

      const drawRow = (cells: string[], bold: boolean) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
        const heights = cells.map((c, i) => doc.heightOfString(c, { width: colW[i]! - 4 }));
        const h = Math.max(10, ...heights) + 3;
        if (doc.y + h > bottom()) doc.addPage();
        const y = doc.y;
        cells.forEach((c, i) => {
          doc.text(c, colX[i]!, y, {
            width: colW[i]! - 4,
            align: i === 0 || table.columns[i]!.format === 'text' ? 'left' : 'right',
          });
        });
        doc.y = y + h;
        doc
          .moveTo(left, doc.y - 1.5)
          .lineTo(left + width, doc.y - 1.5)
          .strokeColor('#dddddd')
          .lineWidth(0.5)
          .stroke();
      };

      drawRow(
        table.columns.map((c) => c.label),
        true,
      );
      if (table.rows.length === 0) {
        doc.font('Helvetica').fontSize(8).text('Nothing in this period.', left).moveDown(0.5);
      }
      for (const row of table.rows) {
        drawRow(
          table.columns.map((c) => formatCell(row[c.key] ?? null, c.format, currency)),
          false,
        );
      }
      doc.x = left;
      doc.moveDown(1);
    }
    doc.end();
  });
}
