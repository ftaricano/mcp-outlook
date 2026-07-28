import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

export type ExtractionErrorCode = 'UNSUPPORTED_FORMAT' | 'EXTRACTION_FAILED' | 'EXTRACTION_TIMEOUT';

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
}

export type AttachmentPipelineResult =
  | { readonly kind: 'zip_listing'; readonly zipEntries: readonly ZipEntryInfo[] }
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
 * always tears the worker down. This is the resource-isolation boundary for
 * hostile input: the resourceLimits below cap the worker's own heap
 * regardless of what the parser inside it does, and the timeout kills a
 * worker that never reports back — neither depends on the file's own
 * declared metadata. Exported (not just used) so the timeout/crash paths can
 * be exercised directly in tests against a small fixture worker, without
 * waiting out the real 30s production timeout.
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

  let response: WorkerSuccessResult;
  try {
    response = await runIsolatedWorker<WorkerSuccessResult>(extractionWorkerUrl(), {
      buffer: request.buffer,
      name: request.name,
      contentType: request.contentType,
      maxChars: request.maxChars,
      mode: request.mode,
      entry: request.entry,
      password: request.password,
      zipLimits: request.zipLimits,
      containerLimits,
    });
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
