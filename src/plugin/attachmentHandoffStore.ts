import { createHash, randomUUID } from 'node:crypto';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HANDOFF_ID_RE = /^oh_[A-Za-z0-9_-]{43}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TEMP_PAYLOAD_RE =
  /^\.payload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const LEGACY_TEMP_MANIFEST_RE =
  /^\.manifest-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const TEMP_FILE_RE =
  /^\.(payload|manifest)-([a-f0-9]{64})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const MANIFEST_MAX_BYTES = 64 * 1024;
const STORE_LOCK_NAME = '.store.lock';
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 20;
const LOCK_HANDSHAKE_TIMEOUT_MS = 2_000;
const LOCK_RELEASE_TIMEOUT_MS = 2_000;
const LOCK_OUTPUT_MAX_BYTES = 4_096;
const PYTHON_EXECUTABLE = '/usr/bin/python3';

// The helper keeps the advisory lock in the kernel. The lock file is persistent and is never
// unlinked, so a crashed holder cannot leave a stale logical lock and there is no compare/delete
// race. The pathname is delivered over stdin rather than exposed in argv or process listings.
const POSIX_FLOCK_HELPER = String.raw`
import fcntl
import json
import os
import stat
import sys

def result(value, code):
    sys.stdout.write(value + "\n")
    sys.stdout.flush()
    raise SystemExit(code)

try:
    raw = sys.stdin.buffer.readline(8193)
    if not raw or len(raw) > 8192:
        result("INVALID", 64)
    request = json.loads(raw.decode("utf-8"))
    path = request.get("path")
    if not isinstance(path, str) or not path or "\x00" in path:
        result("INVALID", 64)
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    opened = os.fstat(fd)
    if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o600 or opened.st_nlink != 1):
        result("INVALID", 64)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        result("BUSY", 75)
    current = os.lstat(path)
    if (not stat.S_ISREG(current.st_mode) or current.st_uid != os.geteuid()
            or stat.S_IMODE(current.st_mode) != 0o600 or current.st_nlink != 1
            or current.st_dev != opened.st_dev or current.st_ino != opened.st_ino):
        result("INVALID", 64)
    sys.stdout.write("LOCKED %d %d\n" % (opened.st_dev, opened.st_ino))
    sys.stdout.flush()
    if sys.stdin.buffer.readline(5) != b"ACK\n":
        result("INVALID", 64)
    confirmed = os.lstat(path)
    if (not stat.S_ISREG(confirmed.st_mode) or confirmed.st_uid != os.geteuid()
            or stat.S_IMODE(confirmed.st_mode) != 0o600 or confirmed.st_nlink != 1
            or confirmed.st_dev != opened.st_dev or confirmed.st_ino != opened.st_ino):
        result("INVALID", 64)
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    sys.stdin.buffer.read()
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
except SystemExit:
    raise
except Exception:
    result("FAILED", 70)
`;

const READ_FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const READ_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const CREATE_FILE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

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
  | 'HANDOFF_LOCK_FAILURE'
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_QUOTA_EXCEEDED'
  | 'HANDOFF_STORAGE_FAILED'
  | 'HANDOFF_UNSUPPORTED_PLATFORM';

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

export interface AttachmentHandoffStoreHooks {
  readonly afterPayloadPublished?: () => Promise<void> | void;
  readonly afterStoreRootSynced?: () => Promise<void> | void;
  readonly temporaryFileFault?: (
    kind: 'payload' | 'manifest',
    stage: 'afterPartialWrite' | 'beforeSync' | 'afterSync'
  ) => Promise<void> | void;
}

export interface PosixFlockOptions {
  readonly attempts?: number;
  readonly retryMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
  readonly executable?: string;
  readonly helperCode?: string;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
}

export interface PosixFlock {
  readonly exited: Promise<void>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
  terminate(): Promise<void>;
}

interface DirectorySnapshot {
  readonly stats: Stats;
  readonly entries: readonly string[];
}

type BundleState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly manifest: AttachmentHandoffManifest }
  | { readonly kind: 'partial'; readonly snapshot: DirectorySnapshot };

interface PreparedPartial {
  readonly bundleStats: Stats;
  readonly payloadState: 'missing' | 'temporary' | 'published';
  readonly payloadTemporary?: string;
  readonly manifestTemporary?: string;
}

