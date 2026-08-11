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
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-2',
        },
      ],
      ['https://graph.microsoft.com/v1.0/page-2', { value: [{ id: 'second' }] }],
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
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

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

describe('getOptimizedFoldersDetailed - pagination evidence', () => {
  it('follows Graph next links for the top-level folder listing', async () => {
    const pages = new Map<string, any>([
      [
        '/users/user@example.com/mailFolders',
        {
          value: [{ id: 'inbox', displayName: 'Inbox' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/folders-page-2',
        },
      ],
      [
        'https://graph.microsoft.com/v1.0/folders-page-2',
        { value: [{ id: 'archive', displayName: 'Archive' }] },
      ],
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
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

    const result = await opt.getOptimizedFoldersDetailed({
      includeSubfolders: false,
      enableCache: false,
      maxItems: 10,
      maxPages: 5,
    });

    expect(result.items.map((item: any) => item.id)).toEqual(['inbox', 'archive']);
    expect(result.pagesScanned).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('follows Graph next links for a per-folder childFolders fetch', async () => {
    const pages = new Map<string, any>([
      ['/users/user@example.com/mailFolders', { value: [{ id: 'inbox', displayName: 'Inbox' }] }],
      [
        '/users/user@example.com/mailFolders/inbox/childFolders',
        {
          value: [{ id: 'sub-1', displayName: 'Sub 1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subfolders-page-2',
        },
      ],
      [
        'https://graph.microsoft.com/v1.0/subfolders-page-2',
        { value: [{ id: 'sub-2', displayName: 'Sub 2' }] },
      ],
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
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

    const result = await opt.getOptimizedFoldersDetailed({
      includeSubfolders: true,
      maxDepth: 2,
      enableCache: false,
      maxItems: 10,
      maxPages: 5,
    });

    expect(result.items.map((item: any) => item.id)).toEqual(['inbox', 'sub-1', 'sub-2']);
    expect(result.truncated).toBe(false);
  });

  it('reports truncated:true when a per-folder childFolders fetch rejects', async () => {
    const client = {
      api(url: string) {
        const chain: any = {
          select: () => chain,
          filter: () => chain,
          orderby: () => chain,
          top: () => chain,
          get: async () => {
            if (url === '/users/user@example.com/mailFolders') {
              return { value: [{ id: 'inbox', displayName: 'Inbox' }] };
            }
            if (url === '/users/user@example.com/mailFolders/inbox/childFolders') {
              throw new Error('Graph 503');
            }
            throw new Error(`unexpected url in test: ${url}`);
          },
        };
        return chain;
      },
    } as never;
    const cache = new CacheManager();
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

    const result = await opt.getOptimizedFoldersDetailed({
      includeSubfolders: true,
      maxDepth: 2,
      enableCache: false,
      maxItems: 10,
      maxPages: 5,
    });

    // The failed branch is dropped (matches the pre-existing console.warn
    // behavior for a single folder's subtree), but the caller must be told
    // the tree is incomplete instead of silently getting only 'inbox' back.
    expect(result.items.map((item: any) => item.id)).toEqual(['inbox']);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated:true when the subfolder recursion hits the maxPages cap', async () => {
    const pages = new Map<string, any>([
      ['/users/user@example.com/mailFolders', { value: [{ id: 'inbox', displayName: 'Inbox' }] }],
      [
        '/users/user@example.com/mailFolders/inbox/childFolders',
        {
          value: [{ id: 'sub-1', displayName: 'Sub 1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subfolders-page-2',
        },
      ],
      [
        'https://graph.microsoft.com/v1.0/subfolders-page-2',
        { value: [{ id: 'sub-2', displayName: 'Sub 2' }] },
      ],
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
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

    const result = await opt.getOptimizedFoldersDetailed({
      includeSubfolders: true,
      maxDepth: 2,
      enableCache: false,
      maxItems: 10,
      maxPages: 1, // one page per fetch — the childFolders next link is never followed
    });

    // The top-level mailFolders fetch is a single page (no nextLink), so it
    // is not truncated on its own; the cap is hit on the per-folder
    // childFolders fetch, which is exactly the gap this method exists to
    // paginate through and signal honestly when it can't.
    expect(result.items.map((item: any) => item.id)).toEqual(['inbox', 'sub-1']);
    expect(result.truncated).toBe(true);
  });

  it('applies maxItems to the whole folder tree instead of once per parent', async () => {
    const client = {
      api(url: string) {
        const chain: any = {
          select: () => chain,
          filter: () => chain,
          orderby: () => chain,
          top: () => chain,
          get: async () => {
            if (url === '/users/user@example.com/mailFolders') {
              return { value: [{ id: 'root', displayName: 'Root' }] };
            }
            if (url === '/users/user@example.com/mailFolders/root/childFolders') {
              return {
                value: [
                  { id: 'child-1', displayName: 'Child 1' },
                  { id: 'child-2', displayName: 'Child 2' },
                ],
              };
            }
            throw new Error(`unexpected url in test: ${url}`);
          },
        };
        return chain;
      },
    } as never;
    const opt = new GraphOptimizer(client, new CacheManager(), {}, 'user@example.com');

    const result = await opt.getOptimizedFoldersDetailed({
      includeSubfolders: true,
      maxDepth: 2,
      enableCache: false,
      maxItems: 2,
      maxPages: 5,
    });

    expect(result.items.map((item: any) => item.id)).toEqual(['root', 'child-1']);
    expect(result.truncated).toBe(true);
  });

  it('does not serve a cached truncated fetch as truncated:false on a later cache hit', async () => {
    // Regression test: getOptimizedFoldersDetailed used to cache folderList
    // unconditionally and hardcode truncated:false on every cache hit, so a
    // first fetch that failed to enumerate all subfolders got cached as
    // "complete" for 10 minutes and every following list_folders call over
    // the same mailbox reported truncated:false over that same incomplete
    // data — the exact silent-truncation class this fix exists to close.
    let childFoldersCallCount = 0;
    const client = {
      api(url: string) {
        const chain: any = {
          select: () => chain,
          filter: () => chain,
          orderby: () => chain,
          top: () => chain,
          get: async () => {
            if (url === '/users/user@example.com/mailFolders') {
              return { value: [{ id: 'inbox', displayName: 'Inbox' }] };
            }
            if (url === '/users/user@example.com/mailFolders/inbox/childFolders') {
              childFoldersCallCount += 1;
              if (childFoldersCallCount === 1) {
                throw new Error('Graph 503');
              }
              return { value: [{ id: 'sub-1', displayName: 'Sub 1' }] };
            }
            throw new Error(`unexpected url in test: ${url}`);
          },
        };
        return chain;
      },
    } as never;
    const cache = new CacheManager();
    const opt = new GraphOptimizer(client, cache, {}, 'user@example.com');

    const optionsForBothCalls = {
      includeSubfolders: true,
      maxDepth: 2,
      enableCache: true,
      maxItems: 10,
      maxPages: 5,
    };

    const first = await opt.getOptimizedFoldersDetailed(optionsForBothCalls);
    expect(first.truncated).toBe(true);

    const second = await opt.getOptimizedFoldersDetailed(optionsForBothCalls);

    // If the truncated first fetch had been cached, this call would
    // short-circuit on the cache hit, never re-invoke childFolders (call
    // count would stay at 1), and report truncated:false over the same
    // incomplete 'inbox'-only tree.
    expect(childFoldersCallCount).toBe(2);
    expect(second.items.map((item: any) => item.id)).toEqual(['inbox', 'sub-1']);
    expect(second.truncated).toBe(false);
  });
});
