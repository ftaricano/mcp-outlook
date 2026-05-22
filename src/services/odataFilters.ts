/**
 * Helpers for constructing Microsoft Graph OData $filter fragments.
 *
 * The Graph API treats `field eq 'literal'` as case-sensitive on string
 * properties, so a sender lookup against `from/emailAddress/address` only
 * matches when the caller's casing exactly equals what the mailbox stored —
 * which the caller has no reliable way to know. `contains()` is documented
 * as case-insensitive on Graph and gives the equality-with-case-flex
 * behaviour callers expect (JAR-257 bug #1).
 *
 * Single quotes in user-supplied input must be doubled per the OData ABNF;
 * otherwise an address like `o'brien@x.com` produces a malformed filter
 * and (worse) opens a filter-injection avenue if the input is attacker-
 * controlled (e.g. coming through an MCP client).
 */

export function escapeODataString(value: string): string {
  return String(value).replace(/'/g, "''");
}

/**
 * Build a Graph $filter fragment that matches when `from/emailAddress/address`
 * contains the given sender substring. Case-insensitive on Graph.
 */
export function buildSenderContainsFilter(sender: string): string {
  return `contains(from/emailAddress/address,'${escapeODataString(sender)}')`;
}
