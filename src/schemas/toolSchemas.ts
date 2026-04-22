import { z } from 'zod';

/**
 * Runtime validation schemas for all 39 MCP tool inputs.
 *
 * These mirror the JSON Schema semantics that were previously declared inline
 * in HandlerRegistry.ts, while adding sensible runtime constraints (email
 * format, non-empty strings, array bounds, integer/nonnegative numerics).
 */

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

const emailAddress = z.string().email();
const emailAddressList = z.array(emailAddress).min(1);

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

const nonEmptyString = z.string().min(1);
const isoDateString = z.string().min(1);

const templateTheme = z.enum(['professional', 'modern', 'minimal', 'corporate']);

const stringOrStringArray = z.union([nonEmptyString, z.array(nonEmptyString).min(1)]);

const folderName = z.string().min(1);

const attachmentInput = z.object({
  name: nonEmptyString,
  contentType: nonEmptyString,
  content: nonEmptyString,
  size: nonNegativeInt.optional()
});

const dateRange = z
  .object({
    from: isoDateString.optional(),
    to: isoDateString.optional()
  })
  .optional();

const organizeRule = z.object({
  name: z.string().optional(),
  targetFolderId: z.string().optional(),
  subjectContains: z.array(z.string()).optional(),
  fromContains: z.array(z.string()).optional(),
  olderThanDays: z.number().optional()
});

const searchCriteria = z
  .object({
    query: z.string().optional(),
    sender: z.string().optional(),
    subject: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    hasAttachments: z.boolean().optional(),
    isRead: z.boolean().optional(),
    folder: z.string().optional()
  })
  .optional();

// ---------------------------------------------------------------------------
// 1. Email Management (9 tools)
// ---------------------------------------------------------------------------

const listEmailsSchema = z.object({
  limit: nonNegativeInt.max(50).optional(),
  skip: nonNegativeInt.optional(),
  folder: z.string().optional(),
  search: z.string().optional()
});

const sendEmailSchema = z.object({
  to: emailAddressList,
  subject: nonEmptyString,
  body: z.string(),
  cc: z.array(emailAddress).optional(),
  bcc: z.array(emailAddress).optional(),
  attachments: z.array(attachmentInput).optional(),
  useTemplate: z.boolean().optional(),
  templateTheme: templateTheme.optional()
});

const replyToEmailSchema = z.object({
  emailId: nonEmptyString,
  body: z.string(),
  replyAll: z.boolean().optional()
});

const createDraftSchema = z.object({
  to: emailAddressList,
  subject: nonEmptyString,
  body: z.string(),
  cc: z.array(emailAddress).optional(),
  bcc: z.array(emailAddress).optional(),
  attachments: z.array(attachmentInput).optional(),
  useTemplate: z.boolean().optional(),
  templateTheme: templateTheme.optional()
});

const markAsReadSchema = z.object({ emailId: nonEmptyString });
const markAsUnreadSchema = z.object({ emailId: nonEmptyString });
const deleteEmailSchema = z.object({ emailId: nonEmptyString });
const summarizeEmailSchema = z.object({ emailId: nonEmptyString });

const summarizeEmailsBatchSchema = z.object({
  limit: nonNegativeInt.max(20).optional(),
  skip: nonNegativeInt.optional(),
  folder: z.string().optional(),
  priorityOnly: z.boolean().optional()
});

const listUsersSchema = z.object({
  limit: nonNegativeInt.optional(),
  search: z.string().optional()
});

// ---------------------------------------------------------------------------
// 2. Attachment Management (9 tools, basic + advanced)
// ---------------------------------------------------------------------------

const listAttachmentsSchema = z.object({ emailId: nonEmptyString });

const downloadAttachmentSchema = z.object({
  emailId: nonEmptyString,
  attachmentId: nonEmptyString,
  includeMetadata: z.boolean().optional()
});

const downloadAttachmentToFileSchema = z.object({
  emailId: nonEmptyString,
  attachmentId: nonEmptyString,
  targetDirectory: z.string().optional(),
  customFilename: z.string().optional(),
  overwrite: z.boolean().optional(),
  validateIntegrity: z.boolean().optional()
});

const downloadAllAttachmentsSchema = z.object({
  emailId: nonEmptyString,
  targetDirectory: z.string().optional(),
  overwrite: z.boolean().optional(),
  validateIntegrity: z.boolean().optional(),
  maxConcurrent: positiveInt.optional()
});

const listDownloadedFilesSchema = z.object({}).passthrough();
const getDownloadDirectoryInfoSchema = z.object({}).passthrough();

