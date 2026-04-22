/**
 * Centralized error handling for MCP Email Server
 * Provides consistent error responses and logging
 */

export interface ErrorContext {
  operation: string;
  emailId?: string;
  attachmentId?: string;
  userEmail?: string;
  metadata?: Record<string, any>;
}

export interface StandardError {
  code: string;
  message: string;
  details?: string;
  retryable: boolean;
  context?: ErrorContext;
}

export class ErrorHandler {
  private static errorCounts: Map<string, number> = new Map();
  
  /**
   * Handle and format errors consistently
   */
  static handleError(error: unknown, context: ErrorContext): StandardError {
    const standardError = this.classifyError(error, context);
    this.logError(standardError);
    this.trackError(standardError.code);
    
    return standardError;
  }

  /**
   * Classify error types and create standard response
   */
  private static classifyError(error: unknown, context: ErrorContext): StandardError {
    // Microsoft Graph API errors
    if (this.isGraphAPIError(error)) {
      return this.handleGraphAPIError(error, context);
    }
    
    // Network errors
    if (this.isNetworkError(error)) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Erro de conectividade de rede',
        details: error instanceof Error ? error.message : 'Conexão falhou',
        retryable: true,
        context
      };
    }
    
    // Authentication errors
    if (this.isAuthError(error)) {
      return {
        code: 'AUTH_ERROR',
        message: 'Erro de autenticação',
        details: 'Token expirado ou inválido. Reautenticação necessária.',
        retryable: false,
        context
      };
    }
    
    // Rate limiting errors
    if (this.isRateLimitError(error)) {
      return {
        code: 'RATE_LIMIT_ERROR',
        message: 'Limite de requisições excedido',
        details: 'Muitas requisições. Tente novamente em alguns minutos.',
        retryable: true,
        context
      };
    }
    
    // File system errors
    if (this.isFileSystemError(error)) {
      return {
        code: 'FILE_SYSTEM_ERROR',
        message: 'Erro no sistema de arquivos',
        details: error instanceof Error ? error.message : 'Operação de arquivo falhou',
        retryable: false,
        context
      };
    }
    
    // Validation errors
    if (this.isValidationError(error)) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'Erro de validação',
        details: error instanceof Error ? error.message : 'Dados inválidos fornecidos',
        retryable: false,
        context
      };
    }
    
    // Generic/unknown errors
    return {
      code: 'UNKNOWN_ERROR',
      message: 'Erro interno do servidor',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
      retryable: false,
      context
    };
  }

  /**
   * Handle Microsoft Graph API specific errors
   */
  private static handleGraphAPIError(error: any, context: ErrorContext): StandardError {
    const statusCode = error?.response?.status || error?.status;
    const errorMessage = error?.response?.data?.error?.message || error?.message;
    
    switch (statusCode) {
      case 400:
        return {
          code: 'BAD_REQUEST',
          message: 'Requisição inválida',
          details: errorMessage || 'Parâmetros da requisição são inválidos',
          retryable: false,
          context
        };
        
      case 401:
        return {
          code: 'UNAUTHORIZED',
          message: 'Não autorizado',
          details: 'Token de acesso inválido ou expirado',
          retryable: false,
          context
        };
        
      case 403:
        return {
          code: 'FORBIDDEN',
          message: 'Acesso negado',
          details: 'Permissões insuficientes para esta operação',
          retryable: false,
          context
        };
        
      case 404:
        return {
          code: 'NOT_FOUND',
          message: 'Recurso não encontrado',
          details: `${context.operation} - recurso não existe ou foi deletado`,
          retryable: false,
          context
        };
        
      case 413:
        return {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Anexo muito grande',
          details: 'Arquivo excede o limite de tamanho do Microsoft Graph',
          retryable: false,
          context
        };
        
      case 429:
        return {
          code: 'RATE_LIMITED',
          message: 'Muitas requisições',
          details: 'Limite de taxa excedido. Tente novamente mais tarde.',
          retryable: true,
          context
        };
        
      case 500:
      case 502:
      case 503:
      case 504:
        return {
          code: 'SERVER_ERROR',
          message: 'Erro no servidor Microsoft Graph',
          details: `Erro temporário do servidor (${statusCode}). Tente novamente.`,
          retryable: true,
          context
        };
        
      default:
        return {
          code: 'GRAPH_API_ERROR',
          message: 'Erro na API do Microsoft Graph',
          details: errorMessage || `Código de status: ${statusCode}`,
          retryable: statusCode >= 500,
          context
        };
    }
  }

  /**
   * Check if error is a Microsoft Graph API error
   */
  private static isGraphAPIError(error: any): boolean {
    return error?.response?.status || 
           error?.status || 
           (error?.message && error.message.includes('graph')) ||
           error?.name === 'GraphError';
  }

  /**
   * Check if error is a network error
   */
  private static isNetworkError(error: any): boolean {
    return error?.code === 'ECONNRESET' ||
           error?.code === 'ENOTFOUND' ||
           error?.code === 'ECONNREFUSED' ||
           error?.message?.includes('network') ||
           error?.message?.includes('timeout');
  }

  /**
   * Check if error is an authentication error
   */
  private static isAuthError(error: any): boolean {
    return error?.response?.status === 401 ||
           error?.status === 401 ||
           error?.message?.includes('authentication') ||
           error?.message?.includes('token');
  }

  /**
   * Check if error is a rate limiting error
   */
  private static isRateLimitError(error: any): boolean {
    return error?.response?.status === 429 ||
           error?.status === 429 ||
           error?.message?.includes('rate limit') ||
           error?.message?.includes('too many requests');
  }

  /**
   * Check if error is a file system error
   */
  private static isFileSystemError(error: any): boolean {
    return error?.code?.startsWith('E') && // ENOENT, EACCES, etc.
           (error?.path || error?.syscall) ||
           error?.message?.includes('file') ||
           error?.message?.includes('directory');
  }

  /**
   * Check if error is a validation error
   */
  private static isValidationError(error: any): boolean {
    return error?.name === 'ValidationError' ||
           error?.message?.includes('validation') ||
           error?.message?.includes('invalid') ||
           error?.message?.includes('required');
  }

  /**
   * Log error with appropriate level
   */
  private static logError(error: StandardError): void {
    // Force everything to stderr to avoid breaking MCP protocol on stdout
    const logMessage = `[${error.code}] ${error.message}`;
    
    // console[logLevel] might write to stdout if level is 'log' or 'info'
    console.error(`🔴 ${logMessage}`);
    
    if (error.details) {
      console.error(`   Details: ${error.details}`);
    }
    
    if (error.context) {
      console.error(`   Context:`, error.context);
    }
  }

  /**
   * Track error frequency for monitoring
   */
  private static trackError(errorCode: string): void {
    const count = this.errorCounts.get(errorCode) || 0;
    this.errorCounts.set(errorCode, count + 1);
    
    // Log warning if error is happening frequently
    if (count > 10) {
      console.warn(`⚠️ Error ${errorCode} has occurred ${count + 1} times`);
    }
  }

  /**
   * Get error statistics
   */
  static getErrorStats(): Map<string, number> {
    return new Map(this.errorCounts);
  }

  /**
   * Clear error statistics
   */
  static clearErrorStats(): void {
    this.errorCounts.clear();
  }

  /**
   * Format error for MCP response
   */
  static formatForMCP(error: StandardError): {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  } {
    let errorText = `❌ ${error.message}`;
    
    if (error.details) {
      errorText += `\n\n📋 Detalhes: ${error.details}`;
    }
    
    if (error.retryable) {
      errorText += `\n\n🔄 Esta operação pode ser tentada novamente.`;
    }
    
    // Add operation context if available
    if (error.context?.operation) {
      errorText += `\n\n🔧 Operação: ${error.context.operation}`;
    }
    
    return {
      content: [
        {
          type: 'text',
          text: errorText
        }
      ],
      isError: true
    };
  }

  /**
   * Create a safe error message (without sensitive details)
   */
  static createSafeErrorMessage(error: StandardError): string {
    // Remove sensitive information from error messages
    const safeMes = error.message
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '[email]') // Remove emails
      .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, '[token]') // Remove tokens
      .replace(/\bpassword\s*[:=]\s*\S+/gi, 'password: [hidden]'); // Remove passwords
      
    return safeMes;
  }
}