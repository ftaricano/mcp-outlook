#!/usr/bin/env node
/**
 * Fake MCP server used by the CLI exit-handling tests. It speaks just enough
 * JSON-RPC for `outlook list` / a tool call, then simulates the production
 * shutdown behaviour that exposed the "Server exited with code 1" race.
 *
 * Mode is selected via FAKE_SERVER_MODE:
 *   success-then-fail (default) — answer initialize + the id:2 request, then
 *                                 exit NON-ZERO on SIGTERM (mimics the flaky
 *                                 real-server shutdown after a successful call)
 *   success-clean               — same, but exit 0 on SIGTERM
 *   fail-before-frame           — write a reason to stderr and exit 1 BEFORE
 *                                 answering anything (genuine startup failure)
 */

const mode = process.env.FAKE_SERVER_MODE || 'success-then-fail';

if (mode === 'fail-before-frame') {
  process.stderr.write('[fake] simulated startup failure: bad credentials\n');
  process.exit(1);
}

process.on('SIGTERM', () => {
  process.exit(mode === 'success-clean' ? 0 : 1);
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp-server', version: '0.0.0' },
        },
      });
    } else if (frame.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { tools: [{ name: 'fake_tool', description: 'a fake tool' }] },
      });
    } else if (frame.method === 'tools/call') {
      if (mode === 'structured-error') {
        // isError result that still carries structured evidence — mirrors a
        // SEARCH_UNTRUSTED/SEARCH_FAILED search that the journal must still capture.
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            content: [{ type: 'text', text: 'FAKE_SEARCH_UNTRUSTED' }],
            structuredContent: {
              status: 'SEARCH_UNTRUSTED',
              strategy: 'local_scan',
              pagesScanned: 4,
              candidatesScanned: 200,
              truncated: true,
            },
            isError: true,
          },
        });
      } else {
        const structuredContent =
          mode === 'structured-success'
            ? {
                status: 'FOUND',
                strategy: 'local_scan',
                pagesScanned: 2,
                candidatesScanned: 80,
                truncated: false,
              }
            : undefined;
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            content: [{ type: 'text', text: 'FAKE_RESULT_OK' }],
            structuredContent,
          },
        });
      }
    }
    // notifications/initialized (no id) → nothing to answer
  }
});

// Stay alive until SIGTERM arrives.
setInterval(() => {}, 1 << 30);
