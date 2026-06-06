import { describe, it, expect } from 'vitest';
import { GraphAuthProvider } from '../../src/auth/graphAuth.js';

const fakeEnv: any = {
  MICROSOFT_GRAPH_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
  MICROSOFT_GRAPH_CLIENT_SECRET: 'fake-secret',
  MICROSOFT_GRAPH_TENANT_ID: '11111111-1111-1111-1111-111111111111',
};

describe('GraphAuthProvider.getAccessToken — refresh-failure handling', () => {
  it('clears a cached expired token when re-acquisition fails (no stale token served)', async () => {
    const provider = new GraphAuthProvider(fakeEnv);
    // Seed an expired cached token and force MSAL to fail the re-acquisition.
    (provider as any).accessToken = 'stale-token';
    (provider as any).tokenExpiresAt = new Date(Date.now() - 60_000);
    (provider as any).msalInstance = {
      acquireTokenByClientCredential: async () => {
        throw new Error('AADSTS7000215: invalid client secret');
      },
    };

    await expect(provider.getAccessToken()).rejects.toThrow(/Authentication failed/);
    expect((provider as any).accessToken).toBeNull();
    expect((provider as any).tokenExpiresAt).toBeNull();
  });

  it('returns the cached token while it is still valid (no re-acquisition)', async () => {
    const provider = new GraphAuthProvider(fakeEnv);
    (provider as any).accessToken = 'good-token';
    (provider as any).tokenExpiresAt = new Date(Date.now() + 10 * 60_000);
    (provider as any).msalInstance = {
      acquireTokenByClientCredential: async () => {
        throw new Error('must not be called');
      },
    };

    await expect(provider.getAccessToken()).resolves.toBe('good-token');
  });
});
