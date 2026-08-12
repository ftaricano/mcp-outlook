# Privacy

`mcp-outlook` processes Microsoft Outlook data only when an operator configures Microsoft
Graph credentials and invokes a tool.

The multi-mailbox plugin defaults to ten read-only tools. In that mode, it:

- reads only mailboxes listed in the operator's private allowlist;
- returns bounded message metadata, body content, and explicitly requested attachment content;
- does not draft, move, copy, mark, download, send, or delete email;
- does not transmit mailbox data to a service operated by this repository's maintainer;
- does not include analytics or telemetry in the plugin transport.

Operators may explicitly enable five additional tools that create drafts, move or copy messages,
mark messages read or unread, and download attachments to the configured local download root.
Even with those tools enabled, the plugin cannot send or delete email because it exposes no such
tool or dispatch path.

Microsoft Graph credentials, mailbox configuration, and message data remain in the operator's
deployment environment. The optional private search-memory file remains local and is never
included in plugin telemetry. The optional CLI run journal is metadata-only and excludes
subjects, addresses, bodies, attachment names, credentials, and raw Graph errors.

Operators are responsible for their Microsoft tenant configuration, access policies, retention,
and any external OAuth proxy used for remote deployment.
