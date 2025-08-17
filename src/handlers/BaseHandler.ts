import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';
import { SecurityManager } from '../security/securityManager.js';
import { MCPBestPractices } from '../utils/mcpBestPractices.js';

export interface HandlerResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export abstract class BaseHandler {
  protected emailService: EmailService;
  protected emailSummarizer: EmailSummarizer;
  protected securityManager: SecurityManager;
  protected mcpBestPractices: MCPBestPractices;

  constructor(
    emailService: EmailService, 
    emailSummarizer: EmailSummarizer,
    securityManager: SecurityManager,
    mcpBestPractices: MCPBestPractices
  ) {
    this.emailService = emailService;
    this.emailSummarizer = emailSummarizer;
    this.securityManager = securityManager;
    this.mcpBestPractices = mcpBestPractices;
  }

  /**
   * Format error response consistently
   */
  protected formatError(message: string, error?: unknown): HandlerResult {
    const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
    return {
      content: [
        {
          type: 'text',
          text: `❌ ${message}: ${errorMessage}`
        }
      ],
      isError: true
    };
  }

  /**
   * Format success response consistently
   */
  protected formatSuccess(message: string): HandlerResult {
    return {
      content: [
        {
          type: 'text',
          text: message
        }
      ]
    };
  }

  /**
   * Validate required arguments
   */
  protected validateRequiredArgs(args: any, required: string[]): string | null {
    for (const field of required) {
      if (!args[field]) {
        return `Campo obrigatório ausente: ${field}`;
      }
    }
    return null;
  }

  /**
   * Validate and secure tool input using MCP best practices
   */
  protected validateToolInput(toolName: string, args: any): HandlerResult | null {
    try {
      // Sanitize input for security
      const sanitizedArgs = this.securityManager.sanitizeInput(args);
      
      // Validate according to MCP best practices
      const validation = this.mcpBestPractices.validateToolInput(toolName, sanitizedArgs);
      
      if (!validation.isValid) {
        return this.formatError(`Validação de entrada falhou para ${toolName}`, new Error(validation.errors.join(', ')));
      }

      // Log warnings if any
      if (validation.warnings.length > 0) {
        console.warn(`⚠️ Avisos para ${toolName}:`, validation.warnings);
      }

      // Log suggestions for optimization
      if (validation.suggestions.length > 0) {
        console.info(`💡 Sugestões para ${toolName}:`, validation.suggestions);
      }

      return null; // No validation errors
    } catch (error) {
      return this.formatError('Erro na validação de segurança', error);
    }
  }

  /**
   * Create audit entry for operation
   */
  protected createAuditEntry(operation: string, args: any, result: 'success' | 'failure'): void {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'system';
      this.securityManager.createAuditEntry(operation, userEmail, args, result);
    } catch (error) {
      console.error('❌ Failed to create audit entry:', error);
    }
  }

  /**
   * Check permissions for operation
   */
  protected checkPermissions(operation: string, args: any): HandlerResult | null {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'system';
      const permissionCheck = this.securityManager.validatePermissions(operation, userEmail, args);
      
      if (!permissionCheck.allowed) {
        return this.formatError(`Permissão negada para ${operation}`, new Error(permissionCheck.reason || 'Acesso não autorizado'));
      }

      return null; // Permission granted
    } catch (error) {
      return this.formatError('Erro na verificação de permissões', error);
    }
  }

  /**
   * Execute operation with full security and audit trail
   */
  protected async executeSecureOperation<T>(
    toolName: string,
    args: any,
    operation: () => Promise<T>
  ): Promise<T> {
    // 1. Validate input
    const inputValidation = this.validateToolInput(toolName, args);
    if (inputValidation) {
      this.createAuditEntry(toolName, args, 'failure');
      throw new Error('Input validation failed');
    }

    // 2. Check permissions
    const permissionCheck = this.checkPermissions(toolName, args);
    if (permissionCheck) {
      this.createAuditEntry(toolName, args, 'failure');
      throw new Error('Permission denied');
    }

    try {
      // 3. Execute operation
      const result = await operation();
      
      // 4. Create success audit entry
      this.createAuditEntry(toolName, args, 'success');
      
      return result;
    } catch (error) {
      // 5. Create failure audit entry
      this.createAuditEntry(toolName, args, 'failure');
      throw error;
    }
  }
}