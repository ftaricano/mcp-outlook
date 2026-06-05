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
