import { z } from 'zod';
import type { Message } from '@microsoft/microsoft-graph-types';
import type { ReliableSearchResult, SearchStatus } from '../services/reliableSearch.js';

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
    maxResults: z.number().int().min(1).max(50).optional(),
    maxPages: z.number().int().min(1).max(10).optional(),
    sortBy: z.enum(['receivedDateTime', 'subject']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
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

export type PluginSearchCriteria = z.output<typeof searchCriteriaSchema>;
export type SearchMailboxInput = z.output<typeof searchMailboxSchema>;
export type SearchMailboxesInput = z.output<typeof searchMailboxesSchema>;
export type GetMessageInput = z.output<typeof getMessageSchema>;

export interface MailboxSearchResult extends ReliableSearchResult<Message> {
  readonly mailbox: string;
}

export interface MultiMailboxSearchResult {
  readonly status: SearchStatus;
  readonly results: readonly MailboxSearchResult[];
}
