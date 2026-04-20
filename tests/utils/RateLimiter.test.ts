import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/utils/RateLimiter.js';

describe('RateLimiter.executeWithRetry', () => {
  beforeEach(() => {
    // Speed up retry delays so tests don't wait seconds.
    vi.useFakeTimers();
    // Silence expected console.warn/error spam from the SUT.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately on first-attempt success', async () => {
    const limiter = new RateLimiter();
    const op = vi.fn().mockResolvedValue('ok');
    const result = await limiter.executeWithRetry(op, 'test');
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and returns on eventual success', async () => {
    const limiter = new RateLimiter();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('done');

    const promise = limiter.executeWithRetry(op, 'test');
    // Advance timers so the internal setTimeouts resolve.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('done');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const limiter = new RateLimiter();
    const lastErr = new Error('always fails');
    const op = vi.fn().mockRejectedValue(lastErr);

    const promise = limiter.executeWithRetry(op, 'test');
    // Attach a catch handler synchronously so the rejection isn't classified
    // as unhandled while fake timers advance.
    const assertion = expect(promise).rejects.toThrow('always fails');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 401 (non-retryable auth error)', async () => {
    const limiter = new RateLimiter();
    const authErr: any = new Error('unauthorized');
    authErr.response = { status: 401 };
    const op = vi.fn().mockRejectedValue(authErr);

    await expect(limiter.executeWithRetry(op, 'test')).rejects.toBe(authErr);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404 (non-retryable client error)', async () => {
    const limiter = new RateLimiter();
    const err: any = new Error('not found');
    err.response = { status: 404 };
    const op = vi.fn().mockRejectedValue(err);

    await expect(limiter.executeWithRetry(op, 'test')).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('does retry on 429 (rate limited)', async () => {
    const limiter = new RateLimiter();
    const err: any = new Error('rate limited');
    err.response = { status: 429 };
    const op = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const promise = limiter.executeWithRetry(op, 'test');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does retry on 500 (server error)', async () => {
    const limiter = new RateLimiter();
    const err: any = new Error('server error');
    err.response = { status: 500 };
    const op = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const promise = limiter.executeWithRetry(op, 'test');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
  });
});

describe('RateLimiter.clearRateLimit / getRateLimitStatus', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRateLimitStatus returns null for unknown endpoint', () => {
    const limiter = new RateLimiter();
    expect(limiter.getRateLimitStatus('unknown')).toBeNull();
  });

  it('checkRateLimit + getRateLimitStatus reports current count', async () => {
    const limiter = new RateLimiter();
    await limiter.checkRateLimit('ep1', 60, 60_000);
    const status = limiter.getRateLimitStatus('ep1');
    expect(status).not.toBeNull();
    expect(status!.count).toBe(1);
    expect(status!.remaining).toBe(59);
  });

  it('clearRateLimit removes the entry', async () => {
    const limiter = new RateLimiter();
    await limiter.checkRateLimit('ep1');
    limiter.clearRateLimit('ep1');
    expect(limiter.getRateLimitStatus('ep1')).toBeNull();
  });
});
