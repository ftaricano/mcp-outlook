/**
 * Minimal stderr-only structured logger.
 *
 * Replaces AdvancedLogger (737 LoC) + IntegratedMonitoring (816 LoC) +
 * PerformanceMonitor (497 LoC). All three were initialized with their
 * features disabled (no file/console sink, no real-time alerts), so the
 * weight was pure dead code.
 *
 * Logs are written to stderr because stdout is the MCP transport channel —
 * writing to stdout would corrupt JSON-RPC frames.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LogFields {
  operation?: string;
  toolName?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerOptions {
  level: LogLevel;
  name: string;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly name: string;

  constructor(opts: LoggerOptions) {
    this.level = opts.level;
    this.name = opts.name;
  }

  error(message: string, error?: unknown, fields?: LogFields): void {
    if (!this.enabled('error')) return;
    this.emit('error', message, this.mergeError(error, fields));
  }

  warn(message: string, fields?: LogFields): void {
    if (!this.enabled('warn')) return;
    this.emit('warn', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    if (!this.enabled('info')) return;
    this.emit('info', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    if (!this.enabled('debug')) return;
    this.emit('debug', message, fields);
  }

  /**
   * Time a block and log its duration. Returns the block's result or
   * re-throws the error after logging it.
   */
  async time<T>(
    operation: string,
    block: () => Promise<T>,
    extra?: Omit<LogFields, 'operation' | 'durationMs' | 'error'>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await block();
      this.debug(`${operation} ok`, {
        ...extra,
        operation,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.error(`${operation} failed`, err, {
        ...extra,
        operation,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.level];
  }

  private mergeError(error: unknown, fields?: LogFields): LogFields {
    if (!error) return fields ?? {};
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      ...fields,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    };
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      name: this.name,
      msg: message,
      ...(fields ?? {}),
    };
    // Single-line JSON to stderr — easy for ops tooling to parse.
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}
