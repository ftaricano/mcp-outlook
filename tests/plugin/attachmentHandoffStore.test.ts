import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentHandoffError,
  AttachmentHandoffStore,
} from '../../src/plugin/attachmentHandoffStore.js';

const roots: string[] = [];
const KEY_ONE = ['123e4567', 'e89b', '42d3', 'a456', '426614174000'].join('-');
const KEY_TWO = ['123e4567', 'e89b', '42d3', 'a456', '426614174001'].join('-');

async function makeStore(
  overrides: Partial<{
    maxAttachmentBytes: number;
    maxStoreBytes: number;
    maxStoreEntries: number;
  }> = {}
) {
  const temporary = await mkdtemp(join(tmpdir(), 'outlook-handoff-store-'));
  roots.push(temporary);
  const root = join(temporary, 'private', 'outlook-handoffs');
  return {
    root,
    store: new AttachmentHandoffStore(
      {
        maxAttachmentBytes: 1024,
        maxStoreBytes: 4096,
        maxStoreEntries: 10,
        ...overrides,
      },
      root
    ),
  };
}

function request(idempotencyKey = KEY_ONE, attachmentId = 'attachment-1') {
  return {
    mailbox: 'finance',
    messageId: 'message-1',
    attachmentId,
    idempotencyKey,
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
  };
}

function handoffId(idempotencyKey: string): string {
  return `oh_${createHash('sha256')
    .update('mcp-outlook-attachment-handoff-v1\0')
    .update(idempotencyKey)
    .digest('base64url')}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AttachmentHandoffStore', () => {
  it('publishes a private integrity-checked bundle and replays it without overwriting', async () => {
    const { root, store } = await makeStore();
    const payload = Buffer.from('bounded attachment bytes');
    const created = await store.create(request(), payload);
    const replayed = await store.create(request(), Buffer.from('different bytes are ignored'));
    const bundle = join(root, created.handoffId);

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      status: 'ready',
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    expect(await readFile(join(bundle, 'payload.bin'))).toEqual(payload);
    expect(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))).toEqual(created);
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(bundle)).mode & 0o777).toBe(0o700);
      expect((await stat(join(bundle, 'payload.bin'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(bundle, 'manifest.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent publication of the same idempotency key', async () => {
    const { root, store } = await makeStore();
    const [first, second] = await Promise.all([
      store.create(request(), Buffer.from('first payload')),
      store.create(request(), Buffer.from('second payload')),
    ]);

    expect(second).toEqual(first);
    const stored = await readFile(join(root, first.handoffId, 'payload.bin'));
    expect([Buffer.from('first payload'), Buffer.from('second payload')]).toContainEqual(stored);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(first.sha256);
  });

  it('rejects idempotency mismatch and tampering', async () => {
    const { root, store } = await makeStore();
    const created = await store.create(request(), Buffer.from('original'));

    await expect(
      store.create(request(KEY_ONE, 'different-attachment'), Buffer.from('other'))
    ).rejects.toMatchObject<Partial<AttachmentHandoffError>>({
      code: 'HANDOFF_IDEMPOTENCY_MISMATCH',
    });

    await writeFile(join(root, created.handoffId, 'payload.bin'), 'tampered', { mode: 0o600 });
    await expect(store.get(created.handoffId)).rejects.toMatchObject<
      Partial<AttachmentHandoffError>
    >({ code: 'HANDOFF_INVALID' });
  });

  it('rejects an injected manifest field instead of exposing a local path', async () => {
    const { root, store } = await makeStore();
    const created = await store.create(request(), Buffer.from('original'));
    const manifestPath = join(root, created.handoffId, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, absolutePath: '/tmp/payload.bin' }),
      {
        mode: 0o600,
      }
    );

    await expect(store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
  });

  it('never overwrites an existing partial or hostile bundle', async () => {
    const { root, store } = await makeStore();
    await store.findReplay({
      mailbox: 'finance',
      messageId: 'message-1',
      attachmentId: 'attachment-1',
      idempotencyKey: KEY_ONE,
    });
    const occupied = handoffId(KEY_ONE);
    const occupiedPath = join(root, occupied);
    await mkdir(occupiedPath, { mode: 0o700 });
    await writeFile(join(occupiedPath, 'sentinel'), 'preserve-me', { mode: 0o600 });

    await expect(store.create(request(), Buffer.from('new'))).rejects.toBeDefined();
    expect(await readFile(join(occupiedPath, 'sentinel'), 'utf8')).toBe('preserve-me');
  });

  it('enforces per-item, aggregate-byte, and entry quotas', async () => {
    const oversized = await makeStore({ maxAttachmentBytes: 4 });
    await expect(oversized.store.create(request(), Buffer.from('12345'))).rejects.toMatchObject<
      Partial<AttachmentHandoffError>
    >({
      code: 'HANDOFF_QUOTA_EXCEEDED',
    });

    const aggregate = await makeStore({ maxAttachmentBytes: 10, maxStoreBytes: 6 });
    await aggregate.store.create(request(KEY_ONE), Buffer.from('1234'));
    await expect(
      aggregate.store.create(request(KEY_TWO), Buffer.from('5678'))
    ).rejects.toMatchObject<Partial<AttachmentHandoffError>>({
      code: 'HANDOFF_QUOTA_EXCEEDED',
    });

    const entries = await makeStore({ maxStoreEntries: 1 });
    await entries.store.create(request(KEY_ONE), Buffer.from('one'));
    await expect(entries.store.create(request(KEY_TWO), Buffer.from('two'))).rejects.toMatchObject<
      Partial<AttachmentHandoffError>
    >({
      code: 'HANDOFF_QUOTA_EXCEEDED',
    });
  });

  it('recovers an old lock whose owning process no longer exists', async () => {
    const { root, store } = await makeStore();
    await store.findReplay({
      mailbox: 'finance',
      messageId: 'message-1',
      attachmentId: 'attachment-1',
      idempotencyKey: KEY_ONE,
    });
    const lock = join(root, '.store.lock');
    await writeFile(
      lock,
      JSON.stringify({
        ownerToken: ['123e4567', 'e89b', '42d3', 'a456', '426614174999'].join('-'),
        pid: 999_999_999,
        createdAt: '2000-01-01T00:00:00.000Z',
      }),
      { mode: 0o600 }
    );
    await chmod(lock, 0o600);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, old, old);

    await expect(store.create(request(), Buffer.from('payload'))).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
