import { describe, expect, it, vi } from 'vitest';
import { collectGraphPages } from '../../src/services/graphPagination.js';

describe('collectGraphPages', () => {
  it('follows @odata.nextLink and returns items from later pages', async () => {
    const fetchNext = vi.fn().mockResolvedValue({
      value: [{ id: 'second' }],
    });

    const result = await collectGraphPages({
      firstPage: {
        value: [{ id: 'first' }],
        '@odata.nextLink': 'https://graph.test/page-2',
      },
      fetchNext,
      maxItems: 10,
      maxPages: 5,
    });

    expect(result.items.map((item) => item.id)).toEqual(['first', 'second']);
    expect(result.pagesScanned).toBe(2);
    expect(result.itemsScanned).toBe(2);
    expect(result.truncated).toBe(false);
    expect(fetchNext).toHaveBeenCalledWith('https://graph.test/page-2');
  });

  it('stops at maxItems and reports truncation', async () => {
    const fetchNext = vi.fn();

    const result = await collectGraphPages({
      firstPage: {
        value: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
        '@odata.nextLink': 'https://graph.test/page-2',
      },
      fetchNext,
      maxItems: 2,
      maxPages: 5,
    });

    expect(result.items.map((item) => item.id)).toEqual(['one', 'two']);
    expect(result.itemsScanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.nextLink).toBeUndefined();
    expect(fetchNext).not.toHaveBeenCalled();
  });

  it('stops at maxPages and reports the remaining next link', async () => {
    const fetchNext = vi.fn().mockResolvedValue({
      value: [{ id: 'second' }],
      '@odata.nextLink': 'https://graph.test/page-3',
    });

    const result = await collectGraphPages({
      firstPage: {
        value: [{ id: 'first' }],
        '@odata.nextLink': 'https://graph.test/page-2',
      },
      fetchNext,
      maxItems: 10,
      maxPages: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['first', 'second']);
    expect(result.pagesScanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.nextLink).toBe('https://graph.test/page-3');
  });

  it('propagates a next-page failure instead of returning a partial clean result', async () => {
    const fetchNext = vi.fn().mockRejectedValue(new Error('throttled'));

    await expect(
      collectGraphPages({
        firstPage: {
          value: [{ id: 'first' }],
          '@odata.nextLink': 'https://graph.test/page-2',
        },
        fetchNext,
        maxItems: 10,
        maxPages: 5,
      })
    ).rejects.toThrow('throttled');
  });
});
