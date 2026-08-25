import { z } from 'zod';
import type { Message } from '@microsoft/microsoft-graph-types';
import type { ReliableSearchResult, SearchStatus } from '../services/reliableSearch.js';
import { isAddressableZipEntryName, MAX_ZIP_ENTRY_NAME_CHARS } from './zipEntryName.js';

const mailboxAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'mailbox must be a lowercase alias');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const isoDateString = z
  .string()
  .regex(ISO_DATE_RE, 'must be an ISO-8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)');

const searchCriteriaSchema = z
  .object({
    query: z.string().min(1).max(500).optional(),
    sender: z.string().min(1).max(320).optional(),
    subject: z.string().min(1).max(500).optional(),
    dateFrom: isoDateString.optional(),
    dateTo: isoDateString.optional(),
    hasAttachments: z.boolean().optional(),
    isRead: z.boolean().optional(),
    folder: z.string().min(1).max(512).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    maxPages: z.number().int().min(1).max(10).optional(),
    sortBy: z.enum(['receivedDateTime', 'subject']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    includeAttachmentNames: z.boolean().optional(),
    expandTerms: z.boolean().optional(),
  })
  .strict();

export const listAllowedMailboxesSchema = z.object({}).strict();

export const searchMailboxSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    criteria: searchCriteriaSchema,
  })
  .strict();

export const searchMailboxesSchema = z
  .object({
    mailboxes: z.array(mailboxAliasSchema).min(1).max(32).optional(),
    criteria: searchCriteriaSchema,
  })
  .strict();

export const getMessageSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageId: z.string().min(1).max(512),
  })
  .strict();

const messageIdSchema = z.string().min(1).max(512);
// Same predicate the listing uses, so what the caller can see is exactly what
// the caller can extract.
const zipEntrySchema = z
  .string()
  .min(1)
  .max(MAX_ZIP_ENTRY_NAME_CHARS)
  .refine(isAddressableZipEntryName, {
    message: 'entry must be a relative path without traversal or backslashes',
  });

export const listMessagesSchema = z
  .object({ mailbox: mailboxAliasSchema, criteria: searchCriteriaSchema })
  .strict();

export const listFoldersSchema = z.object({ mailbox: mailboxAliasSchema }).strict();

export const getFolderStatsSchema = z
  .object({ mailbox: mailboxAliasSchema, folderId: z.string().min(1).max(512) })
  .strict();

export const listAttachmentsSchema = z
  .object({ mailbox: mailboxAliasSchema, messageId: messageIdSchema })
  .strict();

export const getAttachmentContentSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageId: messageIdSchema,
    attachmentId: z.string().min(1).max(512),
    mode: z.enum(['text', 'raw']).default('text'),
    entry: zipEntrySchema.optional(),
    password: z.string().min(1).max(256).optional(),
  })
  .strict();

const investigationFolderSchema = z.enum(['inbox', 'sentitems', 'archive']);
const investigationSignalSchema = z.string().trim().min(1).max(200);
const investigationSignalListSchema = z.array(investigationSignalSchema).max(25).default([]);

const investigateDocumentsCriteriaSchema = z
  .object({
    proposalIds: investigationSignalListSchema,
    clients: investigationSignalListSchema,
    insurers: investigationSignalListSchema,
    attachmentNames: investigationSignalListSchema,
    folders: z
      .array(investigationFolderSchema)
      .min(1)
      .max(3)
      .default(['inbox', 'sentitems', 'archive']),
    maxPagesPerFolder: z.number().int().min(1).max(10).default(10),
    maxMessagesPerFolder: z.number().int().min(1).max(200).default(100),
    maxAttachmentPagesPerMessage: z.number().int().min(1).max(5).default(5),
    maxAttachmentsPerMessage: z.number().int().min(1).max(50).default(50),
    maxResults: z.number().int().min(1).max(25).default(25),
  })
  .strict()
  .superRefine((criteria, context) => {
    if (new Set(criteria.folders).size !== criteria.folders.length) {
      context.addIssue({
        code: 'custom',
        path: ['folders'],
        message: 'folders must be unique',
      });
    }
    if (
      criteria.proposalIds.length === 0 &&
      criteria.clients.length === 0 &&
      criteria.insurers.length === 0 &&
      criteria.attachmentNames.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'at least one investigation signal is required',
      });
    }
  });

export const investigateDocumentsSchema = z
  .object({ mailbox: mailboxAliasSchema, criteria: investigateDocumentsCriteriaSchema })
  .strict();

const inspectAttachmentEvidenceSignalListSchema = z
  .array(investigationSignalSchema)
  .max(25)
  .default([]);

export const inspectAttachmentEvidenceSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageId: messageIdSchema,
    attachmentId: z.string().min(1).max(512),
    proposalIds: inspectAttachmentEvidenceSignalListSchema,
    clients: inspectAttachmentEvidenceSignalListSchema,
    insurers: inspectAttachmentEvidenceSignalListSchema,
    attachmentNames: inspectAttachmentEvidenceSignalListSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.proposalIds.length === 0 &&
      input.clients.length === 0 &&
      input.insurers.length === 0 &&
      input.attachmentNames.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'at least one attachment evidence signal is required',
      });
    }
  });

