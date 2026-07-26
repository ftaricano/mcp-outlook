import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirectories: string[] = [];
const repoRoot = resolve(import.meta.dirname, '../..');

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('plugin packaging', () => {
  it('declares the local Codex plugin and MCP entrypoint', () => {
    const plugin = JSON.parse(readFileSync(join(repoRoot, '.codex-plugin/plugin.json'), 'utf8'));
    const mcp = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf8'));

    expect(plugin).toMatchObject({
      name: 'outlook-multi-mailbox',
      version: '2.2.0',
      description: 'Read-only Outlook search across explicitly allowed mailboxes',
      author: { name: 'Fernando Taricano' },
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Outlook Multi-Mailbox',
        shortDescription: 'Search allowed Outlook mail',
        developerName: 'Fernando Taricano',
        category: 'Productivity',
        capabilities: ['Read'],
        composerIcon: './assets/icon.svg',
        logo: './assets/icon.svg',
      },
    });
    expect(plugin).not.toHaveProperty('apps');
    expect(mcp.mcpServers.outlook_multi_mailbox.args).toEqual([
      '${CODEX_PLUGIN_ROOT}/dist/plugin/stdio.js',
    ]);
  });

  it('generates an app manifest only from a real-looking connection ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-outlook-app-manifest-'));
    temporaryDirectories.push(directory);
    const output = join(directory, '.app.json');
    const pluginManifest = join(directory, 'plugin.json');
    writeFileSync(
      pluginManifest,
      JSON.stringify({
        name: 'outlook-multi-mailbox',
        version: '2.2.0',
        description: 'test',
      })
    );

    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'scripts/generate-app-manifest.js'),
        '--connection-id',
        'plugin_asdk_app_123',
        '--output',
        output,
        '--plugin-manifest',
        pluginManifest,
      ],
      { stdio: 'pipe' }
    );

    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      apps: {
        outlook_multi_mailbox: {
          id: 'asdk_app_123',
          required: true,
        },
      },
    });
    expect(JSON.parse(readFileSync(pluginManifest, 'utf8'))).toMatchObject({
      apps: './.app.json',
    });
    expect(() =>
      execFileSync(
        process.execPath,
        [
          join(repoRoot, 'scripts/generate-app-manifest.js'),
          '--connection-id',
          'invented-id',
          '--output',
          join(directory, 'invalid.json'),
          '--plugin-manifest',
          pluginManifest,
        ],
        { stdio: 'pipe' }
      )
    ).toThrow();
  });
});
