import { describe, expect, it, vi } from 'vitest';
import { SearchHandler } from '../../src/handlers/SearchHandler.js';

function makeHandler(result: any, overrides: Record<string, unknown> = {}) {
  const emailService: any = {
    advancedSearchEmailsDetailed: vi.fn().mockResolvedValue(result),
    ...overrides,
  };
  const emailSummarizer: any = {};
  return {
    handler: new SearchHandler(emailService, emailSummarizer),
    emailService,
  };
}

describe('SearchHandler.handleAdvancedSearch structured evidence', () => {
  it('returns structuredContent while preserving human-readable text', async () => {
    const detailed = {
      status: 'FOUND',
      strategy: 'local_scan',
      confidence: 'high',
      messages: [
        {
          id: 'message-1',
          subject: 'Fatura localizada',
          from: { emailAddress: { address: 'sender@example.com' } },
          receivedDateTime: '2026-07-23T12:00:00Z',
          isRead: false,
          hasAttachments: true,
        },
      ],
      pagesScanned: 3,
      candidatesScanned: 120,
      truncated: false,
      canaryMatched: true,
      warnings: ['graph_search_canary_matched'],
    };
    const { handler } = makeHandler(detailed);

    const result = await handler.handleAdvancedSearch({ query: 'fatura' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Fatura localizada');
    expect(result.structuredContent).toEqual(detailed);
  });

  it('does not describe an incomplete search as a clean empty result', async () => {
    const detailed = {
      status: 'SEARCH_INCOMPLETE',
      strategy: 'local_scan',
      confidence: 'low',
      messages: [],
      pagesScanned: 10,
      candidatesScanned: 500,
      truncated: true,
      canaryMatched: false,
      warnings: ['graph_search_empty'],
    };
    const { handler } = makeHandler(detailed);

    const result = await handler.handleAdvancedSearch({ query: 'fatura' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('inconclusiva');
    expect(result.content[0].text).not.toContain('Nenhum email encontrado');
    expect(result.structuredContent).toEqual(detailed);
  });

  it('returns an MCP error for SEARCH_FAILED while retaining structured evidence', async () => {
    const detailed = {
      status: 'SEARCH_FAILED',
      strategy: 'local_scan',
      confidence: 'low',
      messages: [],
      pagesScanned: 0,
      candidatesScanned: 0,
      truncated: true,
      canaryMatched: false,
      warnings: ['graph_search_failed', 'local_scan_failed'],
    };
    const { handler } = makeHandler(detailed);

    const result = await handler.handleAdvancedSearch({ query: 'fatura' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('falhou');
    expect(result.structuredContent).toEqual(detailed);
  });
});

describe('SearchHandler machine-readable output for every search tool', () => {
  it.each([
    {
      name: 'sender-domain',
      invoke: (handler: SearchHandler) =>
        handler.handleSearchBySenderDomain({ domain: 'example.com', maxResults: 20 }),
      overrides: {
        searchEmailsBySenderDomain: vi.fn().mockResolvedValue([]),
      },
    },
    {
      name: 'attachment-type',
      invoke: (handler: SearchHandler) =>
        handler.handleSearchByAttachmentType({ fileTypes: ['pdf'], maxResults: 20 }),
      overrides: {
        searchEmailsByAttachmentType: vi.fn().mockResolvedValue([]),
      },
    },
    {
      name: 'duplicate',
      invoke: (handler: SearchHandler) =>
        handler.handleFindDuplicateEmails({ criteria: 'subject', maxResults: 50 }),
      overrides: {
        findDuplicateEmails: vi.fn().mockResolvedValue([]),
      },
    },
    {
      name: 'size',
      invoke: (handler: SearchHandler) =>
        handler.handleSearchBySize({ minSizeMB: 1, maxResults: 20 }),
      overrides: {
        searchEmailsBySize: vi.fn().mockResolvedValue([]),
      },
    },
  ])('marks an empty bounded $name scan as incomplete', async ({ invoke, overrides }) => {
    const { handler } = makeHandler(null, overrides);

    const result = await invoke(handler);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('limite examinado');
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        status: 'SEARCH_INCOMPLETE',
        confidence: 'low',
        warnings: ['bounded_scan_no_match'],
      })
    );
  });

  it('returns structured sender-domain results', async () => {
    const { handler } = makeHandler(null, {
      searchEmailsBySenderDomain: vi.fn().mockResolvedValue([
        {
          id: 'one',
          subject: 'Hello',
          from: { emailAddress: { address: 'person@example.com' } },
        },
      ]),
    });

    const result = await handler.handleSearchBySenderDomain({ domain: 'example.com' });

    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        status: 'FOUND',
        resultCount: 1,
        results: [expect.objectContaining({ id: 'one' })],
      })
    );
  });

  it('returns structured attachment-type results', async () => {
    const listAttachments = vi
      .fn()
      .mockResolvedValue([{ name: 'document.pdf', contentType: 'application/pdf' }]);
    const { handler } = makeHandler(null, {
      searchEmailsByAttachmentType: vi.fn().mockResolvedValue([
        {
          id: 'one',
          subject: 'Document',
          from: { emailAddress: { address: 'person@example.com' } },
        },
      ]),
      listAttachments,
    });

    const result = await handler.handleSearchByAttachmentType({ fileTypes: ['pdf'] });

    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        status: 'FOUND',
        resultCount: 1,
        results: [expect.objectContaining({ id: 'one' })],
      })
    );
  });

  it('returns structured saved-search listings', async () => {
    const saved = [
      {
        name: 'faturas',
        criteria: { query: 'fatura' },
        created: '2026-07-23T12:00:00Z',
        updated: '2026-07-23T12:00:00Z',
      },
    ];
    const { handler } = makeHandler(null, {
      listSavedSearches: vi.fn().mockResolvedValue(saved),
    });

    const result = await handler.handleSavedSearches({ action: 'list' });

    expect(result.structuredContent).toEqual({
      action: 'list',
      status: 'FOUND',
      savedSearches: saved,
    });
  });

  it('preserves incomplete evidence when executing a saved search', async () => {
    const evidence = {
      status: 'SEARCH_INCOMPLETE',
      strategy: 'local_scan',
      confidence: 'low',
      messages: [],
      pagesScanned: 10,
      candidatesScanned: 500,
      truncated: true,
      canaryMatched: false,
      warnings: ['graph_search_empty'],
    };
    const { handler } = makeHandler(null, {
      executeSavedSearch: vi.fn().mockResolvedValue({
        emails: [],
        criteria: { query: 'invoice' },
        evidence,
      }),
    });

    const result = await handler.handleSavedSearches({ action: 'execute', name: 'invoices' });

    expect(result.content[0].text).toContain('inconclusiva');
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        action: 'execute',
        status: 'SEARCH_INCOMPLETE',
        evidence,
      })
    );
  });
});
