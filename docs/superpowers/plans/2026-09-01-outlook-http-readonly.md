# Outlook HTTP read-only hardening

## Context

The Outlook plugin's stdio entrypoint intentionally supports independent,
explicit gates for local handoffs, mailbox writes, and outbound sending. The
loopback HTTP entrypoint is a separate transport boundary and must not inherit
those gates from deploy-time environment or private configuration. A reviewed
proxy/tunnel may expose this loopback service later, so its catalog must be
physically read-only before Cloudflare configuration proceeds.

## Scope

- Keep the existing stdio catalog and its independent gates unchanged.
- Force the HTTP entrypoint to expose only the twelve existing physically
  read-only plugin tools.
- Disable local attachment handoffs as well as mailbox writes and sending in
  the HTTP copy of the configuration; handoffs write local state and therefore
  are not read-only transport behavior.
- Prove the boundary with an authenticated Streamable HTTP test that starts
  from an adversarial config with all effectful gates enabled.
- Keep loopback binding, bearer handling, and the existing ingress work out of
  scope for this change.

## Implementation slices

1. Add a small, immutable HTTP policy projection that preserves mailbox and
   resource-limit settings while forcing `allowLocalHandoffs`, `allowWrites`,
   and `allowSend` to `false` and clearing `sendFromAlias`.
2. Construct the HTTP MCP server with that projection for every request, so a
   config object cannot turn the HTTP catalog effectful.
3. Extend the HTTP protocol tests with an adversarial config and assert the
   exact twelve-tool catalog, absence of handoff/write/send names, and a safe
   authenticated call. Keep the existing auth, parser, health, and loopback
   tests green.
4. Update the HTTP documentation and smoke fixture to state and exercise the
   transport-level guarantee without changing the stdio/plugin gate matrix.

## Acceptance criteria

- `tools/list` over the HTTP transport returns exactly the twelve read-only
  tools even when all three config gates are `true`.
- `create_attachment_handoff`, `move_messages`, `copy_messages`,
  `mark_messages`, `download_attachments`, `create_draft`, and `send_email`
  are absent from that HTTP catalog.
- The HTTP policy projection does not mutate or reuse a mutable caller config.
- Existing stdio gate-matrix tests remain unchanged and pass.
- No bearer, Graph credential, mailbox address, or message content is added to
  source, tests, logs, or documentation.
- Cloudflare/remote ingress is not changed until these checks pass.

## Verification

- Focused HTTP plugin tests.
- HTTP smoke test.
- Full `npm run verify`.
- `npm pack --dry-run` and inspect that `scripts/lib/` remains packaged.
- `git diff --check` and a fresh read-only review of the diff.
