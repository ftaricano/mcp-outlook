# Outlook Multi-Mailbox Plugin Specification

**Issue:** JAR-753
**Status:** Approved for implementation
**Date:** 2026-07-26

## Problem

`mcp-outlook` already provides a mature 40-tool MCP server and a one-shot CLI, but each
server process is pinned to one mailbox through `TARGET_USER_EMAIL`. This is effective for
scripts and deterministic operations, but awkward for conversational requests that need to
search several explicitly authorized mailboxes.

The project also lacks a narrow remote MCP surface suitable for connecting as a ChatGPT app
or packaging as a Codex plugin. Publishing all 40 tools would expose write, delete, folder,
batch, and local-filesystem operations that are unnecessary for the initial conversational
use case.

## Goals

1. Preserve the existing CLI and 40-tool stdio MCP contract.
2. Make mailbox selection an instance-level dependency rather than mutable process state.
3. Add a positive mailbox allowlist with optional non-sensitive aliases.
4. Add bounded, parallel, evidence-bearing search across multiple allowed mailboxes.
5. Expose a separate four-tool read-only MCP surface over stdio and Streamable HTTP.
6. Package the read-only surface as a local Codex plugin.
7. Provide a deterministic generator for the `.app.json` file after a remote ChatGPT app
   connection ID and an OAuth-protected endpoint exist.

## Non-Goals

- No public deployment or tunnel creation.
- No new Microsoft Graph permissions.
- No send, draft, reply, delete, move, folder mutation, or batch mutation through the plugin.
- No arbitrary mailbox UPN supplied by the model.
- No search inside binary attachment contents.
- No change to the existing 40-tool names or input schemas.

## User Experience

The plugin exposes four tools:

### `list_allowed_mailboxes`

Returns the server-side aliases available to the caller. It does not return tenant IDs,
application IDs, secrets, or authorization internals.

### `search_mailbox`

Searches one allowed mailbox alias with the existing reliable search contract. The output
includes the mailbox alias, status, confidence, strategy, pagination evidence, warnings, and
bounded message summaries.

### `search_mailboxes`

Searches an explicit list of aliases, or every allowed alias when `mailboxes` is omitted.
Fan-out is capped by configuration and implementation constants. Failure in one mailbox does
not erase successful evidence from other mailboxes.

### `get_message`

Fetches one message by ID from one allowed mailbox alias. The response returns the minimum
useful message fields and bounded body text. It does not return raw MIME or attachment bytes.

## Configuration

The plugin reads a deployment-specific JSON file outside the repository:

```json
{
  "mailboxes": [
    { "alias": "finance", "address": "finance@example.com" },
    { "alias": "billing", "address": "billing@example.com" }
  ],
  "maxConcurrentMailboxes": 3,
  "maxMailboxesPerSearch": 8,
  "maxResultsPerMailbox": 20,
  "maxBodyChars": 12000
}
```

The path is supplied through `OUTLOOK_PLUGIN_CONFIG`. The file:

- must be a regular file;
- must not be a symlink;
- must be owner-readable only or stricter on POSIX systems;
- must contain unique lowercase aliases;
- must contain unique valid email addresses;
- must contain at least one mailbox;
- must not contain credentials.

Microsoft Graph credentials continue to use the existing environment and Keychain resolution.
`TARGET_USER_EMAIL` remains the compatibility default for the original server and CLI.

The HTTP server additionally accepts:

- `OUTLOOK_HTTP_HOST`, default `127.0.0.1`;
- `OUTLOOK_HTTP_PORT`, default `3010`;
- `OUTLOOK_HTTP_BEARER_TOKEN`, optional for loopback defense in depth.

The repository implementation binds only to loopback. A remote ChatGPT connection requires an
external HTTPS OAuth 2.1 resource-server layer with PKCE-capable authorization in front of this
service. Public binding, OAuth client registration, and tunnel creation remain deployment gates.

## Architecture

### Mailbox-scoped core

`EmailService` and `GraphOptimizer` receive a mailbox address at construction. Existing
callers omit the parameter and retain the `TARGET_USER_EMAIL` behavior. Plugin callers create
one service per allowlisted mailbox without modifying `process.env`.

Each optimizer namespaces cache keys by mailbox. The plugin disables cache preloading so fixed
preload keys and background timers cannot cross mailbox boundaries.

### Read-only orchestration

`MultiMailboxService` owns the allowlist and a mailbox-to-service factory. It validates aliases
before every operation, caps fan-out, runs searches with bounded concurrency, and returns
per-mailbox evidence.

### Separate MCP surfaces

- `src/index.ts`: unchanged public contract, 40 tools over stdio.
- `src/plugin/stdio.ts`: four plugin tools over stdio for local Codex packaging.
- `src/plugin/http.ts`: the same four tools over stateless Streamable HTTP.

Both plugin transports construct the same `McpServer` through `createOutlookPluginServer()`.

## Security Requirements

1. Mailbox addresses come only from the server-side configuration.
2. Aliases are matched exactly after lowercase normalization.
3. The model cannot provide a raw mailbox address.
4. Plugin tools are read-only and carry read-only tool annotations.
5. HTTP requests are rejected before body processing when configured bearer authentication
   fails.
6. The built-in HTTP server refuses non-loopback binding. Remote deployment must terminate OAuth
   and HTTPS in a separately reviewed resource-server layer.
7. Health responses contain no mailbox list or credential metadata.
8. Errors returned to MCP clients are redacted through the existing formatter.
9. Logs contain aliases, durations, counts, and normalized statuses only.
10. Body output is length-bounded and treated as untrusted data, never as instructions.
11. Multi-mailbox partial failure remains visible as evidence instead of becoming an empty
    successful result.
12. The public repository contains no real tenant, mailbox, customer, or company data.

## Compatibility

- `outlook list` continues to report exactly 40 tools.
- Existing environment variables and CLI flags keep their current precedence.
- The original stdio MCP server still uses `TARGET_USER_EMAIL`.
- Existing tests that mutate `process.env.TARGET_USER_EMAIL` continue to pass.
- The plugin adds separate build outputs and scripts without changing the package binary name.

## Packaging

The repository includes:

- `.codex-plugin/plugin.json`;
- `.mcp.json` pointing at the plugin stdio entrypoint through `${CODEX_PLUGIN_ROOT}`;
- `scripts/generate-app-manifest.js`, which validates a real `plugin_asdk_app` connection ID
  and writes the current `apps`-shaped `.app.json` while wiring it into the plugin manifest;
- documentation for local Codex installation and remote ChatGPT developer-mode connection.

The generated `.app.json` is deployment-specific and ignored by Git.

## Acceptance Criteria

1. A mailbox-scoped `EmailService` never reads a different mailbox after construction.
2. An unknown alias fails before a Graph request is made.
3. `search_mailboxes` cannot exceed configured mailbox or concurrency limits.
4. Search results retain the existing reliability statuses independently per mailbox.
5. One mailbox failure produces a partial result with an explicit failed status.
6. The plugin MCP `tools/list` returns exactly four read-only tools.
7. Requests with a configured but missing or invalid loopback bearer return `401`.
8. Loopback health returns `200` without exposing mailbox details.
9. An MCP client can initialize, list tools, and call a plugin tool over HTTP.
10. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, the original smoke, the
    plugin stdio smoke, and the HTTP smoke all pass.
11. A production Graph deployment uses a separate `Mail.Read` app registration constrained by
    Exchange Application RBAC; this operational gate is documented and not silently inferred
    from the existing write-capable credentials.
