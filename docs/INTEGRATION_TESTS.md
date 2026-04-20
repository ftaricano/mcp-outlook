# Integration Tests (manual)

The unit suite (`npm test`) covers pure logic and MCP protocol framing. It does **not** make real Microsoft Graph calls. This document tracks the integration checks that must be run manually against a live Azure tenant before shipping.

## Prerequisites

- A dedicated **test** Azure AD tenant or mailbox. Never point these at a production mailbox.
- Azure AD app with the permissions listed in [README](../README.md#azure-ad-permissions-application--client-credentials).
- Admin consent granted.
- `.env` populated with the test credentials and `TARGET_USER_EMAIL` pointing at the test mailbox.

Build once:

```bash
npm run build
```

## Matrix

Tick each box after manual execution. Attach the log line you saw (or record it in the PR description).

### Auth

- [ ] Server starts with valid credentials (`npm start` — watch stderr for `server ready`).
- [ ] Server starts with invalid tenant/client and fails auth validation but keeps accepting MCP requests. Tool calls should return a clean `Authentication failed` message, not crash.
- [ ] Server refuses to start when any required env var is missing.

### Email (9 tools)

- [ ] `list_emails` with `{limit: 5}` — returns up to 5 entries.
- [ ] `list_emails` with folder=`sentitems` — returns sent items.
- [ ] `send_email` plaintext to the test mailbox — arrives.
- [ ] `send_email` with `useTemplate: true, templateTheme: 'corporate'` — HTML template rendered.
- [ ] `send_email` with 1 MB base64 PDF attachment — attachment non-zero, file opens.
- [ ] `reply_to_email` — threading preserved.
- [ ] `mark_as_read` / `mark_as_unread` round-trip visible in Outlook.
- [ ] `delete_email` moves to Deleted Items; passing `permanent:true` (where supported) purges.
- [ ] `summarize_email` returns priority/category/sentiment.
- [ ] `summarize_emails_batch` with `priorityOnly:true`.

### Attachments (9 tools)

- [ ] `list_attachments` on a multi-attachment email.
- [ ] `download_attachment` returns base64 that decodes to the original file.
- [ ] `download_attachment_to_file` writes to disk; MD5/SHA256 validated.
- [ ] `download_all_attachments` with `maxConcurrent:3`.
- [ ] `list_downloaded_files` and `get_download_directory_info` report the expected set.
- [ ] `cleanup_old_downloads` with `dryRun:true` shows candidates, then real run removes them.
- [ ] `export_email_as_attachment` produces a `.eml` that re-imports cleanly.
- [ ] `encode_file_for_attachment` base64 length matches original size * 4/3 ± padding.

### Hybrid (2 tools)

- [ ] `send_email_from_attachment` — attachment round-trip through disk, arrives intact.
- [ ] `send_email_with_file` — large (>3 MB) file attaches successfully.

### Folders (7 tools)

- [ ] `list_folders` with subfolders.
- [ ] `create_folder` / `delete_folder` round-trip.
- [ ] `move_emails_to_folder` and `copy_emails_to_folder` on a batch of 3.
- [ ] `get_folder_stats` numbers match Outlook.
- [ ] `organize_emails_by_rules` with `dryRun:true` then real run.

### Search (6 tools)

- [ ] `advanced_search` with multiple filters (sender + date range + hasAttachments).
- [ ] `search_by_sender_domain` with `includeSubdomains:true`.
- [ ] `search_by_attachment_type` for `['pdf','xlsx']`.
- [ ] `find_duplicate_emails` returns known duplicates.
- [ ] `search_by_size` with min/max MB.
- [ ] `saved_searches` save → list → execute → delete.

### Batch (6 tools)

- [ ] `batch_mark_as_read` on 10 ids.
- [ ] `batch_mark_as_unread` on 10 ids.
- [ ] `batch_delete_emails` on 5 ids, `permanent:false`.
- [ ] `batch_move_emails` on 10 ids.
- [ ] `batch_download_attachments` on 5 emails with `sizeLimit:25`.
- [ ] `email_cleanup_wizard` with `dryRun:true`.

## Rate limiting

- [ ] Run any batch at `maxConcurrent: 10` and verify no 429 errors (or that the rate limiter retries with backoff instead of surfacing them).

## Shutdown

- [ ] `SIGTERM` triggers graceful shutdown within 5 seconds, releases the lock file.

## Automation follow-up

A future change should introduce Playwright-style end-to-end tests that hit a sandbox tenant in CI. The blocker today is credential management — until we have a secret store and a scratch tenant wired into GitHub Actions, this checklist is the contract.
