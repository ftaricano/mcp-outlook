import { createHash } from 'node:crypto';
import type { Message } from '@microsoft/microsoft-graph-types';
import type { AdvancedSearchOptions, EmailService } from '../services/emailService.js';
import type { ReliableSearchResult, SearchStatus } from '../services/reliableSearch.js';
import type { PluginConfig, MailboxConfig } from './config.js';
import {
  AttachmentHandoffError,
  AttachmentHandoffStore,
  type AttachmentHandoffManifest,
} from './attachmentHandoffStore.js';
import type {
  InspectAttachmentEvidenceInput,
  InvestigateDocumentsCriteria,
  MailboxSearchResult,
  MultiMailboxSearchResult,
} from './schemas.js';
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
  | 'listFoldersDetailed'
  | 'getFolderStatistics'
  | 'listAttachments'
  | 'listAttachmentsDetailed'
  | 'downloadAttachment'
  | 'downloadAttachmentToFile'
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

export class BatchResourceLimitError extends Error {
  constructor(resource: string, limit: number) {
    super(`Batch ${resource} budget exceeded (${limit})`);
    this.name = 'BatchResourceLimitError';
  }
}

export class DownloadLimitError extends Error {
  constructor(limit: number) {
    super(`Requested attachments exceed the server download limit of ${limit} bytes`);
    this.name = 'DownloadLimitError';
  }
}

export type AttachmentDownloadErrorCode =
  'BYTE_BUDGET_EXCEEDED' | 'FILE_WRITE_FAILED' | 'DOWNLOAD_FAILED' | 'INVALID_RESULT';

export interface AttachmentDownloadReceipt {
  readonly attachmentId: string;
  readonly status: 'saved' | 'failed';
  readonly filename?: string;
  readonly relativePath?: string;
  readonly sizeBytes: number;
  readonly errorCode?: AttachmentDownloadErrorCode;
}

function isSafeDownloadReceiptPath(filename: unknown, relativePath: unknown): boolean {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0')) {
    return false;
  }
  const segments = relativePath.split('/');
  return (
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    segments.at(-1) === filename
  );
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
  readonly hiddenEntries?: number;
}

interface ListedAttachment {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly contentType?: string | null;
  readonly size?: number | null;
  readonly isInline?: boolean | null;
  readonly attachmentType?: string | null;
}

export type InvestigationFolder = InvestigateDocumentsCriteria['folders'][number];
export type InvestigationStatus =
  'CONFIRMED' | 'CANDIDATE_REVIEW' | 'NOT_FOUND' | 'SEARCH_INCOMPLETE';
export type InvestigationMatchClassification = 'CONFIRMED' | 'CANDIDATE_REVIEW';
export type InvestigationFolderStatus = 'COMPLETE' | 'INCOMPLETE' | 'FAILED';
export type InvestigationCoverageReason =
  | 'MESSAGE_SCAN_LIMIT_REACHED'
  | 'MESSAGE_SCAN_FAILED'
  | 'MESSAGE_TEXT_TRUNCATED'
  | 'ATTACHMENT_SCAN_LIMIT_REACHED'
  | 'ATTACHMENT_SCAN_FAILED'
  | 'ATTACHMENT_NAME_INVALID'
  | 'ATTACHMENT_NAME_TRUNCATED'
  | 'MESSAGE_ID_MISSING'
  | 'FOLDER_NOT_SCANNED';
export type InvestigationConfirmationReason =
  'PROPOSAL_ID_IN_ATTACHMENT_NAME' | 'REQUESTED_ATTACHMENT_NAME_MATCH';

export interface InvestigationFolderCoverage {
  readonly folder: InvestigationFolder;
  readonly status: InvestigationFolderStatus;
  readonly pagesScanned: number;
  readonly messagesScanned: number;
  readonly attachmentListsAttempted: number;
  readonly attachmentListsCompleted: number;
  readonly attachmentPagesScanned: number;
  readonly reasons: readonly InvestigationCoverageReason[];
}

export interface InvestigationMatch {
  readonly folder: InvestigationFolder;
  readonly classification: InvestigationMatchClassification;
  readonly message: InvestigationMessage;
  readonly matchedSignals: {
    readonly proposalIds: readonly string[];
    readonly clients: readonly string[];
    readonly insurers: readonly string[];
    readonly attachmentNames: readonly string[];
  };
  readonly confirmationReasons: readonly InvestigationConfirmationReason[];
}

export interface InvestigationMessage extends Message {
  readonly attachmentCount?: number;
  readonly attachmentsTruncated?: boolean;
  readonly attachmentNamesTruncated?: boolean;
}

export interface InvestigateDocumentsResult {
  readonly mailbox: string;
  readonly status: InvestigationStatus;
  readonly matches: readonly InvestigationMatch[];
  readonly totalMatches: number;
  readonly matchesTruncated: boolean;
  readonly coverage: {
    readonly complete: boolean;
    readonly folders: readonly InvestigationFolderCoverage[];
    readonly limits: {
      readonly maxPagesPerFolder: number;
      readonly maxMessagesPerFolder: number;
      readonly maxAttachmentPagesPerMessage: number;
      readonly maxAttachmentsPerMessage: number;
      readonly maxResults: number;
    };
  };
}

export type AttachmentEvidenceStatus =
  'CONFIRMED' | 'CANDIDATE_REVIEW' | 'NOT_CONFIRMED' | 'VALIDATION_INCOMPLETE';

export type AttachmentEvidenceReason =
  | 'ATTACHMENT_LIST_FAILED'
  | 'ATTACHMENT_LIST_INCOMPLETE'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_ID_DUPLICATE'
  | 'ATTACHMENT_METADATA_INVALID'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TYPE_UNSUPPORTED'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOAD_METADATA_INVALID'
  | 'BASE64_INVALID'
  | 'SIZE_MISMATCH'
  | 'UNSUPPORTED_FORMAT'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_TIMEOUT'
  | 'EXTRACTION_TRUNCATED'
  | 'EXTRACTION_EMPTY';

export type AttachmentEvidenceConfirmationReason =
  'PROPOSAL_ID_IN_ATTACHMENT_NAME' | 'REQUESTED_ATTACHMENT_NAME_AND_IDENTITY_IN_TEXT';

