#!/usr/bin/env node
// Live read-only integration smoke against a real tenant.
// Speaks JSON-RPC over the MCP stdio server (built dist/).
// Exercises: tools/list + list_folders + list_emails + get_folder_stats +
//           advanced_search + summarize_email on the top message.
// NO writes, NO sends, NO deletes.

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
    }, 30000);
  });
}

function tool(name, args) {
  return call('tools/call', { name, arguments: args });
}

function preview(res) {
  if (!res?.content?.[0]?.text) return String(res).slice(0, 200);
  return res.content[0].text.slice(0, 400);
}

(async () => {
  const results = [];
  const ok = (label, pass, info) => { results.push({ label, pass, info }); console.error(`[${pass ? 'PASS' : 'FAIL'}] ${label} — ${info}`); };

  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-smoke', version: '1.0' } });

    const tl = await call('tools/list', {});
    ok('tools/list', tl.tools?.length === 39, `tools=${tl.tools?.length}`);

    // --- list_folders ---
    try {
      const r = await tool('list_folders', { includeSubfolders: false, maxDepth: 1 });
      const p = preview(r);
      ok('list_folders', p.toLowerCase().includes('inbox'), `preview="${p.slice(0,120).replace(/\s+/g,' ')}"`);
    } catch (e) { ok('list_folders', false, String(e).slice(0,200)); }

    // --- list_emails (limit 3) ---
    let firstId = null;
    try {
      const r = await tool('list_emails', { limit: 3, folder: 'inbox' });
      const p = preview(r);
      // try to pull first email id (best-effort)
      const idMatch = p.match(/"id"\s*:\s*"([A-Za-z0-9_\-=\/+]{20,})"/) || p.match(/([A-Za-z0-9_\-=]{40,})/);
      if (idMatch) firstId = idMatch[1];
      ok('list_emails limit:3', p.length > 10, `len=${p.length}`);
    } catch (e) { ok('list_emails limit:3', false, String(e).slice(0,200)); }

    // --- get_folder_stats ---
    try {
      const r = await tool('get_folder_stats', { folderId: 'inbox', includeSubfolders: false });
      const p = preview(r);
      ok('get_folder_stats(inbox)', p.length > 10, `preview="${p.slice(0,120).replace(/\s+/g,' ')}"`);
    } catch (e) { ok('get_folder_stats(inbox)', false, String(e).slice(0,200)); }

    // --- advanced_search ---
    try {
      const r = await tool('advanced_search', { hasAttachments: true, maxResults: 3, folder: 'inbox' });
      const p = preview(r);
      ok('advanced_search hasAttachments', p.length > 10, `len=${p.length}`);
    } catch (e) { ok('advanced_search', false, String(e).slice(0,200)); }

    // --- summarize_email (if we got an id) ---
    if (firstId) {
      try {
        const r = await tool('summarize_email', { emailId: firstId });
        const p = preview(r);
        ok('summarize_email', p.length > 10, `len=${p.length}`);
      } catch (e) { ok('summarize_email', false, String(e).slice(0,200)); }
    } else {
      ok('summarize_email', false, 'skipped: no email id parsed from list_emails');
    }

    const pass = results.filter(r => r.pass).length;
    const total = results.length;
    console.error(`\n=== ${pass}/${total} passed ===`);
    process.exit(pass === total ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(2);
  } finally {
    proc.kill('SIGTERM');
  }
})();
