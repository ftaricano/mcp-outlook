import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * pathGuard — gatekeeper for every filesystem path that enters the MCP server.
 *
 * Threat model: the server is driven by an LLM that consumes untrusted content
 * (email bodies). A prompt injection can coerce the model into calling file
 * tools with attacker-chosen paths. Without this guard, the server would read
 * `~/.ssh/id_rsa`, `~/.aws/credentials`, `.env`, etc., and exfiltrate via
 * `send_email`. We defend by:
 *
 *   1. canonicalising the requested path (`fs.realpathSync` when it exists,
 *      `path.resolve` otherwise) so `..` tricks cannot escape,
 *   2. requiring the result to live inside one of a small allowlist of roots,
 *   3. rejecting symlinks — a symlink inside the allowlist can point outside,
 *   4. enforcing a filename denylist for well-known secret filenames
 *      (`.ssh`, `.aws`, `.pem`, …) as belt-and-braces defence.
 *
 * The allowlist is bootstrapped once at process start. Two env vars extend it:
 *
 *   - `DOWNLOAD_DIR`            — overrides the default download root.
 *   - `MCP_EMAIL_UPLOAD_DIRS`   — colon-separated list of roots from which
 *                                 `encode_file_for_attachment` and
 *                                 `send_email_with_file` may read.
 *
 * If `MCP_EMAIL_UPLOAD_DIRS` is unset, uploads default to the download root.
 * This is intentionally restrictive — the operator opts in to exposing more.
 */

export class PathSecurityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'OUTSIDE_ALLOWLIST'
      | 'SYMLINK_DENIED'
      | 'SECRET_FILENAME'
      | 'NOT_FOUND'
      | 'INVALID_INPUT'
  ) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export type PathIntent = 'read' | 'write';

const SECRET_FILENAME_PATTERNS: RegExp[] = [
  /^\.?ssh$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?aws$/i,
  /^\.?gnupg$/i,
  /^\.?kube$/i,
  /^\.?docker$/i,
  /^\.?netrc$/i,
  /^\.?pgpass$/i,
  /^credentials?(\.json|\.yaml|\.yml)?$/i,
  /^secrets?(\.json|\.yaml|\.yml)?$/i,
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'mcp-email-attachments');

function canonical(p: string): string {
  return path.resolve(p);
}

/**
 * Fully canonicalise by following every symlink in the path. Used after the
 * lexical allowlist check so we can catch the case where an ancestor directory
 * is a symlink pointing outside the allowlist — `path.resolve` alone does not
 * expand symlinks, so `uploadRoot/subdir/file` can smuggle `subdir -> ~/.ssh`
 * past a naive prefix check.
 *
 * Missing tail segments are tolerated (needed for write intent): we walk up
 * until a parent exists, realpath it, and reconstruct the canonical form.
 */
function canonicalReal(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Path (or some ancestor) does not exist yet. Realpath the deepest
    // existing ancestor and glue the remaining segments back on.
    let current = resolved;
    const tail: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...tail.reverse(), path.basename(current));
      } catch {
        tail.push(path.basename(current));
        current = parent;
      }
    }
  }
}

