import { Client } from '@microsoft/microsoft-graph-client';
import { GraphAuthProvider } from '../auth/graphAuth.js';
import { Message } from '@microsoft/microsoft-graph-types';
import { emailTemplateEngine, EmailTemplateOptions, EmailContent } from '../templates/emailTemplates.js';
import { FileManager } from './fileManager.js';
import { CacheManager } from './cacheManager.js';
import { GraphOptimizer } from './graphOptimizer.js';
import { ParallelProcessor } from './parallelProcessor.js';

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
  private cacheManager: CacheManager;
  private graphOptimizer: GraphOptimizer;
  private parallelProcessor: ParallelProcessor<any, any>;

  constructor(private authProvider: GraphAuthProvider, customDownloadDir?: string) {
    this.client = authProvider.getGraphClient();
    this.fileManager = new FileManager(customDownloadDir);
    
    // Initialize performance optimization systems
    this.cacheManager = new CacheManager({
      defaultTtl: 5 * 60 * 1000, // 5 minutes
      maxSize: 1000,
      enableStats: true
    });
    
    this.graphOptimizer = new GraphOptimizer(this.client, this.cacheManager, {
      enableBatching: true,
      batchSize: 20,
      enableSelectiveFields: true,
      enableCompression: true
    });

    this.parallelProcessor = new ParallelProcessor(
      async (data: any) => data, // Default identity function
      {
        maxConcurrency: 5,
        adaptiveConcurrency: true,
        priorityQueuing: true
      }
    );

    // Preload common patterns
    this.initializeOptimizations();
  }

  /**
   * Initialize performance optimizations
   */
  private async initializeOptimizations(): Promise<void> {
    try {
      // Preload common cache patterns after a short delay
      setTimeout(async () => {
        await this.cacheManager.preloadCommonPatterns(this);
      }, 2000);
      
      console.log('⚡ EmailService optimizations initialized');
    } catch (error) {
      console.warn('⚠️ Failed to initialize optimizations:', error);
    }
  }

  async listEmails(options: EmailListOptions = {}): Promise<Message[]> {
    const {
      maxResults = 10,
      filter,
      search,
      folder = 'inbox'
    } = options;

    try {
      // Use GraphOptimizer for optimized email fetching with caching
      const optimizedOptions = {
        folder,
        maxResults,
        search,
        filter,
        enableCache: true,
        select: this.graphOptimizer.getOptimalFields('list'),
        orderBy: search ? undefined : 'receivedDateTime desc' // OData compatibility
      };

      console.log(`📧 Listando emails otimizado: ${maxResults} resultados, pasta: ${folder}`);
      
      if (search || filter) {
        console.log(`🔍 Query: search="${search || 'none'}", filter="${filter || 'none'}"`);
      }

      const emails = await this.graphOptimizer.getOptimizedEmails(optimizedOptions);
      
      console.log(`✅ Encontrados ${emails.length} emails (com cache/otimização)`);
      return emails;
    } catch (error) {
      console.error('❌ Erro ao listar emails otimizado:', error);
      
      // Fallback to original implementation if optimization fails
      console.log('🔄 Fallback para implementação original...');
      
      try {
        const userEmail = process.env.TARGET_USER_EMAIL || 'me';
        let apiEndpoint = userEmail === 'me' 
          ? `/me/mailFolders/${folder}/messages`
          : `/users/${userEmail}/mailFolders/${folder}/messages`;

        const queryParams: string[] = [
          `$top=${Math.min(maxResults, 100)}`,
          `$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,body`
        ];

        if (!search) {
          queryParams.push(`$orderby=receivedDateTime desc`);
        }

        if (filter) {
          queryParams.push(`$filter=${encodeURIComponent(filter)}`);
        }

        if (search) {
          const cleanSearch = search.replace(/['"]/g, '');
          queryParams.push(`$search="${encodeURIComponent(cleanSearch)}"`);
        }

        const queryString = queryParams.join('&');
        const fullEndpoint = `${apiEndpoint}?${queryString}`;

        const response = await this.client.api(fullEndpoint).get();
        
        console.log(`✅ Fallback concluído: ${response.value?.length || 0} emails`);
        return response.value || [];
      } catch (fallbackError) {
        const errorMessage = fallbackError instanceof Error ? fallbackError.message : 'Erro desconhecido';
        
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

  // ===============================
  // FOLDER MANAGEMENT METHODS
  // ===============================

  /**
   * List email folders with optional subfolder inclusion
   */
  async listFolders(includeSubfolders: boolean = true, maxDepth: number = 3): Promise<any[]> {
    try {
      console.log(`📁 Listando pastas otimizado${includeSubfolders ? ' (incluindo subpastas)' : ''}`);

      // Use GraphOptimizer for optimized folder fetching with caching
      const folders = await this.graphOptimizer.getOptimizedFolders({
        includeSubfolders,
        maxDepth,
        enableCache: true,
        select: ['id', 'displayName', 'totalItemCount', 'unreadItemCount', 'parentFolderId']
      });

      console.log(`✅ Encontradas ${folders.length} pastas (com cache/otimização)`);
      return folders;
    } catch (error) {
      console.error('❌ Erro ao listar pastas otimizado:', error);
      
      // Fallback to original implementation
      console.log('🔄 Fallback para implementação original de pastas...');
      
      try {
        const userEmail = process.env.TARGET_USER_EMAIL || 'me';
        const apiEndpoint = userEmail === 'me' 
          ? '/me/mailFolders'
          : `/users/${userEmail}/mailFolders`;

        const response = await this.client
          .api(apiEndpoint)
          .select('id,displayName,totalItemCount,unreadItemCount,parentFolderId')
          .get();

        let allFolders = response.value || [];

        if (includeSubfolders && maxDepth > 1) {
          // Recursively get subfolders
          for (const folder of [...allFolders]) {
            const subfolders = await this.getSubfolders(folder.id, maxDepth - 1);
            allFolders = allFolders.concat(subfolders);
          }
        }

        console.log(`✅ Fallback concluído: ${allFolders.length} pastas`);
        return allFolders;
      } catch (fallbackError) {
        console.error('❌ Erro no fallback de pastas:', fallbackError);
        throw fallbackError;
      }
    }
  }

  /**
   * Get subfolders recursively
   */
  private async getSubfolders(parentFolderId: string, maxDepth: number): Promise<any[]> {
    if (maxDepth <= 0) return [];

    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${parentFolderId}/childFolders`
        : `/users/${userEmail}/mailFolders/${parentFolderId}/childFolders`;

      const response = await this.client
        .api(apiEndpoint)
        .select('id,displayName,totalItemCount,unreadItemCount,parentFolderId')
        .get();

      let subfolders = response.value || [];

      if (maxDepth > 1) {
        for (const subfolder of [...subfolders]) {
          const deeperSubfolders = await this.getSubfolders(subfolder.id, maxDepth - 1);
          subfolders = subfolders.concat(deeperSubfolders);
        }
      }

      return subfolders;
    } catch (error) {
      console.error(`❌ Erro ao obter subpastas de ${parentFolderId}:`, error);
      return [];
    }
  }

  /**
   * Create a new email folder
   */
  async createFolder(folderName: string, parentFolderId?: string): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiEndpoint = parentFolderId 
        ? (userEmail === 'me' 
          ? `/me/mailFolders/${parentFolderId}/childFolders`
          : `/users/${userEmail}/mailFolders/${parentFolderId}/childFolders`)
        : (userEmail === 'me' 
          ? '/me/mailFolders'
          : `/users/${userEmail}/mailFolders`);

      console.log(`📁 Criando pasta: ${folderName}${parentFolderId ? ` (pai: ${parentFolderId})` : ''}`);

      const folder = await this.client
        .api(apiEndpoint)
        .post({
          displayName: folderName
        });

      console.log(`✅ Pasta criada: ${folder.displayName} (ID: ${folder.id})`);
      return folder;
    } catch (error) {
      console.error('❌ Erro ao criar pasta:', error);
      throw error;
    }
  }

  /**
   * Move emails to a specific folder
   */
  async moveEmailsToFolder(emailIds: string[], targetFolderId: string): Promise<any[]> {
    const results = [];

    for (const emailId of emailIds) {
      try {
        const userEmail = process.env.TARGET_USER_EMAIL || 'me';
        const apiEndpoint = userEmail === 'me' 
          ? `/me/messages/${emailId}/move`
          : `/users/${userEmail}/messages/${emailId}/move`;

        console.log(`📦 Movendo email ${emailId.substring(0, 8)}... para pasta ${targetFolderId}`);

        const result = await this.client
          .api(apiEndpoint)
          .post({
            destinationId: targetFolderId
          });

        results.push({
          emailId,
          success: true,
          newLocation: result.parentFolderId
        });

        console.log(`✅ Email movido com sucesso`);
      } catch (error) {
        console.error(`❌ Erro ao mover email ${emailId}:`, error);
        results.push({
          emailId,
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }

    return results;
  }

  /**
   * Copy emails to a specific folder
   */
  async copyEmailsToFolder(emailIds: string[], targetFolderId: string): Promise<any[]> {
    const results = [];

    for (const emailId of emailIds) {
      try {
        const userEmail = process.env.TARGET_USER_EMAIL || 'me';
        const apiEndpoint = userEmail === 'me' 
          ? `/me/messages/${emailId}/copy`
          : `/users/${userEmail}/messages/${emailId}/copy`;

        console.log(`📋 Copiando email ${emailId.substring(0, 8)}... para pasta ${targetFolderId}`);

        const result = await this.client
          .api(apiEndpoint)
          .post({
            destinationId: targetFolderId
          });

        results.push({
          emailId,
          success: true,
          copiedId: result.id
        });

        console.log(`✅ Email copiado com sucesso`);
      } catch (error) {
        console.error(`❌ Erro ao copiar email ${emailId}:`, error);
        results.push({
          emailId,
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }

    return results;
  }

  /**
   * Delete a folder
   */
  async deleteFolder(folderId: string, permanent: boolean = false): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      
      // First get folder info
      const folderEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folderId}`
        : `/users/${userEmail}/mailFolders/${folderId}`;

      const folder = await this.client.api(folderEndpoint).get();

      console.log(`🗑️ Deletando pasta: ${folder.displayName} (${permanent ? 'permanente' : 'para lixeira'})`);

      // Delete the folder
      await this.client.api(folderEndpoint).delete();

      console.log(`✅ Pasta deletada com sucesso`);

      return {
        success: true,
        folderName: folder.displayName,
        emailsAffected: folder.totalItemCount,
        subfoldersAffected: folder.childFolderCount || 0
      };
    } catch (error) {
      console.error('❌ Erro ao deletar pasta:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      };
    }
  }

  /**
   * Get folder statistics
   */
  async getFolderStatistics(folderId: string, includeSubfolders: boolean = false): Promise<any> {
    try {
      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const folderEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folderId}`
        : `/users/${userEmail}/mailFolders/${folderId}`;

      console.log(`📊 Obtendo estatísticas da pasta ${folderId}${includeSubfolders ? ' (incluindo subpastas)' : ''}`);

      const folder = await this.client.api(folderEndpoint).get();

      // Get emails for date range analysis
      const messagesEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folderId}/messages`
        : `/users/${userEmail}/mailFolders/${folderId}/messages`;

      const messages = await this.client
        .api(messagesEndpoint)
        .select('receivedDateTime,hasAttachments')
        .top(1000)
        .get();

      const emails = messages.value || [];
      
      // Calculate statistics
      const unreadEmails = folder.unreadItemCount || 0;
      const totalEmails = folder.totalItemCount || 0;
      const readEmails = totalEmails - unreadEmails;
      const emailsWithAttachments = emails.filter((e: any) => e.hasAttachments).length;

      // Date range analysis
      let dateRange = null;
      if (emails.length > 0) {
        const dates = emails
          .map((e: any) => new Date(e.receivedDateTime))
          .sort((a: Date, b: Date) => a.getTime() - b.getTime());
        
        dateRange = {
          oldest: dates[0].toLocaleString('pt-BR'),
          newest: dates[dates.length - 1].toLocaleString('pt-BR')
        };
      }

      const stats: any = {
        folderName: folder.displayName,
        totalEmails,
        unreadEmails,
        readEmails,
        emailsWithAttachments,
        dateRange
      };

      // Include subfolders if requested
      if (includeSubfolders) {
        const subfolders = await this.getSubfolders(folderId, 1);
        stats.subfolders = subfolders.map((sf: any) => ({
          name: sf.displayName,
          emailCount: sf.totalItemCount || 0
        }));
      }

      console.log(`✅ Estatísticas obtidas para pasta ${folder.displayName}`);
      return stats;
    } catch (error) {
      console.error('❌ Erro ao obter estatísticas da pasta:', error);
      throw error;
    }
  }

  /**
   * Organize emails by predefined rules
   */
  async organizeEmailsByRules(
    sourceFolderId: string, 
    rules: any[], 
    options: { dryRun?: boolean; maxEmails?: number } = {}
  ): Promise<any> {
    const { dryRun = true, maxEmails = 100 } = options;

    try {
      console.log(`🗂️ Organizando emails por regras (${dryRun ? 'simulação' : 'execução'})`);

      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const messagesEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${sourceFolderId}/messages`
        : `/users/${userEmail}/mailFolders/${sourceFolderId}/messages`;

      // Get emails to organize
      const response = await this.client
        .api(messagesEndpoint)
        .select('id,subject,from,body,receivedDateTime')
        .top(maxEmails)
        .get();

      const emails = response.value || [];
      const ruleResults = [];
      let emailsOrganized = 0;

      // Apply each rule
      for (const rule of rules) {
        const matchingEmails = this.findEmailsMatchingRule(emails, rule);
        
        if (matchingEmails.length > 0) {
          ruleResults.push({
            ruleName: rule.name,
            emailsMatched: matchingEmails.length,
            targetFolder: rule.targetFolderId
          });

          if (!dryRun) {
            // Actually move the emails
            const emailIds = matchingEmails.map(e => e.id);
            await this.moveEmailsToFolder(emailIds, rule.targetFolderId);
          }

          emailsOrganized += matchingEmails.length;
        }
      }

      console.log(`✅ Organização concluída: ${emailsOrganized}/${emails.length} emails processados`);

      return {
        emailsProcessed: emails.length,
        emailsOrganized,
        rulesApplied: ruleResults.length,
        ruleResults
      };
    } catch (error) {
      console.error('❌ Erro ao organizar emails:', error);
      throw error;
    }
  }

  /**
   * Find emails matching a specific rule
   */
  private findEmailsMatchingRule(emails: any[], rule: any): any[] {
    return emails.filter(email => {
      // Subject-based rules
      if (rule.subjectContains) {
        const subject = email.subject?.toLowerCase() || '';
        return rule.subjectContains.some((keyword: string) => 
          subject.includes(keyword.toLowerCase())
        );
      }

      // Sender-based rules
      if (rule.fromContains) {
        const from = email.from?.emailAddress?.address?.toLowerCase() || '';
        return rule.fromContains.some((domain: string) => 
          from.includes(domain.toLowerCase())
        );
      }

      // Date-based rules
      if (rule.olderThanDays) {
        const emailDate = new Date(email.receivedDateTime);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - rule.olderThanDays);
        return emailDate < cutoffDate;
      }

      return false;
    });
  }

  // ===============================
  // ADVANCED SEARCH METHODS
  // ===============================

  /**
   * Advanced email search with multiple criteria
   */
  async advancedSearchEmails(options: {
    query?: string;
    sender?: string;
    subject?: string;
    dateFrom?: string;
    dateTo?: string;
    hasAttachments?: boolean;
    isRead?: boolean;
    folder?: string;
    maxResults?: number;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<Message[]> {
    try {
      const {
        query,
        sender,
        subject,
        dateFrom,
        dateTo,
        hasAttachments,
        isRead,
        folder = 'inbox',
        maxResults = 20,
        sortBy = 'receivedDateTime',
        sortOrder = 'desc'
      } = options;

      console.log(`🔍 Executando busca avançada otimizada na pasta ${folder}`);

      // Use GraphOptimizer for intelligent search query optimization
      const optimizedFilter = this.graphOptimizer.optimizeSearchQuery(query || '', {
        searchIn: query ? ['subject', 'from', 'body'] : undefined,
        dateRange: (dateFrom && dateTo) ? { start: dateFrom, end: dateTo } : undefined,
        hasAttachments,
        isRead
      });

      // Generate cache key for this search
      const cacheKey = this.cacheManager.generateEmailKey('advanced_search', {
        ...options,
        optimizedFilter
      });

      // Try cache first
      const cached = this.cacheManager.get<Message[]>(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit: busca avançada (${cached.length} resultados)`);
        return cached;
      }

      // Build search request for GraphOptimizer
      const searchOptions = {
        folder,
        maxResults,
        filter: optimizedFilter,
        search: query,
        enableCache: false, // We handle caching here
        select: this.graphOptimizer.getOptimalFields('search'),
        orderBy: query ? undefined : `${sortBy} ${sortOrder}`
      };

      const emails = await this.graphOptimizer.getOptimizedEmails(searchOptions);

      // Apply additional filtering for complex criteria not handled by Graph API
      let filteredEmails = emails;

      if (sender) {
        filteredEmails = filteredEmails.filter(email => 
          email.from?.emailAddress?.address?.includes(sender)
        );
      }

      if (subject) {
        filteredEmails = filteredEmails.filter(email => 
          email.subject?.toLowerCase().includes(subject.toLowerCase())
        );
      }

      // Cache results based on complexity
      const complexity = this.calculateSearchComplexity(options);
      this.cacheManager.cacheSearchResults(cacheKey, filteredEmails, complexity);

      console.log(`✅ Busca avançada otimizada concluída: ${filteredEmails.length} emails encontrados`);
      return filteredEmails;
    } catch (error) {
      console.error('❌ Erro na busca avançada otimizada:', error);
      
      // Fallback to original implementation
      console.log('🔄 Fallback para busca avançada original...');
      
      try {
        const {
          query,
          sender,
          subject,
          dateFrom,
          dateTo,
          hasAttachments,
          isRead,
          folder = 'inbox',
          maxResults = 20,
          sortBy = 'receivedDateTime',
          sortOrder = 'desc'
        } = options;

        const userEmail = process.env.TARGET_USER_EMAIL || 'me';
        const apiEndpoint = userEmail === 'me' 
          ? `/me/mailFolders/${folder}/messages`
          : `/users/${userEmail}/mailFolders/${folder}/messages`;

        const queryParams: string[] = [
          `$top=${Math.min(maxResults, 100)}`,
          `$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,body`
        ];

        const filterConditions: string[] = [];

        if (sender) {
          filterConditions.push(`from/emailAddress/address eq '${sender}'`);
        }

        if (subject) {
          filterConditions.push(`contains(subject,'${subject}')`);
        }

        if (dateFrom) {
          filterConditions.push(`receivedDateTime ge ${dateFrom}`);
        }

        if (dateTo) {
          filterConditions.push(`receivedDateTime le ${dateTo}`);
        }

        if (hasAttachments !== undefined) {
          filterConditions.push(`hasAttachments eq ${hasAttachments}`);
        }

        if (isRead !== undefined) {
          filterConditions.push(`isRead eq ${isRead}`);
        }

        if (filterConditions.length > 0) {
          queryParams.push(`$filter=${filterConditions.join(' and ')}`);
        }

        if (query) {
          const cleanQuery = query.replace(/['"]/g, '');
          queryParams.push(`$search="${encodeURIComponent(cleanQuery)}"`);
        } else {
          queryParams.push(`$orderby=${sortBy} ${sortOrder}`);
        }

        const queryString = queryParams.join('&');
        const fullEndpoint = `${apiEndpoint}?${queryString}`;

        const response = await this.client.api(fullEndpoint).get();
        
        console.log(`✅ Fallback de busca concluído: ${response.value?.length || 0} emails encontrados`);
        return response.value || [];
      } catch (fallbackError) {
        console.error('❌ Erro no fallback da busca avançada:', fallbackError);
        throw fallbackError;
      }
    }
  }

  /**
   * Calculate search complexity for cache TTL optimization
   */
  private calculateSearchComplexity(options: any): 'simple' | 'moderate' | 'complex' {
    let complexity = 0;
    
    if (options.query) complexity += 2;
    if (options.sender) complexity += 1;
    if (options.subject) complexity += 1;
    if (options.dateFrom || options.dateTo) complexity += 1;
    if (options.hasAttachments !== undefined) complexity += 1;
    if (options.isRead !== undefined) complexity += 1;
    if (options.maxResults > 50) complexity += 1;

    if (complexity <= 2) return 'simple';
    if (complexity <= 4) return 'moderate';
    return 'complex';
  }

  /**
   * Search emails by sender domain
   */
  async searchEmailsBySenderDomain(
    domain: string, 
    options: {
      maxResults?: number;
      includeSubdomains?: boolean;
      folder?: string;
      dateRange?: { from: string; to: string };
    } = {}
  ): Promise<Message[]> {
    try {
      const { maxResults = 20, includeSubdomains = true, folder = 'inbox', dateRange } = options;

      const userEmail = process.env.TARGET_USER_EMAIL || 'me';
      const apiEndpoint = userEmail === 'me' 
        ? `/me/mailFolders/${folder}/messages`
        : `/users/${userEmail}/mailFolders/${folder}/messages`;

      console.log(`🏢 Buscando emails do domínio: ${domain}`);

      const queryParams: string[] = [
        `$top=${Math.min(maxResults, 100)}`,
        `$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview`,
        `$orderby=receivedDateTime desc`
      ];

      // Build domain filter
      const domainFilter = includeSubdomains 
        ? `contains(from/emailAddress/address,'${domain}')`
        : `endswith(from/emailAddress/address,'@${domain}')`;

      const filterConditions = [domainFilter];

      if (dateRange) {
        filterConditions.push(`receivedDateTime ge ${dateRange.from}`);
        filterConditions.push(`receivedDateTime le ${dateRange.to}`);
      }

      queryParams.push(`$filter=${filterConditions.join(' and ')}`);

      const queryString = queryParams.join('&');
      const fullEndpoint = `${apiEndpoint}?${queryString}`;

      const response = await this.client.api(fullEndpoint).get();
      
      console.log(`✅ Encontrados ${response.value?.length || 0} emails do domínio ${domain}`);
      return response.value || [];
    } catch (error) {
      console.error(`❌ Erro na busca por domínio ${domain}:`, error);
      throw error;
    }
  }

  /**
   * Search emails by attachment type
   */
  async searchEmailsByAttachmentType(
    fileTypes: string[], 
    options: {
      maxResults?: number;
      folder?: string;
      sizeLimit?: number;
      dateRange?: { from: string; to: string };
    } = {}
  ): Promise<Message[]> {
    try {
      const { maxResults = 20, folder = 'inbox', sizeLimit, dateRange } = options;

      console.log(`📎 Buscando emails com anexos dos tipos: ${fileTypes.join(', ')}`);

      // First get emails with attachments
      const emailsWithAttachments = await this.listEmails({
        maxResults: maxResults * 2, // Get more to filter by attachment type
        folder,
        filter: 'hasAttachments eq true'
      });

      const matchingEmails: Message[] = [];

      for (const email of emailsWithAttachments) {
        if (matchingEmails.length >= maxResults) break;

        try {
          const attachments = await this.listAttachments(email.id!);
          
          const hasMatchingType = attachments.some(att => 
            fileTypes.some(type => 
              att.contentType?.toLowerCase().includes(type.toLowerCase()) ||
              att.name?.toLowerCase().endsWith(`.${type.toLowerCase()}`)
            )
          );

          if (hasMatchingType) {
            // Check size limit if specified
            if (sizeLimit) {
              const totalSize = attachments.reduce((sum, att) => sum + (att.size || 0), 0);
              const sizeMB = totalSize / (1024 * 1024);
              if (sizeMB > sizeLimit) continue;
            }

            // Check date range if specified
            if (dateRange && email.receivedDateTime) {
              const emailDate = new Date(email.receivedDateTime);
              const fromDate = new Date(dateRange.from);
              const toDate = new Date(dateRange.to);
              if (emailDate < fromDate || emailDate > toDate) continue;
            }

            matchingEmails.push(email);
          }
        } catch (attachmentError) {
          console.warn(`⚠️ Erro ao verificar anexos do email ${email.id}:`, attachmentError);
          continue;
        }
      }

      console.log(`✅ Encontrados ${matchingEmails.length} emails com anexos dos tipos especificados`);
      return matchingEmails;
    } catch (error) {
      console.error('❌ Erro na busca por tipo de anexo:', error);
      throw error;
    }
  }

  /**
   * Find duplicate emails
   */
  async findDuplicateEmails(options: {
    criteria: 'subject' | 'sender' | 'subject+sender';
    folder?: string;
    maxResults?: number;
    includeRead?: boolean;
    dateRange?: { from: string; to: string };
  }): Promise<any[]> {
    try {
      const { criteria, folder = 'inbox', maxResults = 50, includeRead = true, dateRange } = options;

      console.log(`🔄 Procurando emails duplicados por: ${criteria}`);

      // Get emails for analysis
      const emails = await this.listEmails({
        maxResults: maxResults * 2,
        folder
      });

      // Group emails by criteria
      const groups = new Map<string, Message[]>();

      emails.forEach(email => {
        if (!includeRead && email.isRead) return;

        if (dateRange && email.receivedDateTime) {
          const emailDate = new Date(email.receivedDateTime);
          const fromDate = new Date(dateRange.from);
          const toDate = new Date(dateRange.to);
          if (emailDate < fromDate || emailDate > toDate) return;
        }

        let key = '';
        switch (criteria) {
          case 'subject':
            key = email.subject?.trim().toLowerCase() || '';
            break;
          case 'sender':
            key = email.from?.emailAddress?.address?.toLowerCase() || '';
            break;
          case 'subject+sender':
            const subject = email.subject?.trim().toLowerCase() || '';
            const sender = email.from?.emailAddress?.address?.toLowerCase() || '';
            key = `${subject}|${sender}`;
            break;
        }

        if (key) {
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key)!.push(email);
        }
      });

      // Filter groups with duplicates
      const duplicates = Array.from(groups.entries())
        .filter(([_, emails]) => emails.length > 1)
        .map(([key, emails]) => ({
          key: key.length > 100 ? key.substring(0, 100) + '...' : key,
          emails: emails.sort((a, b) => 
            new Date(b.receivedDateTime || 0).getTime() - new Date(a.receivedDateTime || 0).getTime()
          )
        }))
        .sort((a, b) => b.emails.length - a.emails.length);

      console.log(`✅ Encontrados ${duplicates.length} grupos de emails duplicados`);
      return duplicates;
    } catch (error) {
      console.error('❌ Erro na busca por duplicados:', error);
      throw error;
    }
  }

  /**
   * Search emails by size range
   */
  async searchEmailsBySize(options: {
    minSizeMB?: number;
    maxSizeMB?: number;
    folder?: string;
    maxResults?: number;
    includeAttachments?: boolean;
  }): Promise<Message[]> {
    try {
      const { minSizeMB, maxSizeMB, folder = 'inbox', maxResults = 20, includeAttachments = true } = options;

      console.log(`📏 Buscando emails por tamanho: ${minSizeMB || 0}MB - ${maxSizeMB || '∞'}MB`);

      // Note: Microsoft Graph API doesn't support filtering by size directly
      // We need to get emails and filter them locally
      const emails = await this.listEmails({
        maxResults: maxResults * 3, // Get more to filter by size
        folder
      });

      const filteredEmails: Message[] = [];

      for (const email of emails) {
        if (filteredEmails.length >= maxResults) break;

        // Estimate email size (Graph API doesn't always provide size)
        let emailSize = 0;

        // Base email size estimation
        const subjectSize = (email.subject?.length || 0) * 2;
        const bodySize = (email.body?.content?.length || email.bodyPreview?.length || 0) * 2;
        emailSize = subjectSize + bodySize;

        // Add attachment sizes if requested
        if (includeAttachments && email.hasAttachments) {
          try {
            const attachments = await this.listAttachments(email.id!);
            const attachmentSize = attachments.reduce((sum, att) => sum + (att.size || 0), 0);
            emailSize += attachmentSize;
          } catch (attachmentError) {
            console.warn(`⚠️ Erro ao obter tamanho dos anexos do email ${email.id}:`, attachmentError);
          }
        }

        const emailSizeMB = emailSize / (1024 * 1024);

        // Apply size filters
        if (minSizeMB && emailSizeMB < minSizeMB) continue;
        if (maxSizeMB && emailSizeMB > maxSizeMB) continue;

        // Add size to email object for display
        (email as any).size = emailSize;
        filteredEmails.push(email);
      }

      console.log(`✅ Encontrados ${filteredEmails.length} emails no intervalo de tamanho especificado`);
      return filteredEmails;
    } catch (error) {
      console.error('❌ Erro na busca por tamanho:', error);
      throw error;
    }
  }

  /**
   * Save search criteria for later use
   */
  async saveSearchCriteria(name: string, criteria: any): Promise<boolean> {
    try {
      // In a real implementation, this would save to a database or file
      // For now, we'll use a simple in-memory storage
      if (!this.savedSearches) {
        this.savedSearches = new Map();
      }

      this.savedSearches.set(name, {
        name,
        criteria,
        created: new Date().toISOString()
      });

      console.log(`💾 Busca salva: ${name}`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao salvar busca:', error);
      throw error;
    }
  }

  private savedSearches?: Map<string, any>;

  /**
   * List saved searches
   */
  async listSavedSearches(): Promise<any[]> {
    try {
      if (!this.savedSearches) {
        return [];
      }

      return Array.from(this.savedSearches.values());
    } catch (error) {
      console.error('❌ Erro ao listar buscas salvas:', error);
      throw error;
    }
  }

  /**
   * Execute a saved search
   */
  async executeSavedSearch(name: string): Promise<{ emails: Message[]; criteria: any } | null> {
    try {
      if (!this.savedSearches || !this.savedSearches.has(name)) {
        return null;
      }

      const savedSearch = this.savedSearches.get(name);
      const emails = await this.advancedSearchEmails(savedSearch.criteria);

      console.log(`🔍 Executada busca salva "${name}": ${emails.length} emails encontrados`);
      
      return {
        emails,
        criteria: savedSearch.criteria
      };
    } catch (error) {
      console.error(`❌ Erro ao executar busca salva "${name}":`, error);
      throw error;
    }
  }

  /**
   * Delete a saved search
   */
  async deleteSavedSearch(name: string): Promise<boolean> {
    try {
      if (!this.savedSearches || !this.savedSearches.has(name)) {
        return false;
      }

      this.savedSearches.delete(name);
      console.log(`🗑️ Busca salva deletada: ${name}`);
      return true;
    } catch (error) {
      console.error(`❌ Erro ao deletar busca salva "${name}":`, error);
      throw error;
    }
  }

  // ===============================
  // BATCH OPERATIONS
  // ===============================

  /**
   * Batch mark emails as read
   */
  async batchMarkAsRead(emailIds: string[], options: { maxConcurrent?: number } = {}): Promise<Array<{ success: boolean; error?: string }>> {
    const { maxConcurrent = 5 } = options;

    console.log(`📖 Iniciando marcação em lote otimizada como lidos: ${emailIds.length} emails`);

    try {
      // Use ParallelProcessor for optimized batch processing
      const results = await this.parallelProcessor.processEmailsBatch(
        emailIds.map(id => ({ id })),
        async (emailData) => {
          await this.markAsRead(emailData.id);
          return { success: true };
        },
        {
          priority: 'normal',
          batchSize: maxConcurrent,
          timeout: 10000
        }
      );

      // Convert ParallelProcessor results to expected format
      const formattedResults = results.map(result => ({
        success: result.success,
        error: result.error?.message
      }));

      const successCount = formattedResults.filter(r => r.success).length;
      console.log(`✅ Marcação em lote otimizada concluída: ${successCount}/${emailIds.length} sucessos`);

      // Invalidate email cache after bulk operations
      this.cacheManager.invalidateEmailCache();

      return formattedResults;
    } catch (error) {
      console.error('❌ Erro no processamento paralelo, usando fallback:', error);
      
      // Fallback to original implementation
      const results: Array<{ success: boolean; error?: string }> = [];

      for (let i = 0; i < emailIds.length; i += maxConcurrent) {
        const batch = emailIds.slice(i, i + maxConcurrent);
        
        const batchPromises = batch.map(async (emailId) => {
          try {
            await this.markAsRead(emailId);
            return { success: true };
          } catch (error) {
            console.warn(`⚠️ Falha ao marcar email ${emailId} como lido:`, error);
            return { success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        if (i + maxConcurrent < emailIds.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`✅ Fallback de marcação concluído: ${successCount}/${emailIds.length} sucessos`);

      return results;
    }
  }

  /**
   * Batch mark emails as unread
   */
  async batchMarkAsUnread(emailIds: string[], options: { maxConcurrent?: number } = {}): Promise<Array<{ success: boolean; error?: string }>> {
    const { maxConcurrent = 5 } = options;

    console.log(`📬 Iniciando marcação em lote otimizada como não lidos: ${emailIds.length} emails`);

    try {
      // Use ParallelProcessor for optimized batch processing
      const results = await this.parallelProcessor.processEmailsBatch(
        emailIds.map(id => ({ id })),
        async (emailData) => {
          await this.markAsUnread(emailData.id);
          return { success: true };
        },
        {
          priority: 'normal',
          batchSize: maxConcurrent,
          timeout: 10000
        }
      );

      // Convert ParallelProcessor results to expected format
      const formattedResults = results.map(result => ({
        success: result.success,
        error: result.error?.message
      }));

      const successCount = formattedResults.filter(r => r.success).length;
      console.log(`✅ Marcação em lote otimizada concluída: ${successCount}/${emailIds.length} sucessos`);

      // Invalidate email cache after bulk operations
      this.cacheManager.invalidateEmailCache();

      return formattedResults;
    } catch (error) {
      console.error('❌ Erro no processamento paralelo, usando fallback:', error);
      
      // Fallback to original implementation
      const results: Array<{ success: boolean; error?: string }> = [];

      for (let i = 0; i < emailIds.length; i += maxConcurrent) {
        const batch = emailIds.slice(i, i + maxConcurrent);
        
        const batchPromises = batch.map(async (emailId) => {
          try {
            await this.markAsUnread(emailId);
            return { success: true };
          } catch (error) {
            console.warn(`⚠️ Falha ao marcar email ${emailId} como não lido:`, error);
            return { success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        if (i + maxConcurrent < emailIds.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`✅ Fallback de marcação concluído: ${successCount}/${emailIds.length} sucessos`);

      return results;
    }
  }

  /**
   * Batch delete emails
   */
  async batchDeleteEmails(emailIds: string[], options: { permanent?: boolean; maxConcurrent?: number } = {}): Promise<Array<{ success: boolean; error?: string }>> {
    const { permanent = false, maxConcurrent = 3 } = options; // Lower concurrency for delete operations
    const results: Array<{ success: boolean; error?: string }> = [];

    console.log(`🗑️ Iniciando deleção em lote: ${emailIds.length} emails (${permanent ? 'permanente' : 'para lixeira'})`);

    // Process in batches with lower concurrency for delete operations
    for (let i = 0; i < emailIds.length; i += maxConcurrent) {
      const batch = emailIds.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async (emailId) => {
        try {
          await this.deleteEmail(emailId);
          return { success: true };
        } catch (error) {
          console.warn(`⚠️ Falha ao deletar email ${emailId}:`, error);
          return { success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Longer delay between batches for delete operations
      if (i + maxConcurrent < emailIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Deleção em lote concluída: ${successCount}/${emailIds.length} sucessos`);

    return results;
  }

  /**
   * Batch move emails to folder
   */
  async batchMoveEmails(emailIds: string[], targetFolderId: string, options: { maxConcurrent?: number } = {}): Promise<Array<{ success: boolean; error?: string }>> {
    const { maxConcurrent = 5 } = options;
    const results: Array<{ success: boolean; error?: string }> = [];

    console.log(`📦 Iniciando movimentação em lote: ${emailIds.length} emails para pasta ${targetFolderId}`);

    // Process in batches
    for (let i = 0; i < emailIds.length; i += maxConcurrent) {
      const batch = emailIds.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async (emailId) => {
        try {
          await this.moveEmailsToFolder([emailId], targetFolderId);
          return { success: true };
        } catch (error) {
          console.warn(`⚠️ Falha ao mover email ${emailId}:`, error);
          return { success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches
      if (i + maxConcurrent < emailIds.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Movimentação em lote concluída: ${successCount}/${emailIds.length} sucessos`);

    return results;
  }

  /**
   * Batch download all attachments from multiple emails
   */
  async batchDownloadAllAttachments(emailIds: string[], options: {
    targetDirectory?: string;
    maxConcurrent?: number;
    overwrite?: boolean;
    validateIntegrity?: boolean;
    sizeLimit?: number;
  } = {}): Promise<Array<{
    success: boolean;
    filesDownloaded: number;
    totalSizeMB: number;
    fileNames?: string[];
    error?: string;
  }>> {
    const { maxConcurrent = 3, sizeLimit = 25 } = options;
    const results: Array<{
      success: boolean;
      filesDownloaded: number;
      totalSizeMB: number;
      fileNames?: string[];
      error?: string;
    }> = [];

    console.log(`📎 Iniciando download em lote de anexos: ${emailIds.length} emails`);

    // Process in batches with low concurrency for downloads
    for (let i = 0; i < emailIds.length; i += maxConcurrent) {
      const batch = emailIds.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async (emailId) => {
        try {
          const downloadResult = await this.downloadAllAttachmentsFromEmail(emailId, options);
          
          // Calculate total size from successful downloads
          const successfulResults = downloadResult.results.filter(r => r.success);
          const totalSizeMB = successfulResults.length * 0.5; // Estimate 500KB per file
          const fileNames = successfulResults.map(r => r.filename);
          
          return {
            success: true,
            filesDownloaded: downloadResult.successfulDownloads,
            totalSizeMB,
            fileNames
          };
        } catch (error) {
          console.warn(`⚠️ Falha no download dos anexos do email ${emailId}:`, error);
          return {
            success: false,
            filesDownloaded: 0,
            totalSizeMB: 0,
            error: error instanceof Error ? error.message : 'Erro desconhecido'
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Longer delay between batches for download operations
      if (i + maxConcurrent < emailIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const successCount = results.filter(r => r.success).length;
    const totalFiles = results.reduce((sum, r) => sum + r.filesDownloaded, 0);
    console.log(`✅ Download em lote concluído: ${successCount}/${emailIds.length} emails, ${totalFiles} arquivos`);

    return results;
  }

  // ===============================
  // PERFORMANCE OPTIMIZATION METHODS
  // ===============================

  /**
   * Optimized email listing with caching and intelligent field selection
   */
  async listEmailsOptimized(options: EmailListOptions = {}): Promise<Message[]> {
    const {
      maxResults = 10,
      filter,
      search,
      folder = 'inbox'
    } = options;

    try {
      // Generate cache key for this request
      const cacheKey = this.cacheManager.generateEmailKey('list', {
        folder, maxResults, filter, search
      });

      // Try cache first for better performance
      const cached = this.cacheManager.get<Message[]>(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit: emails from ${folder} (${cached.length} emails)`);
        return cached;
      }

      // Use GraphOptimizer for enhanced performance
      const optimizedOptions = {
        folder,
        maxResults,
        search,
        filter,
        enableCache: false, // We handle caching manually
        select: this.graphOptimizer.getOptimalFields('list'),
        orderBy: search ? undefined : 'receivedDateTime desc'
      };

      console.log(`📧 Listing emails: ${maxResults} results, folder: ${folder} (optimized)`);

      const emails = await this.graphOptimizer.getOptimizedEmails(optimizedOptions);
      
      // Cache the results
      this.cacheManager.cacheEmails(cacheKey, emails, folder);
      
      console.log(`✅ Found ${emails.length} emails (with optimization)`);
      return emails;
    } catch (error) {
      console.error('❌ Error in optimized email listing:', error);
      throw error;
    }
  }

  /**
   * Optimized folder listing with caching
   */
  async listFoldersOptimized(includeSubfolders: boolean = true, maxDepth: number = 3): Promise<any[]> {
    try {
      const cacheKey = `folders:optimized:${includeSubfolders}:${maxDepth}`;
      
      // Try cache first
      const cached = this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit: folder structure (${cached.length} folders)`);
        return cached;
      }

      console.log(`📁 Fetching folder structure (optimized, depth: ${maxDepth})`);

      const folders = await this.graphOptimizer.getOptimizedFolders({
        includeSubfolders,
        maxDepth,
        enableCache: false,
        select: ['id', 'displayName', 'totalItemCount', 'unreadItemCount', 'parentFolderId']
      });

      // Cache with longer TTL for folders
      this.cacheManager.cacheFolders(cacheKey, folders);

      console.log(`✅ Found ${folders.length} folders (optimized)`);
      return folders;
    } catch (error) {
      console.error('❌ Error in optimized folder listing:', error);
      throw error;
    }
  }

  /**
   * Parallel batch email processing with intelligent concurrency
   */
  async processBatchEmailsParallel(
    emails: any[],
    operation: (email: any) => Promise<any>,
    options: {
      batchSize?: number;
      priority?: 'low' | 'normal' | 'high' | 'critical';
      timeout?: number;
    } = {}
  ): Promise<any[]> {
    const { batchSize = 10, priority = 'normal', timeout = 15000 } = options;

    console.log(`🔄 Processing ${emails.length} emails in parallel (batch: ${batchSize})`);

    try {
      const results = await this.parallelProcessor.processEmailsBatch(
        emails,
        operation,
        { priority, batchSize, timeout }
      );

      const successCount = results.filter(r => r.success).length;
      console.log(`✅ Parallel processing completed: ${successCount}/${emails.length} successful`);

      return results.filter(r => r.success).map(r => r.result);
    } catch (error) {
      console.error('❌ Error in parallel email processing:', error);
      throw error;
    }
  }

  /**
   * Advanced search with optimization and result caching
   */
  async advancedSearchOptimized(options: {
    query: string;
    folders?: string[];
    searchIn?: ('subject' | 'body' | 'from' | 'to')[];
    dateRange?: { start: string; end: string };
    importance?: 'low' | 'normal' | 'high';
    hasAttachments?: boolean;
    isRead?: boolean;
    maxResults?: number;
  }): Promise<Message[]> {
    const {
      query,
      folders = ['inbox'],
      searchIn = ['subject', 'from'],
      dateRange,
      importance,
      hasAttachments,
      isRead,
      maxResults = 50
    } = options;

    try {
      // Generate cache key for search
      const cacheKey = this.cacheManager.generateEmailKey('search', {
        query, folders, searchIn, dateRange, importance, hasAttachments, isRead, maxResults
      });

      // Try cache first
      const cached = this.cacheManager.get<Message[]>(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit: search results (${cached.length} emails)`);
        return cached;
      }

      console.log(`🔍 Advanced search: "${query}" in ${folders.length} folder(s)`);

      // Build optimized search filter
      const searchFilter = this.graphOptimizer.optimizeSearchQuery(query, {
        searchIn,
        dateRange,
        importance,
        hasAttachments,
        isRead
      });

      // Execute search across folders in parallel
      const searchQueries = folders.map(folder => ({
        query: searchFilter,
        folder,
        options: { maxResults: Math.ceil(maxResults / folders.length) }
      }));

      const allResults = await this.parallelProcessor.processSearchQueriesBatch(
        searchQueries,
        async (queryData: any) => {
          return await this.graphOptimizer.getOptimizedEmails({
            folder: queryData.folder,
            filter: queryData.query,
            maxResults: queryData.options.maxResults,
            select: this.graphOptimizer.getOptimalFields('search')
          });
        },
        {
          mergeResults: true,
          deduplicate: true,
          maxResultsPerQuery: maxResults
        }
      );

      // Limit final results
      const limitedResults = allResults.slice(0, maxResults);

      // Cache results with complexity-based TTL
      const complexity = folders.length > 2 || searchIn.length > 2 ? 'complex' : 'moderate';
      this.cacheManager.cacheSearchResults(cacheKey, limitedResults, complexity);

      console.log(`✅ Advanced search completed: ${limitedResults.length} results`);
      return limitedResults;
    } catch (error) {
      console.error('❌ Error in advanced optimized search:', error);
      throw error;
    }
  }

  /**
   * Intelligent cache invalidation based on operations
   */
  invalidateRelevantCache(operation: 'email' | 'folder' | 'all', context?: string): void {
    switch (operation) {
      case 'email':
        this.cacheManager.invalidateEmailCache(context);
        break;
      case 'folder':
        this.cacheManager.invalidateFolderCache();
        break;
      case 'all':
        this.cacheManager.clear();
        break;
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): {
    cache: any;
    graphOptimizer: any;
    parallelProcessor: any;
  } {
    return {
      cache: this.cacheManager.getStats(),
      graphOptimizer: this.graphOptimizer.getOptimizationStats(),
      parallelProcessor: this.parallelProcessor.getMetrics()
    };
  }

  /**
   * Email cleanup wizard
   */
  async emailCleanupWizard(options: {
    dryRun?: boolean;
    olderThanDays?: number;
    deleteRead?: boolean;
    deleteLargeAttachments?: boolean;
    attachmentSizeLimitMB?: number;
    excludeFolders?: string[];
    maxEmails?: number;
  } = {}): Promise<{
    emailsAnalyzed: number;
    emailsToClean: number;
    emailsDeleted: number;
    spaceSavedMB: number;
    categories: Record<string, number>;
    warnings: string[];
  }> {
    const {
      dryRun = true,
      olderThanDays = 30,
      deleteRead = false,
      deleteLargeAttachments = false,
      attachmentSizeLimitMB = 10,
      excludeFolders = ['sent', 'drafts'],
      maxEmails = 100
    } = options;

    console.log(`🧹 Iniciando assistente de limpeza (${dryRun ? 'simulação' : 'execução'})`);

    const result = {
      emailsAnalyzed: 0,
      emailsToClean: 0,
      emailsDeleted: 0,
      spaceSavedMB: 0,
      categories: {} as Record<string, number>,
      warnings: [] as string[]
    };

    try {
      // Get all folders
      const folders = await this.listFolders(false, 1);
      const targetFolders = folders.filter(folder => 
        !excludeFolders.some(excluded => 
          folder.displayName?.toLowerCase().includes(excluded) ||
          folder.id?.toLowerCase().includes(excluded)
        )
      );

      if (targetFolders.length === 0) {
        result.warnings.push('Nenhuma pasta encontrada para limpeza');
        return result;
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      for (const folder of targetFolders) {
        if (result.emailsAnalyzed >= maxEmails) break;

        try {
          const emails = await this.listEmails({
            maxResults: Math.min(50, maxEmails - result.emailsAnalyzed),
            folder: folder.displayName
          });

          for (const email of emails) {
            if (result.emailsAnalyzed >= maxEmails) break;
            
            result.emailsAnalyzed++;
            
            let shouldClean = false;
            let category = 'outros';

            // Check age
            if (email.receivedDateTime) {
              const emailDate = new Date(email.receivedDateTime);
              if (emailDate < cutoffDate) {
                shouldClean = true;
                category = 'antigos';
              }
            }

            // Check read status
            if (deleteRead && email.isRead) {
              shouldClean = true;
              category = 'lidos';
            }

            // Check attachment size
            if (deleteLargeAttachments && email.hasAttachments) {
              try {
                const attachments = await this.listAttachments(email.id!);
                const totalSize = attachments.reduce((sum, att) => sum + (att.size || 0), 0);
                const sizeMB = totalSize / (1024 * 1024);
                
                if (sizeMB > attachmentSizeLimitMB) {
                  shouldClean = true;
                  category = 'anexos_grandes';
                }
              } catch (attachmentError) {
                console.warn(`⚠️ Erro ao verificar anexos do email ${email.id}:`, attachmentError);
              }
            }

            if (shouldClean) {
              result.emailsToClean++;
              result.categories[category] = (result.categories[category] || 0) + 1;
              
              // Estimate space saved (rough calculation)
              const bodySize = (email.body?.content?.length || email.bodyPreview?.length || 0) * 2;
              result.spaceSavedMB += bodySize / (1024 * 1024);

              if (!dryRun) {
                try {
                  await this.deleteEmail(email.id!);
                  result.emailsDeleted++;
                } catch (deleteError) {
                  console.warn(`⚠️ Falha ao deletar email ${email.id}:`, deleteError);
                  result.warnings.push(`Falha ao deletar email: ${email.subject || 'sem assunto'}`);
                }
              }
            }
          }
        } catch (folderError) {
          console.warn(`⚠️ Erro ao processar pasta ${folder.displayName}:`, folderError);
          result.warnings.push(`Erro ao processar pasta: ${folder.displayName}`);
        }
      }

      if (!dryRun) {
        result.emailsDeleted = result.emailsToClean;
      }

      console.log(`✅ Assistente de limpeza concluído: ${result.emailsToClean} emails ${dryRun ? 'identificados' : 'deletados'}`);
      return result;
    } catch (error) {
      console.error('❌ Erro no assistente de limpeza:', error);
      throw error;
    }
  }

  /**
   * Get comprehensive optimization statistics
   */
  getOptimizationReport(): {
    performance: any;
    cacheEfficiency: any;
    recommendations: string[];
  } {
    const stats = this.getPerformanceStats();
    const recommendations: string[] = [];

    // Analyze cache efficiency
    if (stats.cache.hitRate < 50) {
      recommendations.push('Cache hit rate is low. Consider warming up cache with common operations.');
    }

    if (stats.parallelProcessor.averageProcessingTime > 5000) {
      recommendations.push('High processing times detected. Consider reducing batch sizes or optimizing operations.');
    }

    if (stats.graphOptimizer.queuedRequests > 20) {
      recommendations.push('High request queue detected. Consider enabling more aggressive batching.');
    }

    return {
      performance: stats,
      cacheEfficiency: {
        ...stats.cache,
        efficiency: stats.cache.hitRate > 70 ? 'excellent' : stats.cache.hitRate > 50 ? 'good' : 'needs_improvement'
      },
      recommendations
    };
  }

  /**
   * Warm up cache with common patterns
   */
  async warmUpCache(): Promise<void> {
    console.log('🔥 Warming up cache with common patterns...');
    await this.cacheManager.preloadCommonPatterns(this);
    console.log('✅ Cache warm-up completed');
  }

  /**
   * Reset all optimizations and clear caches
   */
  resetOptimizations(): void {
    console.log('🔄 Resetting all optimizations...');
    this.cacheManager.clear();
    this.graphOptimizer.reset();
    this.parallelProcessor.clear();
    console.log('✅ Optimizations reset completed');
  }

  /**
   * Graceful shutdown and cleanup of resources
   */
  destroy(): void {
    console.log('💥 Shutting down EmailService optimizations...');
    
    try {
      this.cacheManager.destroy();
      this.graphOptimizer.reset();
      this.parallelProcessor.destroy();
      
      console.log('✅ EmailService cleanup completed');
    } catch (error) {
      console.error('❌ Error during EmailService cleanup:', error);
    }
  }
}