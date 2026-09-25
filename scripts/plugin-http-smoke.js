#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOutlookHttpServer } from '../dist/plugin/http.js';

const mailbox = { alias: 'test', address: 'test@example.com' };
const config = {
  mailboxes: [mailbox],
  mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
  maxConcurrentMailboxes: 1,
  maxMailboxesPerSearch: 1,
  maxResultsPerMailbox: 5,
  maxBodyChars: 100,
  allowWrites: true,
  allowLocalHandoffs: true,
  allowSend: true,
  sendFromAlias: 'test',
  maxAttachmentInputBytes: 15 * 1024 * 1024,
  maxExtractedChars: 200_000,
  maxRawAttachmentBytes: 256 * 1024,
  maxBatchSize: 25,
  maxDownloadBatchBytes: 50 * 1024 * 1024,
  maxHandoffAttachmentBytes: 25 * 1024 * 1024,
  maxHandoffStoreBytes: 500 * 1024 * 1024,
  maxHandoffStoreEntries: 1_000,
  maxQueriesPerBatch: 10,
  maxBatchResultMessages: 500,
  maxBatchResultBytes: 2 * 1024 * 1024,
  maxBatchContextChars: 500_000,
  maxBatchAttachments: 1_000,
  maxZipEntries: 200,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
  maxContainerEntries: 1_000,
  maxContainerUncompressedBytes: 100 * 1024 * 1024,
};
const service = {
  listAllowedMailboxes: () => ['test'],
};
const bearerToken = 'plugin-http-smoke-token';
const server = await startOutlookHttpServer(
  { service, config },
  { host: '127.0.0.1', port: 0, bearerToken }
);
const address = server.address();

try {
  if (!address || typeof address === 'string') throw new Error('HTTP smoke did not bind a port');
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    }
  );
  const client = new Client({ name: 'plugin-http-smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const result = await client.callTool({
    name: 'list_allowed_mailboxes',
    arguments: {},
  });
  await client.close();

  if (tools.length !== 12) throw new Error(`Expected 12 tools, received ${tools.length}`);
  if (JSON.stringify(result.structuredContent) !== JSON.stringify({ mailboxes: ['test'] })) {
    throw new Error('Unexpected list_allowed_mailboxes result');
  }
  process.stdout.write('Plugin HTTP smoke OK: authenticated MCP round-trip\n');
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

// The entrypoint must refuse to serve /mcp without a bearer token unless the
// operator opts out explicitly, and must not read a misspelled opt-out as "on".
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const httpEntry = join(repoRoot, 'dist', 'plugin', 'http.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-outlook-http-smoke-'));
const configPath = join(temporaryRoot, 'plugin.json');
writeFileSync(
  configPath,
  JSON.stringify({ mailboxes: [{ alias: 'test', address: 'test@example.com' }] }),
  { mode: 0o600 }
);
chmodSync(configPath, 0o600);

function runEntrypoint(extraEnv) {
  const child = spawn(process.execPath, [httpEntry], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MICROSOFT_GRAPH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'plugin-http-smoke-secret',
      MICROSOFT_GRAPH_TENANT_ID: '22222222-2222-4222-8222-222222222222',
      TARGET_USER_EMAIL: 'test@example.com',
      OUTLOOK_PLUGIN_CONFIG: configPath,
      OUTLOOK_HTTP_PORT: '0',
      ...extraEnv,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('HTTP entrypoint did not start or exit within 15s'));
    }, 15_000);
    child.stderr.on('data', () => {
      if (stderr.includes('listening on')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolvePromise({ started: true, stderr });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ started: stderr.includes('listening on'), code, stderr });
    });
  });
}

try {
  for (const [label, env, pattern] of [
    ['no bearer token', {}, /requires a bearer token/],
    ['blank bearer token', { OUTLOOK_HTTP_BEARER_TOKEN: '   ' }, /requires a bearer token/],
    ['misspelled opt-out', { OUTLOOK_HTTP_ALLOW_NO_AUTH: 'yes please' }, /must be a boolean/],
  ]) {
    const outcome = await runEntrypoint(env);
    if (outcome.started || outcome.code === 0 || !pattern.test(outcome.stderr)) {
      throw new Error(`HTTP entrypoint did not refuse to start: ${label}`);
    }
    process.stdout.write(`Plugin HTTP startup refusal OK (${label})\n`);
  }

  const optedOut = await runEntrypoint({ OUTLOOK_HTTP_ALLOW_NO_AUTH: 'true' });
  if (!optedOut.started || !/without a bearer token/.test(optedOut.stderr)) {
    throw new Error('HTTP entrypoint did not start, or did not warn, with the explicit opt-out');
  }
  process.stdout.write('Plugin HTTP explicit no-auth opt-out OK (starts with a warning)\n');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
