import { BaseHandler, HandlerResult } from './BaseHandler.js';

export class BatchHandler extends BaseHandler {
  /**
   * Handler for batch marking emails as read
   */
  async handleBatchMarkAsRead(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, maxConcurrent = 5 } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    if (emailArray.length === 0) {
      return this.formatError('Lista de emails não pode estar vazia');
    }

    if (emailArray.length > 100) {
      return this.formatError('Máximo de 100 emails por operação em lote');
    }

    try {
      const results = await this.emailService.batchMarkAsRead(emailArray, { maxConcurrent });
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `📖 **Marcação em Lote como Lidos** - Concluída\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Total processados: ${results.length}\n`;
      result += `• Sucessos: ${successCount}\n`;
      result += `• Falhas: ${failureCount}\n`;
      result += `• Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n`;
      
      if (results.length <= 20) {
        result += `\n📋 **Detalhes:**\n`;
        results.forEach((batchResult, index) => {
          const status = batchResult.success ? '✅' : '❌';
          const emailPreview = emailArray[index].substring(0, 8) + '...';
          const details = batchResult.success 
            ? 'Marcado como lido'
            : `Erro: ${batchResult.error}`;
          
          result += `${index + 1}. ${status} ${emailPreview} - ${details}\n`;
        });
      }
      
      if (failureCount > 0) {
        result += `\n⚠️ Alguns emails falharam. Verifique os logs para detalhes.`;
      }
      
      return {
        content: [{ type: 'text', text: result }],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro na marcação em lote', error);
    }
  }

  /**
   * Handler for batch marking emails as unread
   */
  async handleBatchMarkAsUnread(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, maxConcurrent = 5 } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    if (emailArray.length === 0) {
      return this.formatError('Lista de emails não pode estar vazia');
    }

    if (emailArray.length > 100) {
      return this.formatError('Máximo de 100 emails por operação em lote');
    }

    try {
      const results = await this.emailService.batchMarkAsUnread(emailArray, { maxConcurrent });
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `📬 **Marcação em Lote como Não Lidos** - Concluída\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Total processados: ${results.length}\n`;
      result += `• Sucessos: ${successCount}\n`;
      result += `• Falhas: ${failureCount}\n`;
      result += `• Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n`;
      
      if (results.length <= 20) {
        result += `\n📋 **Detalhes:**\n`;
        results.forEach((batchResult, index) => {
          const status = batchResult.success ? '✅' : '❌';
          const emailPreview = emailArray[index].substring(0, 8) + '...';
          const details = batchResult.success 
            ? 'Marcado como não lido'
            : `Erro: ${batchResult.error}`;
          
          result += `${index + 1}. ${status} ${emailPreview} - ${details}\n`;
        });
      }
      
      if (failureCount > 0) {
        result += `\n⚠️ Alguns emails falharam. Verifique os logs para detalhes.`;
      }
      
      return {
        content: [{ type: 'text', text: result }],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro na marcação em lote', error);
    }
  }

  /**
   * Handler for batch deleting emails
   */
  async handleBatchDeleteEmails(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, permanent = false, maxConcurrent = 3 } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    if (emailArray.length === 0) {
      return this.formatError('Lista de emails não pode estar vazia');
    }

    if (emailArray.length > 50) {
      return this.formatError('Máximo de 50 emails por operação de deleção em lote');
    }

    try {
      const results = await this.emailService.batchDeleteEmails(emailArray, { permanent, maxConcurrent });
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `🗑️ **Deleção em Lote** - Concluída\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Total processados: ${results.length}\n`;
      result += `• Sucessos: ${successCount}\n`;
      result += `• Falhas: ${failureCount}\n`;
      result += `• Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n`;
      result += `• Tipo: ${permanent ? 'Deleção permanente' : 'Movido para lixeira'}\n`;
      
      if (results.length <= 20) {
        result += `\n📋 **Detalhes:**\n`;
        results.forEach((batchResult, index) => {
          const status = batchResult.success ? '✅' : '❌';
          const emailPreview = emailArray[index].substring(0, 8) + '...';
          const details = batchResult.success 
            ? (permanent ? 'Deletado permanentemente' : 'Movido para lixeira')
            : `Erro: ${batchResult.error}`;
          
          result += `${index + 1}. ${status} ${emailPreview} - ${details}\n`;
        });
      }
      
      if (failureCount > 0) {
        result += `\n⚠️ Alguns emails falharam. Verifique os logs para detalhes.`;
      }
      
      if (!permanent) {
        result += `\n💡 Use 'permanent: true' para deleção permanente`;
      }
      
      return {
        content: [{ type: 'text', text: result }],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro na deleção em lote', error);
    }
  }

