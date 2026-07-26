# Outlook Multi-Mailbox Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Preserve the existing Outlook CLI while adding a secure, read-only, multi-mailbox MCP plugin for Codex and ChatGPT.

**Architecture:** Refactor mailbox choice into an immutable `EmailService` dependency, then place a bounded multi-mailbox orchestration layer above it. Reuse one four-tool MCP server factory from both stdio and stateless Streamable HTTP transports, leaving the original 40-tool server unchanged.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Microsoft Graph SDK, MCP TypeScript SDK 1.29, Vitest, native Node HTTP/Express adapter from the MCP SDK.

---

## File Map

- Modify `src/services/emailService.ts`: store immutable mailbox identity and replace direct
  `process.env.TARGET_USER_EMAIL` reads.
- Modify `src/services/graphOptimizer.ts`: accept immutable mailbox identity.
- Create `src/plugin/config.ts`: load and validate the deployment-specific mailbox allowlist.
- Create `src/plugin/MultiMailboxService.ts`: mailbox service factory and bounded fan-out.
- Create `src/plugin/schemas.ts`: four plugin input schemas and output-facing types.
- Create `src/plugin/createPluginServer.ts`: register the four read-only MCP tools.
- Create `src/plugin/stdio.ts`: local plugin transport.
- Create `src/plugin/http.ts`: loopback-only authenticated stateless Streamable HTTP transport
  and health.
- Create `tests/plugin/config.test.ts`: configuration validation and filesystem guards.
- Create `tests/plugin/MultiMailboxService.test.ts`: allowlist and fan-out behavior.
- Create `tests/plugin/createPluginServer.test.ts`: plugin tool contract.
- Create `tests/plugin/http.test.ts`: HTTP authorization, host policy, and MCP round-trip.
- Create `scripts/plugin-smoke-test.js`: stdio tools/list smoke.
- Create `scripts/plugin-http-smoke.js`: live local HTTP MCP smoke.
- Create `scripts/generate-app-manifest.js`: deterministic `.app.json` generator.
- Create `.codex-plugin/plugin.json`: plugin metadata.
- Create `.mcp.json`: local Codex plugin MCP declaration.
- Modify `.gitignore`: ignore generated `.app.json` and private plugin configuration.
- Modify `package.json`: add plugin entrypoints and verification scripts.
- Modify `README.md`: architecture, setup, security boundary, Codex and ChatGPT installation.
- Modify `CLAUDE.md`: update invariants and validation commands.
- Modify `.github/workflows/ci.yml`: validate both plugin transports and package contents.
- Modify `vitest.config.ts`: include testable plugin modules in coverage.

### Task 1: Make Mailbox Identity Immutable

**Files:**
- Modify: `src/services/emailService.ts`
- Modify: `src/services/graphOptimizer.ts`
- Test: `tests/services/emailServiceMailbox.test.ts`
- Test: `tests/services/graphOptimizer.test.ts`

- [x] **Step 1: Write failing mailbox-isolation tests**

Create two `EmailService` instances with distinct mailbox constructor options, invoke an
endpoint-producing operation on each, mutate `process.env.TARGET_USER_EMAIL` between calls,
and assert that captured Graph paths remain pinned to the constructor mailbox.

```typescript
const first = createService({ targetUserEmail: 'first@example.com', calls });
const second = createService({ targetUserEmail: 'second@example.com', calls });
process.env.TARGET_USER_EMAIL = 'changed@example.com';

await first.getEmailById('message-1');
await second.getEmailById('message-2');

expect(calls).toEqual([
  '/users/first@example.com/messages/message-1',
  '/users/second@example.com/messages/message-2',
]);
```

- [x] **Step 2: Verify the tests fail for the current process-global behavior**

Run:

```bash
npm test -- tests/services/emailServiceMailbox.test.ts tests/services/graphOptimizer.test.ts
```

Expected: the new test observes `changed@example.com` or a missing constructor option.

- [x] **Step 3: Add an immutable mailbox option**

Add:

```typescript
export interface EmailServiceOptions {
  targetUserEmail?: string;
}
```

Resolve the constructor value once:

```typescript
this.targetUserEmail = options.targetUserEmail ?? process.env.TARGET_USER_EMAIL ?? 'me';
```

Pass the same value into `GraphOptimizer`. Replace all direct reads of
`process.env.TARGET_USER_EMAIL` in both services with the immutable field.

