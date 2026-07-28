#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutlookPluginServer } from '../dist/plugin/createPluginServer.js';

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

const mailbox = { alias: 'test', address: 'test@example.com' };

function buildConfig(allowWrites) {
  return {
    mailboxes: [mailbox],
    mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
    maxConcurrentMailboxes: 1,
    maxMailboxesPerSearch: 1,
    maxResultsPerMailbox: 5,
    maxBodyChars: 100,
    allowWrites,
    maxAttachmentInputBytes: 15 * 1024 * 1024,
    maxExtractedChars: 200_000,
    maxRawAttachmentBytes: 256 * 1024,
    maxBatchSize: 25,
    maxQueriesPerBatch: 10,
    maxZipEntries: 200,
    maxZipUncompressedBytes: 50 * 1024 * 1024,
  };
}

const service = { listAllowedMailboxes: () => ['test'] };

async function checkScenario(allowWrites, expected) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOutlookPluginServer(service, buildConfig(allowWrites), '2.3.0');
  const client = new Client({ name: 'plugin-smoke', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const actual = tools.map((tool) => tool.name).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(
        `allowWrites=${allowWrites}: unexpected plugin tools (${actual.length}): ${actual.join(', ')}`
      );
    }
    process.stdout.write(`Plugin smoke OK (allowWrites=${allowWrites}): ${actual.length} tools\n`);
  } finally {
    await client.close();
    await server.close();
  }
}

await checkScenario(false, READ_TOOLS);
await checkScenario(true, [...READ_TOOLS, ...WRITE_TOOLS]);
