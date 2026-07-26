import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@microsoft/microsoft-graph-types';
import { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';
import type { PluginConfig } from '../../src/plugin/config.js';
import type { ReliableSearchResult } from '../../src/services/reliableSearch.js';

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const mailboxes = [
    { alias: 'finance', address: 'finance@example.com' },
    { alias: 'billing', address: 'billing@example.com' },
    { alias: 'archive', address: 'archive@example.com' },
  ] as const;
  const mailboxesByAlias = new Map(mailboxes.map((mailbox) => [mailbox.alias, mailbox]));

  return {
    mailboxes,
    mailboxesByAlias,
    maxConcurrentMailboxes: 2,
    maxMailboxesPerSearch: 3,
    maxResultsPerMailbox: 20,
    maxBodyChars: 12000,
    ...overrides,
  };
}

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
