#!/usr/bin/env node
// Live read-only + dry-run integration smoke against a real tenant.
// Exercises every tool that can run without a real side-effect:
//   * read-only queries (list/get/search/stats/download-metadata)
//   * dry-run variants (organize/cleanup wizards)
// Skips writes (send/mark/delete/move/copy/create-folder/download-to-file).

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
    }, 45000);
  });
}

function tool(name, args) {
  return call('tools/call', { name, arguments: args });
}

function txt(res) {
  return res?.content?.[0]?.text ?? '';
}

// Detect "tool-returned-error" pattern. The handlers wrap errors in text content
// starting with ❌/Erro/Error rather than a protocol-level error.
function looksLikeError(t) {
  const s = t.slice(0, 120).toLowerCase();
  return s.includes('❌') || s.startsWith('erro ') || s.startsWith('error ') ||
         s.includes('graph error') || s.includes('authentication failed') ||
         s.includes('inefficient') || s.includes('malformed');
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
    const preview = t.slice(0, 140).replace(/\s+/g, ' ');
    record(label, pass, `len=${t.length} preview="${preview}"`);
    return { text: t, pass };
  } catch (e) {
    record(label, false, `threw: ${String(e).slice(0, 200)}`);
    return { text: '', pass: false };
  }
}

(async () => {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-smoke', version: '1.0' },
  });

  const tl = await call('tools/list', {});
  record('tools/list', tl.tools?.length === 40, `tools=${tl.tools?.length}`);

  // --- EMAIL READ ---
  const listEmails = await run('list_emails limit:5', () => tool('list_emails', { limit: 5, folder: 'inbox' }));

  // EmailHandler renders "   ID: <full-id>\n" per email. Grab the full line.
  const idMatches = [...listEmails.text.matchAll(/ID:\s+([^\n\r]+)/g)]
    .map(m => m[1].trim())
    .filter(id => id.length > 80);
  const firstEmailId = idMatches[0] ?? null;
  console.error(`[info] parsed ${idMatches.length} candidate ids, firstLen=${firstEmailId?.length}`);

  await run('summarize_emails_batch limit:2', () => tool('summarize_emails_batch', { limit: 2, priorityOnly: false }));

  if (firstEmailId) {
    await run('summarize_email', () => tool('summarize_email', { emailId: firstEmailId }));
    await run('list_attachments', () => tool('list_attachments', { emailId: firstEmailId }));
  } else {
    record('summarize_email', false, 'skipped: no id parsed');
    record('list_attachments', false, 'skipped: no id parsed');
  }

  // list_users requires User.Read.All — may fail on SPs that only have Mail.*
  await run('list_users limit:3', () => tool('list_users', { limit: 3 }));

  // --- FOLDERS ---
  const listFolders = await run('list_folders', () => tool('list_folders', { includeSubfolders: false, maxDepth: 1 }),
    { check: (t) => /Inbox|Caixa de Entrada|Archive/i.test(t) });
  await run('get_folder_stats inbox', () => tool('get_folder_stats', { folderId: 'inbox', includeSubfolders: false }),
    { check: (t) => /Total|emails/i.test(t) });

  // --- SEARCH ---
  // advanced_search: known issue with broad filters on large folders. Test with
  // a date narrow to confirm the tool is not broken end-to-end, plus without to
  // reproduce the InefficientFilter bug.
  await run('advanced_search with dateFrom', () => tool('advanced_search', {
    dateFrom: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    maxResults: 3,
    folder: 'inbox',
  }));
  await run('advanced_search only hasAttachments (known InefficientFilter)', () => tool('advanced_search', {
    hasAttachments: true, maxResults: 3, folder: 'inbox',
  }));

  await run('search_by_sender_domain', () => tool('search_by_sender_domain', {
    domain: 'cpzseg.com.br', maxResults: 3, includeSubdomains: true, folder: 'inbox',
  }));

  await run('search_by_attachment_type pdf', () => tool('search_by_attachment_type', {
    fileTypes: ['pdf'], maxResults: 3, folder: 'inbox',
  }));

  await run('search_by_size 1-10 MB', () => tool('search_by_size', {
    minSizeMB: 1, maxSizeMB: 10, folder: 'inbox', maxResults: 3,
  }));

  await run('find_duplicate_emails subject', () => tool('find_duplicate_emails', {
    criteria: 'subject', folder: 'inbox', maxResults: 20,
  }));

  await run('saved_searches list', () => tool('saved_searches', { action: 'list' }));

  // --- ATTACHMENTS META / DOWNLOADS FS ---
  await run('list_downloaded_files', () => tool('list_downloaded_files', {}));
  await run('get_download_directory_info', () => tool('get_download_directory_info', {}));
  await run('cleanup_old_downloads dryRun', () => tool('cleanup_old_downloads', { daysOld: 365, dryRun: true }));

  // --- WIZARDS (dry-run only) ---
  await run('email_cleanup_wizard dryRun', () => tool('email_cleanup_wizard', {
    dryRun: true, olderThanDays: 365, maxEmails: 20,
  }));
  await run('organize_emails_by_rules dryRun', () => tool('organize_emails_by_rules', {
    sourceFolderId: 'inbox', dryRun: true, maxEmails: 20,
    rules: [{ name: 'test-rule', targetFolderId: 'archive', subjectContains: ['test'] }],
  }));

  // --- REPORT ---
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
