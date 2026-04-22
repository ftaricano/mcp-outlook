import { describe, it, expect, vi } from 'vitest';
import { HandlerRegistry } from '../../src/handlers/HandlerRegistry.js';

/**
 * Build a minimal mock set that is enough for HandlerRegistry construction +
 * dispatch of simple tools. The handlers themselves only call emailService /
 * securityManager / mcpBestPractices; we stub the bits they touch.
 */
function makeMocks() {
  const securityManager: any = {
    sanitizeInput: (args: any) => args,
    validatePermissions: () => ({ allowed: true }),
    createAuditEntry: vi.fn()
  };

  const mcpBestPractices: any = {
    validateToolInput: () => ({
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: []
    })
  };

  const emailSummarizer: any = {
    summarizeEmail: vi.fn(),
    summarizeEmailsBatch: vi.fn()
  };

  const emailService: any = {
    listEmails: vi.fn().mockResolvedValue([])
  };

  return { emailService, emailSummarizer, securityManager, mcpBestPractices };
}

describe('HandlerRegistry.handleTool', () => {
  it('dispatches list_emails to EmailHandler and returns its result', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(
      mocks.emailService,
      mocks.emailSummarizer,
      mocks.securityManager,
      mocks.mcpBestPractices
    );

    const result = await registry.handleTool('list_emails', { limit: 5 });
    expect(mocks.emailService.listEmails).toHaveBeenCalledTimes(1);
    expect(mocks.emailService.listEmails).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5, folder: 'inbox' })
    );
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });

  it('rejects invalid args (zod) before reaching the handler', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(
      mocks.emailService,
      mocks.emailSummarizer,
      mocks.securityManager,
      mocks.mcpBestPractices
    );

    await expect(
      registry.handleTool('list_emails', { limit: -1 })
    ).rejects.toThrow(/Invalid arguments/);
    expect(mocks.emailService.listEmails).not.toHaveBeenCalled();
  });

  it('rejects unknown tool names at the zod layer', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(
      mocks.emailService,
      mocks.emailSummarizer,
      mocks.securityManager,
      mocks.mcpBestPractices
    );

    await expect(registry.handleTool('does_not_exist', {})).rejects.toThrow(
      /Invalid arguments|Ferramenta desconhecida|Unknown tool/
    );
  });

  it('propagates the parsed/defaulted args into the handler', async () => {
    const mocks = makeMocks();
    const registry = new HandlerRegistry(
      mocks.emailService,
      mocks.emailSummarizer,
      mocks.securityManager,
      mocks.mcpBestPractices
    );

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