/**
 * Return a path is-inside check that refuses to match prefixes that merely
 * share a character (`/foo/bar` vs `/foo/bar-baz`).
 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function containsSecretSegment(fullPath: string): boolean {
  const segments = fullPath.split(path.sep).filter(Boolean);
  for (const seg of segments) {
    for (const pattern of SECRET_FILENAME_PATTERNS) {
      if (pattern.test(seg)) return true;
    }
  }
  return false;
}

export interface PathGuardConfig {
  downloadRoot: string;
  uploadRoots: readonly string[];
}

export function loadPathGuardConfig(env: NodeJS.ProcessEnv = process.env): PathGuardConfig {
  // Canonicalise through symlinks so roots and candidate paths are in the
  // same form. Without this, macOS (/var -> /private/var) and any operator
  // who sets a root under a symlinked path would never match.
  const downloadRoot = canonicalReal(env.DOWNLOAD_DIR?.trim() || DEFAULT_DOWNLOAD_DIR);

  const uploadList = (env.MCP_EMAIL_UPLOAD_DIRS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(canonicalReal);

  // Default: reading from the download root is always allowed (attachments
  // flow: download → encode → send). Operators who want to attach files from
  // a dedicated Documents/mcp-email-uploads folder opt in explicitly.
  const uploadRoots = uploadList.length > 0 ? uploadList : [downloadRoot];

  return { downloadRoot, uploadRoots };
}

export class PathGuard {
  private readonly config: PathGuardConfig;

  constructor(config: PathGuardConfig) {
    // Normalise every root through realpath so downstream comparisons line up
    // even when a caller hands us a path that contains a symlinked ancestor
    // (common on macOS where /var -> /private/var, or on Linux hosts that
    // expose /home/u -> /mnt/.../u).
    this.config = {
      downloadRoot: canonicalReal(config.downloadRoot),
      uploadRoots: config.uploadRoots.map(canonicalReal),
    };
  }

  /**
   * Resolve and validate a path. Throws PathSecurityError on any violation.
   *
   * @param requestedPath — raw string from the tool caller.
   * @param intent — "read" uses uploadRoots; "write" uses downloadRoot.
   * @returns canonical absolute path safe to hand to fs.
   */
  resolveSafe(requestedPath: string, intent: PathIntent): string {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      throw new PathSecurityError('path is required', 'INVALID_INPUT');
    }
    if (requestedPath.includes('\0')) {
      throw new PathSecurityError('path contains NUL byte', 'INVALID_INPUT');
    }

    const resolved = canonical(requestedPath);

    // Refuse anything that walks through a suspicious segment, even if the
    // allowlist would otherwise accept it. This is belt-and-braces against
    // an operator configuring the download dir at $HOME by mistake.
    if (containsSecretSegment(resolved)) {
      throw new PathSecurityError(
        `path ${resolved} contains a segment matching the secret-file denylist`,
        'SECRET_FILENAME'
      );
    }

    // For reads, surface terminal-symlink rejection with a precise error
    // before falling through to the allowlist check. This is diagnostic —
    // the allowlist would also catch it (via realpath), but "is a symlink"
    // is more actionable for the operator than "outside allowlist".
    if (intent === 'read') {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(resolved);
      } catch {
        throw new PathSecurityError(`path ${resolved} does not exist`, 'NOT_FOUND');
      }
      if (stat.isSymbolicLink()) {
        throw new PathSecurityError(`path ${resolved} is a symlink`, 'SYMLINK_DENIED');
      }
      if (!stat.isFile()) {
        throw new PathSecurityError(`path ${resolved} is not a regular file`, 'INVALID_INPUT');
      }
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        const parentStat = fs.lstatSync(parent);
        if (parentStat.isSymbolicLink()) {
          throw new PathSecurityError(
            `write parent ${parent} is a symlink`,
            'SYMLINK_DENIED'
          );
        }
      }
    }

    // Fully canonicalise by following every symlink. Without this, an
    // ancestor directory that is a symlink could smuggle a candidate past
    // the allowlist check (uploadRoot/subdir/file where subdir -> ~/.ssh).
    const real = canonicalReal(resolved);
    if (containsSecretSegment(real)) {
      throw new PathSecurityError(
        `path ${real} (after symlink resolution) contains a denylisted segment`,
        'SECRET_FILENAME'
      );
    }

    const allowedRoots = intent === 'write'
      ? [this.config.downloadRoot]
      : this.config.uploadRoots;

    // Roots are already canonicalised (constructor realpaths them). Compare
    // the candidate's real path against them.
    const insideAllowed = allowedRoots.some(
      (root) => real === root || isInside(real, root)
    );
    if (!insideAllowed) {
      throw new PathSecurityError(
        `path ${resolved} is outside the allowlist for ${intent}. Allowed roots: ${allowedRoots.join(', ')}`,
        'OUTSIDE_ALLOWLIST'
      );
    }

    return resolved;
  }

  /**
   * Resolve a user-supplied targetDirectory for a write operation. Returns
   * the canonical path if inside downloadRoot, or the downloadRoot itself if
   * targetDirectory is undefined. Throws otherwise.
   */
  resolveTargetDirectory(targetDirectory: string | undefined): string {
    if (targetDirectory == null || targetDirectory === '') {
      return this.config.downloadRoot;
    }
    const resolved = canonicalReal(targetDirectory);
    if (containsSecretSegment(resolved)) {
      throw new PathSecurityError(
        `targetDirectory ${resolved} contains a denylisted segment`,
        'SECRET_FILENAME'
      );
    }
    if (
      resolved !== this.config.downloadRoot &&
      !isInside(resolved, this.config.downloadRoot)
    ) {
      throw new PathSecurityError(
        `targetDirectory ${resolved} is outside downloadRoot ${this.config.downloadRoot}`,
        'OUTSIDE_ALLOWLIST'
      );
    }
    return resolved;
  }

  getDownloadRoot(): string {
    return this.config.downloadRoot;
  }

  getUploadRoots(): readonly string[] {
    return this.config.uploadRoots;
  }
}

/**
 * Build a PathGuard from the current process env. Used by index.ts at startup.
 */
export function createPathGuard(env: NodeJS.ProcessEnv = process.env): PathGuard {
  return new PathGuard(loadPathGuardConfig(env));
}
