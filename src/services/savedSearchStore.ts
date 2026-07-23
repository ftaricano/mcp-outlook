import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SavedSearch {
  name: string;
  criteria: Record<string, unknown>;
  created: string;
  updated: string;
}

interface SavedSearchFile {
  version: 1;
  searches: Record<string, SavedSearch>;
}

const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const CRITERIA_FIELDS = new Set([
  'query',
  'sender',
  'subject',
  'dateFrom',
  'dateTo',
  'hasAttachments',
  'isRead',
  'folder',
]);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateCriteria(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !CRITERIA_FIELDS.has(key))) return false;
  return Object.entries(value).every(([key, fieldValue]) => {
    if (key === 'hasAttachments' || key === 'isRead') return typeof fieldValue === 'boolean';
    if (key === 'dateFrom' || key === 'dateTo') return isValidDate(fieldValue);
    return typeof fieldValue === 'string';
  });
}

function validateSearches(value: unknown): value is Record<string, SavedSearch> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, search]) => {
    if (RESERVED_NAMES.has(key) || !isRecord(search) || !validateCriteria(search.criteria)) {
      return false;
    }
    return (
      search.name === key &&
      key.length > 0 &&
      isValidDate(search.created) &&
      isValidDate(search.updated)
    );
  });
}

const delay = (milliseconds: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function defaultOutlookStateDir(): string {
  if (process.env.OUTLOOK_STATE_DIR) return process.env.OUTLOOK_STATE_DIR;
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateRoot, 'mcp-outlook');
}

export class SavedSearchStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(private readonly stateDir: string = defaultOutlookStateDir()) {
    this.filePath = join(stateDir, 'saved-searches.json');
    this.lockPath = join(stateDir, 'saved-searches.lock');
  }

  async save(name: string, criteria: Record<string, unknown>): Promise<SavedSearch> {
    this.assertValidName(name);
    if (!validateCriteria(criteria)) {
      throw new Error('Saved-search criteria do not match the supported schema');
    }
    return this.withWriteLock(async () => {
      const state = await this.readState();
      const now = new Date().toISOString();
      const saved: SavedSearch = {
        name,
        criteria,
        created: state.searches[name]?.created ?? now,
        updated: now,
      };
      state.searches[name] = saved;
      await this.writeState(state);
      return saved;
    });
  }

  async list(): Promise<SavedSearch[]> {
    const state = await this.readState();
    return Object.values(state.searches).sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SavedSearch | null> {
    const state = await this.readState();
    return state.searches[name] ?? null;
  }

  async delete(name: string): Promise<boolean> {
    this.assertValidName(name);
    return this.withWriteLock(async () => {
      const state = await this.readState();
      if (!state.searches[name]) return false;
      delete state.searches[name];
      await this.writeState(state);
      return true;
    });
  }

  private async readState(): Promise<SavedSearchFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, searches: Object.create(null) };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SavedSearchFile>;
      if (parsed.version !== 1 || !validateSearches(parsed.searches)) {
        throw new Error('unsupported state schema');
      }
      // Null-prototype so name lookups (get/delete/save) can't resolve inherited members
      // like "toString" or "constructor" as if they were saved searches.
      return { version: 1, searches: Object.assign(Object.create(null), parsed.searches) };
    } catch (error) {
      throw new Error(
        `Saved-search state is corrupt at ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async writeState(state: SavedSearchFile): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private assertValidName(name: string): void {
    if (!name) {
      throw new Error('Saved-search name must not be empty');
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Saved-search name is reserved: ${name}`);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let lockHandle;

    while (!lockHandle) {
      try {
        lockHandle = await open(this.lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await unlink(this.lockPath);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for saved-search state lock');
        }
        await delay(10);
      }
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close();
      await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
