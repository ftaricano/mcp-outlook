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
 *
 * Without a warning here, a caller whose Keychain entry lives under a non-default
 * service (e.g. an existing `cpz::SP_CLIENT_ID` from another tool) only sees a
 * downstream `MICROSOFT_GRAPH_CLIENT_ID is required` from env validation and has
 * no signal that the Keychain was consulted at all (JAR-259). We log a single
 * stderr summary listing exactly which services were tried so the operator can
 * point at the right one via `OUTLOOK_KEYCHAIN_<VAR>_SERVICES`. Set
 * `OUTLOOK_KEYCHAIN_QUIET=1` to silence the warning (CI / tests).
 */
export function bootstrapKeychain(): void {
  if (process.platform !== 'darwin') return;
  const failures: Array<{ envVar: string; servicesTried: string[] }> = [];
  for (const envVar of ENV_VARS) {
    if (process.env[envVar]) continue;
    const services = serviceNamesFor(envVar);
    let found = false;
    for (const svc of services) {
      const v = lookupKeychain(svc);
      if (v) {
        process.env[envVar] = v;
        found = true;
        break;
      }
    }
    if (!found) failures.push({ envVar, servicesTried: services });
  }

  if (failures.length === 0) return;
  if (process.env.OUTLOOK_KEYCHAIN_QUIET) return;

  const lines = failures
    .map(
      ({ envVar, servicesTried }) =>
        `  • ${envVar}: unset; Keychain miss for [${servicesTried.join(', ')}]`
    )
    .join('\n');
  process.stderr.write(
    `[mcp-outlook] Keychain bootstrap left ${failures.length} variable(s) unresolved:\n` +
      lines +
      '\n' +
      `  Set the env var directly, or point at an existing Keychain entry with\n` +
      `  OUTLOOK_KEYCHAIN_<VAR>_SERVICES (comma-separated services to try in order).\n`
  );
}
