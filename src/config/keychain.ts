import { execFileSync } from 'node:child_process';

const MAPPINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['MICROSOFT_GRAPH_CLIENT_ID', ['cpz::MICROSOFT_GRAPH_CLIENT_ID', 'cpz::SP_CLIENT_ID']],
  ['MICROSOFT_GRAPH_CLIENT_SECRET', ['cpz::MICROSOFT_GRAPH_CLIENT_SECRET', 'cpz::SP_CLIENT_SECRET']],
  ['MICROSOFT_GRAPH_TENANT_ID', ['cpz::MICROSOFT_GRAPH_TENANT_ID', 'cpz::SP_TENANT_ID']],
  ['TARGET_USER_EMAIL', ['cpz::TARGET_USER_EMAIL']],
] as const;

function lookupKeychain(service: string): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
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
  for (const [envVar, services] of MAPPINGS) {
    if (process.env[envVar]) continue;
    for (const svc of services) {
      const v = lookupKeychain(svc);
      if (v) {
        process.env[envVar] = v;
        break;
      }
    }
  }
}
