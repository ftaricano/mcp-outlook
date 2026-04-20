import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '../../src/schemas/jsonSchemaFromZod.js';

describe('getToolSchemas', () => {
  const entries = getToolSchemas();

  it('returns exactly 39 tool entries', () => {
    expect(entries.length).toBe(39);
  });

  it('every entry has a non-empty name and description', () => {
    for (const entry of entries) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("every entry has inputSchema with type === 'object'", () => {
    for (const entry of entries) {
      expect(entry.inputSchema).toBeDefined();
      expect(entry.inputSchema.type).toBe('object');
    }
  });

  it('names are unique', () => {
    const names = entries.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(entries.length);
  });

  it('send_email has required=[to, subject, body]', () => {
    const send = entries.find((e) => e.name === 'send_email');
    expect(send).toBeDefined();
    const required = send!.inputSchema.required;
    expect(required).toEqual(expect.arrayContaining(['to', 'subject', 'body']));
  });

  it('list_emails inputSchema has properties', () => {
    const list = entries.find((e) => e.name === 'list_emails');
    expect(list).toBeDefined();
    expect(list!.inputSchema.properties).toBeDefined();
    expect(list!.inputSchema.properties.limit).toBeDefined();
  });

  it('every expected tool name is present', () => {
    const expected = [
      'list_emails',
      'send_email',
      'reply_to_email',
      'mark_as_read',
      'mark_as_unread',
      'delete_email',
      'summarize_email',
      'summarize_emails_batch',
      'list_users',
      'list_attachments',
      'download_attachment',
      'download_attachment_to_file',
      'download_all_attachments',
      'list_downloaded_files',
      'get_download_directory_info',
      'cleanup_old_downloads',
      'export_email_as_attachment',
      'encode_file_for_attachment',
      'send_email_from_attachment',
      'send_email_with_file',
      'list_folders',
      'create_folder',
      'move_emails_to_folder',
      'copy_emails_to_folder',
      'delete_folder',
      'get_folder_stats',
      'organize_emails_by_rules',
      'advanced_search',
      'search_by_sender_domain',
      'search_by_attachment_type',
      'find_duplicate_emails',
      'search_by_size',
      'saved_searches',
      'batch_mark_as_read',
      'batch_mark_as_unread',
      'batch_delete_emails',
      'batch_move_emails',
      'batch_download_attachments',
      'email_cleanup_wizard'
    ];
    const names = entries.map((e) => e.name);
    for (const tool of expected) {
      expect(names).toContain(tool);
    }
  });
});
