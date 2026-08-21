import { describe, expect, it } from 'vitest';
import {
  createAttachmentHandoffSchema,
  createDraftSchema,
  getAttachmentContentSchema,
  getAttachmentHandoffSchema,
  investigateDocumentsSchema,
  listMessagesSchema,
  markMessagesSchema,
  searchMailboxSchema,
  searchMailboxesBatchSchema,
} from '../../src/plugin/schemas.js';

const TEST_IDEMPOTENCY_KEY = ['123e4567', 'e89b', '42d3', 'a456', '426614174000'].join('-');

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
  it('accepts a bounded document investigation and applies closed-scope defaults', () => {
    const parsed = investigateDocumentsSchema.parse({
      mailbox: 'finance',
      criteria: { proposalIds: ['PROP-1001'], clients: ['Example Industries'] },
    });

    expect(parsed.criteria.folders).toEqual(['inbox', 'sentitems', 'archive']);
    expect(parsed.criteria.maxPagesPerFolder).toBe(10);
    expect(parsed.criteria.maxMessagesPerFolder).toBe(100);
    expect(parsed.criteria.maxAttachmentPagesPerMessage).toBe(5);
    expect(parsed.criteria.maxAttachmentsPerMessage).toBe(50);
  });

  it('requires an investigation signal and rejects arbitrary folders or excessive limits', () => {
    expect(() => investigateDocumentsSchema.parse({ mailbox: 'finance', criteria: {} })).toThrow(
      /signal/i
    );
    expect(() =>
      investigateDocumentsSchema.parse({
        mailbox: 'finance',
        criteria: { proposalIds: ['PROP-1001'], folders: ['deleteditems'] },
      })
    ).toThrow();
    expect(() =>
      investigateDocumentsSchema.parse({
        mailbox: 'finance',
        criteria: { proposalIds: ['PROP-1001'], maxMessagesPerFolder: 201 },
      })
    ).toThrow();
    expect(() =>
      investigateDocumentsSchema.parse({
        mailbox: 'finance',
        criteria: { proposalIds: ['PROP-1001'], folders: ['inbox', 'inbox'] },
      })
    ).toThrow(/unique/i);
  });

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

  it('requires a high-entropy UUIDv4 idempotency key for a local handoff', () => {
    const valid = createAttachmentHandoffSchema.parse({
      mailbox: 'finance',
      messageId: 'message-1',
      attachmentId: 'attachment-1',
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
    });
    expect(valid.idempotencyKey).toBe(TEST_IDEMPOTENCY_KEY);
    expect(() =>
      createAttachmentHandoffSchema.parse({
        mailbox: 'finance',
        messageId: 'message-1',
        attachmentId: 'attachment-1',
        idempotencyKey: 'human-readable-key',
      })
    ).toThrow(/UUIDv4/i);
  });

  it('accepts only opaque handoff identifiers with the fixed shape', () => {
    expect(
      getAttachmentHandoffSchema.parse({ handoffId: `oh_${'A'.repeat(43)}` }).handoffId
    ).toHaveLength(46);
    for (const handoffId of ['../payload.bin', '/tmp/bundle', `oh_${'A'.repeat(42)}`]) {
      expect(() => getAttachmentHandoffSchema.parse({ handoffId })).toThrow();
    }
  });
});
