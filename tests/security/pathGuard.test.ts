import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PathGuard,
  PathSecurityError,
  loadPathGuardConfig,
  createPathGuard,
} from '../../src/security/pathGuard.js';

/**
 * The pathGuard is the fence between an LLM-driven tool call and the local
 * filesystem. If this test suite regresses, the MCP server is one prompt
 * injection away from exfiltrating SSH keys. Keep it strict.
 */

function tmpdir(prefix: string): string {
  // Realpath so the test matches the guard's internal canonicalisation
  // (macOS: /var -> /private/var; Linux containers also symlink /tmp).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('PathGuard', () => {
  let downloadRoot: string;
  let uploadRoot: string;
  let guard: PathGuard;

  beforeEach(() => {
    downloadRoot = tmpdir('mcp-dl-');
    uploadRoot = tmpdir('mcp-up-');
    guard = new PathGuard({
      downloadRoot,
      uploadRoots: [uploadRoot],
    });
  });

  afterEach(() => {
    fs.rmSync(downloadRoot, { recursive: true, force: true });
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  });

  // ---------- read (uploads) ----------

  describe('resolveSafe(read)', () => {
    it('accepts a regular file inside an upload root', () => {
      const f = path.join(uploadRoot, 'hello.txt');
      fs.writeFileSync(f, 'x');
      expect(guard.resolveSafe(f, 'read')).toBe(f);
    });

    it('rejects reading files outside the upload roots', () => {
      const outside = tmpdir('mcp-outside-');
      try {
        const f = path.join(outside, 'secret.txt');
        fs.writeFileSync(f, 'x');
        expect(() => guard.resolveSafe(f, 'read')).toThrow(PathSecurityError);
        expect(() => guard.resolveSafe(f, 'read')).toThrow(/outside the allowlist/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects traversal via ../ that would escape the root', () => {
      const escape = path.join(uploadRoot, '..', 'escape.txt');
      expect(() => guard.resolveSafe(escape, 'read')).toThrow(PathSecurityError);
    });

    it('rejects a symlink inside the upload root', () => {
      const realOutside = tmpdir('mcp-real-');
      try {
        const real = path.join(realOutside, 'target.txt');
        fs.writeFileSync(real, 'leak me');
        const link = path.join(uploadRoot, 'link.txt');
        fs.symlinkSync(real, link);
        expect(() => guard.resolveSafe(link, 'read')).toThrow(/symlink/);
      } finally {
        fs.rmSync(realOutside, { recursive: true, force: true });
      }
    });

    it('rejects a file whose ancestor is a symlink pointing outside the allowlist', () => {
      // The adversarial case: a subdirectory inside uploadRoot is itself a
      // symlink that resolves to a sensitive location. A naive lexical check
      // accepts the path; we must follow the symlink chain.
      const realOutside = tmpdir('mcp-realancestor-');
      try {
        const real = path.join(realOutside, 'innocent.txt');
        fs.writeFileSync(real, 'leak me');
        const linkDir = path.join(uploadRoot, 'subdir');
        fs.symlinkSync(realOutside, linkDir);
        const smuggled = path.join(linkDir, 'innocent.txt');
        expect(() => guard.resolveSafe(smuggled, 'read')).toThrow(/outside the allowlist/);
      } finally {
        fs.rmSync(realOutside, { recursive: true, force: true });
      }
    });

    it('rejects non-existent files', () => {
      const missing = path.join(uploadRoot, 'nope.txt');
      expect(() => guard.resolveSafe(missing, 'read')).toThrow(/does not exist/);
    });

    it('rejects directories', () => {
      const d = path.join(uploadRoot, 'subdir');
      fs.mkdirSync(d);
      expect(() => guard.resolveSafe(d, 'read')).toThrow(/not a regular file/);
    });

    it('rejects paths with NUL bytes', () => {
      expect(() => guard.resolveSafe('foo\0bar', 'read')).toThrow(/NUL byte/);
    });

    it('rejects empty/invalid input', () => {
      expect(() => guard.resolveSafe('', 'read')).toThrow(/required/);
      // @ts-expect-error — deliberate runtime violation
      expect(() => guard.resolveSafe(null, 'read')).toThrow(/required/);
    });
  });

  // ---------- secret denylist ----------

  describe('secret-filename denylist', () => {
    it('refuses a .ssh path even if placed inside the allowlist', () => {
      // Build a directory called ".ssh" inside uploadRoot and try to read it.
      const ssh = path.join(uploadRoot, '.ssh', 'id_rsa');
      fs.mkdirSync(path.dirname(ssh));
      fs.writeFileSync(ssh, 'fake-key');
      expect(() => guard.resolveSafe(ssh, 'read')).toThrow(/denylist/);
    });

    it('refuses .env files', () => {
      const env = path.join(uploadRoot, '.env');
      fs.writeFileSync(env, 'SECRET=1');
      expect(() => guard.resolveSafe(env, 'read')).toThrow(/denylist/);
    });

    it('refuses .pem files', () => {
      const pem = path.join(uploadRoot, 'cert.pem');
      fs.writeFileSync(pem, 'x');
      expect(() => guard.resolveSafe(pem, 'read')).toThrow(/denylist/);
    });

    it('refuses aws credentials file', () => {
      const aws = path.join(uploadRoot, '.aws', 'credentials');
      fs.mkdirSync(path.dirname(aws));
      fs.writeFileSync(aws, 'x');
      expect(() => guard.resolveSafe(aws, 'read')).toThrow(/denylist/);
    });

    it('refuses reading id_rsa even under a neutral dir name', () => {
      const key = path.join(uploadRoot, 'keys', 'id_rsa');
      fs.mkdirSync(path.dirname(key));
      fs.writeFileSync(key, 'x');
      expect(() => guard.resolveSafe(key, 'read')).toThrow(/denylist/);
    });
  });

  // ---------- write (downloads) ----------

  describe('resolveSafe(write)', () => {
    it('accepts a write path inside downloadRoot even if the file does not exist yet', () => {
      const target = path.join(downloadRoot, 'fresh.bin');
      expect(guard.resolveSafe(target, 'write')).toBe(target);
    });

    it('rejects writes outside downloadRoot', () => {
      const outside = tmpdir('mcp-writeout-');
      try {
        const target = path.join(outside, 'evil.bin');
        expect(() => guard.resolveSafe(target, 'write')).toThrow(PathSecurityError);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects writes when parent dir is a symlink', () => {
      const realParent = tmpdir('mcp-realparent-');
      try {
        const linkParent = path.join(downloadRoot, 'link-parent');
        fs.symlinkSync(realParent, linkParent);
        const target = path.join(linkParent, 'x.bin');
        expect(() => guard.resolveSafe(target, 'write')).toThrow(/symlink/);
      } finally {
        fs.rmSync(realParent, { recursive: true, force: true });
      }
    });
  });

  // ---------- targetDirectory ----------

  describe('resolveTargetDirectory', () => {
    it('returns downloadRoot when undefined', () => {
      expect(guard.resolveTargetDirectory(undefined)).toBe(downloadRoot);
    });

    it('returns downloadRoot when empty', () => {
      expect(guard.resolveTargetDirectory('')).toBe(downloadRoot);
    });

    it('accepts subdirectories of downloadRoot', () => {
      const sub = path.join(downloadRoot, 'sub');
      expect(guard.resolveTargetDirectory(sub)).toBe(sub);
    });

    it('rejects anything outside downloadRoot', () => {
      expect(() => guard.resolveTargetDirectory('/etc')).toThrow(/outside downloadRoot/);
    });

    it('rejects targetDirectory walking through secret segment', () => {
      // Even if this happened to be inside downloadRoot, a `.ssh` segment is
      // nonsensical and cheaper to refuse than to reason about.
      const dangerous = path.join(downloadRoot, '.ssh');
      expect(() => guard.resolveTargetDirectory(dangerous)).toThrow(/denylist/);
    });
  });

  // ---------- getters ----------

  it('exposes the configured roots', () => {
    expect(guard.getDownloadRoot()).toBe(downloadRoot);
    expect(guard.getUploadRoots()).toEqual([uploadRoot]);
  });
});

describe('loadPathGuardConfig', () => {
  it('defaults to ~/Downloads/mcp-email-attachments when DOWNLOAD_DIR unset', () => {
    const cfg = loadPathGuardConfig({});
    expect(cfg.downloadRoot).toBe(
      path.join(os.homedir(), 'Downloads', 'mcp-email-attachments')
    );
  });

  it('honours DOWNLOAD_DIR', () => {
    const d = tmpdir('mcp-cfg-');
    try {
      const cfg = loadPathGuardConfig({ DOWNLOAD_DIR: d });
      expect(cfg.downloadRoot).toBe(d);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('defaults uploadRoots to [downloadRoot] when MCP_EMAIL_UPLOAD_DIRS unset', () => {
    const cfg = loadPathGuardConfig({});
    expect(cfg.uploadRoots).toEqual([cfg.downloadRoot]);
  });

  it('parses MCP_EMAIL_UPLOAD_DIRS as colon-separated', () => {
    const a = tmpdir('mcp-a-');
    const b = tmpdir('mcp-b-');
    try {
      const cfg = loadPathGuardConfig({ MCP_EMAIL_UPLOAD_DIRS: `${a}:${b}` });
      expect(cfg.uploadRoots).toEqual([a, b]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('createPathGuard wires env into a PathGuard instance', () => {
    const d = tmpdir('mcp-cpg-');
    try {
      const g = createPathGuard({ DOWNLOAD_DIR: d });
      expect(g.getDownloadRoot()).toBe(d);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
