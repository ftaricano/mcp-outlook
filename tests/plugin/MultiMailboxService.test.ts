import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@microsoft/microsoft-graph-types';
import { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';
import { loadSearchMemory } from '../../src/plugin/searchMemory.js';
import type { ReliableSearchResult } from '../../src/services/reliableSearch.js';
import { config, SAMPLE_MEMORY_YAML, stubEmailService, writeMemory } from './helpers.js';

function searchResult(
  status: ReliableSearchResult<Message>['status']
): ReliableSearchResult<Message> {
  return {
    status,
    strategy: 'graph_search',
    confidence: status === 'FOUND' ? 'high' : 'low',
    messages: status === 'FOUND' ? ([{ id: 'message-1', subject: 'Invoice' }] as Message[]) : [],
    pagesScanned: 1,
    candidatesScanned: 1,
    truncated: false,
    canaryMatched: false,
    warnings: [],
  };
}

describe('MultiMailboxService', () => {
  it('rejects an unknown alias before constructing a mailbox service', async () => {
    const factory = vi.fn();
    const service = new MultiMailboxService(config(), factory);

    await expect(service.searchMailbox('unknown', { query: 'invoice' })).rejects.toThrow(
      /unknown mailbox alias/i
    );

    expect(factory).not.toHaveBeenCalled();
  });

  it('preserves requested alias order and makes partial failure explicit without leaking errors', async () => {
    const factory = vi.fn((address: string) => ({
      advancedSearchEmailsDetailed: vi.fn(async () => {
        if (address === 'billing@example.com') throw new Error('Graph says tenant=secret');
        return searchResult('FOUND');
      }),
      getEmailById: vi.fn(),
    }));
    const service = new MultiMailboxService(config(), factory);

    const result = await service.searchMailboxes(['finance', 'billing'], { query: 'invoice' });

    expect(result.status).toBe('SEARCH_FAILED');
    expect(result.results.map((entry) => entry.mailbox)).toEqual(['finance', 'billing']);
    expect(result.results.map((entry) => entry.status)).toEqual(['FOUND', 'SEARCH_FAILED']);
    expect(result.results[1].warnings).toEqual(['mailbox_search_failed']);
    expect(JSON.stringify(result)).not.toContain('tenant=secret');
  });

  it('caps fan-out concurrency and retains input order despite completion order', async () => {
    let active = 0;
    let peak = 0;
    const factory = vi.fn(() => ({
      advancedSearchEmailsDetailed: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return searchResult('NOT_FOUND');
      }),
      getEmailById: vi.fn(),
    }));
    const service = new MultiMailboxService(config({ maxConcurrentMailboxes: 2 }), factory);

    const result = await service.searchMailboxes(['archive', 'finance', 'billing'], {
      query: 'missing',
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(result.results.map((entry) => entry.mailbox)).toEqual(['archive', 'finance', 'billing']);
    expect(result.status).toBe('NOT_FOUND');
  });

  it('applies the configured mailbox and result limits before services are called', async () => {
    const factory = vi.fn(() => ({
      advancedSearchEmailsDetailed: vi.fn(async (criteria) => {
        expect(criteria.maxResults).toBe(5);
        expect(criteria.scanLimit).toBe(15);
        expect(criteria.includeFullContent).toBe(false);
        return searchResult('NOT_FOUND');
      }),
      getEmailById: vi.fn(),
    }));
    const service = new MultiMailboxService(
      config({ maxMailboxesPerSearch: 1, maxResultsPerMailbox: 5 }),
      factory
    );

    await expect(
      service.searchMailboxes(['finance', 'billing'], { query: 'invoice', maxResults: 50 })
    ).rejects.toThrow(/mailbox limit/i);

    expect(factory).not.toHaveBeenCalled();

    await service.searchMailbox('finance', { query: 'invoice', maxResults: 50 });
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe('read expansion methods', () => {
  it('lists messages via deterministic search on the pinned mailbox service', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }));
    const result = await service.listMessages('finance', { sender: 'x@y.com', maxResults: 100 });
    expect(result.mailbox).toBe('finance');
    expect(advancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sender: 'x@y.com', includeFullContent: false })
    );
  });

  it('lists folders and redacts failures', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listFolders: vi.fn(async () => {
          throw new Error('Graph secret');
        }),
      }));
    await expect(service.listFolders('finance')).rejects.toThrow(/folder listing failed/i);
  });

  it('returns folder stats and attachment metadata from the pinned service', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        getFolderStatistics: vi.fn(async () => ({ totalItems: 10 })),
        listAttachments: vi.fn(async () => [{ id: 'a1', name: 'fatura.pdf', size: 100 }]),
      }));
    await expect(service.getFolderStats('finance', 'inbox')).resolves.toMatchObject({
      totalItems: 10,
    });
    await expect(service.listAttachments('finance', 'm1')).resolves.toHaveLength(1);
  });
});

describe('deterministic caps and term expansion', () => {
  it('caps $search criteria at 50 results but allows 100 for deterministic criteria', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config({ maxResultsPerMailbox: 100 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }));

    await service.searchMailbox('finance', { query: 'fatura', maxResults: 100 });
    expect(advancedSearch).toHaveBeenLastCalledWith(expect.objectContaining({ maxResults: 50 }));

    await service.searchMailbox('finance', { sender: 'a@b.com', maxResults: 100 });
    expect(advancedSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxResults: 100, scanLimit: 500 })
    );
  });

  it('runs one search per expanded term, merging deduped results and recording terms', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const memory = loadSearchMemory(writeMemory(SAMPLE_MEMORY_YAML))!;
    const service = new MultiMailboxService(
      config(),
      () => stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }),
      memory
    );
    const result = await service.searchMailbox('finance', {
      query: 'Empresa Alfa Navegacao',
      expandTerms: true,
    });
    expect(advancedSearch.mock.calls.length).toBeGreaterThan(1);
    expect(result.expandedTerms).toContain('GRUPO NAUTICO');
    expect(result.messages.map((message) => message.id)).toEqual([
      ...new Set(result.messages.map((message) => message.id)),
    ]);
  });

  it('treats expandTerms as a no-op without memory configured', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }));
    const result = await service.searchMailbox('finance', { query: 'x', expandTerms: true });
    expect(advancedSearch).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('search_memory_not_configured');
  });
});

