# CLAUDE.md — agent notes

Guidance for agents working **on this repo**. End-user docs (tool catalog, setup, troubleshooting) live in [README.md](README.md); don't duplicate them here.

## What this is

MCP server exposing Microsoft Graph email operations as 40 tools over stdio, plus a standalone
`outlook` CLI wrapper. A separate multi-mailbox plugin supports allowlisted search, reading, and
bounded attachment access over stdio and loopback Streamable HTTP. It exposes twelve read-only tools
by default, two local handoff tools only when that separate gate is enabled, five additional
non-delete tools only when mailbox writes are explicitly enabled, and one send tool only when a
third gate is enabled and a sending mailbox is pinned by configuration.
Auth is Azure AD client-credentials (no user login). The original server remains single-mailbox
per process; plugin services pin mailbox identity per instance.

## Hard invariants

These are enforced by CI or by design. Don't regress them.

1. **Two fixed catalog families.** The original server exposes exactly 40 tools and
   `scripts/smoke-test.js` enforces that count. The plugin exposes exactly twelve physically
   read-only tools by default, two independently gated local handoff tools, and five additional
   mailbox-write tools
   (move/copy/mark/download/create_draft) when writes are enabled — via the plugin.json
   `allowWrites` field, or via env `PLUGIN_ALLOW_WRITES=true`. The env is the authority:
   `PLUGIN_ALLOW_WRITES=false` forces writes off regardless of what the file says; only when
   the env var is absent or empty does the file's `allowWrites` field decide (default `false`).
   Local handoffs are absent unless `PLUGIN_ALLOW_LOCAL_HANDOFFS=true`; there is no config-file
   fallback. `scripts/plugin-smoke-test.js` enforces the full gate matrix: 12 / 14 / 17 / 19 without
   sending, and 13 / 15 / 18 / 20 with it. **Every delete operation is impossible by
   construction** — no dispatch branch exists for one in the plugin, at any gate combination.
   **Sending is a third, independent gate** (`PLUGIN_ALLOW_SEND=true`, env only, no config-file
   fallback) exposing exactly one tool. It fails closed at startup unless `OUTLOOK_SEND_FROM`
   names a mailbox that is both in the plugin allowlist and covered by a non-empty
   `OUTLOOK_ALLOWED_SENDERS`. `send_email` takes **no `mailbox` argument**: the plugin reads
   untrusted mail from every allowed mailbox, so a caller-nameable sender would be an input a
   malicious message could try to steer. The sending mailbox is not sayable, only configurable.
2. **Every tool has a zod schema.** `src/schemas/toolSchemas.ts` is the gate — `HandlerRegistry.handleTool` runs `validateToolInput` before dispatching. No handler method runs on unvalidated args.
3. **Filesystem access goes through `pathGuard`.** Handlers never call `fs.readFile` / `fs.writeFile` on caller-supplied paths directly; `src/services/fileManager.ts` and `src/services/emailService.ts` already route through `pathGuard.resolveSafe()`. Any new file-touching code must go through the same door.
4. **Graph calls go through `EmailService`.** No direct `Client.api()` in handlers — that bypasses response caching (`CacheManager`) and the batch helpers. Retry/throttling (429 + `Retry-After`) is **not** custom: it comes from the Graph SDK's default middleware chain (`Client.initWithMiddleware` in `src/auth/graphAuth.ts`), which includes the SDK `RetryHandler`. There is no in-house rate limiter.
5. **HTML template inputs are escaped by default.** `src/templates/` must keep escaping user-controlled fields before rendering. Do not add a trusted-HTML bypass without an explicit sanitizer and tests.
6. **Search negatives are evidence-bearing.** Search code must follow `@odata.nextLink` within explicit limits and distinguish `NOT_FOUND` from `SEARCH_INCOMPLETE`, `SEARCH_FAILED`, and `SEARCH_UNTRUSTED`. Never turn a page-fetch failure or limit hit into a clean empty result.
7. **Run telemetry is metadata-only.** `scripts/lib/run-journal.js` may store argument names/types, counters, durations, statuses, and normalized error classes. It must never persist argument values, message content/metadata, attachment names, credentials, or raw errors.
8. **Self-improvement emits proposals only.** `outlook harvest` is observational. It must not edit source, enqueue proposals, mutate skills, or bypass the external autonomy/session-harvest gates.
9. **This is a public repo — no deployment-specific data.** The code, tests, docs, and fixtures must stay free of any specific tenant's operational data: real mailbox addresses, client / company / person names, sender identities, folder maps, or attachment passwords. Anything deployment-specific is **caller-supplied at runtime** — env vars, or an external config / search-memory file passed by path — never committed here. Tests and examples use fictional data only. Rationale: committed content is world-readable and effectively permanent; a leak of an operator's business data cannot be undone. Capabilities that consume such data (e.g. multi-mailbox search, document confirmation, an index-backed cache) belong here as generic mechanisms; the data they read stays in the caller's private config. The optional search-memory file (`PLUGIN_SEARCH_MEMORY_PATH`) and ZIP passwords passed to `get_attachment_content` are caller-supplied at runtime and must never be committed, logged, or persisted by telemetry.
10. **Mailbox identity is immutable per service.** Never switch `TARGET_USER_EMAIL` or another
    process-global value around an operation. Plugin allowlists resolve opaque aliases to
    constructor-pinned mailbox services, and cache keys include mailbox identity.
11. **HTTP is loopback-only in this repo.** Remote ChatGPT use requires a separately reviewed
    HTTPS OAuth 2.1 resource-server layer and a separate Graph `Mail.Read` app registration.
