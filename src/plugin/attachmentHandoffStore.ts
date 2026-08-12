import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HANDOFF_ID_RE = /^oh_[A-Za-z0-9_-]{43}$/;
const MANIFEST_MAX_BYTES = 64 * 1024;
const STORE_LOCK_NAME = '.store.lock';
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_MAX_BYTES = 4096;

export type AttachmentHandoffErrorCode =
  | 'ATTACHMENT_FETCH_FAILED'
  | 'ATTACHMENT_LIST_INCOMPLETE'
  | 'ATTACHMENT_METADATA_INVALID'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_TOO_LARGE'
  | 'HANDOFF_BUSY'
  | 'HANDOFF_DISABLED'
  | 'HANDOFF_IDEMPOTENCY_MISMATCH'
  | 'HANDOFF_INVALID'
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_QUOTA_EXCEEDED'
  | 'HANDOFF_STORAGE_FAILED';

export class AttachmentHandoffError extends Error {
  constructor(readonly code: AttachmentHandoffErrorCode) {
    super(code);
    this.name = 'AttachmentHandoffError';
  }
}

export interface AttachmentHandoffManifest {
  readonly version: 1;
  readonly handoffId: string;
  readonly requestFingerprint: string;
  readonly mailbox: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly status: 'ready';
}

export interface AttachmentHandoffIdentity {
  readonly mailbox: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly idempotencyKey: string;
}

export interface AttachmentHandoffRequest extends AttachmentHandoffIdentity {
  readonly filename: string;
  readonly contentType: string;
}

export interface AttachmentHandoffStoreLimits {
  readonly maxAttachmentBytes: number;
  readonly maxStoreBytes: number;
  readonly maxStoreEntries: number;
}

export function defaultAttachmentHandoffRoot(): string {
  return join(homedir(), '.jarvishub-mcp', 'outlook-handoffs');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function handoffIdFor(idempotencyKey: string): string {
  return `oh_${createHash('sha256')
    .update('mcp-outlook-attachment-handoff-v1\0')
    .update(idempotencyKey)
    .digest('base64url')}`;
}

function requestFingerprint(request: AttachmentHandoffIdentity): string {
  return sha256(
    JSON.stringify([
      request.mailbox,
      request.messageId,
      request.attachmentId,
      request.idempotencyKey,
    ])
  );
}

function isPrivateMode(mode: number, ownerMask: number): boolean {
  return process.platform === 'win32' || ((mode & 0o077) === 0 && (mode & ownerMask) === ownerMask);
}

function isManifest(value: unknown): value is AttachmentHandoffManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Record<string, unknown>;
  const expectedKeys = new Set([
    'version',
    'handoffId',
    'requestFingerprint',
    'mailbox',
    'messageId',
    'attachmentId',
    'filename',
    'contentType',
    'size',
    'sha256',
    'createdAt',
    'status',
  ]);
  return (
    Object.keys(manifest).length === expectedKeys.size &&
    Object.keys(manifest).every((key) => expectedKeys.has(key)) &&
    manifest.version === 1 &&
    typeof manifest.handoffId === 'string' &&
    HANDOFF_ID_RE.test(manifest.handoffId) &&
    typeof manifest.requestFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.requestFingerprint) &&
    typeof manifest.mailbox === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.mailbox) &&
    typeof manifest.messageId === 'string' &&
    manifest.messageId.length >= 1 &&
    manifest.messageId.length <= 512 &&
    typeof manifest.attachmentId === 'string' &&
    manifest.attachmentId.length >= 1 &&
    manifest.attachmentId.length <= 512 &&
    typeof manifest.filename === 'string' &&
    manifest.filename.length >= 1 &&
    Buffer.byteLength(manifest.filename, 'utf8') <= 240 &&
    !/[\\/\0-\x1f\x7f]/.test(manifest.filename) &&
    !manifest.filename.includes('..') &&
    typeof manifest.contentType === 'string' &&
    manifest.contentType.length >= 1 &&
    Buffer.byteLength(manifest.contentType, 'utf8') <= 255 &&
    !/[\0-\x1f\x7f]/.test(manifest.contentType) &&
    Number.isSafeInteger(manifest.size) &&
    (manifest.size as number) >= 0 &&
    typeof manifest.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.sha256) &&
    typeof manifest.createdAt === 'string' &&
    !Number.isNaN(Date.parse(manifest.createdAt)) &&
    manifest.status === 'ready'
  );
}