export const createAttachmentHandoffSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageId: messageIdSchema,
    attachmentId: z.string().min(1).max(512),
    idempotencyKey: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        'idempotencyKey must be a UUIDv4'
      ),
  })
  .strict();

export const getAttachmentHandoffSchema = z
  .object({
    handoffId: z
      .string()
      .regex(/^oh_[A-Za-z0-9_-]{43}$/, 'handoffId is not a valid opaque handoff identifier'),
  })
  .strict();

const batchQuerySchema = z
  .object({
    label: z.string().min(1).max(120),
    mailboxes: z.array(mailboxAliasSchema).min(1).max(32).optional(),
    criteria: searchCriteriaSchema,
  })
  .strict();

export const searchMailboxesBatchSchema = z
  .object({ queries: z.array(batchQuerySchema).min(1).max(25) })
  .strict()
  .superRefine(({ queries }, context) => {
    const labels = new Set<string>();
    queries.forEach((query, index) => {
      if (labels.has(query.label)) {
        context.addIssue({
          code: 'custom',
          path: ['queries', index, 'label'],
          message: `duplicate label: ${query.label}`,
        });
      }
      labels.add(query.label);
    });
  });

const messageIdsSchema = z.array(messageIdSchema).min(1).max(100);

export const moveMessagesSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageIds: messageIdsSchema,
    destinationFolderId: z.string().min(1).max(512),
  })
  .strict();

export const copyMessagesSchema = moveMessagesSchema;

export const markMessagesSchema = z
  .object({ mailbox: mailboxAliasSchema, messageIds: messageIdsSchema, read: z.boolean() })
  .strict();

export const downloadAttachmentsSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    messageId: messageIdSchema,
    attachmentIds: z.array(z.string().min(1).max(512)).min(1).max(100).optional(),
  })
  .strict();

const emailAddressListSchema = z.array(z.string().email()).min(1).max(50);

export const createDraftSchema = z
  .object({
    mailbox: mailboxAliasSchema,
    to: emailAddressListSchema,
    cc: emailAddressListSchema.optional(),
    bcc: emailAddressListSchema.optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(500_000),
    attachmentPaths: z.array(z.string().min(1).max(1024)).max(10).optional(),
  })
  .strict();

export type PluginSearchCriteria = z.output<typeof searchCriteriaSchema>;
export type SearchMailboxInput = z.output<typeof searchMailboxSchema>;
export type SearchMailboxesInput = z.output<typeof searchMailboxesSchema>;
export type GetMessageInput = z.output<typeof getMessageSchema>;
export type ListMessagesInput = z.output<typeof listMessagesSchema>;
export type ListFoldersInput = z.output<typeof listFoldersSchema>;
export type GetFolderStatsInput = z.output<typeof getFolderStatsSchema>;
export type ListAttachmentsInput = z.output<typeof listAttachmentsSchema>;
export type GetAttachmentContentInput = z.output<typeof getAttachmentContentSchema>;
export type InvestigateDocumentsInput = z.output<typeof investigateDocumentsSchema>;
export type InvestigateDocumentsCriteria = InvestigateDocumentsInput['criteria'];
export type InspectAttachmentEvidenceInput = z.output<typeof inspectAttachmentEvidenceSchema>;
export type CreateAttachmentHandoffInput = z.output<typeof createAttachmentHandoffSchema>;
export type GetAttachmentHandoffInput = z.output<typeof getAttachmentHandoffSchema>;
export type SearchMailboxesBatchInput = z.output<typeof searchMailboxesBatchSchema>;
export type MoveMessagesInput = z.output<typeof moveMessagesSchema>;
export type MarkMessagesInput = z.output<typeof markMessagesSchema>;
export type DownloadAttachmentsInput = z.output<typeof downloadAttachmentsSchema>;
/**
 * Sending takes no `mailbox`. The plugin reads untrusted mail from every
 * allowed mailbox, so a caller-nameable sender would be an input a malicious
 * message could try to steer ("reply as the owner"). The sending mailbox is
 * pinned by configuration (`OUTLOOK_SEND_FROM`); here it is not sayable.
 */
export const sendEmailSchema = z
  .object({
    to: emailAddressListSchema,
    cc: emailAddressListSchema.optional(),
    bcc: emailAddressListSchema.optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(500_000),
  })
  .strict();

export type CreateDraftInput = z.output<typeof createDraftSchema>;
export type SendEmailInput = z.output<typeof sendEmailSchema>;

export interface MailboxSearchResult extends ReliableSearchResult<Message> {
  readonly mailbox: string;
  readonly expandedTerms?: readonly string[];
}

export interface MultiMailboxSearchResult {
  readonly status: SearchStatus;
  readonly results: readonly MailboxSearchResult[];
}