export interface AttachmentEvidenceResult {
  readonly mailbox: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly status: AttachmentEvidenceStatus;
  readonly attachment: {
    readonly id?: string;
    readonly name?: string;
    readonly contentType?: string;
    readonly declaredSizeBytes?: number;
    readonly actualSizeBytes?: number;
    readonly sha256?: string;
    readonly extractor?: 'pdf' | 'xlsx' | 'docx' | 'text';
  };
  readonly matchedSignals: {
    readonly proposalIds: readonly string[];
    readonly clients: readonly string[];
    readonly insurers: readonly string[];
    readonly attachmentNames: readonly string[];
  };
  readonly confirmationReasons: readonly AttachmentEvidenceConfirmationReason[];
  readonly reasons: readonly AttachmentEvidenceReason[];
  readonly coverage: {
    readonly complete: boolean;
    readonly listing: {
      readonly pagesScanned: number;
      readonly itemsScanned: number;
      readonly complete: boolean;
    };
    readonly download: {
      readonly attempted: boolean;
      readonly decoded: boolean;
    };
    readonly extraction: {
      readonly attempted: boolean;
      readonly complete: boolean;
      readonly supported: boolean;
      readonly truncated?: boolean;
    };
  };
}

const INVESTIGATION_FOLDER_ORDER = ['inbox', 'sentitems', 'archive'] as const;
const INVESTIGATION_FOLDERS = new Set<InvestigationFolder>(INVESTIGATION_FOLDER_ORDER);
const MAX_INVESTIGATION_ATTACHMENT_NAME_CHARS = 300;
const MAX_INVESTIGATION_MATCH_TEXT_CHARS = 65_536;
const MAX_INVESTIGATION_MATCH_NAME_CHARS = 4_096;
const FILE_ATTACHMENT_TYPE = '#microsoft.graph.fileAttachment';
const MAX_ATTACHMENT_EVIDENCE_PAGES = 20;

function isInvestigationFolder(value: string): value is InvestigationFolder {
  return INVESTIGATION_FOLDERS.has(value as InvestigationFolder);
}

function boundedInvestigationText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const input = value.length > maxChars * 4 ? value.slice(0, maxChars * 4) : value;
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars && input.length === value.length
    ? normalized
    : `${normalized.slice(0, maxChars)}...`;
}

function safeCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeInvestigationSignal(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function investigationTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/gu)
    .filter(Boolean);
}

interface InvestigationTextMatcher {
  includes(signal: string): boolean;
}

interface CompactMatcherNode {
  readonly next: Map<string, number>;
  fail: number;
  readonly outputs: string[];
}

interface InvestigationAhoAutomaton {
  readonly nodes: readonly CompactMatcherNode[];
  readonly patternCount: number;
}

interface InvestigationSignalAutomata {
  readonly separator: string;
  readonly token: InvestigationAhoAutomaton | undefined;
  readonly compact: InvestigationAhoAutomaton | undefined;
}

function buildAhoAutomaton(patterns: readonly string[]): InvestigationAhoAutomaton | undefined {
  const uniquePatterns = [...new Set(patterns)].filter(Boolean);
  if (uniquePatterns.length === 0) return undefined;

  const nodes: CompactMatcherNode[] = [
    {
      next: new Map(),
      fail: 0,
      outputs: [],
    },
  ];
  for (const pattern of uniquePatterns) {
    let nodeIndex = 0;
    for (let characterIndex = 0; characterIndex < pattern.length; characterIndex += 1) {
      const character = pattern[characterIndex];
      const existing = nodes[nodeIndex].next.get(character);
      if (existing !== undefined) {
        nodeIndex = existing;
        continue;
      }
      const nextIndex = nodes.length;
      nodes[nodeIndex].next.set(character, nextIndex);
      nodes.push({ next: new Map(), fail: 0, outputs: [] });
      nodeIndex = nextIndex;
    }
    nodes[nodeIndex].outputs.push(pattern);
  }

  const queue: number[] = [];
  for (const child of nodes[0].next.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeIndex = queue[cursor];
    for (const [character, child] of nodes[nodeIndex].next) {
      queue.push(child);
      let failure = nodes[nodeIndex].fail;
      while (failure !== 0 && !nodes[failure].next.has(character)) {
        failure = nodes[failure].fail;
      }
      nodes[child].fail = nodes[failure].next.get(character) ?? 0;
      nodes[child].outputs.push(...nodes[nodes[child].fail].outputs);
    }
  }

  return { nodes, patternCount: uniquePatterns.length };
}

function scanAhoAutomaton(
  automaton: InvestigationAhoAutomaton | undefined,
  text: string,
  boundaryOffsets?: Uint8Array
): ReadonlySet<string> {
  if (!automaton || text.length === 0) return new Set();

  const matches = new Set<string>();
  const { nodes } = automaton;
  let nodeIndex = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];
    while (nodeIndex !== 0 && !nodes[nodeIndex].next.has(character)) {
      nodeIndex = nodes[nodeIndex].fail;
    }
    nodeIndex = nodes[nodeIndex].next.get(character) ?? 0;
    for (const pattern of nodes[nodeIndex].outputs) {
      const start = offset - pattern.length + 1;
      if (
        start >= 0 &&
        (!boundaryOffsets || (boundaryOffsets[start] === 1 && boundaryOffsets[offset + 1] === 1))
      ) {
        matches.add(pattern);
      }
    }
    if (matches.size === automaton.patternCount) break;
  }
  return matches;
}

function compileInvestigationSignalAutomata(
  signals: readonly string[]
): InvestigationSignalAutomata {
  const separator = '\u0001';
  const tokenSignalKeys = signals
    .map((signal) => {
      const signalTokens = investigationTokens(signal);
      return signalTokens.length > 0
        ? `${separator}${signalTokens.join(separator)}${separator}`
        : '';
    })
    .filter(Boolean);
  const compactSignalPatterns = signals.map(normalizeInvestigationSignal).filter(Boolean);
  return {
    separator,
    token: buildAhoAutomaton(tokenSignalKeys),
    compact: buildAhoAutomaton(compactSignalPatterns),
  };
}

function createInvestigationTextMatcher(
  haystack: string,
  automata: InvestigationSignalAutomata
): InvestigationTextMatcher {
  const tokens = investigationTokens(haystack);
  const { separator } = automata;
  const tokenKey = `${separator}${tokens.join(separator)}${separator}`;
  const compactText = tokens.join('');
  const boundaryOffsets = new Uint8Array(compactText.length + 1);
  let offset = 0;
  boundaryOffsets[0] = 1;
  for (const token of tokens) {
    offset += token.length;
    boundaryOffsets[offset] = 1;
  }
  const tokenMatches = scanAhoAutomaton(automata.token, tokenKey);
  const compactMatches = scanAhoAutomaton(automata.compact, compactText, boundaryOffsets);

  return {
    includes(signal: string): boolean {
      const signalTokens = investigationTokens(signal);
      if (signalTokens.length === 0) return false;

      const signalKey = `${separator}${signalTokens.join(separator)}${separator}`;
      if (tokenMatches.has(signalKey)) return true;

      const compactSignal = normalizeInvestigationSignal(signal);
      return compactSignal.length > 0 && compactMatches.has(compactSignal);
    },
  };
}

