import { Client } from '@microsoft/microsoft-graph-client';
import { CacheManager } from './cacheManager.js';

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
  private pendingBatch: BatchRequest[];
  private batchTimeout?: NodeJS.Timeout;
  private requestQueue: Map<string, Promise<any>>;

  constructor(client: Client, cacheManager: CacheManager, config: Partial<GraphOptimizationConfig> = {}) {
    this.client = client;
    this.cacheManager = cacheManager;
    this.config = {
      enableBatching: true,
      batchSize: 20,
      enableCompression: true,
      enableSelectiveFields: true,
      enableDeltaQueries: false, // Requires special setup
      requestTimeout: 30000,
      ...config
    };

    this.pendingBatch = [];
    this.requestQueue = new Map();

    console.log('⚡ GraphOptimizer inicializado:', this.config);
  }

  /**
   * Optimized email listing with selective fields and caching
   */
  async getOptimizedEmails(options: OptimizedQueryOptions & {
    folder?: string;
    maxResults?: number;
    search?: string;
  }): Promise<any[]> {
    const {
      folder = 'inbox',
      maxResults = 10,
      search,
      enableCache = true,
      select = [
        'id', 'subject', 'from', 'toRecipients', 'receivedDateTime', 
        'isRead', 'importance', 'hasAttachments', 'bodyPreview'
      ],
      ...queryOptions
    } = options;

    // Generate cache key
    const cacheKey = this.cacheManager.generateEmailKey('list', {
      folder, maxResults, search, select: select.sort()
    });

    // Try cache first
    if (enableCache) {
      const cached = this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit: emails from ${folder}`);
        return cached;
      }
    }

    // Build optimized query
    let query = this.buildOptimizedQuery(queryOptions);
    
    // Add selective fields
    if (this.config.enableSelectiveFields && select.length > 0) {
      query = query.select(select);
    }

    // Add search filter
    if (search) {
      const searchFilter = `contains(subject,'${search}') or contains(from/emailAddress/address,'${search}')`;
      query = query.filter(searchFilter);
    }

    // Add pagination
    if (maxResults) {
      query = query.top(Math.min(maxResults, 999)); // Graph API limit
    }

    try {
      const folderPath = folder === 'inbox' ? '/me/mailFolders/inbox' : `/me/mailFolders/${folder}`;
      const emails = await query
        .api(`${folderPath}/messages`)
        .get();

      const emailList = emails.value || [];
      
      // Cache results
      if (enableCache) {
        this.cacheManager.cacheEmails(cacheKey, emailList, folder);
      }

      console.log(`⚡ Fetched ${emailList.length} emails from ${folder} (optimized)`);
      return emailList;
    } catch (error) {
      console.error('❌ Error in optimized email fetch:', error);
      throw error;
    }
  }

  /**
   * Optimized folder listing with caching
   */
  async getOptimizedFolders(options: OptimizedQueryOptions & {
    includeSubfolders?: boolean;
    maxDepth?: number;
  } = {}): Promise<any[]> {
    const {
      includeSubfolders = true,
      maxDepth = 3,
      enableCache = true,
      select = ['id', 'displayName', 'totalItemCount', 'unreadItemCount', 'parentFolderId'],
      ...queryOptions
    } = options;

    const cacheKey = `folders:optimized:${includeSubfolders}:${maxDepth}`;

    // Try cache first
    if (enableCache) {
      const cached = this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        console.log('⚡ Cache hit: folder structure');
        return cached;
      }
    }

    try {
      let query = this.buildOptimizedQuery(queryOptions);
      
      if (this.config.enableSelectiveFields) {
        query = query.select(select);
      }

      const folders = await query
        .api('/me/mailFolders')
        .get();

      let folderList = folders.value || [];

      // Recursively get subfolders if needed
      if (includeSubfolders && maxDepth > 1) {
        folderList = await this.getSubfoldersRecursive(folderList, maxDepth - 1, select);
      }

      // Cache results with longer TTL for folders
      if (enableCache) {
        this.cacheManager.cacheFolders(cacheKey, folderList);
      }

      console.log(`⚡ Fetched ${folderList.length} folders (optimized, depth: ${maxDepth})`);
      return folderList;
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

    console.log(`⚡ Executing ${requests.length} requests in ${batches.length} batch(es)`);

    for (const batch of batches) {
      try {
        const batchRequest = {
          requests: batch.map(req => ({
            id: req.id,
            method: req.method,
            url: req.url,
            body: req.body,
            headers: {
              'Content-Type': 'application/json',
              ...req.headers
            }
          }))
        };

        const response = await this.client
          .api('/$batch')
          .post(batchRequest);

        // Process batch responses
        if (response.responses) {
          for (const batchResponse of response.responses) {
            results.set(batchResponse.id, {
              status: batchResponse.status,
              data: batchResponse.body,
              success: batchResponse.status >= 200 && batchResponse.status < 300
            });
          }
        }

        // Small delay between batches to avoid throttling
        if (batches.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('❌ Batch execution error:', error);
        // Mark all requests in this batch as failed
        for (const req of batch) {
          results.set(req.id, {
            status: 500,
            data: { error: error instanceof Error ? error.message : 'Batch execution failed' },
            success: false
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
      this.requestQueue.set(request.id, Promise.resolve().then(() => {
        // This will be resolved when batch executes
        return new Promise((batchResolve, batchReject) => {
          const originalRequest = request;
          (originalRequest as any).resolve = batchResolve;
          (originalRequest as any).reject = batchReject;
        });
      }));

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
        'id', 'subject', 'from', 'receivedDateTime', 'isRead', 
        'importance', 'hasAttachments', 'bodyPreview'
      ],
      details: [
        'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'bccRecipients',
        'receivedDateTime', 'sentDateTime', 'isRead', 'importance', 'hasAttachments',
        'body', 'bodyPreview', 'categories', 'flag', 'parentFolderId'
      ],
      search: [
        'id', 'subject', 'from', 'receivedDateTime', 'isRead', 
        'hasAttachments', 'bodyPreview', 'importance'
      ],
      metadata: [
        'id', 'subject', 'from', 'receivedDateTime', 'isRead', 
        'importance', 'hasAttachments', 'parentFolderId'
      ]
    };

    return fieldSets[operation] || fieldSets.list;
  }

  /**
   * Optimize search queries with intelligent filtering
   */
  optimizeSearchQuery(searchTerm: string, options: {
    searchIn?: ('subject' | 'body' | 'from' | 'to')[];
    dateRange?: { start: string; end: string };
    importance?: 'low' | 'normal' | 'high';
    hasAttachments?: boolean;
    isRead?: boolean;
  } = {}): string {
    const {
      searchIn = ['subject', 'from'],
      dateRange,
      importance,
      hasAttachments,
      isRead
    } = options;

    const filters: string[] = [];

    // Text search with field targeting
    if (searchTerm) {
      const searchConditions = searchIn.map(field => {
        switch (field) {
          case 'subject':
            return `contains(subject,'${searchTerm}')`;
          case 'body':
            return `contains(body/content,'${searchTerm}')`;
          case 'from':
            return `contains(from/emailAddress/address,'${searchTerm}')`;
          case 'to':
            return `contains(toRecipients/any(to: to/emailAddress/address),'${searchTerm}')`;
          default:
            return `contains(subject,'${searchTerm}')`;
        }
      });
      filters.push(`(${searchConditions.join(' or ')})`);
    }

    // Date range filter
    if (dateRange) {
      filters.push(`receivedDateTime ge ${dateRange.start} and receivedDateTime le ${dateRange.end}`);
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
  private buildOptimizedQuery(options: OptimizedQueryOptions): any {
    let query = this.client.api('');

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
   * Recursively get subfolders with depth control
   */
  private async getSubfoldersRecursive(folders: any[], remainingDepth: number, selectFields: string[]): Promise<any[]> {
    if (remainingDepth <= 0) return folders;

    const allFolders = [...folders];

    for (const folder of folders) {
      try {
        const subfolders = await this.client
          .api(`/me/mailFolders/${folder.id}/childFolders`)
          .select(selectFields)
          .get();

        if (subfolders.value && subfolders.value.length > 0) {
          const nestedSubfolders = await this.getSubfoldersRecursive(
            subfolders.value, 
            remainingDepth - 1, 
            selectFields
          );
          allFolders.push(...nestedSubfolders);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to get subfolders for ${folder.displayName}:`, error);
      }
    }

    return allFolders;
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
      config: this.config
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

    console.log('⚡ GraphOptimizer reset completed');
  }
}