import { describe, expect, it } from 'vitest';
import { harvestEvents } from '../../scripts/lib/harvest.js';

function run(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventType: 'run',
    runId: crypto.randomUUID(),
    timestamp: '2026-07-23T12:00:00.000Z',
    command: 'advanced_search',
    durationMs: 10,
    exitStatus: 'success',
    argumentShape: {},
    ...overrides,
  };
}

describe('harvestEvents', () => {
  it('does not create proposals from a single occurrence', () => {
    const result = harvestEvents(
      [
        run({
          searchEvidence: {
            status: 'SEARCH_INCOMPLETE',
            strategy: 'local_scan',
            pagesScanned: 10,
            candidatesScanned: 500,
            truncated: true,
          },
        }),
      ],
      { skillTarget: 'outlook-mcp', minimumOccurrences: 2 }
    );

    expect(result.proposals).toEqual([]);
  });

  it('enforces a recurrence floor of two even when the caller requests one', () => {
    const result = harvestEvents(
      [
        run({
          searchEvidence: {
            status: 'SEARCH_INCOMPLETE',
            strategy: 'local_scan',
            pagesScanned: 1,
            candidatesScanned: 10,
            truncated: true,
          },
        }),
      ],
      { skillTarget: 'outlook-mcp', minimumOccurrences: 1 }
    );

    expect(result.minimumOccurrences).toBe(2);
    expect(result.proposals).toEqual([]);
  });

  it('creates one deduplicated proposal from recurring incomplete searches', () => {
    const incomplete = {
      status: 'SEARCH_INCOMPLETE',
      strategy: 'local_scan',
      pagesScanned: 10,
      candidatesScanned: 500,
      truncated: true,
    };
    const result = harvestEvents(
      [run({ searchEvidence: incomplete }), run({ searchEvidence: incomplete })],
      { skillTarget: 'outlook-mcp', minimumOccurrences: 2 }
    );

    expect(result.signals).toEqual([
      expect.objectContaining({ key: 'search:SEARCH_INCOMPLETE', count: 2 }),
    ]);
    expect(result.proposals).toEqual([
      expect.objectContaining({
        type: 'patch_skill',
        target: 'outlook-mcp',
      }),
    ]);
  });

  it('creates a proposal from recurring negative feedback without exposing notes', () => {
    const result = harvestEvents(
      [
        run({ runId: 'a' }),
        {
          version: 1,
          eventType: 'feedback',
          runId: 'a',
          timestamp: '2026-07-23T12:05:00.000Z',
          outcome: 'missed',
        },
        run({ runId: 'b' }),
        {
          version: 1,
          eventType: 'feedback',
          runId: 'b',
          timestamp: '2026-07-23T12:06:00.000Z',
          outcome: 'missed',
        },
      ],
      { skillTarget: 'outlook-mcp', minimumOccurrences: 2 }
    );

    expect(result.signals).toContainEqual(
      expect.objectContaining({ key: 'feedback:missed', count: 2 })
    );
    expect(JSON.stringify(result)).not.toContain('note');
  });
});