function investigationTokenSequenceIncludes(haystack: string, signal: string): boolean {
  return createInvestigationTextMatcher(
    haystack,
    compileInvestigationSignalAutomata([signal])
  ).includes(signal);
}

function investigationAttachmentContainsSignal(name: string, signal: string): boolean {
  return investigationTokenSequenceIncludes(name, signal);
}

function investigationAttachmentEqualsSignal(name: string, signal: string): boolean {
  if (name.length > MAX_INVESTIGATION_MATCH_NAME_CHARS) return false;
  const normalizedName = name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedSignal = signal.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return normalizedName.length > 0 && normalizedName === normalizedSignal;
}

function projectInvestigationAttachmentName(value: unknown): {
  name: string | undefined;
  nameTruncated: boolean;
} {
  if (typeof value !== 'string' || value.length === 0) {
    return { name: undefined, nameTruncated: false };
  }
  if (value.length <= MAX_INVESTIGATION_ATTACHMENT_NAME_CHARS) {
    return { name: value, nameTruncated: false };
  }
  return {
    name: `${value.slice(0, MAX_INVESTIGATION_ATTACHMENT_NAME_CHARS)}...`,
    nameTruncated: true,
  };
}

function projectInvestigationMessage(
  message: Message,
  attachments: readonly ListedAttachment[],
  attachmentsTruncated: boolean
): InvestigationMessage {
  const address = boundedInvestigationText(message.from?.emailAddress?.address, 320);
  const projectedAttachments = attachments.slice(0, 50).map((attachment) => {
    const projectedName = projectInvestigationAttachmentName(attachment.name);
    return {
      id: boundedInvestigationText(attachment.id, 512),
      name: projectedName.name,
      nameTruncated: projectedName.nameTruncated || undefined,
      contentType: boundedInvestigationText(attachment.contentType, 100),
      size:
        typeof attachment.size === 'number' && attachment.size >= 0 ? attachment.size : undefined,
      isInline: typeof attachment.isInline === 'boolean' ? attachment.isInline : undefined,
    };
  });
  const attachmentNamesTruncated = projectedAttachments.some(
    (attachment) => attachment.nameTruncated === true
  );
  const projected: InvestigationMessage = {
    id: boundedInvestigationText(message.id, 512),
    subject: boundedInvestigationText(message.subject, 300),
    receivedDateTime: boundedInvestigationText(message.receivedDateTime, 64),
    isRead: typeof message.isRead === 'boolean' ? message.isRead : undefined,
    hasAttachments:
      typeof message.hasAttachments === 'boolean' ? message.hasAttachments : undefined,
    bodyPreview: boundedInvestigationText(message.bodyPreview, 500),
    from: address ? { emailAddress: { address } } : undefined,
    attachments: projectedAttachments.length > 0 ? projectedAttachments : undefined,
    attachmentCount: attachments.length,
    attachmentsTruncated:
      attachmentsTruncated ||
      attachmentNamesTruncated ||
      attachments.length > projectedAttachments.length ||
      projectedAttachments.length > 30,
    attachmentNamesTruncated: attachmentNamesTruncated || undefined,
  };
  return projected;
}

function decodeGraphBase64(value: string, maxBytes: number): Buffer {
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedChars) {
    throw new AttachmentHandoffError('ATTACHMENT_TOO_LARGE');
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new AttachmentHandoffError('ATTACHMENT_FETCH_FAILED');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new AttachmentHandoffError('ATTACHMENT_FETCH_FAILED');
  }
  return decoded;
}

