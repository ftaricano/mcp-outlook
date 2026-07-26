import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPluginConsoleGuard } from '../../src/plugin/logging.js';

const originalConsole = {
  debug: console.debug,
  info: console.info,
  log: console.log,
  warn: console.warn,
  error: console.error,
};

afterEach(() => {
  Object.assign(console, originalConsole);
});

describe('installPluginConsoleGuard', () => {
  it('suppresses legacy console output in plugin processes', () => {
    const output = vi.fn();
    console.error = output;

    installPluginConsoleGuard();
    console.error('mailbox@example.com', 'subject', 'raw Graph error');

    expect(output).not.toHaveBeenCalled();
  });
});
