import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPluginConfigPath,
  loadPluginConfig,
  PluginConfigError,
  resolvePluginConfigPath,
} from '../../src/plugin/config.js';

const tempDirectories: string[] = [];

function writeConfig(value: unknown, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-outlook-plugin-config-'));
  tempDirectories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mailboxes: [
      { alias: 'finance', address: 'finance@example.com' },
      { alias: 'billing', address: 'billing@example.com' },
    ],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadPluginConfig', () => {
  it('uses a stable user-private default path', () => {
    expect(defaultPluginConfigPath()).toMatch(/\.config\/mcp-outlook\/plugin\.json$/);
  });

  it('treats an empty environment override as absent', () => {
    const previous = process.env.OUTLOOK_PLUGIN_CONFIG;
    process.env.OUTLOOK_PLUGIN_CONFIG = '';
    try {
      expect(resolvePluginConfigPath()).toBe(defaultPluginConfigPath());
      expect(resolvePluginConfigPath('   ')).toBe(defaultPluginConfigPath());
    } finally {
      if (previous === undefined) delete process.env.OUTLOOK_PLUGIN_CONFIG;
      else process.env.OUTLOOK_PLUGIN_CONFIG = previous;
    }
  });

  it('loads the allowlist with bounded defaults and immutable lookup entries', () => {
    const config = loadPluginConfig(writeConfig(validConfig()));

    expect(config.mailboxes.map((mailbox) => mailbox.alias)).toEqual(['finance', 'billing']);
    expect(config.mailboxesByAlias.get('finance')).toEqual({
      alias: 'finance',
      address: 'finance@example.com',
    });
    expect(config.maxConcurrentMailboxes).toBe(3);
    expect(config.maxMailboxesPerSearch).toBe(8);
    expect(config.maxResultsPerMailbox).toBe(20);
    expect(config.maxBodyChars).toBe(12000);
    expect(() => (config.mailboxesByAlias as Map<string, unknown>).set('other', {})).toThrow(
      /immutable/i
    );
  });

  it('accepts maxResultsPerMailbox up to the schema ceiling of 100', () => {
    const config = loadPluginConfig(writeConfig(validConfig({ maxResultsPerMailbox: 100 })));
    expect(config.maxResultsPerMailbox).toBe(100);
  });

  it('rejects maxResultsPerMailbox above the schema ceiling of 100', () => {
    expect(() => loadPluginConfig(writeConfig(validConfig({ maxResultsPerMailbox: 101 })))).toThrow(
      /Invalid Outlook plugin configuration/
    );
  });

  it('rejects a symbolic link before resolving the real path', () => {
    const target = writeConfig(validConfig());
    const linkPath = join(tempDirectories[0], 'link.json');
    symlinkSync(target, linkPath);

    expect(() => loadPluginConfig(linkPath)).toThrow(/regular file/i);
  });

  it('rejects a file readable by group or other users on POSIX', () => {
    const path = writeConfig(validConfig(), 0o640);

    expect(() => loadPluginConfig(path)).toThrow(/owner-readable/i);
  });

  it.each([
    [
      'uppercase aliases',
      validConfig({
        mailboxes: [{ alias: 'Finance', address: 'finance@example.com' }],
      }),
      /lowercase alias/i,
    ],
    [
      'duplicate aliases',
      validConfig({
        mailboxes: [
          { alias: 'finance', address: 'finance@example.com' },
          { alias: 'finance', address: 'billing@example.com' },
        ],
      }),
      /duplicate alias/i,
    ],
    [
      'duplicate addresses',
      validConfig({
        mailboxes: [
          { alias: 'finance', address: 'finance@example.com' },
          { alias: 'billing', address: 'finance@example.com' },
        ],
      }),
      /duplicate address/i,
    ],
    ['empty allowlists', validConfig({ mailboxes: [] }), /at least one mailbox/i],
    [
      'invalid email addresses',
      validConfig({ mailboxes: [{ alias: 'finance', address: 'not-an-email' }] }),
      /email/i,
    ],
    [
      'limits outside bounds',
      validConfig({ maxConcurrentMailboxes: 0 }),
      /maxConcurrentMailboxes/i,
    ],
  ])('rejects %s', (_description, value, expectedMessage) => {
    expect(() => loadPluginConfig(writeConfig(value))).toThrow(expectedMessage);
  });

  it('rejects credentials and other undeclared configuration properties', () => {
    expect(() =>
      loadPluginConfig(writeConfig(validConfig({ clientSecret: 'not-allowed' })))
    ).toThrow(PluginConfigError);
  });
});

