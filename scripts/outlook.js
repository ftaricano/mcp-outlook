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
 *   --compact           Backwards-compatible alias for --output=mcp
 *   --help, -h          Show this help
 *
 * Credentials are resolved in this order:
 *   1. --env-file <path> flag (overrides existing variables)
 *   2. $OUTLOOK_ENV_FILE env var (overrides existing variables)
 *   3. Environment variables already set (MICROSOFT_GRAPH_CLIENT_ID, etc.)
 *   4. <repo-root>/.env for missing variables only
 *   5. macOS Keychain for missing variables only
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendFeedback,
  appendRun,
  argumentShape,
  defaultStateDir,
  extractSearchEvidence,
  normalizeErrorClass,
  readJournal,
} from './lib/run-journal.js';
import { harvestEvents } from './lib/harvest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// Server entry can be overridden (mainly for tests, which point this at a fake
// MCP server). Defaults to the built server at <repo-root>/dist/index.js.
const SERVER_ENTRY = process.env.OUTLOOK_SERVER_ENTRY
  ? resolve(process.env.OUTLOOK_SERVER_ENTRY)
  : resolve(REPO_ROOT, 'dist/index.js');

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
    output: 'text',
    sessionId: null,
    noJournal: false,
    help: false,
    command: null, // 'list' | 'schema' | <tool-name>
    schemaTarget: null,
    jsonPayload: null,
    toolArgs: {},
    positionals: [],
  };

  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      i++;
      continue;
    }
    if (a === '--compact') {
      opts.compact = true;
      opts.output = 'mcp';
      i++;
      continue;
    }
    if (a === '--no-journal') {
      opts.noJournal = true;
      i++;
      continue;
    }
    if (a === '--output' || a.startsWith('--output=')) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : raw[++i];
      if (!['text', 'json', 'mcp'].includes(value)) {
        die(`Invalid --output value: ${value}. Use text, json, or mcp.`);
      }
      opts.output = value;
      opts.compact = value === 'mcp';
      i++;
      continue;
    }
    if (a === '--session' || a.startsWith('--session=')) {
      opts.sessionId = a.includes('=') ? a.slice(a.indexOf('=') + 1) : raw[++i];
      i++;
      continue;
    }
    if (a === '--env-file') {
      opts.envFile = raw[++i];
      i++;
      continue;
    }
    if (a === '--timeout') {
      opts.timeout = Number(raw[++i]);
      i++;
      continue;
    }
    if (a === '--json') {
      opts.jsonPayload = raw[++i];
      i++;
      continue;
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
      i++;
      continue;
    }
    // Positional
    if (!opts.command) {
      opts.command = a;
      i++;
      continue;
    }
    if (opts.command === 'schema' && !opts.schemaTarget) {
      opts.schemaTarget = a;
      i++;
      continue;
    }
    opts.positionals.push(a);
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
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// .env loader (manual, no dependency on dotenv module path resolution)
// ---------------------------------------------------------------------------

function loadEnvFile(path, { override = false } = {}) {
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
    if (override || !process.env[key]) process.env[key] = val;
  }
}

