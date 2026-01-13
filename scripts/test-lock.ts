import { LockManager } from '../src/utils/lockManager';
import { fork } from 'child_process';
import path from 'path';

// Helper to run this script in two modes: 'parent' or 'child'
const mode = process.argv[2] || 'parent';

if (mode === 'parent') {
  console.log('[Parent] Starting lock test...');
  const lock = new LockManager('test.lock');
  
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
    if (code === 1) {
      console.log('[Parent] Child exited with 1 (Expected behavior). Test PASSED.');
      lock.release();
      process.exit(0);
    } else {
      console.error(`[Parent] Child exited with ${code} (Unexpected). Test FAILED.`);
      lock.release();
      process.exit(1);
    }
  });

} else {
  // Child mode
  console.log('[Child] Attempting to acquire lock...');
  const lock = new LockManager('test.lock');
  
  try {
    lock.acquire();
    console.log('[Child] Acquired lock (Unexpected!).');
    process.exit(0);
  } catch (err: any) {
    console.log('[Child] Failed to acquire lock (Expected).');
    process.exit(1);
  }
}
