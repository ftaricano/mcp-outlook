import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { extractAttachmentText } from '../../src/plugin/extractors.js';

const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 720 Td (FATURA 12345) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`,
  'latin1'
);

async function xlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Plan1');
  sheet.addRow(['apolice', 'competencia', 'premio']);
  sheet.addRow(['123456', '05/2026', 1500.5]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('extractAttachmentText', () => {
  it('extracts text from a PDF, detected by header even with a .tmp name', async () => {
    const result = await extractAttachmentText(MINIMAL_PDF, 'arquivo.tmp', 'application/octet-stream', 10_000);
    expect(result.extractor).toBe('pdf');
    expect(result.text).toContain('FATURA 12345');
  });

  it('extracts rows from an xlsx as tab-separated lines', async () => {
    const result = await extractAttachmentText(
      await xlsxBuffer(),
      'planilha.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      10_000
    );
    expect(result.extractor).toBe('xlsx');
    expect(result.text).toContain('123456');
    expect(result.text).toContain('05/2026');
  });

  it('passes plain text through with charset decoding', async () => {
    const result = await extractAttachmentText(Buffer.from('linha 1\nlinha 2'), 'notas.txt', 'text/plain', 10_000);
    expect(result.extractor).toBe('text');
    expect(result.text).toContain('linha 2');
  });

  it('truncates output at maxChars and flags it', async () => {
    const result = await extractAttachmentText(Buffer.from('x'.repeat(500)), 'big.txt', 'text/plain', 100);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('rejects unsupported binary formats with a stable code', async () => {
    await expect(
      extractAttachmentText(Buffer.from([0x00, 0x01, 0x02]), 'blob.bin', 'application/octet-stream', 10_000)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('maps parser crashes to EXTRACTION_FAILED without leaking parser text', async () => {
    const corruptPdf = Buffer.from('%PDF-1.4 garbage');
    await expect(
      extractAttachmentText(corruptPdf, 'corrupt.pdf', 'application/pdf', 10_000)
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  it('rejects an xlsx container that fails the pre-scan cap without invoking ExcelJS', async () => {
    const buffer = await xlsxBuffer();
    await expect(
      extractAttachmentText(
        buffer,
        'planilha.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        10_000,
        { maxEntries: 1, maxUncompressedBytes: 100 * 1024 * 1024 }
      )
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  it('rejects an xlsx container whose real content exceeds the pre-scan byte cap', async () => {
    const buffer = await xlsxBuffer();
    await expect(
      extractAttachmentText(
        buffer,
        'planilha.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        10_000,
        { maxEntries: 1_000, maxUncompressedBytes: 1 }
      )
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });
});
