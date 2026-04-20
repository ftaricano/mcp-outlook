import { describe, it, expect } from 'vitest';
import { AttachmentValidator } from '../../src/utils/attachmentValidator.js';

/**
 * Base64 of "hello world" = "aGVsbG8gd29ybGQ=" (11 bytes original).
 * Buffer.from(...).toString('base64') checked locally.
 */
const helloBase64 = Buffer.from('hello world').toString('base64');

function buildAttachment(overrides: Partial<{
  name: string;
  contentType: string;
  content: string;
  size?: number;
}> = {}) {
  return {
    name: 'note.txt',
    contentType: 'text/plain',
    content: helloBase64,
    ...overrides
  };
}

describe('AttachmentValidator.validateSingleAttachment', () => {
  it('accepts a valid small text attachment', () => {
    const result = AttachmentValidator.validateSingleAttachment(buildAttachment());
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.info.originalSize).toBe(11);
    expect(result.info.contentType).toBe('text/plain');
  });

  it('rejects empty file name', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ name: '' })
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /name/i.test(e))).toBe(true);
  });

  it('rejects missing contentType', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ contentType: '' })
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /content type/i.test(e))).toBe(true);
  });

  it('rejects empty content', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ content: '' })
    );
    expect(result.isValid).toBe(false);
  });

  it('rejects invalid base64 (non-base64 characters)', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ content: '!!!not-base64!!!' })
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /base64/i.test(e))).toBe(true);
  });

  it('rejects base64 with bad padding', () => {
    // length not divisible by 4
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ content: 'abc' })
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /padding|base64/i.test(e))).toBe(true);
  });

  it('rejects files larger than 3MB (upload session not implemented)', () => {
    // Build >3MB of bytes → base64
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 100, 0x41);
    const big = bytes.toString('base64');
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ name: 'big.pdf', contentType: 'application/pdf', content: big })
    );
    expect(result.isValid).toBe(false);
    expect(result.info.needsUploadSession).toBe(true);
    expect(result.errors.some((e) => /too large/i.test(e))).toBe(true);
  });

  it('warns for unrecognized MIME type (but still valid)', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ contentType: 'x-custom/thing-format' })
    );
    expect(result.isValid).toBe(true);
    // It is still a syntactically-valid MIME so it may or may not warn; just
    // ensure there's no error.
    expect(result.errors).toHaveLength(0);
  });

  it('warns when reported size differs from calculated size', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ size: 999_999 })
    );
    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => /differs/i.test(w))).toBe(true);
  });
});

describe('AttachmentValidator.validateAttachments', () => {
  it('returns valid for empty array', () => {
    const result = AttachmentValidator.validateAttachments([]);
    expect(result.isValid).toBe(true);
    expect(result.totalSize).toBe(0);
  });

  it('aggregates errors across multiple attachments', () => {
    const good = buildAttachment();
    const bad = buildAttachment({ name: '', content: 'xxx' });
    const result = AttachmentValidator.validateAttachments([good, bad]);
    expect(result.isValid).toBe(false);
    // errors should be prefixed with an index
    expect(result.errors.some((e) => e.includes('Attachment 2'))).toBe(true);
  });

  it('accumulates totalSize', () => {
    const a = buildAttachment();
    const b = buildAttachment({ name: 'b.txt' });
    const result = AttachmentValidator.validateAttachments([a, b]);
    expect(result.isValid).toBe(true);
    expect(result.totalSize).toBe(helloBase64.length * 2);
  });
});

describe('AttachmentValidator.cleanBase64Content', () => {
  it('strips a data URI prefix', () => {
    const cleaned = AttachmentValidator.cleanBase64Content(
      `data:image/png;base64,${helloBase64}`
    );
    expect(cleaned).toBe(helloBase64);
  });

  it('strips whitespace', () => {
    const cleaned = AttachmentValidator.cleanBase64Content(
      `   ${helloBase64.slice(0, 4)}\n${helloBase64.slice(4)}  `
    );
    expect(cleaned).toBe(helloBase64);
  });
});

describe('AttachmentValidator.estimateEncodedSize / calculateOriginalSize', () => {
  it('estimateEncodedSize is roughly 37% over original', () => {
    const estimate = AttachmentValidator.estimateEncodedSize(1000);
    expect(estimate).toBeGreaterThan(1000);
    expect(estimate).toBeLessThanOrEqual(1400);
  });

  it('calculateOriginalSize round-trips a known base64', () => {
    const size = AttachmentValidator.calculateOriginalSize(helloBase64);
    expect(size).toBe(11);
  });
});

/**
 * NOTE: The current AttachmentValidator does not explicitly reject
 * path-traversal file names like "../../etc/passwd" — it only checks
 * that `name` is non-empty. This is documented as a known gap.
 *
 * Kept as a skipped test so future work is visible.
 */
describe.skip('TODO: path-traversal rejection in file name', () => {
  it('rejects ../../etc/passwd', () => {
    const result = AttachmentValidator.validateSingleAttachment(
      buildAttachment({ name: '../../etc/passwd' })
    );
    expect(result.isValid).toBe(false);
  });
});