describe('expansion config fields', () => {
  it('applies safe defaults for the new limits', () => {
    const config = loadPluginConfig(writeConfig(validConfig()));
    expect(config.allowWrites).toBe(false);
    expect(config.allowLocalHandoffs).toBe(false);
    expect(config.maxAttachmentInputBytes).toBe(15 * 1024 * 1024);
    expect(config.maxExtractedChars).toBe(200_000);
    expect(config.maxRawAttachmentBytes).toBe(256 * 1024);
    expect(config.maxConcurrentExtractions).toBe(2);
    expect(config.maxBatchSize).toBe(25);
    expect(config.maxDownloadBatchBytes).toBe(50 * 1024 * 1024);
    expect(config.maxHandoffAttachmentBytes).toBe(25 * 1024 * 1024);
    expect(config.maxHandoffStoreBytes).toBe(500 * 1024 * 1024);
    expect(config.maxHandoffStoreEntries).toBe(1_000);
    expect(config.maxQueriesPerBatch).toBe(10);
    expect(config.maxBatchResultMessages).toBe(500);
    expect(config.maxBatchResultBytes).toBe(2 * 1024 * 1024);
    expect(config.maxBatchContextChars).toBe(500_000);
    expect(config.maxBatchAttachments).toBe(1_000);
    expect(config.maxZipEntries).toBe(200);
    expect(config.maxZipUncompressedBytes).toBe(50 * 1024 * 1024);
    expect(config.maxContainerEntries).toBe(1_000);
    expect(config.maxContainerUncompressedBytes).toBe(100 * 1024 * 1024);
    expect(config.searchMemoryPath).toBeUndefined();
  });

  it('rejects out-of-range limits', () => {
    expect(() =>
      loadPluginConfig(writeConfig(validConfig({ maxRawAttachmentBytes: 10 * 1024 * 1024 })))
    ).toThrow(/Invalid Outlook plugin configuration/);
  });

  it('rejects a handoff store byte budget below the per-attachment cap', () => {
    expect(() =>
      loadPluginConfig(
        writeConfig(
          validConfig({
            maxHandoffAttachmentBytes: 2 * 1024 * 1024,
            maxHandoffStoreBytes: 1024 * 1024,
          })
        )
      )
    ).toThrow(/maxHandoffStoreBytes/i);
  });

  it.each([
    ['maxBatchResultMessages', 5_001],
    ['maxBatchResultBytes', 10 * 1024 * 1024 + 1],
    ['maxBatchContextChars', 5_000_001],
    ['maxBatchAttachments', 10_001],
  ])('rejects an out-of-range %s aggregate budget', (field, value) => {
    expect(() => loadPluginConfig(writeConfig(validConfig({ [field]: value })))).toThrow(
      /Invalid Outlook plugin configuration/
    );
  });

  it('accepts maxConcurrentExtractions within [1, 8] and rejects outside it', () => {
    expect(
      loadPluginConfig(writeConfig(validConfig({ maxConcurrentExtractions: 8 })))
        .maxConcurrentExtractions
    ).toBe(8);
    expect(() =>
      loadPluginConfig(writeConfig(validConfig({ maxConcurrentExtractions: 0 })))
    ).toThrow(/Invalid Outlook plugin configuration/);
    expect(() =>
      loadPluginConfig(writeConfig(validConfig({ maxConcurrentExtractions: 9 })))
    ).toThrow(/Invalid Outlook plugin configuration/);
  });

  it('lets PLUGIN_ALLOW_WRITES=true override the file value', () => {
    process.env.PLUGIN_ALLOW_WRITES = 'true';
    try {
      const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: false })));
      expect(config.allowWrites).toBe(true);
    } finally {
      delete process.env.PLUGIN_ALLOW_WRITES;
    }
  });

  it('lets PLUGIN_ALLOW_WRITES=false force writes off even when the file enables them', () => {
    process.env.PLUGIN_ALLOW_WRITES = 'false';
    try {
      const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: true })));
      expect(config.allowWrites).toBe(false);
    } finally {
      delete process.env.PLUGIN_ALLOW_WRITES;
    }
  });

  it('falls back to the file value when the env override is absent', () => {
    delete process.env.PLUGIN_ALLOW_WRITES;
    const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: true })));
    expect(config.allowWrites).toBe(true);
  });

  it('falls back to the file value when the env override is an empty/whitespace string', () => {
    process.env.PLUGIN_ALLOW_WRITES = '   ';
    try {
      const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: true })));
      expect(config.allowWrites).toBe(true);
    } finally {
      delete process.env.PLUGIN_ALLOW_WRITES;
    }
  });

  it.each(['TRUE', ' True ', '1', 'yes', 'on', 'ON'])(
    'normalizes truthy spelling %j for PLUGIN_ALLOW_WRITES',
    (value) => {
      process.env.PLUGIN_ALLOW_WRITES = value;
      try {
        const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: false })));
        expect(config.allowWrites).toBe(true);
      } finally {
        delete process.env.PLUGIN_ALLOW_WRITES;
      }
    }
  );

  it.each(['FALSE', ' False ', '0', 'no', 'off', 'OFF'])(
    'normalizes falsy spelling %j for PLUGIN_ALLOW_WRITES',
    (value) => {
      process.env.PLUGIN_ALLOW_WRITES = value;
      try {
        const config = loadPluginConfig(writeConfig(validConfig({ allowWrites: true })));
        expect(config.allowWrites).toBe(false);
      } finally {
        delete process.env.PLUGIN_ALLOW_WRITES;
      }
    }
  );

  it.each(['yesplease', '2', 'truthy', 'enabled'])(
    'fails closed on an unrecognized PLUGIN_ALLOW_WRITES spelling %j instead of silently defaulting',
    (value) => {
      process.env.PLUGIN_ALLOW_WRITES = value;
      try {
        expect(() => loadPluginConfig(writeConfig(validConfig({ allowWrites: false })))).toThrow(
          /PLUGIN_ALLOW_WRITES must be a boolean value/
        );
      } finally {
        delete process.env.PLUGIN_ALLOW_WRITES;
      }
    }
  );

  it.each(['TRUE', '1', 'yes', 'on'])(
    'enables local handoffs only for a recognized PLUGIN_ALLOW_LOCAL_HANDOFFS value %j',
    (value) => {
      process.env.PLUGIN_ALLOW_LOCAL_HANDOFFS = value;
      try {
        expect(loadPluginConfig(writeConfig(validConfig())).allowLocalHandoffs).toBe(true);
      } finally {
        delete process.env.PLUGIN_ALLOW_LOCAL_HANDOFFS;
      }
    }
  );

  it('fails closed on an unrecognized PLUGIN_ALLOW_LOCAL_HANDOFFS value', () => {
    process.env.PLUGIN_ALLOW_LOCAL_HANDOFFS = 'enabled';
    try {
      expect(() => loadPluginConfig(writeConfig(validConfig()))).toThrow(
        /PLUGIN_ALLOW_LOCAL_HANDOFFS must be a boolean value/
      );
    } finally {
      delete process.env.PLUGIN_ALLOW_LOCAL_HANDOFFS;
    }
  });

  it('lets PLUGIN_SEARCH_MEMORY_PATH override the file value', () => {
    process.env.PLUGIN_SEARCH_MEMORY_PATH = '/tmp/memory.yaml';
    try {
      const config = loadPluginConfig(writeConfig(validConfig()));
      expect(config.searchMemoryPath).toBe('/tmp/memory.yaml');
    } finally {
      delete process.env.PLUGIN_SEARCH_MEMORY_PATH;
    }
  });
});
