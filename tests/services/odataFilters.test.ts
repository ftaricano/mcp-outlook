import { describe, it, expect } from 'vitest';
import {
  escapeODataString,
  buildSenderContainsFilter,
} from '../../src/services/odataFilters.js';

describe('escapeODataString', () => {
  it('passes plain text through unchanged', () => {
    expect(escapeODataString('bruno@example.com')).toBe('bruno@example.com');
  });

  it("doubles single quotes to satisfy OData ABNF", () => {
    expect(escapeODataString("o'brien@example.com")).toBe("o''brien@example.com");
  });

  it("doubles every quote, not just the first", () => {
    expect(escapeODataString("a'b'c")).toBe("a''b''c");
  });

  it('coerces non-string input to string', () => {
    expect(escapeODataString(42 as unknown as string)).toBe('42');
  });
});

describe('buildSenderContainsFilter', () => {
  it('produces a contains() filter against from/emailAddress/address', () => {
    expect(buildSenderContainsFilter('bruno@pinheiromonteiro.com.br')).toBe(
      "contains(from/emailAddress/address,'bruno@pinheiromonteiro.com.br')"
    );
  });

  it('escapes single quotes in the sender value', () => {
    expect(buildSenderContainsFilter("o'brien@example.com")).toBe(
      "contains(from/emailAddress/address,'o''brien@example.com')"
    );
  });

  it('uses contains (not eq) so callers get case-insensitive matching', () => {
    // Regression guard for JAR-257 bug #1: `eq` is case-sensitive on Graph,
    // which made `--sender=bruno@x.com` silently return 0 results when the
    // address was stored with different casing. Anyone reverting this to
    // `eq` should fail this test.
    expect(buildSenderContainsFilter('X')).not.toMatch(/\beq\b/);
    expect(buildSenderContainsFilter('X')).toMatch(/^contains\(/);
  });
});
