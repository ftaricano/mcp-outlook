import { EmailService } from '../services/emailService.js';
import { EmailSummarizer } from '../services/emailSummarizer.js';
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
  private readonly emailHandler: EmailHandler;
  private readonly attachmentHandler: AttachmentHandler;
  private readonly hybridHandler: HybridHandler;
  private readonly folderHandler: FolderHandler;
  private readonly searchHandler: SearchHandler;
  private readonly batchHandler: BatchHandler;

  constructor(emailService: EmailService, emailSummarizer: EmailSummarizer) {
    this.emailHandler = new EmailHandler(emailService, emailSummarizer);
    this.attachmentHandler = new AttachmentHandler(emailService, emailSummarizer);
    this.hybridHandler = new HybridHandler(emailService, emailSummarizer);
    this.folderHandler = new FolderHandler(emailService, emailSummarizer);
    this.searchHandler = new SearchHandler(emailService, emailSummarizer);
    this.batchHandler = new BatchHandler(emailService, emailSummarizer);
  }

  /**
   * Route a tool request to its handler. Input is validated by the Zod
   * registry in `toolSchemas.ts`; validation failures are returned as a
   * structured MCP error response (isError: true), never thrown, so the
   * caller observes consistent behaviour regardless of which tool failed.
   */
  async handleTool(name: string, args: unknown): Promise<HandlerResult> {
    const validation = validateToolInput(name, args);
    if (!validation.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid arguments for ${name}: ${validation.error}`,
          },
        ],
        isError: true,
      };
    }
    const validated = validation.data;

    switch (name) {
      // Email operations
      case 'list_emails':
        return this.emailHandler.handleListEmails(validated);
      case 'send_email':
        return this.emailHandler.handleSendEmail(validated);
      case 'create_draft':
        return this.emailHandler.handleCreateDraft(validated);
      case 'reply_to_email':
        return this.emailHandler.handleReplyToEmail(validated);
      case 'mark_as_read':
        return this.emailHandler.handleMarkAsRead(validated);
      case 'mark_as_unread':
        return this.emailHandler.handleMarkAsUnread(validated);
      case 'delete_email':
        return this.emailHandler.handleDeleteEmail(validated);
      case 'summarize_email':
        return this.emailHandler.handleSummarizeEmail(validated);
      case 'summarize_emails_batch':
        return this.emailHandler.handleSummarizeEmailsBatch(validated);
      case 'list_users':
        return this.emailHandler.handleListUsers(validated);

      // Attachment operations
      case 'list_attachments':
        return this.attachmentHandler.handleListAttachments(validated);
      case 'download_attachment':
        return this.attachmentHandler.handleDownloadAttachment(validated);
      case 'download_attachment_to_file':
        return this.attachmentHandler.handleDownloadAttachmentToFile(validated);
      case 'download_all_attachments':
        return this.attachmentHandler.handleDownloadAllAttachments(validated);
      case 'list_downloaded_files':
        return this.attachmentHandler.handleListDownloadedFiles(validated);
      case 'get_download_directory_info':
        return this.attachmentHandler.handleGetDownloadDirectoryInfo(validated);
      case 'cleanup_old_downloads':
        return this.attachmentHandler.handleCleanupOldDownloads(validated);
      case 'export_email_as_attachment':
        return this.attachmentHandler.handleExportEmailAsAttachment(validated);
      case 'encode_file_for_attachment':
        return this.attachmentHandler.handleEncodeFileForAttachment(validated);

      // Hybrid operations
      case 'send_email_from_attachment':
        return this.hybridHandler.handleSendEmailFromAttachment(validated);
      case 'send_email_with_file':
        return this.hybridHandler.handleSendEmailWithFile(validated);

      // Folder operations
      case 'list_folders':
        return this.folderHandler.handleListFolders(validated);
      case 'create_folder':
        return this.folderHandler.handleCreateFolder(validated);
      case 'move_emails_to_folder':
        return this.folderHandler.handleMoveEmailsToFolder(validated);
      case 'copy_emails_to_folder':
        return this.folderHandler.handleCopyEmailsToFolder(validated);
      case 'delete_folder':
        return this.folderHandler.handleDeleteFolder(validated);
      case 'get_folder_stats':
        return this.folderHandler.handleGetFolderStats(validated);
      case 'organize_emails_by_rules':
        return this.folderHandler.handleOrganizeEmailsByRules(validated);

      // Search operations
      case 'advanced_search':
        return this.searchHandler.handleAdvancedSearch(validated);
      case 'search_by_sender_domain':
        return this.searchHandler.handleSearchBySenderDomain(validated);
      case 'search_by_attachment_type':
        return this.searchHandler.handleSearchByAttachmentType(validated);
      case 'find_duplicate_emails':
        return this.searchHandler.handleFindDuplicateEmails(validated);
      case 'search_by_size':
        return this.searchHandler.handleSearchBySize(validated);
      case 'saved_searches':
        return this.searchHandler.handleSavedSearches(validated);

      // Batch operations
      case 'batch_mark_as_read':
        return this.batchHandler.handleBatchMarkAsRead(validated);
      case 'batch_mark_as_unread':
        return this.batchHandler.handleBatchMarkAsUnread(validated);
      case 'batch_delete_emails':
        return this.batchHandler.handleBatchDeleteEmails(validated);
      case 'batch_move_emails':
        return this.batchHandler.handleBatchMoveEmails(validated);
      case 'batch_download_attachments':
        return this.batchHandler.handleBatchDownloadAttachments(validated);
      case 'email_cleanup_wizard':
        return this.batchHandler.handleEmailCleanupWizard(validated);

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  }

  /**
   * JSON-Schema list for MCP ListTools handshake.
   */
  static getToolSchemas(): ReturnType<typeof buildToolSchemas> {
    return buildToolSchemas();
  }
}
