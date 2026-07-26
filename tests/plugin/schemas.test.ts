import { describe, expect, it } from 'vitest';
import { searchMailboxSchema } from '../../src/plugin/schemas.js';

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
