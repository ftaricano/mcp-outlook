/**
 * Outbound sender policy.
 *
 * With application-permission credentials, a Graph token can send as *any*
 * mailbox in the tenant. "Which mailbox do we send as" is therefore an
 * authorization decision, not a routing detail, and both outbound paths
 * (`sendMail` and `reply`/`replyAll`) pass through this single gate.
 *
 * Defence in depth only. The authoritative restriction is an Exchange
 * `ApplicationAccessPolicy` bound to a send-only app registration: a process
 * that can edit its own environment can widen this allowlist, but it cannot
 * widen what Graph itself accepts. Deployments that care about the guarantee
 * must do both.
 */

import { z } from 'zod';

export class SenderNotAllowedError extends Error {
  // The message deliberately names no environment variable. Every error
  // crossing the MCP boundary passes through `redactSecrets`, whose catch-all
  // rule masks any 20+ character identifier — `OUTLOOK_ALLOWED_SENDERS` is 22,
  // so naming it would print `[token]` and tell the operator nothing. Weakening
  // that rule to make one message prettier is the wrong trade; "outbound sender
  // allowlist" survives redaction and is greppable in README and CLAUDE.md.
  constructor(public readonly sender: string) {
    super(`Sender not allowed: ${sender} is not in the outbound sender allowlist`);
    this.name = 'SenderNotAllowedError';
  }
}

export class SenderPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderPolicyError';
  }
}

// Deliberately the same validator `env.ts` applies to TARGET_USER_EMAIL rather
// than a hand-rolled shape. A looser pattern here would let `a@b.c/../victim`
// or `a@b.c?$select=1` through a module whose whole job is authorization, and
// those values are interpolated straight into a Graph URL segment.
const emailSchema = z.string().email();

function isEmailAddress(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

/**
 * Parse a comma-separated allowlist. Entries are lowercased and de-duplicated.
 *
 * An *absent* value means "unrestricted" — the pre-existing behaviour, and the
 * only sensible default for a public repo that cannot carry a deployment's
 * addresses (invariant 9). A value that is *present but yields no entries*
 * (`" "`, `","`, `",,,"`) is an operator mistake, not consent to send from
 * anywhere, so it fails loudly. Collapsing the two would make the one input
 * that looks like "the gate is on" behave as "the gate is off", silently.
 *
 * The errors report a count rather than the offending values: a malformed
 * allowlist is a config mistake, and echoing its contents would put deployment
 * addresses into whatever captured the error.
 */
export function parseAllowedSenders(raw: string | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);

  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (entries.length === 0) {
    // An empty string is how "unset" reaches us from a shell that exports the
    // variable without a value, so it keeps the unrestricted meaning. Anything
    // the operator actually typed does not.
    if (raw === '') return Object.freeze([]);
    throw new SenderPolicyError(
      'OUTLOOK_ALLOWED_SENDERS is set but contains no addresses; unset it to allow every mailbox'
    );
  }

  const invalid = entries.filter((entry) => !isEmailAddress(entry)).length;
  if (invalid > 0) {
    throw new SenderPolicyError(
      `OUTLOOK_ALLOWED_SENDERS must be a comma-separated list of email addresses; ${invalid} entry/entries are not valid addresses`
    );
  }

  return Object.freeze([...new Set(entries)]);
}

export class RecipientNotAllowedError extends Error {
  // Names no variable, for the same redaction reason as SenderNotAllowedError.
  constructor(public readonly count: number) {
    super(`Recipients not allowed: ${count} address(es) outside the recipient domain allowlist`);
    this.name = 'RecipientNotAllowedError';
  }
}

export class ReplyDisabledError extends Error {
  // Replying is refused wholesale while a recipient allowlist is set, so this
  // is not a recipient-count failure. Reusing RecipientNotAllowedError(0) here
  // printed "0 address(es) outside the allowlist" alongside a refusal, which
  // reads as a contradiction and hides the actual rule.
  constructor() {
    super('Reply is disabled while an outbound recipient domain allowlist is set');
    this.name = 'ReplyDisabledError';
  }
}

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Parse a comma-separated recipient domain allowlist.
 *
 * Same absent/empty distinction as `parseAllowedSenders`: absent is
 * unrestricted, set-but-empty is an operator mistake and refuses to start.
 *
 * Matching is on the exact domain after `@`. A subdomain does not inherit its
 * parent — `evil.example.com` is not covered by `example.com`. That is the
 * conservative reading, and the one that matters: an attacker who can create a
 * subdomain under a listed domain should not thereby become a valid recipient.
 */
