import type { Message } from '@microsoft/microsoft-graph-types';
import type { AdvancedSearchOptions, EmailService } from '../services/emailService.js';
import type { ReliableSearchResult, SearchStatus } from '../services/reliableSearch.js';
import type { PluginConfig, MailboxConfig } from './config.js';
import type { MailboxSearchResult, MultiMailboxSearchResult } from './schemas.js';
import {
  ExtractionError,
  runAttachmentPipeline,
  ZipError,
  type ZipEntryInfo,
} from './extractors.js';
import { expandTerm, type SearchMemory } from './searchMemory.js';

export type MailboxEmailService = Pick<
  EmailService,
  | 'advancedSearchEmailsDetailed'
  | 'getEmailById'
  | 'listFolders'
  | 'getFolderStatistics'
  | 'listAttachments'
  | 'downloadAttachment'
  | 'downloadAttachmentToFile'
  | 'downloadAllAttachmentsFromEmail'
  | 'moveEmailsToFolder'
  | 'copyEmailsToFolder'
  | 'batchMarkAsRead'
  | 'batchMarkAsUnread'
  | 'createDraft'
  | 'encodeFileForAttachment'
>;

export type EmailServiceFactory = (mailboxAddress: string) => MailboxEmailService;

export class UnknownMailboxAliasError extends Error {
  constructor(alias: string) {
    super(`Unknown mailbox alias: ${alias}`);
    this.name = 'UnknownMailboxAliasError';
  }
}

export class MailboxLimitError extends Error {
  constructor(limit: number) {
    super(`Requested mailboxes exceed the server mailbox limit of ${limit}`);
    this.name = 'MailboxLimitError';
  }
}

export class MailboxOperationError extends Error {
  constructor(operation: string) {
    super(`Mailbox ${operation} failed`);
    this.name = 'MailboxOperationError';
  }
}

export class BatchLimitError extends Error {
  constructor(limit: number) {
    super(`Requested items exceed the server batch limit of ${limit}`);
    this.name = 'BatchLimitError';
  }
}

export type AttachmentContentErrorCode =
  | 'ATTACHMENT_TOO_LARGE'
  | 'RAW_TOO_LARGE'
  | 'ATTACHMENT_FETCH_FAILED'
  | ZipError['code']
  | ExtractionError['code'];

export class AttachmentContentError extends Error {
  constructor(readonly code: AttachmentContentErrorCode) {
    super(code);
    this.name = 'AttachmentContentError';
  }
}

export interface AttachmentContentOptions {
  readonly mode: 'text' | 'raw';
  readonly entry?: string;
  readonly password?: string;
}

export interface AttachmentContentResult {
  readonly mailbox: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly contentType: string;
  readonly kind: 'text' | 'raw' | 'zip_listing';
  readonly entry?: string;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly extractor?: string;
  readonly base64?: string;
  readonly sizeBytes?: number;
  readonly zipEntries?: readonly ZipEntryInfo[];
}

export class MultiMailboxService {
  constructor(
    private readonly config: PluginConfig,
    private readonly createEmailService: EmailServiceFactory,
    private readonly searchMemory: SearchMemory | null = null
  ) {}

  listAllowedMailboxes(): readonly string[] {
    return this.config.mailboxes.map((mailbox) => mailbox.alias);
  }

  async searchMailbox(
    alias: string,
    criteria: AdvancedSearchOptions & { expandTerms?: boolean }
  ): Promise<MailboxSearchResult> {
    const mailbox = this.resolveMailbox(alias);
    return this.searchResolvedMailbox(mailbox, criteria);
  }

