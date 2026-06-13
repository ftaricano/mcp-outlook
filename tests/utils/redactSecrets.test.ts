import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/utils/redactSecrets.js';

describe('redactSecrets', () => {
  it('masks email addresses', () => {
    expect(redactSecrets('falha para fulano@acme.com.br ao enviar')).toBe(
      'falha para [email] ao enviar'
    );
  });

  it('masks long base64-ish tokens without leaking the value', () => {
    const token = 'AKIAIOSFODNN7EXAMPLE1234567890XY';
    const out = redactSecrets(`bearer ${token} rejeitado`);
    expect(out).toContain('[token]');
    expect(out).not.toContain(token);
  });

  it('masks password assignments (: or =)', () => {
    expect(redactSecrets('login com password=Sup3rS3cretVal')).toContain('password: [hidden]');
    expect(redactSecrets('login com password=Sup3rS3cretVal')).not.toContain('Sup3rS3cretVal');
    expect(redactSecrets('PASSWORD: hunter2hunter2')).toContain('[hidden]');
  });

  it('leaves clean error text untouched (no false positives)', () => {
    expect(redactSecrets('Recurso nao encontrado (404)')).toBe('Recurso nao encontrado (404)');
    expect(redactSecrets('erro 429 rate limited')).toBe('erro 429 rate limited');
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });
});