function resolveEnvSource(opts) {
  if (opts.envFile) {
    return { path: resolve(opts.envFile), override: true };
  }

  if (process.env.OUTLOOK_ENV_FILE) {
    return { path: resolve(process.env.OUTLOOK_ENV_FILE), override: true };
  }

  return { path: resolve(REPO_ROOT, '.env'), override: false };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    `
outlook — one-shot CLI for mcp-outlook (40 Microsoft Graph email tools)

Usage:
  outlook list                           List all 40 tools with descriptions
  outlook schema <tool>                  Show a tool's input schema
  outlook <tool> [--key=value ...]       Call a tool with individual flags
  outlook <tool> --json '<JSON>'         Call a tool with a raw JSON args object
  outlook feedback <runId> --outcome=missed
  outlook harvest --since=7d --output=json

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
  --output <mode>     text (default), json (structured), or mcp (raw envelope)
  --session <id>      Link the sanitized run event to an operator session
  --no-journal        Do not append a sanitized run event
  --help, -h          Show this help

Credentials (env vars or .env file):
  MICROSOFT_GRAPH_CLIENT_ID
  MICROSOFT_GRAPH_CLIENT_SECRET
  MICROSOFT_GRAPH_TENANT_ID
  TARGET_USER_EMAIL

  Resolution order: --env-file > $OUTLOOK_ENV_FILE > existing env vars >
  <repo>/.env (missing only) > macOS Keychain (missing only).

  Keychain lookup uses service \`mcp-outlook::<VAR>\` by default. Point at
  existing Keychain entries with OUTLOOK_KEYCHAIN_<VAR>_SERVICES, e.g.:
    export OUTLOOK_KEYCHAIN_MICROSOFT_GRAPH_CLIENT_ID_SERVICES=my-app::CLIENT_ID

Filesystem allowlist (download_attachment_to_file, download_all_attachments,
send_email_with_file, encode_file_for_attachment):
  Writes are confined to DOWNLOAD_DIR (default: ~/Downloads/mcp-outlook-attachments).
  Reads default to DOWNLOAD_DIR; extend with MCP_EMAIL_UPLOAD_DIRS (colon-separated).
  Pass any targetDirectory outside DOWNLOAD_DIR and the call fails — set
  DOWNLOAD_DIR to a parent that includes the paths you actually want to use.

Repo: ${REPO_ROOT}
`.trimStart()
  );
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

