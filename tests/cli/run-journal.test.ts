import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFeedback,
  appendRun,
  argumentShape,
  normalizeErrorClass,
  readJournal,
} from '../../scripts/lib/run-journal.js';

const tempDirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outlook-journal-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('run journal', () => {
  it('records argument names and types without raw values', async () => {
    const stateDir = await tempStateDir();
    await appendRun(stateDir, {
      runId: 'run-1',
      sessionId: 'session-1',
      command: 'advanced_search',
      startedAt: '2026-07-23T12:00:00.000Z',
      durationMs: 42,
      exitStatus: 'success',
      argumentShape: argumentShape({
        query: 'Cliente Super Secreto',
        sender: 'private@example.com',
        hasAttachments: true,
        maxResults: 20,
      }),
      searchEvidence: {
        status: 'FOUND',
        strategy: 'local_scan',
        pagesScanned: 3,
        candidatesScanned: 120,
        truncated: false,
      },
    });

    const raw = await readFile(join(stateDir, 'runs.jsonl'), 'utf8');
    expect(raw).not.toContain('Cliente Super Secreto');
    expect(raw).not.toContain('private@example.com');
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({
        argumentShape: {
          query: 'string',
          sender: 'string',
          hasAttachments: 'boolean',
          maxResults: 'number',
        },
      })
    );
  });

  it('does not persist raw session text or unrecognized argument names', async () => {
    const stateDir = await tempStateDir();
    await appendRun(stateDir, {
      runId: 'run-private',
      sessionId: 'customer@example.com',
      command: 'private@example.com invoice 12345',
      startedAt: '2026-07-23T12:00:00.000Z',
      durationMs: 42,
      exitStatus: 'success',
      argumentShape: argumentShape({
        query: 'private value',
        'customer@example.com': true,
        'secret-client-name': 'value',
      }),
    });

    const raw = await readFile(join(stateDir, 'runs.jsonl'), 'utf8');
    expect(raw).not.toContain('customer@example.com');
    expect(raw).not.toContain('secret-client-name');
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({
        command: 'unknown_command',
        sessionId: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        argumentShape: {
          query: 'string',
          unknown_1: 'boolean',
          unknown_2: 'string',
        },
      })
    );
  });

  it('stores only a normalized error class', async () => {
    expect(normalizeErrorClass('429 Too Many Requests secret@example.com')).toBe('throttled');
    expect(normalizeErrorClass('Access to OData is disabled: [RAOP]')).toBe('access_policy');
    expect(normalizeErrorClass('some private raw failure')).toBe('unknown_error');
  });

  it('links feedback to an existing run and rejects unknown run IDs', async () => {
    const stateDir = await tempStateDir();
    await appendRun(stateDir, {
      runId: 'run-1',
      command: 'advanced_search',
      startedAt: '2026-07-23T12:00:00.000Z',
      durationMs: 10,
      exitStatus: 'success',
      argumentShape: {},
    });

    await appendFeedback(stateDir, 'run-1', 'missed');
    await expect(appendFeedback(stateDir, 'missing', 'failed')).rejects.toThrow(/unknown run/i);

    const events = await readJournal(stateDir);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(
      expect.objectContaining({
        eventType: 'feedback',
        runId: 'run-1',
        outcome: 'missed',
      })
    );
  });
});