- [x] **Step 4: Run focused and compatibility tests**

```bash
npm test -- tests/services/emailServiceMailbox.test.ts tests/services/graphOptimizer.test.ts tests/services/emailServiceSearch.test.ts
```

Expected: all selected suites pass.

### Task 2: Validate the Private Mailbox Configuration

**Files:**
- Create: `src/plugin/config.ts`
- Test: `tests/plugin/config.test.ts`

- [x] **Step 1: Write failing tests for valid and invalid files**

Cover:

```typescript
expect(loadPluginConfig(validPath).mailboxes.map((m) => m.alias)).toEqual([
  'finance',
  'billing',
]);
expect(() => loadPluginConfig(symlinkPath)).toThrow(/regular file/i);
expect(() => loadPluginConfig(duplicateAliasPath)).toThrow(/duplicate alias/i);
expect(() => loadPluginConfig(groupReadablePath)).toThrow(/owner-readable/i);
```

Also assert rejection of uppercase aliases, duplicate addresses, empty arrays, invalid emails,
and limits outside their bounded ranges.

- [x] **Step 2: Verify the tests fail**

```bash
npm test -- tests/plugin/config.test.ts
```

Expected: module-not-found failure for `src/plugin/config.ts`.

- [x] **Step 3: Implement strict Zod and filesystem validation**

Use `lstatSync` before `realpathSync`, reject symbolic links, require a regular file, and on
POSIX reject `(mode & 0o077) !== 0`. Parse JSON through a Zod schema with these defaults:

```typescript
maxConcurrentMailboxes: 3
maxMailboxesPerSearch: 8
maxResultsPerMailbox: 20
maxBodyChars: 12000
```

Build immutable `Map<string, MailboxConfig>` entries after checking duplicate aliases and
addresses.

- [x] **Step 4: Run the focused suite**

```bash
npm test -- tests/plugin/config.test.ts
```

Expected: all configuration cases pass.

### Task 3: Add Bounded Multi-Mailbox Orchestration

**Files:**
- Create: `src/plugin/MultiMailboxService.ts`
- Create: `src/plugin/schemas.ts`
- Test: `tests/plugin/MultiMailboxService.test.ts`

- [x] **Step 1: Write failing allowlist and partial-failure tests**

Use a factory that records requested addresses and returns fake services:

```typescript
await expect(service.searchMailbox('unknown', criteria)).rejects.toThrow(
  /unknown mailbox alias/i
);

const result = await service.searchMailboxes(['finance', 'billing'], criteria);
expect(result.results.map((entry) => entry.mailbox)).toEqual(['finance', 'billing']);
expect(result.results[0].status).toBe('FOUND');
expect(result.results[1].status).toBe('SEARCH_FAILED');
```

Track active calls and assert they never exceed `maxConcurrentMailboxes`.

- [x] **Step 2: Verify the tests fail**

```bash
npm test -- tests/plugin/MultiMailboxService.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Implement the service factory and concurrency pool**

The constructor receives the parsed config and:

```typescript
type EmailServiceFactory = (mailboxAddress: string) => Pick<
  EmailService,
  'advancedSearchEmailsDetailed' | 'getEmailById'
>;
```

Resolve aliases through the map before creating a service. Implement a fixed worker pool over
the selected aliases. Preserve result order, convert thrown mailbox errors into a redacted
`SEARCH_FAILED` entry, and never return a clean global negative when any mailbox is incomplete,
untrusted, or failed.

- [x] **Step 4: Run the focused suite**

```bash
npm test -- tests/plugin/MultiMailboxService.test.ts
```

Expected: all allowlist, limit, order, and partial-failure cases pass.

### Task 4: Build the Four-Tool Plugin MCP Server

**Files:**
- Create: `src/plugin/createPluginServer.ts`
- Create: `src/plugin/stdio.ts`
- Test: `tests/plugin/createPluginServer.test.ts`
- Create: `scripts/plugin-smoke-test.js`

- [x] **Step 1: Write a failing tools/list contract test**

Initialize the server through an in-memory MCP client and assert:

```typescript
expect(tools.map((tool) => tool.name)).toEqual([
  'list_allowed_mailboxes',
  'search_mailbox',
  'search_mailboxes',
  'get_message',
]);
expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
```

Call `search_mailboxes` and assert `structuredContent` retains each mailbox status.

- [x] **Step 2: Verify the test fails**

```bash
npm test -- tests/plugin/createPluginServer.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Register narrow read-only tools**

