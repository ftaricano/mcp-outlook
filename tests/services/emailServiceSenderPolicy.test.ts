import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/services/emailService.js';
import {
  RecipientNotAllowedError,
  SenderNotAllowedError,
  SenderPolicy,
} from '../../src/security/senderPolicy.js';

function makeService(targetUserEmail: string | undefined, senderPolicy: SenderPolicy) {
  const posts: Array<{ path: string; payload: unknown }> = [];
  const chain = (path: string): any => ({
    select: () => chain(path),
    get: async () => ({ id: 'message', body: { content: '' } }),
    post: async (payload: unknown) => {
      posts.push({ path, payload });
      return { id: 'sent-id' };
    },
  });

  const authProvider = {
    getGraphClient: () => ({ api: (path: string) => chain(path) }),
  };
  const pathGuard = {
    getDownloadRoot: () => '/tmp',
    getUploadRoots: () => ['/tmp'],
  };

  const service = new EmailService(authProvider as never, pathGuard as never, {
    targetUserEmail,
    preloadCache: false,
    ensureDownloadDirectory: false,
    senderPolicy,
  });

  return { service, posts };
}

const ALLOWED = 'reports@example.com';

describe('EmailService outbound sender gate', () => {
  it('sends from the allowlisted mailbox', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService(ALLOWED, policy);

    await service.sendEmail(['someone@example.com'], 'Report', 'Body');

    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/users/${ALLOWED}/sendMail`);
  });

  it('redirects the outbound mailbox when send-from is pinned', async () => {
    const policy = new SenderPolicy({ sendFrom: ALLOWED, allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService('invoices@example.com', policy);

    await service.sendEmail(['someone@example.com'], 'Report', 'Body');

    expect(posts[0].path).toBe(`/users/${ALLOWED}/sendMail`);
  });

  it('refuses to send from a mailbox outside the allowlist, without calling Graph', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService('owner@example.com', policy);

    await expect(service.sendEmail(['someone@example.com'], 'Report', 'Body')).rejects.toThrow(
      SenderNotAllowedError
    );
    expect(posts).toHaveLength(0);
  });

  it('surfaces the refusal as SenderNotAllowedError, not as a generic send failure', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service } = makeService('owner@example.com', policy);

    const error = await service
      .sendEmail(['someone@example.com'], 'Report', 'Body')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SenderNotAllowedError);
    expect((error as Error).message).not.toContain('Falha ao enviar email');
  });

  it('refuses to reply out of a mailbox outside the allowlist', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService('owner@example.com', policy);

    await expect(service.replyToEmail('message-1', 'Body')).rejects.toThrow(SenderNotAllowedError);
    expect(posts).toHaveLength(0);
  });

  it('does not let send-from redirect a reply into the allowed mailbox', async () => {
    const policy = new SenderPolicy({ sendFrom: ALLOWED, allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService('owner@example.com', policy);

    await expect(service.replyToEmail('message-1', 'Body')).rejects.toThrow(SenderNotAllowedError);
    expect(posts).toHaveLength(0);
  });

  it('refuses the hybrid attachment send before the attachment is downloaded', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service } = makeService('owner@example.com', policy);
    // The pre-gate exists to avoid pulling a multi-megabyte attachment for a
    // send that cannot happen. Asserting only that it throws would keep passing
    // if someone moved the gate below the download, which is the whole point.
    const download = vi.spyOn(service, 'downloadAttachmentToFile');

    await expect(
      service.sendEmailFromAttachment('msg-1', 'att-1', ['someone@example.com'], 'S', 'B')
    ).rejects.toThrow(SenderNotAllowedError);
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses the hybrid file send before the file is read', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service } = makeService('owner@example.com', policy);

    await expect(
      service.sendEmailWithFileAttachment('/tmp/nope.pdf', ['someone@example.com'], 'S', 'B')
    ).rejects.toThrow(SenderNotAllowedError);
  });

  it('leaves drafts unrestricted, so any mailbox can still stage a message', async () => {
    const policy = new SenderPolicy({ allowedSenders: ALLOWED }, {});
    const { service, posts } = makeService('owner@example.com', policy);

    await service.createDraft(['someone@example.com'], 'Draft', 'Body');

    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/users/owner@example.com/messages');
  });

  it('keeps sending unrestricted when no allowlist is configured', async () => {
    const policy = new SenderPolicy({}, {});
    const { service, posts } = makeService('owner@example.com', policy);

    await service.sendEmail(['someone@example.com'], 'Report', 'Body');

    expect(posts[0].path).toBe('/users/owner@example.com/sendMail');
  });
});

describe('EmailService recipient gate', () => {
  const policyOptions = { allowedSenders: ALLOWED, allowedRecipientDomains: 'example.com' };

  it('sends when every recipient is inside an allowed domain', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await service.sendEmail(['ok@example.com'], 'S', 'B', ['cc@example.com']);

    expect(posts).toHaveLength(1);
  });

  it('refuses an outside recipient without calling Graph', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await expect(service.sendEmail(['leak@evil.test'], 'S', 'B')).rejects.toThrow(
      RecipientNotAllowedError
    );
    expect(posts).toHaveLength(0);
  });

  it('refuses an outside bcc even when to and cc are clean', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await expect(
      service.sendEmail(['ok@example.com'], 'S', 'B', ['cc@example.com'], ['leak@evil.test'])
    ).rejects.toThrow(RecipientNotAllowedError);
    expect(posts).toHaveLength(0);
  });

  it('refuses replying at all, since a reply inherits recipients from untrusted content', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await expect(service.replyToEmail('message-1', 'Body')).rejects.toThrow(
      RecipientNotAllowedError
    );
    expect(posts).toHaveLength(0);
  });

  it('still allows replying when no recipient allowlist is configured', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy({ allowedSenders: ALLOWED }, {}));

    await service.replyToEmail('message-1', 'Body');

    expect(posts).toHaveLength(1);
  });

  it('refuses the hybrid file send before the file is read', async () => {
    const { service } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await expect(
      service.sendEmailWithFileAttachment('/tmp/nope.pdf', ['leak@evil.test'], 'S', 'B')
    ).rejects.toThrow(RecipientNotAllowedError);
  });

  it('leaves drafts unrestricted, so a human can still be handed an outside message', async () => {
    const { service, posts } = makeService(ALLOWED, new SenderPolicy(policyOptions, {}));

    await service.createDraft(['outside@evil.test'], 'Draft', 'Body');

    expect(posts).toHaveLength(1);
  });
});
