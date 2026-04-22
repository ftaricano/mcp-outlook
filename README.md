# mcp-outlook

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/ftaricano/mcp-outlook/actions/workflows/ci.yml/badge.svg)](https://github.com/ftaricano/mcp-outlook/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

MCP server for Microsoft Outlook / Exchange via the Microsoft Graph API. Exposes **40 tools** over stdio — list, send, draft, search, organize, batch-operate, and handle attachments including large-file hybrid flows that bypass MCP token limits.

Works with any MCP-compatible client (Claude Desktop, Cursor, custom agents, etc.). Authenticates via Azure AD **client-credentials** (no user login required).

| Metric | Value |
|---|---|
| Tools | 40 |
| Tests | 145 passing |
| Coverage | ~93% (scoped modules) |
| Node | ≥ 20 |
| MCP SDK | ^1.29.0 |
| License | MIT |

## Requirements

- Node.js 20 or 22
- Azure AD app registration with **Application** permissions:
  - `Mail.ReadWrite` — required for all read/draft/folder operations
  - `Mail.Send` — required only if you call `send_email` or `reply_to_email`
  - `User.Read.All` — optional, only for `list_users`
- Admin consent granted in the Azure Portal

## Install

```bash
git clone https://github.com/ftaricano/mcp-outlook.git
cd mcp-outlook
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `MICROSOFT_GRAPH_CLIENT_ID` | yes | Azure AD application (client) UUID |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | yes | Client secret value |
| `MICROSOFT_GRAPH_TENANT_ID` | yes | Azure AD tenant UUID |
| `TARGET_USER_EMAIL` | yes | Mailbox to operate on |
| `LOG_LEVEL` | no | `error` / `warn` / `info` (default) / `debug` |
| `DOWNLOAD_DIR` | no | Absolute path for attachment downloads |
| `MAX_ATTACHMENT_MB` | no | Attachment size cap (default: 25) |

After setting permissions in Azure AD, click **Grant admin consent** — without this step every call returns 403.

## Quickstart

### Claude Desktop / Cursor

Add to your MCP client config:

```json
{
  "mcpServers": {
    "outlook": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-outlook/dist/index.js"],
      "env": {
        "MICROSOFT_GRAPH_CLIENT_ID": "your-client-id",
        "MICROSOFT_GRAPH_CLIENT_SECRET": "your-client-secret",
        "MICROSOFT_GRAPH_TENANT_ID": "your-tenant-id",
        "TARGET_USER_EMAIL": "user@example.com"
      }
    }
  }
}
```

### Direct (stdio)

```bash
npm start
```

### Docker

```bash
docker build -t mcp-outlook .
docker run --rm -i --env-file .env mcp-outlook
```

## Tools

40 tools across 6 categories:

| Category | Tools |
|---|---|
| **Email** | `list_emails`, `send_email`, `create_draft`, `reply_to_email`, `mark_as_read`, `mark_as_unread`, `delete_email`, `summarize_email`, `summarize_emails_batch`, `list_users` |
| **Attachments** | `list_attachments`, `download_attachment`, `download_attachment_to_file`, `download_all_attachments`, `list_downloaded_files`, `get_download_directory_info`, `cleanup_old_downloads`, `export_email_as_attachment`, `encode_file_for_attachment` |
| **Hybrid (large-file)** | `send_email_from_attachment`, `send_email_with_file` |
| **Folders** | `list_folders`, `create_folder`, `move_emails_to_folder`, `copy_emails_to_folder`, `delete_folder`, `get_folder_stats`, `organize_emails_by_rules` |
| **Search** | `advanced_search`, `search_by_sender_domain`, `search_by_attachment_type`, `find_duplicate_emails`, `search_by_size`, `saved_searches` |
| **Batch** | `batch_mark_as_read`, `batch_mark_as_unread`, `batch_delete_emails`, `batch_move_emails`, `batch_download_attachments`, `email_cleanup_wizard` |

### Hybrid functions

`send_email_from_attachment` and `send_email_with_file` solve a fundamental MCP limitation: large Base64 payloads overflow the protocol's token budget. These tools download/read the file directly on disk, then call the Graph API — no Base64 transfer through MCP at all.

### create_draft vs send_email

`create_draft` only requires `Mail.ReadWrite`. Use it when your tenant policy blocks `Mail.Send` (common in restrictive enterprise environments). The draft lands in the Drafts folder; open Outlook to review and send.

## Architecture

```
src/
  config/env.ts             # zod-validated env — fails fast on bad credentials
  auth/graphAuth.ts         # MSAL client-credentials token provider (auto-refresh)
  services/emailService.ts  # Microsoft Graph wrapper with rate limiting + caching
  schemas/toolSchemas.ts    # zod schemas for all 40 tool inputs
  handlers/*.ts             # one handler class per domain (email, folder, search…)
  handlers/HandlerRegistry  # zod validation + dispatch
  logging/logger.ts         # stderr JSON logger
  templates/                # HTML email templates (4 themes)
  utils/                    # rate limiter, file manager, attachment validator
```

Runtime flow:

1. `loadEnv()` validates credentials via zod on startup — bad config exits immediately with a clear message.
2. `GraphAuthProvider` lazily acquires tokens and refreshes 60 s before expiry.
3. MCP requests hit `HandlerRegistry.handleTool(name, args)` → zod validation → domain handler.
4. Handlers call `EmailService`, which wraps Graph with rate limiting, response caching, and batch helpers.

## Develop

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` / `npm run format:check` | Prettier |
| `npm test` | Vitest unit tests |
| `npm run test:coverage` | Vitest with coverage thresholds |
| `npm run smoke` | Protocol smoke — verify `tools/list` returns 40 entries |
| `npm run audit:prod` | Audit runtime deps only |

CI runs lint + typecheck + tests + smoke on Node 20 and 22.

Live integration smoke tests (require Graph credentials in env):

```bash
node scripts/live-readonly-smoke.js   # 20 read-only + dry-run tools
node scripts/live-writes-smoke.js     # 9 write-path tools (self-contained, safe)
```

## Troubleshooting

**403 / "Insufficient privileges"** — Admin consent not granted. Go to Azure Portal → your app → API permissions → Grant admin consent.

**`send_email` returns 403 but `create_draft` works** — Your tenant policy blocks `Mail.Send` at the application level. Use `create_draft` instead.

**Attachments arrive with 0 KB** — Base64 payload too large for the MCP transport. Use `send_email_from_attachment` or `send_email_with_file` (hybrid functions).

**`delete_email` returns 404 after `move_emails_to_folder`** — Microsoft Graph issues a new message ID on move. The handler now returns the new ID in its output; re-read it before deleting.

**Rate limiting (429)** — Reduce `maxConcurrent` in batch operations. The server implements automatic backoff, but very high concurrency can still hit Graph throttle limits.

## Security

This server handles Azure AD client secrets with broad mailbox access. Keep these practices:

- **Never commit** `.env` — it is in `.gitignore`
- **Never commit** `*.log` or `*.jsonl` files — also in `.gitignore`
- Store secrets in your OS keychain or a secrets manager, not in plaintext files
- Rotate the client secret in Azure AD immediately if it is ever exposed
- Scope `Mail.Send` only if you need outbound email — `Mail.ReadWrite` alone is sufficient for drafts, search, and folder management

Report vulnerabilities privately: [Security advisories](https://github.com/ftaricano/mcp-outlook/security/advisories/new)

## Contributing

```bash
npm run build && npm test && npm run smoke
```

Pre-PR checklist: build passes, lint clean, all tests green, smoke returns 40 tools.

Open an [issue](https://github.com/ftaricano/mcp-outlook/issues) before submitting large changes.

## License

[MIT](LICENSE)
