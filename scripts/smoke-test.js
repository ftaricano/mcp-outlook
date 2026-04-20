#!/usr/bin/env node
/**
 * Smoke test: spawns the built MCP server over stdio, sends `tools/list`,
 * verifies the response includes the expected tools, then shuts it down.
 *
 * Does NOT require real Graph credentials — fake-but-well-formed UUIDs
 * satisfy env validation. The server will fail Graph requests but will
 * still respond to `tools/list` via the MCP handshake because that is
 * pure metadata.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverEntry = resolve(repoRoot, 'dist/index.js');
const lockFile = resolve(repoRoot, 'mcp-server.lock');

const EXPECTED_TOOL_COUNT = 39;
const TIMEOUT_MS = 15_000;

function log(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

async function main() {
  if (!fs.existsSync(serverEntry)) {
    log(`build missing at ${serverEntry} — run "npm run build" first`);
    process.exit(2);
  }

  // Clear any stale lock from a previous run
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* nothing to clean up */
  }

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      MICROSOFT_GRAPH_CLIENT_ID: '11111111-1111-1111-1111-111111111111',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'smoke-test-secret',
      MICROSOFT_GRAPH_TENANT_ID: '22222222-2222-2222-2222-222222222222',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let resolved = false;
  const received = new Map();

  const cleanup = (code) => {
    if (resolved) return;
    resolved = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* fine */
    }
    process.exit(code);
  };

  const timer = setTimeout(() => {
    log(`timeout after ${TIMEOUT_MS}ms — server did not respond`);
    cleanup(1);
  }, TIMEOUT_MS);

  child.stderr.on('data', (chunk) => {
    // Server chatter — ignore unless debugging
    if (process.env.SMOKE_DEBUG) process.stderr.write(chunk);
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    // Parse newline-delimited JSON-RPC frames
    let newlineIdx;
    while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        log(`non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      if (frame.id != null) received.set(frame.id, frame);
      handleFrame(frame);
    }
  });

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`);
    cleanup(1);
  });

  child.on('exit', (code, signal) => {
    if (!resolved) {
      log(`server exited prematurely (code=${code}, signal=${signal})`);
      cleanup(1);
    }
  });

  function send(message) {
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function handleFrame(frame) {
    if (frame.id === 1 && frame.result) {
      log('initialize: ok');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (frame.id === 2) {
      if (frame.error) {
        log(`tools/list error: ${JSON.stringify(frame.error)}`);
        clearTimeout(timer);
        return cleanup(1);
      }
      const tools = frame.result?.tools ?? [];
      log(`tools/list: received ${tools.length} tools`);
      const names = new Set(tools.map((t) => t.name));
      const required = [
        'list_emails',
        'send_email',
        'reply_to_email',
        'mark_as_read',
        'download_attachment',
        'advanced_search',
        'batch_delete_emails',
        'email_cleanup_wizard',
      ];
      const missing = required.filter((n) => !names.has(n));
      if (tools.length !== EXPECTED_TOOL_COUNT) {
        log(`expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
        clearTimeout(timer);
        return cleanup(1);
      }
      if (missing.length) {
        log(`missing required tools: ${missing.join(', ')}`);
        clearTimeout(timer);
        return cleanup(1);
      }
      // Verify every schema has the expected shape
      const malformed = tools.filter(
        (t) => !t.name || typeof t.description !== 'string' || t.inputSchema?.type !== 'object'
      );
      if (malformed.length) {
        log(`${malformed.length} tools have malformed schemas`);
        clearTimeout(timer);
        return cleanup(1);
      }
      log(`PASS: ${tools.length} tools registered, all schemas well-formed`);
      clearTimeout(timer);
      cleanup(0);
    }
  }

  // Kick off the MCP handshake
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    },
  });
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