  async searchMailboxes(
    aliases: readonly string[] | undefined,
    criteria: AdvancedSearchOptions & { expandTerms?: boolean }
  ): Promise<MultiMailboxSearchResult> {
    const mailboxes = this.resolveRequestedMailboxes(aliases);
    if (mailboxes.length > this.config.maxMailboxesPerSearch) {
      throw new MailboxLimitError(this.config.maxMailboxesPerSearch);
    }

    const results = new Array<MailboxSearchResult>(mailboxes.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.config.maxConcurrentMailboxes, mailboxes.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= mailboxes.length) return;
          results[index] = await this.searchResolvedMailbox(mailboxes[index], criteria);
        }
      })
    );

    return {
      status: aggregateSearchStatus(results),
      results,
    };
  }

  async getMessage(alias: string, messageId: string): Promise<Message> {
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);
    return emailService.getEmailById(messageId);
  }

  async listMessages(alias: string, criteria: AdvancedSearchOptions): Promise<MailboxSearchResult> {
    const mailbox = this.resolveMailbox(alias);
    return this.searchResolvedMailbox(mailbox, { ...criteria, query: undefined });
  }

  async listFolders(alias: string): Promise<unknown[]> {
    const mailbox = this.resolveMailbox(alias);
    try {
      return await this.createEmailService(mailbox.address).listFolders(true, 3);
    } catch {
      throw new MailboxOperationError('folder listing');
    }
  }

  async getFolderStats(alias: string, folderId: string): Promise<unknown> {
    const mailbox = this.resolveMailbox(alias);
    try {
      return await this.createEmailService(mailbox.address).getFolderStatistics(folderId, false);
    } catch {
      throw new MailboxOperationError('folder stats');
    }
  }

  async listAttachments(alias: string, messageId: string): Promise<unknown[]> {
    const mailbox = this.resolveMailbox(alias);
    try {
      return await this.createEmailService(mailbox.address).listAttachments(messageId);
    } catch {
      throw new MailboxOperationError('attachment listing');
    }
  }

  async getAttachmentContent(
    alias: string,
    messageId: string,
    attachmentId: string,
    options: AttachmentContentOptions
  ): Promise<AttachmentContentResult> {
    const mailbox = this.resolveMailbox(alias);

    let downloaded: { name: string; contentType: string; content: string };
    try {
      downloaded = await this.createEmailService(mailbox.address).downloadAttachment(
        messageId,
        attachmentId
      );
    } catch {
      throw new AttachmentContentError('ATTACHMENT_FETCH_FAILED');
    }

    const buffer = Buffer.from(downloaded.content, 'base64');
    if (buffer.length > this.config.maxAttachmentInputBytes) {
      throw new AttachmentContentError('ATTACHMENT_TOO_LARGE');
    }

    const base = {
      mailbox: mailbox.alias,
      messageId,
      attachmentId,
      name: downloaded.name,
      contentType: downloaded.contentType,
    };

    const zipLimits = {
      maxEntries: this.config.maxZipEntries,
      maxUncompressedBytes: this.config.maxZipUncompressedBytes,
    };

    // The isolated worker (extractionWorker.ts) is the sole place that
    // decrypts, inflates, or parses attachment bytes — nothing here touches
    // zipArchive.ts or a document parser directly. That worker isolation
    // bounds the event loop and V8 heap of one worker, not native/Buffer
    // memory; the actual size guarantees are maxAttachmentInputBytes above,
    // the raw cap passed below (enforced inside the worker before any bytes
    // are cloned back here), the ZIP caps, and the concurrency gate bounding
    // how many workers can run at once (see extractors.ts).
    let result;
    try {
      result = await runAttachmentPipeline({
        buffer,
        name: downloaded.name,
        contentType: downloaded.contentType,
        maxChars: this.config.maxExtractedChars,
        mode: options.mode,
        entry: options.entry,
        password: options.password,
        zipLimits,
        containerLimits: zipLimits,
        maxRawBytes: this.config.maxRawAttachmentBytes,
        maxConcurrentExtractions: this.config.maxConcurrentExtractions,
      });
    } catch (error) {
      if (error instanceof ZipError || error instanceof ExtractionError) {
        throw new AttachmentContentError(error.code);
      }
      throw error;
    }

    if (result.kind === 'zip_listing') {
      return { ...base, kind: 'zip_listing', zipEntries: result.zipEntries };
    }
    if (result.kind === 'raw') {
      // Redundant, cheap defense-in-depth: the worker already enforced this
      // cap before the bytes were cloned back via postMessage.
      if (result.sizeBytes > this.config.maxRawAttachmentBytes) {
        throw new AttachmentContentError('RAW_TOO_LARGE');
      }
      return {
        ...base,
        kind: 'raw',
        entry: options.entry,
        base64: result.bytes.toString('base64'),
        sizeBytes: result.sizeBytes,
      };
    }
    return {
      ...base,
      kind: 'text',
      entry: options.entry,
      text: result.text,
      truncated: result.truncated,
      extractor: result.extractor,
    };
  }

  private resolveRequestedMailboxes(
    aliases: readonly string[] | undefined
  ): readonly MailboxConfig[] {
    if (!aliases) return this.config.mailboxes;

    const seen = new Set<string>();
    return aliases.map((alias) => {
      const mailbox = this.resolveMailbox(alias);
      if (seen.has(mailbox.alias)) {
        throw new UnknownMailboxAliasError(alias);
      }
      seen.add(mailbox.alias);
      return mailbox;
    });
  }

  private resolveMailbox(alias: string): MailboxConfig {
    const normalizedAlias = alias.trim().toLowerCase();
    const mailbox = this.config.mailboxesByAlias.get(normalizedAlias);
    if (!mailbox) throw new UnknownMailboxAliasError(normalizedAlias);
    return mailbox;
  }

  private assertBatch(ids: readonly string[]): void {
    if (ids.length > this.config.maxBatchSize) {
      throw new BatchLimitError(this.config.maxBatchSize);
    }
  }

  async moveMessages(
    alias: string,
    messageIds: readonly string[],
    destinationFolderId: string
  ): Promise<{ mailbox: string; results: readonly { id: string; success: boolean }[] }> {
    this.assertBatch(messageIds);
    const mailbox = this.resolveMailbox(alias);
    try {
      const raw = await this.createEmailService(mailbox.address).moveEmailsToFolder(
        [...messageIds],
        destinationFolderId
      );
      return { mailbox: mailbox.alias, results: redactBatchOutcomes(messageIds, raw) };
    } catch {
      throw new MailboxOperationError('message move');
    }
  }

  async copyMessages(
    alias: string,
    messageIds: readonly string[],
    destinationFolderId: string
  ): Promise<{ mailbox: string; results: readonly { id: string; success: boolean }[] }> {
    this.assertBatch(messageIds);
    const mailbox = this.resolveMailbox(alias);
    try {
      const raw = await this.createEmailService(mailbox.address).copyEmailsToFolder(
        [...messageIds],
        destinationFolderId
      );
      return { mailbox: mailbox.alias, results: redactBatchOutcomes(messageIds, raw) };
    } catch {
      throw new MailboxOperationError('message copy');
    }
  }

  async markMessages(
    alias: string,
    messageIds: readonly string[],
    read: boolean
  ): Promise<{ mailbox: string; results: readonly { id: string; success: boolean }[] }> {
    this.assertBatch(messageIds);
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);
    try {
      const raw = read
        ? await emailService.batchMarkAsRead([...messageIds])
        : await emailService.batchMarkAsUnread([...messageIds]);
      return { mailbox: mailbox.alias, results: redactBatchOutcomes(messageIds, raw) };
    } catch {
      throw new MailboxOperationError('message mark');
    }
  }

  async downloadAttachments(
    alias: string,
    messageId: string,
    attachmentIds?: readonly string[]
  ): Promise<{
    mailbox: string;
    totalFiles: number;
    successfulDownloads: number;
    failedDownloads: number;
  }> {
    if (attachmentIds) this.assertBatch(attachmentIds);
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);

    if (attachmentIds) {
      let successfulDownloads = 0;
      let failedDownloads = 0;
      for (const attachmentId of attachmentIds) {
        try {
          const outcome = await emailService.downloadAttachmentToFile(messageId, attachmentId, {});
          if (outcome.success) successfulDownloads += 1;
          else failedDownloads += 1;
        } catch {
          failedDownloads += 1;
        }
      }
      return {
        mailbox: mailbox.alias,
        totalFiles: attachmentIds.length,
        successfulDownloads,
        failedDownloads,
      };
    }

    try {
      const outcome = await emailService.downloadAllAttachmentsFromEmail(messageId, {});
      return {
        mailbox: mailbox.alias,
        totalFiles: outcome.totalFiles,
        successfulDownloads: outcome.successfulDownloads,
        failedDownloads: outcome.failedDownloads,
      };
    } catch {
      throw new MailboxOperationError('attachment download');
    }
  }

  async createDraftMessage(
    alias: string,
    draft: {
      to: readonly string[];
      cc?: readonly string[];
      bcc?: readonly string[];
      subject: string;
      body: string;
      attachmentPaths?: readonly string[];
    }
  ): Promise<{ mailbox: string; draftId: string; attachmentsCount: number }> {
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);
    try {
      const attachments = draft.attachmentPaths?.length
        ? await Promise.all(
            draft.attachmentPaths.map((path) => emailService.encodeFileForAttachment(path))
          )
        : undefined;
      const outcome = await emailService.createDraft(
        [...draft.to],
        draft.subject,
        draft.body,
        draft.cc ? [...draft.cc] : undefined,
        draft.bcc ? [...draft.bcc] : undefined,
        attachments,
        undefined
      );
      return {
        mailbox: mailbox.alias,
        draftId: outcome.draftId,
        attachmentsCount: outcome.attachmentsCount,
      };
    } catch {
      throw new MailboxOperationError('draft creation');
    }
  }

  async searchMailboxesBatch(
    queries: readonly {
      label: string;
      mailboxes?: readonly string[];
      criteria: AdvancedSearchOptions & { expandTerms?: boolean };
    }[]
  ): Promise<{
    results: readonly {
      label: string;
      status: SearchStatus;
      results: readonly MailboxSearchResult[];
    }[];
  }> {
    if (queries.length > this.config.maxQueriesPerBatch) {
      throw new BatchLimitError(this.config.maxQueriesPerBatch);
    }
    const results = [];
    for (const query of queries) {
      const outcome = await this.searchMailboxes(query.mailboxes, query.criteria);
      results.push({ label: query.label, status: outcome.status, results: outcome.results });
    }
    return { results };
  }

  private async searchResolvedMailbox(
    mailbox: MailboxConfig,
    criteria: AdvancedSearchOptions & { expandTerms?: boolean }
  ): Promise<MailboxSearchResult> {
    const { expandTerms, ...searchCriteria } = criteria;
    const deterministic = !searchCriteria.query;
    const resultCeiling = deterministic ? 100 : 50;
    const maxResults = Math.min(
      searchCriteria.maxResults ?? this.config.maxResultsPerMailbox,
      this.config.maxResultsPerMailbox,
      resultCeiling
    );
    const scanLimit = deterministic ? Math.min(maxResults * 5, 500) : Math.min(maxResults * 3, 100);

    const terms =
      expandTerms && searchCriteria.query && this.searchMemory
        ? expandTerm(this.searchMemory, searchCriteria.query)
        : [searchCriteria.query].filter((term): term is string => Boolean(term));

    const runOne = async (term?: string): Promise<ReliableSearchResult<Message>> => {
      const emailService = this.createEmailService(mailbox.address);
      return emailService.advancedSearchEmailsDetailed({
        ...searchCriteria,
        query: term,
        maxResults,
        scanLimit,
        includeFullContent: false,
      });
    };

    try {
      if (terms.length <= 1) {
        const evidence = await runOne(terms[0]);
        const warnings =
          expandTerms && !this.searchMemory
            ? [...evidence.warnings, 'search_memory_not_configured']
            : evidence.warnings;
        return { mailbox: mailbox.alias, ...evidence, warnings };
      }

      const merged = new Map<string, Message>();
      let aggregate: ReliableSearchResult<Message> | undefined;
      for (const term of terms) {
        const evidence = await runOne(term);
        for (const message of evidence.messages) {
          if (message.id) merged.set(String(message.id), message);
        }
        aggregate = aggregate ? mergeEvidence(aggregate, evidence) : evidence;
      }
      return {
        mailbox: mailbox.alias,
        ...aggregate!,
        messages: [...merged.values()].slice(0, maxResults),
        expandedTerms: terms,
      };
    } catch {
      return redactedFailedSearch(mailbox.alias);
    }
  }
}

