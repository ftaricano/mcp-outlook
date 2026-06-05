/**
 * Helpers for constructing Microsoft Graph OData $filter fragments.
 *
 * Two sender-filter shapes exist on purpose:
 *
 * 1. `buildSenderContainsFilter(sender)` — `contains(...)`, case-insensitive,
 *    substring match. Used by `advanced_search` where the caller asked for a
 *    flexible search and a partial sender (e.g. just a username) is a valid
 *    UX. Previously `eq` made `--sender=bruno@x.com` silently return zero on
 *    mailboxes that stored the address with different casing (JAR-257 #1).
 *
 * 2. `buildSenderExactFilter(sender)` — `tolower(...) eq tolower(...)`,
 *    case-insensitive but exact equality. Used by `getEmailsFromSender()`
 *    where the caller's contract is "messages from this exact address".
 *    `contains()` here would silently broaden the result set (`bruno`
 *    matching `brunon@x.com`).
 *
 * Both shapes double single quotes in user-supplied input per the OData
 * ABNF; otherwise an address like `o'brien@x.com` produces a malformed
 * filter and (worse) opens a filter-injection avenue when the input flows
 * from an untrusted source (e.g. through an MCP client). Backslash,
 * parentheses, and other characters are not string-literal escape
 * characters in OData and do not need escaping inside `'…'`.
 */

export function escapeODataString(value: string): string {
  return String(value).replace(/'/g, "''");
}

/**
 * Encode a single caller-supplied value for safe interpolation into a Microsoft
 * Graph URL PATH segment (e.g. `/mailFolders/${seg}`, `/messages/${seg}`).
 *
 * The Graph SDK does NOT sanitize path segments: a raw `/` injects extra route
 * segments (changing which resource is hit) and a `?` smuggles real OData query
 * params (e.g. `$expand=attachments($select=contentBytes)`). encodeURIComponent
 * collapses the value into one inert segment (`/`→`%2F`, `?`→`%3F`, `#`→`%23`,
 * space→`%20`), while legitimate well-known names ("inbox") and base64 folder/
 * message ids round-trip correctly — Graph percent-decodes the segment server
 * side. Layer this at the URL boundary on top of the zod `folderRef` validation.
 */
export function encodeGraphSegment(value: string): string {
  const raw = String(value);
  // Fail closed on relative-path segments. Neither encodeURIComponent NOR
  // percent-encoding the dots stops these: the WHATWG URL/Request parser
  // normalizes "."/".." AND their %2e/%2E forms before fetch, so a ".." segment
  // collapses e.g. `/messages/{id}/attachments/..` to a different Graph route.
  // A legitimate folder/message id is never exactly "." or "..".
  if (raw === '.' || raw === '..') {
    throw new Error(`unsafe Graph path segment: ${JSON.stringify(raw)}`);
  }
  return encodeURIComponent(raw);
}

/**
 * Substring match on the sender address, case-insensitive on Graph.
 * Prefer this for caller-facing search where partial matches are useful.
 */
export function buildSenderContainsFilter(sender: string): string {
  return `contains(from/emailAddress/address,'${escapeODataString(sender)}')`;
}

/**
 * Case-insensitive equality on the sender address. Use when the caller
 * contract is "exactly this address" — `getEmailsFromSender()` etc.
 */
export function buildSenderExactFilter(sender: string): string {
  const escaped = escapeODataString(sender).toLowerCase();
  return `tolower(from/emailAddress/address) eq '${escaped}'`;
}
