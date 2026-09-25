import { describe, expect, it } from 'vitest';
import { pluginStartupWarnings } from '../../src/plugin/startupWarnings.js';

describe('pluginStartupWarnings', () => {
  it('warns when sending is on without a recipient allowlist', () => {
    for (const domains of [undefined, '', '   ']) {
      const warnings = pluginStartupWarnings(
        { allowSend: true },
        { OUTLOOK_ALLOWED_RECIPIENT_DOMAINS: domains }
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/OUTLOOK_ALLOWED_RECIPIENT_DOMAINS/);
    }
  });

  it('stays quiet when a recipient allowlist is set', () => {
    expect(
      pluginStartupWarnings(
        { allowSend: true },
        { OUTLOOK_ALLOWED_RECIPIENT_DOMAINS: 'example.com' }
      )
    ).toEqual([]);
  });

  it('stays quiet when sending is off', () => {
    expect(pluginStartupWarnings({ allowSend: false }, {})).toEqual([]);
  });
});
