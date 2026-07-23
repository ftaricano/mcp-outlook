import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FEEDBACK_OUTCOMES = new Set(['correct', 'missed', 'wrong_match', 'failed']);
const SAFE_COMMANDS = new Set([
  'list',
  'schema',
  'list_emails',
  'send_email',
  'create_draft',
  'reply_to_email',
  'mark_as_read',
  'mark_as_unread',
  'delete_email',
  'summarize_email',
  'summarize_emails_batch',
  'list_users',
  'list_attachments',
  'download_attachment',
  'download_attachment_to_file',
  'download_all_attachments',
  'list_downloaded_files',
  'get_download_directory_info',
  'cleanup_old_downloads',
  'export_email_as_attachment',
  'encode_file_for_attachment',
  'send_email_from_attachment',
  'send_email_with_file',
  'list_folders',
  'create_folder',
  'move_emails_to_folder',
  'copy_emails_to_folder',
  'delete_folder',
  'get_folder_stats',
  'organize_emails_by_rules',
  'advanced_search',
  'search_by_sender_domain',
  'search_by_attachment_type',
  'find_duplicate_emails',
  'search_by_size',
  'saved_searches',
  'batch_mark_as_read',
  'batch_mark_as_unread',
  'batch_delete_emails',
  'batch_move_emails',
  'batch_download_attachments',
  'email_cleanup_wizard',
]);
const SAFE_ARGUMENT_NAMES = new Set([
  'action',
  'attachmentId',
  'attachmentSizeLimitMB',
  'attachments',
  'bcc',
  'body',
  'cc',
  'companyName',
  'customFilename',
  'dateFrom',
  'dateTo',
  'daysOld',
  'deleteLargeAttachments',
  'deleteRead',
  'domain',
  'dryRun',
  'emailId',
  'emailIds',
  'emailTitle',
  'excludeFolders',
  'filePath',
  'fileTypes',
  'folder',
  'folderId',
  'format',
  'hasAttachments',
  'includeAttachments',
  'includeMetadata',
  'includeRead',
  'includeSubdomains',
  'includeSubfolders',
  'isRead',
  'keepOriginalFile',
  'limit',
  'logoUrl',
  'maxConcurrent',
  'maxDepth',
  'maxEmails',
  'maxPages',
  'maxResults',
  'maxSizeMB',
  'minSizeMB',
  'name',
  'olderThanDays',
  'overwrite',
  'parentFolderId',
  'permanent',
  'priorityOnly',
  'query',
  'replyAll',
  'rules',
  'scanLimit',
  'search',
  'searchCriteria',
  'sender',
  'signature',
  'sizeLimit',
  'skip',
  'sortBy',
  'sortOrder',
  'sourceEmailId',
  'sourceFolderId',
  'subject',
  'targetDirectory',
  'targetFolderId',
  'templateTheme',
  'to',
  'useTemplate',
  'validateIntegrity',
  'validateTarget',
]);

export function defaultStateDir() {
  if (process.env.OUTLOOK_STATE_DIR) return process.env.OUTLOOK_STATE_DIR;
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateRoot, 'mcp-outlook');
}

export function argumentShape(args) {
  let unknownIndex = 0;
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => {
      const safeKey = SAFE_ARGUMENT_NAMES.has(key) ? key : `unknown_${++unknownIndex}`;
      if (Array.isArray(value)) return [safeKey, 'array'];
      if (value === null) return [safeKey, 'null'];
      return [safeKey, typeof value];
    })
  );
}

const SHAPE_TYPE_LABELS = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'undefined',
  'bigint',
  'symbol',
  'function',
  'array',
  'null',
]);

