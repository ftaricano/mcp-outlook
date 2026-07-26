#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutlookPluginServer } from '../dist/plugin/createPluginServer.js';

const mailbox = { alias: 'test', address: 'test@example.com' };
const config = {
  mailboxes: [mailbox],
  mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
  maxConcurrentMailboxes: 1,
  maxMailboxesPerSearch: 1,
  maxResultsPerMailbox: 5,
  maxBodyChars: 100,
};
const service = {
  listAllowedMailboxes: () => ['test'],
};
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createOutlookPluginServer(service, config);
const client = new Client({ name: 'plugin-smoke', version: '1.0.0' });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const expected = ['list_allowed_mailboxes', 'search_mailbox', 'search_mailboxes', 'get_message'];
  const actual = tools.map((tool) => tool.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected plugin tools: ${actual.join(', ')}`);
  }
  process.stdout.write(`Plugin smoke OK: ${actual.length} read-only tools\n`);
} finally {
  await client.close();
  await server.close();
}
