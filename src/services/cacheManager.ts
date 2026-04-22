import { EventEmitter } from 'events';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
  tags: string[];
}

export interface CacheConfig {
  defaultTtl: number;
  maxSize: number;
  cleanupInterval: number;
  enableStats: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
  evictions: number;
  memoryUsage: number;
}

export class CacheManager extends EventEmitter {
  private cache: Map<string, CacheEntry<any>>;
  private config: CacheConfig;
  private stats: CacheStats;
  private cleanupTimer?: NodeJS.Timeout;
  private accessPatterns: Map<string, number>;

  constructor(config: Partial<CacheConfig> = {}) {
    super();
    
    this.config = {
      defaultTtl: 5 * 60 * 1000, // 5 minutes
      maxSize: 1000,
      cleanupInterval: 60 * 1000, // 1 minute
      enableStats: true,
      ...config
    };

    this.cache = new Map();
    this.accessPatterns = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      maxSize: this.config.maxSize,
      evictions: 0,
      memoryUsage: 0
    };

    this.startCleanupTimer();
    console.error('🗄️ CacheManager inicializado:', this.config);
  }

  /**
   * Get item from cache with intelligent access tracking
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      this.updateStats();
      this.emit('cache-miss', key);
      return null;
    }

    // Check if entry is expired
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.misses++;
      this.updateStats();
      this.emit('cache-expired', key);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;
    this.updateAccessPattern(key);
    this.updateStats();
    this.emit('cache-hit', key);

    return entry.data;
  }

  /**
   * Set item in cache with intelligent eviction
   */
  set<T>(key: string, data: T, options: {
    ttl?: number;
    tags?: string[];
    priority?: 'low' | 'normal' | 'high';
  } = {}): void {
    const {
      ttl = this.config.defaultTtl,
      tags = [],
      priority = 'normal'
    } = options;

    // Check if we need to evict items
    if (this.cache.size >= this.config.maxSize) {
      this.evictLeastUsed();
    }

    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl,
      accessCount: 0,
      lastAccessed: Date.now(),
      tags: [...tags, `priority:${priority}`]
    };

    this.cache.set(key, entry);
    this.updateStats();
    this.emit('cache-set', key, data);

    console.error(`💾 Cache SET: ${key} (TTL: ${ttl}ms, Size: ${this.cache.size})`);
  }

  /**
   * Smart cache key generation for email operations
   */
  generateEmailKey(operation: string, params: Record<string, any>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}:${JSON.stringify(params[key])}`)
      .join('|');
    
    return `email:${operation}:${Buffer.from(sortedParams).toString('base64')}`;
  }

  /**
   * Cache emails with automatic tagging
   */
  cacheEmails(key: string, emails: any[], folder?: string): void {
    const tags = ['emails'];
    if (folder) tags.push(`folder:${folder}`);
    
    this.set(key, emails, {
      ttl: 2 * 60 * 1000, // 2 minutes for email lists
      tags,
      priority: 'high'
    });
  }

  /**
   * Cache folders with longer TTL
   */
  cacheFolders(key: string, folders: any[]): void {
    this.set(key, folders, {
      ttl: 10 * 60 * 1000, // 10 minutes for folder structure
      tags: ['folders', 'metadata'],
      priority: 'high'
    });
  }

  /**
   * Cache user data with extended TTL
   */
  cacheUsers(key: string, users: any[]): void {
    this.set(key, users, {
      ttl: 30 * 60 * 1000, // 30 minutes for user data
      tags: ['users', 'metadata'],
      priority: 'normal'
    });
  }

  /**
   * Cache search results with dynamic TTL based on complexity
   */
  cacheSearchResults(key: string, results: any[], complexity: 'simple' | 'moderate' | 'complex'): void {
    const ttlMap = {
      simple: 5 * 60 * 1000,   // 5 minutes
      moderate: 3 * 60 * 1000, // 3 minutes
      complex: 1 * 60 * 1000   // 1 minute
    };

    this.set(key, results, {
      ttl: ttlMap[complexity],
      tags: ['search', `complexity:${complexity}`],
      priority: complexity === 'complex' ? 'low' : 'normal'
    });
  }

  /**
   * Invalidate cache by tags
   */
  invalidateByTags(tags: string[]): number {
    let invalidated = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (tags.some(tag => entry.tags.includes(tag))) {
        this.cache.delete(key);
        invalidated++;
        this.emit('cache-invalidated', key, tags);
      }
    }

    this.updateStats();
    console.error(`🗑️ Cache invalidated: ${invalidated} entries for tags: ${tags.join(', ')}`);
    return invalidated;
  }

  /**
   * Invalidate folder-related cache when folder operations occur
   */
  invalidateFolderCache(): void {
    this.invalidateByTags(['folders', 'emails']);
  }

  /**
   * Invalidate email cache when email operations occur
   */
  invalidateEmailCache(folder?: string): void {
    const tags = ['emails'];
    if (folder) tags.push(`folder:${folder}`);
    this.invalidateByTags(tags);
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  /**
   * Evict least recently used items with intelligence
   */
  private evictLeastUsed(): void {
    // Find candidates for eviction (exclude high priority items initially)
    const candidates = Array.from(this.cache.entries())
      .filter(([_, entry]) => !entry.tags.includes('priority:high'))
      .sort((a, b) => {
        // Sort by access frequency and recency
        const scoreA = a[1].accessCount * 0.7 + (Date.now() - a[1].lastAccessed) * 0.3;
        const scoreB = b[1].accessCount * 0.7 + (Date.now() - b[1].lastAccessed) * 0.3;
        return scoreA - scoreB;
      });

    // If no low/normal priority candidates, evict from high priority
    const toEvict = candidates.length > 0 ? candidates : Array.from(this.cache.entries());
    
    if (toEvict.length > 0) {
      const [keyToEvict] = toEvict[0];
      this.cache.delete(keyToEvict);
      this.stats.evictions++;
      this.emit('cache-evicted', keyToEvict);
      console.error(`🗑️ Cache evicted: ${keyToEvict} (LRU strategy)`);
    }
  }

  /**
   * Update access patterns for intelligent predictions
   */
  private updateAccessPattern(key: string): void {
    const current = this.accessPatterns.get(key) || 0;
    this.accessPatterns.set(key, current + 1);
  }

  /**
   * Update cache statistics
   */
  private updateStats(): void {
    this.stats.size = this.cache.size;
    this.stats.hitRate = this.stats.hits / (this.stats.hits + this.stats.misses) || 0;
    this.stats.memoryUsage = this.estimateMemoryUsage();
  }

  /**
   * Estimate memory usage of cache
   */
  private estimateMemoryUsage(): number {
    let totalSize = 0;
    for (const [key, entry] of this.cache.entries()) {
      totalSize += Buffer.byteLength(key, 'utf8');
      totalSize += Buffer.byteLength(JSON.stringify(entry.data), 'utf8');
      totalSize += 200; // Overhead for entry metadata
    }
    return totalSize;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        cleaned++;
        this.emit('cache-cleanup', key);
      }
    }

    if (cleaned > 0) {
      console.error(`🧹 Cache cleanup: ${cleaned} expired entries removed`);
      this.updateStats();
    }
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get most accessed cache keys
   */
  getHotKeys(limit: number = 10): Array<{ key: string; accessCount: number }> {
    return Array.from(this.accessPatterns.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([key, accessCount]) => ({ key, accessCount }));
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.accessPatterns.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
    this.updateStats();
    this.emit('cache-cleared');
    console.error(`🗑️ Cache cleared: ${size} entries removed`);
  }

  /**
   * Graceful shutdown
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
    this.removeAllListeners();
    console.error('🗄️ CacheManager destroyed');
  }

  /**
   * Preload common data patterns
   */
  async preloadCommonPatterns(emailService: any): Promise<void> {
    try {
      console.error('🔄 Preloading common cache patterns...');
      
      // Preload folders (commonly accessed)
      const folders = await emailService.listFolders(false, 2);
      this.cacheFolders('folders:root', folders);
      
      // Preload inbox emails (most common operation)
      const inboxEmails = await emailService.listEmails({ maxResults: 20, folder: 'inbox' });
      this.cacheEmails('emails:inbox:recent', inboxEmails, 'inbox');
      
      console.error('✅ Cache preloading completed');
    } catch (error) {
      console.warn('⚠️ Cache preloading failed:', error);
    }
  }
}