#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { GraphAuthProvider } from './auth/graphAuth.js';
import { EmailService } from './services/emailService.js';
import { EmailSummarizer } from './services/emailSummarizer.js';

class EmailMCPServer {
  private server: Server;
  private authProvider: GraphAuthProvider;
  private emailService: EmailService;
  private emailSummarizer: EmailSummarizer;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-email-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.authProvider = new GraphAuthProvider();
    this.emailService = new EmailService(this.authProvider);
    this.emailSummarizer = new EmailSummarizer();

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list_emails',
            description: 'Lista emails da caixa de entrada com filtros opcionais',
            inputSchema: {
              type: 'object',
              properties: {
                maxResults: {
                  type: 'number',
                  description: 'Número máximo de emails para retornar (padrão: 10)',
                  default: 10
                },
                filter: {
                  type: 'string',
                  description: 'Filtro OData para emails (ex: "isRead eq false", "from/emailAddress/address eq \'email@domain.com\'")'
                },
                search: {
                  type: 'string',
                  description: 'Termo de busca para pesquisar nos emails'
                },
                folder: {
                  type: 'string',
                  description: 'Pasta específica para buscar (padrão: inbox)',
                  default: 'inbox'
                }
              },
              additionalProperties: false
            }
          },
          {
            name: 'summarize_email',
            description: 'Cria um resumo de um email específico',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para resumir'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'summarize_emails_batch',
            description: 'Cria resumos para múltiplos emails',
            inputSchema: {
              type: 'object',
              properties: {
                emailIds: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  description: 'Array de IDs de emails para resumir'
                },
                maxResults: {
                  type: 'number',
                  description: 'Número máximo de emails para resumir (padrão: 5)',
                  default: 5
                }
              },
              additionalProperties: false
            }
          },
          {
            name: 'list_users',
            description: 'Lista usuários disponíveis na organização para configurar TARGET_USER_EMAIL',
            inputSchema: {
              type: 'object',
              properties: {
                maxResults: {
                  type: 'number',
                  description: 'Número máximo de usuários para listar (padrão: 20)',
                  default: 20
                }
              },
              additionalProperties: false
            }
          },
          {
            name: 'send_email',
            description: 'Envia um novo email com suporte opcional a anexos',
            inputSchema: {
              type: 'object',
              properties: {
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários (emails)'
                },
                subject: {
                  type: 'string',
                  description: 'Assunto do email'
                },
                body: {
                  type: 'string',
                  description: 'Corpo do email (HTML ou texto)'
                },
                cc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia (opcional)'
                },
                bcc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia oculta (opcional)'
                },
                attachments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Nome do arquivo anexo'
                      },
                      contentType: {
                        type: 'string',
                        description: 'Tipo de conteúdo (MIME type, ex: application/pdf, image/png)'
                      },
                      content: {
                        type: 'string',
                        description: 'Conteúdo do arquivo codificado em Base64'
                      },
                      size: {
                        type: 'number',
                        description: 'Tamanho do arquivo em bytes (opcional)'
                      }
                    },
                    required: ['name', 'contentType', 'content'],
                    additionalProperties: false
                  },
                  description: 'Lista de anexos (opcional)'
                },
                useTemplate: {
                  type: 'boolean',
                  description: 'Usar template HTML elegante (padrão: false)'
                },
                templateTheme: {
                  type: 'string',
                  enum: ['professional', 'modern', 'minimal', 'corporate'],
                  description: 'Tema do template (padrão: professional)'
                },
                emailTitle: {
                  type: 'string',
                  description: 'Título do email (aparece no template)'
                },
                signature: {
                  type: 'string',
                  description: 'Assinatura personalizada'
                },
                companyName: {
                  type: 'string',
                  description: 'Nome da empresa (para header/footer)'
                },
                logoUrl: {
                  type: 'string',
                  description: 'URL do logo da empresa'
                }
              },
              required: ['to', 'subject', 'body'],
              additionalProperties: false
            }
          },
          {
            name: 'reply_to_email',
            description: 'Responde a um email específico',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email a ser respondido'
                },
                body: {
                  type: 'string',
                  description: 'Corpo da resposta (HTML ou texto)'
                },
                replyAll: {
                  type: 'boolean',
                  description: 'Se deve responder para todos (padrão: false)',
                  default: false
                },
                useTemplate: {
                  type: 'boolean',
                  description: 'Usar template HTML elegante com email original (padrão: false)'
                },
                templateTheme: {
                  type: 'string',
                  enum: ['professional', 'modern', 'minimal', 'corporate'],
                  description: 'Tema do template (padrão: professional)'
                },
                signature: {
                  type: 'string',
                  description: 'Assinatura personalizada'
                }
              },
              required: ['emailId', 'body'],
              additionalProperties: false
            }
          },
          {
            name: 'mark_as_read',
            description: 'Marca um email como lido',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para marcar como lido'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'mark_as_unread',
            description: 'Marca um email como não lido',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para marcar como não lido'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'delete_email',
            description: 'Move um email para a lixeira',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para deletar'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'list_attachments',
            description: 'Lista todos os anexos de um email',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para listar anexos'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'download_attachment',
            description: 'Baixa um anexo específico de um email',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email'
                },
                attachmentId: {
                  type: 'string',
                  description: 'ID do anexo para baixar'
                }
              },
              required: ['emailId', 'attachmentId'],
              additionalProperties: false
            }
          },
          {
            name: 'download_attachment_to_file',
            description: 'Download otimizado de anexos grandes - salva diretamente no disco evitando limitações de token',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email'
                },
                attachmentId: {
                  type: 'string',
                  description: 'ID do anexo para baixar'
                },
                targetDirectory: {
                  type: 'string',
                  description: 'Diretório de destino (opcional)'
                },
                filename: {
                  type: 'string',
                  description: 'Nome do arquivo personalizado (opcional)'
                },
                overwrite: {
                  type: 'boolean',
                  description: 'Sobrescrever arquivo existente (padrão: false)',
                  default: false
                },
                validateIntegrity: {
                  type: 'boolean',
                  description: 'Validar integridade do arquivo (padrão: true)',
                  default: true
                }
              },
              required: ['emailId', 'attachmentId'],
              additionalProperties: false
            }
          },
          {
            name: 'download_all_attachments',
            description: 'Download em lote de todos os anexos de um email para o disco',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email'
                },
                targetDirectory: {
                  type: 'string',
                  description: 'Diretório de destino (opcional)'
                },
                overwrite: {
                  type: 'boolean',
                  description: 'Sobrescrever arquivos existentes (padrão: false)',
                  default: false
                },
                validateIntegrity: {
                  type: 'boolean',
                  description: 'Validar integridade dos arquivos (padrão: true)',
                  default: true
                },
                maxConcurrent: {
                  type: 'number',
                  description: 'Máximo de downloads simultâneos (padrão: 3)',
                  default: 3
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'list_downloaded_files',
            description: 'Lista todos os arquivos baixados pelo sistema MCP',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          },
          {
            name: 'get_download_directory_info',
            description: 'Obtém informações sobre o diretório de downloads',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          },
          {
            name: 'cleanup_old_downloads',
            description: 'Remove arquivos baixados antigos',
            inputSchema: {
              type: 'object',
              properties: {
                maxAgeHours: {
                  type: 'number',
                  description: 'Idade máxima em horas para manter arquivos (padrão: 24)',
                  default: 24
                }
              },
              additionalProperties: false
            }
          },
          {
            name: 'export_email_as_attachment',
            description: 'Exporta um email como anexo EML para usar em outros emails',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'ID do email para exportar como anexo'
                }
              },
              required: ['emailId'],
              additionalProperties: false
            }
          },
          {
            name: 'encode_file_for_attachment',
            description: 'Codifica um arquivo do sistema de arquivos para base64 para uso como anexo de email - resolve problema de anexos com 0KB',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Caminho absoluto para o arquivo a ser codificado'
                }
              },
              required: ['filePath'],
              additionalProperties: false
            }
          },
          {
            name: 'send_email_from_attachment',
            description: 'Função híbrida: baixa anexo de um email e reenvia automaticamente para outros destinatários - resolve limitações do MCP para arquivos grandes',
            inputSchema: {
              type: 'object',
              properties: {
                sourceEmailId: {
                  type: 'string',
                  description: 'ID do email que contém o anexo'
                },
                attachmentId: {
                  type: 'string',
                  description: 'ID do anexo a ser reenviado'
                },
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários (emails)'
                },
                subject: {
                  type: 'string',
                  description: 'Assunto do email'
                },
                body: {
                  type: 'string',
                  description: 'Corpo do email (HTML ou texto)'
                },
                cc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia (opcional)'
                },
                bcc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia oculta (opcional)'
                },
                useTemplate: {
                  type: 'boolean',
                  description: 'Usar template HTML elegante (padrão: false)'
                },
                templateTheme: {
                  type: 'string',
                  enum: ['professional', 'modern', 'minimal', 'corporate'],
                  description: 'Tema do template (padrão: professional)'
                },
                keepOriginalFile: {
                  type: 'boolean',
                  description: 'Manter arquivo no disco após envio (padrão: false)'
                },
                customFilename: {
                  type: 'string',
                  description: 'Nome personalizado para o arquivo anexo (opcional)'
                }
              },
              required: ['sourceEmailId', 'attachmentId', 'to', 'subject', 'body'],
              additionalProperties: false
            }
          },
          {
            name: 'send_email_with_file',
            description: 'Envia email com arquivo já baixado do disco - ideal para automação com arquivos grandes',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Caminho absoluto para o arquivo no disco'
                },
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários (emails)'
                },
                subject: {
                  type: 'string',
                  description: 'Assunto do email'
                },
                body: {
                  type: 'string',
                  description: 'Corpo do email (HTML ou texto)'
                },
                cc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia (opcional)'
                },
                bcc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lista de destinatários em cópia oculta (opcional)'
                },
                useTemplate: {
                  type: 'boolean',
                  description: 'Usar template HTML elegante (padrão: false)'
                },
                templateTheme: {
                  type: 'string',
                  enum: ['professional', 'modern', 'minimal', 'corporate'],
                  description: 'Tema do template (padrão: professional)'
                },
                customFilename: {
                  type: 'string',
                  description: 'Nome personalizado para o arquivo anexo (opcional)'
                }
              },
              required: ['filePath', 'to', 'subject', 'body'],
              additionalProperties: false
            }
          }
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_emails':
            return await this.handleListEmails(args);
          
          case 'summarize_email':
            return await this.handleSummarizeEmail(args);
          
          case 'summarize_emails_batch':
            return await this.handleSummarizeEmailsBatch(args);
          
          case 'list_users':
            return await this.handleListUsers(args);

          case 'send_email':
            return await this.handleSendEmail(args);

          case 'reply_to_email':
            return await this.handleReplyToEmail(args);

          case 'mark_as_read':
            return await this.handleMarkAsRead(args);

          case 'mark_as_unread':
            return await this.handleMarkAsUnread(args);

          case 'delete_email':
            return await this.handleDeleteEmail(args);

          case 'list_attachments':
            return await this.handleListAttachments(args);

          case 'download_attachment':
            return await this.handleDownloadAttachment(args);

          case 'download_attachment_to_file':
            return await this.handleDownloadAttachmentToFile(args);

          case 'download_all_attachments':
            return await this.handleDownloadAllAttachments(args);

          case 'list_downloaded_files':
            return await this.handleListDownloadedFiles(args);

          case 'get_download_directory_info':
            return await this.handleGetDownloadDirectoryInfo(args);

          case 'cleanup_old_downloads':
            return await this.handleCleanupOldDownloads(args);

          case 'export_email_as_attachment':
            return await this.handleExportEmailAsAttachment(args);

          case 'encode_file_for_attachment':
            return await this.handleEncodeFileForAttachment(args);

          case 'send_email_from_attachment':
            return await this.handleSendEmailFromAttachment(args);

          case 'send_email_with_file':
            return await this.handleSendEmailWithFile(args);

          default:
            throw new Error(`Ferramenta desconhecida: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Erro: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
            }
          ],
          isError: true
        };
      }
    });
  }

  private async handleListEmails(args: any) {
    const startTime = Date.now();
    const toolName = 'list_emails';
    const userEmail = process.env.TARGET_USER_EMAIL;
    
    // Usar argumentos diretamente com defaults
    const validatedArgs = {
      maxResults: args.maxResults || 10,
      filter: args.filter,
      search: args.search,
      folder: args.folder || 'inbox'
    };

    try {
      const emails = await this.emailService.listEmails(validatedArgs);

      const emailList = emails.map(email => ({
        id: email.id,
        subject: email.subject,
        from: email.from?.emailAddress?.address,
        fromName: email.from?.emailAddress?.name,
        receivedDateTime: email.receivedDateTime,
        isRead: email.isRead,
        hasAttachments: email.hasAttachments,
        bodyPreview: email.bodyPreview ? 
          email.bodyPreview.substring(0, 200) + (email.bodyPreview.length > 200 ? '...' : '') : 
          ''
      }));

      return {
        content: [
          {
            type: 'text',
            text: `📧 Encontrados ${emails.length} emails:\n\n${JSON.stringify(emailList, null, 2)}`
          }
        ]
      };
    } catch (error) {
      throw error;
    }
  }

  private async handleSummarizeEmail(args: any) {
    const { emailId } = args;
    
    const email = await this.emailService.getEmailById(emailId);
    const summary = await this.emailSummarizer.summarizeEmail(email);

    return {
      content: [
        {
          type: 'text',
          text: `Resumo do Email:\n\n${JSON.stringify(summary, null, 2)}`
        }
      ]
    };
  }

  private async handleSummarizeEmailsBatch(args: any) {
    const { emailIds, maxResults = 5 } = args;
    
    let ids = emailIds;
    if (!ids) {
      const emails = await this.emailService.listEmails({ maxResults });
      ids = emails.map(e => e.id);
    }

    const summaries = await this.emailSummarizer.summarizeEmailsBatch(
      ids.slice(0, maxResults),
      this.emailService
    );

    return {
      content: [
        {
          type: 'text',
          text: `Resumos dos Emails:\n\n${JSON.stringify(summaries, null, 2)}`
        }
      ]
    };
  }

  private async handleListUsers(args: any) {
    const { maxResults = 20 } = args;
    
    try {
      const client = this.authProvider.getGraphClient();
      const response = await client
        .api('/users')
        .select('id,displayName,mail,userPrincipalName')
        .top(maxResults)
        .get();

      const users = response.value.map((user: any) => ({
        displayName: user.displayName,
        email: user.mail || user.userPrincipalName,
        id: user.id
      }));

      return {
        content: [
          {
            type: 'text',
            text: `Usuários disponíveis na organização:\n\n${JSON.stringify(users, null, 2)}\n\nPara configurar um usuário específico, adicione o email no arquivo .env:\nTARGET_USER_EMAIL=usuario@dominio.com`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Erro ao listar usuários: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleSendEmail(args: any) {
    const startTime = Date.now();
    const toolName = 'send_email';
    const userEmail = process.env.TARGET_USER_EMAIL;
    
    // Usar argumentos diretamente
    const validatedArgs = {
      to: args.to || [],
      subject: args.subject || '',
      body: args.body || '',
      cc: args.cc,
      bcc: args.bcc,
      attachments: args.attachments
    };
    
    // Preparar opções de template se solicitado
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
      
      // Informações detalhadas sobre anexos se houver
      const attachmentDetails = result.attachmentInfo && result.attachmentInfo.count > 0
        ? `\n\n📊 Detalhes dos Anexos:\n• Total: ${result.attachmentInfo.count}\n• Tamanho: ${result.attachmentInfo.totalSize}${result.warnings && result.warnings.length > 0 ? `\n⚠️ Avisos: ${result.warnings.join('; ')}` : ''}`
        : '';
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Email enviado com sucesso!\n\nPara: ${validatedArgs.to.join(', ')}\nAssunto: ${validatedArgs.subject}\n${validatedArgs.cc ? `CC: ${validatedArgs.cc.join(', ')}\n` : ''}${validatedArgs.bcc ? `BCC: ${validatedArgs.bcc.join(', ')}\n` : ''}${attachmentInfo}${attachmentDetails}\n\nMessage ID: ${result.messageId}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao enviar email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleReplyToEmail(args: any) {
    const { emailId, body, replyAll = false } = args;
    
    // Preparar opções de template se solicitado
    const enhancedOptions = args.useTemplate ? {
      useTemplate: true,
      templateOptions: {
        theme: args.templateTheme || 'professional',
        showHeader: false, // Para replies geralmente não queremos header
        showFooter: true
      },
      emailContent: {
        signature: args.signature
      }
    } : undefined;
    
    try {
      const result = await this.emailService.replyToEmail(emailId, body, replyAll, enhancedOptions);
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Resposta enviada com sucesso!\n\nTipo: ${replyAll ? 'Responder para todos' : 'Responder'}\nEmail ID: ${emailId}\nStatus: ${JSON.stringify(result, null, 2)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao responder email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleMarkAsRead(args: any) {
    const { emailId } = args;
    
    try {
      const success = await this.emailService.markAsRead(emailId);
      
      return {
        content: [
          {
            type: 'text',
            text: success ? `✅ Email ${emailId} marcado como lido` : `❌ Falha ao marcar email como lido`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao marcar como lido: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleMarkAsUnread(args: any) {
    const { emailId } = args;
    
    try {
      const success = await this.emailService.markAsUnread(emailId);
      
      return {
        content: [
          {
            type: 'text',
            text: success ? `✅ Email ${emailId} marcado como não lido` : `❌ Falha ao marcar email como não lido`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao marcar como não lido: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleDeleteEmail(args: any) {
    const { emailId } = args;
    
    try {
      const success = await this.emailService.deleteEmail(emailId);
      
      return {
        content: [
          {
            type: 'text',
            text: success ? `✅ Email ${emailId} movido para lixeira` : `❌ Falha ao deletar email`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao deletar email: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleListAttachments(args: any) {
    const { emailId } = args;
    
    try {
      const attachments = await this.emailService.listAttachments(emailId);
      
      return {
        content: [
          {
            type: 'text',
            text: `📎 Anexos encontrados no email ${emailId}:\n\n${JSON.stringify(attachments, null, 2)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao listar anexos: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleDownloadAttachment(args: any) {
    const { emailId, attachmentId } = args;
    
    try {
      const attachment = await this.emailService.downloadAttachment(emailId, attachmentId);
      
      return {
        content: [
          {
            type: 'text',
            text: `📁 Anexo baixado com sucesso!\n\nNome: ${attachment.name}\nTipo de Conteúdo: ${attachment.contentType}\nTipo de Anexo: ${attachment.attachmentType}\nTamanho do conteúdo: ${attachment.content.length} caracteres\n\n${attachment.attachmentType === '#microsoft.graph.fileAttachment' ? '💾 Conteúdo em Base64 - Para salvar o arquivo, decodifique o conteúdo Base64.' : attachment.attachmentType === '#microsoft.graph.itemAttachment' ? '📧 Item do Outlook (JSON)' : '🔗 Anexo de referência'}\n\nConteúdo: ${attachment.content}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao baixar anexo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler para download otimizado de anexo para arquivo
   */
  private async handleDownloadAttachmentToFile(args: any) {
    const { 
      emailId, 
      attachmentId, 
      targetDirectory, 
      filename, 
      overwrite = false, 
      validateIntegrity = true 
    } = args;
    
    try {
      const result = await this.emailService.downloadAttachmentToFile(
        emailId, 
        attachmentId, 
        {
          targetDirectory,
          filename,
          overwrite,
          validateIntegrity
        }
      );
      
      if (result.success) {
        const sizeInKB = (result.savedSize / 1024).toFixed(2);
        const originalSizeInKB = (result.originalSize / 1024).toFixed(2);
        
        return {
          content: [
            {
              type: 'text',
              text: `🎉 Download otimizado concluído com sucesso!\n\n` +
                   `📄 Arquivo: ${result.filename}\n` +
                   `📍 Local: ${result.filePath}\n` +
                   `📏 Tamanho: ${sizeInKB}KB (original: ${originalSizeInKB}KB)\n` +
                   `🔍 Integridade: ${result.integrity ? '✅ Validada' : '⚠️  Requer verificação'}\n` +
                   `⏱️  Tempo: ${result.downloadTime}ms\n` +
                   `📦 Tipo: ${result.contentType}\n\n` +
                   `💡 Arquivo salvo diretamente no disco, evitando limitações de token do MCP.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Falha no download otimizado: ${result.error || 'Erro desconhecido'}\n\n` +
                   `⏱️  Tempo decorrido: ${result.downloadTime}ms`
            }
          ],
          isError: true
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro no download otimizado: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler para download em lote de todos os anexos
   */
  private async handleDownloadAllAttachments(args: any) {
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
      
      let resultText = `📦 Download em lote ${result.success ? 'concluído' : 'finalizado com falhas'}!\n\n` +
                      `📊 Estatísticas:\n` +
                      `   • Total: ${result.totalFiles} arquivos\n` +
                      `   • Sucessos: ${result.successfulDownloads}\n` +
                      `   • Falhas: ${result.failedDownloads}\n` +
                      `   • Taxa de sucesso: ${successRate}%\n` +
                      `   • Tempo total: ${result.downloadTime}ms\n\n`;
      
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
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro no download em lote: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler para listar arquivos baixados
   */
  private async handleListDownloadedFiles(args: any) {
    try {
      const files = this.emailService.getDownloadedFiles();
      
      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `📭 Nenhum arquivo encontrado no diretório de downloads.\n\n` +
                   `💡 Use 'download_attachment_to_file' ou 'download_all_attachments' para baixar arquivos.`
            }
          ]
        };
      }
      
      let resultText = `📁 Arquivos baixados (${files.length}):\n\n`;
      
      let totalSize = 0;
      files.forEach((file, index) => {
        const sizeInKB = (file.size / 1024).toFixed(2);
        const modifiedDate = file.modified.toLocaleString('pt-BR');
        totalSize += file.size;
        
        resultText += `${index + 1}. 📄 ${file.name}\n` +
                     `   📏 Tamanho: ${sizeInKB}KB\n` +
                     `   📅 Modificado: ${modifiedDate}\n` +
                     `   📍 Local: ${file.path}\n\n`;
      });
      
      const totalSizeInKB = (totalSize / 1024).toFixed(2);
      resultText += `📊 Total: ${totalSizeInKB}KB em ${files.length} arquivos`;
      
      return {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao listar arquivos: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler para informações do diretório de downloads
   */
  private async handleGetDownloadDirectoryInfo(args: any) {
    try {
      const info = this.emailService.getDownloadDirectoryInfo();
      
      const totalSizeInKB = (info.totalSize / 1024).toFixed(2);
      const totalSizeInMB = (info.totalSize / (1024 * 1024)).toFixed(2);
      
      const resultText = `📁 Informações do diretório de downloads:\n\n` +
                        `📍 Local: ${info.path}\n` +
                        `✅ Existe: ${info.exists ? 'Sim' : 'Não'}\n` +
                        `📄 Arquivos: ${info.fileCount}\n` +
                        `📏 Tamanho total: ${totalSizeInKB}KB (${totalSizeInMB}MB)\n\n` +
                        `💡 Use 'list_downloaded_files' para ver detalhes dos arquivos.\n` +
                        `💡 Use 'cleanup_old_downloads' para remover arquivos antigos.`;
      
      return {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro ao obter informações do diretório: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handler para limpeza de arquivos antigos
   */
  private async handleCleanupOldDownloads(args: any) {
    const { maxAgeHours = 24 } = args;
    
    try {
      const cleanedCount = this.emailService.cleanupOldDownloads(maxAgeHours);
      
      const resultText = cleanedCount > 0 ?
        `🗑️  Limpeza concluída!\n\n` +
        `📊 ${cleanedCount} arquivo(s) removido(s)\n` +
        `⏰ Critério: arquivos mais antigos que ${maxAgeHours} horas\n\n` +
        `💡 Use 'list_downloaded_files' para ver os arquivos restantes.` :
        
        `✨ Nenhum arquivo antigo encontrado para remoção.\n\n` +
        `⏰ Critério: arquivos mais antigos que ${maxAgeHours} horas\n` +
        `💡 Todos os arquivos são recentes ou o diretório está vazio.`;
      
      return {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro na limpeza de arquivos: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      // Validar conexão Microsoft Graph no startup
      await this.authProvider.validateConnection();
      
      console.error('MCP Email Server funcionando no stdio');
    } catch (error) {
      console.error('Erro ao iniciar servidor:', error);
      throw error;
    }
  }

  private async handleExportEmailAsAttachment(args: any) {
    try {
      const { emailId } = args;
      
      if (!emailId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Erro: emailId é obrigatório'
            }
          ],
          isError: true
        };
      }

      console.log(`📧 Exportando email ${emailId.substring(0, 30)}... como anexo`);

      const attachment = await this.emailService.exportEmailAsAttachment(emailId);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Email exportado como anexo EML!\n\n` +
                  `📄 Nome: ${attachment.name}\n` +
                  `📏 Tamanho: ${((attachment.size || 0) / 1024).toFixed(1)}KB\n` +
                  `🔗 Tipo MIME: ${attachment.contentType}\n\n` +
                  `💡 Use este anexo em 'send_email' ou 'reply_to_email' adicionando no array de attachments.\n\n` +
                  `Exemplo:\n` +
                  `{\n` +
                  `  "name": "${attachment.name}",\n` +
                  `  "contentType": "${attachment.contentType}",\n` +
                  `  "content": "[Base64 content]"\n` +
                  `}`
          }
        ]
      };

    } catch (error) {
      console.error('❌ Erro ao exportar email:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Erro ao exportar email como anexo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleEncodeFileForAttachment(args: any) {
    try {
      const { filePath } = args;
      
      if (!filePath) {
        return {
          content: [
            {
              type: 'text',
              text: 'Erro: filePath é obrigatório'
            }
          ],
          isError: true
        };
      }

      console.log(`📎 Codificando arquivo para anexo: ${filePath}`);

      // Acessar o FileManager através do EmailService
      const result = await this.emailService.encodeFileForAttachment(filePath);

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro ao codificar arquivo: ${result.error}`
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Arquivo codificado com sucesso!\n\n` +
                  `📄 Nome: ${result.name}\n` +
                  `📏 Tamanho: ${(result.size / 1024).toFixed(1)}KB\n` +
                  `🔗 Tipo MIME: ${result.contentType}\n` +
                  `📦 Base64 length: ${result.content.length} caracteres\n\n` +
                  `💡 Use este anexo em 'send_email' ou 'reply_to_email':\n\n` +
                  `{\n` +
                  `  "name": "${result.name}",\n` +
                  `  "contentType": "${result.contentType}",\n` +
                  `  "content": "${result.content.substring(0, 100)}..."\n` +
                  `}\n\n` +
                  `🎯 Este método resolve o problema de anexos chegando com 0KB!`
          }
        ]
      };

    } catch (error) {
      console.error('❌ Erro ao codificar arquivo:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Erro ao codificar arquivo para anexo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleSendEmailFromAttachment(args: any) {
    try {
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

      if (!sourceEmailId || !attachmentId || !to || !subject || !body) {
        return {
          content: [
            {
              type: 'text',
              text: 'Erro: sourceEmailId, attachmentId, to, subject e body são obrigatórios'
            }
          ],
          isError: true
        };
      }

      console.log(`🚀 Iniciando envio híbrido de anexo...`);
      console.log(`   Email origem: ${sourceEmailId.substring(0, 30)}...`);
      console.log(`   Anexo: ${attachmentId.substring(0, 30)}...`);

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
        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro no envio híbrido: ${result.error}`
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `🎉 Email enviado com sucesso via método híbrido!\n\n` +
                  `📧 **Detalhes do Envio:**\n` +
                  `- Para: ${to.join(', ')}\n` +
                  `- Assunto: ${subject}\n` +
                  `- Anexo: ${result.attachmentInfo.name} (${(result.attachmentInfo.size / 1024).toFixed(1)}KB)\n` +
                  `- Tempo total: ${result.totalTime}ms\n\n` +
                  `📁 **Processamento:**\n` +
                  `- ✅ Download: ${result.downloadResult.filename}\n` +
                  `- ✅ Codificação: ${result.attachmentInfo.contentType}\n` +
                  `- ✅ Envio: Concluído\n` +
                  `- 🗑️ Limpeza: ${keepOriginalFile ? 'Arquivo mantido' : 'Arquivo removido'}\n\n` +
                  `💡 **Vantagem:** Este método funciona com arquivos de qualquer tamanho, contornando limitações do MCP!`
          }
        ]
      };

    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro no envio híbrido: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleSendEmailWithFile(args: any) {
    try {
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

      if (!filePath || !to || !subject || !body) {
        return {
          content: [
            {
              type: 'text',
              text: 'Erro: filePath, to, subject e body são obrigatórios'
            }
          ],
          isError: true
        };
      }

      console.log(`📎 Enviando email com arquivo do disco: ${filePath}`);

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
        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro no envio com arquivo: ${result.error}`
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Email enviado com arquivo do disco!\n\n` +
                  `📧 **Detalhes:**\n` +
                  `- Para: ${to.join(', ')}\n` +
                  `- Assunto: ${subject}\n` +
                  `- Anexo: ${result.attachmentInfo.name} (${(result.attachmentInfo.size / 1024).toFixed(1)}KB)\n` +
                  `- Tipo: ${result.attachmentInfo.contentType}\n\n` +
                  `💡 **Ideal para:** Arquivos grandes já baixados ou processados localmente`
          }
        ]
      };

    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Erro no envio com arquivo: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
          }
        ],
        isError: true
      };
    }
  }
}

// Só executa se for o arquivo principal
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new EmailMCPServer();
  server.run().catch((error) => {
    console.error('Erro fatal ao iniciar servidor:', error);
    process.exit(1);
  });
}