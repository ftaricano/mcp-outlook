#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  'inspect_attachment_evidence',
  'investigate_documents',
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
const SEND_TOOLS = ['send_email'];
const READ_ONLY_TOOLS = [...READ_TOOLS, 'get_attachment_handoff'];
// send_email destroys nothing, but hosts read destructiveHint as 'confirm with
// the human'. Leaving it out would rank sending below marking a message read.
const DESTRUCTIVE_TOOLS = ['move_messages', 'mark_messages', 'send_email'];
// Deleting stays impossible by construction — no dispatch branch exists for it
// at any gate combination. Sending is no longer on this list because it became
// an opt-in capability, but it must still be absent unless PLUGIN_ALLOW_SEND is
// on, which the per-scenario tool-set comparison below enforces exactly.
const FORBIDDEN_TOOLS = ['reply_to_email', 'delete_email', 'batch_delete_emails', 'delete_folder'];

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

const SEND_ADDRESS = 'test@example.com';

async function checkStartupRefusal(label, sendEnv) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MICROSOFT_GRAPH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'plugin-smoke-secret',
      MICROSOFT_GRAPH_TENANT_ID: '22222222-2222-4222-8222-222222222222',
      TARGET_USER_EMAIL: SEND_ADDRESS,
      OUTLOOK_PLUGIN_CONFIG: configPath,
      PLUGIN_ALLOW_SEND: 'true',
      DOWNLOAD_DIR: downloadRoot,
      ...sendEnv,
    },
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code === 0) {
    throw new Error(`Plugin started with an incomplete send configuration: ${label}`);
  }
  process.stdout.write(`Plugin startup refusal OK (${label})\n`);
}

async function checkScenario(allowWrites, allowLocalHandoffs, allowSend, expected) {
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
      PLUGIN_ALLOW_SEND: String(allowSend),
      // Sending refuses to start without both of these; see resolveSendFromAlias.
      ...(allowSend
        ? {
            OUTLOOK_SEND_FROM: SEND_ADDRESS,
            OUTLOOK_ALLOWED_SENDERS: SEND_ADDRESS,
          }
        : {}),
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
        `allowWrites=${allowWrites}, allowLocalHandoffs=${allowLocalHandoffs}, allowSend=${allowSend}: unexpected plugin tools (${actual.length}): ${actual.join(', ')}`
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
      throw new Error('Plugin exposed a reply or delete tool');
    }
    const result = await client.callTool({ name: 'list_allowed_mailboxes', arguments: {} });
    if (JSON.stringify(result.structuredContent) !== JSON.stringify({ mailboxes: ['test'] })) {
      throw new Error('Plugin safe read call returned unexpected output');
    }
    process.stdout.write(
      `Plugin smoke OK (allowWrites=${allowWrites}, allowLocalHandoffs=${allowLocalHandoffs}, allowSend=${allowSend}): ${actual.length} tools\n`
    );
  } finally {
    await client.close();
  }
}

try {
  await checkScenario(false, false, false, READ_TOOLS);
  await checkScenario(false, true, false, [...READ_TOOLS, ...HANDOFF_TOOLS]);
  await checkScenario(true, false, false, [...READ_TOOLS, ...WRITE_TOOLS]);
  await checkScenario(true, true, false, [...READ_TOOLS, ...WRITE_TOOLS, ...HANDOFF_TOOLS]);
  // Sending is independent of the other two gates: it must appear with each of
  // them and, above all, must never appear without its own.
  await checkScenario(false, false, true, [...READ_TOOLS, ...SEND_TOOLS]);
  await checkScenario(false, true, true, [...READ_TOOLS, ...HANDOFF_TOOLS, ...SEND_TOOLS]);
  await checkScenario(true, false, true, [...READ_TOOLS, ...WRITE_TOOLS, ...SEND_TOOLS]);
  await checkScenario(true, true, true, [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    ...HANDOFF_TOOLS,
    ...SEND_TOOLS,
  ]);
  // The strongest claim this plugin makes about sending is that it refuses to
  // START when the gate is on but the sender is not fully pinned. Unit tests
  // cover loadPluginConfig; only this proves the process actually dies.
  await checkStartupRefusal('gate on, no sending mailbox', { OUTLOOK_ALLOWED_SENDERS: SEND_ADDRESS });
  await checkStartupRefusal('gate on, no outbound allowlist', { OUTLOOK_SEND_FROM: SEND_ADDRESS });
  await checkStartupRefusal('sending mailbox not in the plugin allowlist', {
    OUTLOOK_SEND_FROM: 'stranger@example.com',
    OUTLOOK_ALLOWED_SENDERS: 'stranger@example.com',
  });
  await checkStartupRefusal('sending mailbox not covered by the outbound allowlist', {
    OUTLOOK_SEND_FROM: SEND_ADDRESS,
    OUTLOOK_ALLOWED_SENDERS: 'stranger@example.com',
  });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
