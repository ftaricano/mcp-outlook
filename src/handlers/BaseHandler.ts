import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';

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
 * advertising security features that did not exist.
 */
export abstract class BaseHandler {
  protected readonly emailService: EmailService;
  protected readonly emailSummarizer: EmailSummarizer;

  constructor(emailService: EmailService, emailSummarizer: EmailSummarizer) {
    this.emailService = emailService;
    this.emailSummarizer = emailSummarizer;
  }

  protected formatError(message: string, error?: unknown): HandlerResult {
    const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
    return {
      content: [
        {
          type: 'text',
          text: `❌ ${message}: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }

  protected formatSuccess(message: string): HandlerResult {
    return {
      content: [{ type: 'text', text: message }],
    };
  }

  /**
   * Defence-in-depth: Zod already validates required fields in
   * `HandlerRegistry`, so this helper is effectively a no-op at runtime.
   * Kept because concrete handlers still call it and removing the call
   * sites is out of scope for the security-focused audit sweep.
   */
  protected validateRequiredArgs(args: Record<string, unknown>, required: string[]): string | null {
    for (const field of required) {
      const v = args?.[field];
      if (v == null || v === '') {
        return `Campo obrigatório ausente: ${field}`;
      }
    }
    return null;
  }
}
