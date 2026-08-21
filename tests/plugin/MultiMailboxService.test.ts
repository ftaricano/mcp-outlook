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
  it('reports NOT_FOUND only after complete message and attachment coverage', async () => {
    const advancedSearch = vi.fn(async ({ folder }: { folder?: string }) => ({
      ...searchResult('FOUND'),
      messages: [
        {
          id: `${folder}-message`,
          subject: 'Routine correspondence',
          bodyPreview: 'No requested identifiers here',
          hasAttachments: true,
        },
      ] as Message[],
      pagesScanned: 2,
      candidatesScanned: 1,
    }));
    const listAttachments = vi.fn(async () => ({
      items: [{ id: 'attachment-1', name: 'generic-file.pdf', size: 100 }],
      pagesScanned: 1,
      truncated: false,
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: advancedSearch,
        listAttachmentsDetailed: listAttachments,
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.folders).toEqual([
      expect.objectContaining({ folder: 'inbox', status: 'COMPLETE', messagesScanned: 1 }),
      expect.objectContaining({ folder: 'sentitems', status: 'COMPLETE', messagesScanned: 1 }),
      expect.objectContaining({ folder: 'archive', status: 'COMPLETE', messagesScanned: 1 }),
    ]);
    expect(listAttachments).toHaveBeenCalledTimes(3);
    expect(advancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: undefined,
        includeFullContent: false,
        maxPages: 10,
        maxResults: 100,
        scanLimit: 100,
      })
    );
  });

  it('does not report NOT_FOUND when an attachment name is missing', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-1', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: null, size: 100 }],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folder: 'inbox',
          status: 'INCOMPLETE',
          attachmentListsCompleted: 0,
          reasons: ['ATTACHMENT_NAME_INVALID'],
        }),
      ])
    );
  });

  it('does not trust hasAttachments false to exclude inline document attachments', async () => {
    const listAttachmentsDetailed = vi.fn(async () => ({
      items: [{ id: 'attachment-inline', name: 'proposal-PROP-1001.pdf', size: 100 }],
      pagesScanned: 1,
      truncated: false,
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-inline', hasAttachments: false }] as Message[],
        })),
        listAttachmentsDetailed,
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.matches[0]).toMatchObject({
      classification: 'CONFIRMED',
      confirmationReasons: ['PROPOSAL_ID_IN_ATTACHMENT_NAME'],
    });
    expect(listAttachmentsDetailed).toHaveBeenCalledOnce();
  });

  it('keeps multi-signal matching bounded for a large metadata field', async () => {
    const repeatedText = 'aa-'.repeat(333_333);
    const signal = (prefix: string, index: number) => `${prefix}-${index}-${'x'.repeat(180)}`;
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            { id: 'message-1', bodyPreview: repeatedText, hasAttachments: true },
          ] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: Array.from({ length: 50 }, (_, index) => ({
            id: `attachment-${index}`,
            name: `aa-${index}.pdf`,
            size: 100,
          })),
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const startedAt = Date.now();
    const result = await service.investigateDocuments('finance', {
      proposalIds: Array.from({ length: 25 }, (_, index) => signal('proposal', index)),
      clients: Array.from({ length: 25 }, (_, index) => signal('client', index)),
      insurers: Array.from({ length: 25 }, (_, index) => signal('insurer', index)),
      attachmentNames: Array.from({ length: 25 }, (_, index) => signal('attachment', index)),
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 200,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.coverage.folders[0]).toEqual(
      expect.objectContaining({
        status: 'INCOMPLETE',
        reasons: expect.arrayContaining(['MESSAGE_TEXT_TRUNCATED']),
      })
    );
  });

  it('matches the complete attachment name while exposing projection truncation', async () => {
    const longName = `${'prefix-'.repeat(45)}PROP-1001.pdf`;
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-1', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: longName, size: 100 }],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.matches[0]).toMatchObject({
      classification: 'CONFIRMED',
      message: {
        attachmentNamesTruncated: true,
        attachmentsTruncated: true,
        attachments: [{ nameTruncated: true }],
      },
    });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folder: 'inbox',
          status: 'INCOMPLETE',
          reasons: ['ATTACHMENT_NAME_TRUNCATED'],
        }),
      ])
    );
  });

  it('reports omitted canonical folders as incomplete instead of NOT_FOUND', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('NOT_FOUND'),
          messages: [],
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.folders).toEqual([
      expect.objectContaining({ folder: 'inbox', status: 'COMPLETE' }),
      expect.objectContaining({
        folder: 'sentitems',
        status: 'INCOMPLETE',
        reasons: ['FOLDER_NOT_SCANNED'],
      }),
      expect.objectContaining({
        folder: 'archive',
        status: 'INCOMPLETE',
        reasons: ['FOLDER_NOT_SCANNED'],
      }),
    ]);
  });

  it('returns SEARCH_INCOMPLETE instead of absence when a folder scan is truncated', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('SEARCH_INCOMPLETE'),
          messages: [],
          truncated: true,
          pagesScanned: 10,
          candidatesScanned: 100,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.folders[0]).toMatchObject({
      status: 'INCOMPLETE',
      reasons: ['MESSAGE_SCAN_LIMIT_REACHED'],
    });
  });

  it('returns SEARCH_INCOMPLETE when attachment pagination is capped', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-1', subject: 'PROP-1001', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: 'generic.pdf', size: 100 }],
          pagesScanned: 5,
          truncated: true,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.matches[0].classification).toBe('CANDIDATE_REVIEW');
    expect(result.coverage.folders[0].reasons).toContain('ATTACHMENT_SCAN_LIMIT_REACHED');
  });

  it('keeps attachment failures incomplete with a stable redacted reason', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-1', subject: 'PROP-1001', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => {
          throw new Error('Graph mailbox secret');
        }),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.matches[0]).toMatchObject({
      classification: 'CANDIDATE_REVIEW',
      message: { attachmentsTruncated: true },
    });
    expect(result.coverage.folders[0]).toMatchObject({
      status: 'FAILED',
      attachmentListsAttempted: 1,
      attachmentListsCompleted: 0,
      reasons: ['ATTACHMENT_SCAN_FAILED'],
    });
    expect(JSON.stringify(result)).not.toContain('mailbox secret');
  });

  it('confirms only strong attachment identity and otherwise returns review candidates', async () => {
    const messages = [
      {
        id: 'confirmed-message',
        subject: 'Documents for Example Industries',
        bodyPreview: 'Carrier Example Assurance',
        hasAttachments: true,
      },
      {
        id: 'candidate-message',
        subject: 'Example Industries renewal',
        bodyPreview: 'Example Assurance',
        hasAttachments: true,
      },
    ] as Message[];
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages,
          candidatesScanned: 2,
        })),
        listAttachmentsDetailed: vi.fn(async (messageId: string) => ({
          items: [
            {
              id: `${messageId}-attachment`,
              name:
                messageId === 'confirmed-message'
                  ? 'proposal-PROP-1001.pdf'
                  : 'policy-document.pdf',
              size: 100,
            },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: ['Example Industries'],
      insurers: ['Example Assurance'],
      attachmentNames: ['proposal-PROP-1001.pdf'],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.matches.filter((match) => match.folder === 'inbox')).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'confirmed-message' }),
        classification: 'CONFIRMED',
        matchedSignals: expect.objectContaining({
          proposalIds: ['PROP-1001'],
          clients: ['Example Industries'],
          insurers: ['Example Assurance'],
          attachmentNames: ['proposal-PROP-1001.pdf'],
        }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({ id: 'candidate-message' }),
        classification: 'CANDIDATE_REVIEW',
      }),
    ]);
    expect(result.coverage.complete).toBe(true);
  });

  it('returns confirmations before candidates when maxResults truncates matches', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            { id: 'candidate-message', subject: 'Example Industries', hasAttachments: true },
            { id: 'confirmed-message', subject: 'Example Industries', hasAttachments: true },
          ] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async (messageId: string) => ({
          items: [
            {
              id: `${messageId}-attachment`,
              name: messageId === 'confirmed-message' ? 'proposal-PROP-1001.pdf' : 'policy.pdf',
              size: 100,
            },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: ['Example Industries'],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 1,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.totalMatches).toBe(6);
    expect(result.matchesTruncated).toBe(true);
    expect(result.matches[0]).toMatchObject({
      classification: 'CONFIRMED',
      message: { id: 'confirmed-message' },
    });
  });

  it('requires identity alongside an exact requested filename and preserves punctuation', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            { id: 'generic-message', subject: 'Routine correspondence', hasAttachments: true },
            { id: 'identity-message', subject: 'Example Industries', hasAttachments: true },
            { id: 'collision-message', subject: 'Example Industries', hasAttachments: true },
          ] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async (messageId: string) => ({
          items: [
            {
              id: `${messageId}-attachment`,
              name: messageId === 'collision-message' ? 'report1.pdf' : 'report-1.pdf',
              size: 100,
            },
          ],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: [],
      clients: ['Example Industries'],
      insurers: [],
      attachmentNames: ['report-1.pdf'],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.matches).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'identity-message' }),
        classification: 'CONFIRMED',
        confirmationReasons: ['REQUESTED_ATTACHMENT_NAME_MATCH'],
      }),
      expect.objectContaining({
        message: expect.objectContaining({ id: 'generic-message' }),
        classification: 'CANDIDATE_REVIEW',
        confirmationReasons: [],
      }),
      expect.objectContaining({
        message: expect.objectContaining({ id: 'collision-message' }),
        classification: 'CANDIDATE_REVIEW',
        matchedSignals: expect.objectContaining({ attachmentNames: [] }),
      }),
    ]);
  });

  it('keeps filename-only identity as a candidate when signals share one attachment field', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'filename-only', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: 'report.pdf', size: 100 }],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: [],
      clients: ['report'],
      insurers: [],
      attachmentNames: ['report.pdf'],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CANDIDATE_REVIEW');
    expect(result.matches[0]).toMatchObject({
      classification: 'CANDIDATE_REVIEW',
      matchedSignals: { clients: ['report'], attachmentNames: ['report.pdf'] },
      confirmationReasons: [],
    });
  });

  it('does not bridge a multi-term identity signal across metadata fields', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            {
              id: 'split-identity',
              subject: 'Example',
              bodyPreview: 'Industries',
              hasAttachments: false,
            },
          ] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: [],
      clients: ['Example Industries'],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.matches).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  it('confirms an exact filename when identity appears in one metadata field', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            {
              id: 'metadata-identity',
              subject: 'Example Industries',
              bodyPreview: 'Routine correspondence',
              hasAttachments: true,
            },
          ] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: 'report.pdf', size: 100 }],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: [],
      clients: ['Example Industries'],
      insurers: [],
      attachmentNames: ['report.pdf'],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.matches[0]).toMatchObject({
      classification: 'CONFIRMED',
      confirmationReasons: ['REQUESTED_ATTACHMENT_NAME_MATCH'],
    });
  });

  it('does not treat a partial proposal identifier as a confirmation', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [{ id: 'message-1', hasAttachments: true }] as Message[],
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: [{ id: 'attachment-1', name: 'proposal-PROP-10010.pdf', size: 100 }],
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.matches).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  it('distinguishes complete scan coverage from a truncated match projection', async () => {
    const attachments = Array.from({ length: 31 }, (_, index) => ({
      id: `attachment-${index}`,
      name: `generic-${index}.pdf`,
      size: 100,
    }));
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => ({
          ...searchResult('FOUND'),
          messages: [
            { id: 'message-1', subject: 'Example Industries', hasAttachments: true },
            { id: 'message-2', subject: 'Example Industries', hasAttachments: true },
          ] as Message[],
          candidatesScanned: 2,
        })),
        listAttachmentsDetailed: vi.fn(async () => ({
          items: attachments,
          pagesScanned: 1,
          truncated: false,
        })),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: [],
      clients: ['Example Industries'],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox', 'sentitems', 'archive'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 1,
    });

    expect(result).toMatchObject({
      status: 'CANDIDATE_REVIEW',
      totalMatches: 6,
      matchesTruncated: true,
      coverage: { complete: true },
      matches: [
        {
          message: {
            attachmentCount: 31,
            attachmentsTruncated: true,
          },
        },
      ],
    });
  });

  it('redacts folder query failures and records a stable coverage reason', async () => {
    const service = new MultiMailboxService(config(), () =>
      stubEmailService({
        advancedSearchEmailsDetailed: vi.fn(async () => {
          throw new Error('Graph tenant secret');
        }),
      })
    );

    const result = await service.investigateDocuments('finance', {
      proposalIds: ['PROP-1001'],
      clients: [],
      insurers: [],
      attachmentNames: [],
      folders: ['inbox'],
      maxPagesPerFolder: 10,
      maxMessagesPerFolder: 100,
      maxAttachmentPagesPerMessage: 5,
      maxAttachmentsPerMessage: 50,
      maxResults: 25,
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.coverage.folders[0]).toMatchObject({
      status: 'FAILED',
      reasons: ['MESSAGE_SCAN_FAILED'],
    });
    expect(JSON.stringify(result)).not.toContain('tenant secret');
  });

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

describe('inspectAttachmentEvidence', () => {
  function makeService(
    options: {
      name?: string;
      contentType?: string;
      bytes?: Buffer;
      declaredSize?: number;
      listed?: Record<string, unknown>[];
      truncated?: boolean;
      download?: Record<string, unknown>;
      downloadError?: boolean;
    } = {}
  ) {
    const bytes = options.bytes ?? Buffer.from('Proposal PROP-1001 for Example Client', 'utf8');
    const name = options.name ?? 'proposal.txt';
    const contentType = options.contentType ?? 'text/plain';
    const listed = options.listed ?? [
      {
        id: 'attachment-1',
        name,
        contentType,
        size: options.declaredSize ?? bytes.length,
        attachmentType: '#microsoft.graph.fileAttachment',
      },
    ];
    const downloadAttachment = vi.fn(async () => {
      if (options.downloadError) throw new Error('synthetic download failure');
      return {
        name,
        contentType,
        attachmentType: '#microsoft.graph.fileAttachment',
        content: bytes.toString('base64'),
        size: bytes.length,
        ...options.download,
      };
    });
    return {
      service: new MultiMailboxService(config(), () =>
        stubEmailService({
          listAttachmentsDetailed: vi.fn(async () => ({
            items: listed,
            pagesScanned: 2,
            truncated: options.truncated ?? false,
          })),
          downloadAttachment,
        })
      ),
      downloadAttachment,
      bytes,
    };
  }

  const baseCriteria = {
    proposalIds: ['PROP-1001'],
    clients: ['Example Client'],
    insurers: [],
    attachmentNames: ['proposal.txt'],
  };

  it('confirms a proposal ID in the exact attachment name and returns bounded hash metadata only', async () => {
    const { service, downloadAttachment, bytes } = makeService({ name: 'PROP-1001.txt' });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
      attachmentNames: [],
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.confirmationReasons).toEqual(['PROPOSAL_ID_IN_ATTACHMENT_NAME']);
    expect(result.attachment).toMatchObject({
      name: 'PROP-1001.txt',
      declaredSizeBytes: bytes.length,
      actualSizeBytes: bytes.length,
      sha256: expect.any(String),
      extractor: 'text',
    });
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('base64');
    expect(downloadAttachment).toHaveBeenCalledOnce();
  });

  it('confirms an exact requested attachment name only with independent identity in extracted text', async () => {
    const { service } = makeService();
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
      proposalIds: [],
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.confirmationReasons).toEqual(['REQUESTED_ATTACHMENT_NAME_AND_IDENTITY_IN_TEXT']);
    expect(result.matchedSignals).toEqual({
      proposalIds: [],
      clients: ['Example Client'],
      insurers: [],
      attachmentNames: ['proposal.txt'],
    });
  });

  it('keeps content-only and name-only matches at candidate review', async () => {
    const contentOnly = makeService();
    const contentResult = await contentOnly.service.inspectAttachmentEvidence(
      'finance',
      'message-1',
      'attachment-1',
      { proposalIds: [], clients: ['Example Client'], insurers: [], attachmentNames: [] }
    );
    expect(contentResult.status).toBe('CANDIDATE_REVIEW');

    const nameOnly = makeService();
    const nameResult = await nameOnly.service.inspectAttachmentEvidence(
      'finance',
      'message-1',
      'attachment-1',
      { proposalIds: [], clients: [], insurers: [], attachmentNames: ['proposal.txt'] }
    );
    expect(nameResult.status).toBe('CANDIDATE_REVIEW');
  });

  it('matches compact proposal IDs in text without accepting a longer partial ID', async () => {
    const compact = makeService({ bytes: Buffer.from('PROP1001', 'utf8') });
    const compactResult = await compact.service.inspectAttachmentEvidence(
      'finance',
      'message-1',
      'attachment-1',
      { proposalIds: ['PROP-1001'], clients: [], insurers: [], attachmentNames: [] }
    );
    expect(compactResult.status).toBe('CANDIDATE_REVIEW');
    expect(compactResult.matchedSignals.proposalIds).toEqual(['PROP-1001']);

    const partial = makeService({ bytes: Buffer.from('PROP10010', 'utf8') });
    const partialResult = await partial.service.inspectAttachmentEvidence(
      'finance',
      'message-1',
      'attachment-1',
      { proposalIds: ['PROP-1001'], clients: [], insurers: [], attachmentNames: [] }
    );
    expect(partialResult.status).toBe('NOT_CONFIRMED');
    expect(partialResult.matchedSignals.proposalIds).toEqual([]);

    const astral = makeService({ bytes: Buffer.from('𐐀1', 'utf8') });
    const astralResult = await astral.service.inspectAttachmentEvidence(
      'finance',
      'message-1',
      'attachment-1',
      { proposalIds: ['𐐀-1'], clients: [], insurers: [], attachmentNames: [] }
    );
    expect(astralResult.status).toBe('CANDIDATE_REVIEW');
    expect(astralResult.matchedSignals.proposalIds).toEqual(['𐐀-1']);
  });

  it('returns NOT_CONFIRMED only after complete listing, decoding, hashing, and extraction', async () => {
    const { service } = makeService({ bytes: Buffer.from('Routine document', 'utf8') });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      proposalIds: ['MISSING-99'],
      clients: ['Other Client'],
      insurers: ['Other Insurer'],
      attachmentNames: ['other.txt'],
    });

    expect(result.status).toBe('NOT_CONFIRMED');
    expect(result.reasons).toEqual([]);
    expect(result.coverage).toMatchObject({
      complete: true,
      listing: { complete: true, pagesScanned: 2 },
      download: { attempted: true, decoded: true },
      extraction: { attempted: true, complete: true, supported: true, truncated: false },
    });
  });

  it('fails closed when the attachment listing is truncated and does not download a guessed item', async () => {
    const { service, downloadAttachment } = makeService({ truncated: true });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('VALIDATION_INCOMPLETE');
    expect(result.reasons).toEqual(['ATTACHMENT_LIST_INCOMPLETE']);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('reports a deterministic NOT_CONFIRMED when a complete listing lacks the exact attachment ID', async () => {
    const { service, downloadAttachment } = makeService({
      listed: [
        {
          id: 'different-attachment',
          name: 'other.txt',
          contentType: 'text/plain',
          size: 4,
          attachmentType: '#microsoft.graph.fileAttachment',
        },
      ],
    });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('NOT_CONFIRMED');
    expect(result.reasons).toEqual(['ATTACHMENT_NOT_FOUND']);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.listing.complete).toBe(true);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('fails closed when a complete-looking listing contains an attachment without a valid ID', async () => {
    const { service, downloadAttachment } = makeService({
      listed: [
        {
          id: undefined,
          name: 'other.txt',
          contentType: 'text/plain',
          size: 4,
          attachmentType: '#microsoft.graph.fileAttachment',
        },
      ],
    });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('VALIDATION_INCOMPLETE');
    expect(result.reasons).toEqual(['ATTACHMENT_LIST_FAILED']);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('fails closed when an attachment listing ID exceeds the bounded identifier size', async () => {
    const { service, downloadAttachment } = makeService({
      listed: [
        {
          id: 'a'.repeat(513),
          name: 'other.txt',
          contentType: 'text/plain',
          size: 4,
          attachmentType: '#microsoft.graph.fileAttachment',
        },
      ],
    });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('VALIDATION_INCOMPLETE');
    expect(result.reasons).toEqual(['ATTACHMENT_LIST_FAILED']);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('requires a known Graph file attachment type before validating content', async () => {
    const { service, downloadAttachment } = makeService({
      listed: [
        {
          id: 'attachment-1',
          name: 'proposal.txt',
          contentType: 'text/plain',
          size: 1,
        },
      ],
    });
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('VALIDATION_INCOMPLETE');
    expect(result.reasons).toEqual(['ATTACHMENT_TYPE_UNSUPPORTED']);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it.each([
    ['size mismatch', { declaredSize: 999 }, 'SIZE_MISMATCH'],
    ['malformed Base64', { download: { content: '%%%=' } }, 'BASE64_INVALID'],
    ['download failure', { downloadError: true }, 'DOWNLOAD_FAILED'],
    [
      'missing download attachment type',
      { download: { attachmentType: undefined } },
      'DOWNLOAD_METADATA_INVALID',
    ],
    [
      'unsupported format',
      { name: 'proposal.bin', contentType: 'application/octet-stream' },
      'UNSUPPORTED_FORMAT',
    ],
  ] as const)('returns VALIDATION_INCOMPLETE for %s', async (_label, options, reason) => {
    const { service } = makeService(options);
    const result = await service.inspectAttachmentEvidence('finance', 'message-1', 'attachment-1', {
      ...baseCriteria,
    });

    expect(result.status).toBe('VALIDATION_INCOMPLETE');
    expect(result.reasons).toContain(reason);
    expect(result.status).not.toBe('NOT_CONFIRMED');
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