function decodeBoundedBase64(
  value: unknown,
  maxBytes: number
): { buffer?: Buffer; reason?: 'ATTACHMENT_TOO_LARGE' | 'BASE64_INVALID' } {
  if (typeof value !== 'string') return { reason: 'BASE64_INVALID' };
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedChars) return { reason: 'ATTACHMENT_TOO_LARGE' };
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return { reason: 'BASE64_INVALID' };
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maxBytes) return { reason: 'ATTACHMENT_TOO_LARGE' };
  if (decoded.toString('base64') !== value) return { reason: 'BASE64_INVALID' };
  return { buffer: decoded };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function sanitizeHandoffFilename(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .normalize('NFKC')
    .replace(/\.\.+/g, '_')
    .replace(/[\\/:\0-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const bounded = truncateUtf8(normalized, 240);
  return bounded && bounded !== '.' && bounded !== '..' ? bounded : 'attachment.bin';
}

function sanitizeContentType(value: string | null | undefined): string {
  const normalized = (value ?? '').replace(/[\0-\x1f\x7f]/g, '').trim();
  return truncateUtf8(normalized, 255) || 'application/octet-stream';
}

export class MultiMailboxService {
  private readonly handoffStore: AttachmentHandoffStore | null;

  constructor(
    private readonly config: PluginConfig,
    private readonly createEmailService: EmailServiceFactory,
    private readonly searchMemory: SearchMemory | null = null,
    handoffStore?: AttachmentHandoffStore
  ) {
    this.handoffStore = config.allowLocalHandoffs
      ? (handoffStore ??
        new AttachmentHandoffStore({
          maxAttachmentBytes: config.maxHandoffAttachmentBytes,
          maxStoreBytes: config.maxHandoffStoreBytes,
          maxStoreEntries: config.maxHandoffStoreEntries,
        }))
      : null;
  }

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

  async investigateDocuments(
    alias: string,
    criteria: InvestigateDocumentsCriteria
  ): Promise<InvestigateDocumentsResult> {
    const mailbox = this.resolveMailbox(alias);
    if (
      criteria.folders.length === 0 ||
      criteria.folders.some((folder) => !isInvestigationFolder(folder)) ||
      new Set(criteria.folders).size !== criteria.folders.length
    ) {
      throw new MailboxOperationError('document investigation');
    }

    const emailService = this.createEmailService(mailbox.address);
    const coverage: InvestigationFolderCoverage[] = [];
    const matches: InvestigationMatch[] = [];
    const investigationSignals = [
      ...criteria.proposalIds,
      ...criteria.clients,
      ...criteria.insurers,
      ...criteria.attachmentNames,
    ];
    const investigationSignalAutomata = compileInvestigationSignalAutomata(investigationSignals);

    for (const folder of criteria.folders) {
      const reasons: InvestigationCoverageReason[] = [];
      let pagesScanned = 0;
      let messagesScanned = 0;
      let attachmentListsAttempted = 0;
      let attachmentListsCompleted = 0;
      let attachmentPagesScanned = 0;

      let searchResult: ReliableSearchResult<Message>;
      try {
        searchResult = await emailService.advancedSearchEmailsDetailed({
          folder,
          query: undefined,
          includeFullContent: false,
          maxPages: criteria.maxPagesPerFolder,
          maxResults: criteria.maxMessagesPerFolder,
          scanLimit: criteria.maxMessagesPerFolder,
        });
      } catch {
        coverage.push({
          folder,
          status: 'FAILED',
          pagesScanned: 0,
          messagesScanned: 0,
          attachmentListsAttempted: 0,
          attachmentListsCompleted: 0,
          attachmentPagesScanned: 0,
          reasons: ['MESSAGE_SCAN_FAILED'],
        });
        continue;
      }

      pagesScanned = safeCount(searchResult.pagesScanned);
      messagesScanned = Math.max(
        safeCount(searchResult.candidatesScanned),
        Array.isArray(searchResult.messages) ? searchResult.messages.length : 0
      );
      if (searchResult.status === 'SEARCH_FAILED' || searchResult.status === 'SEARCH_UNTRUSTED') {
        reasons.push('MESSAGE_SCAN_FAILED');
      } else if (searchResult.truncated || searchResult.status === 'SEARCH_INCOMPLETE') {
        reasons.push('MESSAGE_SCAN_LIMIT_REACHED');
      }

      for (const message of searchResult.messages ?? []) {
        const messageId = typeof message.id === 'string' ? message.id.trim() : '';
        if (!messageId) {
          reasons.push('MESSAGE_ID_MISSING');
          continue;
        }

        let listedAttachments: ListedAttachment[] = [];
        let attachmentsTruncated = false;
        {
          attachmentListsAttempted += 1;
          try {
            const listing = await emailService.listAttachmentsDetailed(messageId, {
              maxItems: criteria.maxAttachmentsPerMessage,
              maxPages: criteria.maxAttachmentPagesPerMessage,
            });
            const rawItems = Array.isArray(listing.items) ? listing.items : [];
            const invalidAttachmentName = rawItems.some((attachment) => {
              if (!attachment || typeof attachment !== 'object') return true;
              const name = (attachment as { name?: unknown }).name;
              return typeof name !== 'string' || name.trim().length === 0;
            });
            const attachmentNameTruncated = rawItems.some(
              (attachment) =>
                Boolean(attachment) &&
                typeof attachment === 'object' &&
                typeof (attachment as { name?: unknown }).name === 'string' &&
                (attachment as { name: string }).name.length >
                  MAX_INVESTIGATION_ATTACHMENT_NAME_CHARS
            );
            listedAttachments = rawItems
              .filter(
                (attachment): attachment is ListedAttachment =>
                  Boolean(attachment) && typeof attachment === 'object'
              )
              .slice(0, criteria.maxAttachmentsPerMessage);
            attachmentPagesScanned += safeCount(listing.pagesScanned);
            if (invalidAttachmentName) reasons.push('ATTACHMENT_NAME_INVALID');
            if (attachmentNameTruncated) {
              reasons.push('ATTACHMENT_NAME_TRUNCATED');
            }
            if (listing.truncated || rawItems.length > criteria.maxAttachmentsPerMessage) {
              reasons.push('ATTACHMENT_SCAN_LIMIT_REACHED');
              attachmentsTruncated = true;
            }
            if (invalidAttachmentName) attachmentsTruncated = true;
            if (
              !listing.truncated &&
              rawItems.length <= criteria.maxAttachmentsPerMessage &&
              !invalidAttachmentName &&
              !attachmentNameTruncated
            ) {
              attachmentListsCompleted += 1;
            }
          } catch {
            reasons.push('ATTACHMENT_SCAN_FAILED');
            attachmentsTruncated = true;
          }
        }

        const attachmentNames = listedAttachments
          .map((attachment) => attachment.name)
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
        const metadataFields = [
          message.subject,
          message.bodyPreview,
          message.from?.emailAddress?.address,
        ]
          .filter((value): value is string => typeof value === 'string')
          .filter((value) => value.length > 0)
          .map((value) => {
            if (value.length <= MAX_INVESTIGATION_MATCH_TEXT_CHARS) return value;
            reasons.push('MESSAGE_TEXT_TRUNCATED');
            return value.slice(0, MAX_INVESTIGATION_MATCH_TEXT_CHARS);
          });
        const metadataMatchers = metadataFields.map((field) =>
          createInvestigationTextMatcher(field, investigationSignalAutomata)
        );
        const attachmentMatchers = attachmentNames.map((name) =>
          createInvestigationTextMatcher(
            name.slice(0, MAX_INVESTIGATION_MATCH_NAME_CHARS),
            investigationSignalAutomata
          )
        );
        const matchesMetadataSignal = (signal: string): boolean =>
          metadataMatchers.some((matcher) => matcher.includes(signal));
        const matchesAttachmentSignal = (signal: string): boolean =>
          attachmentMatchers.some((matcher) => matcher.includes(signal));
        const matchesAnySignal = (signal: string): boolean =>
          matchesMetadataSignal(signal) || matchesAttachmentSignal(signal);
        const matchedSignals = {
          proposalIds: criteria.proposalIds.filter(matchesAnySignal),
          clients: criteria.clients.filter(matchesAnySignal),
          insurers: criteria.insurers.filter(matchesAnySignal),
          attachmentNames: criteria.attachmentNames.filter((signal) =>
            attachmentNames.some((name) => investigationAttachmentEqualsSignal(name, signal))
          ),
        };

        const proposalInAttachment = criteria.proposalIds.some((proposalId) =>
          attachmentMatchers.some((matcher) => matcher.includes(proposalId))
        );
        const requestedAttachmentMatches = matchedSignals.attachmentNames.length > 0;
        const hasMatchedSignal =
          matchedSignals.proposalIds.length > 0 ||
          matchedSignals.clients.length > 0 ||
          matchedSignals.insurers.length > 0 ||
          matchedSignals.attachmentNames.length > 0;
        if (!hasMatchedSignal) continue;

        const confirmationReasons: InvestigationConfirmationReason[] = [];
        if (proposalInAttachment) confirmationReasons.push('PROPOSAL_ID_IN_ATTACHMENT_NAME');
        const identitySignalMatches =
          criteria.proposalIds.some(matchesMetadataSignal) ||
          criteria.clients.some(matchesMetadataSignal) ||
          criteria.insurers.some(matchesMetadataSignal);
        if (requestedAttachmentMatches && identitySignalMatches) {
          confirmationReasons.push('REQUESTED_ATTACHMENT_NAME_MATCH');
        }
        const isConfirmed = confirmationReasons.length > 0;

        matches.push({
          folder,
          classification: isConfirmed ? 'CONFIRMED' : 'CANDIDATE_REVIEW',
          message: projectInvestigationMessage(message, listedAttachments, attachmentsTruncated),
          matchedSignals,
          confirmationReasons,
        });
      }

      const uniqueReasons = [...new Set(reasons)];
      coverage.push({
        folder,
        status:
          uniqueReasons.includes('MESSAGE_SCAN_FAILED') ||
          uniqueReasons.includes('ATTACHMENT_SCAN_FAILED')
            ? 'FAILED'
            : uniqueReasons.length > 0
              ? 'INCOMPLETE'
              : 'COMPLETE',
        pagesScanned,
        messagesScanned,
        attachmentListsAttempted,
        attachmentListsCompleted,
        attachmentPagesScanned,
        reasons: uniqueReasons,
      });
    }

    const scannedCoverage = coverage;
    const coverageWithOmittedFolders: InvestigationFolderCoverage[] =
      INVESTIGATION_FOLDER_ORDER.map(
        (folder) =>
          scannedCoverage.find((entry) => entry.folder === folder) ?? {
            folder,
            status: 'INCOMPLETE',
            pagesScanned: 0,
            messagesScanned: 0,
            attachmentListsAttempted: 0,
            attachmentListsCompleted: 0,
            attachmentPagesScanned: 0,
            reasons: ['FOLDER_NOT_SCANNED'],
          }
      );
    const coverageComplete = coverageWithOmittedFolders.every(
      (entry) => entry.status === 'COMPLETE'
    );
    const orderedMatches = matches
      .map((match, index) => ({ match, index }))
      .sort((left, right) => {
        const leftRank = left.match.classification === 'CONFIRMED' ? 0 : 1;
        const rightRank = right.match.classification === 'CONFIRMED' ? 0 : 1;
        return leftRank - rightRank || left.index - right.index;
      })
      .map(({ match }) => match);
    const visibleMatches = orderedMatches.slice(0, criteria.maxResults);
    const matchesTruncated = orderedMatches.length > criteria.maxResults;
    const hasConfirmed = visibleMatches.some((match) => match.classification === 'CONFIRMED');
    const status: InvestigationStatus = hasConfirmed
      ? 'CONFIRMED'
      : !coverageComplete
        ? 'SEARCH_INCOMPLETE'
        : matches.length > 0
          ? 'CANDIDATE_REVIEW'
          : 'NOT_FOUND';

    return {
      mailbox: mailbox.alias,
      status,
      matches: visibleMatches,
      totalMatches: orderedMatches.length,
      matchesTruncated,
      coverage: {
        complete: coverageComplete,
        folders: coverageWithOmittedFolders,
        limits: {
          maxPagesPerFolder: criteria.maxPagesPerFolder,
          maxMessagesPerFolder: criteria.maxMessagesPerFolder,
          maxAttachmentPagesPerMessage: criteria.maxAttachmentPagesPerMessage,
          maxAttachmentsPerMessage: criteria.maxAttachmentsPerMessage,
          maxResults: criteria.maxResults,
        },
      },
    };
  }

  async inspectAttachmentEvidence(
    alias: string,
    messageId: string,
    attachmentId: string,
    criteria: Omit<InspectAttachmentEvidenceInput, 'mailbox' | 'messageId' | 'attachmentId'>
  ): Promise<AttachmentEvidenceResult> {
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);
    const matchedSignals = {
      proposalIds: [] as string[],
      clients: [] as string[],
      insurers: [] as string[],
      attachmentNames: [] as string[],
    };
    const confirmationReasons: AttachmentEvidenceConfirmationReason[] = [];
    const reasons: AttachmentEvidenceReason[] = [];
    const listingCoverage = {
      pagesScanned: 0,
      itemsScanned: 0,
      complete: false,
    };
    const downloadCoverage = { attempted: false, decoded: false };
    const extractionCoverage: {
      attempted: boolean;
      complete: boolean;
      supported: boolean;
      truncated?: boolean;
    } = {
      attempted: false,
      complete: false,
      supported: false,
    };
    let metadata: {
      id?: string;
      name?: string;
      contentType?: string;
      declaredSizeBytes?: number;
      extractor?: 'pdf' | 'xlsx' | 'docx' | 'text';
      actualSizeBytes?: number;
      sha256?: string;
    } = { id: attachmentId };

    const result = (status: AttachmentEvidenceStatus): AttachmentEvidenceResult => ({
      mailbox: mailbox.alias,
      messageId,
      attachmentId,
      status,
      attachment: metadata,
      matchedSignals,
      confirmationReasons,
      reasons: [...new Set(reasons)],
      coverage: {
        complete:
          listingCoverage.complete &&
          ((status === 'NOT_CONFIRMED' && reasons.includes('ATTACHMENT_NOT_FOUND')) ||
            (downloadCoverage.decoded && extractionCoverage.complete && reasons.length === 0)),
        listing: { ...listingCoverage },
        download: { ...downloadCoverage },
        extraction: { ...extractionCoverage },
      },
    });

    let listing: { items: unknown[]; pagesScanned: number; truncated: boolean };
    try {
      listing = await emailService.listAttachmentsDetailed(messageId, {
        maxItems: this.config.maxBatchSize + 1,
        maxPages: MAX_ATTACHMENT_EVIDENCE_PAGES,
      });
    } catch {
      reasons.push('ATTACHMENT_LIST_FAILED');
      return result('VALIDATION_INCOMPLETE');
    }

    if (
      !Array.isArray(listing.items) ||
      !Number.isSafeInteger(listing.pagesScanned) ||
      listing.pagesScanned < 1 ||
      listing.pagesScanned > MAX_ATTACHMENT_EVIDENCE_PAGES ||
      typeof listing.truncated !== 'boolean'
    ) {
      reasons.push('ATTACHMENT_LIST_FAILED');
      return result('VALIDATION_INCOMPLETE');
    }
    const listed = listing.items as ListedAttachment[];
    const hasMalformedAttachmentId = listed.some((attachment) => {
      if (!attachment || typeof attachment !== 'object') return true;
      const id = (attachment as { id?: unknown }).id;
      return typeof id !== 'string' || id.length === 0 || id.length > 512;
    });
    if (hasMalformedAttachmentId) {
      reasons.push('ATTACHMENT_LIST_FAILED');
      return result('VALIDATION_INCOMPLETE');
    }
    listingCoverage.pagesScanned = safeCount(listing.pagesScanned);
    listingCoverage.itemsScanned = listed.length;
    if (listing.truncated || listed.length > this.config.maxBatchSize) {
      reasons.push('ATTACHMENT_LIST_INCOMPLETE');
      return result('VALIDATION_INCOMPLETE');
    }
    listingCoverage.complete = true;

    const matches = listed.filter((attachment) => attachment.id === attachmentId);
    if (matches.length === 0) {
      reasons.push('ATTACHMENT_NOT_FOUND');
      return result('NOT_CONFIRMED');
    }
    if (matches.length !== 1) {
      reasons.push('ATTACHMENT_ID_DUPLICATE');
      return result('VALIDATION_INCOMPLETE');
    }

    const listedAttachment = matches[0];
    const name = typeof listedAttachment.name === 'string' ? listedAttachment.name : undefined;
    const contentType =
      typeof listedAttachment.contentType === 'string'
        ? listedAttachment.contentType.trim()
        : undefined;
    const declaredSize = listedAttachment.size;
    metadata = {
      id: typeof listedAttachment.id === 'string' ? listedAttachment.id.slice(0, 512) : undefined,
      name: boundedInvestigationText(name, 300),
      contentType: boundedInvestigationText(contentType, 100),
      declaredSizeBytes:
        typeof declaredSize === 'number' && Number.isSafeInteger(declaredSize)
          ? declaredSize
          : undefined,
    };

    if (
      !name ||
      name.length > 4_096 ||
      !contentType ||
      !Number.isSafeInteger(declaredSize) ||
      (declaredSize as number) < 0
    ) {
      reasons.push('ATTACHMENT_METADATA_INVALID');
      return result('VALIDATION_INCOMPLETE');
    }
    if ((declaredSize as number) > this.config.maxAttachmentInputBytes) {
      reasons.push('ATTACHMENT_TOO_LARGE');
      return result('VALIDATION_INCOMPLETE');
    }
    if (listedAttachment.attachmentType !== FILE_ATTACHMENT_TYPE) {
      reasons.push('ATTACHMENT_TYPE_UNSUPPORTED');
      return result('VALIDATION_INCOMPLETE');
    }

    let downloaded: {
      name?: unknown;
      contentType?: unknown;
      content?: unknown;
      size?: unknown;
      attachmentType?: unknown;
    };
    downloadCoverage.attempted = true;
    try {
      downloaded = await emailService.downloadAttachment(messageId, attachmentId);
    } catch {
      reasons.push('DOWNLOAD_FAILED');
      return result('VALIDATION_INCOMPLETE');
    }

    const downloadedName = typeof downloaded.name === 'string' ? downloaded.name : undefined;
    const downloadedContentType =
      typeof downloaded.contentType === 'string' ? downloaded.contentType.trim() : undefined;
    if (
      !downloadedName ||
      !downloadedContentType ||
      !investigationAttachmentEqualsSignal(downloadedName, name) ||
      downloadedContentType.toLowerCase() !== contentType.toLowerCase() ||
      downloaded.attachmentType !== FILE_ATTACHMENT_TYPE
    ) {
      reasons.push('DOWNLOAD_METADATA_INVALID');
      return result('VALIDATION_INCOMPLETE');
    }

    const decoded = decodeBoundedBase64(downloaded.content, this.config.maxAttachmentInputBytes);
    if (!decoded.buffer) {
      reasons.push(
        decoded.reason === 'ATTACHMENT_TOO_LARGE' ? 'ATTACHMENT_TOO_LARGE' : 'BASE64_INVALID'
      );
      return result('VALIDATION_INCOMPLETE');
    }
    downloadCoverage.decoded = true;
    metadata = {
      ...metadata,
      actualSizeBytes: decoded.buffer.length,
      sha256: createHash('sha256').update(decoded.buffer).digest('hex'),
    };
    if (decoded.buffer.length !== declaredSize) {
      reasons.push('SIZE_MISMATCH');
      return result('VALIDATION_INCOMPLETE');
    }
    if (
      downloaded.size !== undefined &&
      (!Number.isSafeInteger(downloaded.size) || downloaded.size !== decoded.buffer.length)
    ) {
      reasons.push('SIZE_MISMATCH');
      return result('VALIDATION_INCOMPLETE');
    }

    extractionCoverage.attempted = true;
    let extracted: Awaited<ReturnType<typeof runAttachmentPipeline>>;
    try {
      extracted = await runAttachmentPipeline({
        buffer: decoded.buffer,
        name,
        contentType,
        maxChars: this.config.maxExtractedChars,
        mode: 'text',
        zipLimits: {
          maxEntries: this.config.maxZipEntries,
          maxUncompressedBytes: this.config.maxZipUncompressedBytes,
        },
        containerLimits: {
          maxEntries: this.config.maxContainerEntries,
          maxUncompressedBytes: this.config.maxContainerUncompressedBytes,
        },
        maxConcurrentExtractions: this.config.maxConcurrentExtractions,
      });
    } catch (error) {
      if (error instanceof ExtractionError) {
        if (error.code === 'UNSUPPORTED_FORMAT') reasons.push('UNSUPPORTED_FORMAT');
        else if (error.code === 'EXTRACTION_TIMEOUT') reasons.push('EXTRACTION_TIMEOUT');
        else reasons.push('EXTRACTION_FAILED');
      } else if (error instanceof ZipError) {
        reasons.push('EXTRACTION_FAILED');
      } else {
        reasons.push('EXTRACTION_FAILED');
      }
      return result('VALIDATION_INCOMPLETE');
    }

    if (extracted.kind !== 'text') {
      reasons.push('UNSUPPORTED_FORMAT');
      return result('VALIDATION_INCOMPLETE');
    }
    extractionCoverage.supported = true;
    extractionCoverage.truncated = extracted.truncated;
    if (extracted.truncated) {
      reasons.push('EXTRACTION_TRUNCATED');
      return result('VALIDATION_INCOMPLETE');
    }
    if (!extracted.text.trim()) {
      reasons.push('EXTRACTION_EMPTY');
      return result('VALIDATION_INCOMPLETE');
    }
    extractionCoverage.complete = true;
    metadata = { ...metadata, extractor: extracted.extractor };

    const textMatcher = createInvestigationTextMatcher(
      extracted.text,
      compileInvestigationSignalAutomata([
        ...criteria.proposalIds,
        ...criteria.clients,
        ...criteria.insurers,
      ])
    );
    const proposalIdsInName = criteria.proposalIds.filter((signal) =>
      investigationAttachmentContainsSignal(name, signal)
    );
    const clientsInText = criteria.clients.filter((signal) => textMatcher.includes(signal));
    const insurersInText = criteria.insurers.filter((signal) => textMatcher.includes(signal));
    const proposalIdsInText = criteria.proposalIds.filter((signal) => textMatcher.includes(signal));
    const attachmentNamesMatched = criteria.attachmentNames.filter((signal) =>
      investigationAttachmentEqualsSignal(name, signal)
    );
    matchedSignals.proposalIds = [...new Set([...proposalIdsInName, ...proposalIdsInText])];
    matchedSignals.clients = clientsInText;
    matchedSignals.insurers = insurersInText;
    matchedSignals.attachmentNames = attachmentNamesMatched;

    if (proposalIdsInName.length > 0) {
      confirmationReasons.push('PROPOSAL_ID_IN_ATTACHMENT_NAME');
    }
    if (
      attachmentNamesMatched.length > 0 &&
      (proposalIdsInText.length > 0 || clientsInText.length > 0 || insurersInText.length > 0)
    ) {
      confirmationReasons.push('REQUESTED_ATTACHMENT_NAME_AND_IDENTITY_IN_TEXT');
    }

    const hasMatch =
      matchedSignals.proposalIds.length > 0 ||
      matchedSignals.clients.length > 0 ||
      matchedSignals.insurers.length > 0 ||
      matchedSignals.attachmentNames.length > 0;
    const status =
      confirmationReasons.length > 0
        ? 'CONFIRMED'
        : hasMatch
          ? 'CANDIDATE_REVIEW'
          : 'NOT_CONFIRMED';
    return result(status);
  }

  async listFolders(alias: string): Promise<{ items: unknown[]; truncated: boolean }> {
    const mailbox = this.resolveMailbox(alias);
    try {
      return await this.createEmailService(mailbox.address).listFoldersDetailed(true, 3);
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

  async listAttachments(
    alias: string,
    messageId: string
  ): Promise<{ items: unknown[]; pagesScanned: number; truncated: boolean }> {
    const mailbox = this.resolveMailbox(alias);
    try {
      return await this.createEmailService(mailbox.address).listAttachmentsDetailed(messageId);
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
    // Deliberately not zipLimits: those cap a user-facing .zip attachment,
    // while these cap the internal parts of an xlsx/docx. Reusing the archive
    // caps here made a legitimate many-sheet workbook fail the pre-check.
    const containerLimits = {
      maxEntries: this.config.maxContainerEntries,
      maxUncompressedBytes: this.config.maxContainerUncompressedBytes,
    };

    // Decryption, inflation and document parsing happen only inside the
    // isolated worker (extractionWorker.ts) — nothing here touches
    // zipArchive.ts or a parser directly. runAttachmentPipeline resolves a
    // plain raw attachment in place, since returning bytes we already hold
    // needs neither. That worker isolation bounds the event loop and one
    // worker's V8 heap, not native/Buffer memory and not process privileges;
    // the size guarantees are maxAttachmentInputBytes above, the raw cap
    // passed below, the ZIP caps, and the concurrency gate (extractors.ts).
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
        containerLimits,
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
      return {
        ...base,
        kind: 'zip_listing',
        zipEntries: result.zipEntries,
        hiddenEntries: result.hiddenEntries,
      };
    }
    if (result.kind === 'raw') {
      // Redundant, cheap defense-in-depth: runAttachmentPipeline already
      // enforced this cap where the bytes were produced — in the caller for a
      // plain attachment, inside the worker for a ZIP entry.
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

  async createAttachmentHandoff(
    alias: string,
    messageId: string,
    attachmentId: string,
    idempotencyKey: string
  ): Promise<AttachmentHandoffManifest> {
    if (!this.handoffStore) throw new AttachmentHandoffError('HANDOFF_DISABLED');
    const mailbox = this.resolveMailbox(alias);
    const replay = await this.handoffStore.findReplay({
      mailbox: mailbox.alias,
      messageId,
      attachmentId,
      idempotencyKey,
    });
    if (replay) return replay;
    const emailService = this.createEmailService(mailbox.address);

    let listing: { items: unknown[]; truncated: boolean };
    try {
      listing = await emailService.listAttachmentsDetailed(messageId, {
        maxItems: this.config.maxBatchSize,
        maxPages: 20,
      });
    } catch {
      throw new AttachmentHandoffError('ATTACHMENT_FETCH_FAILED');
    }
    if (listing.truncated) {
      throw new AttachmentHandoffError('ATTACHMENT_LIST_INCOMPLETE');
    }

    const matches = (listing.items as ListedAttachment[]).filter(
      (attachment) => attachment.id === attachmentId
    );
    if (matches.length === 0) throw new AttachmentHandoffError('ATTACHMENT_NOT_FOUND');
    if (matches.length !== 1) throw new AttachmentHandoffError('ATTACHMENT_METADATA_INVALID');
    const metadata = matches[0];
    if (!Number.isSafeInteger(metadata.size) || (metadata.size ?? -1) < 0) {
      throw new AttachmentHandoffError('ATTACHMENT_METADATA_INVALID');
    }
    if ((metadata.size as number) > this.config.maxHandoffAttachmentBytes) {
      throw new AttachmentHandoffError('ATTACHMENT_TOO_LARGE');
    }

    let downloaded: { name: string; contentType: string; content: string };
    try {
      downloaded = await emailService.downloadAttachment(messageId, attachmentId);
    } catch {
      throw new AttachmentHandoffError('ATTACHMENT_FETCH_FAILED');
    }
    const payload = decodeGraphBase64(downloaded.content, this.config.maxHandoffAttachmentBytes);
    if (payload.length > this.config.maxHandoffAttachmentBytes) {
      throw new AttachmentHandoffError('ATTACHMENT_TOO_LARGE');
    }

    return this.handoffStore.create(
      {
        mailbox: mailbox.alias,
        messageId,
        attachmentId,
        idempotencyKey,
        filename: sanitizeHandoffFilename(downloaded.name || metadata.name),
        contentType: sanitizeContentType(downloaded.contentType || metadata.contentType),
      },
      payload
    );
  }

  async getAttachmentHandoff(handoffId: string): Promise<AttachmentHandoffManifest> {
    if (!this.handoffStore) throw new AttachmentHandoffError('HANDOFF_DISABLED');
    return this.handoffStore.get(handoffId);
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
    downloadedBytes: number;
    byteLimit: number;
    files: readonly AttachmentDownloadReceipt[];
  }> {
    const mailbox = this.resolveMailbox(alias);
    const emailService = this.createEmailService(mailbox.address);

    try {
      const listing = await emailService.listAttachmentsDetailed(messageId, {
        maxItems: this.config.maxBatchSize + 1,
        maxPages: 20,
      });
      const listed = listing.items as {
        id?: string | null;
        size?: number | null;
      }[];
      if (listing.truncated || listed.length > this.config.maxBatchSize) {
        throw new BatchLimitError(this.config.maxBatchSize);
      }
      const byId = new Map(
        listed
          .filter((attachment): attachment is { id: string; size?: number | null } =>
            Boolean(attachment.id)
          )
          .map((attachment) => [attachment.id, attachment] as const)
      );
      if (!attachmentIds && byId.size !== listed.length) {
        throw new DownloadLimitError(this.config.maxDownloadBatchBytes);
      }
      const requestedIds = attachmentIds ? [...attachmentIds] : [...byId.keys()];
      this.assertBatch(requestedIds);

      const requested = requestedIds.map((attachmentId) => {
        const metadata = byId.get(attachmentId);
        if (!metadata || !Number.isSafeInteger(metadata.size) || (metadata.size ?? -1) < 0) {
          throw new DownloadLimitError(this.config.maxDownloadBatchBytes);
        }
        return { id: attachmentId, size: metadata.size as number };
      });
      const declaredBytes = requested.reduce((total, attachment) => total + attachment.size, 0);
      if (declaredBytes > this.config.maxDownloadBatchBytes) {
        throw new DownloadLimitError(this.config.maxDownloadBatchBytes);
      }

      let downloadedBytes = 0;
      const files: AttachmentDownloadReceipt[] = [];
      for (const attachment of requested) {
        try {
          const outcome = await emailService.downloadAttachmentToFile(messageId, attachment.id, {
            maxBytes: this.config.maxDownloadBatchBytes - downloadedBytes,
          });
          if (outcome.success) {
            const remainingBytes = this.config.maxDownloadBatchBytes - downloadedBytes;
            if (
              !Number.isSafeInteger(outcome.savedSize) ||
              outcome.savedSize < 0 ||
              outcome.savedSize > remainingBytes ||
              !isSafeDownloadReceiptPath(outcome.filename, outcome.relativePath)
            ) {
              files.push({
                attachmentId: attachment.id,
                status: 'failed',
                sizeBytes: 0,
                errorCode: 'INVALID_RESULT',
              });
              continue;
            }
            downloadedBytes += outcome.savedSize;
            files.push({
              attachmentId: attachment.id,
              status: 'saved',
              filename: outcome.filename,
              relativePath: outcome.relativePath,
              sizeBytes: outcome.savedSize,
            });
          } else {
            const errorCode =
              outcome.errorCode === 'BYTE_BUDGET_EXCEEDED' ||
              outcome.errorCode === 'FILE_WRITE_FAILED'
                ? outcome.errorCode
                : 'DOWNLOAD_FAILED';
            files.push({
              attachmentId: attachment.id,
              status: 'failed',
              sizeBytes: 0,
              errorCode,
            });
          }
        } catch {
          files.push({
            attachmentId: attachment.id,
            status: 'failed',
            sizeBytes: 0,
            errorCode: 'DOWNLOAD_FAILED',
          });
        }
      }

      const successfulDownloads = files.filter((file) => file.status === 'saved').length;
      const failedDownloads = files.length - successfulDownloads;

      return {
        mailbox: mailbox.alias,
        totalFiles: requested.length,
        successfulDownloads,
        failedDownloads,
        downloadedBytes,
        byteLimit: this.config.maxDownloadBatchBytes,
        files,
      };
    } catch (error) {
      if (error instanceof BatchLimitError || error instanceof DownloadLimitError) throw error;
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
      // encodeFileForAttachment resolves with success:false instead of throwing
      // when the path is rejected, missing, or oversized. Attaching that result
      // would produce a draft carrying an empty attachment while this tool
      // reported it as attached.
      if (attachments?.some((attachment) => !attachment.success)) {
        throw new MailboxOperationError('draft attachment encoding');
      }
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
    } catch (error) {
      // Keep our own redacted reason; only Graph/encoder failures collapse into
      // the generic one, so the caller can tell "bad attachment path" apart
      // from "Graph refused the draft".
      if (error instanceof MailboxOperationError) throw error;
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
    let totalMessages = 0;
    let totalBytes = 0;
    let totalContextChars = 0;
    let totalAttachments = 0;
    for (const query of queries) {
      const outcome = await this.searchMailboxes(query.mailboxes, query.criteria);
      const entry = { label: query.label, status: outcome.status, results: outcome.results };
      let serialized: string;
      try {
        serialized = JSON.stringify(entry);
      } catch {
        throw new BatchResourceLimitError('serialization', 0);
      }

      totalMessages += outcome.results.reduce((count, result) => count + result.messages.length, 0);
      totalAttachments += outcome.results.reduce(
        (count, result) =>
          count +
          result.messages.reduce(
            (messageCount, message) =>
              messageCount + (Array.isArray(message.attachments) ? message.attachments.length : 0),
            0
          ),
        0
      );
      totalContextChars += serialized.length;
      totalBytes += Buffer.byteLength(serialized, 'utf8');

      if (totalMessages > this.config.maxBatchResultMessages) {
        throw new BatchResourceLimitError('message', this.config.maxBatchResultMessages);
      }
      if (totalAttachments > this.config.maxBatchAttachments) {
        throw new BatchResourceLimitError('attachment', this.config.maxBatchAttachments);
      }
      if (totalContextChars > this.config.maxBatchContextChars) {
        throw new BatchResourceLimitError('context character', this.config.maxBatchContextChars);
      }
      if (totalBytes > this.config.maxBatchResultBytes) {
        throw new BatchResourceLimitError('byte', this.config.maxBatchResultBytes);
      }

      results.push(entry);
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
      // Order the union before cutting it: Map iteration is insertion order, so
      // an unsorted slice would silently favour whichever term ran first — the
      // original query — and discard the alias/group hits that motivated the
      // expansion. And a cut here is real incompleteness, so it has to show up
      // in the evidence rather than being reported as a clean full result.
      const union = sortMessages(
        [...merged.values()],
        searchCriteria.sortBy,
        searchCriteria.sortOrder
      );
      const overflowed = union.length > maxResults;
      return {
        mailbox: mailbox.alias,
        ...aggregate!,
        messages: union.slice(0, maxResults),
        truncated: aggregate!.truncated || overflowed,
        // Mirror what advancedSearchEmailsDetailed does when it truncates: a
        // partial result must not keep claiming high confidence.
        confidence:
          overflowed && aggregate!.confidence === 'high' ? 'medium' : aggregate!.confidence,
        warnings: overflowed
          ? [...new Set([...aggregate!.warnings, 'expanded_merge_truncated'])]
          : aggregate!.warnings,
        expandedTerms: terms,
      };
    } catch {
      return redactedFailedSearch(mailbox.alias);
    }
  }
}

// Re-sorts the union of the expanded terms before it is cut: falling back to
// Map insertion order would put the caller's requested order at the mercy of
// which term ran first. This deliberately mirrors the comparator in
// EmailService.sortAdvancedMessages — same key selection, same localeCompare,
// same direction — so a merged result cannot be ordered differently from a
// single-term one. Keep the two in step if either changes.
function sortMessages(
  messages: Message[],
  sortBy: string | undefined,
  sortOrder: string | undefined
): Message[] {
  const direction = sortOrder === 'asc' ? 1 : -1;
  const valueOf = (message: Message): string | null | undefined =>
    sortBy === 'from'
      ? message.from?.emailAddress?.address
      : sortBy === 'subject'
        ? message.subject
        : message.receivedDateTime;

  return [...messages].sort(
    (left, right) =>
      String(valueOf(left) ?? '').localeCompare(String(valueOf(right) ?? '')) * direction
  );
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