  /**
   * Handler for batch moving emails
   */
  async handleBatchMoveEmails(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds', 'targetFolderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, targetFolderId, maxConcurrent = 5, validateTarget = true } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    if (emailArray.length === 0) {
      return this.formatError('Lista de emails não pode estar vazia');
    }

    if (emailArray.length > 100) {
      return this.formatError('Máximo de 100 emails por operação de movimentação em lote');
    }

    try {
      // Validate target folder if requested
      if (validateTarget) {
        const folders = await this.emailService.listFolders(false, 1);
        const targetExists = folders.some(folder => folder.id === targetFolderId);
        
        if (!targetExists) {
          return this.formatError(`Pasta de destino não encontrada: ${targetFolderId}`);
        }
      }

      const results = await this.emailService.batchMoveEmails(emailArray, targetFolderId, { maxConcurrent });
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `📦 **Movimentação em Lote** - Concluída\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Total processados: ${results.length}\n`;
      result += `• Sucessos: ${successCount}\n`;
      result += `• Falhas: ${failureCount}\n`;
      result += `• Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n`;
      result += `• Pasta destino: ${targetFolderId}\n`;
      
      if (results.length <= 20) {
        result += `\n📋 **Detalhes:**\n`;
        results.forEach((batchResult, index) => {
          const status = batchResult.success ? '✅' : '❌';
          const emailPreview = emailArray[index].substring(0, 8) + '...';
          const details = batchResult.success 
            ? 'Movido com sucesso'
            : `Erro: ${batchResult.error}`;
          
          result += `${index + 1}. ${status} ${emailPreview} - ${details}\n`;
        });
      }
      
      if (failureCount > 0) {
        result += `\n⚠️ Alguns emails falharam na movimentação. Verifique os logs.`;
      }
      
      return {
        content: [{ type: 'text', text: result }],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro na movimentação em lote', error);
    }
  }

  /**
   * Handler for batch downloading attachments
   */
  async handleBatchDownloadAttachments(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      emailIds, 
      targetDirectory = 'downloads',
      maxConcurrent = 3,
      overwrite = false,
      validateIntegrity = true,
      sizeLimit = 25 // MB
    } = args;
    
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    if (emailArray.length === 0) {
      return this.formatError('Lista de emails não pode estar vazia');
    }

    if (emailArray.length > 20) {
      return this.formatError('Máximo de 20 emails por operação de download em lote');
    }

