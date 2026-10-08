import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLI = resolve('scripts/outlook.js');
const SERVER = resolve('tests/fixtures/single-attempt-mcp.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function run(mode: string, args: string[], signal?: NodeJS.Signals) {
  const dir = mkdtempSync(resolve(tmpdir(), 'outlook-single-'));
  dirs.push(dir);
  const pidPath = resolve(dir, 'pid');
  const eventsPath = resolve(dir, 'events');
  const env = {
    ...process.env,
    OUTLOOK_SERVER_ENTRY: SERVER,
    FIXTURE_MODE: mode,
    FIXTURE_PID: pidPath,
    FIXTURE_EVENTS: eventsPath,
    MICROSOFT_GRAPH_CLIENT_ID: 'fixture',
    MICROSOFT_GRAPH_CLIENT_SECRET: 'fixture',
    MICROSOFT_GRAPH_TENANT_ID: 'fixture',
    TARGET_USER_EMAIL: 'sender@example.test',
  };
  delete env.OUTLOOK_ENV_FILE;
  const cli = spawn(process.execPath, [CLI, ...args, '--no-journal'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let aliveAtOutput = false;
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (existsSync(pidPath)) aliveAtOutput ||= alive(Number(readFileSync(pidPath, 'utf8')));
  });
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise<number | null>((resolveP, rejectP) => {
    cli.once('close', resolveP);
    cli.once('error', rejectP);
  });
  const watchdog = setTimeout(() => {
    cli.kill('SIGKILL');
    if (existsSync(pidPath)) {
      try {
        process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL');
      } catch {}
    }
  }, 7000);
  try {
    if (signal) {
      for (let tries = 0; tries < 200 && !existsSync(pidPath); tries++) await delay(10);
      expect(existsSync(pidPath)).toBe(true);
      const group = (pid: number) =>
        execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      expect(group(Number(readFileSync(pidPath, 'utf8')))).toBe(group(cli.pid!));
      expect(group(cli.pid!)).toBe(group(process.pid));
      cli.kill(signal);
    }
    const code = await completion;
    const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : undefined;
    return {
      code,
      stdout,
      stderr,
      aliveAtOutput,
      alive: pid !== undefined && alive(pid),
      events: existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '',
    };
  } finally {
    clearTimeout(watchdog);
  }
}
const send = [
  'send_email',
  '--json',
  JSON.stringify({
    to: ['recipient@example.test'],
    subject: 'Fixture',
    body: 'Fixture',
    noRetry: true,
  }),
  '--output=mcp',
];

describe('CLI single-attempt server gate and lifecycle', () => {
  it.each(['old', 'malformed'])('blocks %s schemas before tools/call', async (mode) => {
    const result = await run(mode, send);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not advertise boolean');
    expect(result.events).toContain('tools/list');
    expect(result.events).not.toContain('tools/call');
    expect(result.alive).toBe(false);
  });
  it('dispatches once despite duplicate initialize/catalog/result frames and preserves MCP output', async () => {
    const result = await run('duplicate', send);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).content[0].text).toBe('FIXTURE_ACCEPTED');
    expect(result.events.match(/tools\/call/g)).toHaveLength(1);
    expect(result.aliveAtOutput).toBe(false);
    expect(result.alive).toBe(false);
  });
  it.each(['cooperative', 'resistant'])(
    'reaps %s child on normal success before output',
    async (mode) => {
      const result = await run(mode, send);
      expect(result.code).toBe(0);
      expect(result.aliveAtOutput).toBe(false);
      expect(result.alive).toBe(false);
      expect(result.events).toContain('term');
    }
  );
  it.each(['hang-cooperative', 'hang-resistant'])('reaps %s child on timeout', async (mode) => {
    const result = await run(mode, [...send, '--timeout', '300']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Timeout');
    expect(result.alive).toBe(false);
    expect(result.events).toContain('term');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it.each(['hang-cooperative', 'hang-resistant'])('reaps %s child on ' + signal, async (mode) => {
      const result = await run(mode, send, signal);
      expect(result.code).toBe(signal === 'SIGTERM' ? 143 : 130);
      expect(result.alive).toBe(false);
      expect(result.events).toContain('term');
      expect(result.stdout).toBe('');
    });
  }
  it('rejects invalid JSON before starting the MCP', async () => {
    const result = await run('cooperative', ['send_email', '--json', '{']);
    expect(result.code).toBe(1);
    expect(result.events).toBe('');
    expect(result.stderr).toContain('valid JSON object');
  });
});
