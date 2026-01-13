import { BaseHandler, HandlerResult } from './BaseHandler.js';

export class HybridHandler extends BaseHandler {
  /**
   * Handler for sending email from attachment
   * This is a hybrid function that downloads an attachment and sends it with a new email
   */
  async handleSendEmailFromAttachment(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, [
      'sourceEmailId', 
      'attachmentId', 
      'to', 
      'subject', 
      'body'
    ]);
    
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      sourceEmailId, 
      attachmentId, 
      to, 
      subject, 
      body,
      cc,
      bcc,
      useTemplate = false,
      templateTheme = 'professional',
      keepOriginalFile = false,
      customFilename
    } = args;

    console.error(`🚀 Iniciando envio híbrido de anexo...`);
    console.error(`   Email origem: ${sourceEmailId.substring(0, 30)}...`);
    console.error(`   Anexo: ${attachmentId.substring(0, 30)}...`);

    try {
      const result = await this.emailService.sendEmailFromAttachment(
        sourceEmailId,
        attachmentId,
        to,
        subject,
        body,
        {
          cc,
          bcc,
          enhancedOptions: useTemplate ? {
            useTemplate: true,
            templateOptions: { theme: templateTheme }
          } : undefined,
          keepOriginalFile,
          customFilename
        }
      );

      if (!result.success) {
        return this.formatError(`Erro no envio híbrido: ${result.error}`);
      }

      let resultText = `✅ Email enviado com anexo transferido!\n\n`;
      resultText += `📧 Detalhes do envio:\n`;
      resultText += `   Para: ${Array.isArray(to) ? to.join(', ') : to}\n`;
      resultText += `   Assunto: ${subject}\n`;
      if (cc) resultText += `   CC: ${Array.isArray(cc) ? cc.join(', ') : cc}\n`;
      if (bcc) resultText += `   BCC: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}\n\n`;
      
      if (result.attachmentInfo) {
        resultText += `📎 Anexo transferido:\n`;
        resultText += `   Nome: ${result.attachmentInfo.name}\n`;
        resultText += `   Tamanho: ${(result.attachmentInfo.size / 1024).toFixed(2)}KB\n`;
        resultText += `   Tipo: ${result.attachmentInfo.contentType}\n\n`;
      }
      
      resultText += `🔄 Processo híbrido:\n`;
      resultText += `   1. Download do anexo original ✅\n`;
      resultText += `   2. Processamento e validação ✅\n`;
      resultText += `   3. Envio com novo email ✅\n\n`;
      
      if (result.sendResult?.messageId) {
        resultText += `📬 Message ID: ${result.sendResult.messageId}\n`;
      }
      
      if (result.attachmentInfo?.filePath && !keepOriginalFile) {
        resultText += `\n🗑️ Arquivo temporário limpo automaticamente`;
      } else if (result.attachmentInfo?.filePath && keepOriginalFile) {
        resultText += `\n💾 Arquivo mantido em: ${result.attachmentInfo.filePath}`;
      }

      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro no envio híbrido', error);
    }
  }

  /**
   * Handler for sending email with file from disk
   * This function reads a file from disk and sends it as an attachment
   */
  async handleSendEmailWithFile(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, [
      'filePath', 
      'to', 
      'subject', 
      'body'
    ]);
    
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      filePath, 
      to, 
      subject, 
      body,
      cc,
      bcc,
      useTemplate = false,
      templateTheme = 'professional',
      customFilename
    } = args;

    console.error(`📎 Enviando email com arquivo do disco: ${filePath}`);

    try {
      const result = await this.emailService.sendEmailWithFileAttachment(
        filePath,
        to,
        subject,
        body,
        {
          cc,
          bcc,
          enhancedOptions: useTemplate ? {
            useTemplate: true,
            templateOptions: { theme: templateTheme }
          } : undefined,
          customFilename
        }
      );

      if (!result.success) {
        return this.formatError(`Erro no envio com arquivo: ${result.error}`);
      }

      let resultText = `✅ Email enviado com arquivo do disco!\n\n`;
      resultText += `📧 Detalhes do envio:\n`;
      resultText += `   Para: ${Array.isArray(to) ? to.join(', ') : to}\n`;
      resultText += `   Assunto: ${subject}\n`;
      if (cc) resultText += `   CC: ${Array.isArray(cc) ? cc.join(', ') : cc}\n`;
      if (bcc) resultText += `   BCC: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}\n\n`;
      
      if (result.attachmentInfo) {
        resultText += `📎 Arquivo anexado:\n`;
        resultText += `   Origem: ${filePath}\n`;
        resultText += `   Nome: ${result.attachmentInfo.name}\n`;
        resultText += `   Tamanho: ${(result.attachmentInfo.size / 1024).toFixed(2)}KB\n`;
        resultText += `   Tipo: ${result.attachmentInfo.contentType}\n\n`;
      }
      
      resultText += `🔄 Processo direto:\n`;
      resultText += `   1. Leitura do arquivo do disco ✅\n`;
      resultText += `   2. Codificação Base64 ✅\n`;
      resultText += `   3. Envio como anexo ✅\n\n`;
      
      if (result.sendResult?.messageId) {
        resultText += `📬 Message ID: ${result.sendResult.messageId}`;
      }

      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro no envio com arquivo', error);
    }
  }
}