#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const READ_TOOLS = [
  'list_allowed_mailboxes',
  'search_mailbox',
  'search_mailboxes',
  'get_message',
  'list_messages',
  'list_folders',
  'get_folder_stats',
  'list_attachments',
  'get_attachment_content',
  'search_mailboxes_batch',
];
const WRITE_TOOLS = [
  'download_attachments',
  'move_messages',
  'copy_messages',
  'mark_messages',
  'create_draft',
];
const HANDOFF_TOOLS = ['create_attachment_handoff', 'get_attachment_handoff'];
const READ_ONLY_TOOLS = [...READ_TOOLS, 'get_attachment_handoff'];
const DESTRUCTIVE_TOOLS = ['move_messages', 'mark_messages'];
const FORBIDDEN_TOOLS = ['send_email', 'reply_to_email', 'delete_email', 'batch_delete_emails'];

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverEntry = join(repoRoot, 'dist', 'plugin', 'stdio.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-outlook-plugin-smoke-'));
const configPath = join(temporaryRoot, 'plugin.json');
const downloadRoot = join(temporaryRoot, 'downloads');

mkdirSync(downloadRoot, { mode: 0o700 });
writeFileSync(
  configPath,
  JSON.stringify({ mailboxes: [{ alias: 'test', address: 'test@example.com' }] }),
  { mode: 0o600 }
);
chmodSync(configPath, 0o600);

async function checkScenario(allowWrites, allowLocalHandoffs, expected) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repoRoot,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MICROSOFT_GRAPH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'plugin-smoke-secret',
      MICROSOFT_GRAPH_TENANT_ID: '22222222-2222-4222-8222-222222222222',
      TARGET_USER_EMAIL: 'test@example.com',
      OUTLOOK_PLUGIN_CONFIG: configPath,
      PLUGIN_ALLOW_WRITES: String(allowWrites),
      PLUGIN_ALLOW_LOCAL_HANDOFFS: String(allowLocalHandoffs),
      DOWNLOAD_DIR: downloadRoot,
    },
  });
  const client = new Client({ name: 'plugin-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const actual = tools.map((tool) => tool.name).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(
        `allowWrites=${allowWrites}, allowLocalHandoffs=${allowLocalHandoffs}: unexpected plugin tools (${actual.length}): ${actual.join(', ')}`
      );
    }
    for (const tool of tools) {
      const shouldBeReadOnly = READ_ONLY_TOOLS.includes(tool.name);
      if (tool.annotations?.readOnlyHint !== shouldBeReadOnly) {
        throw new Error(`${tool.name}: incorrect readOnlyHint`);
      }
      const shouldBeDestructive = DESTRUCTIVE_TOOLS.includes(tool.name);
      if (tool.annotations?.destructiveHint !== shouldBeDestructive) {
        throw new Error(`${tool.name}: incorrect destructiveHint`);
      }
      if (tool.name === 'create_attachment_handoff' && tool.annotations?.idempotentHint !== true) {
        throw new Error(`${tool.name}: incorrect idempotentHint`);
      }
    }
    if (FORBIDDEN_TOOLS.some((name) => actual.includes(name))) {
      throw new Error('Plugin exposed a send or delete tool');
    }
    const result = await client.callTool({ name: 'list_allowed_mailboxes', arguments: {} });
    if (JSON.stringify(result.structuredContent) !== JSON.stringify({ mailboxes: ['test'] })) {
      throw new Error('Plugin safe read call returned unexpected output');
    }
    process.stdout.write(
      `Plugin smoke OK (allowWrites=${allowWrites}, allowLocalHandoffs=${allowLocalHandoffs}): ${actual.length} tools\n`
    );
  } finally {
    await client.close();
  }
}

try {
  await checkScenario(false, false, READ_TOOLS);
  await checkScenario(false, true, [...READ_TOOLS, ...HANDOFF_TOOLS]);
  await checkScenario(true, false, [...READ_TOOLS, ...WRITE_TOOLS]);
  await checkScenario(true, true, [...READ_TOOLS, ...WRITE_TOOLS, ...HANDOFF_TOOLS]);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
