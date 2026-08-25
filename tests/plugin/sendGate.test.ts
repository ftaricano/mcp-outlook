import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig, PluginConfigError } from '../../src/plugin/config.js';
import { MailboxOperationError, MultiMailboxService } from '../../src/plugin/MultiMailboxService.js';

const tempDirectories: string[] = [];

function writeConfig(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-outlook-send-gate-'));
  tempDirectories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      mailboxes: [
        { alias: 'finance', address: 'finance@example.com' },
        { alias: 'robot', address: 'robot@example.com' },
      ],
    }),
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
  return path;
}

const SEND_ENV = ['PLUGIN_ALLOW_SEND', 'OUTLOOK_SEND_FROM', 'OUTLOOK_ALLOWED_SENDERS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SEND_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SEND_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('plugin send gate configuration', () => {
  it('is off by default, with no sending mailbox resolved', () => {
    const config = loadPluginConfig(writeConfig());
    expect(config.allowSend).toBe(false);
    expect(config.sendFromAlias).toBeUndefined();
  });

  it('has no config-file fallback: only the environment can enable it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-outlook-send-gate-'));
    tempDirectories.push(directory);
    const path = join(directory, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        mailboxes: [{ alias: 'robot', address: 'robot@example.com' }],
        allowSend: true,
      }),
      { mode: 0o600 }
    );
    chmodSync(path, 0o600);

    // strictObject: an unknown key is a hard error, so a config file cannot
    // even claim this capability, let alone be believed about it.
    expect(() => loadPluginConfig(path)).toThrow(PluginConfigError);
  });

  it('refuses to start when enabled without a sending mailbox', () => {
    process.env.PLUGIN_ALLOW_SEND = 'true';
    process.env.OUTLOOK_ALLOWED_SENDERS = 'robot@example.com';
    expect(() => loadPluginConfig(writeConfig())).toThrow(PluginConfigError);
  });

  it('refuses a sending mailbox that is not in the plugin allowlist', () => {
    process.env.PLUGIN_ALLOW_SEND = 'true';
    process.env.OUTLOOK_SEND_FROM = 'stranger@example.com';
    process.env.OUTLOOK_ALLOWED_SENDERS = 'stranger@example.com';
    expect(() => loadPluginConfig(writeConfig())).toThrow(PluginConfigError);
  });

  it('refuses to start when the outbound gate is absent', () => {
    process.env.PLUGIN_ALLOW_SEND = 'true';
    process.env.OUTLOOK_SEND_FROM = 'robot@example.com';
    expect(() => loadPluginConfig(writeConfig())).toThrow(PluginConfigError);
  });

  it('refuses a sending mailbox the outbound gate does not cover', () => {
    process.env.PLUGIN_ALLOW_SEND = 'true';
    process.env.OUTLOOK_SEND_FROM = 'robot@example.com';
    process.env.OUTLOOK_ALLOWED_SENDERS = 'finance@example.com';
    expect(() => loadPluginConfig(writeConfig())).toThrow(PluginConfigError);
  });

  it('resolves the sending alias when every condition holds', () => {
    process.env.PLUGIN_ALLOW_SEND = 'true';
    process.env.OUTLOOK_SEND_FROM = 'Robot@Example.com';
    process.env.OUTLOOK_ALLOWED_SENDERS = 'robot@example.com';

    const config = loadPluginConfig(writeConfig());
    expect(config.allowSend).toBe(true);
    expect(config.sendFromAlias).toBe('robot');
  });
});

describe('MultiMailboxService.sendMessage', () => {
  function makeService(overrides: Record<string, unknown>) {
    const sent: Array<{ address: string; to: string[] }> = [];
    const config = {
      mailboxes: [
        { alias: 'finance', address: 'finance@example.com' },
        { alias: 'robot', address: 'robot@example.com' },
      ],
      mailboxesByAlias: new Map([
        ['finance', { alias: 'finance', address: 'finance@example.com' }],
        ['robot', { alias: 'robot', address: 'robot@example.com' }],
      ]),
      allowLocalHandoffs: false,
      ...overrides,
    };

    const service = new MultiMailboxService(config as never, (address) => {
      return {
        sendEmail: async (to: string[]) => {
          sent.push({ address, to });
          return { success: true };
        },
      } as never;
    });

    return { service, sent };
  }

  const message = { to: ['someone@example.com'], subject: 'S', body: 'B' };

  it('refuses when the gate is off, even though the method exists', async () => {
    const { service, sent } = makeService({ allowSend: false, sendFromAlias: undefined });
    await expect(service.sendMessage(message)).rejects.toThrow(MailboxOperationError);
    expect(sent).toHaveLength(0);
  });

  it('refuses when the gate is on but no mailbox was pinned', async () => {
    const { service, sent } = makeService({ allowSend: true, sendFromAlias: undefined });
    await expect(service.sendMessage(message)).rejects.toThrow(MailboxOperationError);
    expect(sent).toHaveLength(0);
  });

  it('always sends from the pinned mailbox, which no caller can name', async () => {
    const { service, sent } = makeService({ allowSend: true, sendFromAlias: 'robot' });

    await service.sendMessage(message);

    expect(sent).toEqual([{ address: 'robot@example.com', to: ['someone@example.com'] }]);
  });

  it('counts every recipient class in the receipt', async () => {
    const { service } = makeService({ allowSend: true, sendFromAlias: 'robot' });

    const result = await service.sendMessage({
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 'S',
      body: 'B',
    });

    expect(result).toEqual({ mailbox: 'robot', recipients: 4 });
  });

  it('does not leak the underlying failure to the caller', async () => {
    const failing = new MultiMailboxService(
      {
        mailboxes: [{ alias: 'robot', address: 'robot@example.com' }],
        mailboxesByAlias: new Map([['robot', { alias: 'robot', address: 'robot@example.com' }]]),
        allowLocalHandoffs: false,
        allowSend: true,
        sendFromAlias: 'robot',
      } as never,
      () =>
        ({
          sendEmail: async () => {
            throw new Error('Falha ao enviar email: robot@example.com quota exceeded');
          },
        }) as never
    );

    await expect(failing.sendMessage(message)).rejects.toThrow(MailboxOperationError);
    await expect(failing.sendMessage(message)).rejects.not.toThrow(/robot@example\.com/);
  });
});
