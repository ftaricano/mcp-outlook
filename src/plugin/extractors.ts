import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { listZipEntries, ZipError } from './zipArchive.js';

const EXTRACTION_TIMEOUT_MS = 30_000;
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

function bound(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1').startsWith('%PDF');
}

function isZipContainer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isTextual(contentType: string, name: string): boolean {
  const lowered = contentType.toLowerCase();
  return (
    lowered.startsWith('text/') ||
    lowered.includes('json') ||
    lowered.includes('xml') ||
    lowered.includes('csv') ||
    /\.(txt|csv|json|xml|html?)$/i.test(name)
  );
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionError('EXTRACTION_TIMEOUT')), EXTRACTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function extractPdf(buffer: Buffer, maxChars: number): Promise<ExtractedText> {
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
  const bounded = bound(parts.join('\n\n'), maxChars);
  return { ...bounded, extractor: 'pdf' };
}

async function extractXlsx(buffer: Buffer, maxChars: number): Promise<ExtractedText> {
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
  const bounded = bound(lines.join('\n'), maxChars);
  return { ...bounded, extractor: 'xlsx' };
}

async function extractDocx(buffer: Buffer, maxChars: number): Promise<ExtractedText> {
  const result = await mammoth.extractRawText({ buffer });
  const bounded = bound(result.value, maxChars);
  return { ...bounded, extractor: 'docx' };
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
    if (isPdf(buffer)) return await withTimeout(extractPdf(buffer, maxChars));
    if (isZipContainer(buffer)) {
      const isXlsx = /\.xlsx$/i.test(name) || contentType.includes('spreadsheetml');
      const isDocx = /\.docx$/i.test(name) || contentType.includes('wordprocessingml');
      if (!isXlsx && !isDocx) throw new ExtractionError('UNSUPPORTED_FORMAT');

      // xlsx/docx são contêineres ZIP entregues inteiros ao parser (ExcelJS/mammoth);
      // um pre-scan com os mesmos caps do ZIP genérico impede zip bombs disfarçadas de
      // documento antes de materializar o parser. Promise.race abaixo não cancela o
      // trabalho do parser em si (limitação conhecida do Node), só o await — a mitigação
      // real é este cap de entrada.
      try {
        await listZipEntries(buffer, limits);
      } catch (error) {
        if (error instanceof ZipError) throw new ExtractionError('EXTRACTION_FAILED');
        throw error;
      }

      if (isXlsx) return await withTimeout(extractXlsx(buffer, maxChars));
      return await withTimeout(extractDocx(buffer, maxChars));
    }
    if (isTextual(contentType, name)) {
      const bounded = bound(buffer.toString('utf8'), maxChars);
      return { ...bounded, extractor: 'text' };
    }
    throw new ExtractionError('UNSUPPORTED_FORMAT');
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError('EXTRACTION_FAILED');
  }
}
