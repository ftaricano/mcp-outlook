import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GRAPH_SERVICES = [
  'mcp-outlook::MICROSOFT_GRAPH_CLIENT_ID',
  'mcp-outlook::MICROSOFT_GRAPH_CLIENT_SECRET',
  'mcp-outlook::MICROSOFT_GRAPH_TENANT_ID',
];

const SERVER_ENTRY = join(process.cwd(), 'dist', 'plugin', 'http.js');

function writeSecurityStub(root: string, logPath: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const script = `#!/bin/sh
set -eu
service="\${3:-}"
printf '%s\\n' "$service" >> "$SECURITY_LOG"
case "$service" in
  'mcp-outlook::MICROSOFT_GRAPH_CLIENT_ID') printf '%s\\n' '11111111-1111-4111-8111-111111111111' ;;
  'mcp-outlook::MICROSOFT_GRAPH_CLIENT_SECRET') printf '%s\\n' 'fixture-graph-secret' ;;
  'mcp-outlook::MICROSOFT_GRAPH_TENANT_ID') printf '%s\\n' '22222222-2222-4222-8222-222222222222' ;;
  'mcp-outlook::TARGET_USER_EMAIL') printf '%s\\n' 'retired@example.com' ;;
  *) exit 1 ;;
esac
`;
  const securityPath = join(bin, 'security');
  writeFileSync(securityPath, script, { mode: 0o700 });
  chmodSync(securityPath, 0o700);
  writeFileSync(logPath, '', { mode: 0o600 });
  return bin;
}

function writePluginConfig(root: string): string {
  const configPath = join(root, 'plugin.json');
  writeFileSync(
    configPath,
    JSON.stringify({ mailboxes: [{ alias: 'test', address: 'test@example.com' }] }),
    { mode: 0o600 }
  );
  return configPath;
}

async function waitForStartup(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`HTTP entrypoint did not start: ${stderr}`));
    }, 5_000);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!settled && stderr.includes('listening on')) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`HTTP entrypoint exited before startup: code=${code}, signal=${signal}`));
    });
  });
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('HTTP keychain bootstrap', () => {
  it('uses only Graph credential services and never restores TARGET_USER_EMAIL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-outlook-http-bootstrap-'));
    const logPath = join(root, 'security-services.log');
    const bin = writeSecurityStub(root, logPath);
    const configPath = writePluginConfig(root);
    const downloadDir = join(root, 'downloads');
    const preloadPath = join(root, 'platform.cjs');
    mkdirSync(downloadDir, { mode: 0o700 });
    writeFileSync(
      preloadPath,
      "Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });\n",
      { mode: 0o600 }
    );

    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        HOME: root,
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        NODE_OPTIONS: `--require=${preloadPath}`,
        OUTLOOK_PLUGIN_CONFIG: configPath,
        DOWNLOAD_DIR: downloadDir,
        OUTLOOK_HTTP_HOST: '127.0.0.1',
        OUTLOOK_HTTP_PORT: '0',
        OUTLOOK_KEYCHAIN_PREFIX: 'mcp-outlook',
        OUTLOOK_KEYCHAIN_QUIET: '1',
        SECURITY_LOG: logPath,
      },
    });

    try {
      await waitForStartup(child);
    } finally {
      await stop(child);
    }

    try {
      const services = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
        : [];
      expect(services).toEqual(GRAPH_SERVICES);
      expect(services).not.toContain('mcp-outlook::TARGET_USER_EMAIL');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
