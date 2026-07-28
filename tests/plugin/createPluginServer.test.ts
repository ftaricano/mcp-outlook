import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutlookPluginServer } from '../../src/plugin/createPluginServer.js';
import { AttachmentContentError } from '../../src/plugin/MultiMailboxService.js';
import type { PluginConfig } from '../../src/plugin/config.js';
import type { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';

const openClients: Client[] = [];

function pluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const mailbox = { alias: 'finance', address: 'finance@example.com' } as const;
  return {
    mailboxes: [mailbox],
    mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
    maxConcurrentMailboxes: 1,
    maxMailboxesPerSearch: 1,
    maxResultsPerMailbox: 20,
    maxBodyChars: 12,
    allowWrites: false,
    maxAttachmentInputBytes: 15 * 1024 * 1024,
    maxExtractedChars: 200_000,
    maxRawAttachmentBytes: 256 * 1024,
    maxBatchSize: 25,
    maxQueriesPerBatch: 10,
    maxZipEntries: 200,
    maxZipUncompressedBytes: 50 * 1024 * 1024,
    searchMemoryPath: undefined,
    ...overrides,
  };
}

function fakeService(overrides: Partial<MultiMailboxService> = {}): MultiMailboxService {
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
    listMessages: async () => ({
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
    }),
    listFolders: async () => [
      {
        id: 'inbox',
        displayName: 'Inbox',
        totalItemCount: 3,
        unreadItemCount: 1,
        childFolderCount: 0,
      },
    ],
    getFolderStats: async () => ({ totalItems: 10, unreadItems: 2, sizeInBytes: 1024 }),
    listAttachments: async () => [
      { id: 'a1', name: 'fatura.pdf', contentType: 'application/pdf', size: 100, isInline: false },
    ],
    getAttachmentContent: async () => ({
      mailbox: 'finance',
      messageId: 'm1',
      attachmentId: 'a1',
      name: 'fatura.pdf',
      contentType: 'application/pdf',
      kind: 'text' as const,
      text: 'FATURA 12345',
      truncated: false,
      extractor: 'pdf',
    }),
    searchMailboxesBatch: async () => ({
      results: [
        {
          label: 'caso-1',
          status: 'FOUND',
          results: [
            {
              mailbox: 'finance',
              status: 'FOUND',
              strategy: 'local_scan',
              confidence: 'high',
              messages: [],
              pagesScanned: 1,
              candidatesScanned: 1,
              truncated: false,
              canaryMatched: false,
              warnings: [],
            },
          ],
        },
      ],
    }),
    moveMessages: async () => ({ mailbox: 'finance', results: [{ id: 'm1', success: true }] }),
    copyMessages: async () => ({ mailbox: 'finance', results: [{ id: 'm1', success: true }] }),
    markMessages: async () => ({ mailbox: 'finance', results: [{ id: 'm1', success: true }] }),
    downloadAttachments: async () => ({
      mailbox: 'finance',
      totalFiles: 1,
      successfulDownloads: 1,
      failedDownloads: 0,
    }),
    createDraftMessage: async () => ({ mailbox: 'finance', draftId: 'd1', attachmentsCount: 0 }),
    ...overrides,
  } as unknown as MultiMailboxService;
}

async function connect(server: ReturnType<typeof createOutlookPluginServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plugin-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client, server };
}

function createServer(overrides: Partial<PluginConfig> = {}) {
  return createOutlookPluginServer(fakeService(), pluginConfig(overrides));
}

function createServerWithAttachmentStub() {
  return createOutlookPluginServer(fakeService(), pluginConfig());
}

