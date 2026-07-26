# Privacy

`mcp-outlook` processes Microsoft Outlook data only when an operator configures Microsoft
Graph credentials and invokes a tool.

The read-only plugin:

- reads only mailboxes listed in the operator's private allowlist;
- returns bounded message metadata and, for an explicit message read, bounded body content;
- does not send, draft, delete, move, or modify email;
- does not transmit mailbox data to a service operated by this repository's maintainer;
- does not include analytics or telemetry in the plugin transport.

Microsoft Graph credentials, mailbox configuration, and message data remain in the operator's
deployment environment. The optional CLI run journal is metadata-only and excludes subjects,
addresses, bodies, attachment names, credentials, and raw Graph errors.

Operators are responsible for their Microsoft tenant configuration, access policies, retention,
and any external OAuth proxy used for remote deployment.