Create an `McpServer` with four tools. Each tool must:

- use the schemas from `src/plugin/schemas.ts`;
- include `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`;
- return concise text plus machine-readable `structuredContent`;
- bound subjects, previews, body text, and result counts;
- label email bodies as untrusted content in the text response.

- [x] **Step 4: Add the stdio entrypoint and smoke script**

`src/plugin/stdio.ts` loads environment, plugin config, auth, path guard, and the plugin server,
then connects `StdioServerTransport`. The smoke script spawns `dist/plugin/stdio.js`, performs
MCP initialization and `tools/list`, and asserts exactly four names.

- [x] **Step 5: Run focused tests and smoke**

```bash
npm run build
node scripts/plugin-smoke-test.js
npm test -- tests/plugin/createPluginServer.test.ts
```

Expected: build succeeds, smoke reports four tools, and tests pass.

### Task 5: Add Loopback-Only Authenticated Streamable HTTP

**Files:**
- Create: `src/plugin/http.ts`
- Test: `tests/plugin/http.test.ts`
- Create: `scripts/plugin-http-smoke.js`

- [x] **Step 1: Write failing HTTP policy tests**

Cover:

```typescript
expect(start({ host: '0.0.0.0' })).rejects.toThrow(/loopback/i);
expect(await request('/health')).toMatchObject({ status: 200 });
expect(await request('/mcp', { bearer: 'wrong' })).toMatchObject({ status: 401 });
```

Complete an MCP initialize, tools/list, and `list_allowed_mailboxes` call against a loopback
server with fake services.

- [x] **Step 2: Verify the tests fail**

```bash
npm test -- tests/plugin/http.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Implement the HTTP server**

Use `createMcpExpressApp()` and a fresh stateless `StreamableHTTPServerTransport` per POST.
Refuse any host except `127.0.0.1`, `localhost`, or `::1`. Authenticate with `timingSafeEqual`
before calling `transport.handleRequest` when a bearer is configured. Return `405` for
unsupported GET/DELETE `/mcp` requests. `/health` returns only:

```json
{ "ok": true, "service": "mcp-outlook-plugin", "version": "2.2.0" }
```

Do not log request bodies, authorization headers, message IDs, addresses, subjects, or errors
before redaction.

- [x] **Step 4: Add a live local smoke**

The script starts the built HTTP server on an ephemeral loopback port with a temporary config
and fake Graph mode, then uses `StreamableHTTPClientTransport` to initialize, list tools, and
call `list_allowed_mailboxes`.

- [x] **Step 5: Run focused tests and smoke**

```bash
npm run build
npm test -- tests/plugin/http.test.ts
node scripts/plugin-http-smoke.js
```

Expected: authorization tests pass and the live round-trip reports success.

### Task 6: Package the Codex Plugin and ChatGPT App Mapping

**Files:**
- Create: `.codex-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `scripts/generate-app-manifest.js`
- Modify: `.gitignore`
- Test: `tests/cli/pluginPackaging.test.ts`

- [x] **Step 1: Write failing packaging tests**

Assert the manifest contains:

```json
{
  "name": "outlook-multi-mailbox",
  "version": "2.2.0",
  "description": "Read-only Outlook search across explicitly allowed mailboxes"
}
```

Assert `.mcp.json` invokes `${CODEX_PLUGIN_ROOT}/dist/plugin/stdio.js`. Run the app-manifest
generator with `plugin_asdk_app_123` and assert:

```json
{
  "apps": {
    "outlook_multi_mailbox": {
      "id": "asdk_app_123",
      "required": true
    }
  }
}
```

Reject IDs that do not start with `plugin_asdk_app_`, and assert that the generator adds
`"apps": "./.app.json"` to the selected plugin manifest.

- [x] **Step 2: Verify the tests fail**

```bash
npm test -- tests/cli/pluginPackaging.test.ts
```

Expected: missing manifest files or generator.

- [x] **Step 3: Add manifests and generator**

Keep `.app.json` ignored because its connection ID is installation-specific. The generator
accepts:

```bash
node scripts/generate-app-manifest.js \
  --connection-id plugin_asdk_app_123 \
  --output .app.json
```

It writes atomically with a final newline and refuses to overwrite unless `--force` is passed.

- [x] **Step 4: Run packaging validation**

