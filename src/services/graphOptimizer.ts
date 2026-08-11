import { Client } from '@microsoft/microsoft-graph-client';
import { CacheManager } from './cacheManager.js';
import { escapeODataString, encodeGraphSegment } from './odataFilters.js';
import {
  collectGraphPages,
  GraphPaginationResult,
  validateGraphNextLink,
} from './graphPagination.js';

export interface GraphOptimizationConfig {
  enableBatching: boolean;
  batchSize: number;
  enableCompression: boolean;
  enableSelectiveFields: boolean;
  enableDeltaQueries: boolean;
  requestTimeout: number;
}

export interface BatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: any;
  headers?: Record<string, string>;
}

export interface OptimizedQueryOptions {
  select?: string[];
  filter?: string;
  orderBy?: string;
  top?: number;
  skip?: number;
  expand?: string[];
  enableCache?: boolean;
  cacheKey?: string;
  cacheTtl?: number;
}

export class GraphOptimizer {
  private client: Client;
  private cacheManager: CacheManager;
  private config: GraphOptimizationConfig;
  private readonly targetUserEmail?: string;
  private pendingBatch: BatchRequest[];
  private batchTimeout?: NodeJS.Timeout;
  private requestQueue: Map<string, Promise<any>>;

  constructor(
    client: Client,
    cacheManager: CacheManager,
    config: Partial<GraphOptimizationConfig> = {},
    targetUserEmail: string | undefined = process.env.TARGET_USER_EMAIL
  ) {
    this.client = client;
    this.cacheManager = cacheManager;
    this.targetUserEmail = targetUserEmail;
    this.config = {
      enableBatching: true,
      batchSize: 20,
      enableCompression: true,
      enableSelectiveFields: true,
      enableDeltaQueries: false, // Requires special setup
      requestTimeout: 30000,
      ...config,
    };

    this.pendingBatch = [];
    this.requestQueue = new Map();

    console.error('⚡ GraphOptimizer inicializado:', this.config);
  }

  /**
   * Helper to get the base endpoint (uses /users/{id} for app permissions or /me for delegated)
   */
  private getBaseEndpoint(): string {
    const targetUser = this.targetUserEmail;
    if (targetUser && targetUser !== 'me') {
      return `/users/${targetUser}`;
    }
    return '/me';
  }

  /**
   * Optimized email listing with selective fields and caching
   */
  async getOptimizedEmails(
    options: OptimizedQueryOptions & {
      folder?: string;
      maxResults?: number;
      search?: string;
    }
  ): Promise<any[]> {
    const result = await this.getOptimizedEmailsDetailed(options);
    return result.items;
  }

  async getOptimizedEmailsDetailed(
    options: OptimizedQueryOptions & {
      folder?: string;
      maxResults?: number;
      maxPages?: number;
      search?: string;
    }
  ): Promise<GraphPaginationResult<any>> {
    const {
      folder = 'inbox',
      maxResults = 10,
      maxPages = 10,
      search,
      enableCache = true,
      select = [
        'id',
        'subject',
        'from',
        'toRecipients',
        'receivedDateTime',
        'isRead',
        'importance',
        'hasAttachments',
        'bodyPreview',
      ],
      ...queryOptions
    } = options;

    // Generate cache key
    // `filter` and `orderBy` MUST be part of the cache key: list_emails,
    // getUnreadEmails (isRead eq false), getEmailsFromSender, date-range queries
    // all resolve to the same folder/maxResults and would otherwise collide on a
    // single cache entry and serve each other's results for the TTL.
    const cacheKey = this.cacheManager.generateEmailKey('list', {
      mailbox: this.targetUserEmail || 'me',
      folder,
      maxResults,
      search,
      filter: queryOptions.filter,
      orderBy: queryOptions.orderBy,
      select: select.sort(),
    });

    // Try cache first
    if (enableCache) {
      const cached = this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        console.error(`⚡ Cache hit: emails from ${folder}`);
        return {
          items: cached,
          pagesScanned: 0,
          itemsScanned: cached.length,
          truncated: false,
        };
      }
    }

    const baseEndpoint = this.getBaseEndpoint();
    const folderPath =
      folder === 'inbox'
        ? `${baseEndpoint}/mailFolders/inbox`
        : `${baseEndpoint}/mailFolders/${encodeGraphSegment(folder)}`;

    // Build optimized query with endpoint
    let query = this.buildOptimizedQuery(`${folderPath}/messages`, queryOptions);

    // Add selective fields
    if (this.config.enableSelectiveFields && select.length > 0) {
      query = query.select(select);
    }

    // Add search filter — escape the caller value so a single quote cannot
    // break out of the string literal and inject extra $filter clauses.
    if (search) {
      const safeSearch = escapeODataString(search);
      const searchFilter = `contains(subject,'${safeSearch}') or contains(from/emailAddress/address,'${safeSearch}')`;
      query = query.filter(searchFilter);
    }

