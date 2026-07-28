import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isZipArchiveAttachment } from './extractionFormat.js';
import { ZipError, type ZipEntryInfo, type ZipErrorCode } from './zipArchive.js';

export { ZipError, type ZipEntryInfo, type ZipErrorCode } from './zipArchive.js';

const EXTRACTION_TIMEOUT_MS = 30_000;
const WORKER_MAX_OLD_GENERATION_MB = 512;
const WORKER_MAX_YOUNG_GENERATION_MB = 64;
const DEFAULT_CONTAINER_MAX_ENTRIES = 1_000;
const DEFAULT_CONTAINER_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export interface ContainerLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
}

export type ExtractionErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_TIMEOUT'
  | 'RAW_TOO_LARGE'
  | 'EXTRACTION_BUSY';

export class ExtractionError extends Error {
  constructor(readonly code: ExtractionErrorCode) {
    super(code);
    this.name = 'ExtractionError';
  }
}

export interface ExtractedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly extractor: 'pdf' | 'xlsx' | 'docx' | 'text';
}

export interface AttachmentPipelineRequest {
  readonly buffer: Buffer;
  readonly name: string;
  readonly contentType: string;
  readonly maxChars: number;
  readonly mode: 'text' | 'raw';
  readonly entry?: string;
  readonly password?: string;
  readonly zipLimits: ContainerLimits;
  readonly containerLimits?: ContainerLimits;
  // Required for 'raw' mode. Enforced wherever the bytes are produced: in this
  // module for a plain attachment (no worker involved), and inside the worker
  // for a ZIP entry, before anything is cloned back over postMessage. Ignored
  // in 'text' mode (maxExtractedChars is the relevant ceiling there).
  readonly maxRawBytes?: number;
  // Caps how many extraction workers may run concurrently across the whole
  // process; see createExtractionGate below.
  readonly maxConcurrentExtractions?: number;
}

export type AttachmentPipelineResult =
  | {
      readonly kind: 'zip_listing';
      readonly zipEntries: readonly ZipEntryInfo[];
      readonly hiddenEntries: number;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly truncated: boolean;
      readonly extractor: ExtractedText['extractor'];
    }
  | { readonly kind: 'raw'; readonly bytes: Buffer; readonly sizeBytes: number };

interface WorkerFailure {
  readonly error: string;
}

function isWorkerFailure(message: unknown): message is WorkerFailure {
  return typeof message === 'object' && message !== null && 'error' in message;
}

const ZIP_ERROR_CODES: ReadonlySet<ZipErrorCode> = new Set([
  'ZIP_INVALID',
  'ZIP_TOO_MANY_ENTRIES',
  'ZIP_TOO_LARGE',
  'ZIP_ENTRY_NOT_FOUND',
  'ZIP_ENCRYPTED',
  'ZIP_UNSUPPORTED_ENCRYPTION',
] satisfies ZipErrorCode[]);

function isZipErrorCode(code: string): code is ZipErrorCode {
  return ZIP_ERROR_CODES.has(code as ZipErrorCode);
}

/**
 * Spawns `workerUrl` with `workerData`, enforces a wall-clock timeout, and
 * always tears the worker down. This keeps a hostile file's parsing work off
 * the main process's event loop and guarantees a hard `terminate()` if the
 * worker never reports back — neither depends on the file's own declared
 * metadata. `resourceLimits` below caps only this worker's V8 heap; it does
 * NOT bound Buffer/ArrayBuffer or native-addon memory, so it is not a memory
 * sandbox by itself (see extractionWorker.ts header and the extraction
 * concurrency gate below for the rest of the picture). Exported (not just
 * used) so the timeout/crash paths can be exercised directly in tests against
 * a small fixture worker, without waiting out the real 30s production
 * timeout.
 */
export async function runIsolatedWorker<TSuccess>(
  workerUrl: URL,
  workerData: unknown,
  timeoutMs = EXTRACTION_TIMEOUT_MS
): Promise<TSuccess> {
  const worker = new Worker(workerUrl, {
    workerData,
    resourceLimits: {
      maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB,
      maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB,
    },
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<TSuccess>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ExtractionError('EXTRACTION_TIMEOUT'));
      }, timeoutMs);

      worker.once('message', (message: TSuccess | WorkerFailure) => {
        if (isWorkerFailure(message)) {
          reject(new ExtractionError(message.error as ExtractionErrorCode));
          return;
        }
        resolve(message);
      });

      worker.once('error', () => reject(new ExtractionError('EXTRACTION_FAILED')));

      worker.once('exit', (code) => {
        // A non-zero exit without a prior message means the worker died before
        // it could report anything — e.g. the resourceLimits heap cap above
        // killed it (OOM). Map that to the same opaque EXTRACTION_FAILED.
        if (code !== 0) reject(new ExtractionError('EXTRACTION_FAILED'));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate();
  }
}

// worker_threads loads its entry point through plain Node ESM resolution —
// it never goes through vitest's TS transform. When this module runs
// compiled (dist/plugin/extractors.js), the sibling extractionWorker.js is
// right there. When it runs as TS (vitest/ts-node in dev), that sibling
// doesn't exist next to the source file, so fall back to the compiled
// artifact in dist/plugin/ instead — this is why the extractAttachmentText
// tests need a prior `npm run build` (see tests/globalSetup.ts).
function extractionWorkerUrl(): URL {
  if (import.meta.url.endsWith('.js')) {
    return new URL('./extractionWorker.js', import.meta.url);
  }
  const srcPluginDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(srcPluginDir, '..', '..');
  return pathToFileURL(join(repoRoot, 'dist', 'plugin', 'extractionWorker.js'));
}

