import { BaseHandler, HandlerResult } from './BaseHandler.js';
import { AttachmentValidator } from '../utils/attachmentValidator.js';

export class EmailHandler extends BaseHandler {
  /**
   * Handler for listing emails
   */
  async handleListEmails(args: any): Promise<HandlerResult> {
    const limit = args.limit || 10;
    const folder = args.folder || 'inbox';
    const search = args.search;

    try {
      const emails = await this.emailService.listEmails({ 
        maxResults: limit, 
        folder: folder, 
        search: search 
      });
      
      if (!emails || emails.length === 0) {
        return this.formatSuccess('📭 Nenhum email encontrado');
      }
      
      let result = `📧 Lista de emails (${emails.length}):\n\n`;
      
      emails.forEach((email, index) => {
        const read = email.isRead ? '✓' : '○';
        const hasAttachment = email.hasAttachments ? '📎' : '';
        const preview = email.bodyPreview ? email.bodyPreview.substring(0, 100) + '...' : '';
        
        result += `${index + 1}. [${read}] ${hasAttachment} **${email.subject || '(Sem assunto)'}**\n`;
        result += `   De: ${email.from?.emailAddress?.address || 'Desconhecido'}\n`;
        result += `   Data: ${email.receivedDateTime ? new Date(email.receivedDateTime).toLocaleString('pt-BR') : 'Data desconhecida'}\n`;
        if (preview) {
          result += `   Preview: ${preview}\n`;
        }
        result += `   ID: ${email.id}\n\n`;
      });
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao listar emails', error);
    }
  }

