import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailService } from '../../src/services/emailService.js';

function makeService(
  targetUserEmail: string,
  calls: string[],
  options: { downloadRoot?: string; ensureDownloadDirectory?: boolean } = {}
) {
  const chain: any = {
    select: () => chain,
    get: async () => ({ id: 'message' }),
  };
  const authProvider = {
    getGraphClient: () => ({
      api: (url: string) => {
        calls.push(url);
        return chain;
      },
    }),
  };
  const pathGuard = {
    getDownloadRoot: () => options.downloadRoot ?? '/tmp',
    getUploadRoots: () => [options.downloadRoot ?? '/tmp'],
  };

  return new EmailService(authProvider as never, pathGuard as never, {
    targetUserEmail,
    preloadCache: false,
    ensureDownloadDirectory: options.ensureDownloadDirectory,
  });
}

describe('EmailService mailbox isolation', () => {
  it('pins each service instance to its constructor mailbox', async () => {
    const calls: string[] = [];
    const first = makeService('first@example.com', calls);
    const second = makeService('second@example.com', calls);

    process.env.TARGET_USER_EMAIL = 'changed@example.com';

    await first.getEmailById('message-1');
    await second.getEmailById('message-2');

    expect(calls).toEqual([
      '/users/first@example.com/messages/message-1',
      '/users/second@example.com/messages/message-2',
    ]);
  });

  it('namespaces optimized cache keys by mailbox', async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const first = makeService('first@example.com', firstCalls) as any;
    const second = makeService('second@example.com', secondCalls) as any;
    const firstKey = vi.spyOn(first.cacheManager, 'generateEmailKey');
    const secondKey = vi.spyOn(second.cacheManager, 'generateEmailKey');
    vi.spyOn(first.cacheManager, 'get').mockReturnValue([]);
    vi.spyOn(second.cacheManager, 'get').mockReturnValue([]);

    await first.listEmails({ folder: 'inbox', maxResults: 5 });
    await second.listEmails({ folder: 'inbox', maxResults: 5 });

    expect(firstKey).toHaveBeenCalledWith(
      'list',
      expect.objectContaining({ mailbox: 'first@example.com' })
    );
    expect(secondKey).toHaveBeenCalledWith(
      'list',
      expect.objectContaining({ mailbox: 'second@example.com' })
    );
  });

  it('can construct a read-only service without creating a download directory', () => {
    const downloadRoot = join(mkdtempSync(join(tmpdir(), 'mcp-outlook-readonly-')), 'downloads');

    makeService('first@example.com', [], {
      downloadRoot,
      ensureDownloadDirectory: false,
    });

    expect(existsSync(downloadRoot)).toBe(false);
  });
});
