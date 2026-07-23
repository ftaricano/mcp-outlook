import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';

describe('EmailService.advancedSearchEmailsDetailed', () => {
  it('falls back to a paginated local scan when Graph search matches the canary', async () => {
    const api = vi.fn((url: string) => ({
      get: async () => {
        if (url.includes('$search=')) {
          return {
            value: [{ id: 'same', subject: 'Recent message unrelated to the term' }],
          };
        }
        return {
          value: [
            {
              id: 'match',
              subject: 'Pacote mensal',
              bodyPreview: '',
              body: { content: '' },
              from: { emailAddress: { address: 'sender@example.com' } },
              attachments: [{ name: 'Fatura Cliente Alfa.pdf' }],
            },
          ],
        };
      },
    }));
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const result = await service.advancedSearchEmailsDetailed({
      query: 'Cliente Alfa',
      maxResults: 10,
      maxPages: 5,
      scanLimit: 100,
    });

    expect(result.status).toBe('FOUND');
    expect(result.strategy).toBe('local_scan');
    expect(result.canaryMatched).toBe(true);
    expect(result.messages.map((message: any) => message.id)).toEqual(['match']);
    expect(api.mock.calls.some(([url]) => url.includes('$expand=attachments'))).toBe(true);
  });

  it('pushes a subject filter to Graph before applying the result limit', async () => {
    const getOptimizedEmailsDetailed = vi.fn().mockResolvedValue({
      items: [],
      pagesScanned: 1,
      itemsScanned: 0,
      truncated: false,
      nextLink: undefined,
    });
    const service = Object.create(EmailService.prototype) as any;
    service.graphOptimizer = {
      getOptimizedEmailsDetailed,
      getOptimalFields: vi.fn().mockReturnValue(['id', 'subject']),
    };

    await service.advancedSearchEmailsDetailed({
      subject: "Cliente d'Água",
      maxResults: 10,
      maxPages: 5,
    });

    expect(getOptimizedEmailsDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.stringContaining("contains(subject,'Cliente d''Água')"),
      })
    );
  });

  it('does not impose a 90-day cutoff on a query-only search', async () => {
    const api = vi.fn((url: string) => ({
      get: async () => {
        if (url.includes('$search=')) return { value: [] };
        return {
          value: [
            {
              id: 'old-match',
              subject: 'Historical invoice',
              receivedDateTime: '2025-01-01T12:00:00Z',
            },
          ],
        };
      },
    }));
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const result = await service.advancedSearchEmailsDetailed({
      query: 'historical invoice',
      maxResults: 10,
      maxPages: 5,
      scanLimit: 100,
    });

    expect(result.status).toBe('FOUND');
    const fallbackUrl = api.mock.calls.map(([url]) => url).find((url) => !url.includes('$search='));
    expect(fallbackUrl).not.toContain('$filter=receivedDateTime');
  });

  it('does not create an impossible implicit window when dateTo is provided', async () => {
    const getOptimizedEmailsDetailed = vi.fn().mockResolvedValue({
      items: [],
      pagesScanned: 1,
      itemsScanned: 0,
      truncated: false,
      nextLink: undefined,
    });
    const service = Object.create(EmailService.prototype) as any;
    service.graphOptimizer = {
      getOptimizedEmailsDetailed,
      getOptimalFields: vi.fn().mockReturnValue(['id', 'subject']),
    };

    await service.advancedSearchEmailsDetailed({
      subject: 'invoice',
      dateTo: '2020-12-31T23:59:59Z',
    });

    const { filter } = getOptimizedEmailsDetailed.mock.calls[0][0];
    expect(filter).toContain('receivedDateTime le 2020-12-31T23:59:59Z');
    expect(filter).not.toContain('receivedDateTime ge');
  });

  it('does not impose a hidden cutoff on subject-only searches', async () => {
    const getOptimizedEmailsDetailed = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'old-match',
          subject: 'Historical invoice',
          receivedDateTime: '2025-01-01T12:00:00Z',
        },
      ],
      pagesScanned: 1,
      itemsScanned: 1,
      truncated: false,
      nextLink: undefined,
    });
    const service = Object.create(EmailService.prototype) as any;
    service.graphOptimizer = {
      getOptimizedEmailsDetailed,
      getOptimalFields: vi.fn().mockReturnValue(['id', 'subject', 'receivedDateTime']),
    };

    const result = await service.advancedSearchEmailsDetailed({
      subject: 'Historical invoice',
    });

    expect(result.status).toBe('FOUND');
    expect(getOptimizedEmailsDetailed.mock.calls[0][0].filter).not.toContain('receivedDateTime ge');
  });

  it('scans before applying subject ordering and the result limit', async () => {
    const getOptimizedEmailsDetailed = vi.fn().mockResolvedValue({
      items: [
        { id: 'z', subject: 'Zulu', isRead: false },
        { id: 'y', subject: 'Yankee', isRead: false },
        { id: 'a', subject: 'Alpha', isRead: false },
      ],
      pagesScanned: 1,
      itemsScanned: 3,
      truncated: false,
      nextLink: undefined,
    });
    const service = Object.create(EmailService.prototype) as any;
    service.graphOptimizer = {
      getOptimizedEmailsDetailed,
      getOptimalFields: vi.fn().mockReturnValue(['id', 'subject']),
    };

    const result = await service.advancedSearchEmailsDetailed({
      subject: '',
      isRead: false,
      maxResults: 1,
      scanLimit: 100,
      sortBy: 'subject',
      sortOrder: 'asc',
    });

    expect(getOptimizedEmailsDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 100 })
    );
    expect(result.messages.map((message: any) => message.id)).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });

  it('applies requested ordering to text-query results before limiting', async () => {
    let searchCall = 0;
    const api = vi.fn((url: string) => ({
      get: async () => {
        if (url === 'https://graph.test/query-page-2') {
          return { value: [{ id: 'a', subject: 'Alpha invoice' }] };
        }
        if (url.includes('$search=')) {
          searchCall += 1;
          return searchCall === 1
            ? {
                value: Array.from({ length: 100 }, (_, index) => ({
                  id: `z-${index}`,
                  subject: `Zulu invoice ${index}`,
                })),
                '@odata.nextLink': 'https://graph.test/query-page-2',
              }
            : { value: [] };
        }
        return { value: [] };
      },
    }));
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const result = await service.advancedSearchEmailsDetailed({
      query: 'invoice',
      maxResults: 1,
      scanLimit: 500,
      sortBy: 'subject',
      sortOrder: 'asc',
    });

    expect(result.messages.map((message: any) => message.id)).toEqual(['a']);
    expect(result.truncated).toBe(true);
    expect(api).toHaveBeenCalledWith('https://graph.test/query-page-2');
  });
});

describe('EmailService.searchEmailsBySenderDomain pagination', () => {
  it('finds a matching sender on a later Graph page', async () => {
    const api = vi.fn((url: string) => ({
      get: async () => {
        if (url === 'https://graph.test/page-2') {
          return {
            value: [
              {
                id: 'match',
                from: { emailAddress: { address: 'person@sub.example.com' } },
                receivedDateTime: '2026-07-23T12:00:00Z',
              },
            ],
          };
        }
        return {
          value: [
            {
              id: 'other',
              from: { emailAddress: { address: 'other@different.com' } },
              receivedDateTime: '2026-07-23T12:00:00Z',
            },
          ],
          '@odata.nextLink': 'https://graph.test/page-2',
        };
      },
    }));
    const service = Object.create(EmailService.prototype) as any;
    service.client = { api };
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const result = await service.searchEmailsBySenderDomain('example.com', {
      maxResults: 1,
      includeSubdomains: true,
      dateRange: {
        from: '2026-07-01T00:00:00Z',
        to: '2026-07-31T23:59:59Z',
      },
    });

    expect(result.map((message: any) => message.id)).toEqual(['match']);
    expect(api).toHaveBeenCalledWith('https://graph.test/page-2');
  });
});
