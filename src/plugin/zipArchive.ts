import { Open } from 'unzipper';
import { isAddressableZipEntryName } from './zipEntryName.js';

export type ZipErrorCode =
  | 'ZIP_INVALID'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_TOO_LARGE'
  | 'ZIP_ENTRY_NOT_FOUND'
  | 'ZIP_ENCRYPTED'
  | 'ZIP_UNSUPPORTED_ENCRYPTION';

export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode) {
    super(code);
    this.name = 'ZipError';
  }
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly uncompressedSize: number;
  readonly encrypted: boolean;
}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly password?: string;
}

export interface ZipListing {
  readonly entries: readonly ZipEntryInfo[];
  // Entries present in the archive but not addressable by name (see
  // isAddressableZipEntryName). Reported rather than dropped silently: a
  // listing that quietly loses every entry of a legacy backslash-separated
  // archive reads as "the attachment has no document" — a false negative.
  readonly hiddenEntries: number;
}

interface RawEntry {
  path: string;
  type: string;
  uncompressedSize?: number;
  flags?: number;
  buffer(password?: string): Promise<Buffer>;
  stream(password?: string): NodeJS.ReadableStream;
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const MAX_END_COMMENT_BYTES = 0xffff;
const MAX_CENTRAL_RECORD_BYTES = 4096;

function preflightCentralDirectory(buffer: Buffer, limits: ZipLimits): void {
  const minimumOffset = Math.max(0, buffer.length - (22 + MAX_END_COMMENT_BYTES));
  let endOffset = -1;

  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      endOffset = offset;
      break;
    }
  }

  if (endOffset < 0) throw new ZipError('ZIP_INVALID');

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);

  // Multi-disk and ZIP64 archives need a different parser. Refuse them before
  // unzipper can allocate a directory with bounds we have not validated.
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ZipError('ZIP_INVALID');
  }

  if (totalEntries > limits.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
  if (centralDirectorySize > limits.maxEntries * MAX_CENTRAL_RECORD_BYTES) {
    throw new ZipError('ZIP_TOO_LARGE');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset > endOffset ||
    centralDirectoryEnd > endOffset ||
    centralDirectoryEnd < centralDirectoryOffset
  ) {
    throw new ZipError('ZIP_INVALID');
  }

  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralDirectoryEnd) throw new ZipError('ZIP_INVALID');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new ZipError('ZIP_INVALID');
    }
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipError('ZIP_INVALID');
    }
    const recordLength = 46 + filenameLength + extraLength + commentLength;
    if (recordLength > MAX_CENTRAL_RECORD_BYTES) throw new ZipError('ZIP_TOO_LARGE');
    cursor += recordLength;
  }
  if (cursor !== centralDirectoryEnd) throw new ZipError('ZIP_INVALID');
}

async function openArchive(buffer: Buffer, limits: ZipLimits): Promise<RawEntry[]> {
  preflightCentralDirectory(buffer, limits);
  try {
    const directory = await Open.buffer(buffer);
    const entries = directory.files as unknown as RawEntry[];
    if (entries.length > limits.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
    return entries;
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('ZIP_INVALID');
  }
}

function isEncrypted(entry: RawEntry): boolean {
  // bit 0 do general purpose flag = encrypted (ZipCrypto ou AES)
  return ((entry.flags ?? 0) & 0x1) === 0x1;
}

export async function listZipEntries(buffer: Buffer, limits: ZipLimits): Promise<ZipListing> {
  const files = (await openArchive(buffer, limits)).filter((entry) => entry.type === 'File');

  // Heuristic fast-path only: uncompressedSize comes from the ZIP central
  // directory, metadata the archive itself supplies and a zip bomb can
  // falsify. This cap does not bound real bytes read — it just rejects
  // obviously-bad declared totals cheaply, before any parser sees the file.
  const declaredTotalBytes = files.reduce(
    (total, entry) => total + (entry.uncompressedSize ?? 0),
    0
  );
  if (declaredTotalBytes > limits.maxUncompressedBytes) throw new ZipError('ZIP_TOO_LARGE');

  const addressable = files.filter((entry) => isAddressableZipEntryName(entry.path));

  return {
    entries: addressable.map((entry) => ({
      name: entry.path,
      uncompressedSize: entry.uncompressedSize ?? 0,
      encrypted: isEncrypted(entry),
    })),
    hiddenEntries: files.length - addressable.length,
  };
}

// O uncompressedSize do header central é declarado pelo próprio arquivo e pode mentir
// (zip bomb); o pre-check abaixo é só fast-path. A garantia real é o cap por bytes
// lidos do stream em readStreamWithCap.
export function readStreamWithCap(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: ZipError): void => {
      if (settled) return;
      settled = true;
      const destroyable = stream as unknown as { destroy?: (error?: Error) => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      reject(error);
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new ZipError('ZIP_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', () => {
      fail(new ZipError('ZIP_INVALID'));
    });
  });
}

