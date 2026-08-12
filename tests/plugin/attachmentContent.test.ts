import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';
import { buildXlsx, buildZip, config, MINIMAL_PDF, stubEmailService } from './helpers.js';

function attachmentStub(content: Buffer, name: string, contentType: string) {
  return {
    downloadAttachment: vi.fn(async () => ({
      name,
      contentType,
      content: content.toString('base64'),
      size: content.length,
    })),
  };
}

describe('getAttachmentContent', () => {
  it('extracts text from a pdf attachment by default', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(MINIMAL_PDF, 'fatura.pdf', 'application/pdf'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' });
    expect(result.kind).toBe('text');
    expect(result.text).toContain('FATURA 12345');
  });

  it('returns base64 in raw mode within the raw cap', async () => {
    const small = Buffer.from('pequeno');
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(small, 'nota.txt', 'text/plain'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'raw' });
    expect(result.kind).toBe('raw');
    expect(Buffer.from(result.base64!, 'base64').toString()).toBe('pequeno');
  });

  it('rejects raw mode above maxRawAttachmentBytes with a stable code', async () => {
    const big = Buffer.alloc(300 * 1024);
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(big, 'big.bin', 'application/octet-stream'))
    );
    await expect(
      service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'raw' })
    ).rejects.toMatchObject({ code: 'RAW_TOO_LARGE' });
  });

  it('rejects any attachment above maxAttachmentInputBytes before touching parsers', async () => {
    const service = new MultiMailboxService(config({ maxAttachmentInputBytes: 1024 }), () =>
      stubEmailService(attachmentStub(Buffer.alloc(2048), 'big.pdf', 'application/pdf'))
    );
    await expect(
      service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('lists zip entries when the attachment is a zip and no entry is given', async () => {
    const zip = await buildZip({ 'GRUPO/fatura.pdf': '%PDF x' });
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(zip, 'pacote.zip', 'application/zip'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' });
    expect(result.kind).toBe('zip_listing');
    expect(result.zipEntries?.[0].name).toBe('GRUPO/fatura.pdf');
  });

  it('extracts a many-sheet workbook whose part count exceeds the user-facing zip entry cap', async () => {
    const xlsx = await buildXlsx(12);
    const service = new MultiMailboxService(
      config({ maxZipEntries: 3, maxContainerEntries: 1_000 }),
      () =>
        stubEmailService(
          attachmentStub(
            xlsx,
            'planilha.xlsx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
        )
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' });
    expect(result.kind).toBe('text');
    expect(result.extractor).toBe('xlsx');
    expect(result.text).toContain('valor-12');
  });

  it('reports a tripped container cap with its own code, not a generic extraction failure', async () => {
    const xlsx = await buildXlsx(12);
    const service = new MultiMailboxService(config({ maxContainerEntries: 2 }), () =>
      stubEmailService(
        attachmentStub(
          xlsx,
          'planilha.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
      )
    );
    await expect(
      service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_MANY_ENTRIES' });
  });

  it('reports zip entries withheld from the listing rather than returning a clean short list', async () => {
    const zip = await buildZip({ 'dir/antigo.txt': 'x', 'ok.txt': 'y' });
    const legacy = Buffer.from(
      zip.toString('latin1').split('dir/antigo.txt').join('dir\\antigo.txt'),
      'latin1'
    );
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(legacy, 'pacote.zip', 'application/zip'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' });
    expect(result.kind).toBe('zip_listing');
    expect(result.zipEntries?.map((entry) => entry.name)).toEqual(['ok.txt']);
    expect(result.hiddenEntries).toBe(1);
  });

  it('extracts a zip entry and pipes it through text extraction', async () => {
    const zip = await buildZip({ 'nota.txt': 'conteudo da nota' });
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(zip, 'pacote.zip', 'application/zip'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', {
      mode: 'text',
      entry: 'nota.txt',
    });
    expect(result.kind).toBe('text');
    expect(result.text).toContain('conteudo da nota');
    expect(result.entry).toBe('nota.txt');
  });

  it('rejects a zip entry in raw mode whose real content vastly exceeds maxRawAttachmentBytes, without inflating up to the (much larger) zip cap', async () => {
    const zip = await buildZip({ 'bomba.txt': 'z'.repeat(1024 * 1024) });
    const service = new MultiMailboxService(
      config({ maxRawAttachmentBytes: 1024, maxZipUncompressedBytes: 50 * 1024 * 1024 }),
      () => stubEmailService(attachmentStub(zip, 'pacote.zip', 'application/zip'))
    );
    const started = Date.now();
    await expect(
      service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'raw', entry: 'bomba.txt' })
    ).rejects.toMatchObject({ code: 'RAW_TOO_LARGE' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects a hostile zip entry whose real content exceeds the cap without materializing it', async () => {
    const zip = await buildZip({ 'bomba.txt': 'z'.repeat(1024 * 1024) });
    const service = new MultiMailboxService(config({ maxZipUncompressedBytes: 10 }), () =>
      stubEmailService(attachmentStub(zip, 'pacote.zip', 'application/zip'))
    );
    await expect(
      service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text', entry: 'bomba.txt' })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });

  it('routes zip handling entirely through the isolated worker, never through zipArchive on the main thread', async () => {
    const source = readFileSync(
      new URL('../../src/plugin/MultiMailboxService.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/zipArchive\.js/);

    const zip = await buildZip({ 'nota.txt': 'conteudo da nota' });
    const service = new MultiMailboxService(config(), () =>
      stubEmailService(attachmentStub(zip, 'pacote.zip', 'application/zip'))
    );
    const result = await service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' });
    expect(result.kind).toBe('zip_listing');
  });

  it('serializes concurrent extractions under a tight maxConcurrentExtractions instead of failing them', async () => {
    const service = new MultiMailboxService(config({ maxConcurrentExtractions: 1 }), () =>
      stubEmailService(attachmentStub(MINIMAL_PDF, 'fatura.pdf', 'application/pdf'))
    );
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.getAttachmentContent('finance', 'm1', 'a1', { mode: 'text' })
      )
    );
    expect(results.every((result) => result.kind === 'text')).toBe(true);
  });
});
