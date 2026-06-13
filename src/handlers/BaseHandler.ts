import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';
import { redactSecrets, formatRedactedError } from '../utils/redactSecrets.js';

export interface HandlerResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Common base for every tool handler. Intentionally thin: validation lives
 * in `HandlerRegistry` (Zod), path enforcement lives in `pathGuard`, and
 * Graph calls live in `EmailService`. This class only owns response shape.
 *
 * We used to carry a `SecurityManager`/`MCPBestPractices` pair here and a
 * suite of `validateToolInput` / `checkPermissions` / `createAuditEntry` /
 * `executeSecureOperation` helpers — none of them were invoked by any
 * concrete handler. They were removed in the P0 audit cleanup to stop
 * advertising security features that did not exist. The old per-handler
 * required-args helper went the same way: Zod (with non-empty constraints on
 * required fields) is the single validation gate, so the runtime no-op was
 * redundant.
 */
export abstract class BaseHandler {
  protected readonly emailService: EmailService;
  protected readonly emailSummarizer: EmailSummarizer;

  constructor(emailService: EmailService, emailSummarizer: EmailSummarizer) {
    this.emailService = emailService;
    this.emailSummarizer = emailSummarizer;
  }

  protected formatError(message: string, error?: unknown): HandlerResult {
    // Redact the WHOLE line: handlers sometimes interpolate a raw Graph error
    // straight into `message` (e.g. `Falha no download: ${result.error}`), so
    // masking only the detail would still leak a token/address/password across
    // the MCP boundary. Shared with the top-level catch in index.ts.
    return {
      content: [{ type: 'text', text: formatRedactedError(`❌ ${message}`, error) }],
      isError: true,
    };
  }

  /**
   * Redact a raw error string before it is interpolated into an otherwise
   * success-shaped result — e.g. per-item failures in batch/folder operations
   * that are reported through `formatSuccess`, not `formatError`.
   */
  protected redactError(error: unknown): string {
    return redactSecrets(error == null ? '' : String(error));
  }

  protected formatSuccess(message: string): HandlerResult {
    return {
      content: [{ type: 'text', text: message }],
    };
  }
}
