import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileManager } from '../../src/services/fileManager.js';
import { PathGuard } from '../../src/security/pathGuard.js';

// Regression guard for the cleanup_old_downloads "dry-run deletes for real" bug:
// dryRun must count matches WITHOUT touching the filesystem.
describe('FileManager.cleanupOldFiles - dryRun must not delete', () => {
  let tmp: string;
  let fm: FileManager;
  let oldFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fm-'));
    const guard = new PathGuard({ downloadRoot: tmp, uploadRoots: [tmp] });
    fm = new FileManager(guard);
    // Create the file under the guard's canonicalized download root (macOS
    // resolves /var -> /private/var), which is what listDownloadedFiles reads.
    oldFile = path.join(guard.getDownloadRoot(), 'old.txt');
    fs.writeFileSync(oldFile, 'stale');
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    fs.utimesSync(oldFile, past, past);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('counts the match but does NOT delete when dryRun=true', () => {
    const n = fm.cleanupOldFiles(24, true);
    expect(n).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(true); // simulation: file survives
  });

  it('actually deletes when dryRun=false', () => {
    const n = fm.cleanupOldFiles(24, false);
    expect(n).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('defaults to a real delete when no dryRun arg is passed (back-compat)', () => {
    const n = fm.cleanupOldFiles(24);
    expect(n).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
  });
});

describe('FileManager.saveAttachmentToDisk atomic publication', () => {
  let tmp: string;
  let fm: FileManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fm-save-'));
    fm = new FileManager(new PathGuard({ downloadRoot: tmp, uploadRoots: [tmp] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const attachment = {
    name: 'report.txt',
    contentType: 'text/plain',
    contentBytes: Buffer.from('complete').toString('base64'),
    size: 8,
  };

  it('publishes concurrent same-name writes without truncating or clobbering either file', async () => {
    const otherAttachment = {
      ...attachment,
      contentBytes: Buffer.from('different').toString('base64'),
      size: 9,
    };
    const [first, second] = await Promise.all([
      fm.saveAttachmentToDisk(attachment),
      fm.saveAttachmentToDisk(otherAttachment),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(new Set([path.basename(first.filePath), path.basename(second.filePath)])).toEqual(
      new Set(['report.txt', 'report_1.txt'])
    );
    expect(fs.readFileSync(first.filePath, 'utf8')).toBe('complete');
    expect(fs.readFileSync(second.filePath, 'utf8')).toBe('different');
    expect(fs.readdirSync(tmp).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('removes its temporary file when atomic publication fails', async () => {
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(
      Object.assign(new Error('simulated publish failure'), { code: 'EACCES' })
    );

    const result = await fm.saveAttachmentToDisk(attachment);

    expect(result.success).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it.each([
    ['ASCII', `${'a'.repeat(300)}.pdf`],
    ['Unicode', `${'📄'.repeat(150)}.xlsx`],
  ])(
    'reserves the temp suffix byte budget for long %s names and preserves the extension',
    async (_label, name) => {
      const extension = path.extname(name);
      const result = await fm.saveAttachmentToDisk({ ...attachment, name });

      expect(result.success).toBe(true);
      expect(result.filename.endsWith(extension)).toBe(true);
      expect(result.filename).not.toContain('\ufffd');
      expect(
        Buffer.byteLength(`.${result.filename}.${process.pid}.${'0'.repeat(36)}.tmp`, 'utf8')
      ).toBeLessThanOrEqual(255);
      expect(fs.readFileSync(result.filePath, 'utf8')).toBe('complete');
      expect(fs.readdirSync(tmp).some((entry) => entry.endsWith('.tmp'))).toBe(false);
    }
  );
});
