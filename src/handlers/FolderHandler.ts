import { BaseHandler, HandlerResult } from './BaseHandler.js';

export class FolderHandler extends BaseHandler {
  /**
   * Handler for listing email folders
   */
  async handleListFolders(args: any): Promise<HandlerResult> {
    const includeSubfolders = args.includeSubfolders !== false;
    const maxDepth = args.maxDepth || 3;

    try {
      const folders = await this.emailService.listFolders(includeSubfolders, maxDepth);
      
      if (!folders || folders.length === 0) {
        return this.formatSuccess('📁 Nenhuma pasta encontrada');
      }
      
      let result = `📁 Pastas de email (${folders.length}):\n\n`;
      
      folders.forEach((folder, index) => {
        const unreadCount = folder.unreadItemCount || 0;
        const totalCount = folder.totalItemCount || 0;
        const unreadBadge = unreadCount > 0 ? ` (${unreadCount} não lidas)` : '';
        
        result += `${index + 1}. **${folder.displayName}**${unreadBadge}\n`;
        result += `   Total: ${totalCount} emails\n`;
        result += `   Tipo: Email\n`;
        result += `   ID: ${folder.id}\n`;
        
        if (folder.parentFolderId) {
          result += `   Pasta pai: ${folder.parentFolderId}\n`;
        }
        
        result += '\n';
      });
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao listar pastas', error);
    }
  }

  /**
   * Handler for creating a new folder
   */
  async handleCreateFolder(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['folderName']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { folderName, parentFolderId } = args;

    try {
      const folder = await this.emailService.createFolder(folderName, parentFolderId);
      
      let result = `✅ Pasta criada com sucesso!\n\n`;
      result += `📁 **${folder.displayName}**\n`;
      result += `   ID: ${folder.id}\n`;
      result += `   Localização: ${parentFolderId ? 'Subpasta' : 'Pasta raiz'}\n`;
      
      if (parentFolderId) {
        result += `   Pasta pai: ${parentFolderId}\n`;
      }
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao criar pasta', error);
    }
  }