  /**
   * Handler for sending email
   */
  async handleSendEmail(args: any): Promise<HandlerResult> {
    // Validate required fields
    const validationError = this.validateRequiredArgs(args, ['to', 'subject', 'body']);
    if (validationError) {
      return this.formatError(validationError);
    }
    
    const validatedArgs = {
      to: args.to || [],
      subject: args.subject || '',
      body: args.body || '',
      cc: args.cc,
      bcc: args.bcc,
      attachments: args.attachments
    };
    
    // Validate attachments if present
    if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
      const validation = AttachmentValidator.validateAttachments(validatedArgs.attachments);
      
      if (!validation.isValid) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro na validação dos anexos:\n\n${validation.errors.join('\n')}`
            }
          ],
          isError: true
        };
      }
      
      // Log warnings if any
      if (validation.warnings.length > 0) {
        console.warn('⚠️ Avisos sobre anexos:', validation.warnings);
      }
    }
    
    // Prepare template options if requested
    const enhancedOptions = args.useTemplate ? {
      useTemplate: true,
      templateOptions: {
        theme: args.templateTheme || 'professional',
        showHeader: !!args.companyName || !!args.logoUrl,
        showFooter: true,
        companyName: args.companyName,
        logoUrl: args.logoUrl
      },
      emailContent: {
        title: args.emailTitle,
        signature: args.signature
      }
    } : undefined;
    
    try {
      const result = await this.emailService.sendEmail(
        validatedArgs.to, 
        validatedArgs.subject, 
        validatedArgs.body, 
        validatedArgs.cc, 
        validatedArgs.bcc,
        validatedArgs.attachments,
        enhancedOptions
      );
      
      const attachmentInfo = validatedArgs.attachments && validatedArgs.attachments.length > 0 
        ? `\n📎 Anexos: ${validatedArgs.attachments.length} arquivo(s) - ${validatedArgs.attachments.map((att: any) => att.name).join(', ')}`
        : '';
      
      const attachmentDetails = result.attachmentInfo && result.attachmentInfo.count > 0
        ? `\n\n📊 Detalhes dos Anexos:\n• Total: ${result.attachmentInfo.count}\n• Tamanho: ${result.attachmentInfo.totalSize}${result.warnings && result.warnings.length > 0 ? `\n⚠️ Avisos: ${result.warnings.join('; ')}` : ''}`
        : '';
      
      return this.formatSuccess(
        `✅ Email enviado com sucesso!\n\n` +
        `Para: ${validatedArgs.to.join(', ')}\n` +
        `Assunto: ${validatedArgs.subject}\n` +
        `${validatedArgs.cc ? `CC: ${validatedArgs.cc.join(', ')}\n` : ''}` +
        `${validatedArgs.bcc ? `BCC: ${validatedArgs.bcc.join(', ')}\n` : ''}` +
        `${attachmentInfo}${attachmentDetails}\n\n` +
        `Message ID: ${result.messageId}`
      );
    } catch (error) {
      return this.formatError('Erro ao enviar email', error);
    }
  }

  /**
   * Handler for creating a draft message (no send).
   * Requires only Mail.ReadWrite; useful when the tenant policy blocks
   * application sendMail but still permits message creation.
   */
  async handleCreateDraft(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['to', 'subject', 'body']);
    if (validationError) {
      return this.formatError(validationError);
    }

    const validatedArgs = {
      to: args.to || [],
      subject: args.subject || '',
      body: args.body || '',
      cc: args.cc,
      bcc: args.bcc,
      attachments: args.attachments,
    };

    if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
      const validation = AttachmentValidator.validateAttachments(validatedArgs.attachments);
      if (!validation.isValid) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro na validação dos anexos:\n\n${validation.errors.join('\n')}`,
            },
          ],
          isError: true,
        };
      }
      if (validation.warnings.length > 0) {
        console.warn('⚠️ Avisos sobre anexos do rascunho:', validation.warnings);
      }
    }

    const enhancedOptions = args.useTemplate
      ? {
          useTemplate: true,
          templateOptions: {
            theme: args.templateTheme || 'professional',
            showHeader: !!args.companyName || !!args.logoUrl,
            showFooter: true,
            companyName: args.companyName,
            logoUrl: args.logoUrl,
          },
          emailContent: {
            title: args.emailTitle,
            signature: args.signature,
          },
        }
      : undefined;

    try {
      const result = await this.emailService.createDraft(
        validatedArgs.to,
        validatedArgs.subject,
        validatedArgs.body,
        validatedArgs.cc,
        validatedArgs.bcc,
        validatedArgs.attachments,
        enhancedOptions
      );

      const ccLine = validatedArgs.cc ? `CC: ${validatedArgs.cc.join(', ')}\n` : '';
      const bccLine = validatedArgs.bcc ? `BCC: ${validatedArgs.bcc.join(', ')}\n` : '';
      const attachLine =
        validatedArgs.attachments && validatedArgs.attachments.length > 0
          ? `📎 Anexos: ${validatedArgs.attachments.length} arquivo(s) — ${validatedArgs.attachments
              .map((att: any) => att.name)
              .join(', ')}\n`
          : '';
      const webLinkLine = result.webLink ? `Link: ${result.webLink}\n` : '';

      return this.formatSuccess(
        `📝 Rascunho criado com sucesso!\n\n` +
          `Para: ${validatedArgs.to.join(', ')}\n` +
          `Assunto: ${validatedArgs.subject}\n` +
          `${ccLine}${bccLine}${attachLine}\n` +
          `ID: ${result.draftId}\n` +
          `${webLinkLine}` +
          `\n💡 Rascunho salvo em "Rascunhos". Abra no Outlook para revisar e enviar.`
      );
    } catch (error) {
      return this.formatError('Erro ao criar rascunho', error);
    }
  }

  /**
   * Handler for replying to email
   */
  async handleReplyToEmail(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId', 'body']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      const result = await this.emailService.replyToEmail(
        args.emailId, 
        args.body,
        args.replyAll
      );
      
      return this.formatSuccess(
        `✅ Resposta enviada com sucesso!\n\n` +
        `Message ID: ${result.messageId}`
      );
    } catch (error) {
      return this.formatError('Erro ao responder email', error);
    }
  }

  /**
   * Handler for marking email as read
   */
  async handleMarkAsRead(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      await this.emailService.markAsRead(args.emailId);
      return this.formatSuccess(`✅ Email marcado como lido`);
    } catch (error) {
      return this.formatError('Erro ao marcar email como lido', error);
    }
  }

  /**
   * Handler for marking email as unread
   */
  async handleMarkAsUnread(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      const result = await this.emailService.markAsUnread(args.emailId);
      return this.formatSuccess(`✅ Email marcado como não lido`);
    } catch (error) {
      return this.formatError('Erro ao marcar email como não lido', error);
    }
  }

  /**
   * Handler for deleting email
   */
  async handleDeleteEmail(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      await this.emailService.deleteEmail(args.emailId);
      return this.formatSuccess(`✅ Email deletado com sucesso`);
    } catch (error) {
      return this.formatError('Erro ao deletar email', error);
    }
  }

  /**
   * Handler for summarizing single email
   */
  async handleSummarizeEmail(args: any): Promise<HandlerResult> {
    const validationError = this.validateRequiredArgs(args, ['emailId']);
    if (validationError) {
      return this.formatError(validationError);
    }

    try {
      const email = await this.emailService.getEmailById(args.emailId);
      if (!email) {
        return this.formatError('Email não encontrado');
      }

      const summary = await this.emailSummarizer.summarizeEmail(email);
      
      let result = `📧 **Resumo do Email**\n\n`;
      result += `**Assunto:** ${summary.subject}\n`;
      result += `**De:** ${summary.from}\n`;
      result += `**Data:** ${summary.date}\n`;
      result += `**Prioridade:** ${summary.priority}\n`;
      result += `**Categoria:** ${summary.category}\n`;
      result += `**Sentimento:** ${summary.sentiment}\n\n`;
      result += `**Resumo:** ${summary.summary}\n\n`;
      
      if (summary.keyPoints.length > 0) {
        result += `**Pontos Principais:**\n`;
        summary.keyPoints.forEach(point => {
          result += `• ${point}\n`;
        });
        result += '\n';
      }
      
      if (summary.actionRequired) {
        result += `⚠️ **Ação Requerida:** Sim\n\n`;
      }
      
      if (summary.attachments && summary.attachments.length > 0) {
        result += `📎 **Anexos:**\n`;
        summary.attachments.forEach(att => {
          result += `• ${att}\n`;
        });
      }
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao resumir email', error);
    }
  }

  /**
   * Handler for batch email summarization
   */
  async handleSummarizeEmailsBatch(args: any): Promise<HandlerResult> {
    const limit = args.limit || 5;
    const skip = args.skip || 0;
    const folder = args.folder || 'inbox';
    const priorityOnly = args.priorityOnly || false;

    try {
      const emails = await this.emailService.listEmails({ 
        maxResults: limit, 
        folder: folder 
      });
      
      if (!emails || emails.length === 0) {
        return this.formatSuccess('📭 Nenhum email encontrado para resumir');
      }
      
      const emailIds = emails.map(email => email.id!);
      const summaries = await this.emailSummarizer.summarizeEmailsBatch(emailIds, this.emailService);
      
      // Filter by priority if requested
      const filteredSummaries = priorityOnly 
        ? summaries.filter(s => s.priority === 'alta')
        : summaries;
      
      if (filteredSummaries.length === 0) {
        return this.formatSuccess('📭 Nenhum email prioritário encontrado');
      }
      
      let result = `📧 **Resumo de ${filteredSummaries.length} emails**\n\n`;
      
      // Group by priority
      const highPriority = filteredSummaries.filter(s => s.priority === 'alta');
      const mediumPriority = filteredSummaries.filter(s => s.priority === 'média');
      const lowPriority = filteredSummaries.filter(s => s.priority === 'baixa');
      
      if (highPriority.length > 0) {
        result += `🔴 **Alta Prioridade (${highPriority.length})**\n`;
        highPriority.forEach(summary => {
          result += this.formatEmailSummary(summary);
        });
        result += '\n';
      }
      
      if (mediumPriority.length > 0) {
        result += `🟡 **Média Prioridade (${mediumPriority.length})**\n`;
        mediumPriority.forEach(summary => {
          result += this.formatEmailSummary(summary);
        });
        result += '\n';
      }
      
      if (lowPriority.length > 0) {
        result += `🟢 **Baixa Prioridade (${lowPriority.length})**\n`;
        lowPriority.forEach(summary => {
          result += this.formatEmailSummary(summary);
        });
      }
      
      return this.formatSuccess(result);
    } catch (error) {
      return this.formatError('Erro ao resumir emails em lote', error);
    }
  }

  /**
   * Format individual email summary for batch display
   */
  private formatEmailSummary(summary: any): string {
    let result = `\n**${summary.subject}**\n`;
    result += `De: ${summary.from} | ${summary.date}\n`;
    result += `Categoria: ${summary.category} | Sentimento: ${summary.sentiment}\n`;
    result += `Resumo: ${summary.summary}\n`;
    
    if (summary.actionRequired) {
      result += `⚠️ Ação: Requerida\n`;
    }
    
    if (summary.attachments && summary.attachments.length > 0) {
      result += `📎 Anexos: ${summary.attachments.join(', ')}\n`;
    }
    
    return result;
  }

  /**
   * Handler for listing users
   */
  async handleListUsers(args: any): Promise<HandlerResult> {
    const limit = args.limit ?? 10;
    const search = args.search;

    try {
      const users = await this.emailService.listOrgUsers({ limit, search });
      if (users.length === 0) {
        return this.formatSuccess('👥 Nenhum usuário encontrado');
      }
      let out = `👥 Usuários (${users.length}):\n\n`;
      users.forEach((u, i) => {
        out += `${i + 1}. **${u.displayName || '(sem nome)'}**\n`;
        out += `   UPN: ${u.userPrincipalName || '-'}\n`;
        if (u.mail) out += `   Email: ${u.mail}\n`;
        out += `   ID: ${u.id}\n\n`;
      });
      return this.formatSuccess(out);
    } catch (error) {
      return this.formatError('Erro ao listar usuários (requer User.Read.All)', error);
    }
  }
}