import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SavedSearchStore } from '../../src/services/savedSearchStore.js';

const tempDirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-outlook-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SavedSearchStore', () => {
  it('persists a saved search across store instances', async () => {
    const dir = await tempStateDir();
    const first = new SavedSearchStore(dir);
    await first.save('faturas', { query: 'fatura', hasAttachments: true });

    const second = new SavedSearchStore(dir);
    expect(await second.list()).toEqual([
      expect.objectContaining({
        name: 'faturas',
        criteria: { query: 'fatura', hasAttachments: true },
      }),
    ]);
  });

  it('persists deletion across store instances', async () => {
    const dir = await tempStateDir();
    const first = new SavedSearchStore(dir);
    await first.save('faturas', { query: 'fatura' });
    expect(await first.delete('faturas')).toBe(true);

    const second = new SavedSearchStore(dir);
    expect(await second.list()).toEqual([]);
    expect(await second.delete('missing')).toBe(false);
  });

  it('writes the state file with owner-only permissions', async () => {
    const dir = await tempStateDir();
    const store = new SavedSearchStore(dir);
    await store.save('private', { sender: 'finance@example.com' });

    const fileStat = await stat(join(dir, 'saved-searches.json'));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('fails loudly on corrupt JSON and does not overwrite it', async () => {
    const dir = await tempStateDir();
    const path = join(dir, 'saved-searches.json');
    await writeFile(path, '{broken', { mode: 0o600 });
    const store = new SavedSearchStore(dir);

    await expect(store.list()).rejects.toThrow(/corrupt/i);
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('preserves concurrent saves from separate store instances', async () => {
    const dir = await tempStateDir();
    const stores = Array.from({ length: 12 }, () => new SavedSearchStore(dir));

    await Promise.all(
      stores.map((store, index) => store.save(`search-${index}`, { query: `query-${index}` }))
    );

    const saved = await new SavedSearchStore(dir).list();
    expect(saved.map((search) => search.name)).toEqual(
      Array.from({ length: 12 }, (_, index) => `search-${index}`).sort()
    );
  });

  it('rejects malformed search maps and reserved property names', async () => {
    const dir = await tempStateDir();
    const path = join(dir, 'saved-searches.json');
    await writeFile(path, '{"version":1,"searches":[]}', { mode: 0o600 });

    await expect(new SavedSearchStore(dir).list()).rejects.toThrow(/corrupt/i);

    await writeFile(path, '{"version":1,"searches":{}}', { mode: 0o600 });
    await expect(new SavedSearchStore(dir).save('__proto__', { query: 'hidden' })).rejects.toThrow(
      /reserved/i
    );
  });

  it('rejects malformed saved-search entry fields', async () => {
    const dir = await tempStateDir();
    const path = join(dir, 'saved-searches.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        searches: {
          broken: {
            name: 'broken',
            criteria: { query: 123, maxPages: 'many' },
            created: 'not-a-date',
            updated: 'also-not-a-date',
          },
        },
      }),
      { mode: 0o600 }
    );

    await expect(new SavedSearchStore(dir).list()).rejects.toThrow(/corrupt/i);
  });

  it('rejects invalid criteria before writing state', async () => {
    const dir = await tempStateDir();
    const store = new SavedSearchStore(dir);

    await expect(store.save('broken', { query: 123, maxPages: 'many' } as any)).rejects.toThrow(
      /criteria/i
    );
    await expect(readFile(join(dir, 'saved-searches.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