describe('searchMailboxesBatch', () => {
  it('returns per-label evidence and enforces maxQueriesPerBatch', async () => {
    const service = new MultiMailboxService(config({ maxQueriesPerBatch: 2 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: vi.fn(async () => searchResult('FOUND')) }));
    const batch = await service.searchMailboxesBatch([
      { label: 'caso-1', criteria: { query: 'a' } },
      { label: 'caso-2', mailboxes: ['finance'], criteria: { query: 'b' } },
    ]);
    expect(batch.results.map((entry) => entry.label)).toEqual(['caso-1', 'caso-2']);
    expect(batch.results[1].results).toHaveLength(1);

    await expect(
      service.searchMailboxesBatch([
        { label: 'a', criteria: {} },
        { label: 'b', criteria: {} },
        { label: 'c', criteria: {} },
      ])
    ).rejects.toThrow(/batch limit/i);
  });
});

describe('write methods', () => {
  it('moves messages up to maxBatchSize and reports per-id outcomes without raw errors', async () => {
    const move = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, success: id !== 'bad' })));
    const service = new MultiMailboxService(config({ maxBatchSize: 2 }), () =>
      stubEmailService({ moveEmailsToFolder: move }));
    const outcome = await service.moveMessages('finance', ['m1', 'bad'], 'folder-1');
    expect(outcome.results).toHaveLength(2);
    await expect(service.moveMessages('finance', ['a', 'b', 'c'], 'f')).rejects.toThrow(
      /batch limit/i
    );
  });

  it('marks messages read/unread through the pinned batch helpers', async () => {
    const markRead = vi.fn(async () => [{ success: true }]);
    const markUnread = vi.fn(async () => [{ success: true }]);
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ batchMarkAsRead: markRead, batchMarkAsUnread: markUnread }));
    await service.markMessages('finance', ['m1'], true);
    expect(markRead).toHaveBeenCalled();
    await service.markMessages('finance', ['m1'], false);
    expect(markUnread).toHaveBeenCalled();
  });

  it('creates a draft and never exposes a send path', async () => {
    const createDraft = vi.fn(async () => ({ success: true, draftId: 'd1', attachmentsCount: 0 }));
    const service = new MultiMailboxService(config(), () => stubEmailService({ createDraft }));
    const result = await service.createDraftMessage('finance', {
      to: ['x@example.com'],
      subject: 's',
      body: '<p>b</p>',
    });
    expect(result.draftId).toBe('d1');
    expect(createDraft).toHaveBeenCalledWith(
      ['x@example.com'],
      's',
      '<p>b</p>',
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('downloads attachments to the server disk via the pinned service', async () => {
    const downloadAll = vi.fn(async () => ({
      success: true,
      totalFiles: 2,
      successfulDownloads: 2,
      failedDownloads: 0,
      downloadedFiles: [],
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ downloadAllAttachmentsFromEmail: downloadAll }));
    const result = await service.downloadAttachments('finance', 'm1', undefined);
    expect(result).toMatchObject({ successfulDownloads: 2 });
  });

  it('downloads only the requested attachmentIds, one at a time, without downloading all', async () => {
    const downloadOne = vi.fn(async (_messageId: string, attachmentId: string) => ({
      success: true,
      filename: `${attachmentId}.pdf`,
      filePath: `/tmp/${attachmentId}.pdf`,
      originalSize: 10,
      savedSize: 10,
      contentType: 'application/pdf',
      integrity: true,
      downloadTime: 1,
    }));
    const downloadAll = vi.fn();
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        downloadAttachmentToFile: downloadOne,
        downloadAllAttachmentsFromEmail: downloadAll,
      }));

    const result = await service.downloadAttachments('finance', 'm1', ['a1', 'a2']);

    expect(downloadOne).toHaveBeenCalledTimes(2);
    expect(downloadOne).toHaveBeenNthCalledWith(1, 'm1', 'a1', {});
    expect(downloadOne).toHaveBeenNthCalledWith(2, 'm1', 'a2', {});
    expect(downloadAll).not.toHaveBeenCalled();
    expect(result).toMatchObject({ totalFiles: 2, successfulDownloads: 2, failedDownloads: 0 });
  });

  it('counts a selective download failure without throwing or leaking raw errors', async () => {
    const downloadOne = vi.fn(async (_messageId: string, attachmentId: string) => {
      if (attachmentId === 'bad') throw new Error('Graph says tenant=secret');
      return {
        success: true,
        filename: `${attachmentId}.pdf`,
        filePath: `/tmp/${attachmentId}.pdf`,
        originalSize: 10,
        savedSize: 10,
        contentType: 'application/pdf',
        integrity: true,
        downloadTime: 1,
      };
    });
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ downloadAttachmentToFile: downloadOne }));

    const result = await service.downloadAttachments('finance', 'm1', ['a1', 'bad']);

    expect(result).toMatchObject({ totalFiles: 2, successfulDownloads: 1, failedDownloads: 1 });
  });
});
