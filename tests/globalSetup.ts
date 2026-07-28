// Vitest globalSetup — runs once, before any test file, in its own process.
//
// src/plugin/extractors.ts delegates all attachment parsing to a worker_thread
// (src/plugin/extractionWorker.ts). worker_threads loads its entry point through
// plain Node ESM resolution, which never goes through vitest's TS transform, so
// any test exercising extractAttachmentText (directly or via MultiMailboxService)
// needs a compiled dist/plugin/extractionWorker.js. Building here — once, before
// test files start running in parallel — also avoids a race between test files
// that would otherwise each need their own build guard.
//
// The artifact must be rebuilt when it is *stale*, not only when it is missing.
// Checking existence alone let a checkout with edited sources run its tests
// against a previously compiled worker: the suite passed while exercising code
// that no longer existed. That is a false green, so compare mtimes and rebuild
// whenever any source is newer than the artifact.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(repoRoot, 'src');
const compiledWorkerPath = join(repoRoot, 'dist', 'plugin', 'extractionWorker.js');

function newestSourceMtimeMs(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestSourceMtimeMs(path) : statSync(path).mtimeMs
    );
  }
  return newest;
}

export default function setup(): void {
  const compiledMtimeMs = existsSync(compiledWorkerPath) ? statSync(compiledWorkerPath).mtimeMs : 0;
  if (compiledMtimeMs < newestSourceMtimeMs(sourceRoot)) {
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
  }
}