function redactBatchOutcomes(
  ids: readonly string[],
  raw: readonly { success?: boolean }[]
): readonly { id: string; success: boolean }[] {
  return ids.map((id, index) => ({ id, success: raw[index]?.success !== false }));
}

function mergeEvidence(
  a: ReliableSearchResult<Message>,
  b: ReliableSearchResult<Message>
): ReliableSearchResult<Message> {
  return {
    status: aggregateSearchStatus([
      { mailbox: '', ...a },
      { mailbox: '', ...b },
    ]),
    strategy: a.strategy,
    confidence: a.confidence === 'high' && b.confidence === 'high' ? 'high' : 'medium',
    messages: [...a.messages, ...b.messages],
    pagesScanned: a.pagesScanned + b.pagesScanned,
    candidatesScanned: a.candidatesScanned + b.candidatesScanned,
    truncated: a.truncated || b.truncated,
    canaryMatched: a.canaryMatched || b.canaryMatched,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
  };
}

function aggregateSearchStatus(results: readonly MailboxSearchResult[]): SearchStatus {
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has('SEARCH_FAILED')) return 'SEARCH_FAILED';
  if (statuses.has('SEARCH_UNTRUSTED')) return 'SEARCH_UNTRUSTED';
  if (statuses.has('SEARCH_INCOMPLETE')) return 'SEARCH_INCOMPLETE';
  if (statuses.has('FOUND')) return 'FOUND';
  return 'NOT_FOUND';
}

function redactedFailedSearch(mailbox: string): MailboxSearchResult {
  const evidence: ReliableSearchResult<Message> = {
    status: 'SEARCH_FAILED',
    strategy: 'local_scan',
    confidence: 'low',
    messages: [],
    pagesScanned: 0,
    candidatesScanned: 0,
    truncated: true,
    canaryMatched: false,
    warnings: ['mailbox_search_failed'],
  };
  return { mailbox, ...evidence };
}
