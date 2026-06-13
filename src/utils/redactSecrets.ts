/**
 * Redact secrets that may surface inside an error message before it reaches the
 * MCP client. Extracted from the former `ErrorHandler.createSafeErrorMessage`
 * (dead code — never invoked) and wired into `BaseHandler.formatError`, which
 * previously emitted `error.message` verbatim.
 *
 * Fail-safe by design: on the error path we prefer over-masking (e.g. a long
 * Graph message id mistaken for a token) over leaking a credential.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '[email]')
    .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, '[token]')
    .replace(/\bpassword\s*[:=]\s*\S+/gi, 'password: [hidden]');
}
