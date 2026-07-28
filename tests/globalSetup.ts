// Vitest globalSetup — runs once, before any test file, in its own process.
//
// src/plugin/extractors.ts delegates all attachment parsing to a worker_thread
// (src/plugin/extractionWorker.ts). worker_threads loads its entry point through
// plain Node ESM resolution, which never goes through vitest's TS transform, so
// any test exercising extractAttachmentText (directly or via MultiMailboxService)
// needs the compiled dist/plugin/extractionWorker.js to already exist. Building
// here — once, before test files start running in parallel — avoids both a
// stale/missing artifact and a race between test files that would otherwise each
// need their own build guard (see JAR-782 fix notes).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const compiledWorkerPath = fileURLToPath(
  new URL('../dist/plugin/extractionWorker.js', import.meta.url)
);

export default function setup(): void {
  if (!existsSync(compiledWorkerPath)) {
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
  }
}
