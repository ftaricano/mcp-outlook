import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';
import { SecurityManager } from '../security/securityManager.js';
import { MCPBestPractices } from '../utils/mcpBestPractices.js';
import { EmailHandler } from './EmailHandler.js';
import { AttachmentHandler } from './AttachmentHandler.js';
import { HybridHandler } from './HybridHandler.js';
import { FolderHandler } from './FolderHandler.js';
import { SearchHandler } from './SearchHandler.js';
import { BatchHandler } from './BatchHandler.js';
import { HandlerResult } from './BaseHandler.js';
import { validateToolInput } from '../schemas/toolSchemas.js';
import { getToolSchemas as buildToolSchemas } from '../schemas/jsonSchemaFromZod.js';

export class HandlerRegistry {
  private emailHandler: EmailHandler;
  private attachmentHandler: AttachmentHandler;
  private hybridHandler: HybridHandler;
  private folderHandler: FolderHandler;
  private searchHandler: SearchHandler;
  private batchHandler: BatchHandler;

  constructor(
    emailService: EmailService, 
    emailSummarizer: EmailSummarizer,
    securityManager: SecurityManager,
    mcpBestPractices: MCPBestPractices
  ) {
    this.emailHandler = new EmailHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
    this.attachmentHandler = new AttachmentHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
    this.hybridHandler = new HybridHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
    this.folderHandler = new FolderHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
    this.searchHandler = new SearchHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
    this.batchHandler = new BatchHandler(emailService, emailSummarizer, securityManager, mcpBestPractices);
  }

  /**
   * Route tool request to appropriate handler
   */
  async handleTool(name: string, args: any): Promise<HandlerResult> {
    const validation = validateToolInput(name, args);
    if (!validation.ok) {
      throw new Error(`Invalid arguments for ${name}: ${validation.error}`);
    }
    args = validation.data;

    switch (name) {
      // Email operations
      case 'list_emails':
        return await this.emailHandler.handleListEmails(args);
      
      case 'send_email':
        return await this.emailHandler.handleSendEmail(args);
      
      case 'reply_to_email':
        return await this.emailHandler.handleReplyToEmail(args);
      
      case 'mark_as_read':
        return await this.emailHandler.handleMarkAsRead(args);
      
      case 'mark_as_unread':
        return await this.emailHandler.handleMarkAsUnread(args);
      
      case 'delete_email':
        return await this.emailHandler.handleDeleteEmail(args);
      
      case 'summarize_email':
        return await this.emailHandler.handleSummarizeEmail(args);
      
      case 'summarize_emails_batch':
        return await this.emailHandler.handleSummarizeEmailsBatch(args);
      
      case 'list_users':
        return await this.emailHandler.handleListUsers(args);
      
      // Attachment operations
      case 'list_attachments':
        return await this.attachmentHandler.handleListAttachments(args);
      
      case 'download_attachment':
        return await this.attachmentHandler.handleDownloadAttachment(args);
      
      case 'download_attachment_to_file':
        return await this.attachmentHandler.handleDownloadAttachmentToFile(args);
      
      case 'download_all_attachments':
        return await this.attachmentHandler.handleDownloadAllAttachments(args);
      
      case 'list_downloaded_files':
        return await this.attachmentHandler.handleListDownloadedFiles(args);
      
      case 'get_download_directory_info':
        return await this.attachmentHandler.handleGetDownloadDirectoryInfo(args);
      
      case 'cleanup_old_downloads':
        return await this.attachmentHandler.handleCleanupOldDownloads(args);
      
      case 'export_email_as_attachment':
        return await this.attachmentHandler.handleExportEmailAsAttachment(args);
      
      case 'encode_file_for_attachment':
        return await this.attachmentHandler.handleEncodeFileForAttachment(args);
      
      // Hybrid operations
      case 'send_email_from_attachment':
        return await this.hybridHandler.handleSendEmailFromAttachment(args);
      
      case 'send_email_with_file':
        return await this.hybridHandler.handleSendEmailWithFile(args);
      
      // Folder operations
      case 'list_folders':
        return await this.folderHandler.handleListFolders(args);
      
      case 'create_folder':
        return await this.folderHandler.handleCreateFolder(args);
      
      case 'move_emails_to_folder':
        return await this.folderHandler.handleMoveEmailsToFolder(args);
      
      case 'copy_emails_to_folder':
        return await this.folderHandler.handleCopyEmailsToFolder(args);
      
      case 'delete_folder':
        return await this.folderHandler.handleDeleteFolder(args);
      
      case 'get_folder_stats':
        return await this.folderHandler.handleGetFolderStats(args);
      
      case 'organize_emails_by_rules':
        return await this.folderHandler.handleOrganizeEmailsByRules(args);
      
      // Search operations
      case 'advanced_search':
        return await this.searchHandler.handleAdvancedSearch(args);
      
      case 'search_by_sender_domain':
        return await this.searchHandler.handleSearchBySenderDomain(args);
      
      case 'search_by_attachment_type':
        return await this.searchHandler.handleSearchByAttachmentType(args);
      
      case 'find_duplicate_emails':
        return await this.searchHandler.handleFindDuplicateEmails(args);
      
      case 'search_by_size':
        return await this.searchHandler.handleSearchBySize(args);
      
      case 'saved_searches':
        return await this.searchHandler.handleSavedSearches(args);
      
      // Batch operations
      case 'batch_mark_as_read':
        return await this.batchHandler.handleBatchMarkAsRead(args);
      
      case 'batch_mark_as_unread':
        return await this.batchHandler.handleBatchMarkAsUnread(args);
      
      case 'batch_delete_emails':
        return await this.batchHandler.handleBatchDeleteEmails(args);
      
      case 'batch_move_emails':
        return await this.batchHandler.handleBatchMoveEmails(args);
      
      case 'batch_download_attachments':
        return await this.batchHandler.handleBatchDownloadAttachments(args);
      
      case 'email_cleanup_wizard':
        return await this.batchHandler.handleEmailCleanupWizard(args);
      
      default:
        throw new Error(`Ferramenta desconhecida: ${name}`);
    }
  }

