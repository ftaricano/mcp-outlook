import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/logging/logger.js';
import { installRedactedConsoleError } from '../../src/logging/redactedConsole.js';

const originalConsoleError = console.error;

describe('Logger error output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    console.error = originalConsoleError;
  });

  it('redacts bearer tokens from error messages and stacks written to stderr', () => {
    const token = 'synthetic-bearer-token-0123456789abcdef';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new Logger({ level: 'error', name: 'test' });

    logger.error('Graph request failed', new Error(`authorization failed: Bearer ${token}`));

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Graph request failed');
    expect(output).not.toContain(token);
    expect(output).toContain('Bearer [token]');
  });

  it('redacts Error objects and interpolated values from console.error output', () => {
    const token = 'synthetic-console-token-0123456789abcdef';
    const output = vi.fn();
    console.error = output;

    installRedactedConsoleError();
    console.error('Graph request failed: %s', new Error(`Bearer ${token}`));

    expect(output).toHaveBeenCalledOnce();
    const logged = String(output.mock.calls[0]?.[0]);
    expect(logged).toContain('Graph request failed');
    expect(logged).not.toContain(token);
    expect(logged).toContain('Bearer [token]');
  });

  it('fails closed if formatting an error log throws', () => {
    const token = 'synthetic-inspect-token-0123456789abcdef';
    const output = vi.fn();
    const failingInspectable = {
      [Symbol.for('nodejs.util.inspect.custom')]: () => {
        throw new Error(`Bearer ${token}`);
      },
    };
    console.error = output;

    installRedactedConsoleError();
    console.error('Graph request failed', failingInspectable);

    expect(output).toHaveBeenCalledWith('[redacted error log]');
    expect(JSON.stringify(output.mock.calls)).not.toContain(token);
  });
});
