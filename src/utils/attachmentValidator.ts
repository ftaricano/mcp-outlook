import { EmailAttachment } from '../services/emailService.js';

export interface AttachmentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  info: {
    sizeInBytes: number;
    sizeInMB: number;
    needsUploadSession: boolean;
    mimeTypeDetected: string;
    base64Valid: boolean;
  };
}

export class AttachmentValidator {
  // Limites do Microsoft Graph API
  private static readonly MAX_ATTACHMENT_SIZE = 3 * 1024 * 1024; // 3MB
  private static readonly MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25MB por email
  private static readonly MAX_ATTACHMENT_COUNT = 100;

  // MIME types comuns para boletos
  private static readonly BOLETO_MIME_TYPES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/bmp',
    'image/tiff'
  ];

  /**
   * Valida um anexo individual
   */
  static validateAttachment(attachment: EmailAttachment): AttachmentValidationResult {
    const result: AttachmentValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      info: {
        sizeInBytes: 0,
        sizeInMB: 0,
        needsUploadSession: false,
        mimeTypeDetected: attachment.contentType,
        base64Valid: false
      }
    };

    // Validação básica de campos obrigatórios
    if (!attachment.name || attachment.name.trim() === '') {
      result.errors.push('Nome do arquivo é obrigatório');
      result.isValid = false;
    }

    if (!attachment.contentType || attachment.contentType.trim() === '') {
      result.errors.push('Tipo de conteúdo (MIME type) é obrigatório');
      result.isValid = false;
    }

    if (!attachment.content || attachment.content.trim() === '') {
      result.errors.push('Conteúdo do arquivo é obrigatório');
      result.isValid = false;
    }

    // Se campos básicos estão ausentes, não continuar validação
    if (!result.isValid) {
      return result;
    }

    // Validação do Base64
    const base64Validation = this.validateBase64(attachment.content);
    result.info.base64Valid = base64Validation.isValid;
    if (!base64Validation.isValid) {
      result.errors.push(...base64Validation.errors);
      result.isValid = false;
    }

    // Calcular tamanho real do arquivo
    const cleanBase64 = this.cleanBase64(attachment.content);
    result.info.sizeInBytes = this.calculateBase64Size(cleanBase64);
    result.info.sizeInMB = result.info.sizeInBytes / (1024 * 1024);

    // Verificar se precisa de upload session (>3MB)
    result.info.needsUploadSession = result.info.sizeInBytes > this.MAX_ATTACHMENT_SIZE;

    // Validação de tamanho
    if (result.info.sizeInBytes > this.MAX_ATTACHMENT_SIZE) {
      result.errors.push(
        `Arquivo muito grande: ${result.info.sizeInMB.toFixed(2)}MB. ` +
        `Limite para anexos simples: 3MB. ` +
        `Arquivos maiores requerem upload session (não implementado ainda).`
      );
      result.isValid = false;
    }

    // Validação de MIME type
    if (!this.isValidMimeType(attachment.contentType)) {
      result.warnings.push(`MIME type não reconhecido: ${attachment.contentType}`);
    }

    // Detecção específica para boletos
    if (this.isBoletoFile(attachment.name, attachment.contentType)) {
      result.info.mimeTypeDetected = 'Boleto detectado';
      if (!this.BOLETO_MIME_TYPES.includes(attachment.contentType.toLowerCase())) {
        result.warnings.push(
          `MIME type incomum para boleto: ${attachment.contentType}. ` +
          `Recomendado: application/pdf para PDFs ou image/* para imagens`
        );
      }
    }

    // Verificar consistência de tamanho informado
    if (attachment.size && Math.abs(attachment.size - result.info.sizeInBytes) > 1000) {
      result.warnings.push(
        `Tamanho informado (${attachment.size} bytes) difere do calculado (${result.info.sizeInBytes} bytes)`
      );
    }

    return result;
  }

  /**
   * Valida um array de anexos
   */
  static validateAttachments(attachments: EmailAttachment[]): {
    isValid: boolean;
    results: AttachmentValidationResult[];
    totalSize: number;
    errors: string[];
    warnings: string[];
  } {
    const results = attachments.map(att => this.validateAttachment(att));
    const totalSize = results.reduce((sum, result) => sum + result.info.sizeInBytes, 0);
    
    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    
    results.forEach((result, index) => {
      result.errors.forEach(error => allErrors.push(`Anexo ${index + 1}: ${error}`));
      result.warnings.forEach(warning => allWarnings.push(`Anexo ${index + 1}: ${warning}`));
    });

    // Validações globais
    if (attachments.length > this.MAX_ATTACHMENT_COUNT) {
      allErrors.push(`Muitos anexos: ${attachments.length}. Limite: ${this.MAX_ATTACHMENT_COUNT}`);
    }

    if (totalSize > this.MAX_TOTAL_SIZE) {
      allErrors.push(
        `Tamanho total muito grande: ${(totalSize / (1024 * 1024)).toFixed(2)}MB. ` +
        `Limite: ${this.MAX_TOTAL_SIZE / (1024 * 1024)}MB`
      );
    }

    return {
      isValid: results.every(r => r.isValid) && allErrors.length === 0,
      results,
      totalSize,
      errors: allErrors,
      warnings: allWarnings
    };
  }

  /**
   * Valida formato Base64
   */
  private static validateBase64(content: string): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Limpar prefixos data: URI se presentes
    const cleanContent = this.cleanBase64(content);

    // Verificar se está vazio
    if (!cleanContent || cleanContent.trim() === '') {
      errors.push('Conteúdo Base64 está vazio');
      return { isValid: false, errors };
    }

    // Verificar caracteres válidos (apenas A-Z, a-z, 0-9, +, /, =)
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(cleanContent)) {
      errors.push('Conteúdo contém caracteres inválidos para Base64');
    }

    // Verificar padding correto
    const paddingCount = (cleanContent.match(/=/g) || []).length;
    if (paddingCount > 2) {
      errors.push('Padding Base64 inválido (mais de 2 caracteres =)');
    }

    // Verificar comprimento (deve ser múltiplo de 4 após limpeza)
    if (cleanContent.length % 4 !== 0) {
      errors.push('Comprimento Base64 inválido (deve ser múltiplo de 4)');
    }

    // Tentar decodificar para verificar validade
    try {
      Buffer.from(cleanContent, 'base64');
    } catch (error) {
      errors.push('Conteúdo Base64 não pode ser decodificado');
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Remove prefixos data: URI do Base64
   */
  private static cleanBase64(content: string): string {
    // Remove data:mime/type;base64, se presente
    const dataUriMatch = content.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUriMatch) {
      return dataUriMatch[1];
    }
    return content.trim();
  }

  /**
   * Calcula tamanho real do arquivo a partir do Base64
   */
  private static calculateBase64Size(base64: string): number {
    const cleanBase64 = base64.replace(/[^A-Za-z0-9+/]/g, '');
    const paddingCount = (base64.match(/=/g) || []).length;
    return Math.floor((cleanBase64.length * 3) / 4) - paddingCount;
  }

  /**
   * Verifica se é um MIME type válido
   */
  private static isValidMimeType(mimeType: string): boolean {
    const mimeRegex = /^[a-zA-Z][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_]*$/;
    return mimeRegex.test(mimeType);
  }

  /**
   * Detecta se é um arquivo de boleto
   */
  private static isBoletoFile(fileName: string, mimeType: string): boolean {
    const name = fileName.toLowerCase();
    const type = mimeType.toLowerCase();
    
    return (
      name.includes('boleto') ||
      name.includes('cobranca') ||
      name.includes('pagamento') ||
      name.includes('fatura') ||
      this.BOLETO_MIME_TYPES.includes(type)
    );
  }
}