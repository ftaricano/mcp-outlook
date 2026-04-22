import { BaseHandler, HandlerResult } from './BaseHandler.js';

export class AttachmentHandler extends BaseHandler {
  /**
   * Handler for listing attachments
   */
  async handleListAttachments(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      const attachments = await this.emailService.listAttachments(args.emailId);
      
      if (!attachments || attachments.length === 0) {
        return this.formatSuccess('📎 Nenhum anexo encontrado neste email');
      }
      
      let result = `📎 Anexos encontrados (${attachments.length}):\n\n`;
      
      attachments.forEach((attachment, index) => {
        const sizeInKB = attachment.size ? (attachment.size / 1024).toFixed(2) : 'N/A';
        
        result += `${index + 1}. **${attachment.name}**\n`;
        result += `   Tipo: ${attachment.contentType || 'Desconhecido'}\n`;
        result += `   Tamanho: ${sizeInKB} KB\n`;
        result += `   ID: ${attachment.id}\n\n`;
      });
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao listar anexos', error);
    }
  }

  /**
   * Handler for downloading attachment
   */
  async handleDownloadAttachment(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId', 'attachmentId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      const attachment = await this.emailService.downloadAttachment(
        args.emailId, 
        args.attachmentId
      );
      
      if (!attachment || !attachment.content) {
        return this.formatError('Anexo não encontrado ou sem conteúdo');
      }
      
      let result = `✅ Anexo baixado com sucesso!\n\n`;
      result += `📄 Nome: ${attachment.name}\n`;
      result += `📊 Tipo: ${attachment.contentType}\n`;
      
      if (attachment.size) {
        const sizeInKB = (attachment.size / 1024).toFixed(2);
        result += `📏 Tamanho: ${sizeInKB} KB\n`;
      }
      
      const contentLength = attachment.content.length;
      const preview = attachment.content.substring(0, 100);
      
      result += `\n📝 Conteúdo (Base64, ${contentLength} caracteres):\n`;
      result += `${preview}...\n\n`;
      result += `💡 Use este conteúdo Base64 para salvar ou processar o arquivo`;
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao baixar anexo', error);
    }
  }

  /**
   * Handler for downloading attachment to file
   */
  async handleDownloadAttachmentToFile(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId', 'attachmentId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      emailId, 
      attachmentId, 
      targetDirectory, 
      customFilename,
      overwrite = false,
      validateIntegrity = true 
    } = args;
    
    try {
      const result = await this.emailService.downloadAttachmentToFile(
        emailId,
        attachmentId,
        {
          targetDirectory,
          filename: customFilename,
          overwrite,
          validateIntegrity
        }
      );
      
      if (!result.success) {
        return this.formatError(`Falha no download: ${result.error}`);
      }
      
      const sizeInKB = result.originalSize ? (result.originalSize / 1024).toFixed(2) : 'N/A';
      
      let resultText = `✅ Anexo salvo com sucesso!\n\n`;
      resultText += `📄 Arquivo: ${result.filename}\n`;
      resultText += `📂 Local: ${result.filePath}\n`;
      resultText += `📏 Tamanho: ${sizeInKB} KB\n`;
      resultText += `🎯 Tipo: ${result.contentType}\n`;
      
      if (result.downloadTime) {
        resultText += `⏱️ Tempo: ${result.downloadTime}ms\n`;
      }
      
      if (validateIntegrity && result.integrity) {
        resultText += `\n🔒 Integridade verificada ✅\n`;
      }
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro no download otimizado', error);
    }
  }

  /**
   * Handler for downloading all attachments
   */
  async handleDownloadAllAttachments(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      emailId, 
      targetDirectory, 
      overwrite = false, 
      validateIntegrity = true,
      maxConcurrent = 3
    } = args;
    
    try {
      const result = await this.emailService.downloadAllAttachmentsFromEmail(
        emailId,
        {
          targetDirectory,
          overwrite,
          validateIntegrity,
          maxConcurrent
        }
      );
      
      const successRate = result.totalFiles > 0 ? 
        ((result.successfulDownloads / result.totalFiles) * 100).toFixed(1) : '0';
      
      let resultText = `📦 Download em lote ${result.success ? 'concluído' : 'finalizado com falhas'}!\n\n`;
      resultText += `📊 Estatísticas:\n`;
      resultText += `   • Total: ${result.totalFiles} arquivos\n`;
      resultText += `   • Sucessos: ${result.successfulDownloads}\n`;
      resultText += `   • Falhas: ${result.failedDownloads}\n`;
      resultText += `   • Taxa de sucesso: ${successRate}%\n`;
      resultText += `   • Tempo total: ${result.downloadTime}ms\n\n`;
      
      if (result.results.length > 0) {
        resultText += `📋 Detalhes dos arquivos:\n`;
        result.results.forEach((fileResult, index) => {
          const status = fileResult.success ? '✅' : '❌';
          const details = fileResult.success ? 
            `Local: ${fileResult.filePath}` :
            `Erro: ${fileResult.error}`;
          
          resultText += `   ${index + 1}. ${status} ${fileResult.filename}\n      ${details}\n`;
        });
      }
      
      if (result.failedDownloads > 0) {
        resultText += `\n⚠️  Alguns arquivos falharam. Verifique os logs para detalhes.`;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ],
        isError: result.failedDownloads > 0
      };
    } catch (error) {
      return this.formatError('Erro no download em lote', error);
    }
  }

  /**
   * Handler for listing downloaded files
   */
  async handleListDownloadedFiles(_args: any): Promise<HandlerResult> {
    try {
      const files = this.emailService.getDownloadedFiles();
      
      if (files.length === 0) {
        return this.formatSuccess(
          `📭 Nenhum arquivo encontrado no diretório de downloads.\n\n` +
          `💡 Use 'download_attachment_to_file' ou 'download_all_attachments' para baixar arquivos.`
        );
      }
      
      let resultText = `📁 Arquivos baixados (${files.length}):\n\n`;
      
      let totalSize = 0;
      files.forEach((file, index) => {
        const sizeInKB = (file.size / 1024).toFixed(2);
        const modifiedDate = file.modified.toLocaleString('pt-BR');
        totalSize += file.size;
        
        resultText += `${index + 1}. 📄 ${file.name}\n`;
        resultText += `   📏 Tamanho: ${sizeInKB}KB\n`;
        resultText += `   📅 Modificado: ${modifiedDate}\n`;
        resultText += `   📍 Local: ${file.path}\n\n`;
      });
      
      const totalSizeInKB = (totalSize / 1024).toFixed(2);
      resultText += `📊 Total: ${totalSizeInKB}KB em ${files.length} arquivos`;
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao listar arquivos', error);
    }
  }

  /**
   * Handler for getting download directory info
   */
  async handleGetDownloadDirectoryInfo(args: any): Promise<HandlerResult> {
    try {
      const info = this.emailService.getDownloadDirectoryInfo();
      
      const totalSizeInKB = (info.totalSize / 1024).toFixed(2);
      const totalSizeInMB = (info.totalSize / (1024 * 1024)).toFixed(2);
      
      let resultText = `📂 Informações do Diretório de Downloads\n\n`;
      resultText += `📍 Caminho: ${info.path}\n`;
      resultText += `📊 Total de arquivos: ${info.fileCount}\n`;
      resultText += `💾 Espaço usado: ${totalSizeInKB}KB (${totalSizeInMB}MB)\n`;
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao obter informações do diretório', error);
    }
  }

  /**
   * Handler for cleaning up old downloads
   */
  async handleCleanupOldDownloads(args: any): Promise<HandlerResult> {
    const daysOld = args.daysOld || 7;
    const dryRun = args.dryRun !== false;
    
    try {
      // Convert days to hours for the actual API
      const hoursOld = daysOld * 24;
      const deletedCount = this.emailService.cleanupOldDownloads(hoursOld);
      
      let resultText = dryRun 
        ? `🔍 Simulação de limpeza:\n\n`
        : `✅ Limpeza concluída:\n\n`;
      
      resultText += `📊 Resumo:\n`;
      resultText += `   • Arquivos ${dryRun ? 'a deletar' : 'deletados'}: ${deletedCount}\n`;
      resultText += `   • Critério: arquivos com mais de ${daysOld} dias\n`;
      
      if (deletedCount === 0) {
        resultText += `\nℹ️ Nenhum arquivo atende ao critério de limpeza.`;
      }
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro na limpeza de arquivos', error);
    }
  }

  /**
   * Handler for exporting email as attachment
   */
  async handleExportEmailAsAttachment(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }
    
    try {
      const result = await this.emailService.exportEmailAsAttachment(args.emailId);
      
      const sizeKB = result.size ? (result.size / 1024).toFixed(2) : 'N/A';
      
      let resultText = `✅ Email exportado com sucesso!\n\n`;
      resultText += `📧 Formato: EML\n`;
      resultText += `📄 Nome: ${result.name}\n`;
      resultText += `📏 Tamanho: ${sizeKB}KB\n`;
      resultText += `🎯 Tipo MIME: ${result.contentType}\n\n`;
      resultText += `📝 Conteúdo Base64 (primeiros 200 caracteres):\n`;
      resultText += `${result.content.substring(0, 200)}...\n\n`;
      resultText += `💡 Este conteúdo pode ser usado como anexo em outro email`;
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao exportar email', error);
    }
  }

  /**
   * Handler for encoding file for attachment
   */
  async handleEncodeFileForAttachment(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['filePath']);
    if (validationError) {
      return this.formatError(validationError);
    }
    
    try {
      const result = await this.emailService.encodeFileForAttachment(args.filePath);
      
      if (!result.success) {
        return this.formatError(`Falha ao codificar: ${result.error}`);
      }
      
      const sizeKB = (result.size / 1024).toFixed(2);
      
      let resultText = `✅ Arquivo codificado com sucesso!\n\n`;
      resultText += `📄 Nome: ${result.name}\n`;
      resultText += `🎯 Tipo MIME: ${result.contentType}\n`;
      resultText += `📏 Tamanho: ${sizeKB}KB\n\n`;
      resultText += `📝 Conteúdo Base64 (primeiros 200 caracteres):\n`;
      resultText += `${result.content.substring(0, 200)}...\n\n`;
      resultText += `💡 Use este conteúdo para enviar o arquivo como anexo`;
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao codificar arquivo', error);
    }
  }
}