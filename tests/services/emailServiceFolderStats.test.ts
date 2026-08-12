import { describe, expect, it } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';

// JAR-988 (W1): the plugin-layer regression test for get_folder_stats mocks
// MultiMailboxService.getFolderStats directly with the already-correct
// shape, so it never exercises the real EmailService.getFolderStatistics
// implementation against a Graph response. This test does — a rename of any
// of these field names in getFolderStatistics would fail here even if the
// plugin-layer mock were (incorrectly) left matching the old names.
describe('EmailService.getFolderStatistics', () => {
  it('returns the real field names computed from the Graph folder + messages responses', async () => {
    const api = (url: string) => ({
      select: () => ({
        top: () => ({
          get: async () => {
            if (url.includes('/messages')) {
              return {
                value: [
                  { receivedDateTime: '2026-01-05T10:00:00Z', hasAttachments: true },
                  { receivedDateTime: '2026-01-01T10:00:00Z', hasAttachments: false },
                ],
              };
            }
            throw new Error(`unexpected select().top() url in test: ${url}`);
          },
        }),
      }),
      get: async () => {
        if (url.endsWith('/mailFolders/inbox')) {
          return { displayName: 'Inbox', totalItemCount: 10, unreadItemCount: 3 };
        }
        throw new Error(`unexpected url in test: ${url}`);
      },
    });
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const stats = await service.getFolderStatistics('inbox', false);

    expect(stats).toMatchObject({
      folderName: 'Inbox',
      totalEmails: 10,
      unreadEmails: 3,
      readEmails: 7,
      emailsWithAttachments: 1,
    });
    expect(stats.dateRange).toBeTruthy();
    expect(stats).not.toHaveProperty('totalItems');
    expect(stats).not.toHaveProperty('unreadItems');
    expect(stats).not.toHaveProperty('sizeInBytes');
  });

  it('follows message nextLink and returns pagination evidence', async () => {
    const pages = new Map<string, unknown>([
      [
        '/users/user@example.com/mailFolders/inbox/messages',
        {
          value: [{ receivedDateTime: '2026-01-01T10:00:00Z', hasAttachments: false }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/folder-stats-page-2',
        },
      ],
      [
        'https://graph.microsoft.com/v1.0/folder-stats-page-2',
        { value: [{ receivedDateTime: '2026-01-02T10:00:00Z', hasAttachments: true }] },
      ],
    ]);
    const api = (url: string) => {
      const chain: any = {
        select: () => chain,
        top: () => chain,
        get: async () => {
          if (url.endsWith('/mailFolders/inbox')) {
            return { displayName: 'Inbox', totalItemCount: 2, unreadItemCount: 0 };
          }
          return pages.get(url);
        },
      };
      return chain;
    };
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const stats = await service.getFolderStatistics('inbox', false);

    expect(stats).toMatchObject({
      emailsWithAttachments: 1,
      messagesScanned: 2,
      pagesScanned: 2,
      truncated: false,
    });
  });

  it('marks attachment and date statistics truncated when the message cap is reached', async () => {
    const api = (url: string) => {
      const chain: any = {
        select: () => chain,
        top: () => chain,
        get: async () => {
          if (url.endsWith('/mailFolders/inbox')) {
            return { displayName: 'Inbox', totalItemCount: 1001, unreadItemCount: 0 };
          }
          return {
            value: Array.from({ length: 1000 }, () => ({
              receivedDateTime: '2026-01-01T10:00:00Z',
              hasAttachments: false,
            })),
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/not-fetched',
          };
        },
      };
      return chain;
    };
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    service.targetUserEmail = 'user@example.com';

    const stats = await service.getFolderStatistics('inbox', false);

    expect(stats).toMatchObject({ messagesScanned: 1000, pagesScanned: 1, truncated: true });
  });
});
