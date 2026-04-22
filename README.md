# MCP Email Server

Production-grade MCP (Model Context Protocol) server for Microsoft Outlook / Exchange via Microsoft Graph API. Exposes **40 email tools** over stdio — send, draft, search, organize, batch, and handle attachments (including large-file hybrid flows that sidestep MCP token limits).

## Status

| Metric | Value |
|---|---|
| Tools | 40 |
| Tests | 145 passing (8 files) |
| Coverage | ~93% on scoped modules |
| Node | >=20 |
| MCP SDK | ^1.29.0 |
| License | MIT |

## Architecture

```
src/
  config/env.ts            # zod-validated environment (fail-fast on startup)
  auth/graphAuth.ts        # MSAL client-credentials token provider
  services/emailService.ts # Microsoft Graph wrapper (large — split pending)
  schemas/toolSchemas.ts   # zod schemas for all 40 tool inputs
  handlers/*.ts            # one handler class per tool domain
  handlers/HandlerRegistry # runtime input validation + dispatch
  logging/logger.ts        # minimal stderr JSON logger
  security/securityManager # audit / permission checks
  templates/               # HTML email templates
  utils/                   # rate limiter, file manager, validators
```

Runtime flow:

1. `loadEnv()` parses and validates process.env (zod). Missing or malformed credentials exit immediately with a clear message.
2. `GraphAuthProvider` lazily acquires tokens via MSAL and refreshes 60s before expiry.
3. MCP requests enter `HandlerRegistry.handleTool(name, args)` which runs `validateToolInput` (zod) before dispatching to a domain handler.
4. Handlers call into `EmailService`, which wraps the Graph client with rate limiting, caching, and batching.

## Install

```bash
npm install
npm run build
```

Requires Node 20 or 22.

## Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `MICROSOFT_GRAPH_CLIENT_ID` | yes | Azure AD application (client) UUID |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | yes | Client secret (store securely) |
| `MICROSOFT_GRAPH_TENANT_ID` | yes | Azure AD tenant UUID |
| `TARGET_USER_EMAIL` | no | Mailbox to operate on (client-credentials flow) |
| `LOG_LEVEL` | no | `error` / `warn` / `info` (default) / `debug` |
| `MCP_SERVER_NAME` | no | Defaults to `mcp-email-server` |
| `DOWNLOAD_DIR` | no | Absolute path for attachment downloads |
| `MAX_ATTACHMENT_MB` | no | Size cap (default 25) |

### Azure AD permissions (Application / client-credentials)

- `Mail.ReadWrite`
- `Mail.Send`
- `User.Read.All` (optional — only if you call `list_users`)
- `Files.ReadWrite.All` (optional)

After granting, an admin **must** click *Grant admin consent* in the Azure Portal.

## Run

### Direct

```bash
npm start
```

### Via MCP client (stdio)

```json
{
  "mcpServers": {
    "outlook": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-email/dist/index.js"],
      "env": {
        "MICROSOFT_GRAPH_CLIENT_ID": "…",
        "MICROSOFT_GRAPH_CLIENT_SECRET": "…",
        "MICROSOFT_GRAPH_TENANT_ID": "…",
        "TARGET_USER_EMAIL": "user@example.com"
      }
    }
  }
}
```

### Docker

```bash
docker build -t mcp-email .
docker run --rm -i --env-file .env mcp-email
```

The `HEALTHCHECK` verifies the compiled entrypoint imports cleanly — full functional health requires exercising a tool from an MCP client.

## Develop

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript → `dist/` |
| `npm run typecheck` | tsc --noEmit |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |
| `npm test` | Vitest (unit) |
| `npm run test:coverage` | Vitest with coverage thresholds |
| `npm run smoke` | Spawn built server, verify `tools/list` returns 40 entries |
| `npm run audit:prod` | Audit runtime deps only |

CI (`.github/workflows/ci.yml`) runs lint + typecheck + test + smoke on Node 20 and 22.

## Tools

See [CLAUDE.md](./CLAUDE.md) for the full tool catalog with parameter schemas and examples. Summary by category:

- **Email**: `list_emails`, `send_email`, `create_draft`, `reply_to_email`, `mark_as_read`, `mark_as_unread`, `delete_email`, `summarize_email`, `summarize_emails_batch`, `list_users`
- **Attachments**: `list_attachments`, `download_attachment`, `download_attachment_to_file`, `download_all_attachments`, `list_downloaded_files`, `get_download_directory_info`, `cleanup_old_downloads`, `export_email_as_attachment`, `encode_file_for_attachment`
- **Hybrid (large-file)**: `send_email_from_attachment`, `send_email_with_file`
- **Folders**: `list_folders`, `create_folder`, `move_emails_to_folder`, `copy_emails_to_folder`, `delete_folder`, `get_folder_stats`, `organize_emails_by_rules`
- **Search**: `advanced_search`, `search_by_sender_domain`, `search_by_attachment_type`, `find_duplicate_emails`, `search_by_size`, `saved_searches`
- **Batch**: `batch_mark_as_read`, `batch_mark_as_unread`, `batch_delete_emails`, `batch_move_emails`, `batch_download_attachments`, `email_cleanup_wizard`

## Known follow-ups

- `src/services/emailService.ts` is still ~3000 LoC and should be split by domain (email / folder / search / attachment). Postponed because splitting without Graph integration tests is high-risk.
- HTML template rendering does not escape user-supplied body; XFAIL test in `tests/templates/emailTemplates.test.ts`.
- Attachment filename validation accepts `../` path components; XFAIL test in `tests/utils/attachmentValidator.test.ts`.
- `src/security/securityManager.ts` is over-engineered relative to how it's used by handlers — candidate for simplification alongside the `EmailService` split.

## License

MIT