  /**
   * Handler for moving emails between folders
   */
  async handleMoveEmailsToFolder(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds', 'targetFolderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, targetFolderId } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    try {
      const results = await this.emailService.moveEmailsToFolder(emailArray, targetFolderId);
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `📦 Movimentação de emails concluída!\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `   • Total processados: ${results.length}\n`;
      result += `   • Sucessos: ${successCount}\n`;
      result += `   • Falhas: ${failureCount}\n`;
      result += `   • Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n\n`;
      
      if (results.length <= 10) {
        result += `📋 **Detalhes:**\n`;
        results.forEach((moveResult, index) => {
          const status = moveResult.success ? '✅' : '❌';
          const details = moveResult.success 
            ? `Movido para ${targetFolderId}` 
            : `Erro: ${moveResult.error}`;
          
          result += `   ${index + 1}. ${status} Email ${emailArray[index].substring(0, 8)}... - ${details}\n`;
        });
      }
      
      if (failureCount > 0) {
        result += `\n⚠️ Alguns emails falharam na movimentação. Verifique os logs para detalhes.`;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: result
          }
        ],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro ao mover emails', error);
    }
  }

  /**
   * Handler for copying emails to folder
   */
  async handleCopyEmailsToFolder(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailIds', 'targetFolderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { emailIds, targetFolderId } = args;
    const emailArray = Array.isArray(emailIds) ? emailIds : [emailIds];

    try {
      const results = await this.emailService.copyEmailsToFolder(emailArray, targetFolderId);
      
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      
      let result = `📋 Cópia de emails concluída!\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `   • Total processados: ${results.length}\n`;
      result += `   • Sucessos: ${successCount}\n`;
      result += `   • Falhas: ${failureCount}\n`;
      result += `   • Taxa de sucesso: ${((successCount / results.length) * 100).toFixed(1)}%\n\n`;
      
      if (results.length <= 10) {
        result += `📋 **Detalhes:**\n`;
        results.forEach((copyResult, index) => {
          const status = copyResult.success ? '✅' : '❌';
          const details = copyResult.success 
            ? `Copiado para ${targetFolderId}` 
            : `Erro: ${copyResult.error}`;
          
          result += `   ${index + 1}. ${status} Email ${emailArray[index].substring(0, 8)}... - ${details}\n`;
        });
      }
      
      return {
        content: [
          {
            type: 'text',
            text: result
          }
        ],
        isError: failureCount > 0
      };
    } catch (error) {
      return this.formatError('Erro ao copiar emails', error);
    }
  }

  /**
   * Handler for deleting a folder
   */
  async handleDeleteFolder(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['folderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { folderId, permanent = false } = args;

    try {
      const result = await this.emailService.deleteFolder(folderId, permanent);
      
      if (!result.success) {
        return this.formatError(`Falha ao deletar pasta: ${result.error}`);
      }
      
      let resultText = `✅ Pasta deletada com sucesso!\n\n`;
      resultText += `📁 **${result.folderName}**\n`;
      resultText += `   Tipo de exclusão: ${permanent ? 'Permanente' : 'Movida para lixeira'}\n`;
      
      if (result.emailsAffected) {
        resultText += `   Emails afetados: ${result.emailsAffected}\n`;
      }
      
      if (result.subfoldersAffected) {
        resultText += `   Subpastas afetadas: ${result.subfoldersAffected}\n`;
      }
      
      if (!permanent) {
        resultText += `\n💡 Para exclusão permanente, use o parâmetro 'permanent: true'`;
      }
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao deletar pasta', error);
    }
  }

  /**
   * Handler for getting folder statistics
   */
  async handleGetFolderStats(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['folderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { folderId, includeSubfolders = false } = args;

    try {
      const stats = await this.emailService.getFolderStatistics(folderId, includeSubfolders);
      
      let result = `📊 **Estatísticas da Pasta**\n\n`;
      result += `📁 **${stats.folderName}**\n`;
      result += `   📧 Total de emails: ${stats.totalEmails}\n`;
      result += `   ○ Não lidos: ${stats.unreadEmails}\n`;
      result += `   ✓ Lidos: ${stats.readEmails}\n`;
      result += `   📎 Com anexos: ${stats.emailsWithAttachments}\n\n`;
      
      if (stats.sizeInBytes) {
        const sizeInMB = (stats.sizeInBytes / (1024 * 1024)).toFixed(2);
        result += `💾 **Tamanho:** ${sizeInMB}MB\n\n`;
      }
      
      if (stats.dateRange) {
        result += `📅 **Período:**\n`;
        result += `   Mais antigo: ${stats.dateRange.oldest}\n`;
        result += `   Mais recente: ${stats.dateRange.newest}\n\n`;
      }
      
      if (includeSubfolders && stats.subfolders) {
        result += `📁 **Subpastas incluídas:** ${stats.subfolders.length}\n`;
        stats.subfolders.forEach((subfolder: any) => {
          result += `   • ${subfolder.name} (${subfolder.emailCount} emails)\n`;
        });
      }
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao obter estatísticas da pasta', error);
    }
  }

  /**
   * Handler for organizing emails by rules
   */
  async handleOrganizeEmailsByRules(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['sourceFolderId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const { 
      sourceFolderId,
      rules = [],
      dryRun = true,
      maxEmails = 100 
    } = args;

    try {
      const result = await this.emailService.organizeEmailsByRules(
        sourceFolderId,
        rules,
        { dryRun, maxEmails }
      );
      
      const mode = dryRun ? 'Simulação' : 'Execução';
      let resultText = `🗂️ **${mode} de Organização Concluída**\n\n`;
      
      resultText += `📊 **Estatísticas:**\n`;
      resultText += `   • Emails processados: ${result.emailsProcessed}\n`;
      resultText += `   • Emails organizados: ${result.emailsOrganized}\n`;
      resultText += `   • Regras aplicadas: ${result.rulesApplied}\n`;
      resultText += `   • Taxa de organização: ${((result.emailsOrganized / result.emailsProcessed) * 100).toFixed(1)}%\n\n`;
      
      if (result.ruleResults.length > 0) {
        resultText += `📋 **Resultados por Regra:**\n`;
        result.ruleResults.forEach((ruleResult: any, index: number) => {
          resultText += `   ${index + 1}. **${ruleResult.ruleName}**\n`;
          resultText += `      Emails correspondentes: ${ruleResult.emailsMatched}\n`;
          resultText += `      ${dryRun ? 'Seriam movidos' : 'Movidos'} para: ${ruleResult.targetFolder}\n\n`;
        });
      }
      
      if (dryRun && result.emailsOrganized > 0) {
        resultText += `💡 Execute novamente com 'dryRun: false' para aplicar as mudanças.`;
      }
      
      return this.formatSuccess(resultText);
    } catch (error) {
      return this.formatError('Erro ao organizar emails', error);
    }
  }
}