function measureStreamWithCap(stream: NodeJS.ReadableStream, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;

    const fail = (error: ZipError): void => {
      if (settled) return;
      settled = true;
      const destroyable = stream as unknown as { destroy?: (error?: Error) => void };
      destroyable.destroy?.();
      reject(error);
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) fail(new ZipError('ZIP_TOO_LARGE'));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });
    stream.on('error', () => fail(new ZipError('ZIP_INVALID')));
  });
}

export async function validateZipContents(buffer: Buffer, limits: ZipLimits): Promise<void> {
  const files = (await openArchive(buffer, limits)).filter((entry) => entry.type === 'File');
  const declaredTotalBytes = files.reduce(
    (total, entry) => total + (entry.uncompressedSize ?? 0),
    0
  );
  if (declaredTotalBytes > limits.maxUncompressedBytes) throw new ZipError('ZIP_TOO_LARGE');

  let measuredTotalBytes = 0;
  for (const entry of files) {
    if (isEncrypted(entry) && !limits.password) throw new ZipError('ZIP_ENCRYPTED');
    try {
      measuredTotalBytes += await measureStreamWithCap(
        entry.stream(limits.password),
        limits.maxUncompressedBytes - measuredTotalBytes
      );
    } catch (error) {
      if (error instanceof ZipError && error.code === 'ZIP_TOO_LARGE') throw error;
      throw new ZipError(isEncrypted(entry) ? 'ZIP_UNSUPPORTED_ENCRYPTION' : 'ZIP_INVALID');
    }
  }
}

export async function extractZipEntry(
  buffer: Buffer,
  entryName: string,
  limits: ZipLimits
): Promise<Buffer> {
  const files = (await openArchive(buffer, limits)).filter((entry) => entry.type === 'File');

  const entry = files.find(
    (candidate) => candidate.path === entryName && isAddressableZipEntryName(candidate.path)
  );
  if (!entry) throw new ZipError('ZIP_ENTRY_NOT_FOUND');

  // fast-path: o tamanho declarado no header central já descarta bombas óbvias
  // sem abrir o stream, mas não é a garantia — ver readStreamWithCap.
  if ((entry.uncompressedSize ?? 0) > limits.maxUncompressedBytes)
    throw new ZipError('ZIP_TOO_LARGE');
  if (isEncrypted(entry) && !limits.password) throw new ZipError('ZIP_ENCRYPTED');

  let extracted: Buffer;
  try {
    extracted = await readStreamWithCap(entry.stream(limits.password), limits.maxUncompressedBytes);
  } catch (error) {
    if (error instanceof ZipError && error.code === 'ZIP_TOO_LARGE') throw error;
    // senha errada e AES não suportado caem aqui; não dá para distinguir sem vazar detalhe
    throw new ZipError(isEncrypted(entry) ? 'ZIP_UNSUPPORTED_ENCRYPTION' : 'ZIP_INVALID');
  }

  return extracted;
}
