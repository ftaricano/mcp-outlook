import { z } from 'zod';

/**
 * Environment schema. Validated once at startup so the server fails fast
 * with a clear error message instead of dying later inside a Graph call.
 */
const EnvSchema = z.object({
  MICROSOFT_GRAPH_CLIENT_ID: z
    .string()
    .min(1, 'MICROSOFT_GRAPH_CLIENT_ID is required')
    .uuid('MICROSOFT_GRAPH_CLIENT_ID must be a valid Azure AD application (client) UUID'),
  MICROSOFT_GRAPH_CLIENT_SECRET: z
    .string()
    .min(1, 'MICROSOFT_GRAPH_CLIENT_SECRET is required'),
  MICROSOFT_GRAPH_TENANT_ID: z
    .string()
    .min(1, 'MICROSOFT_GRAPH_TENANT_ID is required')
    .uuid('MICROSOFT_GRAPH_TENANT_ID must be a valid Azure AD tenant UUID'),
  TARGET_USER_EMAIL: z
    .string()
    .email('TARGET_USER_EMAIL must be a valid email address')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  DEBUG: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'),
  NODE_ENV: z.enum(['production', 'development', 'test']).optional().default('production'),
  MCP_SERVER_NAME: z.string().optional().default('mcp-email-server'),
  MCP_SERVER_VERSION: z.string().optional().default('2.1.0'),
  DOWNLOAD_DIR: z.string().optional(),
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().max(150).optional().default(25),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(
    public readonly issues: Array<{ path: string; message: string }>,
    message: string
  ) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate environment variables. Throws EnvValidationError with
 * all failures aggregated, so the operator can fix everything in one go.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    const summary = issues.map((i) => `  • ${i.path}: ${i.message}`).join('\n');
    throw new EnvValidationError(
      issues,
      `Invalid environment configuration:\n${summary}\n\n` +
        `Check your .env file or environment variables. See .env.example for reference.`
    );
  }
  return result.data;
}

/**
 * Redact a secret-like value for logs (show first 4 chars only).
 */
export function redact(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}
