import { describe, it, expect } from 'vitest';
import { validateToolInput, toolSchemas } from '../../src/schemas/toolSchemas.js';

/**
 * Happy-path smoke tests: a minimal valid input for each tool should validate.
 * This catches regressions where a schema accidentally becomes too strict.
 */
const happyInputs: Record<string, unknown> = {
  list_emails: { limit: 10 },
  send_email: { to: ['a@b.com'], subject: 'Hi', body: 'Body text' },
  create_draft: { to: ['a@b.com'], subject: 'Draft', body: 'Draft body' },
  reply_to_email: { emailId: 'abc123', body: 'Reply' },
  mark_as_read: { emailId: 'abc123' },
  mark_as_unread: { emailId: 'abc123' },
  delete_email: { emailId: 'abc123' },
  summarize_email: { emailId: 'abc123' },
  summarize_emails_batch: { limit: 5 },
  list_users: { limit: 10 },
  list_attachments: { emailId: 'abc123' },
  download_attachment: { emailId: 'abc123', attachmentId: 'att1' },
  download_attachment_to_file: { emailId: 'abc123', attachmentId: 'att1' },
  download_all_attachments: { emailId: 'abc123' },
  list_downloaded_files: {},
  get_download_directory_info: {},
  cleanup_old_downloads: { daysOld: 7, dryRun: true },
  export_email_as_attachment: { emailId: 'abc123', format: 'eml' },
  encode_file_for_attachment: { filePath: '/tmp/foo.pdf' },
  send_email_from_attachment: {
    sourceEmailId: 'src1',
    attachmentId: 'att1',
    to: ['a@b.com'],
    subject: 'Fwd',
    body: 'See attached'
  },
  send_email_with_file: {
    filePath: '/tmp/foo.pdf',
    to: ['a@b.com'],
    subject: 'File',
    body: 'See attached'
  },
  list_folders: { includeSubfolders: true, maxDepth: 3 },
  create_folder: { folderName: 'MyFolder' },
  move_emails_to_folder: { emailIds: 'id1', targetFolderId: 'f1' },
  copy_emails_to_folder: { emailIds: ['id1', 'id2'], targetFolderId: 'f1' },
  delete_folder: { folderId: 'f1' },
  get_folder_stats: { folderId: 'f1' },
  organize_emails_by_rules: { sourceFolderId: 'inbox', dryRun: true },
  advanced_search: { query: 'hello', maxResults: 10 },
  search_by_sender_domain: { domain: 'acme.com' },
  search_by_attachment_type: { fileTypes: 'pdf' },
  find_duplicate_emails: { criteria: 'subject' },
  search_by_size: { minSizeMB: 1, maxSizeMB: 5 },
  saved_searches: { action: 'list' },
  batch_mark_as_read: { emailIds: ['id1', 'id2'] },
  batch_mark_as_unread: { emailIds: 'id1' },
  batch_delete_emails: { emailIds: ['id1'], permanent: false },
  batch_move_emails: { emailIds: ['id1'], targetFolderId: 'f1' },
  batch_download_attachments: { emailIds: ['id1'] },
  email_cleanup_wizard: { dryRun: true, olderThanDays: 30 }
};

describe('validateToolInput - happy path', () => {
  for (const toolName of Object.keys(toolSchemas)) {
    it(`accepts a minimal valid input for ${toolName}`, () => {
      const input = happyInputs[toolName];
      expect(input, `missing happy input for ${toolName}`).toBeDefined();
      const result = validateToolInput(toolName, input);
      if (!result.ok) {
        throw new Error(`Expected ok for ${toolName}, got: ${result.error}`);
      }
      expect(result.ok).toBe(true);
    });
  }

  it('covers all 40 tools registered', () => {
    expect(Object.keys(toolSchemas).length).toBe(40);
    // Every registered tool has a happy-path input.
    for (const toolName of Object.keys(toolSchemas)) {
      expect(happyInputs, `${toolName} missing happy input`).toHaveProperty(toolName);
    }
  });
});

