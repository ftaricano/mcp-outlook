# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The loopback HTTP server refuses to start without `OUTLOOK_HTTP_BEARER_TOKEN`, unless
  `OUTLOOK_HTTP_ALLOW_NO_AUTH=true` is set explicitly. A blank token counts as missing.
- The stdio plugin warns on stderr when the send gate is on and
  `OUTLOOK_ALLOWED_RECIPIENT_DOMAINS` is unset.

### Added

- `CHANGELOG.md`, `CONTRIBUTING.md`, and issue and pull request templates.
- README: a one-line summary, a demo captured from the CLI with fictional data, and credits.

### Changed

- `AGENTS.md` is organized into Commands, Layout, Conventions and Don'ts.
- CI: secret scan with gitleaks, actions pinned to commit SHAs, and a manual
  `workflow_dispatch` trigger. Test files and scripts pass `npm run format:check` again.
- The default root for local attachment handoffs is now `~/.mcp-outlook/handoffs`. Bundles
  under the previous root are not migrated; handoffs are off unless
  `PLUGIN_ALLOW_LOCAL_HANDOFFS=true`.
- `author` in `package.json` and the plugin manifest is the GitHub handle. Examples and test
  fixtures use fictional names and `example.com` addresses.

### Removed

- The workflow that auto-merged Dependabot pull requests. Dependency updates are merged by a
  maintainer after CI.
- Internal planning documents under `docs/plans`, `docs/specs` and `docs/superpowers`;
  `docs/specs` is no longer part of the npm package.

## [2.3.0] - 2026-09-24

First tagged release. It covers the changes merged after 2.2.0; earlier history is in the
git log.

### Added

- Multi-mailbox plugin: attachment listing and content extraction, ZIP handling, batch
  search, folder statistics, and mailbox-write tools behind an opt-in gate (#61).
- Private local attachment handoffs, behind a separate opt-in gate (#69).
- Plugin tools for document investigation and attachment evidence inspection (#72).
- Outbound sender and recipient allowlists: `OUTLOOK_ALLOWED_SENDERS`, `OUTLOOK_SEND_FROM`
  and `OUTLOOK_ALLOWED_RECIPIENT_DOMAINS` (#74).

### Changed

- `@modelcontextprotocol/sdk` 1.30.0, plus `@azure/msal-node`, `mammoth` and development
  dependency updates (#64, #65, #71, #73).
- `AGENTS.md` is the single source of instructions for coding agents (#86).

### Fixed

- CLI: a closed stdin (`EPIPE`) is reported as an error instead of crashing (#62).
- The loopback HTTP entrypoint always serves the read-only catalog (#76).
- The private plugin configuration is read without re-opening its path, which closes a
  file-swap race (#77).
- Error logs written to stderr are redacted (#85).

[Unreleased]: https://github.com/ftaricano/mcp-outlook/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/ftaricano/mcp-outlook/releases/tag/v2.3.0
