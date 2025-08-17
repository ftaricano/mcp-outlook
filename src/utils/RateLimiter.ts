/**
 * Rate Limiter for Microsoft Graph API calls
 * Implements exponential backoff with jitter
 */
export class RateLimiter {
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 1000; // 1 second

  /**
   * Check if a request should be rate limited
   */
  async checkRateLimit(endpoint: string, maxRequests: number = 60, windowMs: number = 60000): Promise<boolean> {
    const now = Date.now();
    const key = endpoint;
    
    let entry = this.requestCounts.get(key);
    
    // Reset window if expired
    if (!entry || now >= entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      this.requestCounts.set(key, entry);
    }
    
    // Check if limit exceeded
    if (entry.count >= maxRequests) {
      const waitTime = entry.resetTime - now;
      console.warn(`⚠️ Rate limit reached for ${endpoint}. Waiting ${waitTime}ms`);
      await this.delay(waitTime);
      
      // Reset after waiting
      entry.count = 0;
      entry.resetTime = now + windowMs;
    }
    
    entry.count++;
    return true;
  }

  /**
   * Execute a function with retry logic and exponential backoff
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: string = 'operation'
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw error;
        }
        
        if (attempt < this.maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);
          console.warn(`⚠️ ${context} failed (attempt ${attempt}/${this.maxRetries}). Retrying in ${delay}ms:`, error);
          await this.delay(delay);
        }
      }
    }
    
    console.error(`❌ ${context} failed after ${this.maxRetries} attempts`);
    throw lastError!;
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    return Math.min(exponentialDelay + jitter, 30000); // Max 30 seconds
  }

  /**
   * Check if error should not be retried
   */
  private isNonRetryableError(error: any): boolean {
    if (!error?.response?.status) return false;
    
    const status = error.response.status;
    
    // Don't retry on client errors (except rate limiting)
    if (status >= 400 && status < 500 && status !== 429) {
      return true;
    }
    
    // Don't retry on authentication errors
    if (status === 401 || status === 403) {
      return true;
    }
    
    return false;
  }

  /**
   * Wait for specified time
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clear rate limit data for an endpoint
   */
  clearRateLimit(endpoint: string): void {
    this.requestCounts.delete(endpoint);
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(endpoint: string): { count: number; remaining: number; resetTime: number } | null {
    const entry = this.requestCounts.get(endpoint);
    if (!entry) return null;
    
    return {
      count: entry.count,
      remaining: Math.max(0, 60 - entry.count), // Assuming 60 req/min default
      resetTime: entry.resetTime
    };
  }
}