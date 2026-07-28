import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDocxName, isXlsxName, isZipContainer } from './extractionFormat.js';
import { listZipEntries, ZipError } from './zipArchive.js';

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

interface WorkerFailure {
  readonly error: ExtractionErrorCode;
}

function isWorkerFailure(message: unknown): message is WorkerFailure {
  return typeof message === 'object' && message !== null && 'error' in message;
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
          reject(new ExtractionError(message.error));
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
  try {
    if (isZipContainer(buffer)) {
      const isXlsx = isXlsxName(name, contentType);
      const isDocx = isDocxName(name, contentType);
      if (!isXlsx && !isDocx) throw new ExtractionError('UNSUPPORTED_FORMAT');

      // Fast-path, defense-in-depth only: the ZIP central directory declares an
      // uncompressed size per entry, but that field is attacker-controlled
      // metadata (zip bombs falsify it) — this cap does NOT bound real bytes
      // read. It exists purely to reject obviously-bad declared sizes before
      // paying for a worker thread. The actual guarantee against unbounded
      // CPU/memory from a hostile xlsx/docx payload is the worker's
      // resourceLimits below, which caps real heap usage independent of
      // anything the file itself claims.
      try {
        await listZipEntries(buffer, limits);
      } catch (error) {
        if (error instanceof ZipError) throw new ExtractionError('EXTRACTION_FAILED');
        throw error;
      }
    }

    return await runIsolatedWorker<ExtractedText>(extractionWorkerUrl(), {
      buffer,
      name,
      contentType,
      maxChars,
    });
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError('EXTRACTION_FAILED');
  }
}