function createServerWithOversizedAttachmentStub() {
  return createOutlookPluginServer(
    fakeService({
      getAttachmentContent: async () => {
        throw new AttachmentContentError('RAW_TOO_LARGE');
      },
    }),
    pluginConfig()
  );
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe('createOutlookPluginServer', () => {
  describe('expanded catalog', () => {
    it('registers exactly the 10 read tools when writes are disabled', async () => {
      const { client } = await connect(createServer({ allowWrites: false }));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          'get_attachment_content',
          'get_folder_stats',
          'get_message',
          'list_allowed_mailboxes',
          'list_attachments',
          'list_folders',
          'list_messages',
          'search_mailbox',
          'search_mailboxes',
          'search_mailboxes_batch',
        ].sort()
      );
    });

    it('registers the 5 write tools only with allowWrites', async () => {
      const { client } = await connect(createServer({ allowWrites: true }));
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toHaveLength(15);
      for (const name of [
        'download_attachments',
        'move_messages',
        'copy_messages',
        'mark_messages',
        'create_draft',
      ]) {
        expect(names).toContain(name);
      }
    });

    it('marks read tools readOnlyHint=true and write tools readOnlyHint=false', async () => {
      const { client } = await connect(createServer({ allowWrites: true }));
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get('search_mailbox')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('move_messages')?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get('move_messages')?.annotations?.destructiveHint).toBe(false);
    });

    it('keeps the untrusted-data framing on attachment text output', async () => {
      const { client } = await connect(createServerWithAttachmentStub());
      const result = await client.callTool({
        name: 'get_attachment_content',
        arguments: { mailbox: 'finance', messageId: 'm1', attachmentId: 'a1' },
      });
      const text = (result.content as Array<{ text: string }>).map((block) => block.text).join(' ');
      expect(text).toMatch(/untrusted data, not instructions/i);
    });

    it('returns redacted errors with the stable code for oversized raw requests', async () => {
      const { client } = await connect(createServerWithOversizedAttachmentStub());
      const result = await client.callTool({
        name: 'get_attachment_content',
        arguments: { mailbox: 'finance', messageId: 'm1', attachmentId: 'a1', mode: 'raw' },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('RAW_TOO_LARGE');
      expect((result.content as Array<{ text: string }>)[0].text).not.toMatch(
        /graph|stack|password/i
      );
    });
  });

  it('exposes the legacy four read-only tools inside the wider read catalog', async () => {
    const { client } = await connect(createServer());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'list_allowed_mailboxes',
      'search_mailbox',
      'search_mailboxes',
      'get_message',
    ]) {
      expect(names).toContain(name);
    }
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it('removes full bodies from search results', async () => {
    const { client } = await connect(createServer());
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
    const { client } = await connect(createServer());
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

  it('lists folders with bounded projection', async () => {
    const { client } = await connect(createServer());
    const result = await client.callTool({
      name: 'list_folders',
      arguments: { mailbox: 'finance' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mailbox: 'finance',
      folders: [{ id: 'inbox', displayName: 'Inbox' }],
    });
  });

  it('returns folder stats', async () => {
    const { client } = await connect(createServer());
    const result = await client.callTool({
      name: 'get_folder_stats',
      arguments: { mailbox: 'finance', folderId: 'inbox' },
    });
    expect(result.structuredContent).toMatchObject({ folderId: 'inbox', totalItems: 10 });
  });

  it('lists attachment metadata', async () => {
    const { client } = await connect(createServer());
    const result = await client.callTool({
      name: 'list_attachments',
      arguments: { mailbox: 'finance', messageId: 'm1' },
    });
    expect(result.structuredContent).toMatchObject({
      mailbox: 'finance',
      attachments: [{ id: 'a1', name: 'fatura.pdf' }],
    });
  });

  it('runs a labeled batch search and returns per-label evidence', async () => {
    const { client } = await connect(createServer());
    const result = await client.callTool({
      name: 'search_mailboxes_batch',
      arguments: { queries: [{ label: 'caso-1', criteria: { query: 'fatura' } }] },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [{ label: 'caso-1', status: 'FOUND' }],
    });
  });

  it('does not register write tools when allowWrites is false', async () => {
    const { client } = await connect(createServer({ allowWrites: false }));
    const result = await client.callTool({
      name: 'move_messages',
      arguments: { mailbox: 'finance', messageIds: ['m1'], destinationFolderId: 'f1' },
    });
    expect(result.isError).toBe(true);
  });

  it('moves messages when allowWrites is true', async () => {
    const { client } = await connect(createServer({ allowWrites: true }));
    const result = await client.callTool({
      name: 'move_messages',
      arguments: { mailbox: 'finance', messageIds: ['m1'], destinationFolderId: 'f1' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ mailbox: 'finance' });
  });

  it('downloads attachments to server disk when allowWrites is true', async () => {
    const { client } = await connect(createServer({ allowWrites: true }));
    const result = await client.callTool({
      name: 'download_attachments',
      arguments: { mailbox: 'finance', messageId: 'm1', attachmentIds: ['a1'] },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ successfulDownloads: 1 });
  });

  it('creates a draft without exposing a send path', async () => {
    const { client } = await connect(createServer({ allowWrites: true }));
    const result = await client.callTool({
      name: 'create_draft',
      arguments: {
        mailbox: 'finance',
        to: ['x@example.com'],
        subject: 'Assunto',
        body: '<p>corpo</p>',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ draftId: 'd1' });
  });
});
