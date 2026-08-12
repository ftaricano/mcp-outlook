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
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch })
    );
    const result = await service.listMessages('finance', { sender: 'x@y.com', maxResults: 100 });
    expect(result.mailbox).toBe('finance');
    expect(advancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sender: 'x@y.com', includeFullContent: false })
    );
  });

  it('lists folders and redacts failures', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listFoldersDetailed: vi.fn(async () => {
          throw new Error('Graph secret');
        }),
      })
    );
    await expect(service.listFolders('finance')).rejects.toThrow(/folder listing failed/i);
  });

  it('lists folders and propagates the truncated signal', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listFoldersDetailed: vi.fn(async () => ({
          items: [{ id: 'inbox', displayName: 'Inbox' }],
          truncated: true,
        })),
      })
    );
    await expect(service.listFolders('finance')).resolves.toMatchObject({
      items: [{ id: 'inbox' }],
      truncated: true,
    });
  });

  it('returns folder stats and attachment metadata from the pinned service', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        getFolderStatistics: vi.fn(async () => ({ totalEmails: 10, unreadEmails: 2 })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'a1', name: 'fatura.pdf', size: 100 }],
          pagesScanned: 2,
          truncated: true,
        })),
      })
    );
    await expect(service.getFolderStats('finance', 'inbox')).resolves.toMatchObject({
      totalEmails: 10,
    });
    await expect(service.listAttachments('finance', 'm1')).resolves.toMatchObject({
      items: [{ id: 'a1' }],
      pagesScanned: 2,
      truncated: true,
    });
  });
});

describe('deterministic caps and term expansion', () => {
  it('caps $search criteria at 50 results but allows 100 for deterministic criteria', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config({ maxResultsPerMailbox: 100 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch })
    );

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

  it('flags the merged union as truncated and keeps the newest across terms, not the first term', async () => {
    const memory = loadSearchMemory(writeMemory(SAMPLE_MEMORY_YAML))!;
    // Each term returns distinct messages; the first term's are the OLDEST, so
    // an unsorted insertion-order cut would keep exactly the wrong ones.
    let call = 0;
    const advancedSearch = vi.fn(async () => {
      call += 1;
      const base = searchResult('FOUND');
      return {
        ...base,
        messages: [
          { id: `m${call}a`, receivedDateTime: `2026-0${call}-01T00:00:00Z` },
          { id: `m${call}b`, receivedDateTime: `2026-0${call}-02T00:00:00Z` },
        ] as typeof base.messages,
      };
    });
    const service = new MultiMailboxService(
      config(),
      () => stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }),
      memory
    );

    const result = await service.searchMailbox('finance', {
      query: 'Empresa Alfa Navegacao',
      expandTerms: true,
      maxResults: 2,
    });

    expect(advancedSearch.mock.calls.length).toBeGreaterThan(1);
    expect(result.messages).toHaveLength(2);
    // Newest overall wins regardless of which term produced them.
    expect(result.messages[0].receivedDateTime! > result.messages[1].receivedDateTime!).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain('expanded_merge_truncated');
  });

  it('honours a subject sort across the merged union and demotes confidence when it truncates', async () => {
    const memory = loadSearchMemory(writeMemory(SAMPLE_MEMORY_YAML))!;
    let call = 0;
    const advancedSearch = vi.fn(async () => {
      call += 1;
      const base = searchResult('FOUND');
      return {
        ...base,
        confidence: 'high' as const,
        messages: [
          { id: `m${call}a`, subject: `Z-${call}` },
          { id: `m${call}b`, subject: `A-${call}` },
        ] as typeof base.messages,
      };
    });
    const service = new MultiMailboxService(
      config(),
      () => stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }),
      memory
    );

    const result = await service.searchMailbox('finance', {
      query: 'Empresa Alfa Navegacao',
      expandTerms: true,
      maxResults: 2,
      sortBy: 'subject',
      sortOrder: 'asc',
    });

    expect(result.messages.map((message) => message.subject)).toEqual(['A-1', 'A-2']);
    expect(result.truncated).toBe(true);
    expect(result.confidence).toBe('medium');
  });

  it('orders the merged union the same way the underlying search does, accents and case included', async () => {
    const memory = loadSearchMemory(writeMemory(SAMPLE_MEMORY_YAML))!;
    // Binary '<' would sort uppercase before lowercase and put accented words
    // after 'z'; localeCompare — what EmailService uses — does neither.
    const subjects = [
      ['fatura', 'Ápice'],
      ['Zebra', 'ábaco'],
    ];
    let call = 0;
    const advancedSearch = vi.fn(async () => {
      const base = searchResult('FOUND');
      const pair = subjects[call];
      call += 1;
      return {
        ...base,
        messages: pair.map((subject, index) => ({ id: `${subject}-${index}`, subject })),
      } as typeof base;
    });
    const service = new MultiMailboxService(
      config(),
      () => stubEmailService({ advancedSearchEmailsDetailed: advancedSearch }),
      memory
    );

    const result = await service.searchMailbox('finance', {
      query: 'Empresa Alfa Navegacao',
      expandTerms: true,
      maxResults: 10,
      sortBy: 'subject',
      sortOrder: 'asc',
    });

    const merged = ['fatura', 'Ápice', 'Zebra', 'ábaco'];
    expect(result.messages.map((message) => message.subject)).toEqual(
      [...merged].sort((a, b) => a.localeCompare(b))
    );
  });

  it('treats expandTerms as a no-op without memory configured', async () => {
    const advancedSearch = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ advancedSearchEmailsDetailed: advancedSearch })
    );
    const result = await service.searchMailbox('finance', { query: 'x', expandTerms: true });
    expect(advancedSearch).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('search_memory_not_configured');
  });
});