    // Add pagination
    if (maxResults) {
      query = query.top(Math.min(maxResults, 100));
    }

    try {
      const firstPage = await query.get();
      const pagination = await collectGraphPages({
        firstPage,
        fetchNext: (nextLink) => this.client.api(validateGraphNextLink(nextLink)).get(),
        maxItems: maxResults,
        maxPages,
      });

      // Cache results
      if (enableCache) {
        this.cacheManager.cacheEmails(cacheKey, pagination.items, folder);
      }

      console.error(
        `⚡ Fetched ${pagination.items.length} emails from ${folder} ` +
          `(${pagination.pagesScanned} page(s), optimized)`
      );
      return pagination;
    } catch (error) {
      console.error('❌ Error in optimized email fetch:', error);
      throw error;
    }
  }

  /**
   * Optimized folder listing with caching. Thin wrapper over
   * getOptimizedFoldersDetailed for callers that only need the array —
   * mirrors the getOptimizedEmails / getOptimizedEmailsDetailed split above.
   */
  async getOptimizedFolders(
    options: OptimizedQueryOptions & {
      includeSubfolders?: boolean;
      maxDepth?: number;
    } = {}
  ): Promise<any[]> {
    const result = await this.getOptimizedFoldersDetailed(options);
    return result.items;
  }

  /**
   * Optimized folder listing with caching and pagination evidence. Follows
   * @odata.nextLink at both the top-level mailFolders fetch and every
   * per-folder childFolders fetch instead of trusting a single page, and
   * reports whether any of those fetches (or a per-folder error) left the
   * tree incomplete.
   */
  async getOptimizedFoldersDetailed(
    options: OptimizedQueryOptions & {
      includeSubfolders?: boolean;
      maxDepth?: number;
      maxItems?: number;
      maxPages?: number;
    } = {}
  ): Promise<GraphPaginationResult<any>> {
    const {
      includeSubfolders = true,
      maxDepth = 3,
      enableCache = true,
      maxItems = 1000,
      maxPages = 20,
      select = ['id', 'displayName', 'totalItemCount', 'unreadItemCount', 'parentFolderId'],
      ...queryOptions
    } = options;

    const cacheKey =
      `folders:${this.targetUserEmail || 'me'}:optimized:` +
      `${includeSubfolders}:${maxDepth}:${maxItems}:${maxPages}`;

    // Try cache first. truncated:false is safe here (not a stale guess)
    // only because the write side below never caches a truncated fetch.
    if (enableCache) {
      const cached = this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        console.error('⚡ Cache hit: folder structure');
        return { items: cached, pagesScanned: 0, itemsScanned: cached.length, truncated: false };
      }
    }

    try {
      const baseEndpoint = this.getBaseEndpoint();
      let query = this.buildOptimizedQuery(`${baseEndpoint}/mailFolders`, queryOptions);

      if (this.config.enableSelectiveFields) {
        query = query.select(select);
      }
      query = query.top(Math.min(maxItems, 100));

      const firstPage = await query.get();
      const pagination = await collectGraphPages({
        firstPage,
        fetchNext: (nextLink) => this.client.api(validateGraphNextLink(nextLink)).get(),
        maxItems,
        maxPages,
      });

      let folderList = pagination.items;
      let truncated = pagination.truncated;

      // Recursively get subfolders if needed
      if (includeSubfolders && maxDepth > 1) {
        const budget = { remaining: Math.max(0, maxItems - folderList.length) };
        const subResult = await this.getSubfoldersRecursive(
          folderList,
          maxDepth - 1,
          select,
          budget,
          maxPages
        );
        folderList = subResult.folders;
        truncated = truncated || subResult.truncated;
      }

      // Cache results with longer TTL for folders — but only when the fetch
      // was complete. Caching a truncated fetch would serve the same
      // incomplete tree as truncated:false (a hardcoded/stale cache hit
      // can't know the flag) for the whole TTL, reintroducing the silent
      // truncation this method exists to fix.
      if (enableCache && !truncated) {
        this.cacheManager.cacheFolders(cacheKey, folderList);
      }

      console.error(
        `⚡ Fetched ${folderList.length} folders (optimized, depth: ${maxDepth})` +
          (truncated ? ' [truncated]' : '')
      );
      return {
        items: folderList,
        pagesScanned: pagination.pagesScanned,
        itemsScanned: pagination.itemsScanned,
        truncated,
        nextLink: pagination.nextLink,
      };
    } catch (error) {
      console.error('❌ Error in optimized folder fetch:', error);
      throw error;
    }
  }

  /**
   * Batch operations for multiple requests
   */
  async executeBatch(requests: BatchRequest[]): Promise<Map<string, any>> {
    if (!this.config.enableBatching || requests.length === 0) {
      throw new Error('Batching not enabled or no requests provided');
    }

    const results = new Map<string, any>();
    const batches = this.chunkArray(requests, this.config.batchSize);

    console.error(`⚡ Executing ${requests.length} requests in ${batches.length} batch(es)`);

    for (const batch of batches) {
      try {
        const batchRequest = {
          requests: batch.map((req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            body: req.body,
            headers: {
              'Content-Type': 'application/json',
              ...req.headers,
            },
          })),
        };

        const response = await this.client.api('/$batch').post(batchRequest);

        // Process batch responses
        if (response.responses) {
          for (const batchResponse of response.responses) {
            results.set(batchResponse.id, {
              status: batchResponse.status,
              data: batchResponse.body,
              success: batchResponse.status >= 200 && batchResponse.status < 300,
            });
          }
        }

        // Small delay between batches to avoid throttling
        if (batches.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('❌ Batch execution error:', error);
        // Mark all requests in this batch as failed
        for (const req of batch) {
          results.set(req.id, {
            status: 500,
            data: { error: error instanceof Error ? error.message : 'Batch execution failed' },
            success: false,
          });
        }
      }
    }

    return results;
  }

  /**
   * Queue and auto-batch requests for efficiency
   */
  async queueRequest(request: BatchRequest, autoExecute: boolean = true): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingBatch.push(request);

      // Store resolver for this request
      this.requestQueue.set(
        request.id,
        Promise.resolve().then(() => {
          // This will be resolved when batch executes
          return new Promise((batchResolve, batchReject) => {
            const originalRequest = request;
            (originalRequest as any).resolve = batchResolve;
            (originalRequest as any).reject = batchReject;
          });
        })
      );

      // Auto-execute batch when it reaches batch size or after timeout
      if (autoExecute) {
        this.scheduleEarlyBatchExecution();
      }

      // Return promise that resolves when batch executes
      this.requestQueue.get(request.id)?.then(resolve).catch(reject);
    });
  }

  /**
   * Smart field selection based on operation type
   */
  getOptimalFields(operation: 'list' | 'details' | 'search' | 'metadata'): string[] {
    const fieldSets = {
      list: [
        'id',
        'subject',
        'from',
        'receivedDateTime',
        'isRead',
        'importance',
        'hasAttachments',
        'bodyPreview',
      ],
      details: [
        'id',
        'subject',
        'from',
        'toRecipients',
        'ccRecipients',
        'bccRecipients',
        'receivedDateTime',
        'sentDateTime',
        'isRead',
        'importance',
        'hasAttachments',
        'body',
        'bodyPreview',
        'categories',
        'flag',
        'parentFolderId',
      ],
      search: [
        'id',
        'subject',
        'from',
        'receivedDateTime',
        'isRead',
        'hasAttachments',
        'bodyPreview',
        'importance',
      ],
      metadata: [
        'id',
        'subject',
        'from',
        'receivedDateTime',
        'isRead',
        'importance',
        'hasAttachments',
        'parentFolderId',
      ],
    };

    return fieldSets[operation] || fieldSets.list;
  }

  /**
   * Optimize search queries with intelligent filtering
   */
  optimizeSearchQuery(
    searchTerm: string,
    options: {
      searchIn?: ('subject' | 'body' | 'from' | 'to')[];
      dateRange?: { start?: string; end?: string };
      importance?: 'low' | 'normal' | 'high';
      hasAttachments?: boolean;
      isRead?: boolean;
    } = {}
  ): string {
    const {
      searchIn = ['subject', 'from'],
      dateRange,
      importance,
      hasAttachments,
      isRead,
    } = options;

    const filters: string[] = [];

    // Text search with field targeting. Escape the caller value once so a
    // single quote cannot break out of the string literal and inject clauses.
    if (searchTerm) {
      const safeTerm = escapeODataString(searchTerm);
      const searchConditions = searchIn.map((field) => {
        switch (field) {
          case 'subject':
            return `contains(subject,'${safeTerm}')`;
          case 'body':
            return `contains(body/content,'${safeTerm}')`;
          case 'from':
            return `contains(from/emailAddress/address,'${safeTerm}')`;
          case 'to':
            return `contains(toRecipients/any(to: to/emailAddress/address),'${safeTerm}')`;
          default:
            return `contains(subject,'${safeTerm}')`;
        }
      });
      filters.push(`(${searchConditions.join(' or ')})`);
    }

    // Date range filter — emit each bound independently so a one-sided range
    // (only start, or only end) is still enforced instead of being dropped.
    if (dateRange) {
      if (dateRange.start) filters.push(`receivedDateTime ge ${dateRange.start}`);
      if (dateRange.end) filters.push(`receivedDateTime le ${dateRange.end}`);
    }

    // Importance filter
    if (importance) {
      filters.push(`importance eq '${importance}'`);
    }

    // Attachment filter
    if (hasAttachments !== undefined) {
      filters.push(`hasAttachments eq ${hasAttachments}`);
    }

    // Read status filter
    if (isRead !== undefined) {
      filters.push(`isRead eq ${isRead}`);
    }

    return filters.join(' and ');
  }

  /**
   * Build optimized query with standard optimizations
   */
  private buildOptimizedQuery(endpoint: string, options: OptimizedQueryOptions): any {
    let query = this.client.api(endpoint);

    if (options.filter) {
      query = query.filter(options.filter);
    }

    if (options.orderBy) {
      query = query.orderby(options.orderBy);
    }

    if (options.top) {
      query = query.top(Math.min(options.top, 999));
    }

    if (options.skip) {
      query = query.skip(options.skip);
    }

    if (options.expand && options.expand.length > 0) {
      query = query.expand(options.expand.join(','));
    }

    return query;
  }

  /**
   * Recursively get subfolders with depth control. Follows @odata.nextLink
   * per folder's childFolders page and reports truncation — both when a page
   * limit is hit and when a per-folder fetch errors out (that branch of the
   * tree is dropped, which is exactly the kind of gap `truncated` exists to
   * surface rather than hide behind a console.warn).
   */
  private async getSubfoldersRecursive(
    folders: any[],
    remainingDepth: number,
    selectFields: string[],
    budget: { remaining: number },
    maxPages: number
  ): Promise<{ folders: any[]; truncated: boolean }> {
    if (remainingDepth <= 0) return { folders, truncated: false };

    const allFolders = [...folders];
    let truncated = false;

    const baseEndpoint = this.getBaseEndpoint();

    for (const folder of folders) {
      if (budget.remaining <= 0) {
        truncated = true;
        break;
      }
      try {
        const firstPage = await this.client
          .api(`${baseEndpoint}/mailFolders/${encodeGraphSegment(folder.id)}/childFolders`)
          .select(selectFields)
          .top(Math.min(budget.remaining, 100))
          .get();

        const pagination = await collectGraphPages({
          firstPage,
          fetchNext: (nextLink) => this.client.api(validateGraphNextLink(nextLink)).get(),
          maxItems: budget.remaining,
          maxPages,
        });
        budget.remaining -= pagination.items.length;
        if (pagination.truncated) truncated = true;

        if (pagination.items.length > 0) {
          const nested = await this.getSubfoldersRecursive(
            pagination.items,
            remainingDepth - 1,
            selectFields,
            budget,
            maxPages
          );
          allFolders.push(...nested.folders);
          if (nested.truncated) truncated = true;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to get subfolders for ${folder.displayName}:`, error);
        truncated = true;
      }
    }

    return { folders: allFolders, truncated };
  }

  /**
   * Schedule batch execution with smart timing
   */
  private scheduleEarlyBatchExecution(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    // Execute immediately if batch is full
    if (this.pendingBatch.length >= this.config.batchSize) {
      this.executeQueuedBatch();
      return;
    }

    // Otherwise, wait for more requests or timeout
    this.batchTimeout = setTimeout(() => {
      if (this.pendingBatch.length > 0) {
        this.executeQueuedBatch();
      }
    }, 50); // Very short timeout for responsiveness
  }

  /**
   * Execute queued batch requests
   */
  private async executeQueuedBatch(): Promise<void> {
    if (this.pendingBatch.length === 0) return;

    const batchToExecute = [...this.pendingBatch];
    this.pendingBatch = [];

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }

    try {
      const results = await this.executeBatch(batchToExecute);

      // Resolve individual request promises
      for (const request of batchToExecute) {
        const result = results.get(request.id);
        const requestWithResolver = request as any;

        if (result?.success) {
          requestWithResolver.resolve?.(result.data);
        } else {
          requestWithResolver.reject?.(new Error(result?.data?.error || 'Batch request failed'));
        }
      }
    } catch (error) {
      // Reject all promises in case of batch failure
      for (const request of batchToExecute) {
        const requestWithResolver = request as any;
        requestWithResolver.reject?.(error);
      }
    }
  }

  /**
   * Utility: chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Get optimization statistics
   */
  getOptimizationStats(): {
    cacheStats: any;
    queuedRequests: number;
    pendingBatch: number;
    config: GraphOptimizationConfig;
  } {
    return {
      cacheStats: this.cacheManager.getStats(),
      queuedRequests: this.requestQueue.size,
      pendingBatch: this.pendingBatch.length,
      config: this.config,
    };
  }

  /**
   * Clear optimization cache and reset state
   */
  reset(): void {
    this.cacheManager.clear();
    this.requestQueue.clear();
    this.pendingBatch = [];

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }

    console.error('⚡ GraphOptimizer reset completed');
  }
}
