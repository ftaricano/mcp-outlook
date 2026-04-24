# CLAUDE.md — agent notes

Guidance for agents working **on this repo**. End-user docs (tool catalog, setup, troubleshooting) live in [README.md](README.md); don't duplicate them here.

## What this is

MCP server exposing Microsoft Graph email operations as 40 tools over stdio, plus a standalone `outlook` CLI wrapper. Auth is Azure AD client-credentials (no user login). Single-mailbox per process — `TARGET_USER_EMAIL` pins it.

## Hard invariants

These are enforced by CI or by design. Don't regress them.

1. **40 tools exactly.** `scripts/smoke-test.js:21` hardcodes `EXPECTED_TOOL_COUNT`. When adding/removing a tool, bump this constant and the tool table in [README.md](README.md).
2. **Every tool has a zod schema.** `src/schemas/toolSchemas.ts` is the gate — `HandlerRegistry.handleTool` runs `validateToolInput` before dispatching. No handler method runs on unvalidated args.
3. **Filesystem access goes through `pathGuard`.** Handlers never call `fs.readFile` / `fs.writeFile` on caller-supplied paths directly; `src/services/fileManager.ts` and `src/services/emailService.ts` already route through `pathGuard.resolveSafe()`. Any new file-touching code must go through the same door.
4. **Graph calls go through `EmailService`.** No direct `Client.api()` in handlers — that bypasses rate limiting, response caching, and retry.
5. **HTML templates do not escape content.** `src/templates/` renders raw input. Never feed untrusted strings into a template field.

## Architecture at a glance

```
src/
  config/     zod-validated env, fails fast
  auth/       MSAL client-credentials
  security/   pathGuard — filesystem allowlist (DOWNLOAD_DIR, MCP_EMAIL_UPLOAD_DIRS)
  services/   Graph wrapper: rate limit, cache, batch helpers
  schemas/    zod input schema per tool + jsonSchema converter
  handlers/   one class per domain, HandlerRegistry routes by tool name
  templates/  4 HTML themes
  utils/      rate limiter, file manager, attachment validator
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
| `npm run build && npm test && npm run smoke` | pre-PR — must all pass |
| `npm run test:coverage` | enforces coverage thresholds |
| `node scripts/live-readonly-smoke.js` | live Graph read smoke — requires real creds, not in CI |
| `node scripts/live-writes-smoke.js` | live Graph write smoke — same |

The failing-test / hotfix loop: run the narrowest vitest file first (`npm test -- tests/path/file.test.ts`), not the full suite.

## Dev workflow for non-trivial changes

README's [Development workflow](README.md#development-workflow) section is the canonical reference: **plan → execute task-by-task → verify diff before declaring done**. Skip the ceremony for typo-class fixes; apply it the moment a change touches `src/security/`, credentials, Graph permission scopes, or spans multiple files.

## Anti-patterns

- `fetch()` directly to `graph.microsoft.com` — route through `EmailService`.
- `path.resolve()` as a "safety" step — it doesn't follow symlinks or enforce the allowlist. Use `pathGuard.resolveSafe(path, 'read' | 'write')`.
- Base64 payloads >500 KB through `send_email` — use the hybrid tools (`send_email_from_attachment`, `send_email_with_file`).
- `Co-Authored-By: Claude` / "Generated with Claude Code" in commits or PR bodies — see the user's global `~/.claude/CLAUDE.md`.
- Comments that narrate what the code does. Comment only when the _why_ is non-obvious.
