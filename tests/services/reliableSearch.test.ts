import { describe, expect, it, vi } from 'vitest';
import {
  messageMatchesQuery,
  runReliableTextSearch,
  type ReliableSearchMessage,
} from '../../src/services/reliableSearch.js';

function message(
  id: string,
  overrides: Partial<ReliableSearchMessage> = {}
): ReliableSearchMessage {
  return {
    id,
    subject: '',
    bodyPreview: '',
    body: { content: '' },
    from: { emailAddress: { address: '' } },
    attachments: [],
    ...overrides,
  };
}

const complete = <T>(items: T[]) => ({
  items,
  pagesScanned: 1,
  itemsScanned: items.length,
  truncated: false,
});

describe('runReliableTextSearch', () => {
  it('uses local fallback when Graph returns identical IDs for the real and canary terms', async () => {
    const ignored = complete([message('same')]);
    const executeSearch = vi.fn().mockResolvedValue(ignored);
    const executeFallback = vi.fn().mockResolvedValue(
      complete([
        message('match', {
          attachments: [{ name: 'Fatura Cliente Alfa.pdf' }],
        }),
      ])
    );

    const result = await runReliableTextSearch({
      query: 'Cliente Alfa',
      maxResults: 10,
      executeSearch,
      executeFallback,
    });

    expect(result.status).toBe('FOUND');
    expect(result.strategy).toBe('local_scan');
    expect(result.canaryMatched).toBe(true);
    expect(result.messages.map((item) => item.id)).toEqual(['match']);
  });

  it('treats identical Graph IDs in a different order as a canary match', async () => {
    const executeFallback = vi
      .fn()
      .mockResolvedValue(complete([message('real', { subject: 'invoice' })]));
    const executeSearch = vi
      .fn()
      .mockResolvedValueOnce(complete([message('a'), message('b')]))
      .mockResolvedValueOnce(complete([message('b'), message('a')]));

    const result = await runReliableTextSearch({
      query: 'invoice',
      maxResults: 10,
      executeSearch,
      executeFallback,
    });

    expect(result.strategy).toBe('local_scan');
    expect(result.canaryMatched).toBe(true);
    expect(executeFallback).toHaveBeenCalledOnce();
  });

  it('treats any nonempty impossible canary result as suspicious', async () => {
    const executeFallback = vi
      .fn()
      .mockResolvedValue(complete([message('real', { subject: 'invoice' })]));
    const executeSearch = vi
      .fn()
      .mockResolvedValueOnce(complete([message('a'), message('b')]))
      .mockResolvedValueOnce(complete([message('c'), message('a')]));

    const result = await runReliableTextSearch({
      query: 'invoice',
      maxResults: 10,
      executeSearch,
      executeFallback,
    });

    expect(result.strategy).toBe('local_scan');
    expect(result.canaryMatched).toBe(true);
    expect(executeFallback).toHaveBeenCalledOnce();
  });

  it('uses local fallback when Graph search returns no candidates', async () => {
    const result = await runReliableTextSearch({
      query: 'contrato social',
      maxResults: 10,
      executeSearch: vi.fn().mockResolvedValue(complete([])),
      executeFallback: vi
        .fn()
        .mockResolvedValue(
          complete([message('match', { bodyPreview: 'Segue o contrato social solicitado.' })])
        ),
    });

    expect(result.status).toBe('FOUND');
    expect(result.strategy).toBe('local_scan');
  });

  it('returns NOT_FOUND at medium confidence after an exhaustive fallback scan', async () => {
    const result = await runReliableTextSearch({
      query: 'cliente inexistente',
      maxResults: 10,
      executeSearch: vi.fn().mockResolvedValue(complete([])),
      executeFallback: vi.fn().mockResolvedValue(complete([message('other')])),
    });

    expect(result.status).toBe('NOT_FOUND');
    // Local matcher recall < Graph KQL (whole-token, no stemming), so a completed
    // negative is capped below 'high' and flags its exact-match limitation.
    expect(result.confidence).toBe('medium');
    expect(result.truncated).toBe(false);
    expect(result.warnings).toContain('fallback_exact_token_match');
  });

  it('returns SEARCH_INCOMPLETE instead of NOT_FOUND when fallback scanning is truncated', async () => {
    const result = await runReliableTextSearch({
      query: 'cliente talvez depois',
      maxResults: 10,
      executeSearch: vi.fn().mockResolvedValue(complete([])),
      executeFallback: vi.fn().mockResolvedValue({
        items: [message('other')],
        pagesScanned: 2,
        itemsScanned: 200,
        truncated: true,
        nextLink: 'https://graph.test/page-3',
      }),
    });

    expect(result.status).toBe('SEARCH_INCOMPLETE');
    expect(result.confidence).toBe('low');
    expect(result.truncated).toBe(true);
  });

  it('matches normalized Unicode text and numeric tokens during fallback', async () => {
    const result = await runReliableTextSearch({
      query: 'JOÃO 100151515',
      maxResults: 10,
      executeSearch: vi.fn().mockResolvedValue(complete([])),
      executeFallback: vi.fn().mockResolvedValue(
        complete([
          message('match', {
            subject: 'Documento de Joao',
            bodyPreview: 'Referência 100151515',
          }),
        ])
      ),
    });

    expect(result.status).toBe('FOUND');
    expect(result.messages.map((item) => item.id)).toEqual(['match']);
  });

  it('normalizes punctuation while requiring token boundaries', () => {
    expect(
      messageMatchesQuery(message('one', { subject: 'Cliente-Alfa confirmado' }), 'Cliente Alfa')
    ).toBe(true);
    expect(messageMatchesQuery(message('two', { subject: 'Annual report' }), 'ann')).toBe(false);
    expect(messageMatchesQuery(message('three', { subject: 'Reference 100151515' }), '10015')).toBe(
      false
    );
  });

  it('marks found results truncated when more matches exist than maxResults', async () => {
    const result = await runReliableTextSearch({
      query: 'invoice',
      maxResults: 2,
      executeSearch: vi.fn().mockResolvedValue(complete([])),
      executeFallback: vi
        .fn()
        .mockResolvedValue(
          complete([
            message('1', { subject: 'invoice one' }),
            message('2', { subject: 'invoice two' }),
            message('3', { subject: 'invoice three' }),
          ])
        ),
    });

    expect(result.status).toBe('FOUND');
    expect(result.messages).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.confidence).toBe('medium');
  });

  it('returns SEARCH_UNTRUSTED when canary and fallback verification both fail', async () => {
    const executeSearch = vi
      .fn()
      .mockResolvedValueOnce(complete([message('candidate')]))
      .mockRejectedValueOnce(new Error('canary failed'));

    const result = await runReliableTextSearch({
      query: 'invoice',
      maxResults: 10,
      executeSearch,
      executeFallback: vi.fn().mockRejectedValue(new Error('fallback failed')),
    });

    expect(result.status).toBe('SEARCH_UNTRUSTED');
    expect(result.warnings).toContain('canary_failed');
  });

  it('returns SEARCH_FAILED when both Graph search and fallback fail', async () => {
    const result = await runReliableTextSearch({
      query: 'fatura',
      maxResults: 10,
      executeSearch: vi.fn().mockRejectedValue(new Error('search failed')),
      executeFallback: vi.fn().mockRejectedValue(new Error('scan failed')),
    });

    expect(result.status).toBe('SEARCH_FAILED');
    expect(result.messages).toEqual([]);
    expect(result.warnings).toContain('graph_search_failed');
    expect(result.warnings).toContain('local_scan_failed');
  });

  it('returns SEARCH_UNTRUSTED when the canary is suspicious and fallback cannot verify it', async () => {
    const ignored = complete([message('same')]);

    const result = await runReliableTextSearch({
      query: 'fatura',
      maxResults: 10,
      executeSearch: vi.fn().mockResolvedValue(ignored),
      executeFallback: vi.fn().mockRejectedValue(new Error('scan failed')),
    });

    expect(result.status).toBe('SEARCH_UNTRUSTED');
    expect(result.canaryMatched).toBe(true);
  });
});