  /**
   * Get all available tools with their schemas
   * This method should be called from the main index.ts to register tools
   */
  static getToolSchemas(): any[] {
    return buildToolSchemas();
  }
}

// --- legacy inline schemas removed; see src/schemas/*.ts ---
declare const __LEGACY_UNUSED__: any;
const __legacyRemoved = (): any[] => {
  return [
    // placeholder to allow the old block below to be excised in one edit
    {
        name: 'list_emails',
        description: 'Lista emails da caixa de entrada ou de uma pasta específica',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Número de emails para retornar (padrão: 10, máx: 50)'
            },
            skip: {
              type: 'number',
              description: 'Número de emails para pular (para paginação)'
            },
            folder: {
              type: 'string',
              description: 'Pasta para listar (inbox, sentitems, drafts, deleteditems)'
            },
            search: {
              type: 'string',
              description: 'Termo de busca para filtrar emails'
            }
          }
        }
      },
      {
        name: 'send_email',
        description: 'Envia um novo email com suporte a anexos e templates HTML',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lista de destinatários'
            },
            subject: {
              type: 'string',
              description: 'Assunto do email'
            },
            body: {
              type: 'string',
              description: 'Corpo do email (texto ou HTML)'
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
                  name: { type: 'string', description: 'Nome do arquivo' },
                  contentType: { type: 'string', description: 'Tipo MIME do arquivo' },
                  content: { type: 'string', description: 'Conteúdo do arquivo em Base64' },
                  size: { type: 'number', description: 'Tamanho do arquivo em bytes (opcional)' }
                },
                required: ['name', 'contentType', 'content']
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
            }
          },
          required: ['to', 'subject', 'body']
        }
      },
      {
        name: 'reply_to_email',
        description: 'Responde a um email existente',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email para responder'
            },
            body: {
              type: 'string',
              description: 'Corpo da resposta'
            },
            replyAll: {
              type: 'boolean',
              description: 'Responder a todos (padrão: false)'
            }
          },
          required: ['emailId', 'body']
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
              description: 'ID do email'
            }
          },
          required: ['emailId']
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
              description: 'ID do email'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'delete_email',
        description: 'Deleta um email permanentemente',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email para deletar'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'summarize_email',
        description: 'Resume um email específico com análise inteligente',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email para resumir'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'summarize_emails_batch',
        description: 'Resume múltiplos emails em lote com categorização por prioridade',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Número de emails para resumir (padrão: 5, máx: 20)'
            },
            skip: {
              type: 'number',
              description: 'Número de emails para pular'
            },
            folder: {
              type: 'string',
              description: 'Pasta para buscar emails (padrão: inbox)'
            },
            priorityOnly: {
              type: 'boolean',
              description: 'Resumir apenas emails de alta prioridade (padrão: false)'
            }
          }
        }
      },
      {
        name: 'list_users',
        description: 'Lista usuários do diretório (requer permissões de administrador)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Número de usuários para retornar (padrão: 10)'
            },
            search: {
              type: 'string',
              description: 'Termo de busca para filtrar usuários'
            }
          }
        }
      },
      
      // Attachment Management Tools
      {
        name: 'list_attachments',
        description: 'Lista todos os anexos de um email',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'download_attachment',
        description: 'Baixa um anexo específico como Base64',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email'
            },
            attachmentId: {
              type: 'string',
              description: 'ID do anexo'
            },
            includeMetadata: {
              type: 'boolean',
              description: 'Incluir metadados do anexo (padrão: true)'
            }
          },
          required: ['emailId', 'attachmentId']
        }
      },
      {
        name: 'download_attachment_to_file',
        description: 'Baixa um anexo diretamente para arquivo no disco (otimizado para arquivos grandes)',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email'
            },
            attachmentId: {
              type: 'string',
              description: 'ID do anexo'
            },
            targetDirectory: {
              type: 'string',
              description: 'Diretório de destino (opcional, padrão: downloads/)'
            },
            customFilename: {
              type: 'string',
              description: 'Nome personalizado para o arquivo (opcional)'
            },
            overwrite: {
              type: 'boolean',
              description: 'Sobrescrever arquivo existente (padrão: false)'
            },
            validateIntegrity: {
              type: 'boolean',
              description: 'Validar integridade do arquivo (MD5/SHA256) (padrão: true)'
            }
          },
          required: ['emailId', 'attachmentId']
        }
      },
      {
        name: 'download_all_attachments',
        description: 'Baixa todos os anexos de um email em lote',
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
              description: 'Sobrescrever arquivos existentes (padrão: false)'
            },
            validateIntegrity: {
              type: 'boolean',
              description: 'Validar integridade dos arquivos (padrão: true)'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Número máximo de downloads simultâneos (padrão: 3)'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'list_downloaded_files',
        description: 'Lista arquivos baixados no diretório de downloads',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_download_directory_info',
        description: 'Obtém informações sobre o diretório de downloads',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'cleanup_old_downloads',
        description: 'Limpa arquivos antigos do diretório de downloads',
        inputSchema: {
          type: 'object',
          properties: {
            daysOld: {
              type: 'number',
              description: 'Deletar arquivos mais antigos que X dias (padrão: 7)'
            },
            dryRun: {
              type: 'boolean',
              description: 'Apenas simular, não deletar (padrão: true)'
            }
          }
        }
      },
      {
        name: 'export_email_as_attachment',
        description: 'Exporta um email como arquivo anexável (EML ou MSG)',
        inputSchema: {
          type: 'object',
          properties: {
            emailId: {
              type: 'string',
              description: 'ID do email para exportar'
            },
            format: {
              type: 'string',
              enum: ['eml', 'msg'],
              description: 'Formato de exportação (padrão: eml)'
            }
          },
          required: ['emailId']
        }
      },
      {
        name: 'encode_file_for_attachment',
        description: 'Codifica um arquivo do disco para Base64 para usar como anexo',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Caminho do arquivo no disco'
            },
            customFilename: {
              type: 'string',
              description: 'Nome personalizado para o anexo (opcional)'
            }
          },
          required: ['filePath']
        }
      },
      
      // Hybrid Functions
      {
        name: 'send_email_from_attachment',
        description: 'Função híbrida: baixa anexo de um email e envia em novo email (solução para limitações do MCP)',
        inputSchema: {
          type: 'object',
          properties: {
            sourceEmailId: {
              type: 'string',
              description: 'ID do email de origem contendo o anexo'
            },
            attachmentId: {
              type: 'string',
              description: 'ID do anexo a ser transferido'
            },
            to: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lista de destinatários do novo email'
            },
            subject: {
              type: 'string',
              description: 'Assunto do novo email'
            },
            body: {
              type: 'string',
              description: 'Corpo do novo email'
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
              description: 'Manter arquivo temporário após envio (padrão: false)'
            },
            customFilename: {
              type: 'string',
              description: 'Nome personalizado para o arquivo anexo (opcional)'
            }
          },
          required: ['sourceEmailId', 'attachmentId', 'to', 'subject', 'body']
        }
      },
      {
        name: 'send_email_with_file',
        description: 'Envia email com arquivo do disco como anexo (sem transferência Base64 via MCP)',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Caminho do arquivo no disco para anexar'
            },
            to: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lista de destinatários'
            },
            subject: {
              type: 'string',
              description: 'Assunto do email'
            },
            body: {
              type: 'string',
              description: 'Corpo do email'
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
          required: ['filePath', 'to', 'subject', 'body']
        }
      },

      // ===============================
      // FOLDER MANAGEMENT TOOLS
      // ===============================
      
      {
        name: 'list_folders',
        description: 'Lista todas as pastas de email do usuário com opção de incluir subpastas',
        inputSchema: {
          type: 'object',
          properties: {
            includeSubfolders: {
              type: 'boolean',
              description: 'Incluir subpastas na listagem (padrão: true)'
            },
            maxDepth: {
              type: 'number',
              description: 'Profundidade máxima para busca de subpastas (padrão: 3)'
            }
          }
        }
      },

      {
        name: 'create_folder',
        description: 'Cria uma nova pasta de email',
        inputSchema: {
          type: 'object',
          properties: {
            folderName: {
              type: 'string',
              description: 'Nome da pasta a ser criada'
            },
            parentFolderId: {
              type: 'string',
              description: 'ID da pasta pai (opcional, se não especificado, cria na raiz)'
            }
          },
          required: ['folderName']
        }
      },

      {
        name: 'move_emails_to_folder',
        description: 'Move um ou mais emails para uma pasta específica',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) do(s) email(s) a ser(em) movido(s)'
            },
            targetFolderId: {
              type: 'string',
              description: 'ID da pasta de destino'
            }
          },
          required: ['emailIds', 'targetFolderId']
        }
      },

      {
        name: 'copy_emails_to_folder',
        description: 'Copia um ou mais emails para uma pasta específica',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) do(s) email(s) a ser(em) copiado(s)'
            },
            targetFolderId: {
              type: 'string',
              description: 'ID da pasta de destino'
            }
          },
          required: ['emailIds', 'targetFolderId']
        }
      },

      {
        name: 'delete_folder',
        description: 'Deleta uma pasta de email (cuidado: operação irreversível)',
        inputSchema: {
          type: 'object',
          properties: {
            folderId: {
              type: 'string',
              description: 'ID da pasta a ser deletada'
            },
            permanent: {
              type: 'boolean',
              description: 'Deletar permanentemente (padrão: false, move para lixeira)'
            }
          },
          required: ['folderId']
        }
      },

      {
        name: 'get_folder_stats',
        description: 'Obtém estatísticas detalhadas de uma pasta de email',
        inputSchema: {
          type: 'object',
          properties: {
            folderId: {
              type: 'string',
              description: 'ID da pasta para análise'
            },
            includeSubfolders: {
              type: 'boolean',
              description: 'Incluir estatísticas das subpastas (padrão: false)'
            }
          },
          required: ['folderId']
        }
      },

      {
        name: 'organize_emails_by_rules',
        description: 'Organiza emails automaticamente usando regras predefinidas (suporta modo simulação)',
        inputSchema: {
          type: 'object',
          properties: {
            sourceFolderId: {
              type: 'string',
              description: 'ID da pasta fonte para organização'
            },
            rules: {
              type: 'array',
              description: 'Array de regras de organização',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Nome da regra' },
                  targetFolderId: { type: 'string', description: 'Pasta de destino' },
                  subjectContains: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Palavras-chave no assunto' 
                  },
                  fromContains: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Domínios ou emails do remetente' 
                  },
                  olderThanDays: { 
                    type: 'number', 
                    description: 'Emails mais antigos que X dias' 
                  }
                }
              }
            },
            dryRun: {
              type: 'boolean',
              description: 'Modo simulação - apenas mostra o que seria feito (padrão: true)'
            },
            maxEmails: {
              type: 'number',
              description: 'Máximo de emails a processar (padrão: 100)'
            }
          },
          required: ['sourceFolderId']
        }
      },

      // ===============================
      // ADVANCED SEARCH TOOLS
      // ===============================
      
      {
        name: 'advanced_search',
        description: 'Busca avançada de emails com múltiplos critérios (texto, remetente, assunto, data, anexos, status)',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Texto para buscar no conteúdo dos emails'
            },
            sender: {
              type: 'string',
              description: 'Email do remetente específico'
            },
            subject: {
              type: 'string',
              description: 'Texto para buscar no assunto'
            },
            dateFrom: {
              type: 'string',
              description: 'Data inicial (formato ISO: 2024-01-01T00:00:00Z)'
            },
            dateTo: {
              type: 'string',
              description: 'Data final (formato ISO: 2024-12-31T23:59:59Z)'
            },
            hasAttachments: {
              type: 'boolean',
              description: 'Filtrar emails com/sem anexos'
            },
            isRead: {
              type: 'boolean',
              description: 'Filtrar emails lidos/não lidos'
            },
            folder: {
              type: 'string',
              description: 'Pasta para buscar (padrão: inbox)'
            },
            maxResults: {
              type: 'number',
              description: 'Máximo de resultados (padrão: 20)'
            },
            sortBy: {
              type: 'string',
              enum: ['receivedDateTime', 'subject', 'from'],
              description: 'Campo para ordenação (padrão: receivedDateTime)'
            },
            sortOrder: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Ordem da classificação (padrão: desc)'
            }
          }
        }
      },

      {
        name: 'search_by_sender_domain',
        description: 'Busca emails por domínio do remetente com análise estatística',
        inputSchema: {
          type: 'object',
          properties: {
            domain: {
              type: 'string',
              description: 'Domínio para buscar (ex: company.com)'
            },
            maxResults: {
              type: 'number',
              description: 'Máximo de resultados (padrão: 20)'
            },
            includeSubdomains: {
              type: 'boolean',
              description: 'Incluir subdomínios na busca (padrão: true)'
            },
            folder: {
              type: 'string',
              description: 'Pasta para buscar (padrão: inbox)'
            },
            dateRange: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Data inicial (ISO format)' },
                to: { type: 'string', description: 'Data final (ISO format)' }
              },
              description: 'Intervalo de datas opcional'
            }
          },
          required: ['domain']
        }
      },

      {
        name: 'search_by_attachment_type',
        description: 'Busca emails por tipo de anexo com análise detalhada',
        inputSchema: {
          type: 'object',
          properties: {
            fileTypes: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'Tipo(s) de arquivo (ex: pdf, xlsx, jpg) ou MIME types'
            },
            maxResults: {
              type: 'number',
              description: 'Máximo de resultados (padrão: 20)'
            },
            folder: {
              type: 'string',
              description: 'Pasta para buscar (padrão: inbox)'
            },
            sizeLimit: {
              type: 'number',
              description: 'Limite de tamanho dos anexos em MB'
            },
            dateRange: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Data inicial (ISO format)' },
                to: { type: 'string', description: 'Data final (ISO format)' }
              },
              description: 'Intervalo de datas opcional'
            }
          },
          required: ['fileTypes']
        }
      },

      {
        name: 'find_duplicate_emails',
        description: 'Encontra emails duplicados com base em diferentes critérios',
        inputSchema: {
          type: 'object',
          properties: {
            criteria: {
              type: 'string',
              enum: ['subject', 'sender', 'subject+sender'],
              description: 'Critério para identificar duplicatas (padrão: subject)'
            },
            folder: {
              type: 'string',
              description: 'Pasta para analisar (padrão: inbox)'
            },
            maxResults: {
              type: 'number',
              description: 'Máximo de emails a analisar (padrão: 50)'
            },
            includeRead: {
              type: 'boolean',
              description: 'Incluir emails lidos na análise (padrão: true)'
            },
            dateRange: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Data inicial (ISO format)' },
                to: { type: 'string', description: 'Data final (ISO format)' }
              },
              description: 'Intervalo de datas opcional'
            }
          }
        }
      },

      {
        name: 'search_by_size',
        description: 'Busca emails por faixa de tamanho',
        inputSchema: {
          type: 'object',
          properties: {
            minSizeMB: {
              type: 'number',
              description: 'Tamanho mínimo em MB'
            },
            maxSizeMB: {
              type: 'number',
              description: 'Tamanho máximo em MB'
            },
            folder: {
              type: 'string',
              description: 'Pasta para buscar (padrão: inbox)'
            },
            maxResults: {
              type: 'number',
              description: 'Máximo de resultados (padrão: 20)'
            },
            includeAttachments: {
              type: 'boolean',
              description: 'Incluir tamanho dos anexos no cálculo (padrão: true)'
            }
          }
        }
      },

      {
        name: 'saved_searches',
        description: 'Gerencia buscas salvas (salvar, listar, executar, deletar)',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['save', 'list', 'execute', 'delete'],
              description: 'Ação a ser executada'
            },
            name: {
              type: 'string',
              description: 'Nome da busca salva (obrigatório para save, execute, delete)'
            },
            searchCriteria: {
              type: 'object',
              description: 'Critérios de busca a serem salvos (obrigatório para save)',
              properties: {
                query: { type: 'string' },
                sender: { type: 'string' },
                subject: { type: 'string' },
                dateFrom: { type: 'string' },
                dateTo: { type: 'string' },
                hasAttachments: { type: 'boolean' },
                isRead: { type: 'boolean' },
                folder: { type: 'string' }
              }
            }
          },
          required: ['action']
        }
      },

      // ===============================
      // BATCH OPERATIONS TOOLS
      // ===============================
      
      {
        name: 'batch_mark_as_read',
        description: 'Marca múltiplos emails como lidos em operação em lote otimizada',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) dos emails a serem marcados como lidos (máx: 100)'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Máximo de operações simultâneas (padrão: 5)'
            }
          },
          required: ['emailIds']
        }
      },

      {
        name: 'batch_mark_as_unread',
        description: 'Marca múltiplos emails como não lidos em operação em lote otimizada',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) dos emails a serem marcados como não lidos (máx: 100)'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Máximo de operações simultâneas (padrão: 5)'
            }
          },
          required: ['emailIds']
        }
      },

      {
        name: 'batch_delete_emails',
        description: 'Deleta múltiplos emails em operação em lote com controle de permanência',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) dos emails a serem deletados (máx: 50)'
            },
            permanent: {
              type: 'boolean',
              description: 'Deleção permanente ou mover para lixeira (padrão: false)'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Máximo de operações simultâneas (padrão: 3)'
            }
          },
          required: ['emailIds']
        }
      },

      {
        name: 'batch_move_emails',
        description: 'Move múltiplos emails para uma pasta específica em operação em lote',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) dos emails a serem movidos (máx: 100)'
            },
            targetFolderId: {
              type: 'string',
              description: 'ID da pasta de destino'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Máximo de operações simultâneas (padrão: 5)'
            },
            validateTarget: {
              type: 'boolean',
              description: 'Validar se a pasta de destino existe (padrão: true)'
            }
          },
          required: ['emailIds', 'targetFolderId']
        }
      },

      {
        name: 'batch_download_attachments',
        description: 'Baixa todos os anexos de múltiplos emails em operação em lote otimizada',
        inputSchema: {
          type: 'object',
          properties: {
            emailIds: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'ID(s) dos emails para baixar anexos (máx: 20)'
            },
            targetDirectory: {
              type: 'string',
              description: 'Diretório de destino (padrão: downloads)'
            },
            maxConcurrent: {
              type: 'number',
              description: 'Máximo de downloads simultâneos (padrão: 3)'
            },
            overwrite: {
              type: 'boolean',
              description: 'Sobrescrever arquivos existentes (padrão: false)'
            },
            validateIntegrity: {
              type: 'boolean',
              description: 'Validar integridade dos arquivos (padrão: true)'
            },
            sizeLimit: {
              type: 'number',
              description: 'Limite de tamanho total em MB (padrão: 25)'
            }
          },
          required: ['emailIds']
        }
      },

      {
        name: 'email_cleanup_wizard',
        description: 'Assistente inteligente de limpeza de emails com critérios personalizáveis e modo simulação',
        inputSchema: {
          type: 'object',
          properties: {
            dryRun: {
              type: 'boolean',
              description: 'Modo simulação - apenas mostrar o que seria deletado (padrão: true)'
            },
            olderThanDays: {
              type: 'number',
              description: 'Deletar emails mais antigos que X dias (padrão: 30)'
            },
            deleteRead: {
              type: 'boolean',
              description: 'Deletar emails já lidos (padrão: false)'
            },
            deleteLargeAttachments: {
              type: 'boolean',
              description: 'Deletar emails com anexos grandes (padrão: false)'
            },
            attachmentSizeLimitMB: {
              type: 'number',
              description: 'Limite de tamanho de anexo em MB (padrão: 10)'
            },
            excludeFolders: {
              type: 'array',
              items: { type: 'string' },
              description: 'Pastas a excluir da limpeza (padrão: [sent, drafts])'
            },
            maxEmails: {
              type: 'number',
              description: 'Máximo de emails a analisar (padrão: 100)'
            }
          }
        }
      }
    ];
  }
}