import { EmailAttachment } from '../services/emailService.js';

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

export interface SingleAttachmentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  info: AttachmentInfo;
}

export class AttachmentValidator {
  // Microsoft Graph API limits
  private static readonly MAX_SMALL_ATTACHMENT_SIZE = 3 * 1024 * 1024; // 3MB for regular attachments
  private static readonly MAX_UPLOAD_SESSION_SIZE = 150 * 1024 * 1024; // 150MB with upload session
  private static readonly MAX_TOTAL_ATTACHMENT_SIZE = 150 * 1024 * 1024; // 150MB total
  private static readonly MAX_ATTACHMENT_COUNT = 100;
  private static readonly BASE64_OVERHEAD = 1.37; // 37% overhead for Base64

  // Supported MIME types for common files
  private static readonly COMMON_MIME_TYPES = [
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed',
    'text/plain',
    'text/csv',
    'text/html',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/bmp',
    'image/tiff',
    'application/octet-stream'
  ];

  // MIME types for Brazilian boleto (payment slips)
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
   * Validates all attachments before sending
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

    // Check attachment count limit
    if (attachments.length > this.MAX_ATTACHMENT_COUNT) {
      result.errors.push(
        `Too many attachments: ${attachments.length}. Maximum allowed: ${this.MAX_ATTACHMENT_COUNT}`
      );
      result.isValid = false;
    }

    // Validate each attachment
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      const validation = this.validateSingleAttachment(attachment);
      
      // Add index to errors and warnings for clarity
      validation.errors.forEach(error => 
        result.errors.push(`Attachment ${i + 1} (${attachment.name || 'unnamed'}): ${error}`)
      );
      validation.warnings.forEach(warning => 
        result.warnings.push(`Attachment ${i + 1} (${attachment.name || 'unnamed'}): ${warning}`)
      );

      if (!validation.isValid) {
        result.isValid = false;
      }

