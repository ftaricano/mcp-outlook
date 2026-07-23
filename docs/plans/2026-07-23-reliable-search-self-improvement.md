# JAR-680 - Reliable Search and Governed Self-Improvement

Date: 2026-07-23
Issue: JAR-680
Branch: `feat/JAR-680-reliable-search`

## Objective

Make the Outlook CLI safer for agents by eliminating first-page false negatives,
returning machine-readable search evidence, persisting saved searches across one-shot
CLI invocations, and recording sanitized run outcomes that can produce governed learning
proposals.

The CLI must never edit its own source or apply learning automatically. It may detect
recurring signals and emit proposals; application remains owned by the existing
`session-harvest` and `autonomy-policy` gates.

## Compatibility Constraints

1. Keep exactly 40 MCP tools.
2. Existing human-readable text remains the default output.
3. Existing `--compact` behavior remains available as the raw MCP result envelope.
4. Graph calls remain inside `EmailService` or `GraphOptimizer`.
5. Caller-controlled filesystem paths continue through `pathGuard`.
6. Run telemetry must not store credentials, message bodies, subjects, addresses, query
   values, attachment names, or raw Graph errors.
7. Search failure, incomplete scanning, and empty results must remain distinct states.

## Deliverables

### 1. Shared Graph pagination

Add a tested pagination collector that:

- follows the complete `@odata.nextLink` URL returned by Graph;
- stops at `maxItems` or `maxPages`;
- reports `pagesScanned`, `itemsScanned`, `truncated`, and the remaining next link;
- never converts a page-fetch failure into an empty result.

Use it in optimized listing and search paths that currently inspect only `response.value`.

### 2. Reliable search evidence

Add a stable search result contract:

```ts
type SearchStatus =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'SEARCH_INCOMPLETE'
  | 'SEARCH_FAILED'
  | 'SEARCH_UNTRUSTED';
```

The result includes:

- strategy used;
- result messages;
- pages and candidates scanned;
- truncation;
- retry/failure warnings where observable;
- confidence;
- whether a negative canary indicated that Graph ignored `$search`.

For text queries:

1. execute Graph `$search`;
2. execute a deterministic impossible canary query;
3. compare ordered message IDs;
4. if suspicious or empty, fall back to a bounded paginated local scan over message
   subject/body preview/body/sender and attachment names;
5. only return `NOT_FOUND` when the fallback scan is exhaustive for the selected window;
6. return `SEARCH_INCOMPLETE` when limits prevent an exhaustive negative conclusion.

`advanced_search` and the other search handlers expose this evidence through MCP
`structuredContent` while preserving the existing text.

### 3. Agent-oriented CLI output

Add:

```text
--output=text   default human-readable output
--output=json   structuredContent when supplied, otherwise a stable fallback object
--output=mcp    raw MCP result envelope
```

Keep `--compact` as a backwards-compatible alias for `--output=mcp`.

### 4. Persistent saved searches

Replace the process-local `Map` with an atomic JSON store:

- root: `OUTLOOK_STATE_DIR`, defaulting to the platform user state directory;
- file mode `0600`;
- schema/version validation;
- save/list/execute/delete persists between one-shot CLI processes;
- corrupt state fails loudly without overwriting the original file.

### 5. Sanitized run journal and feedback

Each server-backed CLI call records a JSONL event unless `--no-journal` is set:

- generated `runId`;
- optional `--session`;
- timestamp, command, duration, exit status;
- argument names and value types only;
- structured search status and counters when present;
- normalized error class, never raw error text.

Add local commands:

```text
outlook feedback <runId> --outcome=<correct|missed|wrong_match|failed>
outlook harvest --since=7d [--dry-run] [--skill-target=outlook-mcp]
```

Feedback is a separate JSONL event linked by `runId`.

Harvest:

- reads the journal without credentials or Graph startup;
- requires recurrence of at least two matching events;
- reports recurring failures, incomplete/untrusted searches, and negative feedback;
- emits `learning-proposals` compatible proposal objects;
- never enqueues or applies proposals automatically.

### 6. Documentation and ecosystem alignment

Update:

- `README.md`;
- repository `CLAUDE.md` invariants and test commands where needed;
- `outlook-mcp` skill examples and session-harvest integration;
- canonical gotchas only when verified behavior supersedes existing text.

Do not close JAR-493: its live mailbox verification remains separate.
Do not close JAR-674: it governs hub-wide skill telemetry beyond this CLI.

## TDD Task Sequence

### Task A - Pagination primitive

Files:

- `src/services/graphPagination.ts`
- `tests/services/graphPagination.test.ts`

RED:

- second-page match is returned;
- item limit marks truncation;
- page limit marks truncation;
- next-page error rejects.

GREEN:

- implement minimal collector.

Verification:

```bash
npm test -- tests/services/graphPagination.test.ts
```

### Task B - Search result and canary/local fallback

Files:

- `src/services/reliableSearch.ts`
- `tests/services/reliableSearch.test.ts`
- `src/services/emailService.ts`
- `src/services/graphOptimizer.ts`

RED:

- identical real/canary IDs trigger fallback;
- empty `$search` triggers fallback;
- exhaustive fallback yields `NOT_FOUND`;
- bounded fallback yields `SEARCH_INCOMPLETE`;
- fallback match yields `FOUND`;
- Graph failure yields `SEARCH_FAILED`, not empty.

GREEN:

- implement pure comparison/matching helpers;
- integrate paginated Graph requests.

Verification:

```bash
npm test -- tests/services/reliableSearch.test.ts tests/services/graphPagination.test.ts
```

### Task C - Structured MCP output

Files:

- `src/handlers/BaseHandler.ts`
- `src/handlers/SearchHandler.ts`
- `src/index.ts`
- `tests/handlers/SearchHandler.test.ts`

RED:

- search success contains `structuredContent`;
- empty/incomplete/failure statuses remain distinct;
- text output remains compatible.

GREEN:

- extend `HandlerResult`;
- return the structured result alongside text.

### Task D - Persistent saved searches

Files:

- `src/services/savedSearchStore.ts`
- `tests/services/savedSearchStore.test.ts`
- `src/services/emailService.ts`

RED:

- saved value survives a new store instance;
- delete persists;
- file is mode `0600`;
- corrupt JSON fails without overwrite.

GREEN:

- atomic temp-file plus rename implementation.

### Task E - CLI output and journal

Files:

- `scripts/lib/run-journal.js`
- `scripts/outlook.js`
- `tests/cli/run-journal.test.ts`
- `tests/cli/exit-handling.test.ts`

RED:

- `--output=json` selects structured content;
- `--output=mcp` preserves the envelope;
- journal contains no raw argument values;
- error journal stores only normalized class;
- `--no-journal` writes nothing.

GREEN:

- refactor CLI finish/failure paths around one recorder.

### Task F - Feedback and harvest

Files:

- `scripts/lib/run-journal.js`
- `scripts/lib/harvest.js`
- `scripts/outlook.js`
- `tests/cli/harvest.test.ts`

RED:

- feedback links to an existing run;
- unknown run ID fails;
- one event produces no proposal;
- two recurring signals produce one deduplicated proposal;
- harvest does not modify the learning queue.

GREEN:

- implement local subcommands without starting MCP or loading credentials.

### Task G - Documentation and full verification

Files:

- `README.md`
- `CLAUDE.md`
- relevant skill/canonical documentation through their governed boundaries

Verification:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run smoke
node scripts/outlook.js --help
```

Run CLI integration tests with the fake MCP server for text, JSON, MCP, journal,
feedback, and harvest paths. Do not run live mailbox searches as part of JAR-680.

## Review Gate

After all tests pass:

1. inspect the complete diff;
2. search all journal-writing paths for raw argument/error persistence;
3. run an adversarial reviewer against pagination boundaries, corrupt state, concurrent
   one-shot calls, Unicode queries, numeric queries, and empty values;
4. fix every blocker and rerun focused plus full gates;
5. only then create a PR.

## Completion Evidence

JAR-680 is complete only when:

- every deliverable above has direct test or command evidence;
- the tool count remains 40;
- the branch contains no secrets or mailbox data;
- full verification commands pass freshly;
- the PR is open and the Linear issue is moved to In Review, not Done;
- the requested session harvest is run and its applied/proposed items are reported.
