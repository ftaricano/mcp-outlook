import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';

describe('EmailService.listAttachmentsDetailed', () => {
  it('follows validated nextLink pages and reports complete pagination evidence', async () => {
    const pages = new Map<string, unknown>([
      [
        '/users/user@example.com/messages/m1/attachments',
        {
          value: [{ id: 'a1', name: 'one.txt', size: 1 }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/attachment-page-2',
        },
      ],
      [
        'https://graph.microsoft.com/v1.0/attachment-page-2',
        { value: [{ id: 'a2', name: 'two.txt', size: 2 }] },
      ],
    ]);
    const api = (url: string) => ({ get: async () => pages.get(url) });
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const result = await service.listAttachmentsDetailed('m1', { maxItems: 3, maxPages: 2 });

    expect(result).toMatchObject({ pagesScanned: 2, truncated: false });
    expect(result.items.map((attachment: { id: string }) => attachment.id)).toEqual(['a1', 'a2']);
  });

  it('stops at the item budget and reports truncation', async () => {
    const api = () => ({
      get: async () => ({
        value: [
          { id: 'a1', name: 'one.txt', size: 1 },
          { id: 'a2', name: 'two.txt', size: 2 },
        ],
      }),
    });
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const result = await service.listAttachmentsDetailed('m1', { maxItems: 1, maxPages: 2 });

    expect(result).toMatchObject({ pagesScanned: 1, truncated: true });
    expect(result.items).toHaveLength(1);
  });

  it('requests metadata-only attachment pages without contentBytes', async () => {
    const request: any = {
      select: vi.fn(),
      top: vi.fn(),
      get: vi.fn(async () => ({
        value: [
          {
            id: 'a1',
            name: 'one.txt',
            contentType: 'text/plain',
            size: 1,
            isInline: false,
            contentBytes: 'not-requested',
          },
        ],
      })),
    };
    request.select.mockReturnValue(request);
    request.top.mockReturnValue(request);
    const api = vi.fn(() => request);
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const result = await service.listAttachmentsDetailed('m1', {
      maxItems: 3,
      maxPages: 2,
      metadataOnly: true,
    });

    expect(request.select).toHaveBeenCalledWith('id,name,contentType,size,isInline');
    expect(request.top).toHaveBeenCalledWith(3);
    expect(result.items).toEqual([expect.objectContaining({ id: 'a1', name: 'one.txt', size: 1 })]);
    expect(result.items[0]).not.toHaveProperty('contentBytes');
  });
});
