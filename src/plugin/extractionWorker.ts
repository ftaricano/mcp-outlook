// Runs inside a dedicated worker_thread (spawned by extractors.ts). All
// attachment parsing (pdfjs / ExcelJS / mammoth) happens here so that a
// hostile or malformed file can only exhaust the resourceLimits budget of
// this worker — not the CPU/heap of the main MCP process. The supervisor
// enforces the wall-clock timeout and terminates this thread; this file
// never talks back except via a single postMessage.
import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import {
  bound,
  isDocxName,
  isPdf,
  isTextual,
  isXlsxName,
  isZipContainer,
} from './extractionFormat.js';

type Extractor = 'pdf' | 'xlsx' | 'docx' | 'text';
type WorkerErrorCode = 'UNSUPPORTED_FORMAT' | 'EXTRACTION_FAILED';

interface WorkerRequest {
  readonly buffer: Buffer | Uint8Array;
  readonly name: string;
  readonly contentType: string;
  readonly maxChars: number;
}

type WorkerResponse =
  | { readonly text: string; readonly truncated: boolean; readonly extractor: Extractor }
  | { readonly error: WorkerErrorCode };

async function extractPdf(buffer: Buffer, maxChars: number): Promise<WorkerResponse> {
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
  return { ...bound(parts.join('\n\n'), maxChars), extractor: 'pdf' };
}

async function extractXlsx(buffer: Buffer, maxChars: number): Promise<WorkerResponse> {
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
  return { ...bound(lines.join('\n'), maxChars), extractor: 'xlsx' };
}

async function extractDocx(buffer: Buffer, maxChars: number): Promise<WorkerResponse> {
  const result = await mammoth.extractRawText({ buffer });
  return { ...bound(result.value, maxChars), extractor: 'docx' };
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  const buffer = Buffer.isBuffer(request.buffer) ? request.buffer : Buffer.from(request.buffer);
  const { name, contentType, maxChars } = request;
  try {
    if (isPdf(buffer)) return await extractPdf(buffer, maxChars);
    if (isZipContainer(buffer)) {
      if (isXlsxName(name, contentType)) return await extractXlsx(buffer, maxChars);
      if (isDocxName(name, contentType)) return await extractDocx(buffer, maxChars);
      return { error: 'UNSUPPORTED_FORMAT' };
    }
    if (isTextual(contentType, name)) {
      return { ...bound(buffer.toString('utf8'), maxChars), extractor: 'text' };
    }
    return { error: 'UNSUPPORTED_FORMAT' };
  } catch {
    return { error: 'EXTRACTION_FAILED' };
  }
}

if (!parentPort) {
  throw new Error('extractionWorker.ts must run inside a worker_thread');
}

run(workerData as WorkerRequest)
  .then((response) => parentPort?.postMessage(response))
  .catch(() => parentPort?.postMessage({ error: 'EXTRACTION_FAILED' } satisfies WorkerResponse));
