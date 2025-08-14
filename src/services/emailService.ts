import { Client } from '@microsoft/microsoft-graph-client';
import { GraphAuthProvider } from '../auth/graphAuth.js';
import { Message } from '@microsoft/microsoft-graph-types';
import { emailTemplateEngine, EmailTemplateOptions, EmailContent } from '../templates/emailTemplates.js';
import { FileManager } from './fileManager.js';

export interface EmailListOptions {
  maxResults?: number;
  filter?: string;
  search?: string;
  folder?: string;
}

export interface EmailAttachment {
  name: string;
  contentType: string;
  content: string; // Base64 encoded content
  size?: number;
}

export interface EnhancedEmailOptions {
  useTemplate?: boolean;
  templateOptions?: EmailTemplateOptions;
  emailContent?: {
    title?: string;
    signature?: string;
  };
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
  private fileManager: FileManager;

  constructor(private authProvider: GraphAuthProvider, customDownloadDir?: string) {
    this.client = authProvider.getGraphClient();
    this.fileManager = new FileManager(customDownloadDir);
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

      console.log(`📧 Listando emails: ${maxResults} resultados, pasta: ${folder}`);
      
      const queryParams: string[] = [
        `$top=${Math.min(maxResults, 100)}`, // Microsoft Graph limita a 100 por página
        `$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,body`
      ];

      // Microsoft Graph não permite $orderby com $search
      if (!search) {
        queryParams.push(`$orderby=receivedDateTime desc`);
      }

      if (filter) {
        queryParams.push(`$filter=${encodeURIComponent(filter)}`);
      }

      if (search) {
        // Remover caracteres especiais que podem causar problemas
        const cleanSearch = search.replace(/['"]/g, '');
        queryParams.push(`$search="${encodeURIComponent(cleanSearch)}"`);
      }

      const queryString = queryParams.join('&');
      const fullEndpoint = `${apiEndpoint}?${queryString}`;

      if (search || filter) {
        console.log(`🔍 Query: search="${search || 'none'}", filter="${filter || 'none'}"`);
      }

      const response = await this.client.api(fullEndpoint).get();
      
      console.log(`✅ Encontrados ${response.value?.length || 0} emails`);
      return response.value || [];
    } catch (error) {
      console.error('❌ Erro ao listar emails:', error);
      
      // Log detalhado para debugging
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const endpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folder}/messages`
        : `/users/${userEmail}/mailFolders/${folder}/messages`;
      console.error(`   Endpoint: ${endpoint}`);
      console.error(`   Query params: ${JSON.stringify(options)}`);
      
      // Tratamento específico para erros conhecidos
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      if (errorMessage.includes('$orderBy') && errorMessage.includes('$search')) {
        throw new Error(`Erro de compatibilidade OData corrigido. Tente novamente - o $orderBy foi removido ao usar $search.`);
      }
      
      if (errorMessage.includes('$search')) {
        throw new Error(`Erro de busca: ${errorMessage}. Verifique o termo de busca e tente novamente.`);
      }
      
      if (errorMessage.includes('$filter')) {
        throw new Error(`Erro de filtro: ${errorMessage}. Verifique a sintaxe do filtro OData.`);
      }
      
      throw new Error(`Falha ao listar emails: ${errorMessage}`);
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
      const userEmail = process.env.TARGET_USER_EMAIL;
      
      if (!userEmail) {
        console.error('TARGET_USER_EMAIL não configurado no .env');
        return false;
      }
      
      // Usar endpoint específico do usuário ao invés de /me
      // /me só funciona com delegated authentication
      await this.client.api(`/users/${userEmail}`).select('id,mail').get();
      return true;
    } catch (error) {
      console.error('Erro ao validar conexão com Microsoft Graph:', error);
      return false;
    }
  }

  // Funcionalidades de Envio de Email
  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[], attachments?: EmailAttachment[], enhancedOptions?: EnhancedEmailOptions): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' ? '/me/sendMail' : `/users/${userEmail}/sendMail`;

      // Preparar conteúdo do email com template se solicitado
      let emailBody = body;
      
      if (enhancedOptions?.useTemplate) {
        console.log('🎨 Aplicando template HTML elegante...');
        
        const emailContent: EmailContent = {
          title: enhancedOptions.emailContent?.title,
          body: body,
          signature: enhancedOptions.emailContent?.signature,
          attachmentList: attachments?.map(att => att.name)
        };
        
        emailBody = emailTemplateEngine.formatNewEmail(
          emailContent, 
          enhancedOptions.templateOptions || {}
        );
        
        // Validar template
        const validation = emailTemplateEngine.validateTemplate(emailBody);
        if (!validation.valid) {
          console.warn('⚠️  Template warnings:', validation.warnings.join(', '));
        } else {
          console.log('✅ Template validado com sucesso');
        }
      }

      const message: any = {
        message: {
          subject: subject,
          body: {
            contentType: 'HTML',
            content: emailBody
          },
          toRecipients: to.map(email => ({ emailAddress: { address: email } })),
          ccRecipients: cc ? cc.map(email => ({ emailAddress: { address: email } })) : [],
          bccRecipients: bcc ? bcc.map(email => ({ emailAddress: { address: email } })) : []
        }
      };

      // Adicionar anexos se fornecidos
      if (attachments && attachments.length > 0) {
        console.log(`📎 Processando ${attachments.length} anexo(s) para Microsoft Graph...`);
        
        const processedAttachments = [];
        
        for (let i = 0; i < attachments.length; i++) {
          const attachment = attachments[i];
          console.log(`   ${i + 1}. Processando "${attachment.name}"`);
          
          // Validar e preparar Base64 para Microsoft Graph API (preservando integridade)
          const cleanBase64 = this.cleanBase64ForMSGraph(attachment.content);
          
          // Verificar se o arquivo foi modificado
          if (cleanBase64.length !== attachment.content.length) {
            console.log(`   ⚠️  Arquivo foi modificado: ${attachment.content.length} → ${cleanBase64.length} chars`);
          } else {
            console.log(`   ✅ Arquivo preservado intacto: ${cleanBase64.length} chars`);
          }
          
          // Validar tamanho real do arquivo decodificado
          let decodedSize: number;
          try {
            const buffer = Buffer.from(cleanBase64, 'base64');
            decodedSize = buffer.length;
          } catch (error) {
            throw new Error(`Anexo "${attachment.name}" tem Base64 inválido: ${error instanceof Error ? error.message : 'formato incorreto'}`);
          }
          
          if (decodedSize > 15 * 1024 * 1024) { // 15MB limit
            throw new Error(`Anexo "${attachment.name}" muito grande: ${(decodedSize / (1024 * 1024)).toFixed(2)}MB. Limite: 15MB`);
          }
          
          console.log(`   ✅ "${attachment.name}" - ${(decodedSize / 1024).toFixed(1)}KB - ${attachment.contentType}`);
          
          processedAttachments.push({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: attachment.name,
            contentType: attachment.contentType,
            contentBytes: cleanBase64
          });
        }
        
        message.message.attachments = processedAttachments;
        console.log('✅ Todos os anexos processados e prontos para Microsoft Graph');
      }

      console.log('📧 Enviando email...');
      const response = await this.client.api(apiPath).post(message);
      console.log('✅ Email enviado com sucesso');
      
      return { 
        success: true, 
        messageId: response?.id, 
        attachmentsCount: attachments?.length || 0 
      };
    } catch (error) {
      console.error('❌ Erro ao enviar email:', error);
      
      const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
      
      // Detectar erros específicos de anexo
      const lowerErrorMsg = errorMsg.toLowerCase();
      
      if (lowerErrorMsg.includes('edm.binary') || lowerErrorMsg.includes('cannot convert')) {
        throw new Error(`❌ Erro de formato Base64: ${errorMsg}\n\n🔧 Este erro foi corrigido! Tente novamente:\n- O Base64 agora é limpo automaticamente\n- Caracteres inválidos são removidos\n- Padding é corrigido automaticamente\n- Teste com: node attachment-debug-test.js <arquivo>`);
      }
      
      if (lowerErrorMsg.includes('attachment') || 
          lowerErrorMsg.includes('content') || 
          lowerErrorMsg.includes('base64') ||
          lowerErrorMsg.includes('size') ||
          lowerErrorMsg.includes('malformed')) {
        throw new Error(`Erro de anexo: ${errorMsg}\n\n🔧 Dicas:\n- Verifique se o arquivo não está corrompido\n- Use tamanho menor que 15MB\n- Para boletos PDF use contentType 'application/pdf'\n- Teste com: node attachment-debug-test.js <arquivo>`);
      }
      
      throw new Error(`Falha ao enviar email: ${errorMsg}`);
    }
  }

  async replyToEmail(emailId: string, body: string, replyAll: boolean = false, enhancedOptions?: EnhancedEmailOptions): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const action = replyAll ? 'replyAll' : 'reply';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}/${action}`
        : `/users/${userEmail}/messages/${emailId}/${action}`;

      // Preparar conteúdo da resposta com template se solicitado
      let replyBody = body;
      
      if (enhancedOptions?.useTemplate) {
        console.log('🎨 Aplicando template HTML para resposta...');
        
        try {
          // Buscar email original para incluir no template
          const originalEmail = await this.getEmailById(emailId);
          
          const replyContent: EmailContent = {
            title: enhancedOptions.emailContent?.title,
            body: body,
            signature: enhancedOptions.emailContent?.signature
          };
          
          const originalContent: EmailContent = {
            body: originalEmail.body?.content || '',
            metadata: {
              sender: originalEmail.from?.emailAddress?.address || undefined,
              date: originalEmail.receivedDateTime || undefined,
              originalSubject: originalEmail.subject || undefined
            },
            attachmentList: originalEmail.attachments?.map((att: any) => att.name).filter(Boolean)
          };
          
          replyBody = emailTemplateEngine.formatReplyEmail(
            replyContent,
            originalContent, 
            enhancedOptions.templateOptions || {}
          );
          
          console.log('✅ Template de resposta aplicado com sucesso');
          
        } catch (templateError) {
          console.warn('⚠️  Erro ao aplicar template, usando formato simples:', templateError);
          replyBody = emailTemplateEngine.formatSimpleEmail(body);
        }
      }

      const replyMessage = {
        message: {
          body: {
            contentType: 'HTML',
            content: replyBody
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

  async downloadAttachment(emailId: string, attachmentId: string): Promise<{ name: string, contentType: string, content: string, attachmentType?: string, size?: number }> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiPath = userEmail === 'me' 
        ? `/me/messages/${emailId}/attachments/${attachmentId}`
        : `/users/${userEmail}/messages/${emailId}/attachments/${attachmentId}`;

      console.log(`📥 Baixando anexo...`);
      
      // Obter informações completas do anexo incluindo conteúdo
      const attachment = await this.client.api(apiPath).get();
      const attachmentType = attachment['@odata.type'];
      
      console.log(`   Nome: ${attachment.name}`);
      console.log(`   Tipo: ${attachment.contentType}`);
      console.log(`   Tamanho reportado: ${attachment.size} bytes`);
      
      let content = '';
      let actualSize = 0;
      
      // Tratar diferentes tipos de anexo
      if (attachmentType === '#microsoft.graph.fileAttachment') {
        // FileAttachment - conteúdo em contentBytes (já em Base64)
        content = attachment.contentBytes || '';
        
        if (!content) {
          console.warn('⚠️  contentBytes vazio, tentando método alternativo...');
          
          // Tentar buscar com $value (retorna o conteúdo bruto)
          try {
            const rawContent = await this.client.api(`${apiPath}/$value`).get();
            
            // O $value retorna o conteúdo binário, precisamos converter para Base64
            if (rawContent instanceof ArrayBuffer) {
              const uint8Array = new Uint8Array(rawContent);
              content = Buffer.from(uint8Array).toString('base64');
            } else if (rawContent instanceof Uint8Array) {
              content = Buffer.from(rawContent).toString('base64');
            } else if (typeof rawContent === 'string') {
              // Se já for string, assumir que está em Base64
              content = rawContent;
            } else if (Buffer.isBuffer(rawContent)) {
              content = rawContent.toString('base64');
            } else {
              console.error('Tipo de conteúdo desconhecido:', typeof rawContent);
              throw new Error('Formato de conteúdo não reconhecido');
            }
          } catch (valueError) {
            console.error('Erro ao obter conteúdo via /$value:', valueError);
            throw valueError;
          }
        }
        
        // Validar e limpar o Base64
        if (content) {
          // Remover espaços, quebras de linha e caracteres invisíveis
          const originalLength = content.length;
          content = content.replace(/[\s\r\n\t]+/g, '');
          
          if (originalLength !== content.length) {
            console.log(`   🧹 Limpeza: removidos ${originalLength - content.length} caracteres`);
          }
          
          // Corrigir padding se necessário
          const remainder = content.length % 4;
          if (remainder !== 0) {
            const paddingNeeded = 4 - remainder;
            content += '='.repeat(paddingNeeded);
            console.log(`   🔧 Padding corrigido: adicionados ${paddingNeeded} caracteres`);
          }
          
          // Verificar se é Base64 válido e obter tamanho real
          try {
            const testBuffer = Buffer.from(content, 'base64');
            actualSize = testBuffer.length;
            console.log(`   ✅ Base64 válido: ${(actualSize / 1024).toFixed(2)}KB decodificado`);
            
            // Verificar discrepância com tamanho reportado
            if (attachment.size && Math.abs(actualSize - attachment.size) > 1000) {
              console.warn(`   ⚠️  Discrepância de tamanho: reportado ${attachment.size} bytes, real ${actualSize} bytes`);
              
              // Se o arquivo está significativamente menor, pode estar truncado
              if (actualSize < attachment.size * 0.9) {
                console.warn(`   ⚠️  Possível truncamento: apenas ${((actualSize / attachment.size) * 100).toFixed(1)}% do arquivo`);
              }
            }
          } catch (b64Error) {
            const errorMessage = b64Error instanceof Error ? b64Error.message : 'Erro desconhecido';
            console.error('   ❌ Base64 inválido:', errorMessage);
            throw new Error(`Conteúdo do anexo não é Base64 válido: ${errorMessage}`);
          }
        }
        
      } else if (attachmentType === '#microsoft.graph.itemAttachment') {
        // ItemAttachment - email anexado
        console.log('   📧 ItemAttachment detectado (email anexado)');
        content = attachment.item ? Buffer.from(JSON.stringify(attachment.item)).toString('base64') : '';
        if (content) {
          actualSize = Buffer.from(content, 'base64').length;
        }
        
      } else if (attachmentType === '#microsoft.graph.referenceAttachment') {
        // ReferenceAttachment - link para arquivo na nuvem
        console.warn('   ⚠️  ReferenceAttachment (link para nuvem) - não pode ser baixado diretamente');
        throw new Error('Anexos de referência (links para arquivos na nuvem) não podem ser baixados diretamente. Use o link: ' + (attachment.sourceUrl || 'não disponível'));
        
      } else {
        // Tipo desconhecido - tentar contentBytes como fallback
        console.warn(`   ⚠️  Tipo desconhecido: ${attachmentType}, tentando contentBytes...`);
        content = attachment.contentBytes || '';
        if (content) {
          actualSize = Buffer.from(content, 'base64').length;
        }
      }
      
      if (!content) {
        throw new Error('Conteúdo do anexo não encontrado ou está vazio');
      }
      
      console.log(`   📦 Download concluído: ${content.length} caracteres Base64`);
      
      return {
        name: attachment.name || 'anexo_sem_nome',
        contentType: attachment.contentType || 'application/octet-stream',
        content: content,
        attachmentType: attachmentType,
        size: actualSize
      };
    } catch (error) {
      console.error('❌ Erro ao baixar anexo:', error);
      throw new Error(`Falha ao baixar anexo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  /**
   * Valida e prepara Base64 para Microsoft Graph API
   * Garante que o Base64 seja válido e esteja no formato correto para Microsoft Graph
   */
  private cleanBase64ForMSGraph(base64Content: string): string {
    const originalSize = base64Content.length;
    console.log(`   📏 Base64 original: ${originalSize} caracteres`);
    
    // 1. Remover prefixo data: URI se presente
    let cleanContent = base64Content;
    const dataUriMatch = base64Content.match(/^data:[^;]+;base64,(.*)$/);
    if (dataUriMatch) {
      cleanContent = dataUriMatch[1];
      console.log(`   🔧 Removido prefixo data: URI - agora: ${cleanContent.length} caracteres`);
    }
    
    // 2. Remover espaços em branco, quebras de linha e caracteres invisíveis
    cleanContent = cleanContent.replace(/[\s\r\n\t]+/g, '');
    
    // 3. Remover caracteres não-Base64 que possam ter sido introduzidos
    cleanContent = cleanContent.replace(/[^A-Za-z0-9+/=]/g, '');
    
    const afterCleanSize = cleanContent.length;
    console.log(`   🧹 Após limpeza: ${afterCleanSize} caracteres`);
    
    // 4. Corrigir padding se necessário
    const remainder = cleanContent.length % 4;
    if (remainder !== 0) {
      const paddingNeeded = 4 - remainder;
      cleanContent += '='.repeat(paddingNeeded);
      console.log(`   🔧 Adicionado ${paddingNeeded} caractere(s) de padding`);
    }
    
    // 5. Validar que o Base64 é válido
    try {
      const testBuffer = Buffer.from(cleanContent, 'base64');
      const decodedSize = testBuffer.length;
      console.log(`   ✅ Base64 válido - arquivo de ${(decodedSize / 1024).toFixed(1)}KB`);
      
      return cleanContent;
      
    } catch (error) {
      throw new Error(`Base64 inválido mesmo após correções: ${error instanceof Error ? error.message : 'formato incorreto'}`);
    }
  }

  /**
   * Download otimizado de anexos grandes - salva diretamente no disco
   * Evita limitações de token do MCP retornando apenas metadados
   */
  async downloadAttachmentToFile(
    emailId: string, 
    attachmentId: string,
    options: {
      targetDirectory?: string;
      filename?: string;
      overwrite?: boolean;
      validateIntegrity?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    filename: string;
    filePath: string;
    originalSize: number;
    savedSize: number;
    contentType: string;
    integrity: boolean;
    downloadTime: number;
    error?: string;
  }> {
    const startTime = Date.now();
    
    try {
      console.log('🚀 Iniciando download otimizado...');
      console.log(`   Email ID: ${emailId.substring(0, 30)}...`);
      console.log(`   Attachment ID: ${attachmentId.substring(0, 30)}...`);

      // 1. Baixar anexo usando método existente
      const attachment = await this.downloadAttachment(emailId, attachmentId);
      
      console.log('📦 Anexo obtido via Graph API');
      console.log(`   Nome: ${attachment.name}`);
      console.log(`   Tipo: ${attachment.contentType}`);
      console.log(`   Tamanho: ${attachment.size || 0} bytes`);

      // 2. Preparar dados para o FileManager
      const attachmentData = {
        name: attachment.name,
        contentType: attachment.contentType,
        contentBytes: attachment.content, // Base64
        size: attachment.size || 0,
        id: attachmentId
      };

      // 3. Salvar usando FileManager otimizado
      const saveResult = await this.fileManager.saveAttachmentToDisk(
        attachmentData, 
        options
      );

      const downloadTime = Date.now() - startTime;

      console.log(`✅ Download concluído em ${downloadTime}ms`);
      console.log(`   Arquivo: ${saveResult.filePath}`);
      console.log(`   Tamanho salvo: ${saveResult.savedSize} bytes`);
      console.log(`   Integridade: ${saveResult.integrity ? '✅' : '⚠️'}`);

      return {
        success: saveResult.success,
        filename: attachment.name,
        filePath: saveResult.filePath,
        originalSize: saveResult.originalSize,
        savedSize: saveResult.savedSize,
        contentType: attachment.contentType,
        integrity: saveResult.integrity,
        downloadTime,
        error: saveResult.error
      };

    } catch (error) {
      const downloadTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      console.error(`❌ Falha no download após ${downloadTime}ms:`, errorMessage);
      
      return {
        success: false,
        filename: '',
        filePath: '',
        originalSize: 0,
        savedSize: 0,
        contentType: '',
        integrity: false,
        downloadTime,
        error: errorMessage
      };
    }
  }

  /**
   * Lista todos os arquivos baixados pelo FileManager
   */
  getDownloadedFiles(): Array<{
    name: string;
    path: string;
    size: number;
    modified: Date;
  }> {
    return this.fileManager.listDownloadedFiles();
  }

  /**
   * Limpa arquivos antigos baixados
   */
  cleanupOldDownloads(maxAgeHours: number = 24): number {
    return this.fileManager.cleanupOldFiles(maxAgeHours);
  }

  /**
   * Obtém informações sobre o diretório de downloads
   */
  getDownloadDirectoryInfo(): {
    path: string;
    exists: boolean;
    fileCount: number;
    totalSize: number;
  } {
    return this.fileManager.getDownloadDirInfo();
  }

  /**
   * Download em lote de múltiplos anexos de um email
   */
  async downloadAllAttachmentsFromEmail(
    emailId: string,
    options: {
      targetDirectory?: string;
      overwrite?: boolean;
      validateIntegrity?: boolean;
      maxConcurrent?: number;
    } = {}
  ): Promise<{
    success: boolean;
    totalFiles: number;
    successfulDownloads: number;
    failedDownloads: number;
    downloadTime: number;
    results: Array<{
      filename: string;
      success: boolean;
      filePath?: string;
      error?: string;
    }>;
  }> {
    const startTime = Date.now();
    const maxConcurrent = options.maxConcurrent || 3;
    
    try {
      console.log('📦 Iniciando download em lote...');
      
      // 1. Listar todos os anexos do email
      const attachments = await this.listAttachments(emailId);
      
      if (attachments.length === 0) {
        console.log('📭 Nenhum anexo encontrado no email');
        return {
          success: true,
          totalFiles: 0,
          successfulDownloads: 0,
          failedDownloads: 0,
          downloadTime: Date.now() - startTime,
          results: []
        };
      }

      console.log(`📎 ${attachments.length} anexos encontrados`);

      // 2. Download com controle de concorrência
      const results = [];
      let successfulDownloads = 0;
      let failedDownloads = 0;

      // Processar em lotes para evitar sobrecarga
      for (let i = 0; i < attachments.length; i += maxConcurrent) {
        const batch = attachments.slice(i, i + maxConcurrent);
        
        const batchPromises = batch.map(async (attachment) => {
          try {
            const result = await this.downloadAttachmentToFile(
              emailId, 
              attachment.id, 
              {
                ...options,
                filename: attachment.name
              }
            );

            if (result.success) {
              successfulDownloads++;
              return {
                filename: attachment.name,
                success: true,
                filePath: result.filePath
              };
            } else {
              failedDownloads++;
              return {
                filename: attachment.name,
                success: false,
                error: result.error
              };
            }
          } catch (error) {
            failedDownloads++;
            return {
              filename: attachment.name,
              success: false,
              error: error instanceof Error ? error.message : 'Erro desconhecido'
            };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        console.log(`📊 Lote ${i / maxConcurrent + 1} processado: ${batchResults.length} arquivos`);
      }

      const downloadTime = Date.now() - startTime;
      
      console.log(`✅ Download em lote concluído em ${downloadTime}ms`);
      console.log(`   Total: ${attachments.length} arquivos`);
      console.log(`   Sucessos: ${successfulDownloads}`);
      console.log(`   Falhas: ${failedDownloads}`);

      return {
        success: failedDownloads === 0,
        totalFiles: attachments.length,
        successfulDownloads,
        failedDownloads,
        downloadTime,
        results
      };

    } catch (error) {
      const downloadTime = Date.now() - startTime;
      console.error('❌ Erro no download em lote:', error);
      
      return {
        success: false,
        totalFiles: 0,
        successfulDownloads: 0,
        failedDownloads: 0,
        downloadTime,
        results: []
      };
    }
  }

  /**
   * Exporta um email como anexo EML para usar em outro email
   */
  async exportEmailAsAttachment(emailId: string): Promise<EmailAttachment> {
    try {
      console.log(`📧 Exportando email ${emailId.substring(0, 30)}... como anexo EML`);

      // 1. Buscar dados básicos do email
      const userEmail = process.env.TARGET_USER_EMAIL;
      const baseUrl = userEmail 
        ? `/users/${userEmail}/messages/${emailId}`
        : `/me/messages/${emailId}`;

      const client = this.authProvider.getGraphClient();
      const emailData = await client.api(baseUrl).get();

      // 2. Buscar o conteúdo MIME completo do email
      const mimeUrl = userEmail
        ? `/users/${userEmail}/messages/${emailId}/$value`
        : `/me/messages/${emailId}/$value`;

      console.log('🔄 Obtendo conteúdo MIME completo...');
      const mimeContent = await client.api(mimeUrl).get();

      // 3. Gerar nome do arquivo baseado no assunto e data
      const subject = emailData.subject || 'Email sem assunto';
      const receivedDate = new Date(emailData.receivedDateTime);
      const dateStr = receivedDate.toISOString().split('T')[0]; // YYYY-MM-DD
      
      // Limpar caracteres especiais do nome do arquivo
      const cleanSubject = subject
        .replace(/[<>:"/\\|?*]/g, '_')
        .substring(0, 50);
      
      const fileName = `${dateStr}_${cleanSubject}.eml`;

      // 4. Converter conteúdo MIME para Base64
      const base64Content = Buffer.from(mimeContent, 'utf8').toString('base64');

      console.log('✅ Email exportado com sucesso');
      console.log(`   Arquivo: ${fileName}`);
      console.log(`   Tamanho: ${(base64Content.length / 1024).toFixed(1)}KB (Base64)`);
      console.log(`   Assunto original: ${subject}`);

      return {
        name: fileName,
        contentType: 'message/rfc822', // MIME type padrão para emails
        content: base64Content,
        size: Buffer.from(base64Content, 'base64').length // tamanho real do arquivo
      };

    } catch (error) {
      console.error('❌ Erro ao exportar email como anexo:', error);
      throw new Error(`Falha ao exportar email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  /**
   * Codifica um arquivo do sistema de arquivos para uso como anexo de email
   * Método de conveniência que usa o FileManager interno
   */
  async encodeFileForAttachment(filePath: string): Promise<{
    success: boolean;
    name: string;
    contentType: string;
    content: string; // Base64 encoded
    size: number;
    error?: string;
  }> {
    return await this.fileManager.encodeFileForEmailAttachment(filePath);
  }

  /**
   * Função híbrida: baixa anexo e envia email automaticamente
   * Soluciona limitações do MCP para arquivos grandes
   */
  async sendEmailFromAttachment(
    sourceEmailId: string,
    attachmentId: string,
    to: string[],
    subject: string,
    body: string,
    options: {
      cc?: string[];
      bcc?: string[];
      replyAll?: boolean;
      enhancedOptions?: EnhancedEmailOptions;
      keepOriginalFile?: boolean;
      customFilename?: string;
    } = {}
  ): Promise<{
    success: boolean;
    downloadResult: any;
    sendResult: any;
    attachmentInfo: {
      name: string;
      size: number;
      contentType: string;
      filePath: string;
    };
    totalTime: number;
    error?: string;
  }> {
    const startTime = Date.now();
    
    try {
      console.log('🚀 Iniciando envio híbrido de email com anexo...');
      console.log(`   Email origem: ${sourceEmailId.substring(0, 30)}...`);
      console.log(`   Anexo: ${attachmentId.substring(0, 30)}...`);
      console.log(`   Destinatários: ${to.join(', ')}`);

      // 1. Baixar anexo para disco
      console.log('📥 Fase 1: Baixando anexo...');
      const downloadResult = await this.downloadAttachmentToFile(
        sourceEmailId,
        attachmentId,
        {
          filename: options.customFilename,
          overwrite: true,
          validateIntegrity: true
        }
      );

      if (!downloadResult.success) {
        throw new Error(`Falha no download: ${downloadResult.error}`);
      }

      console.log('✅ Download concluído');
      console.log(`   Arquivo: ${downloadResult.filename}`);
      console.log(`   Tamanho: ${(downloadResult.savedSize / 1024).toFixed(1)}KB`);
      console.log(`   Local: ${downloadResult.filePath}`);

      // 2. Codificar arquivo para anexo
      console.log('🔄 Fase 2: Codificando para anexo...');
      const encodingResult = await this.fileManager.encodeFileForEmailAttachment(
        downloadResult.filePath
      );

      if (!encodingResult.success) {
        throw new Error(`Falha na codificação: ${encodingResult.error}`);
      }

      console.log('✅ Codificação concluída');
      console.log(`   Base64: ${encodingResult.content.length} caracteres`);

      // 3. Preparar anexo para envio
      const attachmentForEmail: EmailAttachment = {
        name: encodingResult.name,
        contentType: encodingResult.contentType,
        content: encodingResult.content,
        size: encodingResult.size
      };

      // 4. Enviar email
      console.log('📧 Fase 3: Enviando email...');
      const sendResult = await this.sendEmail(
        to,
        subject,
        body,
        options.cc,
        options.bcc,
        [attachmentForEmail],
        options.enhancedOptions
      );

      if (!sendResult.success) {
        throw new Error(`Falha no envio: ${sendResult}`);
      }

      // 5. Limpeza opcional
      if (!options.keepOriginalFile) {
        try {
          const fs = await import('fs');
          fs.default.unlinkSync(downloadResult.filePath);
          console.log('🗑️  Arquivo temporário removido');
        } catch (cleanupError) {
          console.warn('⚠️  Erro ao remover arquivo temporário:', cleanupError);
        }
      }

      const totalTime = Date.now() - startTime;

      console.log('🎉 Envio híbrido concluído com sucesso!');
      console.log(`   Tempo total: ${totalTime}ms`);
      console.log(`   Message ID: ${sendResult.messageId || 'N/A'}`);

      return {
        success: true,
        downloadResult,
        sendResult,
        attachmentInfo: {
          name: downloadResult.filename,
          size: downloadResult.savedSize,
          contentType: downloadResult.contentType,
          filePath: downloadResult.filePath
        },
        totalTime
      };

    } catch (error) {
      const totalTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      console.error(`❌ Falha no envio híbrido após ${totalTime}ms:`, errorMessage);
      
      return {
        success: false,
        downloadResult: null,
        sendResult: null,
        attachmentInfo: {
          name: '',
          size: 0,
          contentType: '',
          filePath: ''
        },
        totalTime,
        error: errorMessage
      };
    }
  }

  /**
   * Função híbrida simplificada: envia email com anexo já baixado do disco
   */
  async sendEmailWithFileAttachment(
    filePath: string,
    to: string[],
    subject: string,
    body: string,
    options: {
      cc?: string[];
      bcc?: string[];
      enhancedOptions?: EnhancedEmailOptions;
      customFilename?: string;
    } = {}
  ): Promise<{
    success: boolean;
    sendResult: any;
    attachmentInfo: {
      name: string;
      size: number;
      contentType: string;
    };
    error?: string;
  }> {
    try {
      console.log('📎 Enviando email com arquivo do disco...');
      console.log(`   Arquivo: ${filePath}`);
      console.log(`   Destinatários: ${to.join(', ')}`);

      // 1. Codificar arquivo
      const encodingResult = await this.fileManager.encodeFileForEmailAttachment(filePath);

      if (!encodingResult.success) {
        throw new Error(`Falha na codificação: ${encodingResult.error}`);
      }

      // 2. Preparar anexo
      const attachmentForEmail: EmailAttachment = {
        name: options.customFilename || encodingResult.name,
        contentType: encodingResult.contentType,
        content: encodingResult.content,
        size: encodingResult.size
      };

      // 3. Enviar email
      const sendResult = await this.sendEmail(
        to,
        subject,
        body,
        options.cc,
        options.bcc,
        [attachmentForEmail],
        options.enhancedOptions
      );

      console.log('✅ Email enviado com anexo do disco');

      return {
        success: true,
        sendResult,
        attachmentInfo: {
          name: attachmentForEmail.name,
          size: attachmentForEmail.size || 0,
          contentType: attachmentForEmail.contentType
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      console.error('❌ Erro no envio com arquivo do disco:', errorMessage);
      
      return {
        success: false,
        sendResult: null,
        attachmentInfo: {
          name: '',
          size: 0,
          contentType: ''
        },
        error: errorMessage
      };
    }
  }
}