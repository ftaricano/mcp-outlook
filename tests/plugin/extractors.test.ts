import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  createExtractionGate,
  extractAttachmentText,
  ExtractionError,
  runAttachmentPipeline,
  runIsolatedWorker,
} from '../../src/plugin/extractors.js';

// extractAttachmentText now delegates all real parsing to a compiled worker
// (src/plugin/extractionWorker.ts -> dist/plugin/extractionWorker.js) so that
// hostile input is isolated by worker_threads resourceLimits, not just a
// Promise.race in the main process. Node's worker_threads loads that file by
// URL and does not go through vitest's TS transform, so the format-detection
// tests below need the real build artifact — see tests/globalSetup.ts, which
// builds it once before any test file runs. This is a deliberate trade-off
// (see JAR-782 fix notes): the mechanism tests further down (timeout / crash
// handling) exercise `runIsolatedWorker` directly against small plain-JS
// fixture workers instead, so they run fast on any Node version without
// depending on the build.

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
    const result = await extractAttachmentText(
      MINIMAL_PDF,
      'arquivo.tmp',
      'application/octet-stream',
      10_000
    );
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
    const result = await extractAttachmentText(
      Buffer.from('linha 1\nlinha 2'),
      'notas.txt',
      'text/plain',
      10_000
    );
    expect(result.extractor).toBe('text');
    expect(result.text).toContain('linha 2');
  });

  it('truncates output at maxChars and flags it', async () => {
    const result = await extractAttachmentText(
      Buffer.from('x'.repeat(500)),
      'big.txt',
      'text/plain',
      100
    );
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('rejects unsupported binary formats with a stable code', async () => {
    await expect(
      extractAttachmentText(
        Buffer.from([0x00, 0x01, 0x02]),
        'blob.bin',
        'application/octet-stream',
        10_000
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('maps parser crashes to EXTRACTION_FAILED without leaking parser text', async () => {
    const corruptPdf = Buffer.from('%PDF-1.4 garbage');
    await expect(
      extractAttachmentText(corruptPdf, 'corrupt.pdf', 'application/pdf', 10_000)
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  // The pre-scan reports which cap tripped instead of a generic failure: a
  // container cap set too low for a legitimate document must not read as
  // "this file is corrupt".
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
    ).rejects.toMatchObject({ code: 'ZIP_TOO_MANY_ENTRIES' });
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
    ).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });
});

describe('runAttachmentPipeline raw mode cap', () => {
  const zipLimits = { maxEntries: 200, maxUncompressedBytes: 50 * 1024 * 1024 };

  it('returns the caller buffer itself for non-container raw mode, proving it never crossed a thread boundary', async () => {
    const buffer = Buffer.from('bytes que nao precisam de parser');
    const result = await runAttachmentPipeline({
      buffer,
      name: 'nota.bin',
      contentType: 'application/octet-stream',
      maxChars: 10_000,
      mode: 'raw',
      zipLimits,
      maxRawBytes: 256 * 1024,
    });

    // structuredClone through workerData would hand back a copy; identity here
    // is the observable proof that the short-circuit skipped the worker.
    expect(result).toMatchObject({ kind: 'raw' });
    expect((result as { bytes: Buffer }).bytes).toBe(buffer);
  });

  it('rejects raw mode above maxRawBytes with a stable code, before any thread transfer', async () => {
    await expect(
      runAttachmentPipeline({
        buffer: Buffer.alloc(300 * 1024),
        name: 'big.bin',
        contentType: 'application/octet-stream',
        maxChars: 10_000,
        mode: 'raw',
        zipLimits,
        maxRawBytes: 256 * 1024,
      })
    ).rejects.toMatchObject({ code: 'RAW_TOO_LARGE' });
  });

  it('accepts raw mode content within maxRawBytes', async () => {
    const result = await runAttachmentPipeline({
      buffer: Buffer.from('pequeno'),
      name: 'nota.txt',
      contentType: 'text/plain',
      maxChars: 10_000,
      mode: 'raw',
      zipLimits,
      maxRawBytes: 256 * 1024,
    });
    expect(result.kind).toBe('raw');
  });

  it('is not affected by the raw cap in text mode: only maxExtractedChars applies', async () => {
    const result = await runAttachmentPipeline({
      buffer: Buffer.from('x'.repeat(500)),
      name: 'big.txt',
      contentType: 'text/plain',
      maxChars: 100,
      mode: 'text',
      zipLimits,
      maxRawBytes: 10,
    });
    expect(result.kind).toBe('text');
  });

  it('rejects a raw-mode zip entry whose real content vastly exceeds the raw cap without inflating up to the zip limit', async () => {
    const { buildZip } = await import('./helpers.js');
    const zip = await buildZip({ 'bomba.txt': 'z'.repeat(1024 * 1024) });
    const started = Date.now();
    await expect(
      runAttachmentPipeline({
        buffer: zip,
        name: 'pacote.zip',
        contentType: 'application/zip',
        maxChars: 10_000,
        mode: 'raw',
        entry: 'bomba.txt',
        zipLimits: { maxEntries: 200, maxUncompressedBytes: 50 * 1024 * 1024 },
        maxRawBytes: 1024,
      })
    ).rejects.toMatchObject({ code: 'RAW_TOO_LARGE' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('createExtractionGate', () => {
  it('never runs more than maxConcurrent tasks at once', async () => {
    const gate = createExtractionGate(2, 16);
    let active = 0;
    let peak = 0;

    const task = () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects with EXTRACTION_BUSY once the wait queue is full instead of growing it unbounded', async () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const gate = createExtractionGate(1, 1);
    const first = deferred();
    const second = deferred();

    const firstRun = gate.run(() => first.promise); // takes the only active slot
    const secondRun = gate.run(() => second.promise); // queues (queue now full: 1/1)
    await expect(gate.run(async () => {})).rejects.toMatchObject({ code: 'EXTRACTION_BUSY' });

    first.resolve();
    await firstRun;
    second.resolve();
    await secondRun;
  });
});

describe('runIsolatedWorker', () => {
  it('terminates a hung worker and rejects EXTRACTION_TIMEOUT without waiting out the real production timeout', async () => {
    const hangingWorkerUrl = new URL('../fixtures/hanging-worker.mjs', import.meta.url);
    await expect(runIsolatedWorker(hangingWorkerUrl, {}, 200)).rejects.toMatchObject({
      code: 'EXTRACTION_TIMEOUT',
    });
  });

  it('maps a worker that exits non-zero without posting a message to EXTRACTION_FAILED', async () => {
    const crashingWorkerUrl = new URL('../fixtures/crashing-worker.mjs', import.meta.url);
    await expect(runIsolatedWorker(crashingWorkerUrl, {}, 5_000)).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
    });
  });

  it('maps an uncaught worker error to EXTRACTION_FAILED without leaking the underlying message', async () => {
    const throwingWorkerUrl = new URL('../fixtures/throwing-worker.mjs', import.meta.url);
    const rejection = await runIsolatedWorker(throwingWorkerUrl, {}, 5_000).catch(
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(ExtractionError);
    expect((rejection as ExtractionError).code).toBe('EXTRACTION_FAILED');
    expect((rejection as ExtractionError).message).not.toContain('boom');
  });
});
