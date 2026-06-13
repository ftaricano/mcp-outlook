/**
 * Redact secrets that may surface inside an error string before it reaches the
 * MCP client. Extracted from a former centralized error-handling helper (dead
 * code, never invoked) and wired into the live error path (BaseHandler
 * formatError / redactError), which previously emitted raw error text verbatim.
 *
 * Fail-safe by design: on the error path we prefer over-masking (e.g. a long
 * Graph message id mistaken for a token) over leaking a credential. Every
 * pattern is linear (no nested quantifiers) to avoid ReDoS on attacker text.
 */
export function redactSecrets(message: string): string {
  return (
    message
      // JWT / Graph access tokens: eyJ<base64url>.<base64url>.<base64url>.
      // Handled before the generic base64 rule so the dots don't split it.
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
      // `Bearer <token>` authorization values.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [token]')
      // Named secret assignments: password/secret/token/api_key = value.
      .replace(
        /\b(password|client_secret|access_token|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi,
        '$1: [hidden]'
      )
      // Email addresses.
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '[email]')
      // Long opaque base64 / base64url blobs (covers bare tokens / Azure keys).
      .replace(/\b[A-Za-z0-9+/_-]{20,}={0,2}\b/g, '[token]')
  );
}

/**
 * Build a redacted error line for the MCP client. Single source of truth for
 * every error path that crosses the boundary — the per-handler `formatError`
 * and the top-level `CallToolRequestSchema` catch in `index.ts`. The whole line
 * is masked because the caller-supplied `prefix` can itself carry an
 * interpolated raw error.
 */
export function formatRedactedError(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : 'Erro desconhecido';
  return redactSecrets(`${prefix}: ${detail}`);
}