    try {
      const results = await this.emailService.batchDownloadAllAttachments(emailArray, {
        targetDirectory,
        maxConcurrent,
        overwrite,
        validateIntegrity,
        sizeLimit
      });
      
      const totalFiles = results.reduce((sum, r) => sum + r.filesDownloaded, 0);
      const totalSizeMB = results.reduce((sum, r) => sum + r.totalSizeMB, 0);
      const failedEmails = results.filter(r => !r.success).length;
      
      let result = `📎 **Download em Lote de Anexos** - Concluído\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Emails processados: ${results.length}\n`;
      result += `• Emails com falha: ${failedEmails}\n`;
      result += `• Total de arquivos baixados: ${totalFiles}\n`;
      result += `• Tamanho total: ${totalSizeMB.toFixed(2)}MB\n`;
      result += `• Taxa de sucesso: ${(((results.length - failedEmails) / results.length) * 100).toFixed(1)}%\n`;
      result += `• Diretório: ${targetDirectory}\n\n`;
      
      result += `📋 **Resultados por Email:**\n`;
      results.forEach((downloadResult, index) => {
        const status = downloadResult.success ? '✅' : '❌';
        const emailPreview = emailArray[index].substring(0, 8) + '...';
        
        if (downloadResult.success) {
          result += `${index + 1}. ${status} ${emailPreview} - ${downloadResult.filesDownloaded} arquivo(s) (${downloadResult.totalSizeMB.toFixed(2)}MB)\n`;
          
          if (downloadResult.fileNames && downloadResult.fileNames.length > 0) {
            const fileList = downloadResult.fileNames.slice(0, 3).join(', ');
            const moreFiles = downloadResult.fileNames.length > 3 ? ` +${downloadResult.fileNames.length - 3} mais` : '';
            result += `   Arquivos: ${fileList}${moreFiles}\n`;
          }
        } else {
          result += `${index + 1}. ${status} ${emailPreview} - Erro: ${downloadResult.error}\n`;
        }
      });
      
      if (failedEmails > 0) {
        result += `\n⚠️ ${failedEmails} email(s) falharam no download. Verifique os logs.`;
      }
      
      result += `\n\n💡 Use 'list_downloaded_files' para ver todos os arquivos baixados`;
      
      return {
        content: [{ type: 'text', text: result }],
        isError: failedEmails > 0
      };
    } catch (error) {
      return this.formatError('Erro no download em lote', error);
    }
  }

  /**
   * Handler for email cleanup wizard
   */
  async handleEmailCleanupWizard(args: any): Promise<HandlerResult> {
    const {
      dryRun = true,
      olderThanDays = 30,
      deleteRead = false,
      deleteLargeAttachments = false,
      attachmentSizeLimitMB = 10,
      excludeFolders = ['sent', 'drafts'],
      maxEmails = 100
    } = args;

    try {
      const cleanupResult = await this.emailService.emailCleanupWizard({
        dryRun,
        olderThanDays,
        deleteRead,
        deleteLargeAttachments,
        attachmentSizeLimitMB,
        excludeFolders,
        maxEmails
      });

      const mode = dryRun ? 'Simulação' : 'Execução';
      let result = `🧹 **Assistente de Limpeza de Emails** - ${mode}\n\n`;
      
      result += `📊 **Configuração:**\n`;
      result += `• Emails mais antigos que: ${olderThanDays} dias\n`;
      result += `• Deletar emails lidos: ${deleteRead ? 'Sim' : 'Não'}\n`;
      result += `• Deletar anexos grandes: ${deleteLargeAttachments ? 'Sim' : 'Não'}\n`;
      if (deleteLargeAttachments) {
        result += `• Limite de tamanho de anexo: ${attachmentSizeLimitMB}MB\n`;
      }
      result += `• Pastas excluídas: ${excludeFolders.join(', ')}\n`;
      result += `• Máximo de emails: ${maxEmails}\n\n`;
      
      result += `📈 **Resultados:**\n`;
      result += `• Emails analisados: ${cleanupResult.emailsAnalyzed}\n`;
      result += `• Emails candidatos à limpeza: ${cleanupResult.emailsToClean}\n`;
      result += `• Emails ${dryRun ? 'que seriam' : ''} deletados: ${cleanupResult.emailsDeleted}\n`;
      result += `• Espaço ${dryRun ? 'estimado a ser' : ''} liberado: ${cleanupResult.spaceSavedMB.toFixed(2)}MB\n\n`;
      
      if (cleanupResult.categories && Object.keys(cleanupResult.categories).length > 0) {
        result += `📂 **Por Categoria:**\n`;
        Object.entries(cleanupResult.categories).forEach(([category, count]) => {
          result += `• ${category}: ${count} emails\n`;
        });
        result += '\n';
      }
      
      if (cleanupResult.warnings && cleanupResult.warnings.length > 0) {
        result += `⚠️ **Avisos:**\n`;
        cleanupResult.warnings.forEach(warning => {
          result += `• ${warning}\n`;
        });
        result += '\n';
      }
      
      if (dryRun && cleanupResult.emailsToClean > 0) {
        result += `💡 **Próximos Passos:**\n`;
        result += `• Execute novamente com 'dryRun: false' para aplicar a limpeza\n`;
        result += `• Considere fazer backup antes da limpeza final\n`;
        result += `• Revise as categorias de emails a serem removidos\n`;
      } else if (!dryRun && cleanupResult.emailsDeleted > 0) {
        result += `✅ **Limpeza Concluída com Sucesso**\n`;
        result += `Emails foram movidos para a lixeira e podem ser recuperados se necessário.`;
      }
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro no assistente de limpeza', error);
    }
  }
}