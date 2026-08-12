import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquirePosixFlock,
  AttachmentHandoffError,
  AttachmentHandoffStore,
  type AttachmentHandoffStoreHooks,
} from '../../src/plugin/attachmentHandoffStore.js';

const roots: string[] = [];
const KEY_ONE = ['123e4567', 'e89b', '42d3', 'a456', '426614174000'].join('-');
const KEY_TWO = ['123e4567', 'e89b', '42d3', 'a456', '426614174001'].join('-');

async function makeStore(
  overrides: Partial<{
    maxAttachmentBytes: number;
    maxStoreBytes: number;
    maxStoreEntries: number;
  }> = {},
  hooks: AttachmentHandoffStoreHooks = {}
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
      root,
      hooks
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
    .update(idempotencyKey.toLowerCase())
    .digest('base64url')}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AttachmentHandoffStore', () => {
  it('keeps get read-only when the store root does not exist', async () => {
    const { root, store } = await makeStore();

    await expect(store.get(handoffId(KEY_ONE))).rejects.toMatchObject({
      code: 'HANDOFF_NOT_FOUND',
    });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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

  it('coordinates replay lookup with manifest-last publication', async () => {
    let entered!: () => void;
    let resume!: () => void;
    const payloadPublished = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publicationMayFinish = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const { store } = await makeStore(
      {},
      {
        afterPayloadPublished: async () => {
          entered();
          await publicationMayFinish;
        },
      }
    );
    const identity = {
      mailbox: 'finance',
      messageId: 'message-1',
      attachmentId: 'attachment-1',
      idempotencyKey: KEY_ONE,
    };

    const publishing = store.create(request(), Buffer.from('payload'));
    await payloadPublished;
    let lookupSettled = false;
    const lookup = store.findReplay(identity).finally(() => {
      lookupSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lookupSettled).toBe(false);
    resume();

    const [created, replay] = await Promise.all([publishing, lookup]);
    expect(replay).toEqual(created);
  });

  it('recovers a crash before the manifest commit marker and retries safely', async () => {
    let failOnce = true;
    const { root, store } = await makeStore(
      {},
      {
        afterPayloadPublished: () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('simulated crash before manifest publication');
          }
        },
      }
    );
    const payload = Buffer.from('recoverable payload');

    await expect(store.create(request(), payload)).rejects.toThrow(
      'simulated crash before manifest publication'
    );
    const bundle = join(root, handoffId(KEY_ONE));
    expect(await readFile(join(bundle, 'payload.bin'))).toEqual(payload);
    await expect(lstat(join(bundle, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const recovered = await store.create(request(), payload);
    expect(recovered.status).toBe('ready');
    expect(await store.get(recovered.handoffId)).toEqual(recovered);
  });

  it('fsyncs the store root after creating a bundle entry before publication', async () => {
    let observedBundle = false;
    const { root, store } = await makeStore(
      {},
      {
        afterStoreRootSynced: async () => {
          const bundle = await stat(join(root, handoffId(KEY_ONE)));
          observedBundle = bundle.isDirectory();
        },
      }
    );

    await store.create(request(), Buffer.from('payload'));
    expect(observedBundle).toBe(true);
  });

  it('canonicalizes UUIDv4 casing for the opaque id and replay fingerprint', async () => {
    const { store } = await makeStore();
    const lower = await store.create(request(KEY_ONE), Buffer.from('payload'));
    const upper = await store.create(request(KEY_ONE.toUpperCase()), Buffer.from('ignored'));

    expect(upper).toEqual(lower);
    expect(lower.handoffId).toBe(handoffId(KEY_ONE));
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

  it('uses a persistent kernel lock and releases it when the holder crashes', async () => {
    const { root, store } = await makeStore();
    await store.findReplay(request());
    const lock = join(root, '.store.lock');
    const first = await acquirePosixFlock(lock, { attempts: 1 });
    await expect(acquirePosixFlock(lock, { attempts: 1 })).rejects.toMatchObject({
      code: 'HANDOFF_BUSY',
    });
    await first.terminate();
    const recovered = await acquirePosixFlock(lock, { attempts: 1 });
    await recovered.release();
    expect((await lstat(lock)).isFile()).toBe(true);
  });

  it('never removes a replacement lock inode during holder cleanup', async () => {
    const { root, store } = await makeStore();
    await store.findReplay(request());
    const lock = join(root, '.store.lock');
    const holder = await acquirePosixFlock(lock, { attempts: 1 });
    const displaced = join(root, '.displaced.lock');
    await rename(lock, displaced);
    await writeFile(lock, '', { mode: 0o600, flag: 'wx' });
    const replacement = await lstat(lock);

    await holder.terminate();

    const after = await lstat(lock);
    expect([after.dev, after.ino]).toEqual([replacement.dev, replacement.ino]);
  });

  it('fails closed and reaps a hung or early-exit lock helper', async () => {
    const { root, store } = await makeStore();
    await store.findReplay(request());
    const lock = join(root, '.store.lock');

    await expect(
      acquirePosixFlock(lock, {
        attempts: 1,
        handshakeTimeoutMs: 30,
        releaseTimeoutMs: 500,
        helperCode: 'import sys, time; sys.stdin.buffer.readline(); time.sleep(60)',
      })
    ).rejects.toMatchObject({ code: 'HANDOFF_STORAGE_FAILED' });
    await expect(
      acquirePosixFlock(lock, {
        attempts: 1,
        handshakeTimeoutMs: 500,
        releaseTimeoutMs: 500,
        helperCode: 'import sys; print("LOCKED 1 1", flush=True); sys.exit(0)',
      })
    ).rejects.toMatchObject({ code: 'HANDOFF_STORAGE_FAILED' });
    await expect(
      acquirePosixFlock(lock, {
        attempts: 1,
        executable: '/definitely/missing/python3',
      })
    ).rejects.toMatchObject({ code: 'HANDOFF_UNSUPPORTED_PLATFORM' });
    await expect(
      acquirePosixFlock(lock, {
        attempts: 1,
        handshakeTimeoutMs: 500,
        releaseTimeoutMs: 500,
        helperCode: 'import sys; sys.exit(0)',
      })
    ).rejects.toMatchObject({ code: 'HANDOFF_STORAGE_FAILED' });

    const healthy = await acquirePosixFlock(lock, { attempts: 1 });
    await healthy.release();
  });

  it('rejects hostile root, bundle, file modes, symlinks, and hard links', async () => {
    const hostileRoot = await makeStore();
    const target = join(hostileRoot.root, '..', 'target');
    await mkdir(join(hostileRoot.root, '..'), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await symlink(target, hostileRoot.root);
    await expect(hostileRoot.store.create(request(), Buffer.from('payload'))).rejects.toMatchObject(
      { code: 'HANDOFF_STORAGE_FAILED' }
    );

    const parentTemporary = await mkdtemp(join(tmpdir(), 'outlook-handoff-parent-link-'));
    roots.push(parentTemporary);
    const parentTarget = join(parentTemporary, 'target');
    const parentLink = join(parentTemporary, 'private');
    await mkdir(parentTarget, { mode: 0o700 });
    await symlink(parentTarget, parentLink);
    const parentLinkedStore = new AttachmentHandoffStore(
      { maxAttachmentBytes: 1024, maxStoreBytes: 4096, maxStoreEntries: 10 },
      join(parentLink, 'outlook-handoffs')
    );
    await expect(parentLinkedStore.create(request(), Buffer.from('payload'))).rejects.toMatchObject(
      { code: 'HANDOFF_STORAGE_FAILED' }
    );

    const privateStore = await makeStore();
    const created = await privateStore.store.create(request(), Buffer.from('payload'));
    const bundle = join(privateStore.root, created.handoffId);
    await chmod(privateStore.root, 0o755);
    await expect(privateStore.store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
    expect((await stat(privateStore.root)).mode & 0o777).toBe(0o755);
    await chmod(privateStore.root, 0o700);
    await chmod(bundle, 0o755);
    await expect(privateStore.store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
    await chmod(bundle, 0o700);

    const payload = join(bundle, 'payload.bin');
    await chmod(payload, 0o640);
    await expect(privateStore.store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
    await chmod(payload, 0o600);
    const extraLink = join(bundle, 'extra-link');
    await link(payload, extraLink);
    await expect(privateStore.store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
    await unlink(extraLink);
    await unlink(payload);
    const outside = join(privateStore.root, 'outside.bin');
    await writeFile(outside, 'payload', { mode: 0o600 });
    await symlink(outside, payload);
    await expect(privateStore.store.get(created.handoffId)).rejects.toMatchObject({
      code: 'HANDOFF_INVALID',
    });
  });
});
