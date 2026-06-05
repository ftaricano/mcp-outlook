import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
