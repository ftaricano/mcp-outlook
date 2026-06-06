import { describe, it, expect } from 'vitest';
import { EmailHandler } from '../../src/handlers/EmailHandler.js';

// Minimal fakes — handleSummarizeEmailsBatch only calls listEmails() and
// summarizeEmailsBatch().
function makeHandler(emails: any[], batch: { summaries: any[]; failed: string[] }) {
  const emailService: any = { listEmails: async () => emails };
  const emailSummarizer: any = { summarizeEmailsBatch: async () => batch };
  return new EmailHandler(emailService, emailSummarizer);
}

describe('EmailHandler.handleSummarizeEmailsBatch — failure reporting', () => {
  it('returns an error (not a clean success) when every email fails to summarize', async () => {
    const handler = makeHandler([{ id: 'a' }, { id: 'b' }], { summaries: [], failed: ['a', 'b'] });
    const r = await handler.handleSummarizeEmailsBatch({ limit: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('2'); // both failures surfaced
  });

  it('still surfaces the failure note when priority filtering leaves nothing', async () => {
    const handler = makeHandler([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
      summaries: [{ id: 'a', priority: 'baixa' }],
      failed: ['b', 'c'],
    });
    const r = await handler.handleSummarizeEmailsBatch({ limit: 10, priorityOnly: true });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('não puderam ser resumidos');
  });

  it('reports a clean empty result when there is nothing to summarize and no failures', async () => {
    const handler = makeHandler([], { summaries: [], failed: [] });
    const r = await handler.handleSummarizeEmailsBatch({ limit: 10 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Nenhum email encontrado');
  });
});
