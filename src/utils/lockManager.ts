import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export class LockManager {
  private lockFilePath: string;
  private hasLock: boolean = false;

  constructor(lockFileName: string = "mcp-server.lock") {
    // Save lockfile in the project directory (where the compiled JS lives).
    // Using import.meta.url to get the correct directory regardless of how the server is started.
    // This fixes the issue where process.cwd() returns "/" when started by Antigravity/MCP host.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // Go up from dist/utils to the project root
    const projectRoot = path.resolve(__dirname, "..", "..");
    this.lockFilePath = path.resolve(projectRoot, lockFileName);
  }

  /**
   * Tries to acquire the lock.
   * Throws an error if the lock is held by another active process.
   */
  public acquire(): void {
    if (fs.existsSync(this.lockFilePath)) {
      try {
        const pid = parseInt(fs.readFileSync(this.lockFilePath, "utf-8"), 10);

        if (this.isProcessRunning(pid)) {
          throw new Error(
            `Server is already running with PID ${pid}. Lockfile: ${this.lockFilePath}`
          );
        } else {
          // Stale lock, process is dead
          console.error(`Found stale lock from PID ${pid}. Removing...`);
          fs.unlinkSync(this.lockFilePath);
        }
      } catch (error) {
        // If we can't read the file or pid is invalid, we assume it's corrupt and remove it
        if ((error as any).code !== "EEXIST") {
          // Don't catch our own error above
          // If the error was our "Server is already running" error, rethrow it
          if (
            error instanceof Error &&
            error.message.startsWith("Server is already running")
          ) {
            throw error;
          }
          console.error(
            `Error reading lockfile, assuming stale/corrupt: ${error}`
          );
          try {
            fs.unlinkSync(this.lockFilePath);
          } catch (unlinkError) {
            // Ignore if it's already gone
          }
        }
      }
    }

    try {
      fs.writeFileSync(this.lockFilePath, process.pid.toString(), "utf-8");
      this.hasLock = true;
      console.error(`🔐 Lock acquired. PID: ${process.pid}`);
    } catch (error) {
      throw new Error(
        `Failed to write lockfile at ${this.lockFilePath}: ${
          (error as Error).message
        }`
      );
    }
  }

  /**
   * Releases the lock if held.
   */
  public release(): void {
    if (this.hasLock && fs.existsSync(this.lockFilePath)) {
      try {
        // Double check we are deleting OUR lock (PID matches)
        const pid = parseInt(fs.readFileSync(this.lockFilePath, "utf-8"), 10);
        if (pid === process.pid) {
          fs.unlinkSync(this.lockFilePath);
          console.error("🔓 Lock released.");
        }
      } catch (error) {
        console.error(`Error releasing lock: ${(error as Error).message}`);
      }
      this.hasLock = false;
    }
  }

  /**
   * Checks if a process with the given PID is running.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // signal 0 tests for existence of the process
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e.code === "EPERM"; // If EPERM, process exists but we don't have permission (still running)
    }
  }
}
