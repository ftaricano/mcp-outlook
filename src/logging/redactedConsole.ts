import { format } from 'node:util';
import { redactSecrets } from '../utils/redactSecrets.js';

const REDACTED_CONSOLE_ERROR = Symbol.for('mcp-outlook.redactedConsoleError');
type GuardedConsoleError = typeof console.error & { [REDACTED_CONSOLE_ERROR]?: true };

export function installRedactedConsoleError(): void {
  const original = console.error as GuardedConsoleError;
  if (original[REDACTED_CONSOLE_ERROR]) return;

  const guarded = (...args: Parameters<typeof console.error>): void => {
    let message: string;
    try {
      message = redactSecrets(format(...args));
    } catch {
      message = '[redacted error log]';
    }
    original.call(console, message);
  };

  Object.defineProperty(guarded, REDACTED_CONSOLE_ERROR, { value: true });
  console.error = guarded;
}
