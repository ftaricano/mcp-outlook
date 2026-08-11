import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';

describe('EmailService.downloadAttachmentToFile byte budget', () => {
  it('rejects real decoded bytes before the file manager writes', async () => {
    const saveAttachmentToDisk = vi.fn();
    const service = Object.create(EmailService.prototype) as any;
    service.downloadAttachment = vi.fn(async () => ({
      name: 'report.pdf',
      contentType: 'application/pdf',
      content: Buffer.alloc(11).toString('base64'),
      size: 1,
    }));
    service.fileManager = { saveAttachmentToDisk };

    const result = await service.downloadAttachmentToFile('m1', 'a1', { maxBytes: 10 });

    expect(result).toMatchObject({ success: false, savedSize: 0, originalSize: 11 });
    expect(saveAttachmentToDisk).not.toHaveBeenCalled();
  });
});
