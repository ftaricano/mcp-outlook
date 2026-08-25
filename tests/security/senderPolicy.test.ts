import { describe, expect, it } from 'vitest';
import {
  parseAllowedSenders,
  SenderNotAllowedError,
  SenderPolicy,
  SenderPolicyError,
} from '../../src/security/senderPolicy.js';

describe('parseAllowedSenders', () => {
  it('treats an absent value as unrestricted', () => {
    expect(parseAllowedSenders(undefined)).toEqual([]);
  });

  it('treats an empty string as unset, the shell idiom for it', () => {
    expect(parseAllowedSenders('')).toEqual([]);
  });

  // The dangerous case: a value that *looks* configured but parses to nothing.
  // Treating it as unrestricted would make the one input an operator reads as
  // "the gate is on" behave as "the gate is off", with no error and no log.
  it.each([' ', ',', ',,,', '   ,  ,', '\t', '\n'])(
    'refuses to start when the allowlist is set but yields no addresses: %j',
    (raw) => {
      expect(() => parseAllowedSenders(raw)).toThrow(SenderPolicyError);
    }
  );

  it('normalizes case, whitespace and duplicates', () => {
    expect(parseAllowedSenders(' Reports@Example.com , reports@example.com ,ops@example.com')).toEqual(
      ['reports@example.com', 'ops@example.com']
    );
  });

  it.each([
    'a@b.c/../../users/victim',
    'a@b.c/x',
    'a@b.c?$select=1',
    '<a@b.c>',
    'a@b.c#frag',
  ])('rejects an address that could escape a Graph URL segment: %j', (entry) => {
    expect(() => parseAllowedSenders(entry)).toThrow(SenderPolicyError);
  });

  it('rejects entries that are not email addresses without echoing them', () => {
    let thrown: unknown;
    try {
      parseAllowedSenders('reports@example.com,not-an-address');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SenderPolicyError);
    expect((thrown as Error).message).toContain('1 entry/entries');
    expect((thrown as Error).message).not.toContain('not-an-address');
  });
});

describe('SenderPolicy without an allowlist', () => {
  it('keeps the pre-existing behaviour of sending from the reading mailbox', () => {
    const policy = new SenderPolicy({}, {});
    expect(policy.restricted).toBe(false);
    expect(policy.resolveSendMailbox('anyone@example.com')).toBe('anyone@example.com');
    expect(policy.assertReplyMailbox('anyone@example.com')).toBe('anyone@example.com');
  });

  it('falls back to me when no mailbox is pinned', () => {
    const policy = new SenderPolicy({}, {});
    expect(policy.resolveSendMailbox(undefined)).toBe('me');
  });

  it('still honours an explicit send-from override', () => {
    const policy = new SenderPolicy({ sendFrom: 'reports@example.com' }, {});
    expect(policy.resolveSendMailbox('inbox@example.com')).toBe('reports@example.com');
  });
});

describe('SenderPolicy with an allowlist', () => {
  const allowedSenders = 'reports@example.com';

  it('permits an allowlisted reading mailbox', () => {
    const policy = new SenderPolicy({ allowedSenders }, {});
    expect(policy.restricted).toBe(true);
    expect(policy.resolveSendMailbox('reports@example.com')).toBe('reports@example.com');
  });

  it('matches case-insensitively', () => {
    const policy = new SenderPolicy({ allowedSenders }, {});
    expect(policy.resolveSendMailbox('Reports@Example.com')).toBe('Reports@Example.com');
  });

  it('refuses a mailbox outside the allowlist', () => {
    const policy = new SenderPolicy({ allowedSenders }, {});
    expect(() => policy.resolveSendMailbox('owner@example.com')).toThrow(SenderNotAllowedError);
  });

  it('refuses the me fallback, which app-only credentials cannot resolve', () => {
    const policy = new SenderPolicy({ allowedSenders }, {});
    expect(() => policy.resolveSendMailbox(undefined)).toThrow(SenderNotAllowedError);
  });

  it('lets send-from redirect a non-allowlisted reading mailbox to an allowed sender', () => {
    const policy = new SenderPolicy({ sendFrom: 'reports@example.com', allowedSenders }, {});
    expect(policy.resolveSendMailbox('invoices@example.com')).toBe('reports@example.com');
  });

  it('refuses a send-from that is not itself allowlisted', () => {
    const policy = new SenderPolicy({ sendFrom: 'owner@example.com', allowedSenders }, {});
    expect(() => policy.resolveSendMailbox('reports@example.com')).toThrow(SenderNotAllowedError);
  });

  it('never redirects a reply, because a reply belongs to its own mailbox', () => {
    const policy = new SenderPolicy({ sendFrom: 'reports@example.com', allowedSenders }, {});
    expect(() => policy.assertReplyMailbox('owner@example.com')).toThrow(SenderNotAllowedError);
  });

  it('reads both knobs from the environment', () => {
    const policy = new SenderPolicy(
      {},
      { OUTLOOK_SEND_FROM: 'reports@example.com', OUTLOOK_ALLOWED_SENDERS: allowedSenders }
    );
    expect(policy.resolveSendMailbox('invoices@example.com')).toBe('reports@example.com');
  });

  it('cannot be widened after construction', () => {
    const policy = new SenderPolicy({ allowedSenders }, {});
    expect(() => {
      (policy as unknown as { allowed: string[] }).allowed = ['owner@example.com'];
    }).toThrow();
    expect(() => policy.resolveSendMailbox('owner@example.com')).toThrow(SenderNotAllowedError);
  });
});

describe('SenderNotAllowedError message', () => {
  it('survives the boundary redactor, which masks any 20+ char identifier', async () => {
    const { redactSecrets } = await import('../../src/utils/redactSecrets.js');
    const policy = new SenderPolicy({ allowedSenders: 'reports@example.com' }, {});

    let message = '';
    try {
      policy.resolveSendMailbox('owner@example.com');
    } catch (error) {
      message = (error as Error).message;
    }

    // Naming OUTLOOK_ALLOWED_SENDERS (22 chars) would print as `[token]` and
    // leave the operator with no idea which knob refused the send.
    expect(redactSecrets(message)).toContain('is not in the outbound sender allowlist');
    expect(redactSecrets(message)).not.toContain('[token]');
  });
});

describe('SenderPolicy configuration errors', () => {
  it('rejects a malformed send-from', () => {
    expect(() => new SenderPolicy({ sendFrom: 'not-an-address' }, {})).toThrow(SenderPolicyError);
  });
});
