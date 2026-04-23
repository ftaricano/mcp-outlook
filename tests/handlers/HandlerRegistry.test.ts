import { describe, it, expect, vi } from 'vitest';
import { HandlerRegistry } from '../../src/handlers/HandlerRegistry.js';

/**
 * Build a minimal mock set that is enough for HandlerRegistry construction +
 * dispatch of simple tools. The handlers themselves only call emailService
 * and emailSummarizer — we stub the bits they touch.
 */
function makeMocks() {
  const emailSummarizer: any = {
    summarizeEmail: vi.fn(),
    summarizeEmailsBatch: vi.fn(),
  };

  const emailService: any = {
    listEmails: vi.fn().mockResolvedValue([]),
  };

  return { emailService, emailSummarizer };
}

describe('HandlerRegistry.handleTool', () => {
  it('dispatches list_emails to EmailHandler and returns its result', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(mocks.emailService, mocks.emailSummarizer);

    const result = await registry.handleTool('list_emails', { limit: 5 });
    expect(mocks.emailService.listEmails).toHaveBeenCalledTimes(1);
    expect(mocks.emailService.listEmails).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5, folder: 'inbox' })
    );
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });

  it('returns a structured error (not throw) for invalid args', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(mocks.emailService, mocks.emailSummarizer);

    const result = await registry.handleTool('list_emails', { limit: -1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid arguments for list_emails/);
    expect(mocks.emailService.listEmails).not.toHaveBeenCalled();
  });

  it('returns a structured error for unknown tool names', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(mocks.emailService, mocks.emailSummarizer);

    const result = await registry.handleTool('does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool|Invalid arguments/);
  });

  it('propagates the parsed/defaulted args into the handler', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(mocks.emailService, mocks.emailSummarizer);

    await registry.handleTool('list_emails', {});
    // With empty input, defaults kick in inside EmailHandler (limit=10).
    expect(mocks.emailService.listEmails).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 10, folder: 'inbox' })
    );
  });
});

describe('HandlerRegistry.getToolSchemas (static)', () => {
  it('exposes the 40-entry schema list', () => {
    const schemas = HandlerRegistry.getToolSchemas();
    expect(schemas.length).toBe(40);
  });
});
