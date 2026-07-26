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