```bash
npm test -- tests/cli/pluginPackaging.test.ts
npm pack --dry-run
```

Expected: packaging tests pass and the tarball includes plugin manifests, built plugin
entrypoints, generator, and documentation.

### Task 7: Update Scripts and Documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`

- [x] **Step 1: Add package scripts**

Add:

```json
"start:plugin": "node dist/plugin/stdio.js",
"start:http": "node dist/plugin/http.js",
"smoke:plugin": "node scripts/plugin-smoke-test.js",
"smoke:http": "node scripts/plugin-http-smoke.js",
"verify": "npm run lint && npm run typecheck && npm test && npm run build && npm run smoke && npm run smoke:plugin && npm run smoke:http"
```

- [x] **Step 2: Document setup and trust boundaries**

README sections must cover:

- CLI versus plugin use cases;
- private config format and permissions;
- local Codex plugin installation from the repository;
- starting the HTTP server;
- connecting the remote MCP in ChatGPT developer mode;
- generating `.app.json` after obtaining the real app connection ID;
- explicit warning that public exposure requires a separately reviewed HTTPS OAuth 2.1
  resource-server layer and a read-only Graph app registration;
- read-only plugin tool table;
- existing CLI as the fallback path.

- [x] **Step 3: Update repository invariants**

Document that the original server remains exactly 40 tools and the plugin remains exactly four
read-only tools. Update the canonical validation command to `npm run verify`.

- [x] **Step 4: Validate documentation and packaging**

```bash
npm run format:check
npm pack --dry-run
rg -n "TARGET_USER_EMAIL|OUTLOOK_PLUGIN_CONFIG|search_mailboxes|Streamable HTTP" README.md CLAUDE.md
```

Expected: formatting passes and every new contract is documented.

### Task 8: Full Verification and Independent Review

**Files:**
- Review: all changed files

- [x] **Step 1: Run the complete deterministic gate**

```bash
npm run verify
npm run test:coverage
npm audit --omit=dev
```

Expected: all checks pass. Any audit finding is reported with package, severity, runtime reach,
and remediation decision.

- [x] **Step 2: Run credential-free behavioral QA**

Start the HTTP server with a temporary fictional allowlist and fake Graph service. Observe:

1. `/health` returns `200`;
2. wrong bearer returns `401`;
3. MCP initialize succeeds;
4. tools/list returns four tools;
5. multi-mailbox search returns independent evidence;
6. unknown alias fails before any fake Graph call;
7. original `outlook list` still returns 40 tools.

- [x] **Step 3: Run adversarial reviews**

Review the complete `git diff origin/main...HEAD` through these independent lenses:

- correctness and compatibility;
- authentication, allowlist, prompt injection, and data leakage;
- concurrency, partial failure, and search-evidence semantics.

Every critical or major finding must be fixed and re-reviewed.

- [x] **Step 4: Perform final read-after-write and repository hygiene**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
rg -n "T[B]D|T[O]DO|implement la[t]er|fill in detai[l]s|real tenant|real mailbox" \
  docs/specs docs/superpowers/plans README.md src tests scripts
```

Expected: no whitespace errors, no generated private config, no deployment-specific data, and
only intended files changed.

## Execution Evidence

Completed on July 26, 2026.

- `npm run verify`: 33 test files passed; 346 tests passed and 1 skipped; original MCP smoke
  reported 40 tools; plugin stdio smoke reported 4 read-only tools; authenticated loopback HTTP
  smoke passed.
- `npm run test:coverage`: 88.36% statements, 78.19% branches, 91.6% functions, and 89.1%
  lines.
- `npm audit --json`: 0 vulnerabilities across production and development dependencies.
- `npm pack --dry-run`: 167 package entries with plugin manifests, built entrypoints, icon,
  privacy policy, generator, and documentation.
- Clean production-only tarball installation passed from a directory containing spaces; both
  plugin smokes passed and no download directory was created.
- `gitleaks dir . --no-banner --redact`: no leaks found.
- Independent adversarial review initially blocked excessive multi-mailbox content scanning.
  The public schema now rejects caller-controlled scan limits, fan-out scans are capped at 100
  metadata-only messages per mailbox, and full message bodies remain exclusive to
  `get_message`. Re-review verdict: `APPROVED`.
- No real Microsoft Graph calls, credentials, mailbox allowlist, public endpoint, tunnel, or
  ChatGPT connection ID were created during implementation or verification.
