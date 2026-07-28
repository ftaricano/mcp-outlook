# mcp-outlook

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/ftaricano/mcp-outlook/actions/workflows/ci.yml/badge.svg)](https://github.com/ftaricano/mcp-outlook/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

MCP server for Microsoft Outlook / Exchange via the Microsoft Graph API. Exposes **40 tools** over stdio — list, send, draft, search, organize, batch-operate, and handle attachments including large-file hybrid flows that bypass MCP token limits.

Works with any MCP-compatible client (Claude Desktop, Cursor, custom agents, etc.). Authenticates via Azure AD **client-credentials** (no user login required).

| Metric | Value |
|---|---|
| Tools | 40 operational + 10 read-only plugin tools (15 with `PLUGIN_ALLOW_WRITES=true`) |
| Tests | Unit, protocol, CLI, plugin, and HTTP suites |
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
| `OUTLOOK_KEYCHAIN_PREFIX` | no | macOS Keychain service prefix. Default: `mcp-outlook`. |
| `DOWNLOAD_DIR` | no | Absolute write root. All attachment downloads land here; everything else is rejected. Default: `~/Downloads/mcp-outlook-attachments`. |
| `MCP_EMAIL_UPLOAD_DIRS` | no | Colon-separated read allowlist for `send_email_with_file` / `encode_file_for_attachment`. Anything outside — including symlinks pointing out and files in `~/.ssh`, `~/.aws`, `*.env`, `*.pem`, etc. — is rejected. Defaults to `DOWNLOAD_DIR`. |
| `MAX_ATTACHMENT_MB` | no | Attachment size cap (default: 25) |
| `OUTLOOK_STATE_DIR` | no | Local state root for persistent saved searches and sanitized run telemetry. Defaults to `$XDG_STATE_HOME/mcp-outlook` or `~/.local/state/mcp-outlook`. |
| `OUTLOOK_JOURNAL` | no | Set to `0` to disable sanitized CLI run telemetry globally. Individual calls can use `--no-journal`. |

Resolution order (first hit wins): `process.env` → `<repo>/.env` (if present) → **macOS Keychain** (`security find-generic-password -s "<prefix>::<VARIABLE>" -a "$USER"`). On macOS, the default prefix is `mcp-outlook`; set `OUTLOOK_KEYCHAIN_PREFIX` if you want a different namespace.

To populate the Keychain:

```bash
security add-generic-password -U -s "mcp-outlook::MICROSOFT_GRAPH_CLIENT_ID"     -a "$USER" -w '<uuid>'
security add-generic-password -U -s "mcp-outlook::MICROSOFT_GRAPH_CLIENT_SECRET" -a "$USER" -w '<secret>'
security add-generic-password -U -s "mcp-outlook::MICROSOFT_GRAPH_TENANT_ID"     -a "$USER" -w '<uuid>'
security add-generic-password -U -s "mcp-outlook::TARGET_USER_EMAIL"             -a "$USER" -w 'user@example.com'
```

For multi-account CLI setups, pass an alternative `.env` via `--env-file` or `$OUTLOOK_ENV_FILE`. Those explicit files override existing credential variables for the one-shot CLI process; the default `<repo>/.env` is only a missing-value fallback.

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

# Agent-oriented structured output
outlook advanced_search --query="invoice" --output=json

# Record operator feedback and inspect recurring learning signals
outlook feedback <run-id> --outcome=missed --output=json
outlook harvest --since=7d --skill-target=outlook-mcp --output=json

# Flags: --env-file, --timeout, --output, --session, --no-journal, --compact, --help
```

CLI credentials resolve in this order: `--env-file <path>` → `$OUTLOOK_ENV_FILE` → existing env vars → `<repo>/.env` for missing values → macOS Keychain. Explicit env files override existing credential variables for this one-shot process; the default repo `.env` does not.

Output modes:

- `--output=text` — human-readable output (default).
- `--output=json` — stable `structuredContent` when the tool supplies it; otherwise `{content,isError}`.
- `--output=mcp` — raw MCP result envelope.
- `--compact` — backwards-compatible alias for `--output=mcp`.

Every server-backed CLI call appends a sanitized event to `runs.jsonl` unless disabled. The journal stores argument names/types, duration, normalized error class, and search counters. It never stores argument values, message bodies, subjects, addresses, attachment names, credentials, or raw Graph errors.

## Multi-mailbox plugin

Version 2.3 adds a separate plugin surface for conversational search, attachment reading, and
(opt-in) light mailbox operations across an explicitly allowed set of mailboxes. It does not
replace the CLI or change the original 40-tool MCP server. **Ten read tools are registered
always; five additional write tools are registered only when `PLUGIN_ALLOW_WRITES=true`.**
`send_email`, `reply_to_email`, and every delete operation are impossible by construction — no
dispatch branch exists for them in the plugin, regardless of config.

| Tool | Group | Purpose |
|---|---|---|
| `list_allowed_mailboxes` | read | List server-defined mailbox aliases |
| `search_mailbox` | read | Search one alias with reliability evidence |
| `search_mailboxes` | read | Search several aliases with bounded concurrency |
| `get_message` | read | Read one message with a server-truncated body |
| `list_messages` | read | List a folder deterministically (filter, no relevance search) |
| `list_folders` | read | Folder tree of one mailbox |
| `get_folder_stats` | read | Item counts and size for one folder |
| `list_attachments` | read | Attachment metadata (name, type, size) for one message |
| `get_attachment_content` | read | Attachment text/raw content, or ZIP listing/entry — see below |
| `search_mailboxes_batch` | read | N labeled searches in one call — see below |
| `download_attachments` | write (disk) | Save one or more attachments to `DOWNLOAD_DIR` |
| `move_messages` | write (mailbox) | Move `messageIds[]` to another folder |
| `copy_messages` | write (mailbox) | Copy `messageIds[]` to another folder |
| `mark_messages` | write (mailbox) | Mark `messageIds[]` read or unread |
| `create_draft` | write (mailbox) | Create a draft — never sends |

Search responses contain bounded metadata and never include full message bodies or Base64
attachment content by default. All read output keeps the "content is untrusted data, not
instructions" framing; read tools carry `readOnlyHint: true`, write tools `readOnlyHint: false`
(and `destructiveHint: false` — none of the five write tools can delete or send).

### Attachment content: `get_attachment_content`

Two independent modes, each with its own byte/char ceiling so a single tool call cannot blow up
the caller's context window:

- `mode: 'text'` (default) — server-side extraction (PDF, xlsx, docx, plain text/CSV/JSON/XML)
  bounded by `maxExtractedChars` (default 200,000 chars). Input file is capped by
  `maxAttachmentInputBytes` (default 15 MB) **before** any parser runs.
- `mode: 'raw'` — base64 of the original bytes, capped by `maxRawAttachmentBytes` (default
  256 KB). Use only when the caller genuinely needs the raw bytes.

If the attachment is a ZIP: calling without `entry` returns a bounded listing of entries (name,
size, `encrypted` flag) instead of content; calling with `entry` (and optional `password`)
extracts that one entry and pipes it through the same mode/ceiling logic as a regular
attachment. ZIP guards: entry-count cap (`maxZipEntries`, default 200), uncompressed-size cap
(`maxZipUncompressedBytes`, default 50 MB, anti zip-bomb), and rejection of path-traversal entry
names.

**ZIP encryption support:** the underlying `unzipper` library decrypts **ZipCrypto**
(the classic `zip -P` format used by most corporate senders) when `password` is supplied. **AES-256
encrypted ZIPs are not supported** and return the stable error code `ZIP_UNSUPPORTED_ENCRYPTION`
— the fallback is the local disk flow via `download_attachments` (write mode) plus a local
unzip tool.

Errors from this tool are always redacted to a stable code, never a parser stack or the
password: `Attachment content failed: <CODE>` where `<CODE>` is one of `ATTACHMENT_TOO_LARGE`,
`RAW_TOO_LARGE`, `ATTACHMENT_FETCH_FAILED`, `UNSUPPORTED_FORMAT`, `EXTRACTION_FAILED`,
`EXTRACTION_TIMEOUT`, `ZIP_INVALID`, `ZIP_TOO_MANY_ENTRIES`, `ZIP_TOO_LARGE`,
`ZIP_ENTRY_NOT_FOUND`, `ZIP_ENCRYPTED`, or `ZIP_UNSUPPORTED_ENCRYPTION`.

### Labeled batch search: `search_mailboxes_batch`

Runs several labeled `search_mailboxes` queries in a single call — `{ queries: [{ label,
mailboxes?, criteria }, ...] }` — capped at `maxQueriesPerBatch` (default 10) per call. The
result groups evidence by `label`, so a caller matching many external cases (invoices, pending
policies) against 2+ mailboxes doesn't need one round-trip per case.

### Search criteria extras

`search_mailbox` / `search_mailboxes` / `list_messages` / batch criteria accept two opt-in
flags:

- `includeAttachmentNames: boolean` — expands the Graph query to include attachment name/type/
  size in each message summary (bounded, first 30 attachments), so a caller can classify a
  result by attachment name without a separate `list_attachments` call per candidate.
- `expandTerms: boolean` — expands `query` into aliases/group members using the external search
  memory (below). No-op, with a `search_memory_not_configured` warning, when no memory file is
  configured.

Deterministic criteria (no `query`, i.e. `$filter`-based) accept a higher `maxResults` ceiling
(100 vs 50 for relevance search) and a wider internal scan limit, because covering a full
mailbox window requires paginating to the end.

### External search memory (optional, caller-supplied)

Set `PLUGIN_SEARCH_MEMORY_PATH` to a private YAML file (mode `0600`, never committed) with:

```yaml
apelidos:
  "Official Company Name": ["KnownAlias"]
grupos:
  "Economic Group Name": ["Member Company A", "Member Company B"]
stopwords: ["LTDA", "SA"]
```

Only `apelidos`, `grupos`, and `stopwords` are read; other keys in the same file (e.g. an
existing private sender map) are ignored. This mechanism is generic — the actual aliases,
groups, and stopwords are deployment data and must live outside this repository (see Hard
invariant 9 in `CLAUDE.md`).

### Private plugin configuration

Create `~/.config/mcp-outlook/plugin.json` with mode `0600`:

```json
{
  "mailboxes": [
    { "alias": "finance", "address": "finance@example.com" },
    { "alias": "billing", "address": "billing@example.com" }
  ],
  "maxConcurrentMailboxes": 3,
  "maxMailboxesPerSearch": 8,
  "maxResultsPerMailbox": 20,
  "maxBodyChars": 12000,
  "allowWrites": false,
  "maxAttachmentInputBytes": 15728640,
  "maxExtractedChars": 200000,
  "maxRawAttachmentBytes": 262144,
  "maxBatchSize": 25,
  "maxQueriesPerBatch": 10,
  "maxZipEntries": 200,
  "maxZipUncompressedBytes": 52428800
}
```

| Field | Default | Purpose |
|---|---|---|
| `allowWrites` | `false` | Registers the 5 write tools when `true` (see env override below) |
| `maxAttachmentInputBytes` | 15 MB | Cap on the attachment file before extraction/raw handling |
| `maxExtractedChars` | 200,000 | Cap on extracted text returned to the caller |
| `maxRawAttachmentBytes` | 256 KB | Cap on `mode: 'raw'` base64 output |
| `maxBatchSize` | 25 | Cap on `messageIds[]` / `attachmentIds[]` in move/copy/mark/download |
| `maxQueriesPerBatch` | 10 | Cap on `queries[]` in `search_mailboxes_batch` |
| `maxZipEntries` | 200 | Cap on entries listed/considered in a ZIP |
| `maxZipUncompressedBytes` | 50 MB | Cap on ZIP uncompressed size (anti zip-bomb) |
| `searchMemoryPath` | — | Path to the external search-memory YAML (see above) |

Environment overrides (useful for deploy-time toggles without editing the private config file):
`PLUGIN_SEARCH_MEMORY_PATH=<path>` always takes precedence over the file when set. Writes are
enabled via the `allowWrites` field in `plugin.json` **or** `PLUGIN_ALLOW_WRITES=true` — the env
var is the authority: `PLUGIN_ALLOW_WRITES=false` forces writes off even if the file has
`allowWrites: true`; leaving the env var unset or empty falls back to the file's `allowWrites`
value (default `false`).

```bash
chmod 600 ~/.config/mcp-outlook/plugin.json
npm run build
```

Aliases and addresses must be unique. The model receives aliases, not permission to provide an
arbitrary mailbox address. Set `OUTLOOK_PLUGIN_CONFIG` only when using a different private
path.

### Local Codex plugin

This repository is a valid local Codex plugin:

- `.codex-plugin/plugin.json` provides metadata;
- `.mcp.json` launches `dist/plugin/stdio.js` through `${CODEX_PLUGIN_ROOT}`;
- the plugin exposes the 10 read tools above by default, or all 15 with
  `PLUGIN_ALLOW_WRITES=true` set in the plugin process environment.

Build the repository, then install the repository directory as a local plugin from the Codex
plugin manager. The plugin process uses the same generic credential resolution as the existing
server. Keep deployment-specific credential wrappers outside this public repository.

### Loopback Streamable HTTP

For local protocol validation or an external OAuth proxy:

```bash
npm run build
OUTLOOK_HTTP_BEARER_TOKEN='<local-token>' npm run start:http
```

The built-in server listens on `127.0.0.1:3010` by default:

- MCP endpoint: `/mcp`
- metadata-only health: `/health`
- Streamable HTTP, stateless JSON responses
- optional bearer checked before JSON parsing
- 1 MB request-body limit
- non-loopback binding rejected

This process is not a public ChatGPT endpoint by itself. A remote ChatGPT app requires HTTPS
and an OAuth 2.1 resource-server layer with PKCE-capable authorization in front of it. Do not
publish the loopback service through a raw tunnel or reuse the write-capable Graph app for that
deployment.

After registering the real remote app connection, generate the deployment-specific mapping:

```bash
node scripts/generate-app-manifest.js \
  --connection-id plugin_asdk_app_123 \
  --output .app.json
```

`.app.json` is intentionally ignored by Git. The generator writes the current `apps` manifest
shape, converts the ChatGPT technical ID to its `asdk_app_*` app ID, and adds
`"apps": "./.app.json"` to `.codex-plugin/plugin.json`. It rejects invented identifier shapes
and refuses to overwrite an existing mapping unless `--force` is passed.

### Production prerequisites

Before remote use:

1. Create a separate Microsoft Graph app registration with `Mail.Read`, not the existing
   write-capable permissions.
2. Constrain its mailbox access with Exchange Application RBAC and verify one allowed and one
   denied mailbox.
3. Put the loopback service behind a reviewed HTTPS OAuth 2.1 resource-server layer.
4. Keep the local alias allowlist in place; tenant authorization and local authorization are
   independent gates.
5. Run `npm run verify` and the live read-only smoke with fictional/test mailboxes.

The CLI remains the fallback for cron, shell pipelines, large local attachments, and supervised
write operations.

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

### Reliable search contract

`advanced_search` distinguishes five outcomes in `structuredContent`:

- `FOUND`
- `NOT_FOUND`
- `SEARCH_INCOMPLETE`
- `SEARCH_FAILED`
- `SEARCH_UNTRUSTED`

Text queries run a negative canary against Graph. Empty or suspicious `$search` results trigger a bounded local scan over paginated messages, body previews/bodies, sender fields, and attachment names. A negative result is only `NOT_FOUND` when that fallback scan completes; hitting `maxPages` or `scanLimit` returns `SEARCH_INCOMPLETE`.

```bash
outlook advanced_search \
  --query="invoice 100151515" \
  --dateFrom="2026-01-01T00:00:00Z" \
  --maxPages=10 \
  --scanLimit=500 \
  --output=json
```

Search-related tools also expose machine-readable result arrays. Human-readable text remains unchanged by default.

### Persistent saved searches

Saved searches are stored atomically in `saved-searches.json` under `OUTLOOK_STATE_DIR`, with owner-only permissions. They therefore survive separate one-shot CLI calls:

```bash
outlook saved_searches --json '{"action":"save","name":"invoices","searchCriteria":{"query":"invoice"}}'
outlook saved_searches --action=list --output=json
outlook saved_searches --action=execute --name=invoices --output=json
```

Corrupt state fails loudly and is never overwritten automatically.

### Governed self-improvement

The CLI records evidence and emits proposals; it does not modify its own code or skills.

```bash
# Link a call to an operator session
outlook advanced_search --query="invoice" --session=case-123 --output=json

# Record whether the result was useful
outlook feedback <run-id> --outcome=correct
outlook feedback <run-id> --outcome=missed

# Recurring signals require at least two occurrences
outlook harvest --since=7d --minimum-occurrences=2 --output=json
```

`harvest` returns `learning-proposals` compatible objects for an external governance process. It never enqueues or applies them automatically.

## Architecture

```
src/
  config/env.ts             # zod-validated env — fails fast on bad credentials
  auth/graphAuth.ts         # MSAL client-credentials token provider (auto-refresh)
  services/emailService.ts  # Microsoft Graph wrapper with response caching + batch helpers
  schemas/toolSchemas.ts    # zod schemas for all 40 tool inputs
  handlers/*.ts             # one handler class per domain (email, folder, search…)
  handlers/HandlerRegistry  # zod validation + dispatch
  logging/logger.ts         # stderr JSON logger
  templates/                # HTML email templates (4 themes)
  utils/                    # file manager, attachment validator, secret redaction
```

Runtime flow:

1. `loadEnv()` validates credentials via zod on startup — bad config exits immediately with a clear message.
2. `GraphAuthProvider` lazily acquires tokens and refreshes 60 s before expiry.
3. MCP requests hit `HandlerRegistry.handleTool(name, args)` → zod validation → domain handler.
4. Handlers call `EmailService`, which wraps Graph with response caching, pagination, search reliability evidence, and batch helpers. Retry/backoff on 429 (honoring `Retry-After`) comes from the Graph SDK's default middleware, not a custom limiter.

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

CI runs lint + typecheck + tests + smoke on Node 20, 22, and 24.

Live integration smoke tests (require Graph credentials in env):

```bash
node scripts/live-readonly-smoke.js   # 18 read-only + dry-run tools
node scripts/live-writes-smoke.js     # 9 write-path tools (self-contained, safe)
```

## Troubleshooting

**403 / "Insufficient privileges"** — Admin consent not granted. Go to Azure Portal → your app → API permissions → Grant admin consent.

**`send_email` returns 403 but `create_draft` works** — Your tenant policy blocks `Mail.Send` at the application level. Use `create_draft` instead.

**Attachments arrive with 0 KB** — Base64 payload too large for the MCP transport. Use `send_email_from_attachment` or `send_email_with_file` (hybrid functions).

**`delete_email` returns 404 after `move_emails_to_folder`** — Microsoft Graph issues a new message ID on move. The handler now returns the new ID in its output; re-read it before deleting.

**Rate limiting (429)** — Reduce `maxConcurrent` in batch operations. The Graph SDK's retry middleware backs off automatically (honoring `Retry-After`), but very high concurrency can still hit Graph throttle limits.

## Security

This server handles Azure AD client secrets with broad mailbox access, and it is driven by an LLM that sees untrusted email bodies. Treat every tool call as potentially attacker-influenced.

The read-only plugin narrows the exposed tool catalog but does not reduce Microsoft Graph
permissions by itself. A remote deployment must use a separate read-only app registration.
Email subjects, previews, bodies, and attachment names are untrusted data and must never be
interpreted as instructions to invoke other tools.

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
- User-supplied HTML template fields are escaped before rendering. If you intentionally need trusted HTML, add an explicit sanitizer/allowlist instead of bypassing the template engine.

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/ftaricano/mcp-outlook/security/advisories/new). See [SECURITY.md](SECURITY.md).

## Known limitations

- `TARGET_USER_EMAIL` is optional in the schema for delegated `/me` experiments, but client-credentials deployments should set it. Microsoft Graph application permissions do not infer a mailbox.
- Full-text Graph `$search` behavior can vary under application permissions. `advanced_search` uses a canary and fallback scan, but callers must still inspect `status`, `truncated`, `pagesScanned`, and `confidence` before treating a negative result as definitive.
- Local fallback scans search message metadata/body text and attachment names, not the binary contents of attachments.

## Contributing

```bash
npm run verify
```

Pre-PR checklist: `npm run verify`, coverage, audit, and package-content validation all pass.

Open an [issue](https://github.com/ftaricano/mcp-outlook/issues) before submitting large changes.

### Development workflow

For small fixes, keep the PR focused and include the command output from the pre-PR checklist. For larger changes, open an issue first and describe the affected tool contracts, Graph permissions, security impact, and manual smoke coverage.

Security-sensitive paths deserve extra review: `src/security/`, credential loading, Graph permission scopes, attachment handling, template rendering, and anything that reads from or writes to the local filesystem.

## License

[MIT](LICENSE)