// Defense-in-depth: re-shape at the persistence boundary so a caller that mistakenly
// hands raw values (instead of type labels) never leaks them. Keys are re-allowlisted and
// any value that is not already a known type label is collapsed to its typeof.
function sanitizeArgumentShape(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return undefined;
  let unknownIndex = 0;
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => {
      const safeKey = SAFE_ARGUMENT_NAMES.has(key) ? key : `unknown_${++unknownIndex}`;
      return [safeKey, SHAPE_TYPE_LABELS.has(value) ? value : typeof value];
    })
  );
}

export function hashSessionId(sessionId) {
  if (!sessionId) return undefined;
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
  return `sha256:${digest}`;
}

export function sanitizeCommand(command) {
  return SAFE_COMMANDS.has(command) ? command : 'unknown_command';
}

export function normalizeErrorClass(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (/\b429\b|too many requests|throttl/.test(text)) return 'throttled';
  if (/\b401\b|unauthori[sz]ed|invalid.*credential|authentication/.test(text)) {
    return 'authentication';
  }
  if (/\b403\b|forbidden|insufficient privileges/.test(text)) return 'forbidden';
  if (/raop|access to odata is disabled|access policy/.test(text)) return 'access_policy';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/invalid arguments|validation|zod/.test(text)) return 'invalid_arguments';
  if (/server exited|spawn|enoent/.test(text)) return 'server_startup';
  return 'unknown_error';
}

export function extractSearchEvidence(structuredContent) {
  if (!structuredContent || typeof structuredContent !== 'object') return undefined;
  const status = structuredContent.status;
  if (typeof status !== 'string') return undefined;
  return {
    status,
    strategy:
      typeof structuredContent.strategy === 'string' ? structuredContent.strategy : undefined,
    pagesScanned:
      typeof structuredContent.pagesScanned === 'number'
        ? structuredContent.pagesScanned
        : undefined,
    candidatesScanned:
      typeof structuredContent.candidatesScanned === 'number'
        ? structuredContent.candidatesScanned
        : undefined,
    truncated:
      typeof structuredContent.truncated === 'boolean' ? structuredContent.truncated : undefined,
    canaryMatched:
      typeof structuredContent.canaryMatched === 'boolean'
        ? structuredContent.canaryMatched
        : undefined,
  };
}

async function appendEvent(stateDir, event) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'runs.jsonl');
  await writeFile(path, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'a',
  });
  await chmod(path, 0o600);
}

export async function appendRun(stateDir, run) {
  // Construct the event from an explicit allowlist. The metadata-only invariant is enforced
  // here, not delegated to callers: spreading `run` would persist any extra caller-supplied
  // property (raw errors, message metadata, credentials) verbatim.
  await appendEvent(stateDir, {
    version: 1,
    eventType: 'run',
    timestamp: new Date().toISOString(),
    runId: typeof run.runId === 'string' ? run.runId : undefined,
    command: sanitizeCommand(run.command),
    sessionId: hashSessionId(run.sessionId),
    startedAt: typeof run.startedAt === 'string' ? run.startedAt : undefined,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : undefined,
    exitStatus: typeof run.exitStatus === 'string' ? run.exitStatus : undefined,
    argumentShape: sanitizeArgumentShape(run.argumentShape),
    searchEvidence: extractSearchEvidence(run.searchEvidence),
    errorClass: typeof run.errorClass === 'string' ? run.errorClass : undefined,
  });
}

export async function readJournal(stateDir = defaultStateDir()) {
  const path = join(stateDir, 'runs.jsonl');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Run journal is corrupt at line ${index + 1}`);
      }
    });
}

export async function appendFeedback(stateDir, runId, outcome) {
  if (!FEEDBACK_OUTCOMES.has(outcome)) {
    throw new Error(`Invalid feedback outcome: ${outcome}`);
  }
  const events = await readJournal(stateDir);
  if (!events.some((event) => event.eventType === 'run' && event.runId === runId)) {
    throw new Error(`Unknown run ID: ${runId}`);
  }
  await appendEvent(stateDir, {
    version: 1,
    eventType: 'feedback',
    runId,
    timestamp: new Date().toISOString(),
    outcome,
  });
}
