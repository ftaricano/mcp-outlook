import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('keychain miss (mocked)');
  }),
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_PLATFORM = process.platform;

beforeEach(() => {
  // Force the darwin code path regardless of the host running the tests
  // (Linux CI, container, etc.). Without this, the `if (platform !== 'darwin')
  // return` guard inside bootstrapKeychain causes the suite to "pass" by
  // skipping every assertion on non-macOS hosts. Flagged by the Codex review
  // of PR #34.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

  Object.keys(process.env)
    .filter((k) => k.startsWith('MICROSOFT_GRAPH_') || k.startsWith('OUTLOOK_KEYCHAIN_'))
    .forEach((k) => delete process.env[k]);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  vi.restoreAllMocks();
  Object.keys(process.env).forEach((k) => {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  });
  Object.assign(process.env, ORIGINAL_ENV);
});

async function loadBootstrap() {
  vi.resetModules();
  return await import('../../src/config/keychain.js');
}

describe('bootstrapKeychain — darwin path (JAR-259)', () => {
  it('does not warn when all required vars are already set in env', async () => {
    process.env.MICROSOFT_GRAPH_CLIENT_ID = 'preset-id';
    process.env.MICROSOFT_GRAPH_CLIENT_SECRET = 'preset-secret';
    process.env.MICROSOFT_GRAPH_TENANT_ID = 'preset-tenant';
    process.env.TARGET_USER_EMAIL = 'user@example.com';

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { bootstrapKeychain } = await loadBootstrap();
    bootstrapKeychain();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about each unresolved variable and the services it tried', async () => {
    // No env set, mocked Keychain throws on every lookup → every var stays unresolved.
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { bootstrapKeychain } = await loadBootstrap();
    bootstrapKeychain();

    expect(warn).toHaveBeenCalled();
    const output = warn.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('MICROSOFT_GRAPH_CLIENT_ID');
    expect(output).toContain('mcp-outlook::MICROSOFT_GRAPH_CLIENT_ID');
    // The warning has to mention the env-var escape hatch so the operator
    // can wire up an existing Keychain entry (e.g. cpz::SP_CLIENT_ID) without
    // having to read source code.
    expect(output).toMatch(/OUTLOOK_KEYCHAIN_.+_SERVICES/);
  });

  it('lists fallback services passed via OUTLOOK_KEYCHAIN_*_SERVICES', async () => {
    process.env.OUTLOOK_KEYCHAIN_MICROSOFT_GRAPH_CLIENT_ID_SERVICES =
      'cpz::SP_CLIENT_ID,other::CLIENT_ID';

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { bootstrapKeychain } = await loadBootstrap();
    bootstrapKeychain();

    const output = warn.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('cpz::SP_CLIENT_ID');
    expect(output).toContain('other::CLIENT_ID');
  });

  it('stays quiet when OUTLOOK_KEYCHAIN_QUIET is set (CI / tests)', async () => {
    process.env.OUTLOOK_KEYCHAIN_QUIET = '1';

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { bootstrapKeychain } = await loadBootstrap();
    bootstrapKeychain();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('bootstrapKeychain — non-darwin path', () => {
  it('returns silently and touches nothing on non-darwin hosts', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { bootstrapKeychain } = await loadBootstrap();
    bootstrapKeychain();
    expect(warn).not.toHaveBeenCalled();
    expect(process.env.MICROSOFT_GRAPH_CLIENT_ID).toBeUndefined();
  });
});
