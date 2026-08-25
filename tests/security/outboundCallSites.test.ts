import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard for invariant 14: outbound mail goes through `senderPolicy`.
 *
 * The gate itself is two lines of convention in `emailService`. Without this
 * test, a later `forward_email` or `send_draft` would compile, lint, and pass
 * every other suite while sending from any mailbox in the tenant — the exact
 * way this class of gate historically rots. Modelled on the
 * `EXPECTED_TOOL_COUNT` check in `scripts/smoke-test.js`: pin the surface, so
 * growing it is a deliberate edit rather than an accident.
 */

const SRC_ROOT = new URL('../../src', import.meta.url).pathname;

// Graph routes that put a message on the wire. `/send` covers the
// `messages/{id}/send` endpoint that would let a created draft be dispatched —
// today no such call exists, which is why `create_draft` can safely sit outside
// the gate. If that ever changes, the draft path needs the gate too.
// The reply path builds its route from a variable (`replyAll ? 'replyAll' :
// 'reply'`), so the literal `/reply` never appears in the source — matching on
// the path shape alone would leave half the gated surface unguarded. Match the
// quoted action words too.
const OUTBOUND_ROUTE =
  /sendMail|['"`]reply(All)?['"`]|\/forward\b|['"`]forward['"`]|createReply|createForward|\/send\b/;

// Every outbound route literal must live in this file, behind the gate.
const GATED_FILE = 'services/emailService.ts';

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listTypeScriptFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Comments name these routes when explaining the gate; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('outbound call sites', () => {
  const files = listTypeScriptFiles(SRC_ROOT);

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('keeps every Graph outbound route inside the gated file', () => {
    const offenders = files
      .filter((file) => OUTBOUND_ROUTE.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC_ROOT, file))
      .filter((file) => file !== GATED_FILE);

    expect(offenders).toEqual([]);
  });

  it('pins the number of outbound routes so a new one cannot slip in unnoticed', () => {
    const source = stripComments(readFileSync(join(SRC_ROOT, GATED_FILE), 'utf8'));
    const matches = source.match(new RegExp(OUTBOUND_ROUTE, 'g')) ?? [];

    // Two paths, each naming its route twice (the `me` branch and the
    // `/users/{mailbox}` branch): sendMail x2, reply/replyAll x2.
    // Changing this number means adding an outbound path — route it through
    // `senderPolicy` before updating the count.
    expect(matches).toHaveLength(4);
  });

  it('has no outbound route anywhere in the read-only plugin', () => {
    const pluginFiles = files.filter((file) => relative(SRC_ROOT, file).startsWith('plugin/'));

    expect(pluginFiles.length).toBeGreaterThan(5);
    for (const file of pluginFiles) {
      expect(OUTBOUND_ROUTE.test(stripComments(readFileSync(file, 'utf8')))).toBe(false);
    }
  });
});
