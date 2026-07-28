import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { PluginConfig } from '../../src/plugin/config.js';
import type { MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';
import {
  createOutlookHttpApp,
  isExecutedAsMain,
  startOutlookHttpServer,
} from '../../src/plugin/http.js';

const servers: Server[] = [];

function dependencies() {
  const mailbox = { alias: 'finance', address: 'finance@example.com' } as const;
  const config: PluginConfig = {
    mailboxes: [mailbox],
    mailboxesByAlias: new Map([[mailbox.alias, mailbox]]),
    maxConcurrentMailboxes: 1,
    maxMailboxesPerSearch: 1,
    maxResultsPerMailbox: 10,
    maxBodyChars: 100,
    allowWrites: false,
    maxAttachmentInputBytes: 15 * 1024 * 1024,
    maxExtractedChars: 200_000,
    maxRawAttachmentBytes: 256 * 1024,
    maxConcurrentExtractions: 2,
    maxBatchSize: 25,
    maxQueriesPerBatch: 10,
    maxZipEntries: 200,
    maxZipUncompressedBytes: 50 * 1024 * 1024,
    searchMemoryPath: undefined,
  };
  const service = {
    listAllowedMailboxes: () => ['finance'],
  } as unknown as MultiMailboxService;
  return { config, service };
}

async function start(bearerToken?: string) {
  const server = await startOutlookHttpServer(dependencies(), {
    host: '127.0.0.1',
    port: 0,
    bearerToken,
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

describe('Outlook plugin HTTP server', () => {
  it('recognizes an entrypoint path containing spaces', () => {
    const path = '/tmp/outlook plugin/dist/plugin/http.js';
    expect(isExecutedAsMain(pathToFileURL(path).href, path)).toBe(true);
  });

  it('refuses non-loopback binding', () => {
    expect(() => createOutlookHttpApp(dependencies(), { host: '0.0.0.0' })).toThrow(
      /loopback-only/i
    );
  });

  it('returns a metadata-only health response', async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'mcp-outlook-plugin',
      version: '2.3.0',
    });
  });

  it('rejects a missing or invalid bearer before MCP body handling', async () => {
    const baseUrl = await start('test-token');
    const missing = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid-json',
    });
    const invalid = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      body: '{invalid-json',
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it('returns redacted JSON-RPC errors for malformed and oversized authenticated bodies', async () => {
    const baseUrl = await start('test-token');
    const headers = {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: '{invalid-json',
    });
    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
    });

    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/json');
    expect(await malformed.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('content-type')).toContain('application/json');
    expect(await oversized.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large' },
      id: null,
    });
  });

  it('completes an authenticated MCP initialize, tools/list, and tool call', async () => {
    const baseUrl = await start('test-token');
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: 'Bearer test-token',
        },
      },
    });
    const client = new Client({ name: 'http-test-client', version: '1.0.0' });

    await client.connect(transport);
    const { tools } = await client.listTools();
    const result = await client.callTool({
      name: 'list_allowed_mailboxes',
      arguments: {},
    });
    await client.close();

    expect(tools).toHaveLength(10);
    expect(result.structuredContent).toEqual({ mailboxes: ['finance'] });
  });
});
