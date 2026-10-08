import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

let root: string;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'outlook-capabilities-'));
  for (const path of ['scripts', 'dist', 'package.json', 'package-lock.json'])
    cpSync(resolve(path), resolve(root, path), { recursive: true });
  symlinkSync(resolve('node_modules'), resolve(root, 'node_modules'));
  // A probe must neither import startup config nor start the server.
  writeFileSync(
    resolve(root, 'dist/config/keychain.js'),
    "throw new Error('Unexpected keychain bootstrap');\n"
  );
  writeFileSync(resolve(root, 'dist/index.js'), "throw new Error('Unexpected MCP startup');\n");
  writeFileSync(resolve(root, '.env'), 'OUTLOOK_SERVER_ENTRY=unexpected-fixture-entry\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function probe(extra: Record<string, string> = {}, args = ['capabilities', '--output=json']) {
  const env = { ...process.env, ...extra };
  for (const key of [
    'OUTLOOK_SERVER_ENTRY',
    'OUTLOOK_ENV_FILE',
    'MICROSOFT_GRAPH_CLIENT_ID',
    'MICROSOFT_GRAPH_CLIENT_SECRET',
    'MICROSOFT_GRAPH_TENANT_ID',
    'TARGET_USER_EMAIL',
  ])
    if (!(key in extra)) delete env[key];
  return spawnSync(process.execPath, ['--', resolve(root, 'scripts/outlook.js'), ...args], {
    env,
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 5000,
  });
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('offline built-installation capabilities', () => {
  it('emits pinned installation/schema/dependency identity without credentials or bootstrap', () => {
    const result = probe();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const data = JSON.parse(result.stdout);
    expect(data.contractVersion).toBe(1);
    expect(data.send_email).toEqual({
      noRetry: true,
      attemptLimit: 1,
      maxRetries: 0,
      maxRedirects: 0,
    });
    expect(data.childCleanup).toEqual({
      supported: true,
      signals: ['SIGTERM', 'SIGINT'],
      graceMs: 1000,
      inheritedProcessGroup: true,
    });
    expect(data.installation.cliSha256).toBe(hash(resolve(root, 'scripts/outlook.js')));
    expect(data.installation.packageSha256).toBe(hash(resolve(root, 'package.json')));
    expect(data.installation.lockfileSha256).toBe(hash(resolve(root, 'package-lock.json')));
    for (const name of [
      'cliSupportSha256',
      'serverSha256',
      'schemaSha256',
      'buildSha256',
      'graphSdkSha256',
    ])
      expect(data.installation[name]).toMatch(/^[a-f0-9]{64}$/);
    expect(data.installation.graphSdkVersion).toBe('3.0.7');
  });
  it('keeps a package without an npm-excluded lock usable and declares null provenance', () => {
    rmSync(resolve(root, 'package-lock.json'));
    const result = probe();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).installation.lockfileSha256).toBeNull();
  });
  it.each(['OUTLOOK_SERVER_ENTRY', 'OUTLOOK_ENV_FILE'])(
    'refuses %s selectors before probing',
    (key) => {
      const result = probe({ [key]: resolve(root, 'nonexistent') });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('no server or environment selectors');
    }
  );
  it.each([
    { args: ['capabilities', '--output=json', '--env-file', 'fixture.env'] },
    { args: ['capabilities', '--output=json', '--timeout', '1'] },
    { args: ['capabilities', '--output=mcp'] },
    { args: ['capabilities', '--output=json', '--help'] },
  ])('refuses alternate probe arguments %j', ({ args }) => {
    const result = probe({}, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
  it('refuses missing built schemas', () => {
    rmSync(resolve(root, 'dist/schemas/jsonSchemaFromZod.js'));
    const result = probe();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unavailable');
  });
  it('refuses an old built send schema', () => {
    writeFileSync(
      resolve(root, 'dist/schemas/jsonSchemaFromZod.js'),
      "export const getToolSchemas = () => [{ name: 'send_email', inputSchema: { properties: {} } }];\n"
    );
    expect(probe().status).toBe(1);
  });
  it('detects built tree drift', () => {
    const before = JSON.parse(probe().stdout).installation.buildSha256;
    writeFileSync(resolve(root, 'dist/offline-fixture.txt'), 'Fixture');
    expect(JSON.parse(probe().stdout).installation.buildSha256).not.toBe(before);
  });
});
