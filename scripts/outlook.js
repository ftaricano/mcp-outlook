#!/usr/bin/env node
/**
 * outlook CLI — one-shot caller for the mcp-outlook MCP server.
 *
 * Usage:
 *   outlook list                           # list all 40 tools with descriptions
 *   outlook schema <tool>                  # show a tool's input schema
 *   outlook <tool> [--key=value ...]       # call a tool via individual flags
 *   outlook <tool> --json '{"k":"v"}'     # call a tool with a raw JSON args object
 *
 * Flags (can appear anywhere):
 *   --env-file <path>   Load credentials from this .env file
 *   --timeout <ms>      Max wait for server response (default: 30000)
 *   --compact           Print raw JSON instead of human-readable text
 *   --help, -h          Show this help
 *
 * Credentials are resolved in this order:
 *   1. --env-file <path> flag
 *   2. $OUTLOOK_ENV_FILE env var
 *   3. <repo-root>/.env   (same directory as this script's parent)
 *   4. Environment variables already set (MICROSOFT_GRAPH_CLIENT_ID, etc.)
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = resolve(REPO_ROOT, 'dist/index.js');

const KEYCHAIN_BOOTSTRAP = resolve(REPO_ROOT, 'dist/config/keychain.js');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const raw = argv.slice(2);
  const opts = {
    envFile: null,
    timeout: 30_000,
    compact: false,
    help: false,
    command: null,   // 'list' | 'schema' | <tool-name>
    schemaTarget: null,
    jsonPayload: null,
    toolArgs: {},
  };

  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    if (a === '--help' || a === '-h') {
      opts.help = true; i++; continue;
    }
    if (a === '--compact') { opts.compact = true; i++; continue; }
    if (a === '--env-file') { opts.envFile = raw[++i]; i++; continue; }
    if (a === '--timeout') { opts.timeout = Number(raw[++i]); i++; continue; }
    if (a === '--json') {
      opts.jsonPayload = raw[++i]; i++; continue;
    }
    if (a.startsWith('--')) {
      // --key=value or --key value
      const eqIdx = a.indexOf('=');
      let key, val;
      if (eqIdx !== -1) {
        key = a.slice(2, eqIdx);
        val = a.slice(eqIdx + 1);
      } else {
        key = a.slice(2);
        val = raw[i + 1] && !raw[i + 1].startsWith('--') ? raw[++i] : 'true';
      }
      opts.toolArgs[key] = coerce(val);
      i++; continue;
    }
    // Positional
    if (!opts.command) { opts.command = a; i++; continue; }
    if (opts.command === 'schema' && !opts.schemaTarget) {
      opts.schemaTarget = a; i++; continue;
    }
    i++;
  }
  return opts;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  const n = Number(v);
  if (!isNaN(n) && v.trim() !== '') return n;
  // Try JSON for arrays/objects passed as a flag value
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
    try { return JSON.parse(v); } catch { /* fall through */ }
  }
  return v;
}

// ---------------------------------------------------------------------------
// .env loader (manual, no dependency on dotenv module path resolution)
// ---------------------------------------------------------------------------

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`
outlook — one-shot CLI for mcp-outlook (40 Microsoft Graph email tools)

Usage:
  outlook list                           List all 40 tools with descriptions
  outlook schema <tool>                  Show a tool's input schema
  outlook <tool> [--key=value ...]       Call a tool with individual flags
  outlook <tool> --json '<JSON>'         Call a tool with a raw JSON args object

Examples:
  outlook list
  outlook schema list_emails
  outlook list_emails --limit=5 --folder=inbox
  outlook send_email --to='["a@b.com"]' --subject="Hi" --body="Hello"
  outlook create_draft --to='["a@b.com"]' --subject="Draft" --body="Hello"
  outlook advanced_search --query="invoice" --hasAttachments=true --maxResults=10
  outlook batch_mark_as_read --json '{"emailIds":["id1","id2"]}'
  outlook list_folders --includeSubfolders=true

Flags:
  --env-file <path>   Load credentials from this .env file
  --timeout <ms>      Response timeout in ms (default: 30000)
  --compact           Raw JSON output instead of human-readable text
  --help, -h          Show this help

Credentials (env vars or .env file):
  MICROSOFT_GRAPH_CLIENT_ID
  MICROSOFT_GRAPH_CLIENT_SECRET
  MICROSOFT_GRAPH_TENANT_ID
  TARGET_USER_EMAIL

Repo: ${REPO_ROOT}
`.trimStart());
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    die(`Server not built. Run: cd ${REPO_ROOT} && npm run build`);
  }
  return spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function die(msg, code = 1) {
  process.stderr.write(`[outlook] ${msg}\n`);
  process.exit(code);
}

