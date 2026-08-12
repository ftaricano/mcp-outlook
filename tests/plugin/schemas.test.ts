import { describe, expect, it } from 'vitest';
import {
  createDraftSchema,
  getAttachmentContentSchema,
  listMessagesSchema,
  markMessagesSchema,
  searchMailboxSchema,
  searchMailboxesBatchSchema,
} from '../../src/plugin/schemas.js';

describe('plugin search date compatibility', () => {
  it.each(['2026-07-26', '2026-07-26T15:00:00Z', '2026-07-26T12:00:00-03:00'])(
    'accepts the original MCP ISO date shape: %s',
    (dateFrom) => {
      expect(
        searchMailboxSchema.safeParse({
          mailbox: 'finance',
          criteria: { dateFrom },
        }).success
      ).toBe(true);
    }
  );

  it('rejects an OData filter injection in a date field', () => {
    expect(
      searchMailboxSchema.safeParse({
        mailbox: 'finance',
        criteria: { dateFrom: '2026-07-26 or isRead eq false' },
      }).success
    ).toBe(false);
  });

  it('does not expose caller-controlled scan limits', () => {
    expect(
      searchMailboxSchema.safeParse({
        mailbox: 'finance',
        criteria: { query: 'invoice', scanLimit: 500 },
      }).success
    ).toBe(false);
  });
});

describe('expansion tool schemas', () => {
  it('accepts the new criteria flags and the raised deterministic cap', () => {
    const parsed = listMessagesSchema.parse({
      mailbox: 'finance',
      criteria: {
        sender: 'a@b.com',
        maxResults: 100,
        includeAttachmentNames: true,
        expandTerms: true,
      },
    });
    expect(parsed.criteria.maxResults).toBe(100);
  });

  it('rejects maxResults above 100', () => {
    expect(() =>
      listMessagesSchema.parse({ mailbox: 'finance', criteria: { maxResults: 101 } })
    ).toThrow();
  });

  it('validates a labeled batch and rejects more than the schema ceiling of queries', () => {
    const query = { label: 'caso-1', criteria: { query: 'fatura' } };
    expect(() =>
      searchMailboxesBatchSchema.parse({ queries: Array.from({ length: 26 }, () => query) })
    ).toThrow();
    const ok = searchMailboxesBatchSchema.parse({ queries: [query] });
    expect(ok.queries[0].label).toBe('caso-1');
  });

  it('rejects duplicate batch labels', () => {
    const query = { label: 'dup', criteria: { query: 'x' } };
    expect(() => searchMailboxesBatchSchema.parse({ queries: [query, query] })).toThrow(/label/i);
  });

  it('validates attachment content input with optional zip entry and password', () => {
    const parsed = getAttachmentContentSchema.parse({
      mailbox: 'finance',
      messageId: 'm1',
      attachmentId: 'a1',
      mode: 'raw',
      entry: 'pasta/arquivo.pdf',
      password: 's3cret',
    });
    expect(parsed.mode).toBe('raw');
  });

  it('defaults attachment content mode to text', () => {
    const parsed = getAttachmentContentSchema.parse({
      mailbox: 'finance',
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(parsed.mode).toBe('text');
  });

  it('rejects zip entries with path traversal', () => {
    expect(() =>
      getAttachmentContentSchema.parse({
        mailbox: 'finance',
        messageId: 'm1',
        attachmentId: 'a1',
        entry: '../etc/passwd',
      })
    ).toThrow();
  });

  it('accepts a dotted entry name, which is not traversal', () => {
    const parsed = getAttachmentContentSchema.parse({
      mailbox: 'finance',
      messageId: 'm1',
      attachmentId: 'a1',
      entry: 'relatorio..v2.pdf',
    });
    expect(parsed.entry).toBe('relatorio..v2.pdf');
  });

  it('rejects entry names the listing never emits, keeping both validations aligned', () => {
    for (const entry of ['dir\\arquivo.pdf', '/absoluto.pdf', 'a'.repeat(513)]) {
      expect(() =>
        getAttachmentContentSchema.parse({
          mailbox: 'finance',
          messageId: 'm1',
          attachmentId: 'a1',
          entry,
        })
      ).toThrow();
    }
  });

  it('bounds messageIds arrays at the schema ceiling of 100', () => {
    const ids = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    expect(() =>
      markMessagesSchema.parse({ mailbox: 'finance', messageIds: ids, read: true })
    ).toThrow();
  });

  it('validates a draft without exposing any send capability', () => {
    const parsed = createDraftSchema.parse({
      mailbox: 'finance',
      to: ['x@example.com'],
      subject: 'Assunto',
      body: '<p>corpo</p>',
    });
    expect(parsed.to).toHaveLength(1);
  });
});
