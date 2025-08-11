import { Client } from '@microsoft/microsoft-graph-client';
import { GraphAuthProvider } from '../auth/graphAuth.js';
import { Message } from '@microsoft/microsoft-graph-types';

export interface EmailListOptions {
  maxResults?: number;
  filter?: string;
  search?: string;
  folder?: string;
}

export interface EmailSummaryData {
  id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
  attachments?: string[];
}

export class EmailService {
  private client: Client;

  constructor(private authProvider: GraphAuthProvider) {
    this.client = authProvider.getGraphClient();
  }

  async listEmails(options: EmailListOptions = {}): Promise<Message[]> {
    const {
      maxResults = 10,
      filter,
      search,
      folder = 'inbox'
    } = options;

    try {
      // Usar email específico configurado no .env, ou 'me' como fallback
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      let apiEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folder}/messages`
        : `/users/${userEmail}/mailFolders/${folder}/messages`;
      
      const queryParams: string[] = [
        `$top=${Math.min(maxResults, 100)}`, // Microsoft Graph limita a 100 por página
        `$orderby=receivedDateTime desc`,
        `$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,body`
      ];

      if (filter) {
        queryParams.push(`$filter=${encodeURIComponent(filter)}`);
      }

      if (search) {
        queryParams.push(`$search="${encodeURIComponent(search)}"`);
      }

      const queryString = queryParams.join('&');
      const fullEndpoint = `${apiEndpoint}?${queryString}`;

      const response = await this.client.api(fullEndpoint).get();
      
      return response.value || [];
    } catch (error) {
      console.error('Erro ao listar emails:', error);
      throw new Error(`Falha ao listar emails: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async getEmailById(emailId: string): Promise<Message> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}`
        : `/users/${userEmail}/messages/${emailId}`;
        
      const email = await this.client
        .api(apiPath)
        .select('id,subject,from,receivedDateTime,isRead,hasAttachments,body,attachments')
        .get();

      return email;
    } catch (error) {
      console.error(`Erro ao obter email ${emailId}:`, error);
      throw new Error(`Falha ao obter email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async searchEmails(query: string, maxResults: number = 10): Promise<Message[]> {
    return this.listEmails({
      search: query,
      maxResults
    });
  }

  async getUnreadEmails(maxResults: number = 10): Promise<Message[]> {
    return this.listEmails({
      filter: 'isRead eq false',
      maxResults
    });
  }

  async getEmailsFromSender(senderEmail: string, maxResults: number = 10): Promise<Message[]> {
    return this.listEmails({
      filter: `from/emailAddress/address eq '${senderEmail}'`,
      maxResults
    });
  }

  async getEmailsFromToday(): Promise<Message[]> {
    const today = new Date().toISOString().split('T')[0];
    return this.listEmails({
      filter: `receivedDateTime ge ${today}T00:00:00Z`,
      maxResults: 50
    });
  }

  async getEmailsByDateRange(startDate: string, endDate: string, maxResults: number = 50): Promise<Message[]> {
    return this.listEmails({
      filter: `receivedDateTime ge ${startDate}T00:00:00Z and receivedDateTime le ${endDate}T23:59:59Z`,
      maxResults
    });
  }