const cleanupOldDownloadsSchema = z.object({
  daysOld: nonNegativeInt.optional(),
  dryRun: z.boolean().optional()
});

const exportEmailAsAttachmentSchema = z.object({
  emailId: nonEmptyString,
  format: z.enum(['eml', 'msg']).optional()
});

const encodeFileForAttachmentSchema = z.object({
  filePath: nonEmptyString,
  customFilename: z.string().optional()
});

// ---------------------------------------------------------------------------
// 3. Hybrid Functions (2 tools)
// ---------------------------------------------------------------------------

const sendEmailFromAttachmentSchema = z.object({
  sourceEmailId: nonEmptyString,
  attachmentId: nonEmptyString,
  to: emailAddressList,
  subject: nonEmptyString,
  body: z.string(),
  cc: z.array(emailAddress).optional(),
  bcc: z.array(emailAddress).optional(),
  useTemplate: z.boolean().optional(),
  templateTheme: templateTheme.optional(),
  keepOriginalFile: z.boolean().optional(),
  customFilename: z.string().optional()
});

const sendEmailWithFileSchema = z.object({
  filePath: nonEmptyString,
  to: emailAddressList,
  subject: nonEmptyString,
  body: z.string(),
  cc: z.array(emailAddress).optional(),
  bcc: z.array(emailAddress).optional(),
  useTemplate: z.boolean().optional(),
  templateTheme: templateTheme.optional(),
  customFilename: z.string().optional()
});

// ---------------------------------------------------------------------------
// 4. Folder Management (7 tools)
// ---------------------------------------------------------------------------

const listFoldersSchema = z.object({
  includeSubfolders: z.boolean().optional(),
  maxDepth: positiveInt.optional()
});

const createFolderSchema = z.object({
  folderName,
  parentFolderId: z.string().optional()
});

const moveEmailsToFolderSchema = z.object({
  emailIds: stringOrStringArray,
  targetFolderId: nonEmptyString
});

const copyEmailsToFolderSchema = z.object({
  emailIds: stringOrStringArray,
  targetFolderId: nonEmptyString
});

const deleteFolderSchema = z.object({
  folderId: nonEmptyString,
  permanent: z.boolean().optional()
});

const getFolderStatsSchema = z.object({
  folderId: nonEmptyString,
  includeSubfolders: z.boolean().optional()
});

const organizeEmailsByRulesSchema = z.object({
  sourceFolderId: nonEmptyString,
  rules: z.array(organizeRule).optional(),
  dryRun: z.boolean().optional(),
  maxEmails: positiveInt.optional()
});

// ---------------------------------------------------------------------------
// 5. Advanced Search (6 tools)
// ---------------------------------------------------------------------------