async function runMcp({ command, schemaTarget, toolArgs, jsonPayload, timeout, compact }) {
  const child = startServer();
  let buf = '';
  let idCounter = 1;
  let timer;

  return new Promise((resolve) => {
    const responses = new Map();

    timer = setTimeout(() => {
      child.kill();
      die(`Timeout after ${timeout}ms — is the server built and credentials set?`);
    }, timeout);

    child.stderr.on('data', () => {}); // suppress server logs

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id != null) responses.set(frame.id, frame);
        onFrame(frame);
      }
    });

    child.on('error', (err) => die(`Spawn error: ${err.message}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        // Non-zero exit before we resolved — likely credential error
        clearTimeout(timer);
        die(`Server exited with code ${code} — check credentials and .env`);
      }
    });

    function send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }

    function finish(output) {
      clearTimeout(timer);
      child.kill('SIGTERM');
      process.stdout.write(output + '\n');
      resolve();
    }

    function onFrame(frame) {
      // Step 1: initialize response → send initialized + our request
      if (frame.id === 1 && frame.result) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        if (command === 'list') {
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (command === 'schema') {
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else {
          // Regular tool call
          let args;
          if (jsonPayload) {
            try { args = JSON.parse(jsonPayload); }
            catch (e) { clearTimeout(timer); child.kill(); die(`--json parse error: ${e.message}`); }
          } else {
            args = toolArgs;
          }
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: command, arguments: args } });
        }
      }

      // Step 2: our request response
      if (frame.id === 2) {
        if (frame.error) {
          clearTimeout(timer);
          child.kill();
          die(`Tool error: ${frame.error.message ?? JSON.stringify(frame.error)}`);
          return;
        }

        if (command === 'list') {
          const tools = frame.result?.tools ?? [];
          if (compact) {
            finish(JSON.stringify(tools));
          } else {
            const lines = tools.map(t =>
              `  ${t.name.padEnd(36)} ${t.description ?? ''}`
            ).join('\n');
            finish(`${tools.length} tools:\n\n${lines}`);
          }
          return;
        }

        if (command === 'schema') {
          const tools = frame.result?.tools ?? [];
          const tool = tools.find(t => t.name === schemaTarget);
          if (!tool) {
            clearTimeout(timer);
            child.kill();
            die(`Unknown tool: ${schemaTarget}`);
            return;
          }
          finish(JSON.stringify(tool.inputSchema, null, compact ? 0 : 2));
          return;
        }

        // tool call result
        const content = frame.result?.content ?? [];
        if (compact) {
          finish(JSON.stringify(frame.result));
        } else {
          const text = content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          const isError = frame.result?.isError;
          if (isError) {
            clearTimeout(timer);
            child.kill();
            process.stderr.write(`[outlook] error:\n${text}\n`);
            process.exit(1);
          }
          finish(text || JSON.stringify(frame.result, null, 2));
        }
      }
    }

    // Kick off with initialize
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'outlook-cli', version: '1.0.0' },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv);

if (opts.help || !opts.command) {
  printHelp();
  process.exit(0);
}

// Load credentials. Order (first to set wins): process.env → .env → Keychain.
// .env runs before Keychain so `--env-file` / `OUTLOOK_ENV_FILE` can override
// the default mailbox stored in the chain (multi-account use).
const envFile =
  opts.envFile ??
  process.env.OUTLOOK_ENV_FILE ??
  resolve(REPO_ROOT, '.env');
loadEnvFile(envFile);

if (existsSync(KEYCHAIN_BOOTSTRAP)) {
  const mod = await import(KEYCHAIN_BOOTSTRAP);
  mod.bootstrapKeychain();
}

await runMcp(opts);