export function parseAllowedRecipientDomains(raw: string | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);

  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  if (entries.length === 0) {
    if (raw === '') return Object.freeze([]);
    throw new SenderPolicyError(
      'OUTLOOK_ALLOWED_RECIPIENT_DOMAINS is set but contains no domains; unset it to allow every recipient'
    );
  }

  const invalid = entries.filter((entry) => !DOMAIN_PATTERN.test(entry)).length;
  if (invalid > 0) {
    throw new SenderPolicyError(
      `OUTLOOK_ALLOWED_RECIPIENT_DOMAINS must be a comma-separated list of domains; ${invalid} entry/entries are not valid domains`
    );
  }

  return Object.freeze([...new Set(entries)]);
}

export interface SenderPolicyOptions {
  readonly sendFrom?: string;
  readonly allowedSenders?: string;
  readonly allowedRecipientDomains?: string;
}

export class SenderPolicy {
  private readonly sendFrom: string | undefined;
  private readonly allowed: readonly string[];
  private readonly allowedRecipientDomains: readonly string[];

  constructor(options: SenderPolicyOptions = {}, source: NodeJS.ProcessEnv = process.env) {
    const sendFrom = (options.sendFrom ?? source.OUTLOOK_SEND_FROM)?.trim();
    if (sendFrom && !isEmailAddress(sendFrom.toLowerCase())) {
      throw new SenderPolicyError('OUTLOOK_SEND_FROM must be a valid email address');
    }

    this.sendFrom = sendFrom || undefined;
    this.allowed = parseAllowedSenders(options.allowedSenders ?? source.OUTLOOK_ALLOWED_SENDERS);
    this.allowedRecipientDomains = parseAllowedRecipientDomains(
      options.allowedRecipientDomains ?? source.OUTLOOK_ALLOWED_RECIPIENT_DOMAINS
    );
    Object.freeze(this);
  }

  get restricted(): boolean {
    return this.allowed.length > 0;
  }

  get restrictsRecipients(): boolean {
    return this.allowedRecipientDomains.length > 0;
  }

  /**
   * Authorize the full recipient set of an outbound message.
   *
   * Pinning the sender defeats impersonation; this defeats exfiltration, which
   * is the larger risk wherever the caller composing the message may be acting
   * on untrusted content. All three recipient classes are checked together —
   * bcc is the one an inattentive reviewer misses, and the one an attacker
   * would reach for.
   */
  assertRecipients(recipients: readonly (readonly string[] | undefined)[]): void {
    if (this.allowedRecipientDomains.length === 0) return;

    const addresses = recipients.flatMap((group) => group ?? []);
    const rejected = addresses.filter((address) => {
      const domain = address.trim().toLowerCase().split('@').pop() ?? '';
      return !this.allowedRecipientDomains.includes(domain);
    });

    if (rejected.length > 0) throw new RecipientNotAllowedError(rejected.length);
  }

  /**
   * Resolve the mailbox a new outbound message must be sent from.
   *
   * `OUTLOOK_SEND_FROM` wins over the service's reading mailbox so one process
   * can read `reports@` and send as `noreply@` without switching a
   * process-global value mid-flight.
   */
  resolveSendMailbox(readingMailbox: string | undefined): string {
    return this.enforce(this.sendFrom ?? readingMailbox);
  }

  /**
   * Authorize a reply sent from `mailbox`.
   *
   * Unlike a new message, a reply is bound to the mailbox that owns the
   * original message — redirecting it would point at a message id that does
   * not exist in the other mailbox. So `OUTLOOK_SEND_FROM` does not apply
   * here: the allowlist can only permit or refuse. Replying out of a mailbox
   * *is* sending as its owner.
   */
  assertReplyMailbox(mailbox: string | undefined): string {
    return this.enforce(mailbox);
  }

  private enforce(mailbox: string | undefined): string {
    const sender = mailbox?.trim() || 'me';
    if (this.allowed.length === 0) return sender;

    // `me` is resolved server-side from the token. Under app-only credentials
    // it never names a real mailbox, so it cannot be matched against the
    // allowlist — and a restricted deployment must not fall through it.
    if (sender === 'me') throw new SenderNotAllowedError('me');

    if (!this.allowed.includes(sender.toLowerCase())) {
      throw new SenderNotAllowedError(sender);
    }
    return sender;
  }
}