12. **Graph permissions follow the exposed catalog.** The default twelve-tool plugin requires only
    application `Mail.Read`. Enabling its five write tools requires `Mail.ReadWrite`. Enabling its
    send gate requires `Mail.Send` — the one case where the plugin needs it; leave that gate off
    and the plugin never does. The original 40-tool server requires `Mail.ReadWrite` and needs `Mail.Send` only
    for `send_email` and `reply_to_email`.
13. **Plugin downloads have aggregate budgets.** `download_attachments` applies both
    `maxBatchSize` and `maxDownloadBatchBytes` whether `attachmentIds` is supplied or omitted.
    No attachment may start writing when its real decoded size exceeds the remaining byte budget.
14. **Outbound sending goes through `senderPolicy`.** The original server has exactly two paths
    that put mail on the wire — `EmailService.sendEmail()` and `EmailService.replyToEmail()` — and
    both resolve their mailbox through `src/security/senderPolicy.ts` *before* entering their
    `try` block, because both catches rewrite errors and would disguise a refusal as a retryable
    failure. When `OUTLOOK_ALLOWED_SENDERS` is set, any mailbox outside it is refused before Graph
    is called; unset means unrestricted, since the deployment's addresses cannot live in this repo
    (invariant 9). `OUTLOOK_SEND_FROM` redirects new messages only — a reply belongs to the mailbox
    that owns the original message, and redirecting it would point at a foreign message id.
    `create_draft` is deliberately outside the gate. Any new outbound call site must pass the gate —
    `tests/security/outboundCallSites.test.ts` fails if an outbound Graph route appears outside
    `EmailService`, or if their number changes. The plugin's `send_email` reaches the wire through
    that same `EmailService.sendEmail`, so it inherits this gate rather than bypassing it.
15. **Local handoffs are opaque, private, and fail closed.** They use only the fixed
    `~/.jarvishub-mcp/outlook-handoffs` root, never a caller-supplied path. A `0700` bundle contains
    only `0600` `payload.bin` plus `manifest.json`; the manifest is the final commit marker. Replay
    revalidates request fingerprint, exact manifest shape, modes, size, and SHA-256. The MCP never
    returns bytes, Base64, internal paths, or the request fingerprint. Quotas bound one payload,
    aggregate payload bytes, and committed bundle count.

## Architecture at a glance

```
src/
  config/     zod-validated env, fails fast
  auth/       MSAL client-credentials
  security/   pathGuard — filesystem allowlist (DOWNLOAD_DIR, MCP_EMAIL_UPLOAD_DIRS)
              senderPolicy — outbound mailbox allowlist (OUTLOOK_ALLOWED_SENDERS, OUTLOOK_SEND_FROM)
  services/   Graph wrapper: response cache, batch helpers (retry via SDK middleware)
  schemas/    zod input schema per tool + jsonSchema converter
  handlers/   one class per domain, HandlerRegistry routes by tool name
  templates/  4 HTML themes
  utils/      file manager, attachment validator, secret redaction
scripts/lib/  persistent state, sanitized run journal, governed harvest
```

Handler domains: `Email`, `Attachment`, `Hybrid` (large-file), `Folder`, `Search`, `Batch`. Stay in the right domain when adding a tool.

## Adding a tool

1. zod schema → `src/schemas/toolSchemas.ts`
2. handler method on the appropriate domain class under `src/handlers/`
3. case branch in `HandlerRegistry.handleTool`
4. unit test in `tests/schemas/toolSchemas.test.ts` (validation) + handler test
5. bump `EXPECTED_TOOL_COUNT` in [scripts/smoke-test.js](scripts/smoke-test.js)
6. add row to the tools table in [README.md](README.md)

## Testing gates

| Command | Gate |
|---|---|
| `npm run verify` | pre-PR — lint, typecheck, tests, build and all three smokes |
| `npm run test:coverage` | enforces coverage thresholds |
| `node scripts/live-readonly-smoke.js` | live Graph read smoke — requires real creds, not in CI |
| `node scripts/live-writes-smoke.js` | live Graph write smoke — same |

The failing-test / hotfix loop: run the narrowest vitest file first (`npm test -- tests/path/file.test.ts`), not the full suite.

For search/CLI work, include the focused suites under `tests/services/*Search*`,
`tests/services/graphPagination.test.ts`, and `tests/cli/`. Packaging changes must also run
`npm pack --dry-run` and confirm `scripts/lib/` is present.

## Dev workflow for non-trivial changes

README's [Development workflow](README.md#development-workflow) section is the canonical reference: **plan → execute task-by-task → verify diff before declaring done**. Skip the ceremony for typo-class fixes; apply it the moment a change touches `src/security/`, credentials, Graph permission scopes, or spans multiple files.

## Anti-patterns

- `fetch()` directly to `graph.microsoft.com` — route through `EmailService`.
- `path.resolve()` as a "safety" step — it doesn't follow symlinks or enforce the allowlist. Use `pathGuard.resolveSafe(path, 'read' | 'write')`.
- Base64 payloads >500 KB through `send_email` — use the hybrid tools (`send_email_from_attachment`, `send_email_with_file`).
- AI-generated attribution lines such as `Co-Authored-By: Claude` or `Generated with Claude Code` in commits or PR bodies.
- Returning an empty array after pagination, canary, fallback, or state parsing failed.
- Writing raw CLI arguments or Graph error text to `runs.jsonl`.
- Making `outlook harvest` apply or enqueue its own proposals.
- Comments that narrate what the code does. Comment only when the _why_ is non-obvious.
