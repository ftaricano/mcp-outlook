import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ZipFile } from 'yazl';
import { extractZipEntry, listZipEntries, readStreamWithCap } from '../../src/plugin/zipArchive.js';

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

const LIMITS = { maxEntries: 200, maxUncompressedBytes: 50 * 1024 * 1024 };

describe('zipArchive', () => {
  it('lists entries with sizes', async () => {
    const zip = await buildZip({ 'GRUPO-ALFA/fatura-05-2026.pdf': '%PDF fake', 'leia-me.txt': 'oi' });
    const entries = await listZipEntries(zip, LIMITS);
    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['GRUPO-ALFA/fatura-05-2026.pdf', 'leia-me.txt'])
    );
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
    await expect(listZipEntries(zip, { ...LIMITS, maxUncompressedBytes: 1024 })).rejects.toMatchObject({
      code: 'ZIP_TOO_LARGE',
    });
  });

  it('rejects archives with too many entries', async () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}.txt`, 'x']));
    const zip = await buildZip(many);
    await expect(listZipEntries(zip, { ...LIMITS, maxEntries: 3 })).rejects.toMatchObject({
      code: 'ZIP_TOO_MANY_ENTRIES',
    });
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

  it('signals encrypted entries in the listing and fails extraction without password', async () => {
    // yazl não gera ZIP cifrado; fixture binária mínima com ZipCrypto fica em
    // tests/fixtures/plugin/encrypted.zip (gerada uma única vez com `zip -P test123`
    // contendo secret.txt="segredo"; conteúdo fictício, sem dado real).
    const { readFileSync } = await import('node:fs');
    const zip = readFileSync('tests/fixtures/plugin/encrypted.zip');
    const entries = await listZipEntries(zip, LIMITS);
    expect(entries[0].encrypted).toBe(true);
    await expect(extractZipEntry(zip, 'secret.txt', LIMITS)).rejects.toMatchObject({
      code: 'ZIP_ENCRYPTED',
    });
    const decrypted = await extractZipEntry(zip, 'secret.txt', { ...LIMITS, password: 'test123' });
    expect(decrypted.toString('utf8')).toContain('segredo');
  });
});
