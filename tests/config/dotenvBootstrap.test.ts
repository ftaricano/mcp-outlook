import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const entrypoints = ['dist/index.js', 'dist/plugin/stdio.js', 'dist/plugin/http.js'];

function loadEntrypointEnvironment(
  entrypoint: string,
  extraEnv: NodeJS.ProcessEnv = {},
  withEnvFile = true
) {
  const directory = mkdtempSync(join(tmpdir(), 'outlook-dotenv-bootstrap-'));
  try {
    if (withEnvFile) {
      writeFileSync(join(directory, '.env'), 'PLUGIN_ALLOW_SEND=true\nQA_DOTENV_MARKER=cwd-file\n');
    }
    const alternate = join(directory, 'alternate.env');
    writeFileSync(alternate, 'PLUGIN_ALLOW_SEND=true\nQA_DOTENV_MARKER=alternate-file\n');
    const observer = join(directory, 'observe-dotenv.cjs');
    // Stop after the real bootstrap config call, before Keychain or Graph can run.
    writeFileSync(
      observer,
      `const { createRequire, syncBuiltinESMExports } = require('node:module');
const refuseExternalEffects = () => {
  throw new Error('Fixture refused an external effect before dotenv bootstrap');
};
globalThis.fetch = refuseExternalEffects;
require('node:net').Socket.prototype.connect = refuseExternalEffects;
for (const name of ['node:http', 'node:https']) {
  require(name).request = refuseExternalEffects;
  require(name).get = refuseExternalEffects;
}
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  require('node:child_process')[name] = refuseExternalEffects;
}
syncBuiltinESMExports();
const dotenv = createRequire(${JSON.stringify(resolve(entrypoint))})('dotenv');
const config = dotenv.config;
dotenv.config = (options) => {
  const result = config(options);
  process.stdout.write(JSON.stringify({
    send: process.env.PLUGIN_ALLOW_SEND,
    marker: process.env.QA_DOTENV_MARKER ?? null,
    error: result.error?.code ?? null,
    parsedKeys: Object.keys(result.parsed ?? {}).sort(),
  }) + '\\n');
  process.exit(0);
};
`
    );
    return spawnSync(process.execPath, ['--require', observer, resolve(entrypoint)], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PLUGIN_ALLOW_SEND: 'false',
        ...Object.fromEntries(
          Object.entries(extraEnv).map(([key, value]) => [
            key,
            value === '<alternate>' ? alternate : value,
          ])
        ),
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.each(entrypoints)('dotenv bootstrap: %s', (entrypoint) => {
  it.each(['DOTENV_OVERRIDE', 'DOTENV_CONFIG_OVERRIDE'])(
    'keeps explicit send refusal when %s requests an override',
    (variable) => {
      const result = loadEntrypointEnvironment(entrypoint, { [variable]: 'true' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        send: 'false',
        marker: 'cwd-file',
        error: null,
        parsedKeys: ['PLUGIN_ALLOW_SEND', 'QA_DOTENV_MARKER'],
      });
    }
  );

  it.each(['DOTENV_PATH', 'DOTENV_CONFIG_PATH'])(
    'loads the cwd file instead of the ambient %s path',
    (variable) => {
      const result = loadEntrypointEnvironment(entrypoint, { [variable]: '<alternate>' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).marker).toBe('cwd-file');
    }
  );

  it('keeps stdout and stderr quiet despite ambient dotenv logging flags', () => {
    const result = loadEntrypointEnvironment(entrypoint, {
      DOTENV_DEBUG: 'true',
      DOTENV_CONFIG_DEBUG: 'true',
      DOTENV_QUIET: 'false',
      DOTENV_CONFIG_QUIET: 'false',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${JSON.stringify({
        send: 'false',
        marker: 'cwd-file',
        error: null,
        parsedKeys: ['PLUGIN_ALLOW_SEND', 'QA_DOTENV_MARKER'],
      })}\n`
    );
  });

  it('returns a missing-file error without throwing or printing', () => {
    const result = loadEntrypointEnvironment(entrypoint, {}, false);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      send: 'false',
      marker: null,
      error: 'ENOENT',
      parsedKeys: [],
    });
  });
});
