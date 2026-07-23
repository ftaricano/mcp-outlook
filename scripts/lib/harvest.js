const NEGATIVE_FEEDBACK = new Set(['missed', 'wrong_match', 'failed']);
const ACTIONABLE_SEARCH_STATUSES = new Set([
  'SEARCH_INCOMPLETE',
  'SEARCH_FAILED',
  'SEARCH_UNTRUSTED',
]);

function proposalFor(signal, skillTarget) {
  const searchStatus = signal.key.startsWith('search:')
    ? signal.key.slice('search:'.length)
    : undefined;
  const summary = searchStatus
    ? `Document recurring ${searchStatus} outcomes observed by the Outlook CLI`
    : `Document recurring ${signal.key} feedback observed by the Outlook CLI`;

  return {
    type: 'patch_skill',
    target: skillTarget,
    summary,
    rationale: `${signal.count} sanitized run events showed the same signal; recurring evidence met the minimum threshold.`,
    proposed_change:
      `Add a troubleshooting/decision rule for signal ${signal.key}. ` +
      'Require agents to inspect structured search evidence and avoid treating it as a clean negative.',
  };
}

export function harvestEvents(
  events,
  { skillTarget = 'outlook-mcp', minimumOccurrences = 2 } = {}
) {
  minimumOccurrences = Math.max(2, Math.trunc(minimumOccurrences) || 2);
  const counts = new Map();

  for (const event of events) {
    let key;
    if (event.eventType === 'run' && ACTIONABLE_SEARCH_STATUSES.has(event.searchEvidence?.status)) {
      key = `search:${event.searchEvidence.status}`;
    } else if (event.eventType === 'run' && event.exitStatus === 'error' && event.errorClass) {
      key = `error:${event.errorClass}`;
    } else if (event.eventType === 'feedback' && NEGATIVE_FEEDBACK.has(event.outcome)) {
      key = `feedback:${event.outcome}`;
    }
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const signals = Array.from(counts.entries())
    .filter(([, count]) => count >= minimumOccurrences)
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    minimumOccurrences,
    signals,
    proposals: signals.map((signal) => proposalFor(signal, skillTarget)),
  };
}
