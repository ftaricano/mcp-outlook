import { execFileSync } from 'node:child_process';

const DEFAULT_PREFIX = 'mcp-outlook';

const ENV_VARS = [
  'MICROSOFT_GRAPH_CLIENT_ID',
  'MICROSOFT_GRAPH_CLIENT_SECRET',
  'MICROSOFT_GRAPH_TENANT_ID',
  'TARGET_USER_EMAIL',
] as const;

function fallbackServicesFor(envVar: (typeof ENV_VARS)[number]): string[] {
  return (process.env[`OUTLOOK_KEYCHAIN_${envVar}_SERVICES`] ?? '')
    .split(',')
    .map((service) => service.trim())
    .filter(Boolean);
}

function serviceNamesFor(envVar: (typeof ENV_VARS)[number]): string[] {
  const prefix = process.env.OUTLOOK_KEYCHAIN_PREFIX?.trim() || DEFAULT_PREFIX;
  return [`${prefix}::${envVar}`, ...fallbackServicesFor(envVar)];
}

function lookupKeychain(service: string): string | null {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Populate Microsoft Graph env vars from the macOS Keychain when not already set.
 * No-op on non-darwin platforms. Existing process.env values win — Keychain is
 * a fallback so the same shell can override for testing without touching the chain.
 */
export function bootstrapKeychain(): void {
  if (process.platform !== 'darwin') return;
  for (const envVar of ENV_VARS) {
    if (process.env[envVar]) continue;
    for (const svc of serviceNamesFor(envVar)) {
      const v = lookupKeychain(svc);
      if (v) {
        process.env[envVar] = v;
        break;
      }
    }
  }
}
