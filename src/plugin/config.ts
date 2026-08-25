import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseAllowedSenders } from '../security/senderPolicy.js';

const MAX_CONCURRENT_MAILBOXES = 8;
const MAX_MAILBOXES_PER_SEARCH = 32;
const MAX_RESULTS_PER_MAILBOX = 100;
const MAX_BODY_CHARS = 12000;

const mailboxSchema = z
  .strictObject({
    alias: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'alias must be a lowercase alias'),
    address: z.string().email(),
  })
  .transform((mailbox) => Object.freeze({ ...mailbox }));

const pluginConfigSchema = z
  .strictObject({
    mailboxes: z.array(mailboxSchema).min(1, 'at least one mailbox is required'),
    maxConcurrentMailboxes: z.number().int().min(1).max(MAX_CONCURRENT_MAILBOXES).default(3),
    maxMailboxesPerSearch: z.number().int().min(1).max(MAX_MAILBOXES_PER_SEARCH).default(8),
    maxResultsPerMailbox: z.number().int().min(1).max(MAX_RESULTS_PER_MAILBOX).default(20),
    maxBodyChars: z.number().int().min(1).max(MAX_BODY_CHARS).default(12000),
    allowWrites: z.boolean().default(false),
    maxAttachmentInputBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    maxExtractedChars: z.number().int().min(1_000).max(1_000_000).default(200_000),
    maxRawAttachmentBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024)
      .default(256 * 1024),
    maxConcurrentExtractions: z.number().int().min(1).max(8).default(2),
    maxBatchSize: z.number().int().min(1).max(100).default(25),
    maxDownloadBatchBytes: z
      .number()
      .int()
      .min(1024)
      .max(500 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    maxHandoffAttachmentBytes: z
      .number()
      .int()
      .min(1024)
      .max(100 * 1024 * 1024)
      .default(25 * 1024 * 1024),
    maxHandoffStoreBytes: z
      .number()
      .int()
      .min(1024)
      .max(5 * 1024 * 1024 * 1024)
      .default(500 * 1024 * 1024),
    maxHandoffStoreEntries: z.number().int().min(1).max(10_000).default(1_000),
    maxQueriesPerBatch: z.number().int().min(1).max(25).default(10),
    maxBatchResultMessages: z.number().int().min(1).max(5_000).default(500),
    maxBatchResultBytes: z
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    maxBatchContextChars: z.number().int().min(1_000).max(5_000_000).default(500_000),
    maxBatchAttachments: z.number().int().min(1).max(10_000).default(1_000),
    maxZipEntries: z.number().int().min(1).max(1_000).default(200),
    maxZipUncompressedBytes: z
      .number()
      .int()
      .min(1024)
      .max(200 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    // Separate from the .zip caps above: these bound the *internal* structure
    // of an OOXML document (xlsx/docx), whose part count scales with sheets and
    // embedded objects and is unrelated to how large an attached archive a
    // deployment wants to accept.
    maxContainerEntries: z.number().int().min(1).max(20_000).default(1_000),
    maxContainerUncompressedBytes: z
      .number()
      .int()
      .min(1024)
      .max(500 * 1024 * 1024)
      .default(100 * 1024 * 1024),
    searchMemoryPath: z.string().min(1).optional(),
  })
  .superRefine(({ mailboxes, maxHandoffAttachmentBytes, maxHandoffStoreBytes }, context) => {
    const aliases = new Set<string>();
    const addresses = new Set<string>();

    mailboxes.forEach((mailbox, index) => {
      if (aliases.has(mailbox.alias)) {
        context.addIssue({
          code: 'custom',
          path: ['mailboxes', index, 'alias'],
          message: `duplicate alias: ${mailbox.alias}`,
        });
      }
      aliases.add(mailbox.alias);

      const address = mailbox.address.toLowerCase();
      if (addresses.has(address)) {
        context.addIssue({
          code: 'custom',
          path: ['mailboxes', index, 'address'],
          message: `duplicate address: ${mailbox.address}`,
        });
      }
      addresses.add(address);
    });

    if (maxHandoffStoreBytes < maxHandoffAttachmentBytes) {
      context.addIssue({
        code: 'custom',
        path: ['maxHandoffStoreBytes'],
        message: 'must be at least maxHandoffAttachmentBytes',
      });
    }
  });

export type MailboxConfig = Readonly<z.output<typeof mailboxSchema>>;

export interface PluginConfig {
  readonly mailboxes: readonly MailboxConfig[];
  readonly mailboxesByAlias: ReadonlyMap<string, MailboxConfig>;
  readonly maxConcurrentMailboxes: number;
  readonly maxMailboxesPerSearch: number;
  readonly maxResultsPerMailbox: number;
  readonly maxBodyChars: number;
  readonly allowWrites: boolean;
  readonly allowLocalHandoffs: boolean;
  readonly allowSend: boolean;
  readonly sendFromAlias: string | undefined;
  readonly maxAttachmentInputBytes: number;
  readonly maxExtractedChars: number;
  readonly maxRawAttachmentBytes: number;
  readonly maxConcurrentExtractions: number;
  readonly maxBatchSize: number;
  readonly maxDownloadBatchBytes: number;
  readonly maxHandoffAttachmentBytes: number;
  readonly maxHandoffStoreBytes: number;
  readonly maxHandoffStoreEntries: number;
  readonly maxQueriesPerBatch: number;
  readonly maxBatchResultMessages: number;
  readonly maxBatchResultBytes: number;
  readonly maxBatchContextChars: number;
  readonly maxBatchAttachments: number;
  readonly maxZipEntries: number;
  readonly maxZipUncompressedBytes: number;
  readonly maxContainerEntries: number;
  readonly maxContainerUncompressedBytes: number;
  readonly searchMemoryPath: string | undefined;
}

export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

export function defaultPluginConfigPath(): string {
  return join(homedir(), '.config', 'mcp-outlook', 'plugin.json');
}

export function resolvePluginConfigPath(configPath?: string): string {
  return (
    configPath?.trim() || process.env.OUTLOOK_PLUGIN_CONFIG?.trim() || defaultPluginConfigPath()
  );
}

function createImmutableMailboxMap(
  entries: Iterable<readonly [string, MailboxConfig]>
): ReadonlyMap<string, MailboxConfig> {
  const map = new Map(entries);
  const rejectMutation = (): never => {
    throw new Error('Mailbox alias map is immutable');
  };

  Object.defineProperties(map, {
    set: { value: rejectMutation },
    delete: { value: rejectMutation },
    clear: { value: rejectMutation },
  });

  return Object.freeze(map) as ReadonlyMap<string, MailboxConfig>;
}

function readPrivateConfigFile(configPath: string): string {
  let stats;
  try {
    stats = lstatSync(configPath);
  } catch {
    throw new PluginConfigError('Outlook plugin configuration file is not available');
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PluginConfigError('Outlook plugin configuration must be a regular file');
  }

  if (process.platform !== 'win32' && ((stats.mode & 0o077) !== 0 || (stats.mode & 0o400) === 0)) {
    throw new PluginConfigError(
      'Outlook plugin configuration must be owner-readable only on POSIX systems'
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(configPath);
  } catch {
    throw new PluginConfigError('Outlook plugin configuration file is not available');
  }

  try {
    return readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new PluginConfigError('Outlook plugin configuration could not be read');
  }
}

const TRUTHY_ALLOW_WRITES_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSY_ALLOW_WRITES_VALUES = new Set(['false', '0', 'no', 'off']);

function resolveBooleanEnv(
  name: string,
  envValue: string | undefined,
  defaultValue: boolean
): boolean {
  const normalized = envValue?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (TRUTHY_ALLOW_WRITES_VALUES.has(normalized)) return true;
  if (FALSY_ALLOW_WRITES_VALUES.has(normalized)) return false;
  // A capability switch that fails silently to a default is worse than one
  // that refuses to start: an unrecognized spelling must be surfaced rather
  // than quietly ignored.
  throw new PluginConfigError(`${name} must be a boolean value`);
}

/**
 * Resolve the single mailbox this plugin instance may send from.
 *
 * Deliberately stricter than the CLI. The plugin is the surface that reads
 * untrusted mail across every allowed mailbox, so enabling sending here only
 * makes sense if the sender is fixed by configuration and cannot be named by a
 * caller. Three conditions, all required, all failing at startup rather than at
 * the first send — a plugin that boots with sending half-configured is a plugin
 * whose operator believes it is safe:
 *
 *  1. `OUTLOOK_SEND_FROM` names the sending mailbox. Without it the plugin
 *     would fall back to the per-call mailbox, i.e. sending as any allowed box.
 *  2. That address is one of the configured mailboxes, so the send runs on a
 *     constructor-pinned service like every other operation (invariant 10) and
 *     is visible in `list_allowed_mailboxes`.
 *  3. `OUTLOOK_ALLOWED_SENDERS` is set and covers it. The outbound gate is the
 *     authority; enabling sending without it would leave a plugin that can send
 *     as anything the credential allows.
 */
function resolveSendFromAlias(mailboxes: readonly MailboxConfig[]): string {
  const sendFrom = process.env.OUTLOOK_SEND_FROM?.trim().toLowerCase();
  if (!sendFrom) {
    throw new PluginConfigError(
      'PLUGIN_ALLOW_SEND requires OUTLOOK_SEND_FROM to name the sending mailbox'
    );
  }

  const mailbox = mailboxes.find((entry) => entry.address.toLowerCase() === sendFrom);
  if (!mailbox) {
    throw new PluginConfigError(
      'OUTLOOK_SEND_FROM does not match any mailbox in the plugin allowlist'
    );
  }

  let allowedSenders: readonly string[];
  try {
    allowedSenders = parseAllowedSenders(process.env.OUTLOOK_ALLOWED_SENDERS);
  } catch (error) {
    throw new PluginConfigError(error instanceof Error ? error.message : 'invalid sender allowlist');
  }

  if (allowedSenders.length === 0) {
    throw new PluginConfigError(
      'PLUGIN_ALLOW_SEND requires a non-empty OUTLOOK_ALLOWED_SENDERS outbound gate'
    );
  }
  if (!allowedSenders.includes(sendFrom)) {
    throw new PluginConfigError(
      'OUTLOOK_SEND_FROM is not covered by the outbound sender allowlist'
    );
  }

  return mailbox.alias;
}

export function loadPluginConfig(configPath?: string): PluginConfig {
  const resolvedConfigPath = resolvePluginConfigPath(configPath);
  let source: unknown;
  try {
    source = JSON.parse(readPrivateConfigFile(resolvedConfigPath));
  } catch (error) {
    if (error instanceof PluginConfigError) throw error;
    throw new PluginConfigError('Outlook plugin configuration must contain valid JSON');
  }

  const parsed = pluginConfigSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; ');
    throw new PluginConfigError(`Invalid Outlook plugin configuration: ${issues}`);
  }

  const mailboxes = Object.freeze([...parsed.data.mailboxes]);
  const allowWrites = resolveBooleanEnv(
    'PLUGIN_ALLOW_WRITES',
    process.env.PLUGIN_ALLOW_WRITES,
    parsed.data.allowWrites
  );
  const allowLocalHandoffs = resolveBooleanEnv(
    'PLUGIN_ALLOW_LOCAL_HANDOFFS',
    process.env.PLUGIN_ALLOW_LOCAL_HANDOFFS,
    false
  );
  const allowSend = resolveBooleanEnv('PLUGIN_ALLOW_SEND', process.env.PLUGIN_ALLOW_SEND, false);
  const sendFromAlias = allowSend ? resolveSendFromAlias(mailboxes) : undefined;
  const searchMemoryPath =
    process.env.PLUGIN_SEARCH_MEMORY_PATH?.trim() || parsed.data.searchMemoryPath;

  return Object.freeze({
    mailboxes,
    mailboxesByAlias: createImmutableMailboxMap(
      mailboxes.map((mailbox) => [mailbox.alias, mailbox] as const)
    ),
    maxConcurrentMailboxes: parsed.data.maxConcurrentMailboxes,
    maxMailboxesPerSearch: parsed.data.maxMailboxesPerSearch,
    maxResultsPerMailbox: parsed.data.maxResultsPerMailbox,
    maxBodyChars: parsed.data.maxBodyChars,
    allowWrites,
    allowLocalHandoffs,
    allowSend,
    sendFromAlias,
    maxAttachmentInputBytes: parsed.data.maxAttachmentInputBytes,
    maxExtractedChars: parsed.data.maxExtractedChars,
    maxRawAttachmentBytes: parsed.data.maxRawAttachmentBytes,
    maxConcurrentExtractions: parsed.data.maxConcurrentExtractions,
    maxBatchSize: parsed.data.maxBatchSize,
    maxDownloadBatchBytes: parsed.data.maxDownloadBatchBytes,
    maxHandoffAttachmentBytes: parsed.data.maxHandoffAttachmentBytes,
    maxHandoffStoreBytes: parsed.data.maxHandoffStoreBytes,
    maxHandoffStoreEntries: parsed.data.maxHandoffStoreEntries,
    maxQueriesPerBatch: parsed.data.maxQueriesPerBatch,
    maxBatchResultMessages: parsed.data.maxBatchResultMessages,
    maxBatchResultBytes: parsed.data.maxBatchResultBytes,
    maxBatchContextChars: parsed.data.maxBatchContextChars,
    maxBatchAttachments: parsed.data.maxBatchAttachments,
    maxZipEntries: parsed.data.maxZipEntries,
    maxZipUncompressedBytes: parsed.data.maxZipUncompressedBytes,
    maxContainerEntries: parsed.data.maxContainerEntries,
    maxContainerUncompressedBytes: parsed.data.maxContainerUncompressedBytes,
    searchMemoryPath,
  });
}
