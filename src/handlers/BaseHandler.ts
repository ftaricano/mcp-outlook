import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';
import { redactSecrets } from '../utils/redactSecrets.js';

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
 * advertising security features that did not exist. The `validateRequiredArgs`
 * helper went the same way: Zod (with non-empty constraints on required
 * fields) is the single validation gate, so the runtime no-op was redundant.
 */
export abstract class BaseHandler {
  protected readonly emailService: EmailService;
  protected readonly emailSummarizer: EmailSummarizer;

  constructor(emailService: EmailService, emailSummarizer: EmailSummarizer) {
    this.emailService = emailService;
    this.emailSummarizer = emailSummarizer;
  }

  protected formatError(message: string, error?: unknown): HandlerResult {
    const rawMessage = error instanceof Error ? error.message : 'Erro desconhecido';
    // The raw Graph/runtime message can carry a token, address or password;
    // redact before it crosses the MCP boundary.
    const errorMessage = redactSecrets(rawMessage);
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
}