describe('searchMailboxesBatch', () => {
  it('returns per-label evidence and enforces maxQueriesPerBatch', async () => {
    const service = new MultiMailboxService(config({ maxQueriesPerBatch: 2 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: vi.fn(async () => searchResult('FOUND')) })
    );
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

  it('fails closed when aggregate messages exceed the configured batch budget', async () => {
    const search = vi.fn(async () => searchResult('FOUND'));
    const service = new MultiMailboxService(config({ maxBatchResultMessages: 1 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: search })
    );

    await expect(
      service.searchMailboxesBatch([
        { label: 'one', mailboxes: ['finance'], criteria: { query: 'a' } },
        { label: 'two', mailboxes: ['finance'], criteria: { query: 'b' } },
      ])
    ).rejects.toThrow(/message budget/i);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('fails closed when aggregate attachment metadata exceeds the configured batch budget', async () => {
    const result = searchResult('FOUND');
    result.messages[0].attachments = [{ id: 'a1' }, { id: 'a2' }];
    const service = new MultiMailboxService(config({ maxBatchAttachments: 1 }), () =>
      stubEmailService({ advancedSearchEmailsDetailed: vi.fn(async () => result) })
    );

    await expect(
      service.searchMailboxesBatch([
        {
          label: 'attachments',
          mailboxes: ['finance'],
          criteria: { query: 'a', includeAttachmentNames: true },
        },
      ])
    ).rejects.toThrow(/attachment budget/i);
  });

  it('enforces aggregate context-character and UTF-8 byte budgets independently', async () => {
    const result = searchResult('FOUND');
    result.messages[0].subject = 'é'.repeat(100);

    const contextLimited = new MultiMailboxService(
      config({ maxBatchContextChars: 10, maxBatchResultBytes: 10_000 }),
      () => stubEmailService({ advancedSearchEmailsDetailed: vi.fn(async () => result) })
    );
    await expect(
      contextLimited.searchMailboxesBatch([
        { label: 'chars', mailboxes: ['finance'], criteria: { query: 'a' } },
      ])
    ).rejects.toThrow(/context character budget/i);

    const bytesLimited = new MultiMailboxService(
      config({ maxBatchContextChars: 10_000, maxBatchResultBytes: 100 }),
      () => stubEmailService({ advancedSearchEmailsDetailed: vi.fn(async () => result) })
    );
    await expect(
      bytesLimited.searchMailboxesBatch([
        { label: 'bytes', mailboxes: ['finance'], criteria: { query: 'a' } },
      ])
    ).rejects.toThrow(/byte budget/i);
  });
});

describe('write methods', () => {
  it('moves messages up to maxBatchSize and reports per-id outcomes without raw errors', async () => {
    const move = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, success: id !== 'bad' })));
    const service = new MultiMailboxService(config({ maxBatchSize: 2 }), () =>
      stubEmailService({ moveEmailsToFolder: move })
    );
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
      stubEmailService({ batchMarkAsRead: markRead, batchMarkAsUnread: markUnread })
    );
    await service.markMessages('finance', ['m1'], true);
    expect(markRead).toHaveBeenCalled();
    await service.markMessages('finance', ['m1'], false);
    expect(markUnread).toHaveBeenCalled();
  });

  it('refuses the draft when an attachment fails to encode instead of attaching nothing', async () => {
    const createDraft = vi.fn(async () => ({ success: true, draftId: 'd1', attachmentsCount: 2 }));
    // The real encoder resolves with success:false rather than throwing.
    const encodeFileForAttachment = vi.fn(async (path: string) =>
      path.includes('blocked')
        ? { success: false, name: '', contentType: '', content: '', size: 0 }
        : { success: true, name: 'ok.pdf', contentType: 'application/pdf', content: 'AAA', size: 3 }
    );
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({ createDraft, encodeFileForAttachment })
    );

    await expect(
      service.createDraftMessage('finance', {
        to: ['x@example.com'],
        subject: 's',
        body: '<p>b</p>',
        attachmentPaths: ['/allowed/ok.pdf', '/blocked/secret.pdf'],
      })
    ).rejects.toThrow(/draft attachment encoding failed/i);

    expect(createDraft).not.toHaveBeenCalled();
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

  it('downloads all listed attachments through the same bounded path', async () => {
    const downloadOne = vi.fn(async () => ({
      success: true,
      filename: 'file.pdf',
      relativePath: 'file.pdf',
      filePath: '/tmp/file.pdf',
      originalSize: 40,
      savedSize: 40,
      contentType: 'application/pdf',
      integrity: true,
      downloadTime: 1,
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 40 },
            { id: 'a2', size: 40 },
          ],
          pagesScanned: 2,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );
    const result = await service.downloadAttachments('finance', 'm1', undefined);
    expect(result).toMatchObject({ successfulDownloads: 2, downloadedBytes: 80 });
    expect(downloadOne).toHaveBeenNthCalledWith(1, 'm1', 'a1', { maxBytes: 50 * 1024 * 1024 });
    expect(downloadOne).toHaveBeenNthCalledWith(2, 'm1', 'a2', {
      maxBytes: 50 * 1024 * 1024 - 40,
    });
    expect(result.files).toEqual([
      {
        attachmentId: 'a1',
        status: 'saved',
        filename: 'file.pdf',
        relativePath: 'file.pdf',
        sizeBytes: 40,
      },
      {
        attachmentId: 'a2',
        status: 'saved',
        filename: 'file.pdf',
        relativePath: 'file.pdf',
        sizeBytes: 40,
      },
    ]);
    expect(result.files.every((file) => !('filePath' in file))).toBe(true);
  });

  it('fails closed when attachment pagination is truncated before the first write', async () => {
    const downloadOne = vi.fn();
    const listAttachmentsDetailed = vi.fn(async () => ({
      items: [{ id: 'a1', size: 1 }],
      pagesScanned: 20,
      truncated: true,
    }));
    const service = new MultiMailboxService(config({ maxBatchSize: 2 }), () =>
      stubEmailService({
        listAttachmentsDetailed,
        downloadAttachmentToFile: downloadOne,
      })
    );

    await expect(service.downloadAttachments('finance', 'm1')).rejects.toThrow(/batch limit/i);
    expect(listAttachmentsDetailed).toHaveBeenCalledWith('m1', { maxItems: 3, maxPages: 20 });
    expect(downloadOne).not.toHaveBeenCalled();
  });

  it('rejects download-all above maxBatchSize before the first write', async () => {
    const downloadOne = vi.fn();
    const service = new MultiMailboxService(config({ maxBatchSize: 2 }), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 1 },
            { id: 'a2', size: 1 },
            { id: 'a3', size: 1 },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );

    await expect(service.downloadAttachments('finance', 'm1')).rejects.toThrow(/batch limit/i);
    expect(downloadOne).not.toHaveBeenCalled();
  });

  it('rejects a declared aggregate download above the byte cap before the first write', async () => {
    const downloadOne = vi.fn();
    const service = new MultiMailboxService(config({ maxDownloadBatchBytes: 100 }), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 60 },
            { id: 'a2', size: 50 },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );

    await expect(service.downloadAttachments('finance', 'm1')).rejects.toThrow(/download limit/i);
    expect(downloadOne).not.toHaveBeenCalled();
  });

  it('passes the remaining real-byte budget to every write and reports partial success', async () => {
    const downloadOne = vi.fn(async (_messageId: string, attachmentId: string, options: any) => {
      if (attachmentId === 'a2') {
        expect(options.maxBytes).toBe(2);
        return { success: false, savedSize: 0, errorCode: 'BYTE_BUDGET_EXCEEDED' };
      }
      return { success: true, filename: 'a1.pdf', relativePath: 'a1.pdf', savedSize: 8 };
    });
    const service = new MultiMailboxService(config({ maxDownloadBatchBytes: 10 }), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 1 },
            { id: 'a2', size: 1 },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );

    const result = await service.downloadAttachments('finance', 'm1');

    expect(result).toMatchObject({
      successfulDownloads: 1,
      failedDownloads: 1,
      downloadedBytes: 8,
      byteLimit: 10,
    });
    expect(result.files).toEqual([
      {
        attachmentId: 'a1',
        status: 'saved',
        filename: 'a1.pdf',
        relativePath: 'a1.pdf',
        sizeBytes: 8,
      },
      {
        attachmentId: 'a2',
        status: 'failed',
        sizeBytes: 0,
        errorCode: 'BYTE_BUDGET_EXCEEDED',
      },
    ]);
  });

  it('downloads only the requested attachmentIds, one at a time, without downloading all', async () => {
    const downloadOne = vi.fn(async (_messageId: string, attachmentId: string) => ({
      success: true,
      filename: `${attachmentId}.pdf`,
      relativePath: `${attachmentId}.pdf`,
      filePath: `/tmp/${attachmentId}.pdf`,
      originalSize: 10,
      savedSize: 10,
      contentType: 'application/pdf',
      integrity: true,
      downloadTime: 1,
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 10 },
            { id: 'a2', size: 10 },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );

    const result = await service.downloadAttachments('finance', 'm1', ['a1', 'a2']);

    expect(downloadOne).toHaveBeenCalledTimes(2);
    expect(downloadOne).toHaveBeenNthCalledWith(1, 'm1', 'a1', {
      maxBytes: 50 * 1024 * 1024,
    });
    expect(downloadOne).toHaveBeenNthCalledWith(2, 'm1', 'a2', {
      maxBytes: 50 * 1024 * 1024 - 10,
    });
    expect(result).toMatchObject({ totalFiles: 2, successfulDownloads: 2, failedDownloads: 0 });
  });

  it('counts a selective download failure without throwing or leaking raw errors', async () => {
    const downloadOne = vi.fn(async (_messageId: string, attachmentId: string) => {
      if (attachmentId === 'bad') throw new Error('Graph says tenant=secret');
      return {
        success: true,
        filename: `${attachmentId}.pdf`,
        relativePath: `${attachmentId}.pdf`,
        filePath: `/tmp/${attachmentId}.pdf`,
        originalSize: 10,
        savedSize: 10,
        contentType: 'application/pdf',
        integrity: true,
        downloadTime: 1,
      };
    });
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [
            { id: 'a1', size: 10 },
            { id: 'bad', size: 10 },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
        downloadAttachmentToFile: downloadOne,
      })
    );

    const result = await service.downloadAttachments('finance', 'm1', ['a1', 'bad']);

    expect(result).toMatchObject({ totalFiles: 2, successfulDownloads: 1, failedDownloads: 1 });
    expect(result.files[1]).toEqual({
      attachmentId: 'bad',
      status: 'failed',
      sizeBytes: 0,
      errorCode: 'DOWNLOAD_FAILED',
    });
  });
});