describe('validateToolInput - realistic second inputs', () => {
  it('send_email accepts cc/bcc/attachments/template', () => {
    const r = validateToolInput('send_email', {
      to: ['a@b.com', 'c@d.com'],
      subject: 'Test',
      body: '<p>Hi</p>',
      cc: ['cc@x.com'],
      bcc: ['bcc@y.com'],
      useTemplate: true,
      templateTheme: 'corporate',
      attachments: [
        { name: 'f.pdf', contentType: 'application/pdf', content: 'AAAA' }
      ]
    });
    expect(r.ok).toBe(true);
  });

  it('send_email preserves template customization fields (regression)', () => {
    // Regression: zod strip default was silently dropping companyName, logoUrl,
    // emailTitle and signature before they reached EmailHandler. The handler
    // then passed undefined into the rendered template.
    const r = validateToolInput('send_email', {
      to: ['a@b.com'],
      subject: 'Brand check',
      body: '<p>Hi</p>',
      useTemplate: true,
      templateTheme: 'corporate',
      companyName: 'ACME',
      logoUrl: 'https://example.com/logo.png',
      emailTitle: 'Quarterly update',
      signature: '— Team ACME'
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.companyName).toBe('ACME');
      expect(r.data.logoUrl).toBe('https://example.com/logo.png');
      expect(r.data.emailTitle).toBe('Quarterly update');
      expect(r.data.signature).toBe('— Team ACME');
    }
  });

  it('create_draft preserves template customization fields (regression)', () => {
    const r = validateToolInput('create_draft', {
      to: ['a@b.com'],
      subject: 'Draft brand check',
      body: '<p>Hi</p>',
      useTemplate: true,
      templateTheme: 'professional',
      companyName: 'ACME',
      logoUrl: 'https://example.com/logo.png',
      emailTitle: 'Draft title',
      signature: '— Team'
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.companyName).toBe('ACME');
      expect(r.data.logoUrl).toBe('https://example.com/logo.png');
      expect(r.data.emailTitle).toBe('Draft title');
      expect(r.data.signature).toBe('— Team');
    }
  });

  it('advanced_search accepts all filters', () => {
    const r = validateToolInput('advanced_search', {
      query: 'x',
      sender: 'a@b.com',
      subject: 'Re:',
      dateFrom: '2024-01-01T00:00:00Z',
      dateTo: '2024-12-31T23:59:59Z',
      hasAttachments: true,
      isRead: false,
      folder: 'inbox',
      maxResults: 50,
      sortBy: 'receivedDateTime',
      sortOrder: 'desc'
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateToolInput - negative cases', () => {
  it('rejects missing required field `to` in send_email', () => {
    const r = validateToolInput('send_email', { subject: 'x', body: 'y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/to/);
  });

  it('rejects invalid email in send_email.to', () => {
    const r = validateToolInput('send_email', {
      to: ['not-an-email'],
      subject: 'x',
      body: 'y'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toMatch(/email/);
  });

  it('rejects empty to array', () => {
    const r = validateToolInput('send_email', { to: [], subject: 'x', body: 'y' });
    expect(r.ok).toBe(false);
  });

  it('rejects list_emails.limit > 50', () => {
    const r = validateToolInput('list_emails', { limit: 999 });
    expect(r.ok).toBe(false);
  });

  it('rejects list_emails.limit negative', () => {
    const r = validateToolInput('list_emails', { limit: -1 });
    expect(r.ok).toBe(false);
  });

  it('rejects wrong enum in saved_searches.action', () => {
    const r = validateToolInput('saved_searches', { action: 'bogus' });
    expect(r.ok).toBe(false);
  });

  it('rejects wrong enum in send_email.templateTheme', () => {
    const r = validateToolInput('send_email', {
      to: ['a@b.com'],
      subject: 'x',
      body: 'y',
      useTemplate: true,
      templateTheme: 'neon'
    });
    expect(r.ok).toBe(false);
  });

  it('rejects batch_delete_emails array over max of 50', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id${i}`);
    const r = validateToolInput('batch_delete_emails', { emailIds: ids });
    expect(r.ok).toBe(false);
  });

  it('rejects missing emailId in mark_as_read', () => {
    const r = validateToolInput('mark_as_read', {});
    expect(r.ok).toBe(false);
  });

  it('rejects empty string emailId in mark_as_read', () => {
    const r = validateToolInput('mark_as_read', { emailId: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects negative daysOld in cleanup_old_downloads', () => {
    const r = validateToolInput('cleanup_old_downloads', { daysOld: -5 });
    expect(r.ok).toBe(false);
  });

  it('rejects 0 maxDepth in list_folders (must be positive int)', () => {
    const r = validateToolInput('list_folders', { maxDepth: 0 });
    expect(r.ok).toBe(false);
  });

  it('returns ok:false with Unknown tool for unregistered names', () => {
    const r = validateToolInput('not_a_real_tool', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown tool/);
  });
});
