import { EmailAttachment } from './emailService.js';

export interface AttachmentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  totalSize: number;
  attachmentInfo: AttachmentInfo[];
}

export interface AttachmentInfo {
  name: string;
  originalSize: number;
  base64Size: number;
  contentType: string;
  needsUploadSession: boolean;
}

export class AttachmentValidator {
  // Limites do Microsoft Graph API
  private static readonly MAX_SMALL_ATTACHMENT_SIZE = 15 * 1024 * 1024; // 15MB
  private static readonly MAX_TOTAL_ATTACHMENT_SIZE = 150 * 1024 * 1024; // 150MB
  private static readonly BASE64_OVERHEAD = 1.33; // 33% overhead

  // MIME types suportados para boletos
  private static readonly SUPPORTED_BOLETO_TYPES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'application/octet-stream'
  ];

  /**
   * Valida todos os anexos antes do envio
   */
  static validateAttachments(attachments: EmailAttachment[]): AttachmentValidationResult {
    const result: AttachmentValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      totalSize: 0,
      attachmentInfo: []
    };

    if (!attachments || attachments.length === 0) {
      return result;
    }

    for (const attachment of attachments) {
      const info = this.validateSingleAttachment(attachment, result);
      result.attachmentInfo.push(info);
      result.totalSize += info.base64Size;
    }

    // Validar tamanho total
    if (result.totalSize > this.MAX_TOTAL_ATTACHMENT_SIZE) {
      result.errors.push(
        `Tamanho total dos anexos (${this.formatBytes(result.totalSize)}) excede o limite de ${this.formatBytes(this.MAX_TOTAL_ATTACHMENT_SIZE)}`
      );
      result.isValid = false;
    }

    // Verificar se algum anexo necessita upload session
    const needsUploadSession = result.attachmentInfo.some(info => info.needsUploadSession);
    if (needsUploadSession) {
      result.warnings.push(
        'Alguns anexos são grandes (>15MB) e requerem upload session - funcionalidade não implementada ainda'
      );
    }

    return result;
  }

  /**
   * Valida um único anexo
   */
  private static validateSingleAttachment(
    attachment: EmailAttachment, 
    result: AttachmentValidationResult
  ): AttachmentInfo {
    const info: AttachmentInfo = {
      name: attachment.name,
      originalSize: 0,
      base64Size: 0,
      contentType: attachment.contentType,
      needsUploadSession: false
    };

    // 1. Validar nome do arquivo
    if (!attachment.name || attachment.name.trim() === '') {
      result.errors.push('Nome do arquivo não pode estar vazio');
      result.isValid = false;
    }

    // 2. Validar MIME type
    if (!attachment.contentType || attachment.contentType.trim() === '') {
      result.errors.push(`Tipo de conteúdo não especificado para '${attachment.name}'`);
      result.isValid = false;
    }

    // 3. Validar conteúdo base64
    const base64Validation = this.validateBase64Content(attachment.content);
    if (!base64Validation.isValid) {
      result.errors.push(`Base64 inválido para '${attachment.name}': ${base64Validation.error}`);
      result.isValid = false;
      return info;
    }

    info.originalSize = base64Validation.originalSize;
    info.base64Size = base64Validation.base64Size;

    // 4. Verificar se precisa de upload session
    if (info.base64Size > this.MAX_SMALL_ATTACHMENT_SIZE) {
      info.needsUploadSession = true;
    }

    // 5. Validações específicas para boletos
    if (this.isBoletoAttachment(attachment.name, attachment.contentType)) {
      this.validateBoletoSpecific(attachment, info, result);
    }

    // 6. Warnings para arquivos grandes
    if (info.base64Size > 1024 * 1024) { // >1MB
      result.warnings.push(
        `'${attachment.name}' é grande (${this.formatBytes(info.base64Size)}) - pode demorar para enviar`
      );
    }

    return info;
  }

  /**
   * Valida conteúdo base64
   */
  private static validateBase64Content(content: string): {
    isValid: boolean;
    error?: string;
    originalSize: number;
    base64Size: number;
  } {
    if (!content || content.trim() === '') {
      return {
        isValid: false,
        error: 'Conteúdo está vazio',
        originalSize: 0,
        base64Size: 0
      };
    }

    // Remover possíveis prefixos data: URI
    const cleanBase64 = content.replace(/^data:[^;]+;base64,/, '');

    // Validar formato base64
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(cleanBase64)) {
      return {
        isValid: false,
        error: 'Formato base64 inválido - contém caracteres não permitidos',
        originalSize: 0,
        base64Size: 0
      };
    }

    // Verificar padding correto
    if (cleanBase64.length % 4 !== 0) {
      return {
        isValid: false,
        error: 'Formato base64 inválido - padding incorreto',
        originalSize: 0,
        base64Size: 0
      };
    }

    try {
      // Tentar decodificar para verificar se é válido
      const buffer = Buffer.from(cleanBase64, 'base64');
      
      return {
        isValid: true,
        originalSize: buffer.length,
        base64Size: cleanBase64.length
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Erro ao decodificar base64: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
        originalSize: 0,
        base64Size: 0
      };
    }
  }

  /**
   * Identifica se é um anexo de boleto
   */
  private static isBoletoAttachment(fileName: string, contentType: string): boolean {
    const name = fileName.toLowerCase();
    const type = contentType.toLowerCase();
    
    // Padrões comuns de boletos
    const boletoPatterns = [
      /boleto/i,
      /cobranca/i,
      /cobrança/i,
      /fatura/i,
      /duplicata/i,
      /titulo/i,
      /título/i
    ];

    return boletoPatterns.some(pattern => pattern.test(name)) ||
           this.SUPPORTED_BOLETO_TYPES.includes(type);
  }

  /**
   * Validações específicas para boletos
   */
  private static validateBoletoSpecific(
    attachment: EmailAttachment,
    info: AttachmentInfo,
    result: AttachmentValidationResult
  ): void {
    // Verificar se o tipo MIME é apropriado para boletos
    if (!this.SUPPORTED_BOLETO_TYPES.includes(attachment.contentType.toLowerCase())) {
      result.warnings.push(
        `'${attachment.name}' parece ser um boleto, mas o tipo '${attachment.contentType}' pode não ser ideal. Considere PDF ou imagem.`
      );
    }

    // Verificar se o arquivo não está muito pequeno (suspeito)
    if (info.originalSize < 1024) { // <1KB
      result.warnings.push(
        `'${attachment.name}' é muito pequeno (${this.formatBytes(info.originalSize)}) para um boleto válido`
      );
    }

    // Verificar se não está muito grande
    if (info.originalSize > 10 * 1024 * 1024) { // >10MB
      result.warnings.push(
        `'${attachment.name}' é muito grande (${this.formatBytes(info.originalSize)}) para um boleto típico`
      );
    }
  }

  /**
   * Formata bytes em formato legível
   */
  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Limpa e normaliza conteúdo base64
   */
  static cleanBase64Content(content: string): string {
    return content.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  }

  /**
   * Calcula tamanho estimado após encoding
   */
  static estimateEncodedSize(originalSize: number): number {
    return Math.ceil(originalSize * this.BASE64_OVERHEAD);
  }
}