interface TemporaryFile {
  readonly kind: 'payload' | 'manifest';
  readonly fingerprint: string | null;
  readonly name: string;
}

export function defaultAttachmentHandoffRoot(): string {
  return join(homedir(), '.jarvishub-mcp', 'outlook-handoffs');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseTemporaryFile(name: string): TemporaryFile | null {
  const current = TEMP_FILE_RE.exec(name);
  if (current) {
    return {
      kind: current[1] as 'payload' | 'manifest',
      fingerprint: current[2],
      name,
    };
  }
  if (LEGACY_TEMP_PAYLOAD_RE.test(name)) {
    return { kind: 'payload', fingerprint: null, name };
  }
  if (LEGACY_TEMP_MANIFEST_RE.test(name)) {
    return { kind: 'manifest', fingerprint: null, name };
  }
  return null;
}

function temporaryFileName(kind: 'payload' | 'manifest', fingerprint: string): string {
  return `.${kind}-${fingerprint}-${randomUUID()}.tmp`;
}

function normalizeIdentity<T extends AttachmentHandoffIdentity>(identity: T): T {
  if (!UUID_V4_RE.test(identity.idempotencyKey)) {
    throw new AttachmentHandoffError('HANDOFF_INVALID');
  }
  return { ...identity, idempotencyKey: identity.idempotencyKey.toLowerCase() };
}

function handoffIdFor(idempotencyKey: string): string {
  return `oh_${createHash('sha256')
    .update('mcp-outlook-attachment-handoff-v1\0')
    .update(idempotencyKey.toLowerCase())
    .digest('base64url')}`;
}

function requestFingerprint(request: AttachmentHandoffIdentity): string {
  return sha256(
    JSON.stringify([
      request.mailbox,
      request.messageId,
      request.attachmentId,
      request.idempotencyKey.toLowerCase(),
    ])
  );
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function currentEuid(): number {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') {
    throw new AttachmentHandoffError('HANDOFF_UNSUPPORTED_PLATFORM');
  }
  if (!fsConstants.O_NOFOLLOW || !fsConstants.O_DIRECTORY) {
    throw new AttachmentHandoffError('HANDOFF_UNSUPPORTED_PLATFORM');
  }
  return process.geteuid();
}

function validateDirectoryStats(
  stats: Stats,
  expectedMode: number | undefined,
  code: AttachmentHandoffErrorCode
): void {
  if (
    !stats.isDirectory() ||
    stats.uid !== currentEuid() ||
    stats.nlink < 1 ||
    (expectedMode !== undefined && (stats.mode & 0o777) !== expectedMode)
  ) {
    throw new AttachmentHandoffError(code);
  }
}

function validateFileStats(stats: Stats, maxBytes: number, code: AttachmentHandoffErrorCode): void {
  if (
    !stats.isFile() ||
    stats.uid !== currentEuid() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size < 0 ||
    stats.size > maxBytes
  ) {
    throw new AttachmentHandoffError(code);
  }
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

function parseManifest(buffer: Buffer): AttachmentHandoffManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AttachmentHandoffError('HANDOFF_INVALID');
  }
  if (!isManifest(parsed)) throw new AttachmentHandoffError('HANDOFF_INVALID');
  return parsed;
}