const advancedSearchSchema = z.object({
  query: z.string().optional(),
  sender: z.string().optional(),
  subject: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  isRead: z.boolean().optional(),
  folder: z.string().optional(),
  maxResults: positiveInt.optional(),
  sortBy: z.enum(['receivedDateTime', 'subject', 'from']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
});

const searchBySenderDomainSchema = z.object({
  domain: nonEmptyString,
  maxResults: positiveInt.optional(),
  includeSubdomains: z.boolean().optional(),
  folder: z.string().optional(),
  dateRange
});

const searchByAttachmentTypeSchema = z.object({
  fileTypes: stringOrStringArray,
  maxResults: positiveInt.optional(),
  folder: z.string().optional(),
  sizeLimit: z.number().nonnegative().optional(),
  dateRange
});

const findDuplicateEmailsSchema = z.object({
  criteria: z.enum(['subject', 'sender', 'subject+sender']).optional(),
  folder: z.string().optional(),
  maxResults: positiveInt.optional(),
  includeRead: z.boolean().optional(),
  dateRange
});

const searchBySizeSchema = z.object({
  minSizeMB: z.number().nonnegative().optional(),
  maxSizeMB: z.number().nonnegative().optional(),
  folder: z.string().optional(),
  maxResults: positiveInt.optional(),
  includeAttachments: z.boolean().optional()
});

const savedSearchesSchema = z.object({
  action: z.enum(['save', 'list', 'execute', 'delete']),
  name: z.string().optional(),
  searchCriteria
});

// ---------------------------------------------------------------------------
// 6. Batch Operations (6 tools)
// ---------------------------------------------------------------------------

const emailIdsBatch = (max: number) =>
  z.union([nonEmptyString, z.array(nonEmptyString).min(1).max(max)]);

const batchMarkAsReadSchema = z.object({
  emailIds: emailIdsBatch(100),
  maxConcurrent: positiveInt.optional()
});

const batchMarkAsUnreadSchema = z.object({
  emailIds: emailIdsBatch(100),
  maxConcurrent: positiveInt.optional()
});

const batchDeleteEmailsSchema = z.object({
  emailIds: emailIdsBatch(50),
  permanent: z.boolean().optional(),
  maxConcurrent: positiveInt.optional()
});

const batchMoveEmailsSchema = z.object({
  emailIds: emailIdsBatch(100),
  targetFolderId: nonEmptyString,
  maxConcurrent: positiveInt.optional(),
  validateTarget: z.boolean().optional()
});

const batchDownloadAttachmentsSchema = z.object({
  emailIds: emailIdsBatch(20),
  targetDirectory: z.string().optional(),
  maxConcurrent: positiveInt.optional(),
  overwrite: z.boolean().optional(),
  validateIntegrity: z.boolean().optional(),
  sizeLimit: z.number().nonnegative().optional()
});

const emailCleanupWizardSchema = z.object({
  dryRun: z.boolean().optional(),
  olderThanDays: nonNegativeInt.optional(),
  deleteRead: z.boolean().optional(),
  deleteLargeAttachments: z.boolean().optional(),
  attachmentSizeLimitMB: z.number().nonnegative().optional(),
  excludeFolders: z.array(z.string()).optional(),
  maxEmails: positiveInt.optional()
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const toolSchemas: Record<string, z.ZodTypeAny> = {
  // Email Management
  list_emails: listEmailsSchema,
  send_email: sendEmailSchema,
  reply_to_email: replyToEmailSchema,
  mark_as_read: markAsReadSchema,
  mark_as_unread: markAsUnreadSchema,
  delete_email: deleteEmailSchema,
  summarize_email: summarizeEmailSchema,
  summarize_emails_batch: summarizeEmailsBatchSchema,
  list_users: listUsersSchema,

  // Attachment Management
  list_attachments: listAttachmentsSchema,
  download_attachment: downloadAttachmentSchema,
  download_attachment_to_file: downloadAttachmentToFileSchema,
  download_all_attachments: downloadAllAttachmentsSchema,
  list_downloaded_files: listDownloadedFilesSchema,
  get_download_directory_info: getDownloadDirectoryInfoSchema,
  cleanup_old_downloads: cleanupOldDownloadsSchema,
  export_email_as_attachment: exportEmailAsAttachmentSchema,
  encode_file_for_attachment: encodeFileForAttachmentSchema,

  // Hybrid
  send_email_from_attachment: sendEmailFromAttachmentSchema,
  send_email_with_file: sendEmailWithFileSchema,

  // Folder Management
  list_folders: listFoldersSchema,
  create_folder: createFolderSchema,
  move_emails_to_folder: moveEmailsToFolderSchema,
  copy_emails_to_folder: copyEmailsToFolderSchema,
  delete_folder: deleteFolderSchema,
  get_folder_stats: getFolderStatsSchema,
  organize_emails_by_rules: organizeEmailsByRulesSchema,

  // Advanced Search
  advanced_search: advancedSearchSchema,
  search_by_sender_domain: searchBySenderDomainSchema,
  search_by_attachment_type: searchByAttachmentTypeSchema,
  find_duplicate_emails: findDuplicateEmailsSchema,
  search_by_size: searchBySizeSchema,
  saved_searches: savedSearchesSchema,

  // Batch Operations
  batch_mark_as_read: batchMarkAsReadSchema,
  batch_mark_as_unread: batchMarkAsUnreadSchema,
  batch_delete_emails: batchDeleteEmailsSchema,
  batch_move_emails: batchMoveEmailsSchema,
  batch_download_attachments: batchDownloadAttachmentsSchema,
  email_cleanup_wizard: emailCleanupWizardSchema
};

/**
 * Validate tool input at runtime using the zod schema registered for the
 * given tool name. Returns a tagged union so callers can pattern-match on
 * success without try/catch on ZodError.
 */
export function validateToolInput(
  toolName: string,
  args: unknown
): { ok: true; data: any } | { ok: false; error: string } {
  const schema = toolSchemas[toolName];
  if (!schema) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }

  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  const flattened = parsed.error.errors
    .map((err) => {
      const path = err.path.length > 0 ? err.path.join('.') : '(root)';
      return `${path}: ${err.message}`;
    })
    .join('; ');

  return { ok: false, error: flattened };
}