      result.attachmentInfo.push(validation.info);
      result.totalSize += validation.info.base64Size;
    }

    // Validate total size
    if (result.totalSize > this.MAX_TOTAL_ATTACHMENT_SIZE) {
      result.errors.push(
        `Total attachment size (${this.formatBytes(result.totalSize)}) exceeds limit of ${this.formatBytes(this.MAX_TOTAL_ATTACHMENT_SIZE)}`
      );
      result.isValid = false;
    }

    // Check if any attachment needs upload session
    const needsUploadSession = result.attachmentInfo.some(info => info.needsUploadSession);
    if (needsUploadSession) {
      result.warnings.push(
        'Some attachments are large (>3MB) and require upload session - this feature is not implemented yet'
      );
    }

    return result;
  }

  /**
   * Validates a single attachment
   */
  static validateSingleAttachment(attachment: EmailAttachment): SingleAttachmentValidationResult {
    const result: SingleAttachmentValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      info: {
        name: attachment.name || '',
        originalSize: 0,
        base64Size: 0,
        contentType: attachment.contentType || '',
        needsUploadSession: false
      }
    };

    // 1. Validate file name
    if (!attachment.name || attachment.name.trim() === '') {
      result.errors.push('File name cannot be empty');
      result.isValid = false;
    } else {
      result.info.name = attachment.name;
    }

    // 2. Validate MIME type
    if (!attachment.contentType || attachment.contentType.trim() === '') {
      result.errors.push('Content type (MIME type) is required');
      result.isValid = false;
    } else {
      result.info.contentType = attachment.contentType;
      
      // Check if MIME type is recognized
      if (!this.isValidMimeType(attachment.contentType)) {
        result.warnings.push(`Unrecognized MIME type: ${attachment.contentType}`);
      }
    }

    // 3. Validate Base64 content
    if (!attachment.content || attachment.content.trim() === '') {
      result.errors.push('File content cannot be empty');
      result.isValid = false;
      return result;
    }

    const base64Validation = this.validateBase64Content(attachment.content);
    if (!base64Validation.isValid) {
      result.errors.push(`Invalid Base64 content: ${base64Validation.error}`);
      result.isValid = false;
      return result;
    }

    result.info.originalSize = base64Validation.originalSize;
    result.info.base64Size = base64Validation.base64Size;

    // 4. Check if needs upload session (>3MB)
    if (result.info.originalSize > this.MAX_SMALL_ATTACHMENT_SIZE) {
      result.info.needsUploadSession = true;
      result.errors.push(
        `File too large: ${this.formatBytes(result.info.originalSize)}. ` +
        `Maximum size for regular attachments: ${this.formatBytes(this.MAX_SMALL_ATTACHMENT_SIZE)}. ` +
        `Large file upload session is not implemented yet.`
      );
      result.isValid = false;
    }

    // 5. Specific validations for boletos (Brazilian payment slips)
    if (this.isBoletoAttachment(attachment.name, attachment.contentType)) {
      this.validateBoletoSpecific(attachment, result);
    }

    // 6. Size warnings
    if (result.info.originalSize > 1024 * 1024) { // >1MB
      result.warnings.push(
        `Large file (${this.formatBytes(result.info.originalSize)}) - may take longer to send`
      );
    }

    // 7. Verify size consistency if provided
    if (attachment.size && Math.abs(attachment.size - result.info.originalSize) > 1000) {
      result.warnings.push(
        `Reported size (${attachment.size} bytes) differs from calculated size (${result.info.originalSize} bytes)`
      );
    }

    return result;
  }

  /**
   * Validates Base64 content
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
        error: 'Content is empty',
        originalSize: 0,
        base64Size: 0
      };
    }

    // Remove possible data: URI prefixes
    const cleanBase64 = this.cleanBase64Content(content);

    // Validate Base64 format
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(cleanBase64)) {
      return {
        isValid: false,
        error: 'Invalid Base64 format - contains invalid characters',
        originalSize: 0,
        base64Size: 0
      };
    }

    // Check correct padding
    if (cleanBase64.length % 4 !== 0) {
      return {
        isValid: false,
        error: 'Invalid Base64 format - incorrect padding',
        originalSize: 0,
        base64Size: 0
      };
    }

    try {
      // Try to decode to verify validity
      const buffer = Buffer.from(cleanBase64, 'base64');
      
      return {
        isValid: true,
        originalSize: buffer.length,
        base64Size: cleanBase64.length
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Error decoding Base64: ${error instanceof Error ? error.message : 'Unknown error'}`,
        originalSize: 0,
        base64Size: 0
      };
    }
  }

  /**
   * Checks if it's a valid MIME type
   */
  private static isValidMimeType(mimeType: string): boolean {
    const normalizedType = mimeType.toLowerCase();
    
    // Check if it's in our common types list
    if (this.COMMON_MIME_TYPES.includes(normalizedType)) {
      return true;
    }

    // Check if it follows the general MIME type format
    const mimeRegex = /^[a-zA-Z][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_+.]*$/;
    return mimeRegex.test(mimeType);
  }

  /**
   * Identifies if it's a boleto (Brazilian payment slip) attachment
   */
  private static isBoletoAttachment(fileName: string, contentType: string): boolean {
    const name = fileName.toLowerCase();
    const type = contentType.toLowerCase();
    
    // Common boleto patterns
    const boletoPatterns = [
      /boleto/i,
      /cobranca/i,
      /cobrança/i,
      /fatura/i,
      /duplicata/i,
      /titulo/i,
      /título/i,
      /pagamento/i,
      /payment/i
    ];

    return boletoPatterns.some(pattern => pattern.test(name)) ||
           this.BOLETO_MIME_TYPES.includes(type);
  }

  /**
   * Specific validations for boletos
   */
  private static validateBoletoSpecific(
    attachment: EmailAttachment,
    result: SingleAttachmentValidationResult
  ): void {
    // Check if MIME type is appropriate for boletos
    if (!this.BOLETO_MIME_TYPES.includes(attachment.contentType.toLowerCase())) {
      result.warnings.push(
        `File appears to be a boleto, but type '${attachment.contentType}' may not be ideal. Consider using PDF or image format.`
      );
    }

    // Check if file is too small (suspicious)
    if (result.info.originalSize < 1024) { // <1KB
      result.warnings.push(
        `File is too small (${this.formatBytes(result.info.originalSize)}) for a valid boleto`
      );
    }

    // Check if file is too large
    if (result.info.originalSize > 10 * 1024 * 1024) { // >10MB
      result.warnings.push(
        `File is too large (${this.formatBytes(result.info.originalSize)}) for a typical boleto`
      );
    }
  }

  /**
   * Formats bytes in human-readable format
   */
  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Cleans and normalizes Base64 content
   */
  static cleanBase64Content(content: string): string {
    // Remove data: URI prefix if present
    const dataUriMatch = content.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUriMatch) {
      return dataUriMatch[1].replace(/\s/g, '');
    }
    return content.replace(/\s/g, '');
  }

  /**
   * Estimates encoded size after Base64 encoding
   */
  static estimateEncodedSize(originalSize: number): number {
    return Math.ceil(originalSize * this.BASE64_OVERHEAD);
  }

  /**
   * Calculates original size from Base64 content
   */
  static calculateOriginalSize(base64: string): number {
    const cleanBase64 = this.cleanBase64Content(base64);
    const paddingCount = (cleanBase64.match(/=/g) || []).length;
    return Math.floor((cleanBase64.length * 3) / 4) - paddingCount;
  }
}