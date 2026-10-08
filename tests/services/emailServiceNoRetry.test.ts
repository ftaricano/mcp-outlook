import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@microsoft/microsoft-graph-client';
import { EmailService } from '../../src/services/emailService.js';
import { SenderPolicy } from '../../src/security/senderPolicy.js';

function service() {
  const client = Client.initWithMiddleware({
    authProvider: { getAccessToken: async () => 'fictional-offline-token' },
  });
  return new EmailService(
    { getGraphClient: () => client } as never,
    { getDownloadRoot: () => '/tmp', getUploadRoots: () => ['/tmp'] } as never,
    {
      targetUserEmail: 'sender@example.test',
      senderPolicy: new SenderPolicy({}, {}),
      preloadCache: false,
      ensureDownloadDirectory: false,
    }
  );
}

afterEach(() => vi.restoreAllMocks());

describe('EmailService single-attempt send through the real SDK', () => {
  for (const status of [429, 503, 504, 307, 308]) {
    it.each([true, false, undefined])('status ' + status + ', noRetry=%s', async (noRetry) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
        const response = new Response(
          JSON.stringify({ error: { code: 'OfflineFixture', message: 'Fixture' } }),
          {
            status,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '0',
              Location: 'https://graph.microsoft.com/v1.0/users/sender@example.test/sendMail',
            },
          }
        );
        Object.defineProperty(response, 'url', { value: String(url) });
        return response;
      });
      await expect(
        service().sendEmail(
          ['recipient@example.test'],
          'Fixture',
          'Fixture',
          undefined,
          undefined,
          undefined,
          undefined,
          { noRetry }
        )
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(noRetry ? 1 : status === 307 || status === 308 ? 6 : 4);
      for (const [, options] of fetch.mock.calls) {
        expect(options?.method).toBe('POST');
        if (noRetry === true) expect(options?.redirect).toBe('manual');
      }
    });
  }
  it('accepts 202 without replay', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    await expect(
      service().sendEmail(
        ['recipient@example.test'],
        'Fixture',
        'Fixture',
        undefined,
        undefined,
        undefined,
        undefined,
        { noRetry: true }
      )
    ).resolves.toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
  });
  it('surfaces a network failure without replay', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Offline network fixture'));
    await expect(
      service().sendEmail(
        ['recipient@example.test'],
        'Fixture',
        'Fixture',
        undefined,
        undefined,
        undefined,
        undefined,
        { noRetry: true }
      )
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
  });
});
