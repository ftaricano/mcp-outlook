export interface GraphPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

export interface GraphPaginationResult<T> {
  items: T[];
  pagesScanned: number;
  itemsScanned: number;
  truncated: boolean;
  nextLink?: string;
}

interface CollectGraphPagesOptions<T> {
  firstPage: GraphPage<T>;
  fetchNext: (nextLink: string) => Promise<GraphPage<T>>;
  maxItems: number;
  maxPages: number;
}

export function validateGraphNextLink(nextLink: string): string {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new Error('Graph pagination returned an invalid nextLink URL');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com') {
    throw new Error('Graph pagination nextLink must use https://graph.microsoft.com');
  }

  if (!url.pathname.startsWith('/v1.0/') && !url.pathname.startsWith('/beta/')) {
    throw new Error('Graph pagination nextLink has an unsupported API path');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

export async function collectGraphPages<T>({
  firstPage,
  fetchNext,
  maxItems,
  maxPages,
}: CollectGraphPagesOptions<T>): Promise<GraphPaginationResult<T>> {
  const items: T[] = [];
  let page = firstPage;
  let pagesScanned = 0;
  let itemsScanned = 0;

  while (true) {
    pagesScanned += 1;
    const pageItems = page.value ?? [];

    const remaining = Math.max(0, maxItems - items.length);
    const consumedItems = pageItems.slice(0, remaining);
    items.push(...consumedItems);
    itemsScanned += consumedItems.length;

    const nextLink = page['@odata.nextLink'];
    if (items.length >= maxItems) {
      const stoppedWithinPage = pageItems.length > remaining;
      return {
        items,
        pagesScanned,
        itemsScanned,
        truncated: Boolean(nextLink) || stoppedWithinPage,
        nextLink: stoppedWithinPage ? undefined : nextLink,
      };
    }

    if (!nextLink) {
      return {
        items,
        pagesScanned,
        itemsScanned,
        truncated: false,
      };
    }

    if (pagesScanned >= maxPages) {
      return {
        items,
        pagesScanned,
        itemsScanned,
        truncated: true,
        nextLink,
      };
    }

    page = await fetchNext(nextLink);
  }
}
