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
| Tests | 178 passing |
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

Four required values feed both the server and the CLI:

| Variable | Required | Description |
|---|---|---|
| `MICROSOFT_GRAPH_CLIENT_ID` | yes | Azure AD application (client) UUID |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | yes | Client secret value |
| `MICROSOFT_GRAPH_TENANT_ID` | yes | Azure AD tenant UUID |
| `TARGET_USER_EMAIL` | yes* | Mailbox to operate on. Strongly recommended — omitting it causes runtime errors from Graph rather than a clean startup failure. |
| `LOG_LEVEL` | no | `error` / `warn` / `info` (default) / `debug` |
| `DOWNLOAD_DIR` | no | Absolute write root. All attachment downloads land here; everything else is rejected. Default: `<cwd>/downloads`. |
| `MCP_EMAIL_UPLOAD_DIRS` | no | Colon-separated read allowlist for `send_email_with_file` / `encode_file_for_attachment`. Anything outside — including symlinks pointing out and files in `~/.ssh`, `~/.aws`, `*.env`, `*.pem`, etc. — is rejected. Defaults to `DOWNLOAD_DIR`. |
| `MAX_ATTACHMENT_MB` | no | Attachment size cap (default: 25) |

Resolution order (first hit wins): `process.env` → `<repo>/.env` (if present) → **macOS Keychain** (`security find-generic-password -s "<KEY>" -a "$USER"`). On macOS, the server reads from the Keychain automatically — no `.env` needed for the default account. Tries `cpz::MICROSOFT_GRAPH_*` first, falls back to `cpz::SP_*` (since the SharePoint Graph app is the same Azure AD registration).

To populate the Keychain:

```bash
security add-generic-password -U -s "cpz::MICROSOFT_GRAPH_CLIENT_ID"     -a "$USER" -w '<uuid>'
security add-generic-password -U -s "cpz::MICROSOFT_GRAPH_CLIENT_SECRET" -a "$USER" -w '<secret>'
security add-generic-password -U -s "cpz::MICROSOFT_GRAPH_TENANT_ID"     -a "$USER" -w '<uuid>'
security add-generic-password -U -s "cpz::TARGET_USER_EMAIL"             -a "$USER" -w 'user@example.com'
```

For multi-account setups, pass an alternative `.env` via `--env-file` or `$OUTLOOK_ENV_FILE` — process env beats Keychain.

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

### `outlook` CLI (one-shot calls)

The package ships with a standalone CLI — `./scripts/outlook.js`, registered as the `outlook` bin — that spawns the server, runs a single MCP request, and exits. Useful for scripts, cron, smoke-testing a tool, or inspecting a schema without wiring up an MCP client.

```bash
# Discover
outlook list                          # all 40 tools with descriptions
outlook schema list_emails            # input schema for a single tool

# Call with flags
outlook list_emails --limit=5 --folder=inbox
outlook create_draft --to='["a@b.com"]' --subject="Hi" --body="Hello"

# Call with raw JSON (useful for arrays/objects)
outlook batch_mark_as_read --json '{"emailIds":["id1","id2"]}'

# Flags: --env-file <path>, --timeout <ms>, --compact, --help
```

Credentials resolve in this order: `--env-file <path>` → `$OUTLOOK_ENV_FILE` → `<repo>/.env` → existing env vars → macOS Keychain (same fallback chain as the server).

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

This server handles Azure AD client secrets with broad mailbox access, and it is driven by an LLM that sees untrusted email bodies. Treat every tool call as potentially attacker-influenced.

**Filesystem allowlist (`pathGuard`)** — `send_email_with_file`, `encode_file_for_attachment`, and all attachment download paths go through a central allowlist (`src/security/pathGuard.ts`):

- **Writes** are confined to `DOWNLOAD_DIR`.
- **Reads** are confined to `MCP_EMAIL_UPLOAD_DIRS` (defaults to `DOWNLOAD_DIR`).
- Symlinks, `..` traversal, NUL bytes, and files in secret-bearing locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials.json`, `id_rsa*`, etc.) are rejected before the file is read.

Without this guard, an attacker who controls an email body could instruct the agent to attach `~/.ssh/id_rsa` to an outbound email. The guard blocks that class of confused-deputy attack at the boundary.

Keep these practices:

- **Never commit** `.env` — it is in `.gitignore`
- **Never commit** `*.log` or `*.jsonl` files — also in `.gitignore`
- Store secrets in your OS keychain or a secrets manager, not in plaintext files
- Rotate the client secret in Azure AD immediately if it is ever exposed
- Set `MCP_EMAIL_UPLOAD_DIRS` to the *minimum* set of directories the server actually needs to read. Do not set it to `$HOME` or `/`.
- Scope `Mail.Send` only if you need outbound email — `Mail.ReadWrite` alone is sufficient for drafts, search, and folder management
- **Template injection risk:** see [Known limitations](#known-limitations) — HTML templates do not escape user-supplied fields.

Report vulnerabilities privately: [Security advisories](https://github.com/ftaricano/mcp-outlook/security/advisories/new)

## Known limitations

- HTML email templates (`src/templates/`) do not escape user-supplied content (body, `companyName`, `logoUrl`, etc.). Never render untrusted input directly into a template — an attacker who controls an email body could inject arbitrary HTML/JavaScript into outbound messages.
- `TARGET_USER_EMAIL` is not validated at startup — omitting it produces a runtime Graph error rather than a clear startup failure.

## Contributing

```bash
npm run build && npm test && npm run smoke
```

Pre-PR checklist: build passes, lint clean, all tests green, smoke returns 40 tools.

Open an [issue](https://github.com/ftaricano/mcp-outlook/issues) before submitting large changes.

### Development workflow

Non-trivial changes follow a three-phase discipline borrowed from the [superpowers](https://github.com/obra/superpowers) skill set:

1. **Plan first** (`writing-plans`) — for any change touching more than one file or subsystem, write the plan to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` before editing code. Plans are bite-sized (2–5 min steps), TDD-first, and list exact file paths.
2. **Execute task-by-task** (`executing-plans`) — work through the plan one task at a time, checking boxes as you go. No batching, no skipping ahead. Commit at the end of each task.
3. **Verify before declaring done** (`verification-before-completion`) — before marking any material change complete, re-run the pre-PR checklist above and read the actual diff. An agent's summary describes intent, not outcome — trust the diff, not the narrative.

Skip the ceremony for one-line fixes or typo-class changes; apply it the moment a change spans multiple files, introduces new contracts, or touches security-sensitive paths (`src/security/`, credential handling, Graph permission scopes).

## License

[MIT](LICENSE)