async function writePrivateFile(path: string, contents: string | Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AttachmentHandoffStore {
  constructor(
    private readonly limits: AttachmentHandoffStoreLimits,
    private readonly root = defaultAttachmentHandoffRoot()
  ) {}

  async create(
    request: AttachmentHandoffRequest,
    payload: Buffer
  ): Promise<AttachmentHandoffManifest> {
    if (payload.length > this.limits.maxAttachmentBytes) {
      throw new AttachmentHandoffError('HANDOFF_QUOTA_EXCEEDED');
    }

    await this.ensurePrivateRoot();
    const handoffId = handoffIdFor(request.idempotencyKey);
    const fingerprint = requestFingerprint(request);

    return this.withStoreLock(async () => {
      const existing = await this.readIfPresent(handoffId, true);
      if (existing) return this.acceptReplay(existing, fingerprint);

      const usage = await this.storeUsage();
      if (
        usage.entries + 1 > this.limits.maxStoreEntries ||
        usage.bytes + payload.length > this.limits.maxStoreBytes
      ) {
        throw new AttachmentHandoffError('HANDOFF_QUOTA_EXCEEDED');
      }

      const bundlePath = join(this.root, handoffId);
      let reserved = false;
      try {
        await mkdir(bundlePath, { mode: 0o700 });
        reserved = true;
        await chmod(bundlePath, 0o700);

        const manifest: AttachmentHandoffManifest = {
          version: 1,
          handoffId,
          requestFingerprint: fingerprint,
          mailbox: request.mailbox,
          messageId: request.messageId,
          attachmentId: request.attachmentId,
          filename: request.filename,
          contentType: request.contentType,
          size: payload.length,
          sha256: sha256(payload),
          createdAt: new Date().toISOString(),
          status: 'ready',
        };

        const nonce = randomUUID();
        const payloadTemporary = join(bundlePath, `.payload-${nonce}.tmp`);
        const manifestTemporary = join(bundlePath, `.manifest-${nonce}.tmp`);
        await writePrivateFile(payloadTemporary, payload);
        await rename(payloadTemporary, join(bundlePath, 'payload.bin'));
        await syncDirectory(bundlePath);
        await writePrivateFile(manifestTemporary, `${JSON.stringify(manifest)}\n`);
        await rename(manifestTemporary, join(bundlePath, 'manifest.json'));
        await syncDirectory(bundlePath);
        return await this.readBundle(handoffId, true);
      } catch (error) {
        if (reserved) await rm(bundlePath, { recursive: true, force: true });
        if (error instanceof AttachmentHandoffError) throw error;
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    });
  }

  async findReplay(identity: AttachmentHandoffIdentity): Promise<AttachmentHandoffManifest | null> {
    await this.ensurePrivateRoot();
    const handoffId = handoffIdFor(identity.idempotencyKey);
    const existing = await this.readIfPresent(handoffId, true);
    return existing ? this.acceptReplay(existing, requestFingerprint(identity)) : null;
  }

  async get(handoffId: string): Promise<AttachmentHandoffManifest> {
    if (!HANDOFF_ID_RE.test(handoffId)) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    await this.ensurePrivateRoot();
    const manifest = await this.readIfPresent(handoffId, true);
    if (!manifest) throw new AttachmentHandoffError('HANDOFF_NOT_FOUND');
    return manifest;
  }

  private acceptReplay(
    manifest: AttachmentHandoffManifest,
    fingerprint: string
  ): AttachmentHandoffManifest {
    if (manifest.requestFingerprint !== fingerprint) {
      throw new AttachmentHandoffError('HANDOFF_IDEMPOTENCY_MISMATCH');
    }
    return manifest;
  }

  private async ensurePrivateRoot(): Promise<void> {
    const parent = dirname(this.root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const path of [parent, this.root]) {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
      await chmod(path, 0o700);
      const secured = await lstat(path);
      if (!isPrivateMode(secured.mode, 0o700)) {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    }
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, STORE_LOCK_NAME);
    let handle;
    let ownerToken = '';
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        ownerToken = randomUUID();
        await handle.writeFile(
          `${JSON.stringify({ ownerToken, pid: process.pid, createdAt: new Date().toISOString() })}\n`
        );
        await handle.sync();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (handle) {
            await handle.close();
            await rm(lockPath, { force: true });
          }
          throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
        }
        await this.recoverStaleLock(lockPath);
        await delay(LOCK_RETRY_MS);
      }
    }
    if (!handle) throw new AttachmentHandoffError('HANDOFF_BUSY');

    try {
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await this.releaseOwnedLock(lockPath, ownerToken);
    }
  }

  private async recoverStaleLock(lockPath: string): Promise<void> {
    let stats;
    try {
      stats = await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      !isPrivateMode(stats.mode, 0o600) ||
      stats.size > LOCK_MAX_BYTES
    ) {
      throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    }
    if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return;

    let ownerPid: number | null = null;
    try {
      const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      if (
        typeof parsed.ownerToken === 'string' &&
        /^[0-9a-f-]{36}$/i.test(parsed.ownerToken) &&
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid as number) > 0 &&
        typeof parsed.createdAt === 'string' &&
        Date.now() - Date.parse(parsed.createdAt) > LOCK_STALE_MS
      ) {
        ownerPid = parsed.pid as number;
      }
    } catch {
      ownerPid = null;
    }
    if (ownerPid !== null && this.isProcessAlive(ownerPid)) return;

    const stalePath = join(this.root, `.stale-${randomUUID()}.lock`);
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async releaseOwnedLock(lockPath: string, ownerToken: string): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      if (parsed.ownerToken === ownerToken) await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    }
  }

  private async readIfPresent(
    handoffId: string,
    verifyPayload: boolean
  ): Promise<AttachmentHandoffManifest | null> {
    try {
      return await this.readBundle(handoffId, verifyPayload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readBundle(
    handoffId: string,
    verifyPayload: boolean
  ): Promise<AttachmentHandoffManifest> {
    if (!HANDOFF_ID_RE.test(handoffId)) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    const bundlePath = join(this.root, handoffId);
    const bundleStats = await lstat(bundlePath);
    if (
      bundleStats.isSymbolicLink() ||
      !bundleStats.isDirectory() ||
      !isPrivateMode(bundleStats.mode, 0o700)
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }

    const manifestPath = join(bundlePath, 'manifest.json');
    const payloadPath = join(bundlePath, 'payload.bin');
    let manifestStats;
    let payloadStats;
    try {
      [manifestStats, payloadStats] = await Promise.all([lstat(manifestPath), lstat(payloadPath)]);
    } catch {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    if (
      manifestStats.isSymbolicLink() ||
      !manifestStats.isFile() ||
      !isPrivateMode(manifestStats.mode, 0o600) ||
      manifestStats.size > MANIFEST_MAX_BYTES ||
      payloadStats.isSymbolicLink() ||
      !payloadStats.isFile() ||
      !isPrivateMode(payloadStats.mode, 0o600) ||
      payloadStats.size > this.limits.maxAttachmentBytes
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    if (
      !isManifest(parsed) ||
      parsed.handoffId !== handoffId ||
      parsed.size !== payloadStats.size
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    if (verifyPayload) {
      const payload = await readFile(payloadPath);
      if (sha256(payload) !== parsed.sha256) {
        throw new AttachmentHandoffError('HANDOFF_INVALID');
      }
    }
    return Object.freeze(parsed);
  }

  private async storeUsage(): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    const children = await readdir(this.root, { withFileTypes: true });
    for (const child of children) {
      if (!HANDOFF_ID_RE.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new AttachmentHandoffError('HANDOFF_INVALID');
      }
      const manifest = await this.readBundle(child.name, false);
      entries += 1;
      bytes += manifest.size;
    }
    return { entries, bytes };
  }
}
