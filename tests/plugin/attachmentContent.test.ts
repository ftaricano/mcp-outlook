import { describe, expect, it, vi } from 'vitest';
import { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';
import { buildZip, config, MINIMAL_PDF, stubEmailService } from './helpers.js';

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
});
