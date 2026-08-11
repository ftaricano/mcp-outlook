import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';

describe('EmailService.listFoldersDetailed fallback budget', () => {
  it('applies the 1000-item cap to the whole tree and reports truncation', async () => {
    const roots = Array.from({ length: 999 }, (_, index) => ({
      id: `root-${index}`,
      displayName: `Root ${index}`,
    }));
    const api = (url: string) => {
      const chain: any = {
        select: () => chain,
        top: () => chain,
        get: async () => {
          if (url === '/users/user@example.com/mailFolders') return { value: roots };
          if (url === '/users/user@example.com/mailFolders/root-0/childFolders') {
            return {
              value: [
                { id: 'child-1', displayName: 'Child 1' },
                { id: 'child-2', displayName: 'Child 2' },
              ],
            };
          }
          throw new Error(`unexpected url in test: ${url}`);
        },
      };
      return chain;
    };
    const service = Object.create(EmailService.prototype) as any;
    service.targetUserEmail = 'user@example.com';
    service.client = { api };
    service.graphOptimizer = {
      getOptimizedFoldersDetailed: vi.fn(async () => {
        throw new Error('force fallback');
      }),
    };

    const result = await service.listFoldersDetailed(true, 2);

    expect(result.items).toHaveLength(1000);
    expect(result.items.at(-1)).toMatchObject({ id: 'child-1' });
    expect(result.truncated).toBe(true);
  });
});
