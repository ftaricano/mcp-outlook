# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/ftaricano/mcp-outlook/security/advisories/new

Do not open a public issue for credential leaks, mailbox-access bugs, path traversal, prompt-injection exfiltration paths, or Microsoft Graph permission bypasses.

## Supported Versions

Security fixes target the default branch first. If the project starts publishing versioned releases, supported release lines will be listed here.

## Security-Sensitive Areas

Extra review is required for changes touching:

- Microsoft Graph credential loading and token acquisition
- Graph permission scopes and mailbox targeting
- Attachment downloads, uploads, and local file reads
- `src/security/pathGuard.ts`
- HTML email template rendering
- MCP tool schemas and argument validation

## Credential Handling

Never commit `.env`, client secrets, downloaded mailbox data, attachment artifacts, logs, or JSONL traces. Rotate Azure AD client secrets immediately if they are exposed.
