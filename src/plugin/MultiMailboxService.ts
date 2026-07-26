import type { Message } from '@microsoft/microsoft-graph-types';
import type { AdvancedSearchOptions, EmailService } from '../services/emailService.js';
import type { ReliableSearchResult, SearchStatus } from '../services/reliableSearch.js';
import type { PluginConfig, MailboxConfig } from './config.js';
import type { MailboxSearchResult, MultiMailboxSearchResult } from './schemas.js';

export type MailboxEmailService = Pick<
  EmailService,
  'advancedSearchEmailsDetailed' | 'getEmailById'
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

export class MultiMailboxService {
  constructor(
    private readonly config: PluginConfig,
    private readonly createEmailService: EmailServiceFactory
  ) {}

  listAllowedMailboxes(): readonly string[] {
    return this.config.mailboxes.map((mailbox) => mailbox.alias);
  }

  async searchMailbox(
    alias: string,
    criteria: AdvancedSearchOptions
  ): Promise<MailboxSearchResult> {
    const mailbox = this.resolveMailbox(alias);
    return this.searchResolvedMailbox(mailbox, criteria);
  }

  async searchMailboxes(
    aliases: readonly string[] | undefined,
    criteria: AdvancedSearchOptions
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

  private async searchResolvedMailbox(
    mailbox: MailboxConfig,
    criteria: AdvancedSearchOptions
  ): Promise<MailboxSearchResult> {
    try {
      const emailService = this.createEmailService(mailbox.address);
      const maxResults = Math.min(
        criteria.maxResults ?? this.config.maxResultsPerMailbox,
        this.config.maxResultsPerMailbox
      );
      const evidence = await emailService.advancedSearchEmailsDetailed({
        ...criteria,
        maxResults,
        scanLimit: Math.min(maxResults * 3, 100),
        includeFullContent: false,
      });
      return { mailbox: mailbox.alias, ...evidence };
    } catch {
      return redactedFailedSearch(mailbox.alias);
    }
  }
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
