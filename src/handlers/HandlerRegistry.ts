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
   * Get all available tools with their JSON schemas, generated from the
   * zod registry in src/schemas/.
   */
  static getToolSchemas(): any[] {
    return buildToolSchemas();
  }
}
