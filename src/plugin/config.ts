import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

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
    maxBatchSize: z.number().int().min(1).max(100).default(25),
    maxQueriesPerBatch: z.number().int().min(1).max(25).default(10),
    maxZipEntries: z.number().int().min(1).max(1_000).default(200),
    maxZipUncompressedBytes: z
      .number()
      .int()
      .min(1024)
      .max(200 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    searchMemoryPath: z.string().min(1).optional(),
  })
  .superRefine(({ mailboxes }, context) => {
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
  readonly maxAttachmentInputBytes: number;
  readonly maxExtractedChars: number;
  readonly maxRawAttachmentBytes: number;
  readonly maxBatchSize: number;
  readonly maxQueriesPerBatch: number;
  readonly maxZipEntries: number;
  readonly maxZipUncompressedBytes: number;
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

function resolveAllowWrites(envValue: string | undefined, fileValue: boolean): boolean {
  const normalized = envValue?.trim().toLowerCase();
  if (!normalized) return fileValue;
  if (TRUTHY_ALLOW_WRITES_VALUES.has(normalized)) return true;
  if (FALSY_ALLOW_WRITES_VALUES.has(normalized)) return false;
  // A kill-switch that fails silently to a default is worse than one that
  // refuses to start: an operator setting PLUGIN_ALLOW_WRITES=False (or any
  // other unrecognized spelling) must be told, not have it quietly ignored.
  throw new PluginConfigError('PLUGIN_ALLOW_WRITES must be a boolean value');
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
  const allowWrites = resolveAllowWrites(process.env.PLUGIN_ALLOW_WRITES, parsed.data.allowWrites);
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
    maxAttachmentInputBytes: parsed.data.maxAttachmentInputBytes,
    maxExtractedChars: parsed.data.maxExtractedChars,
    maxRawAttachmentBytes: parsed.data.maxRawAttachmentBytes,
    maxBatchSize: parsed.data.maxBatchSize,
    maxQueriesPerBatch: parsed.data.maxQueriesPerBatch,
    maxZipEntries: parsed.data.maxZipEntries,
    maxZipUncompressedBytes: parsed.data.maxZipUncompressedBytes,
    searchMemoryPath,
  });
}
