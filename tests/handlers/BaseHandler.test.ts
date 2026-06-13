import { describe, it, expect } from 'vitest';
import { BaseHandler } from '../../src/handlers/BaseHandler.js';
import type { EmailService } from '../../src/services/emailService.js';
import type { EmailSummarizer } from '../../src/services/emailSummarizer.js';

// Concrete subclass exposing the protected formatError, so we can assert that
// the secret-redaction wiring is active on the LIVE error path (not just the
// pure redactSecrets helper). The base constructor only stores its deps, so
// empty casts are safe here.
class TestHandler extends BaseHandler {
  public error(message: string, error?: unknown) {
    return this.formatError(message, error);
  }
}

describe('BaseHandler.formatError', () => {
  const handler = new TestHandler({} as EmailService, {} as EmailSummarizer);

  it('redacts a token and email from the raw error message', () => {
    const res = handler.error(
      'Falha ao enviar',
      new Error('graph rejected token AKIAIOSFODNN7EXAMPLE1234567890XY for fulano@acme.com')
    );
    const text = res.content[0].text;
    expect(res.isError).toBe(true);
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE1234567890XY');
    expect(text).not.toContain('fulano@acme.com');
    expect(text).toContain('[token]');
    expect(text).toContain('[email]');
    // Handler-supplied prefix is preserved.
    expect(text).toContain('Falha ao enviar');
  });

  it('falls back to a generic message for a non-Error throwable', () => {
    const res = handler.error('Falha', 'just a string');
    expect(res.content[0].text).toContain('Erro desconhecido');
    expect(res.isError).toBe(true);
  });
});
