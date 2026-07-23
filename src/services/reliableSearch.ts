import { createHash } from 'node:crypto';
import type { GraphPaginationResult } from './graphPagination.js';

export type SearchStatus =
  'FOUND' | 'NOT_FOUND' | 'SEARCH_INCOMPLETE' | 'SEARCH_FAILED' | 'SEARCH_UNTRUSTED';

export type SearchStrategy = 'graph_search' | 'local_scan';
export type SearchConfidence = 'high' | 'medium' | 'low';

export interface ReliableSearchMessage {
  id?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { content?: string | null } | null;
  from?: { emailAddress?: { address?: string | null } | null } | null;
  attachments?: Array<{ name?: string | null }> | null;
}

export interface ReliableSearchResult<T extends ReliableSearchMessage> {
  status: SearchStatus;
  strategy: SearchStrategy;
  confidence: SearchConfidence;
  messages: T[];
  pagesScanned: number;
  candidatesScanned: number;
  truncated: boolean;
  canaryMatched: boolean;
  warnings: string[];
}

interface RunReliableTextSearchOptions<T extends ReliableSearchMessage> {
  query: string;
  maxResults: number;
  executeSearch: (term: string) => Promise<GraphPaginationResult<T>>;
  executeFallback: () => Promise<GraphPaginationResult<T>>;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function searchableText(message: ReliableSearchMessage): string {
  return normalize(
    [
      message.subject,
      message.bodyPreview,
      message.body?.content,
      message.from?.emailAddress?.address,
      ...(message.attachments ?? []).map((attachment) => attachment.name),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export function messageMatchesQuery(message: ReliableSearchMessage, query: string): boolean {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return false;

  const haystackTokens = new Set(searchableText(message).split(' ').filter(Boolean));
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystackTokens.has(token));
}

export function buildCanaryTerm(query: string): string {
  const digest = createHash('sha256').update(query).digest('hex').slice(0, 16);
  return `__mcp_outlook_canary_${digest}__`;
}

export async function runReliableTextSearch<T extends ReliableSearchMessage>({
  query,
  maxResults,
  executeSearch,
  executeFallback,
}: RunReliableTextSearchOptions<T>): Promise<ReliableSearchResult<T>> {
  const warnings: string[] = [];
  let canaryMatched = false;
  let canaryFailed = false;
  let graphSearchSucceeded = false;
  let graphPages = 0;
  let graphCandidates = 0;

  try {
    const graphResult = await executeSearch(query);
    graphSearchSucceeded = true;
    graphPages += graphResult.pagesScanned;
    graphCandidates += graphResult.itemsScanned;

    try {
      const canaryResult = await executeSearch(buildCanaryTerm(query));
      graphPages += canaryResult.pagesScanned;
      graphCandidates += canaryResult.itemsScanned;
      canaryMatched = canaryResult.items.length > 0;

      if (graphResult.items.length > 0 && !canaryMatched) {
        const resultTruncated =
          graphResult.truncated || graphResult.items.length > Math.max(0, maxResults);
        return {
          status: 'FOUND',
          strategy: 'graph_search',
          confidence: resultTruncated ? 'medium' : 'high',
          messages: graphResult.items.slice(0, maxResults),
          pagesScanned: graphPages,
          candidatesScanned: graphCandidates,
          truncated: resultTruncated,
          canaryMatched: false,
          warnings,
        };
      }
    } catch {
      canaryFailed = true;
      warnings.push('canary_failed');
    }

    if (canaryMatched) warnings.push('graph_search_canary_matched');
    if (graphResult.items.length === 0) warnings.push('graph_search_empty');
  } catch {
    warnings.push('graph_search_failed');
  }

  try {
    const fallbackResult = await executeFallback();
    const allMatches = fallbackResult.items.filter((message) =>
      messageMatchesQuery(message, query)
    );
    const matches = allMatches.slice(0, maxResults);
    const resultTruncated = fallbackResult.truncated || allMatches.length > maxResults;
    const pagesScanned = graphPages + fallbackResult.pagesScanned;
    const candidatesScanned = graphCandidates + fallbackResult.itemsScanned;

    if (matches.length > 0) {
      return {
        status: 'FOUND',
        strategy: 'local_scan',
        confidence: resultTruncated ? 'medium' : 'high',
        messages: matches,
        pagesScanned,
        candidatesScanned,
        truncated: resultTruncated,
        canaryMatched,
        warnings,
      };
    }

    // The local matcher requires whole-token equality, so its recall is strictly below
    // Graph KQL (no stemming/prefix): a completed scan negative can still miss "fatura" in
    // "faturas". Cap the NOT_FOUND at medium so callers don't over-trust the absence.
    if (!fallbackResult.truncated) warnings.push('fallback_exact_token_match');
    return {
      status: fallbackResult.truncated ? 'SEARCH_INCOMPLETE' : 'NOT_FOUND',
      strategy: 'local_scan',
      confidence: fallbackResult.truncated ? 'low' : 'medium',
      messages: [],
      pagesScanned,
      candidatesScanned,
      truncated: fallbackResult.truncated,
      canaryMatched,
      warnings,
    };
  } catch {
    warnings.push('local_scan_failed');
    return {
      status:
        graphSearchSucceeded && (canaryMatched || canaryFailed)
          ? 'SEARCH_UNTRUSTED'
          : 'SEARCH_FAILED',
      strategy: 'local_scan',
      confidence: 'low',
      messages: [],
      pagesScanned: graphPages,
      candidatesScanned: graphCandidates,
      truncated: true,
      canaryMatched,
      warnings,
    };
  }
}
