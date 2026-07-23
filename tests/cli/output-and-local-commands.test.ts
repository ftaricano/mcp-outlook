import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../../scripts/outlook.js');
const FAKE_SERVER = resolve(here, '../fixtures/fake-mcp-server.mjs');
const tempDirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outlook-cli-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCli(args: string[], stateDir: string, fakeMode = 'structured-success') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveP, rejectP) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OUTLOOK_SERVER_ENTRY: FAKE_SERVER,
          FAKE_SERVER_MODE: fakeMode,
          OUTLOOK_STATE_DIR: stateDir,
          MICROSOFT_GRAPH_CLIENT_ID: 'dummy',
          MICROSOFT_GRAPH_CLIENT_SECRET: 'dummy',
          MICROSOFT_GRAPH_TENANT_ID: 'dummy',
          TARGET_USER_EMAIL: 'dummy@example.com',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data.toString('utf8')));
      child.stderr.on('data', (data) => (stderr += data.toString('utf8')));
      child.on('error', rejectP);
      child.on('close', (code) => resolveP({ code, stdout, stderr }));
    }
  );
}

describe('outlook CLI agent output and local commands', () => {
  it('--output=json prints structuredContent and journals sanitized evidence', async () => {
    const stateDir = await tempStateDir();
    const result = await runCli(
      [
        'fake_tool',
        '--query=Secret Client',
        '--sender=private@example.com',
        '--output=json',
        '--session=test-session',
      ],
      stateDir
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ status: 'FOUND', strategy: 'local_scan' })
    );
    const journal = await readFile(join(stateDir, 'runs.jsonl'), 'utf8');
    expect(journal).not.toContain('Secret Client');
    expect(journal).not.toContain('private@example.com');
    expect(JSON.parse(journal)).toEqual(
      expect.objectContaining({
        command: 'unknown_command',
        sessionId: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        searchEvidence: expect.objectContaining({ status: 'FOUND' }),
      })
    );
  });

  it('journals search evidence even when the tool returns an error result', async () => {
    const stateDir = await tempStateDir();
    const result = await runCli(
      [
        'fake_tool',
        '--query=Secret Client',
        '--sender=private@example.com',
        '--session=test-session',
      ],
      stateDir,
      'structured-error'
    );

    // The CLI reports the failure (non-zero exit) but the run must still be journaled with
    // its structured evidence so harvest can observe recurring reliability failures.
    expect(result.code).not.toBe(0);
    const journal = await readFile(join(stateDir, 'runs.jsonl'), 'utf8');
    expect(journal).not.toContain('Secret Client');
    expect(journal).not.toContain('private@example.com');
    expect(JSON.parse(journal)).toEqual(
      expect.objectContaining({
        exitStatus: 'error',
        searchEvidence: expect.objectContaining({
          status: 'SEARCH_UNTRUSTED',
          strategy: 'local_scan',
          truncated: true,
        }),
      })
    );
  });

  it('--output=mcp preserves the raw MCP result envelope', async () => {
    const stateDir = await tempStateDir();
    const result = await runCli(['fake_tool', '--output=mcp', '--no-journal'], stateDir);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.content[0].text).toBe('FAKE_RESULT_OK');
    expect(parsed.structuredContent.status).toBe('FOUND');
  });

  it('--no-journal avoids creating a run journal', async () => {
    const stateDir = await tempStateDir();
    const result = await runCli(['fake_tool', '--no-journal'], stateDir);
    expect(result.code).toBe(0);
    await expect(readFile(join(stateDir, 'runs.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('feedback and harvest run locally without starting MCP', async () => {
    const stateDir = await tempStateDir();
    const first = await runCli(['fake_tool', '--output=json'], stateDir);
    expect(first.code).toBe(0);
    const runId = JSON.parse((await readFile(join(stateDir, 'runs.jsonl'), 'utf8')).trim()).runId;

    const feedback = await runCli(
      ['feedback', runId, '--outcome=missed', '--output=json'],
      stateDir,
      'fail-before-frame'
    );
    expect(feedback.code).toBe(0);

    const second = await runCli(['fake_tool', '--output=json'], stateDir);
    expect(second.code).toBe(0);
    const lines = (await readFile(join(stateDir, 'runs.jsonl'), 'utf8')).trim().split('\n');
    const secondRunId = JSON.parse(lines.at(-1)!).runId;
    const secondFeedback = await runCli(
      ['feedback', secondRunId, '--outcome=missed', '--output=json'],
      stateDir,
      'fail-before-frame'
    );
    expect(secondFeedback.code).toBe(0);

    const harvest = await runCli(
      ['harvest', '--since=7d', '--skill-target=outlook-mcp', '--output=json'],
      stateDir,
      'fail-before-frame'
    );
    expect(harvest.code).toBe(0);
    expect(JSON.parse(harvest.stdout).proposals).toEqual([
      expect.objectContaining({ type: 'patch_skill', target: 'outlook-mcp' }),
    ]);
  });
});
