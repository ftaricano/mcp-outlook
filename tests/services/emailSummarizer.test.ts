import { describe, it, expect } from 'vitest';
import { EmailSummarizer } from '../../src/services/emailSummarizer.js';

function fakeEmail(overrides: any = {}) {
  return {
    id: 'msg-1',
    subject: 'Teste padrão',
    from: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
    receivedDateTime: '2024-05-01T12:00:00Z',
    body: { content: 'Olá, tudo bem?' },
    hasAttachments: false,
    attachments: [],
    ...overrides
  };
}

describe('EmailSummarizer.summarizeEmail', () => {
  const summarizer = new EmailSummarizer();

  it('produces a summary with all expected fields', async () => {
    const summary = await summarizer.summarizeEmail(fakeEmail() as any);
    expect(summary.id).toBe('msg-1');
    expect(summary.subject).toBe('Teste padrão');
    expect(summary.from).toBe('alice@example.com');
    expect(['alta', 'média', 'baixa']).toContain(summary.priority);
    expect(typeof summary.category).toBe('string');
    expect(['positivo', 'neutro', 'negativo']).toContain(summary.sentiment);
    expect(typeof summary.actionRequired).toBe('boolean');
    expect(Array.isArray(summary.keyPoints)).toBe(true);
  });

  it('flags URGENTE subject as high priority', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ subject: 'URGENTE: revisar contrato' }) as any
    );
    expect(summary.priority).toBe('alta');
  });

  it('flags meeting-related emails as medium priority', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        subject: 'Convite para reunião de planejamento',
        body: { content: 'Confirme presença' }
      }) as any
    );
    // body has "confirme" which is also a medium-priority word; subject is
    // "reunião" which is medium too.
    expect(summary.priority).toBe('média');
  });

  it('low-priority fallback for banal email', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ subject: 'oi', body: { content: 'tudo bem?' } }) as any
    );
    expect(summary.priority).toBe('baixa');
  });

  it('categorizes financial emails', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        subject: 'Fatura do mês',
        body: { content: 'Segue a fatura de pagamento' }
      }) as any
    );
    expect(summary.category).toBe('Financeiro');
  });

  it('falls back to Geral when no category matches', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ subject: 'xyz', body: { content: 'abcdef' } }) as any
    );
    expect(summary.category).toBe('Geral');
  });

  it('detects positive sentiment when positive words present', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        body: { content: 'Obrigado pela excelente apresentação, ficamos satisfeitos.' }
      }) as any
    );
    expect(summary.sentiment).toBe('positivo');
  });

  it('detects negative sentiment when negative words present', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        body: { content: 'Houve um problema grave e o pagamento foi rejeitado.' }
      }) as any
    );
    expect(summary.sentiment).toBe('negativo');
  });

  it('handles empty body without throwing', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ body: { content: '' } }) as any
    );
    expect(summary).toBeDefined();
    expect(summary.subject).toBe('Teste padrão');
  });

  it('handles missing subject with "Sem assunto"', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ subject: undefined }) as any
    );
    expect(summary.subject).toBe('Sem assunto');
  });

  it('handles missing from with "Remetente desconhecido"', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ from: undefined }) as any
    );
    expect(summary.from).toBe('Remetente desconhecido');
  });

  it('handles missing receivedDateTime with "Data desconhecida"', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({ receivedDateTime: undefined }) as any
    );
    expect(summary.date).toBe('Data desconhecida');
  });

  it('extracts attachment names when hasAttachments is true', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        hasAttachments: true,
        attachments: [{ name: 'a.pdf' }, { name: 'b.xlsx' }]
      }) as any
    );
    expect(summary.attachments).toEqual(['a.pdf', 'b.xlsx']);
  });

  it('strips HTML tags from body before summarizing', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        body: {
          content:
            '<p>Prezado, <b>por favor</b> confirme o recebimento do <i>documento</i>.</p>'
        }
      }) as any
    );
    // Should not contain tags
    expect(summary.summary).not.toMatch(/<\/?[a-z]/i);
  });

  it('marks actionRequired when action verbs are present', async () => {
    const summary = await summarizer.summarizeEmail(
      fakeEmail({
        subject: 'Preciso de sua aprovação',
        body: { content: 'Por favor, aprove o documento.' }
      }) as any
    );
    expect(summary.actionRequired).toBe(true);
  });
});

describe('EmailSummarizer.summarizeEmailsBatch', () => {
  it('iterates over emailIds and returns summaries', async () => {
    const summarizer = new EmailSummarizer();
    const fakeService: any = {
      getEmailById: async (id: string) => fakeEmail({ id })
    };
    const result = await summarizer.summarizeEmailsBatch(
      ['id1', 'id2'],
      fakeService
    );
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('id1');
    expect(result[1].id).toBe('id2');
  });

  it('skips failing emails without throwing', async () => {
    const summarizer = new EmailSummarizer();
    const fakeService: any = {
      getEmailById: async (id: string) => {
        if (id === 'bad') throw new Error('not found');
        return fakeEmail({ id });
      }
    };
    // Silence the expected console.error from the SUT.
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const result = await summarizer.summarizeEmailsBatch(
      ['id1', 'bad', 'id2'],
      fakeService
    );
    expect(result.map((r) => r.id)).toEqual(['id1', 'id2']);
    spy.mockRestore();
  });
});

// Make sure vi is importable in this test file after the helper uses it above.
import { vi } from 'vitest';
