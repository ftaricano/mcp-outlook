import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRYPOINTS = [
  resolve(process.cwd(), 'dist/index.js'),
  resolve(process.cwd(), 'dist/plugin/stdio.js'),
  resolve(process.cwd(), 'dist/plugin/http.js'),
];

function runEntrypoint(entrypoint: string, cwd: string, preloadPath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        HOME: cwd,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'test',
        NODE_OPTIONS: `--require=${preloadPath}`,
        OUTLOOK_KEYCHAIN_QUIET: '1',
        MICROSOFT_GRAPH_CLIENT_ID: ['synthetic', 'client-id', '0123456789abcdef'].join('-'),
        MICROSOFT_GRAPH_CLIENT_SECRET: '',
        MICROSOFT_GRAPH_TENANT_ID: ['synthetic', 'tenant-id', 'fedcba9876543210'].join('-'),
      },
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`Startup entrypoint timed out: ${entrypoint}`));
    }, 5_000);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 1) {
        rejectPromise(new Error(`Expected startup validation exit 1, got ${code}`));
        return;
      }
      resolvePromise(stderr);
    });
  });
}

describe('startup environment validation stderr', () => {
  it('retains Graph variable names without echoing supplied values on all entrypoints', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mcp-outlook-startup-redaction-'));
    const preloadPath = join(cwd, 'platform.cjs');
    writeFileSync(
      preloadPath,
      "Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });\n",
      { mode: 0o600 }
    );

    try {
      const outputs = await Promise.all(
        ENTRYPOINTS.map((entrypoint) => runEntrypoint(entrypoint, cwd, preloadPath))
      );
      for (const output of outputs) {
        expect(output).toContain('MICROSOFT_GRAPH_CLIENT_ID');
        expect(output).toContain('MICROSOFT_GRAPH_CLIENT_SECRET');
        expect(output).toContain('MICROSOFT_GRAPH_TENANT_ID');
        expect(output).not.toContain('0123456789abcdef');
        expect(output).not.toContain('fedcba9876543210');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
