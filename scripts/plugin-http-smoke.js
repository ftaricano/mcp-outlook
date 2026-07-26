#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startOutlookHttpServer } from '../dist/plugin/http.js';

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

  if (tools.length !== 4) throw new Error(`Expected 4 tools, received ${tools.length}`);
  if (JSON.stringify(result.structuredContent) !== JSON.stringify({ mailboxes: ['test'] })) {
    throw new Error('Unexpected list_allowed_mailboxes result');
  }
  process.stdout.write('Plugin HTTP smoke OK: authenticated MCP round-trip\n');
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
