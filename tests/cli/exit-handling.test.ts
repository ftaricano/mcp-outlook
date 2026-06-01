import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../../scripts/outlook.js');
const FAKE_SERVER = resolve(here, '../fixtures/fake-mcp-server.mjs');

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], fakeMode: string): Promise<CliResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OUTLOOK_SERVER_ENTRY: FAKE_SERVER,
        FAKE_SERVER_MODE: fakeMode,
        // Pre-set creds so the CLI's keychain bootstrap stays silent. The fake
        // server ignores them entirely.
        MICROSOFT_GRAPH_CLIENT_ID: 'dummy',
        MICROSOFT_GRAPH_CLIENT_SECRET: 'dummy',
        MICROSOFT_GRAPH_TENANT_ID: 'dummy',
        TARGET_USER_EMAIL: 'dummy@example.com',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', rejectP);
    child.on('close', (code, signal) => resolveP({ code, signal, stdout, stderr }));
  });
}

describe('outlook CLI — server shutdown exit handling', () => {
  it('reports success when the server exits non-zero AFTER a result was printed (list)', async () => {
    const r = await runCli(['list'], 'success-then-fail');
    expect(r.stdout).toContain('fake_tool');
    expect(r.stderr).not.toMatch(/Server exited/i);
    expect(r.stderr).not.toMatch(/check credentials/i);
    expect(r.code).toBe(0);
  });

  it('reports success for a tool call even when shutdown exits non-zero', async () => {
    const r = await runCli(['fake_tool'], 'success-then-fail');
    expect(r.stdout).toContain('FAKE_RESULT_OK');
    expect(r.stderr).not.toMatch(/Server exited/i);
    expect(r.code).toBe(0);
  });

  it('still succeeds cleanly when the server exits 0 on shutdown', async () => {
    const r = await runCli(['list'], 'success-clean');
    expect(r.stdout).toContain('fake_tool');
    expect(r.code).toBe(0);
  });

  it('still reports an error when the server fails BEFORE producing a result, surfacing the real reason', async () => {
    const r = await runCli(['list'], 'fail-before-frame');
    expect(r.code).toBe(1);
    // The genuine startup-failure path must still error, and should surface the
    // server's actual stderr instead of only a generic credentials hint.
    expect(r.stderr).toMatch(/simulated startup failure/i);
    expect(r.stdout).not.toContain('fake_tool');
  });
});
