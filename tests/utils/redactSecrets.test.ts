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

  it('masks a JWT / Graph access token (base64url with dots)', () => {
    const jwt =
      'eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets(`auth failed: Bearer ${jwt}`);
    expect(out).not.toContain('eyJ0eXAiOiJKV1QifQ');
    expect(out).toContain('[token]');
  });

  it('masks a base64url token containing - and _', () => {
    const t = 'abcDEF123456_-7890ghijKLmno_pq';
    expect(redactSecrets(`opaque ${t} value`)).not.toContain(t);
  });

  it('masks named secret assignments (client_secret, api_key)', () => {
    expect(redactSecrets('client_secret=AbC~xyz.123val')).toContain('[hidden]');
    expect(redactSecrets('client_secret=AbC~xyz.123val')).not.toContain('AbC~xyz.123val');
    expect(redactSecrets('api_key: zzz999aaa')).toContain('[hidden]');
  });
});
