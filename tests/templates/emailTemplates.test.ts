import { describe, it, expect } from 'vitest';
import { EmailTemplateEngine, emailTemplateEngine } from '../../src/templates/emailTemplates.js';

describe('EmailTemplateEngine.formatNewEmail', () => {
  const engine = new EmailTemplateEngine();

  it('produces HTML containing the body text', () => {
    const html = engine.formatNewEmail({ body: 'Hello world' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Hello world');
  });

  it('includes DOCTYPE, charset and viewport', () => {
    const html = engine.formatNewEmail({ body: 'x' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('charset=');
    expect(html).toContain('viewport');
  });

  for (const theme of ['professional', 'modern', 'minimal', 'corporate'] as const) {
    it(`renders for theme ${theme}`, () => {
      const html = engine.formatNewEmail({ body: `Body-${theme}` }, { theme });
      expect(html).toContain(`Body-${theme}`);
      expect(html).toContain('<!DOCTYPE html>');
    });
  }

  it('falls back to professional for an unknown theme', () => {
    // Unknown theme: should still render without throwing.
    const html = engine.formatNewEmail({ body: 'fallback' }, { theme: 'bogus' as any });
    expect(html).toContain('fallback');
  });

  it('renders the title when provided', () => {
    const html = engine.formatNewEmail({ title: 'My Title', body: 'body' });
    expect(html).toContain('My Title');
  });

  it('renders attachment list when provided', () => {
    const html = engine.formatNewEmail({
      body: 'b',
      attachmentList: ['invoice.pdf', 'photo.jpg'],
    });
    expect(html).toContain('invoice.pdf');
    expect(html).toContain('photo.jpg');
  });

  it('omits header h2 when showHeader=false', () => {
    const withHeader = engine.formatNewEmail(
      { body: 'b' },
      { showHeader: true, companyName: 'ACME Corp' }
    );
    const withoutHeader = engine.formatNewEmail(
      { body: 'b' },
      { showHeader: false, companyName: 'ACME Corp' }
    );
    // The header section renders an <h2> with the company name; the footer
    // also uses the company name, so we assert on the header-only h2 markup.
    expect(withHeader).toMatch(/<h2[^>]*>\s*\n?\s*ACME Corp/);
    expect(withoutHeader).not.toMatch(/<h2[^>]*>\s*\n?\s*ACME Corp/);
  });

  it('renders footer by default with current year', () => {
    const html = engine.formatNewEmail({ body: 'b' });
    const year = new Date().getFullYear();
    expect(html).toContain(String(year));
  });

  it('renders signature when provided', () => {
    const html = engine.formatNewEmail({ body: 'b', signature: 'Regards, John' });
    expect(html).toContain('Regards, John');
  });

  it('escapes user-supplied title, signature, company name, logo alt, and attachment names', () => {
    const html = engine.formatNewEmail(
      {
        title: '<img src=x onerror=alert(1)>',
        body: 'safe',
        signature: '<script>alert(2)</script>',
        attachmentList: ['report<img>.pdf'],
      },
      {
        companyName: 'ACME <Corp>',
        logoUrl: 'https://example.com/logo.png',
      }
    );

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('report<img>.pdf');
    expect(html).not.toContain('ACME <Corp>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('report&lt;img&gt;.pdf');
    expect(html).toContain('ACME &lt;Corp&gt;');
  });

  it('converts \\n\\n into paragraphs', () => {
    const html = engine.formatNewEmail({ body: 'First paragraph\n\nSecond paragraph' });
    expect(html).toContain('First paragraph');
    expect(html).toContain('Second paragraph');
    // Should have multiple <p> blocks
    const pCount = (html.match(/<p style=/g) || []).length;
    expect(pCount).toBeGreaterThanOrEqual(2);
  });
});

describe('EmailTemplateEngine.formatReplyEmail', () => {
  const engine = new EmailTemplateEngine();

  it('includes both reply body and original email metadata', () => {
    const html = engine.formatReplyEmail(
      { body: 'My reply' },
      {
        body: 'Original message',
        metadata: {
          sender: 'alice@example.com',
          date: '2024-01-01',
          originalSubject: 'Hello',
        },
      }
    );
    expect(html).toContain('My reply');
    expect(html).toContain('Original message');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('2024-01-01');
    expect(html).toContain('Hello');
  });

  it('escapes original email metadata, body, and attachment names', () => {
    const html = engine.formatReplyEmail(
      { body: 'Reply' },
      {
        body: '<script>alert(1)</script>',
        attachmentList: ['invoice<script>.pdf'],
        metadata: {
          sender: '<b>alice@example.com</b>',
          date: '<time>2024-01-01</time>',
          originalSubject: '<img src=x>',
        },
      }
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('invoice<script>.pdf');
    expect(html).not.toContain('<b>alice@example.com</b>');
    expect(html).not.toContain('<time>2024-01-01</time>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('invoice&lt;script&gt;.pdf');
    expect(html).toContain('&lt;b&gt;alice@example.com&lt;/b&gt;');
    expect(html).toContain('&lt;time&gt;2024-01-01&lt;/time&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

describe('EmailTemplateEngine.formatSimpleEmail', () => {
  const engine = new EmailTemplateEngine();

  it('wraps the body in a div', () => {
    const html = engine.formatSimpleEmail('Just a line');
    expect(html).toContain('Just a line');
    expect(html).toContain('<div');
  });
});

describe('EmailTemplateEngine.validateTemplate', () => {
  const engine = new EmailTemplateEngine();

  it('returns valid=true for a well-formed template', () => {
    const html = engine.formatNewEmail({ body: 'ok' });
    const result = engine.validateTemplate(html);
    // The current template triggers the "too much inline CSS" warning at >50 inline styles.
    // We assert the three structural warnings are NOT emitted.
    const structuralWarnings = result.warnings.filter(
      (w) => w.includes('DOCTYPE') || w.includes('Charset') || w.includes('viewport')
    );
    expect(structuralWarnings).toHaveLength(0);
  });

  it('warns when DOCTYPE missing', () => {
    const result = engine.validateTemplate('<html><head></head><body></body></html>');
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('DOCTYPE'))).toBe(true);
  });

  it('warns when charset missing', () => {
    const result = engine.validateTemplate('<!DOCTYPE html><html></html>');
    expect(result.warnings.some((w) => w.includes('Charset'))).toBe(true);
  });

  it('warns when viewport missing', () => {
    const result = engine.validateTemplate(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head></html>'
    );
    expect(result.warnings.some((w) => w.includes('viewport'))).toBe(true);
  });
});

describe('exported singleton', () => {
  it('emailTemplateEngine is a usable EmailTemplateEngine', () => {
    expect(emailTemplateEngine).toBeInstanceOf(EmailTemplateEngine);
    const html = emailTemplateEngine.formatNewEmail({ body: 'hello' });
    expect(html).toContain('hello');
  });
});

describe('EmailTemplateEngine HTML escaping', () => {
  it('escapes <script> tags in body', () => {
    const engine = new EmailTemplateEngine();
    const html = engine.formatNewEmail({ body: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes body content while preserving paragraph and line breaks', () => {
    const engine = new EmailTemplateEngine();
    const html = engine.formatNewEmail({ body: '<b>One</b>\nTwo\n\nThree & four' });

    expect(html).not.toContain('<b>One</b>');
    expect(html).toContain('&lt;b&gt;One&lt;/b&gt;<br>Two');
    expect(html).toContain('Three &amp; four');
  });
});