async function runMcp({
  command,
  schemaTarget,
  toolArgs,
  jsonPayload,
  timeout,
  compact,
  output,
  sessionId,
  noJournal,
}) {
  const child = startServer();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let invocationArgs = toolArgs;
  let buf = '';
  let idCounter = 1;
  let timer;
  // Set once we've printed a result or reported an error. After that point the
  // server is only shutting down (we sent it SIGTERM), so its exit code must
  // NOT be turned into a spurious "check credentials" failure.
  let settled = false;
  // Captured server stderr, surfaced verbatim when the server dies BEFORE
  // answering (real reason — lock contention, bad env — beats a generic hint).
  let serverStderr = '';

  return new Promise((resolve) => {
    const responses = new Map();

    timer = setTimeout(() => {
      fail(`Timeout after ${timeout}ms — is the server built and credentials set?`);
    }, timeout);

    // Capture (don't discard) server logs so a genuine startup failure can
    // explain itself instead of falling back to the generic credentials hint.
    child.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
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
        if (frame.id != null) responses.set(frame.id, frame);
        onFrame(frame);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      fail(`Spawn error: ${err.message}`);
    });
    // 'close' (not 'exit') so captured stderr is complete before we report.
    child.on('close', (code, signal) => {
      // Reaching here while unsettled means the server closed BEFORE producing
      // our result — a genuine startup/early failure worth reporting. If we
      // already settled, this is just the post-SIGTERM shutdown: ignore it.
      if (settled) return;
      const reason = serverStderr.trim();
      const where = code != null ? `code ${code}` : `signal ${signal}`;
      if (reason) {
        fail(`Server exited before responding (${where}):\n${reason}`);
      } else {
        fail(
          `Server exited before responding (${where}) — ensure it is built ` +
            `(npm run build) and credentials are set (.env / Keychain).`
        );
      }
    });

    function send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }

    async function recordRun(exitStatus, result, rawError) {
      if (noJournal || process.env.OUTLOOK_JOURNAL === '0') return;
      try {
        await appendRun(defaultStateDir(), {
          runId,
          sessionId: sessionId || undefined,
          command,
          startedAt,
          durationMs: Date.now() - startedMs,
          exitStatus,
          argumentShape: argumentShape(invocationArgs),
          searchEvidence: extractSearchEvidence(result?.structuredContent),
          errorClass: rawError ? normalizeErrorClass(rawError) : undefined,
        });
      } catch (error) {
        process.stderr.write(
          `[outlook] journal warning: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }

    function finish(renderedOutput, result) {
      clearTimeout(timer);
      settled = true;
      void recordRun('success', result).finally(() => {
        process.stdout.write(renderedOutput + '\n');
        child.kill('SIGTERM');
        resolve();
      });
    }

    function fail(message) {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      child.kill();
      void recordRun('error', undefined, message).finally(() => die(message));
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
            try {
              args = JSON.parse(jsonPayload);
              invocationArgs = args;
            } catch (e) {
              fail(`--json parse error: ${e.message}`);
              return;
            }
          } else {
            args = toolArgs;
          }
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: command, arguments: args },
          });
        }
      }

      // Step 2: our request response
      if (frame.id === 2) {
        if (frame.error) {
          fail(`Tool error: ${frame.error.message ?? JSON.stringify(frame.error)}`);
          return;
        }

        if (command === 'list') {
          const tools = frame.result?.tools ?? [];
          if (output !== 'text') {
            finish(JSON.stringify(tools), frame.result);
          } else {
            const lines = tools
              .map((t) => `  ${t.name.padEnd(36)} ${t.description ?? ''}`)
              .join('\n');
            finish(`${tools.length} tools:\n\n${lines}`, frame.result);
          }
          return;
        }

        if (command === 'schema') {
          const tools = frame.result?.tools ?? [];
          const tool = tools.find((t) => t.name === schemaTarget);
          if (!tool) {
            fail(`Unknown tool: ${schemaTarget}`);
            return;
          }
          finish(JSON.stringify(tool.inputSchema, null, compact ? 0 : 2), frame.result);
          return;
        }

        // tool call result
        const content = frame.result?.content ?? [];
        const text = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        const isError = frame.result?.isError;
        if (isError) {
          fail(`error:\n${text || 'Tool returned an error'}`);
          return;
        }
        if (output === 'mcp') {
          finish(JSON.stringify(frame.result), frame.result);
        } else if (output === 'json') {
          finish(
            JSON.stringify(
              frame.result?.structuredContent ?? {
                content: text,
                isError: false,
              }
            ),
            frame.result
          );
        } else {
          finish(text || JSON.stringify(frame.result, null, 2), frame.result);
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

function parseSince(value) {
  const match = /^(\d+)([dh])$/.exec(String(value || '7d'));
  if (!match) die(`Invalid --since value: ${value}. Use values such as 24h or 7d.`);
  const amount = Number(match[1]);
  const unitMs = match[2] === 'h' ? 3_600_000 : 86_400_000;
  return Date.now() - amount * unitMs;
}

if (opts.command === 'feedback') {
  const runId = opts.positionals[0];
  const outcome = opts.toolArgs.outcome;
  if (!runId || typeof outcome !== 'string') {
    die('Usage: outlook feedback <runId> --outcome=<correct|missed|wrong_match|failed>');
  }
  try {
    await appendFeedback(defaultStateDir(), runId, outcome);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const result = { ok: true, runId, outcome };
  process.stdout.write(
    opts.output === 'text'
      ? `Feedback recorded for ${runId}: ${outcome}\n`
      : `${JSON.stringify(result)}\n`
  );
  process.exit(0);
}

if (opts.command === 'harvest') {
  const cutoff = parseSince(opts.toolArgs.since);
  const events = (await readJournal(defaultStateDir())).filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
  const result = harvestEvents(events, {
    skillTarget:
      typeof (opts.toolArgs.skillTarget ?? opts.toolArgs['skill-target']) === 'string'
        ? (opts.toolArgs.skillTarget ?? opts.toolArgs['skill-target'])
        : 'outlook-mcp',
    minimumOccurrences:
      typeof (opts.toolArgs.minimumOccurrences ?? opts.toolArgs['minimum-occurrences']) === 'number'
        ? (opts.toolArgs.minimumOccurrences ?? opts.toolArgs['minimum-occurrences'])
        : 2,
  });
  process.stdout.write(`${JSON.stringify(result, null, opts.output === 'text' ? 2 : 0)}\n`);
  process.exit(0);
}

// Explicit env files are account selectors and override existing credential vars
// for this one-shot process. The repo-local .env remains a missing-value fallback.
const envSource = resolveEnvSource(opts);
loadEnvFile(envSource.path, { override: envSource.override });

if (existsSync(KEYCHAIN_BOOTSTRAP)) {
  const mod = await import(KEYCHAIN_BOOTSTRAP);
  mod.bootstrapKeychain();
}

await runMcp(opts);