async function openSecureDirectory(
  path: string,
  expectedMode: number | undefined,
  code: AttachmentHandoffErrorCode
): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_DIRECTORY_FLAGS);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new AttachmentHandoffError(code);
  }
  try {
    const stats = await handle.stat();
    validateDirectoryStats(stats, expectedMode, code);
    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readSecureFile(
  path: string,
  maxBytes: number,
  code: AttachmentHandoffErrorCode
): Promise<{ buffer: Buffer; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_FILE_FLAGS);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new AttachmentHandoffError(code);
  }
  try {
    const before = await handle.stat();
    validateFileStats(before, maxBytes, code);
    const buffer = await handle.readFile();
    const after = await handle.stat();
    validateFileStats(after, maxBytes, code);
    if (!sameStableFile(before, after) || buffer.length !== after.size) {
      throw new AttachmentHandoffError(code);
    }
    return { buffer, stats: after };
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(
  path: string,
  contents: string | Buffer,
  kind: 'payload' | 'manifest',
  hooks: AttachmentHandoffStoreHooks,
  lock: PosixFlock
): Promise<Stats> {
  let handle: FileHandle;
  try {
    handle = await lock.run(() => open(path, CREATE_FILE_FLAGS, 0o600));
  } catch (error) {
    if (error instanceof AttachmentHandoffError && error.code === 'HANDOFF_LOCK_FAILURE') {
      throw error;
    }
    throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
  }
  try {
    const before = await lock.run(() => handle.stat());
    validateFileStats(before, Number.MAX_SAFE_INTEGER, 'HANDOFF_STORAGE_FAILED');
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const split = bytes.length > 1 ? Math.ceil(bytes.length / 2) : bytes.length;
    if (split > 0) await lock.run(() => handle.write(bytes.subarray(0, split)));
    await lock.run(async () => hooks.temporaryFileFault?.(kind, 'afterPartialWrite'));
    if (split < bytes.length) await lock.run(() => handle.write(bytes.subarray(split)));
    await lock.run(async () => hooks.temporaryFileFault?.(kind, 'beforeSync'));
    await lock.run(() => handle.sync());
    await lock.run(async () => hooks.temporaryFileFault?.(kind, 'afterSync'));
    const after = await lock.run(() => handle.stat());
    validateFileStats(after, Number.MAX_SAFE_INTEGER, 'HANDOFF_STORAGE_FAILED');
    if (
      !sameInode(before, after) ||
      after.nlink !== 1 ||
      after.size !== Buffer.byteLength(contents)
    ) {
      throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    }
    return after;
  } finally {
    await handle.close();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWithLock<T>(
  lock: PosixFlock | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return lock ? lock.run(operation) : operation();
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= LOCK_OUTPUT_MAX_BYTES) return current;
  return Buffer.concat([Buffer.from(current), chunk])
    .subarray(0, LOCK_OUTPUT_MAX_BYTES)
    .toString('utf8');
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
    child.once('error', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopLockHelper(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  terminate: boolean
): Promise<void> {
  if (terminate) child.kill('SIGKILL');
  else child.stdin.end();
  if (await waitForExit(child, timeoutMs)) return;
  child.kill('SIGKILL');
  if (await waitForExit(child, timeoutMs)) return;
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.removeAllListeners();
  child.unref();
  throw new AttachmentHandoffError('HANDOFF_LOCK_FAILURE');
}

async function startLockHelper(
  lockPath: string,
  options: PosixFlockOptions
): Promise<{ kind: 'locked'; lock: PosixFlock } | { kind: 'busy' }> {
  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(
      options.executable ?? PYTHON_EXECUTABLE,
      ['-c', options.helperCode ?? POSIX_FLOCK_HELPER],
      { stdio: 'pipe', shell: false }
    );
  } catch {
    throw new AttachmentHandoffError('HANDOFF_UNSUPPORTED_PLATFORM');
  }
  child.stdin.on('error', () => undefined);

  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? LOCK_HANDSHAKE_TIMEOUT_MS;
  const releaseTimeoutMs = options.releaseTimeoutMs ?? LOCK_RELEASE_TIMEOUT_MS;
  let stdout = '';
  let stderr = '';
  let spawnFailed = false;
  let acknowledgmentSent = false;
  let settled = false;
  const outcome = await new Promise<'locked' | 'busy' | 'failed'>((resolve) => {
    const finish = (value: 'locked' | 'busy' | 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish('failed'), handshakeTimeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
      const lines = stdout.split('\n');
      const line = lines[0];
      if (/^LOCKED \d+ \d+$/.test(line) && !acknowledgmentSent) {
        acknowledgmentSent = true;
        child.stdin.write('ACK\n', (error) => {
          if (error) finish('failed');
        });
      }
      if (acknowledgmentSent && lines.includes('READY')) finish('locked');
      else if (line === 'BUSY') finish('busy');
      else if (line === 'INVALID' || line === 'FAILED') finish('failed');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once('error', () => {
      spawnFailed = true;
      finish('failed');
    });
    child.once('exit', () => finish(stdout.startsWith('BUSY\n') ? 'busy' : 'failed'));
    child.stdin.write(`${JSON.stringify({ path: lockPath })}\n`, (error) => {
      if (error) finish('failed');
    });
  });

  void stderr;
  if (outcome !== 'locked') {
    await stopLockHelper(child, releaseTimeoutMs, true);
    if (spawnFailed) {
      throw new AttachmentHandoffError('HANDOFF_UNSUPPORTED_PLATFORM');
    }
    return outcome === 'busy'
      ? { kind: 'busy' }
      : Promise.reject(new AttachmentHandoffError('HANDOFF_STORAGE_FAILED'));
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  if (child.exitCode !== null || child.signalCode !== null) {
    await stopLockHelper(child, releaseTimeoutMs, true);
    throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
  }

  let alive = true;
  let stopping = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const markExited = () => {
    alive = false;
    resolveExited();
  };
  child.once('exit', markExited);
  child.once('error', markExited);
  if (child.exitCode !== null || child.signalCode !== null) markExited();

  const assertAlive = () => {
    if (!alive && !stopping) {
      throw new AttachmentHandoffError('HANDOFF_LOCK_FAILURE');
    }
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertAlive();
    const result = await Promise.race([
      operation(),
      exited.then<never>(() => {
        throw new AttachmentHandoffError('HANDOFF_LOCK_FAILURE');
      }),
    ]);
    assertAlive();
    return result;
  };

  let stopped = false;
  const stop = async (terminate: boolean) => {
    if (stopped) return;
    stopped = true;
    stopping = true;
    await stopLockHelper(child, releaseTimeoutMs, terminate);
  };
  return {
    kind: 'locked',
    lock: {
      exited,
      run,
      release: async () => stop(false),
      terminate: async () => stop(true),
    },
  };
}

export async function acquirePosixFlock(
  lockPath: string,
  options: PosixFlockOptions = {}
): Promise<PosixFlock> {
  currentEuid();
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new AttachmentHandoffError('HANDOFF_UNSUPPORTED_PLATFORM');
  }
  const attempts = options.attempts ?? LOCK_ATTEMPTS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await startLockHelper(lockPath, options);
    if (result.kind === 'locked') return result.lock;
    if (attempt + 1 < attempts) await delay(retryMs);
  }
  throw new AttachmentHandoffError('HANDOFF_BUSY');
}

export class AttachmentHandoffStore {
  private readonly hooks: AttachmentHandoffStoreHooks;

  constructor(
    private readonly limits: AttachmentHandoffStoreLimits,
    private readonly root = defaultAttachmentHandoffRoot(),
    hooks: AttachmentHandoffStoreHooks = {},
    private readonly lockOptions: PosixFlockOptions = {}
  ) {
    currentEuid();
    this.hooks = hooks;
  }

  async create(
    request: AttachmentHandoffRequest,
    payload: Buffer
  ): Promise<AttachmentHandoffManifest> {
    if (payload.length > this.limits.maxAttachmentBytes) {
      throw new AttachmentHandoffError('HANDOFF_QUOTA_EXCEEDED');
    }
    const normalized = normalizeIdentity(request);
    const candidateManifest = this.createManifest(normalized, payload);
    await this.ensureWritableRoot();

    return this.withStoreLock(async (lock) => {
      const state = await lock.run(() => this.inspectBundle(candidateManifest.handoffId, true));
      if (state.kind === 'ready') {
        return this.acceptReplay(state.manifest, candidateManifest.requestFingerprint);
      }

      const prepared =
        state.kind === 'partial'
          ? await this.preparePartial(state.snapshot, candidateManifest, payload, lock)
          : null;
      const usage = await lock.run(() => this.storeUsage(candidateManifest.handoffId));
      if (
        usage.entries + 1 > this.limits.maxStoreEntries ||
        usage.bytes + payload.length > this.limits.maxStoreBytes
      ) {
        throw new AttachmentHandoffError('HANDOFF_QUOTA_EXCEEDED');
      }

      const publication =
        prepared ?? (await this.createBundleDirectory(candidateManifest.handoffId, lock));
      return this.publish(publication, candidateManifest, payload, lock);
    });
  }

  async findReplay(identity: AttachmentHandoffIdentity): Promise<AttachmentHandoffManifest | null> {
    const normalized = normalizeIdentity(identity);
    await this.ensureWritableRoot();
    return this.withStoreLock(async (lock) => {
      const handoffId = handoffIdFor(normalized.idempotencyKey);
      const state = await lock.run(() => this.inspectBundle(handoffId, true));
      if (state.kind !== 'ready') return null;
      return this.acceptReplay(state.manifest, requestFingerprint(normalized));
    });
  }

  async get(handoffId: string): Promise<AttachmentHandoffManifest> {
    if (!HANDOFF_ID_RE.test(handoffId)) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    await this.assertReadOnlyRoot();
    const state = await this.inspectBundle(handoffId, true);
    if (state.kind === 'absent') throw new AttachmentHandoffError('HANDOFF_NOT_FOUND');
    if (state.kind === 'partial') throw new AttachmentHandoffError('HANDOFF_INVALID');
    return state.manifest;
  }

  private createManifest(
    request: AttachmentHandoffRequest,
    payload: Buffer
  ): AttachmentHandoffManifest {
    const manifest: AttachmentHandoffManifest = {
      version: 1,
      handoffId: handoffIdFor(request.idempotencyKey),
      requestFingerprint: requestFingerprint(request),
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
    if (!isManifest(manifest)) throw new AttachmentHandoffError('HANDOFF_INVALID');
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

  private async ensureWritableRoot(): Promise<void> {
    await this.ensurePrivateDirectory(dirname(this.root));
    await this.ensurePrivateDirectory(this.root);
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    try {
      const existing = await openSecureDirectory(path, 0o700, 'HANDOFF_STORAGE_FAILED');
      await existing.handle.close();
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const container = await openSecureDirectory(dirname(path), undefined, 'HANDOFF_STORAGE_FAILED');
    try {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
        }
      }
      await container.handle.sync();
    } finally {
      await container.handle.close();
    }

    const created = await openSecureDirectory(path, 0o700, 'HANDOFF_STORAGE_FAILED');
    await created.handle.close();
  }

  private async assertReadOnlyRoot(): Promise<void> {
    try {
      const parent = await openSecureDirectory(dirname(this.root), 0o700, 'HANDOFF_INVALID');
      await parent.handle.close();
      const root = await openSecureDirectory(this.root, 0o700, 'HANDOFF_INVALID');
      await root.handle.close();
    } catch (error) {
      if (isMissing(error)) throw new AttachmentHandoffError('HANDOFF_NOT_FOUND');
      throw error;
    }
  }

  private async snapshotDirectory(
    path: string,
    expectedMode: number,
    code: AttachmentHandoffErrorCode
  ): Promise<DirectorySnapshot> {
    const opened = await openSecureDirectory(path, expectedMode, code);
    try {
      const entries = (await readdir(path)).sort();
      const after = await opened.handle.stat();
      validateDirectoryStats(after, expectedMode, code);
      if (!sameInode(opened.stats, after)) throw new AttachmentHandoffError(code);
      const current = await openSecureDirectory(path, expectedMode, code);
      try {
        if (!sameInode(opened.stats, current.stats)) {
          throw new AttachmentHandoffError(code);
        }
      } finally {
        await current.handle.close();
      }
      return { stats: after, entries };
    } finally {
      await opened.handle.close();
    }
  }

  private async assertDirectoryIdentity(
    path: string,
    expected: Stats,
    code: AttachmentHandoffErrorCode
  ): Promise<void> {
    const current = await openSecureDirectory(path, 0o700, code);
    try {
      if (!sameInode(expected, current.stats)) throw new AttachmentHandoffError(code);
    } finally {
      await current.handle.close();
    }
  }

  private async syncPrivateDirectory(
    path: string,
    expected: Stats,
    lock?: PosixFlock
  ): Promise<void> {
    const current = await runWithLock(lock, () =>
      openSecureDirectory(path, 0o700, 'HANDOFF_STORAGE_FAILED')
    );
    try {
      if (!sameInode(expected, current.stats)) {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
      await runWithLock(lock, () => current.handle.sync());
      const after = await runWithLock(lock, () => current.handle.stat());
      validateDirectoryStats(after, 0o700, 'HANDOFF_STORAGE_FAILED');
      if (!sameInode(expected, after)) {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    } finally {
      await current.handle.close();
    }
  }

  private async inspectBundle(handoffId: string, verifyPayload: boolean): Promise<BundleState> {
    const bundlePath = join(this.root, handoffId);
    let snapshot: DirectorySnapshot;
    try {
      snapshot = await this.snapshotDirectory(bundlePath, 0o700, 'HANDOFF_INVALID');
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' };
      throw error;
    }
    if (!snapshot.entries.includes('manifest.json')) {
      return { kind: 'partial', snapshot };
    }
    return {
      kind: 'ready',
      manifest: await this.readCommittedBundle(handoffId, snapshot, verifyPayload),
    };
  }

  private async readCommittedBundle(
    handoffId: string,
    snapshot: DirectorySnapshot,
    verifyPayload: boolean
  ): Promise<AttachmentHandoffManifest> {
    if (
      snapshot.entries.length !== 2 ||
      snapshot.entries[0] !== 'manifest.json' ||
      snapshot.entries[1] !== 'payload.bin'
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    const bundlePath = join(this.root, handoffId);
    const manifestRead = await readSecureFile(
      join(bundlePath, 'manifest.json'),
      MANIFEST_MAX_BYTES,
      'HANDOFF_INVALID'
    );
    const payloadRead = await readSecureFile(
      join(bundlePath, 'payload.bin'),
      this.limits.maxAttachmentBytes,
      'HANDOFF_INVALID'
    );
    await this.assertDirectoryIdentity(bundlePath, snapshot.stats, 'HANDOFF_INVALID');

    const manifest = parseManifest(manifestRead.buffer);
    if (
      manifest.handoffId !== handoffId ||
      manifest.size !== payloadRead.stats.size ||
      (verifyPayload && sha256(payloadRead.buffer) !== manifest.sha256)
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    return Object.freeze(manifest);
  }

  private async preparePartial(
    snapshot: DirectorySnapshot,
    manifest: AttachmentHandoffManifest,
    payload: Buffer,
    lock: PosixFlock
  ): Promise<PreparedPartial> {
    const temporaryFiles = snapshot.entries
      .map(parseTemporaryFile)
      .filter((value): value is TemporaryFile => value !== null);
    const payloadTemporaries = temporaryFiles.filter((entry) => entry.kind === 'payload');
    const manifestTemporaries = temporaryFiles.filter((entry) => entry.kind === 'manifest');
    const allowed = new Set(['payload.bin', ...temporaryFiles.map((entry) => entry.name)]);
    if (
      snapshot.entries.some((entry) => !allowed.has(entry)) ||
      payloadTemporaries.length > 1 ||
      manifestTemporaries.length > 1 ||
      (snapshot.entries.includes('payload.bin') && payloadTemporaries.length > 0) ||
      (manifestTemporaries.length > 0 &&
        !snapshot.entries.includes('payload.bin') &&
        payloadTemporaries.length === 0)
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }

    for (const temporary of temporaryFiles) {
      if (temporary.fingerprint !== null && temporary.fingerprint !== manifest.requestFingerprint) {
        throw new AttachmentHandoffError('HANDOFF_IDEMPOTENCY_MISMATCH');
      }
    }

    const bundlePath = join(this.root, manifest.handoffId);
    const payloadName = snapshot.entries.includes('payload.bin')
      ? 'payload.bin'
      : payloadTemporaries[0]?.name;
    let payloadState: PreparedPartial['payloadState'] = snapshot.entries.includes('payload.bin')
      ? 'published'
      : payloadName
        ? 'temporary'
        : 'missing';
    if (payloadName) {
      let existingPayload: { buffer: Buffer; stats: Stats } | null = null;
      try {
        existingPayload = await lock.run(() =>
          readSecureFile(
            join(bundlePath, payloadName),
            this.limits.maxAttachmentBytes,
            'HANDOFF_INVALID'
          )
        );
      } catch (error) {
        if (error instanceof AttachmentHandoffError && error.code === 'HANDOFF_LOCK_FAILURE') {
          throw error;
        }
        if (payloadName === 'payload.bin') throw error;
      }
      if (!existingPayload?.buffer.equals(payload)) {
        if (payloadName === 'payload.bin' || payloadTemporaries[0]?.fingerprint === null) {
          throw new AttachmentHandoffError('HANDOFF_INVALID');
        }
        await this.removeTemporary(
          bundlePath,
          snapshot.stats,
          payloadTemporaries[0],
          manifest.requestFingerprint,
          lock
        );
        payloadState = 'missing';
      }
    }

    let manifestTemporary: TemporaryFile | undefined = manifestTemporaries[0];
    const publicationProven = manifestTemporary?.fingerprint === manifest.requestFingerprint;
    if (manifestTemporary) {
      let recovered: AttachmentHandoffManifest | null = null;
      try {
        recovered = parseManifest(
          (
            await lock.run(() =>
              readSecureFile(
                join(bundlePath, manifestTemporary!.name),
                MANIFEST_MAX_BYTES,
                'HANDOFF_INVALID'
              )
            )
          ).buffer
        );
      } catch (error) {
        if (error instanceof AttachmentHandoffError && error.code === 'HANDOFF_LOCK_FAILURE') {
          throw error;
        }
        if (manifestTemporary.fingerprint === null) throw error;
      }
      if (recovered && recovered.requestFingerprint !== manifest.requestFingerprint) {
        throw new AttachmentHandoffError('HANDOFF_IDEMPOTENCY_MISMATCH');
      }
      if (recovered && !this.manifestMatches(recovered, manifest)) {
        throw new AttachmentHandoffError('HANDOFF_INVALID');
      }
      if (!recovered) {
        await this.removeTemporary(
          bundlePath,
          snapshot.stats,
          manifestTemporary,
          manifest.requestFingerprint,
          lock
        );
        manifestTemporary = undefined;
      }
    }
    if (payloadState === 'published' && !manifestTemporary && !publicationProven) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    await lock.run(() =>
      this.assertDirectoryIdentity(bundlePath, snapshot.stats, 'HANDOFF_INVALID')
    );

    return {
      bundleStats: snapshot.stats,
      payloadState,
      payloadTemporary: payloadState === 'temporary' ? payloadTemporaries[0]?.name : undefined,
      manifestTemporary: manifestTemporary?.name,
    };
  }

  private async removeTemporary(
    bundlePath: string,
    bundleStats: Stats,
    temporary: TemporaryFile,
    expectedFingerprint: string,
    lock: PosixFlock
  ): Promise<void> {
    const reparsed = parseTemporaryFile(temporary.name);
    if (
      !reparsed ||
      reparsed.name !== temporary.name ||
      reparsed.kind !== temporary.kind ||
      reparsed.fingerprint === null ||
      reparsed.fingerprint !== expectedFingerprint
    ) {
      throw new AttachmentHandoffError('HANDOFF_INVALID');
    }
    const path = join(bundlePath, temporary.name);
    const handle = await lock.run(() => open(path, READ_FILE_FLAGS));
    try {
      const opened = await lock.run(() => handle.stat());
      validateFileStats(opened, Number.MAX_SAFE_INTEGER, 'HANDOFF_INVALID');
      await lock.run(() =>
        this.assertDirectoryIdentity(bundlePath, bundleStats, 'HANDOFF_INVALID')
      );
      const current = await lock.run(() => open(path, READ_FILE_FLAGS));
      try {
        const currentStats = await lock.run(() => current.stat());
        validateFileStats(currentStats, Number.MAX_SAFE_INTEGER, 'HANDOFF_INVALID');
        if (!sameInode(opened, currentStats)) {
          throw new AttachmentHandoffError('HANDOFF_INVALID');
        }
        await lock.run(() => unlink(path));
        const removed = await lock.run(() => handle.stat());
        if (!sameInode(opened, removed) || removed.nlink !== 0) {
          throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
        }
      } finally {
        await current.close();
      }
    } finally {
      await handle.close();
    }
    await this.syncPrivateDirectory(bundlePath, bundleStats, lock);
  }

  private manifestMatches(
    recovered: AttachmentHandoffManifest,
    expected: AttachmentHandoffManifest
  ): boolean {
    return (
      recovered.version === expected.version &&
      recovered.handoffId === expected.handoffId &&
      recovered.requestFingerprint === expected.requestFingerprint &&
      recovered.mailbox === expected.mailbox &&
      recovered.messageId === expected.messageId &&
      recovered.attachmentId === expected.attachmentId &&
      recovered.filename === expected.filename &&
      recovered.contentType === expected.contentType &&
      recovered.size === expected.size &&
      recovered.sha256 === expected.sha256 &&
      recovered.status === expected.status
    );
  }

  private async createBundleDirectory(
    handoffId: string,
    lock: PosixFlock
  ): Promise<PreparedPartial> {
    const bundlePath = join(this.root, handoffId);
    try {
      await lock.run(() => mkdir(bundlePath, { mode: 0o700 }));
    } catch (error) {
      if (error instanceof AttachmentHandoffError && error.code === 'HANDOFF_LOCK_FAILURE') {
        throw error;
      }
      throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    }
    const bundle = await lock.run(() =>
      openSecureDirectory(bundlePath, 0o700, 'HANDOFF_STORAGE_FAILED')
    );
    await bundle.handle.close();
    const root = await lock.run(() =>
      openSecureDirectory(this.root, 0o700, 'HANDOFF_STORAGE_FAILED')
    );
    try {
      await lock.run(() => root.handle.sync());
      const after = await lock.run(() => root.handle.stat());
      validateDirectoryStats(after, 0o700, 'HANDOFF_STORAGE_FAILED');
      if (!sameInode(root.stats, after)) {
        throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
      }
    } finally {
      await root.handle.close();
    }
    await lock.run(async () => this.hooks.afterStoreRootSynced?.());
    return { bundleStats: bundle.stats, payloadState: 'missing' };
  }

  private async publish(
    prepared: PreparedPartial,
    manifest: AttachmentHandoffManifest,
    payload: Buffer,
    lock: PosixFlock
  ): Promise<AttachmentHandoffManifest> {
    const bundlePath = join(this.root, manifest.handoffId);
    let payloadState = prepared.payloadState;
    let payloadTemporary = prepared.payloadTemporary;
    if (payloadState === 'missing') {
      payloadTemporary = temporaryFileName('payload', manifest.requestFingerprint);
      await writePrivateFile(
        join(bundlePath, payloadTemporary),
        payload,
        'payload',
        this.hooks,
        lock
      );
      payloadState = 'temporary';
    }
    let manifestTemporary = prepared.manifestTemporary;
    if (!manifestTemporary) {
      manifestTemporary = temporaryFileName('manifest', manifest.requestFingerprint);
      await writePrivateFile(
        join(bundlePath, manifestTemporary),
        `${JSON.stringify(manifest)}\n`,
        'manifest',
        this.hooks,
        lock
      );
    }
    if (payloadState === 'temporary') {
      await lock.run(() =>
        this.assertDirectoryIdentity(bundlePath, prepared.bundleStats, 'HANDOFF_STORAGE_FAILED')
      );
      await lock.run(() =>
        rename(join(bundlePath, payloadTemporary!), join(bundlePath, 'payload.bin'))
      );
      await this.syncPrivateDirectory(bundlePath, prepared.bundleStats, lock);
    }
    const publishedPayload = await lock.run(() =>
      readSecureFile(
        join(bundlePath, 'payload.bin'),
        this.limits.maxAttachmentBytes,
        'HANDOFF_STORAGE_FAILED'
      )
    );
    if (!publishedPayload.buffer.equals(payload)) {
      throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    }
    await lock.run(async () => this.hooks.afterPayloadPublished?.());

    await lock.run(() =>
      this.assertDirectoryIdentity(bundlePath, prepared.bundleStats, 'HANDOFF_STORAGE_FAILED')
    );
    await lock.run(() =>
      rename(join(bundlePath, manifestTemporary), join(bundlePath, 'manifest.json'))
    );
    await this.syncPrivateDirectory(bundlePath, prepared.bundleStats, lock);
    const committed = await lock.run(() => this.inspectBundle(manifest.handoffId, true));
    if (committed.kind !== 'ready') throw new AttachmentHandoffError('HANDOFF_STORAGE_FAILED');
    return committed.manifest;
  }

  private async storeUsage(excludedHandoffId: string): Promise<{ entries: number; bytes: number }> {
    const root = await this.snapshotDirectory(this.root, 0o700, 'HANDOFF_INVALID');
    let entries = 0;
    let bytes = 0;
    for (const child of root.entries) {
      if (child === STORE_LOCK_NAME || child === excludedHandoffId) continue;
      if (!HANDOFF_ID_RE.test(child)) throw new AttachmentHandoffError('HANDOFF_INVALID');
      const state = await this.inspectBundle(child, false);
      if (state.kind !== 'ready') throw new AttachmentHandoffError('HANDOFF_INVALID');
      entries += 1;
      bytes += state.manifest.size;
    }
    await this.assertDirectoryIdentity(this.root, root.stats, 'HANDOFF_INVALID');
    return { entries, bytes };
  }

  private async withStoreLock<T>(operation: (lock: PosixFlock) => Promise<T>): Promise<T> {
    const lock = await acquirePosixFlock(join(this.root, STORE_LOCK_NAME), this.lockOptions);
    try {
      return await lock.run(() => operation(lock));
    } finally {
      await lock.release();
    }
  }
}
