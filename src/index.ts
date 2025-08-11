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
            description: 'Envia um novo email',
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
    const {
      maxResults = 10,
      filter,
      search,
      folder = 'inbox'
    } = args;

    const emails = await this.emailService.listEmails({
      maxResults,
      filter,
      search,
      folder
    });

    const emailList = emails.map(email => ({
      id: email.id,
      subject: email.subject,
      from: email.from?.emailAddress?.address,
      fromName: email.from?.emailAddress?.name,
      receivedDateTime: email.receivedDateTime,
      isRead: email.isRead,
      hasAttachments: email.hasAttachments,
      bodyPreview: email.bodyPreview?.substring(0, 200) + '...'
    }));

    return {
      content: [
        {
          type: 'text',
          text: `Encontrados ${emails.length} emails:\n\n${JSON.stringify(emailList, null, 2)}`
        }
      ]
    };
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
    const { to, subject, body, cc, bcc } = args;
    
    try {
      const result = await this.emailService.sendEmail(to, subject, body, cc, bcc);
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Email enviado com sucesso!\n\nPara: ${to.join(', ')}\nAssunto: ${subject}\n${cc ? `CC: ${cc.join(', ')}\n` : ''}${bcc ? `BCC: ${bcc.join(', ')}\n` : ''}Status: ${JSON.stringify(result, null, 2)}`
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
    
    try {
      const result = await this.emailService.replyToEmail(emailId, body, replyAll);
      
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
            text: `📁 Anexo baixado com sucesso!\n\nNome: ${attachment.name}\nTipo de Conteúdo: ${attachment.contentType}\nTipo de Anexo: ${attachment.attachmentType}\nTamanho do conteúdo: ${attachment.content.length} caracteres\n\n${attachment.attachmentType === '#microsoft.graph.fileAttachment' ? '💾 Conteúdo em Base64 - Para salvar o arquivo, decodifique o conteúdo Base64.' : attachment.attachmentType === '#microsoft.graph.itemAttachment' ? '📧 Item do Outlook (JSON)' : '🔗 Anexo de referência'}\n\nConteúdo: ${attachment.content.substring(0, 200)}${attachment.content.length > 200 ? '...' : ''}`
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP Email Server funcionando no stdio');
  }
}

const server = new EmailMCPServer();
server.run().catch(console.error);