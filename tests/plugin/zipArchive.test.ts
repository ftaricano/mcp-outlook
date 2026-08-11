import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ZipFile } from 'yazl';
import {
  extractZipEntry,
  listZipEntries,
  readStreamWithCap,
  validateZipContents,
} from '../../src/plugin/zipArchive.js';

function buildZip(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk as Buffer));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function buildZipWithDirectories(directoryCount: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (let index = 0; index < directoryCount; index += 1) {
      zip.addEmptyDirectory(`dir-${index}`);
    }
    zip.addBuffer(Buffer.from('x'), 'file.txt');
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk as Buffer));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function patchFirstCentralEntry(
  zip: Buffer,
  mutate: (buffer: Buffer, offset: number) => void
): Buffer {
  const patched = Buffer.from(zip);
  for (let offset = 0; offset <= patched.length - 46; offset += 1) {
    if (patched.readUInt32LE(offset) === 0x02014b50) {
      mutate(patched, offset);
      return patched;
    }
  }
  throw new Error('central directory entry not found');
}

const LIMITS = { maxEntries: 200, maxUncompressedBytes: 50 * 1024 * 1024 };

describe('zipArchive', () => {
  it('lists entries with sizes', async () => {
    const zip = await buildZip({
      'GRUPO-ALFA/fatura-05-2026.pdf': '%PDF fake',
      'leia-me.txt': 'oi',
    });
    const listing = await listZipEntries(zip, LIMITS);
    expect(listing.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['GRUPO-ALFA/fatura-05-2026.pdf', 'leia-me.txt'])
    );
    expect(listing.hiddenEntries).toBe(0);
  });

  it('reports entries excluded from the listing instead of dropping them silently', async () => {
    // Zippers on legacy Windows tooling write '\' as the separator. yazl refuses
    // to create such a name, so patch the bytes after the fact — the name is not
    // covered by the CRC and the replacement is the same length, so offsets and
    // checksums stay valid.
    const zip = await buildZip({ 'dir/antigo.txt': 'x', 'ok.txt': 'y' });
    const legacy = Buffer.from(
      zip.toString('latin1').split('dir/antigo.txt').join('dir\\antigo.txt'),
      'latin1'
    );

    const listing = await listZipEntries(legacy, LIMITS);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['ok.txt']);
    expect(listing.hiddenEntries).toBe(1);
  });

  it('keeps a name with a dotted segment addressable, since it is not traversal', async () => {
    const zip = await buildZip({ 'relatorio..v2.pdf': 'conteudo' });
    const listing = await listZipEntries(zip, LIMITS);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['relatorio..v2.pdf']);
    expect(listing.hiddenEntries).toBe(0);

    const extracted = await extractZipEntry(zip, 'relatorio..v2.pdf', LIMITS);
    expect(extracted.toString('utf8')).toBe('conteudo');
  });

  it('extracts a single entry by exact name', async () => {
    const zip = await buildZip({ 'a.txt': 'conteudo-a', 'b.txt': 'conteudo-b' });
    const buffer = await extractZipEntry(zip, 'b.txt', LIMITS);
    expect(buffer.toString('utf8')).toBe('conteudo-b');
  });

  it('rejects a missing entry with a stable code', async () => {
    const zip = await buildZip({ 'a.txt': 'x' });
    await expect(extractZipEntry(zip, 'nao-existe.txt', LIMITS)).rejects.toMatchObject({
      code: 'ZIP_ENTRY_NOT_FOUND',
    });
  });

  it('rejects listing when the declared total uncompressed size exceeds the cap', async () => {
    const zip = await buildZip({ 'a.txt': 'x'.repeat(2048), 'b.txt': 'y'.repeat(2048) });
    await expect(
      listZipEntries(zip, { ...LIMITS, maxUncompressedBytes: 1024 })
    ).rejects.toMatchObject({
      code: 'ZIP_TOO_LARGE',
    });
  });

  it('rejects archives with too many entries', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`f${index}.txt`, 'x'])
    );
    const zip = await buildZip(many);
    await expect(listZipEntries(zip, { ...LIMITS, maxEntries: 3 })).rejects.toMatchObject({
      code: 'ZIP_TOO_MANY_ENTRIES',
    });
  });

  it('counts directory records against maxEntries before opening the archive', async () => {
    const zip = await buildZipWithDirectories(3);
    await expect(listZipEntries(zip, { ...LIMITS, maxEntries: 3 })).rejects.toMatchObject({
      code: 'ZIP_TOO_MANY_ENTRIES',
    });
  });

  it.each([
    [
      'non-zero entry disk',
      (buffer: Buffer, offset: number) => buffer.writeUInt16LE(1, offset + 34),
    ],
    [
      'ZIP64 compressed size sentinel',
      (buffer: Buffer, offset: number) => buffer.writeUInt32LE(0xffffffff, offset + 20),
    ],
    [
      'ZIP64 local header offset sentinel',
      (buffer: Buffer, offset: number) => buffer.writeUInt32LE(0xffffffff, offset + 42),
    ],
  ])('rejects a central entry with %s before opening', async (_label, mutate) => {
    const zip = await buildZip({ 'a.txt': 'x' });
    await expect(listZipEntries(patchFirstCentralEntry(zip, mutate), LIMITS)).rejects.toMatchObject(
      {
        code: 'ZIP_INVALID',
      }
    );
  });

  it('rejects entries whose declared uncompressed size exceeds the cap', async () => {
    const zip = await buildZip({ 'big.txt': 'y'.repeat(2048) });
    await expect(
      extractZipEntry(zip, 'big.txt', { ...LIMITS, maxUncompressedBytes: 1024 })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });

  it('rejects traversal entry names on extraction', async () => {
    const zip = await buildZip({ 'ok.txt': 'x' });
    await expect(extractZipEntry(zip, '../fora.txt', LIMITS)).rejects.toMatchObject({
      code: 'ZIP_ENTRY_NOT_FOUND',
    });
  });

  it('rejects entries whose real bytes exceed the cap even when the declared header size lies', async () => {
    // simula um header central mentiroso (uncompressedSize menor que o conteúdo real):
    // extractZipEntry só confia no declarado como fast-path, quem garante o cap é o
    // stream real, então testamos o cap por stream de forma isolada aqui.
    const stream = new PassThrough();
    const cap = 1024;
    const chunk = Buffer.alloc(512, 'y');

    const pending = readStreamWithCap(stream, cap);
    stream.write(chunk);
    stream.write(chunk);
    stream.write(chunk); // 1536 bytes escritos > cap de 1024, sem nunca sinalizar 'end'

    await expect(pending).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });

  it('aborts a real zip extraction without materializing content beyond the cap', async () => {
    const zip = await buildZip({ 'big.txt': 'z'.repeat(1024 * 1024) });
    await expect(
      extractZipEntry(zip, 'big.txt', { ...LIMITS, maxUncompressedBytes: 10 })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });

  it('validates aggregate real entry bytes before an OOXML parser receives the container', async () => {
    const zip = await buildZip({ 'a.xml': 'a'.repeat(700), 'b.xml': 'b'.repeat(700) });
    const dishonest = Buffer.from(zip);
    for (let offset = 0; offset <= dishonest.length - 46; offset += 1) {
      if (dishonest.readUInt32LE(offset) === 0x02014b50) {
        dishonest.writeUInt32LE(1, offset + 24);
      }
    }
    await expect(
      validateZipContents(dishonest, { ...LIMITS, maxUncompressedBytes: 1_000 })
    ).rejects.toMatchObject({ code: 'ZIP_TOO_LARGE' });
  });

  it('signals encrypted entries in the listing and fails extraction without password', async () => {
    // yazl não gera ZIP cifrado; fixture binária mínima com ZipCrypto fica em
    // tests/fixtures/plugin/encrypted.zip (gerada uma única vez com `zip -P test123`
    // contendo secret.txt="segredo"; conteúdo fictício, sem dado real).
    const { readFileSync } = await import('node:fs');
    const zip = readFileSync('tests/fixtures/plugin/encrypted.zip');
    const listing = await listZipEntries(zip, LIMITS);
    expect(listing.entries[0].encrypted).toBe(true);
    await expect(extractZipEntry(zip, 'secret.txt', LIMITS)).rejects.toMatchObject({
      code: 'ZIP_ENCRYPTED',
    });
    const decrypted = await extractZipEntry(zip, 'secret.txt', { ...LIMITS, password: 'test123' });
    expect(decrypted.toString('utf8')).toContain('segredo');
  });
});
