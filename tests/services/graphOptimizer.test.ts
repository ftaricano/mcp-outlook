import { describe, it, expect, vi } from 'vitest';
import { GraphOptimizer } from '../../src/services/graphOptimizer.js';
import { CacheManager } from '../../src/services/cacheManager.js';

// optimizeSearchQuery and the cache-key path never touch the Graph client, so a
// bare object is enough — we only exercise filter construction and cache keying.
function makeOptimizer() {
  const cache = new CacheManager();
  const client = {} as never;
  return { opt: new GraphOptimizer(client, cache, {}), cache };
}

describe('optimizeSearchQuery - OData injection hardening', () => {
  it('escapes single quotes in the search term so it cannot break the literal', () => {
    const { opt } = makeOptimizer();
    const filter = opt.optimizeSearchQuery("x' or 1", { searchIn: ['subject'] });
    expect(filter).toContain("contains(subject,'x'' or 1')");
  });

  it('escapes the term across every targeted field', () => {
    const { opt } = makeOptimizer();
    const filter = opt.optimizeSearchQuery("o'brien", { searchIn: ['subject', 'from', 'body'] });
    expect(filter).toContain("contains(subject,'o''brien')");
    expect(filter).toContain("contains(from/emailAddress/address,'o''brien')");
    expect(filter).toContain("contains(body/content,'o''brien')");
  });
});

describe('optimizeSearchQuery - one-sided date range', () => {
  it('emits only a ge bound when just the start date is provided', () => {
    const { opt } = makeOptimizer();
    const filter = opt.optimizeSearchQuery('', { dateRange: { start: '2025-01-01' } });
    expect(filter).toContain('receivedDateTime ge 2025-01-01');
    expect(filter).not.toContain(' le ');
  });

  it('emits only a le bound when just the end date is provided', () => {
    const { opt } = makeOptimizer();
    const filter = opt.optimizeSearchQuery('', { dateRange: { end: '2025-12-31' } });
    expect(filter).toContain('receivedDateTime le 2025-12-31');
    expect(filter).not.toContain(' ge ');
  });

  it('emits both bounds when both dates are provided', () => {
    const { opt } = makeOptimizer();
    const filter = opt.optimizeSearchQuery('', {
      dateRange: { start: '2025-01-01', end: '2025-12-31' },
    });
    expect(filter).toContain('receivedDateTime ge 2025-01-01');
    expect(filter).toContain('receivedDateTime le 2025-12-31');
  });
});

describe('getOptimizedEmails - cache key includes the $filter', () => {
  it('produces distinct cache keys for distinct filter values (no collision)', async () => {
    const { opt, cache } = makeOptimizer();
    const keySpy = vi.spyOn(cache, 'generateEmailKey');
    // Force a cache "hit" so the method returns before touching the Graph client.
    vi.spyOn(cache, 'get').mockReturnValue([] as never);

    await opt.getOptimizedEmails({ folder: 'inbox', maxResults: 10, filter: 'isRead eq false' });
    await opt.getOptimizedEmails({ folder: 'inbox', maxResults: 10, filter: 'isRead eq true' });

    const k1 = keySpy.mock.results[0]?.value;
    const k2 = keySpy.mock.results[1]?.value;
    expect(k1).toBeTruthy();
    expect(k1).not.toBe(k2);
  });
});

describe('getOptimizedEmails - path-segment encoding (no route injection)', () => {
  // A chain that records the URL passed to client.api() and no-ops the rest of
  // the fluent Graph request builder.
  function capturingClient(calls: string[]) {
    const chain: never = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'get') return async () => ({ value: [] });
          return () => chain;
        },
      }
    ) as never;
    return { api: (url: string) => (calls.push(url), chain) } as never;
  }

  it('percent-encodes the folder so a / or ? cannot alter the Graph route', async () => {
    const calls: string[] = [];
    const cache = new CacheManager();
    vi.spyOn(cache, 'get').mockReturnValue(undefined as never); // cache miss -> hits the client
    const opt = new GraphOptimizer(capturingClient(calls), cache, {});

    await opt.getOptimizedEmails({ folder: 'inbox/messages?$expand=attachments', maxResults: 5 });

    const url = calls[0] ?? '';
    expect(url).toContain('mailFolders/inbox%2Fmessages%3F');
    expect(url).not.toContain('mailFolders/inbox/messages?');
  });
});

describe('getOptimizedEmailsDetailed - pagination evidence', () => {
  it('follows Graph next links until maxResults is satisfied', async () => {
    const pages = new Map<string, any>([
      [
        '/users/user@example.com/mailFolders/inbox/messages',
        {
          value: [{ id: 'first' }],
          '@odata.nextLink': 'https://graph.test/page-2',
        },
      ],
      ['https://graph.test/page-2', { value: [{ id: 'second' }] }],
    ]);
    const client = {
      api(url: string) {
        const chain: any = {
          select: () => chain,
          filter: () => chain,
          orderby: () => chain,
          top: () => chain,
          get: async () => pages.get(url),
        };
        return chain;
      },
    } as never;
    const cache = new CacheManager();
    const opt = new GraphOptimizer(client, cache, {});
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const result = await opt.getOptimizedEmailsDetailed({
      folder: 'inbox',
      maxResults: 2,
      maxPages: 5,
      enableCache: false,
    });

    expect(result.items.map((item) => item.id)).toEqual(['first', 'second']);
    expect(result.pagesScanned).toBe(2);
    expect(result.truncated).toBe(false);
  });
});