function normalizeWorkerError(error: unknown): ZipError | ExtractionError {
  if (error instanceof ExtractionError && isZipErrorCode(error.code)) {
    return new ZipError(error.code);
  }
  if (error instanceof ExtractionError) return error;
  return new ExtractionError('EXTRACTION_FAILED');
}

interface RawWorkerResult {
  readonly kind: 'raw';
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
}

type WorkerSuccessResult = Exclude<AttachmentPipelineResult, { kind: 'raw' }> | RawWorkerResult;

const DEFAULT_MAX_CONCURRENT_EXTRACTIONS = 2;
// Not caller-configurable (unlike maxConcurrentExtractions): a bound on how
// many callers may wait for a free worker slot before the server tells them
// to back off, so an overload can't grow the pending-promise queue without
// limit.
const MAX_QUEUED_EXTRACTIONS = 16;

export interface ExtractionGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A simple counting semaphore bounding how many extraction workers may run
 * at once. worker_threads' resourceLimits only caps a single worker's own
 * heap (see extractionWorker.ts) — nothing stops a caller from spawning many
 * workers in parallel and multiplying that per-worker budget by however many
 * are in flight. This gate is the process-wide cap on concurrency: calls
 * beyond `maxConcurrent` wait in a bounded queue; calls beyond
 * `maxConcurrent + maxQueued` fail fast with EXTRACTION_BUSY instead of
 * growing the queue without limit.
 */
export function createExtractionGate(
  maxConcurrent: number,
  maxQueued: number = MAX_QUEUED_EXTRACTIONS
): ExtractionGate {
  let active = 0;
  const waiting: Array<() => void> = [];

  function acquire(): Promise<void> | void {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    if (waiting.length >= maxQueued) {
      throw new ExtractionError('EXTRACTION_BUSY');
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

let sharedExtractionGate: ExtractionGate | undefined;
let sharedExtractionGateCapacity: number | undefined;

// `maxConcurrentExtractions` is a static per-process config value, so a
// single shared gate (recreated only if the requested capacity actually
// changes, e.g. across test configs) is enough — the queue must persist
// across concurrent calls for the count to mean anything.
function getSharedExtractionGate(maxConcurrent: number): ExtractionGate {
  if (!sharedExtractionGate || sharedExtractionGateCapacity !== maxConcurrent) {
    sharedExtractionGate = createExtractionGate(maxConcurrent);
    sharedExtractionGateCapacity = maxConcurrent;
  }
  return sharedExtractionGate;
}

/**
 * The single entry point into the isolated worker for attachment content.
 * Everything that touches hostile bytes — ZIP listing, decryption, inflate,
 * and document parsing — happens inside the worker; this function only
 * ships the request in and normalizes the response/error on the way out.
 * Never call zipArchive.ts or the pdf/xlsx/docx parsers from the main
 * thread — route through here instead.
 */
export async function runAttachmentPipeline(
  request: AttachmentPipelineRequest
): Promise<AttachmentPipelineResult> {
  const containerLimits = request.containerLimits ?? {
    maxEntries: DEFAULT_CONTAINER_MAX_ENTRIES,
    maxUncompressedBytes: DEFAULT_CONTAINER_MAX_UNCOMPRESSED_BYTES,
  };
  const maxRawBytes = request.maxRawBytes ?? Number.MAX_SAFE_INTEGER;

  // Raw mode on a non-container attachment needs no parser and no inflate, so
  // handing it to the worker would only structured-clone the payload across the
  // thread boundary before rejecting it. Decide here instead: the size check is
  // a length comparison on bytes we already hold, and `isZipArchiveAttachment`
  // reads magic bytes and the name only.
  if (
    request.mode === 'raw' &&
    !isZipArchiveAttachment(request.buffer, request.name, request.contentType)
  ) {
    if (request.buffer.length > maxRawBytes) throw new ExtractionError('RAW_TOO_LARGE');
    return {
      kind: 'raw',
      bytes: request.buffer,
      sizeBytes: request.buffer.length,
    };
  }

  const gate = getSharedExtractionGate(
    request.maxConcurrentExtractions ?? DEFAULT_MAX_CONCURRENT_EXTRACTIONS
  );

  let response: WorkerSuccessResult;
  try {
    response = await gate.run(() =>
      runIsolatedWorker<WorkerSuccessResult>(extractionWorkerUrl(), {
        buffer: request.buffer,
        name: request.name,
        contentType: request.contentType,
        maxChars: request.maxChars,
        mode: request.mode,
        entry: request.entry,
        password: request.password,
        zipLimits: request.zipLimits,
        containerLimits,
        maxRawBytes,
      })
    );
  } catch (error) {
    throw normalizeWorkerError(error);
  }

  if (response.kind === 'raw') {
    return { kind: 'raw', bytes: Buffer.from(response.bytes), sizeBytes: response.sizeBytes };
  }
  return response;
}

export async function extractAttachmentText(
  buffer: Buffer,
  name: string,
  contentType: string,
  maxChars: number,
  containerLimits?: ContainerLimits
): Promise<ExtractedText> {
  const limits = containerLimits ?? {
    maxEntries: DEFAULT_CONTAINER_MAX_ENTRIES,
    maxUncompressedBytes: DEFAULT_CONTAINER_MAX_UNCOMPRESSED_BYTES,
  };
  const result = await runAttachmentPipeline({
    buffer,
    name,
    contentType,
    maxChars,
    mode: 'text',
    zipLimits: limits,
    containerLimits: limits,
  });
  if (result.kind !== 'text') {
    throw new ExtractionError('EXTRACTION_FAILED');
  }
  return { text: result.text, truncated: result.truncated, extractor: result.extractor };
}
