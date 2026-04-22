#!/usr/bin/env node
// Live write-path smoke against the real tenant.
// Creates a transient folder "__mcp-smoke__", creates a draft message
// (via create_draft — needs only Mail.ReadWrite, not Mail.Send), then
// round-trips status/move/copy and finally cleans up (delete email + folder).
// Every artifact is self-created — nothing touches existing user mail.
//
// Uses the same stdio JSON-RPC harness shape as live-readonly-smoke.js.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '../dist/index.js');

const proc = spawn('node', [entry], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let buffer = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const h = pending.get(msg.id);
    if (h) { pending.delete(msg.id); h(msg); }
  }
});

function call(method, params) {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++;
    pending.set(id, (msg) => msg.error ? rejectPromise(msg.error) : resolvePromise(msg.result));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rejectPromise(new Error(`timeout: ${method}`)); }
    }, 60000);
  });
}

const tool = (name, args) => call('tools/call', { name, arguments: args });
const txt = (res) => res?.content?.[0]?.text ?? '';

function looksLikeError(t) {
  const s = t.slice(0, 160).toLowerCase();
  return s.includes('❌') || s.startsWith('erro ') || s.startsWith('error ') ||
         s.includes('graph error') || s.includes('authentication failed');
}

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.error(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
}

async function run(label, fn, { check = (t) => t.length > 0 } = {}) {
  try {
    const r = await fn();
    const t = txt(r);
    const err = looksLikeError(t);
    const pass = !err && check(t);
    const preview = t.slice(0, 160).replace(/\s+/g, ' ');
    record(label, pass, `len=${t.length} preview="${preview}"`);
    return { text: t, pass };
  } catch (e) {
    record(label, false, `threw: ${String(e).slice(0, 200)}`);
    return { text: '', pass: false };
  }
}

// Extract Graph id from EmailHandler / FolderHandler textual output.
// Both render "   ID: <long-id>\n" style lines, but folder ids are much shorter
// (~150 chars base64) than email ids (~152+). Accept anything > 40 chars so we
// capture folder ids too.
function extractIds(text) {
  return [...text.matchAll(/ID:\s+([^\n\r]+)/g)]
    .map((m) => m[1].trim())
    .filter((id) => id.length > 40);
}

const stamp = Date.now();
const FOLDER_NAME = `__mcp-smoke__${stamp}`;
const SUBJECT = `__mcp-smoke__ ${stamp}`;
const TARGET = process.env.TARGET_USER_EMAIL || 'fernando.taricano@cpzseg.com.br';

let folderId = null;
let emailId = null;

(async () => {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-writes-smoke', version: '1.0' },
  });

  // ---- 1. create_folder ----
  const created = await run(`create_folder ${FOLDER_NAME}`, () => tool('create_folder', {
    folderName: FOLDER_NAME,
  }));
  const folderIds = extractIds(created.text);
  folderId = folderIds[0] ?? null;
  console.error(`[info] created folder id len=${folderId?.length}`);

  // ---- 2. create_draft (replaces send_email — only needs Mail.ReadWrite) ----
  const draftCreated = await run('create_draft to self', () => tool('create_draft', {
    to: [TARGET],
    subject: SUBJECT,
    body: `Automated write-path smoke. stamp=${stamp}. Safe to delete.`,
  }));
  const draftIds = extractIds(draftCreated.text);
  emailId = draftIds[0] ?? null;
  console.error(`[info] draft id len=${emailId?.length}`);

  // ---- 4. mark_as_read / mark_as_unread round-trip ----
  if (emailId) {
    await run('mark_as_read', () => tool('mark_as_read', { emailId }));
    await run('mark_as_unread', () => tool('mark_as_unread', { emailId }));
  } else {
    record('mark_as_read', false, 'skipped: no emailId');
    record('mark_as_unread', false, 'skipped: no emailId');
  }

  // ---- 5. reply_to_email (threaded reply, goes back to sender = self) ----
  if (emailId) {
    await run('reply_to_email', () => tool('reply_to_email', {
      emailId,
      body: `Automated reply from mcp-smoke. stamp=${stamp}`,
    }));
  } else {
    record('reply_to_email', false, 'skipped: no emailId');
  }

  // ---- 6. copy_emails_to_folder (copy into __mcp-smoke__) ----
  if (emailId && folderId) {
    await run('copy_emails_to_folder', () => tool('copy_emails_to_folder', {
      emailIds: [emailId],
      targetFolderId: folderId,
    }));
  } else {
    record('copy_emails_to_folder', false, 'skipped: missing emailId or folderId');
  }

  // ---- 7. move_emails_to_folder (move original into __mcp-smoke__) ----
  if (emailId && folderId) {
    const moved = await run('move_emails_to_folder', () => tool('move_emails_to_folder', {
      emailIds: [emailId],
      targetFolderId: folderId,
    }));
    // Moving returns a NEW message id (Graph semantics). Try to capture it.
    const newIds = extractIds(moved.text);
    if (newIds.length > 0) {
      console.error(`[info] post-move id len=${newIds[0].length}`);
      emailId = newIds[0];
    }
  } else {
    record('move_emails_to_folder', false, 'skipped: missing emailId or folderId');
  }

  // ---- 8. get_folder_stats on __mcp-smoke__ ----
  if (folderId) {
    await run('get_folder_stats __mcp-smoke__', () => tool('get_folder_stats', {
      folderId,
      includeSubfolders: false,
    }), { check: (t) => /Total|emails/i.test(t) });
  } else {
    record('get_folder_stats __mcp-smoke__', false, 'skipped: no folderId');
  }

  // ---- 9. cleanup: delete_folder (this deletes the folder and its contents) ----
  if (folderId) {
    await run('delete_folder __mcp-smoke__', () => tool('delete_folder', {
      folderId,
      permanent: false, // move to deleted-items so it's reversible
    }));
  } else {
    record('delete_folder', false, 'skipped: no folderId');
  }

  // ---- REPORT ----
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  console.error(`\n=== ${pass}/${total} passed ===`);
  for (const r of results.filter((x) => !x.ok)) {
    console.error(`  FAIL: ${r.label} — ${r.detail}`);
  }
  proc.kill('SIGTERM');
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e);
  proc.kill('SIGTERM');
  process.exit(2);
});
