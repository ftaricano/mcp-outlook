import { describe, it, expect } from 'vitest';
import { loadEnv, redact, EnvValidationError } from '../../src/config/env.js';

const validClientId = '11111111-1111-1111-1111-111111111111';
const validTenantId = '22222222-2222-2222-2222-222222222222';

const baseValid: NodeJS.ProcessEnv = {
  MICROSOFT_GRAPH_CLIENT_ID: validClientId,
  MICROSOFT_GRAPH_CLIENT_SECRET: 'super-secret-value',
  MICROSOFT_GRAPH_TENANT_ID: validTenantId
};

describe('loadEnv', () => {
  it('parses a minimal valid env', () => {
    const env = loadEnv(baseValid);
    expect(env.MICROSOFT_GRAPH_CLIENT_ID).toBe(validClientId);
    expect(env.MICROSOFT_GRAPH_CLIENT_SECRET).toBe('super-secret-value');
    expect(env.MICROSOFT_GRAPH_TENANT_ID).toBe(validTenantId);
    expect(env.DEBUG).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.MAX_ATTACHMENT_MB).toBe(25);
  });

  it('throws EnvValidationError when CLIENT_ID missing', () => {
    const env: NodeJS.ProcessEnv = { ...baseValid };
    delete env.MICROSOFT_GRAPH_CLIENT_ID;
    try {
      loadEnv(env);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as Error).message).toMatch(/MICROSOFT_GRAPH_CLIENT_ID/);
    }
  });

  it('throws on non-UUID CLIENT_ID', () => {
    const env = { ...baseValid, MICROSOFT_GRAPH_CLIENT_ID: 'not-a-uuid' };
    expect(() => loadEnv(env)).toThrow(EnvValidationError);
  });

  it('throws on invalid TARGET_USER_EMAIL', () => {
    const env = { ...baseValid, TARGET_USER_EMAIL: 'not-an-email' };
    expect(() => loadEnv(env)).toThrow(EnvValidationError);
  });

  it('empty TARGET_USER_EMAIL becomes undefined', () => {
    const env = { ...baseValid, TARGET_USER_EMAIL: '' };
    const parsed = loadEnv(env);
    expect(parsed.TARGET_USER_EMAIL).toBeUndefined();
  });

  it("DEBUG='true' parses as boolean true", () => {
    const env = { ...baseValid, DEBUG: 'true' };
    const parsed = loadEnv(env);
    expect(parsed.DEBUG).toBe(true);
  });

  it("DEBUG='false' parses as boolean false", () => {
    const env = { ...baseValid, DEBUG: 'false' };
    const parsed = loadEnv(env);
    expect(parsed.DEBUG).toBe(false);
  });

  it('coerces MAX_ATTACHMENT_MB from string', () => {
    const env = { ...baseValid, MAX_ATTACHMENT_MB: '50' };
    const parsed = loadEnv(env);
    expect(parsed.MAX_ATTACHMENT_MB).toBe(50);
  });

  it('rejects LOG_LEVEL outside enum', () => {
    const env = { ...baseValid, LOG_LEVEL: 'trace' };
    expect(() => loadEnv(env)).toThrow(EnvValidationError);
  });

  it('aggregates multiple issues in one error', () => {
    const env: NodeJS.ProcessEnv = {
      MICROSOFT_GRAPH_CLIENT_ID: 'bad',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'ok',
      MICROSOFT_GRAPH_TENANT_ID: 'bad'
    };
    try {
      loadEnv(env);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('redact', () => {
  it('returns (unset) for undefined', () => {
    expect(redact(undefined)).toBe('(unset)');
  });

  it('returns *** for short strings', () => {
    expect(redact('short')).toBe('***');
    expect(redact('12345678')).toBe('***'); // exactly 8 chars
  });

  it('shows first 4 chars + length for longer strings', () => {
    const out = redact('abcdefghij');
    expect(out).toMatch(/^abcd/);
    expect(out).toMatch(/10 chars/);
  });

  it('does not leak the full secret', () => {
    const secret = 'SUPER-SECRET-VALUE-1234567890';
    const out = redact(secret);
    expect(out).not.toContain('SECRET-VALUE');
  });
});
