import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutlookPluginServer } from '../../src/plugin/createPluginServer.js';
import type { PluginConfig } from '../../src/plugin/config.js';
import type { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';

const openClients: Client[] = [];

function pluginConfig(): PluginConfig {
  const mailbox = { alias: 'finance', address: 'finance@example.com' } as const;
  return {
    mailboxes: [mailbox],
    mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
    maxConcurrentMailboxes: 1,
    maxMailboxesPerSearch: 1,
    maxResultsPerMailbox: 20,
    maxBodyChars: 12,
  };
}

function fakeService(): MultiMailboxService {
  return {
    listAllowedMailboxes: () => ['finance'],
    searchMailbox: async () => ({
      mailbox: 'finance',
      status: 'FOUND',
      strategy: 'local_scan',
      confidence: 'high',
      messages: [
        {
          id: 'message-1',
          subject: 'Invoice',
          body: { content: 'secret body must not be returned by search' },
          bodyPreview: 'preview',
          from: { emailAddress: { address: 'sender@example.com' } },
        },
      ],
      pagesScanned: 2,
      candidatesScanned: 5,
      truncated: false,
      canaryMatched: false,
      warnings: [],
    }),
    searchMailboxes: async () => ({
      status: 'FOUND',
      results: [
        {
          mailbox: 'finance',
          status: 'FOUND',
          strategy: 'local_scan',
          confidence: 'high',
          messages: [{ id: 'message-1', subject: 'Invoice' }],
          pagesScanned: 1,
          candidatesScanned: 1,
          truncated: false,
          canaryMatched: false,
          warnings: [],
        },
      ],
    }),
    getMessage: async () => ({
      id: 'message-1',
      subject: 'Invoice',
      body: { content: '1234567890abcdef', contentType: 'text' },
    }),
  } as unknown as MultiMailboxService;
}

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOutlookPluginServer(fakeService(), pluginConfig());
  const client = new Client({ name: 'plugin-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client, server };
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe('createOutlookPluginServer', () => {
  it('exposes exactly four physically read-only tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'list_allowed_mailboxes',
      'search_mailbox',
      'search_mailboxes',
      'get_message',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it('removes full bodies from search results', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'search_mailbox',
      arguments: {
        mailbox: 'finance',
        criteria: { query: 'invoice' },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      'secret body must not be returned'
    );
    expect(result.structuredContent).toMatchObject({
      mailbox: 'finance',
      status: 'FOUND',
      messages: [{ id: 'message-1', bodyPreview: 'preview' }],
    });
  });

  it('truncates message bodies according to server policy', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'get_message',
      arguments: {
        mailbox: 'finance',
        messageId: 'message-1',
      },
    });

    expect(result.structuredContent).toMatchObject({
      mailbox: 'finance',
      message: {
        id: 'message-1',
        body: '1234567890ab...',
      },
    });
  });
});
