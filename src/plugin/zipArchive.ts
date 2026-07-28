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

async function openArchive(buffer: Buffer): Promise<RawEntry[]> {
  try {
    const directory = await Open.buffer(buffer);
    return directory.files as unknown as RawEntry[];
  } catch {
    throw new ZipError('ZIP_INVALID');
  }
}

function isEncrypted(entry: RawEntry): boolean {
  // bit 0 do general purpose flag = encrypted (ZipCrypto ou AES)
  return ((entry.flags ?? 0) & 0x1) === 0x1;
}

export async function listZipEntries(buffer: Buffer, limits: ZipLimits): Promise<ZipListing> {
  const files = (await openArchive(buffer)).filter((entry) => entry.type === 'File');
  if (files.length > limits.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');

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

export async function extractZipEntry(
  buffer: Buffer,
  entryName: string,
  limits: ZipLimits
): Promise<Buffer> {
  const files = (await openArchive(buffer)).filter((entry) => entry.type === 'File');
  if (files.length > limits.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');

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