  extractEmailContent(email: Message): EmailSummaryData {
    const bodyContent = email.body?.content || '';
    
    // Remove HTML tags para obter texto puro
    const plainTextBody = bodyContent.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    
    // Extrair informações de anexos se existirem
    const attachments = email.attachments?.map((att: any) => att.name).filter(Boolean) || [];

    return {
      id: email.id || '',
      subject: email.subject || 'Sem assunto',
      from: email.from?.emailAddress?.address || 'Remetente desconhecido',
      date: email.receivedDateTime || '',
      body: plainTextBody,
      attachments: attachments.length > 0 ? attachments : undefined
    };
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.client.api('/me').get();
      return true;
    } catch (error) {
      console.error('Erro ao validar conexão com Microsoft Graph:', error);
      return false;
    }
  }

  // Funcionalidades de Envio de Email
  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' ? '/me/sendMail' : `/users/${userEmail}/sendMail`;

      const message = {
        message: {
          subject: subject,
          body: {
            contentType: 'HTML',
            content: body
          },
          toRecipients: to.map(email => ({ emailAddress: { address: email } })),
          ccRecipients: cc ? cc.map(email => ({ emailAddress: { address: email } })) : [],
          bccRecipients: bcc ? bcc.map(email => ({ emailAddress: { address: email } })) : []
        }
      };

      const response = await this.client.api(apiPath).post(message);
      return { success: true, messageId: response?.id };
    } catch (error) {
      console.error('Erro ao enviar email:', error);
      throw new Error(`Falha ao enviar email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async replyToEmail(emailId: string, body: string, replyAll: boolean = false): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const action = replyAll ? 'replyAll' : 'reply';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}/${action}`
        : `/users/${userEmail}/messages/${emailId}/${action}`;

      const replyMessage = {
        message: {
          body: {
            contentType: 'HTML',
            content: body
          }
        }
      };

      const response = await this.client.api(apiPath).post(replyMessage);
      return { success: true, messageId: response?.id };
    } catch (error) {
      console.error('Erro ao responder email:', error);
      throw new Error(`Falha ao responder email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  // Funcionalidades de Gestão de Status
  async markAsRead(emailId: string): Promise<boolean> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}`
        : `/users/${userEmail}/messages/${emailId}`;

      await this.client.api(apiPath).patch({ isRead: true });
      return true;
    } catch (error) {
      console.error('Erro ao marcar como lido:', error);
      throw new Error(`Falha ao marcar como lido: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async markAsUnread(emailId: string): Promise<boolean> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}`
        : `/users/${userEmail}/messages/${emailId}`;

      await this.client.api(apiPath).patch({ isRead: false });
      return true;
    } catch (error) {
      console.error('Erro ao marcar como não lido:', error);
      throw new Error(`Falha ao marcar como não lido: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async deleteEmail(emailId: string): Promise<boolean> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}`
        : `/users/${userEmail}/messages/${emailId}`;

      await this.client.api(apiPath).delete();
      return true;
    } catch (error) {
      console.error('Erro ao deletar email:', error);
      throw new Error(`Falha ao deletar email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  // Funcionalidades de Anexos
  async listAttachments(emailId: string): Promise<any[]> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}/attachments`
        : `/users/${userEmail}/messages/${emailId}/attachments`;

      const response = await this.client.api(apiPath).get();
      
      return response.value.map((attachment: any) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        isInline: attachment.isInline,
        attachmentType: attachment['@odata.type'] // Adiciona o tipo do anexo
      }));
    } catch (error) {
      console.error('Erro ao listar anexos:', error);
      throw new Error(`Falha ao listar anexos: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  async downloadAttachment(emailId: string, attachmentId: string): Promise<{ name: string, contentType: string, content: string, attachmentType?: string }> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}/attachments/${attachmentId}`
        : `/users/${userEmail}/messages/${emailId}/attachments/${attachmentId}`;

      // Primeiro, obter informações do anexo para identificar o tipo
      const attachment = await this.client.api(apiPath).get();
      const attachmentType = attachment['@odata.type'];
      
      let content = '';
      
      // Tratar diferentes tipos de anexo
      if (attachmentType === '#microsoft.graph.fileAttachment') {
        // FileAttachment - conteúdo em contentBytes
        content = attachment.contentBytes || '';
        
        // Se contentBytes estiver vazio, tentar endpoint /$value
        if (!content) {
          try {
            const rawContent = await this.client.api(`${apiPath}/$value`).get();
            // Converter buffer para Base64 se necessário
            content = typeof rawContent === 'string' ? rawContent : Buffer.from(rawContent).toString('base64');
          } catch (valueError) {
            console.warn('Não foi possível obter conteúdo via /$value:', valueError);
          }
        }
      } else if (attachmentType === '#microsoft.graph.itemAttachment') {
        // ItemAttachment - conteúdo MIME
        content = attachment.item ? JSON.stringify(attachment.item) : '';
      } else if (attachmentType === '#microsoft.graph.referenceAttachment') {
        // ReferenceAttachment - apenas metadados, sem conteúdo para download
        throw new Error('Anexos de referência (links para arquivos na nuvem) não podem ser baixados diretamente');
      } else {
        // Tipo desconhecido - tentar contentBytes como fallback
        content = attachment.contentBytes || '';
      }
      
      if (!content) {
        throw new Error('Conteúdo do anexo não encontrado ou está vazio');
      }
      
      return {
        name: attachment.name || 'anexo_sem_nome',
        contentType: attachment.contentType || 'application/octet-stream',
        content: content,
        attachmentType: attachmentType
      };
    } catch (error) {
      console.error('Erro ao baixar anexo:', error);
      throw new Error(`Falha ao baixar anexo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }
}