// Runs inside a dedicated worker_thread (spawned by extractors.ts). This is
// the single hostile-content handler: ZIP listing/extraction (decryption +
// inflate, via zipArchive.ts) and attachment parsing (pdfjs / ExcelJS /
// mammoth) all happen here, so a hostile or malformed file can only exhaust
// the resourceLimits budget of this worker — never the CPU/heap of the main
// MCP process. The supervisor (extractors.ts) enforces the wall-clock
// timeout and terminates this thread; this file never talks back except via
// a single postMessage, and it never includes a password in that message.
import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import {
  bound,
  isDocxName,
  isPdf,
  isTextual,
  isXlsxName,
  isZipArchiveAttachment,
  isZipContainer,
} from './extractionFormat.js';
import { extractZipEntry, listZipEntries, ZipError, type ZipEntryInfo } from './zipArchive.js';

type Extractor = 'pdf' | 'xlsx' | 'docx' | 'text';
type WorkerErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EXTRACTION_FAILED'
  | 'ZIP_INVALID'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_TOO_LARGE'
  | 'ZIP_ENTRY_NOT_FOUND'
  | 'ZIP_ENCRYPTED'
  | 'ZIP_UNSUPPORTED_ENCRYPTION';

interface ContainerLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
}

interface WorkerRequest {
  readonly buffer: Buffer | Uint8Array;
  readonly name: string;
  readonly contentType: string;
  readonly maxChars: number;
  readonly mode: 'text' | 'raw';
  readonly entry?: string;
  readonly password?: string;
  readonly zipLimits: ContainerLimits;
  readonly containerLimits: ContainerLimits;
}

type TextResult = { readonly text: string; readonly truncated: boolean };

type WorkerResponse =
  | { readonly kind: 'zip_listing'; readonly zipEntries: readonly ZipEntryInfo[] }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly truncated: boolean;
      readonly extractor: Extractor;
    }
  | { readonly kind: 'raw'; readonly bytes: Uint8Array; readonly sizeBytes: number }
  | { readonly error: WorkerErrorCode };

async function extractPdf(buffer: Buffer, maxChars: number): Promise<TextResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const parts: string[] = [];
  let total = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages && total <= maxChars; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    parts.push(pageText);
    total += pageText.length;
  }
  await document.destroy();
  return bound(parts.join('\n\n'), maxChars);
}

async function extractXlsx(buffer: Buffer, maxChars: number): Promise<TextResult> {
  const workbook = new ExcelJS.Workbook();
  // exceljs bundles its own Buffer typings that don't line up structurally with
  // Node's; the runtime call accepts a Buffer/ArrayBuffer, only the type check needs help.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const lines: string[] = [];
  let total = 0;
  workbook.eachSheet((sheet) => {
    if (total > maxChars) return;
    lines.push(`# ${sheet.name}`);
    sheet.eachRow((row) => {
      if (total > maxChars) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const line = values.map((value) => (value == null ? '' : String(value))).join('\t');
      lines.push(line);
      total += line.length;
    });
  });
  return bound(lines.join('\n'), maxChars);
}

async function extractDocx(buffer: Buffer, maxChars: number): Promise<TextResult> {
  const result = await mammoth.extractRawText({ buffer });
  return bound(result.value, maxChars);
}

// Applies the parsing pipeline to `buffer` — either the whole downloaded
// attachment, or (when the request carried an `entry`) the bytes already
// pulled out of a zip archive by `runArchive` below.
async function runPipeline(
  buffer: Buffer,
  effectiveName: string,
  contentType: string,
  maxChars: number,
  mode: 'text' | 'raw',
  containerLimits: ContainerLimits
): Promise<WorkerResponse> {
  if (mode === 'raw') {
    return { kind: 'raw', bytes: new Uint8Array(buffer), sizeBytes: buffer.length };
  }

  if (isPdf(buffer)) {
    const result = await extractPdf(buffer, maxChars);
    return { kind: 'text', ...result, extractor: 'pdf' };
  }

  if (isZipContainer(buffer)) {
    const isXlsx = isXlsxName(effectiveName, contentType);
    const isDocx = isDocxName(effectiveName, contentType);
    if (!isXlsx && !isDocx) return { error: 'UNSUPPORTED_FORMAT' };

    // Fast-path, defense-in-depth only: the ZIP central directory declares an
    // uncompressed size per entry, but that field is attacker-controlled
    // metadata (zip bombs falsify it) — this cap does NOT bound real bytes
    // read. It exists purely to reject obviously-bad declared sizes before
    // paying for ExcelJS/mammoth. The real guarantee against unbounded
    // CPU/memory from a hostile xlsx/docx payload is this worker's own
    // resourceLimits, enforced by the supervisor regardless of what the file
    // itself claims.
    try {
      await listZipEntries(buffer, containerLimits);
    } catch (error) {
      if (error instanceof ZipError) return { error: 'EXTRACTION_FAILED' };
      throw error;
    }

    const result = isXlsx
      ? await extractXlsx(buffer, maxChars)
      : await extractDocx(buffer, maxChars);
    return { kind: 'text', ...result, extractor: isXlsx ? 'xlsx' : 'docx' };
  }

  if (isTextual(contentType, effectiveName)) {
    const result = bound(buffer.toString('utf8'), maxChars);
    return { kind: 'text', ...result, extractor: 'text' };
  }

  return { error: 'UNSUPPORTED_FORMAT' };
}

// Handles a user-facing .zip attachment: listing (no entry requested) or
// decrypt+inflate of one named entry (readStreamWithCap, inside
// extractZipEntry, bounds real bytes read regardless of declared size).
async function runArchive(request: WorkerRequest, buffer: Buffer): Promise<WorkerResponse> {
  const limits = { ...request.zipLimits, password: request.password };
  if (!request.entry) {
    const zipEntries = await listZipEntries(buffer, limits);
    return { kind: 'zip_listing', zipEntries };
  }
  const inner = await extractZipEntry(buffer, request.entry, limits);
  return runPipeline(
    inner,
    request.entry,
    request.contentType,
    request.maxChars,
    request.mode,
    request.containerLimits
  );
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  const buffer = Buffer.isBuffer(request.buffer) ? request.buffer : Buffer.from(request.buffer);
  try {
    if (isZipArchiveAttachment(buffer, request.name, request.contentType)) {
      return await runArchive(request, buffer);
    }
    return await runPipeline(
      buffer,
      request.name,
      request.contentType,
      request.maxChars,
      request.mode,
      request.containerLimits
    );
  } catch (error) {
    if (error instanceof ZipError) return { error: error.code };
    return { error: 'EXTRACTION_FAILED' };
  }
}

if (!parentPort) {
  throw new Error('extractionWorker.ts must run inside a worker_thread');
}

run(workerData as WorkerRequest)
  .then((response) => parentPort?.postMessage(response))
  .catch(() => parentPort?.postMessage({ error: 'EXTRACTION_FAILED' } satisfies WorkerResponse));
