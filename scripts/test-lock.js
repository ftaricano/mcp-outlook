import { LockManager } from '../dist/utils/lockManager.js';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// Helper to run this script in two modes: 'parent' or 'child'
const mode = process.argv[2] || 'parent';

if (mode === 'parent') {
  console.log('[Parent] Starting lock test...');
  // Ensure we use a unique lock file for testing
  const lock = new LockManager('test-concurrency.lock');
  
  try {
    lock.acquire();
    console.log('[Parent] Acquired lock.');
  } catch (err) {
    console.error('[Parent] Failed to acquire lock:', err);
    process.exit(1);
  }

  // Spawn child to try to acquire same lock
  console.log('[Parent] Spawning child...');
  const child = fork(__filename, ['child']);

  child.on('exit', (code) => {
    // Expected: child exits with 0 (which means it handled the "failure" as expected success in our logic below)
    // Actually, let's make child exit with 0 if it *checked* correctly and found it locked.
    
    if (code === 0) {
      console.log('[Parent] Child exited with 0 (Test PASSED).');
      lock.release();
      process.exit(0);
    } else {
      console.error(`[Parent] Child exited with ${code} (Test FAILED).`);
      lock.release();
      process.exit(1);
    }
  });

} else {
  // Child mode
  console.log('[Child] Attempting to acquire lock...');
  const lock = new LockManager('test-concurrency.lock');
  
  try {
    lock.acquire();
    console.log('[Child] Acquired lock (Unexpected!).');
    process.exit(1); // Fail if we acquired it
  } catch (err) {
    console.log('[Child] Failed to acquire lock (Expected behavior).');
    process.exit(0); // Success if we failed to acquire
  }
}
