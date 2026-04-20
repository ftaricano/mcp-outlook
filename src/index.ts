#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AppEnv, EnvValidationError, loadEnv } from './config/env.js';
import { GraphAuthProvider } from './auth/graphAuth.js';
import { EmailService } from './services/emailService.js';
import { EmailSummarizer } from './services/emailSummarizer.js';
import { SecurityManager } from './security/securityManager.js';
import { MCPBestPractices } from './utils/mcpBestPractices.js';
import { HandlerRegistry } from './handlers/HandlerRegistry.js';
import { Logger } from './logging/logger.js';
import { LockManager } from './utils/lockManager.js';

class EmailMCPServer {
  private readonly server: Server;
  private readonly authProvider: GraphAuthProvider;
  private readonly emailService: EmailService;
  private readonly emailSummarizer: EmailSummarizer;
  private readonly handlerRegistry: HandlerRegistry;
  private readonly lockManager: LockManager;
  private readonly env: AppEnv;
  public readonly logger: Logger;

  constructor(env: AppEnv) {
    this.env = env;
    this.logger = new Logger({ level: env.LOG_LEVEL, name: env.MCP_SERVER_NAME });

    this.lockManager = new LockManager();
    try {
      this.lockManager.acquire();
    } catch (error) {
      this.logger.error('Failed to acquire lock', error);
      process.exit(1);
    }

    this.server = new Server(
      { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    this.authProvider = new GraphAuthProvider(env);
    this.emailService = new EmailService(this.authProvider);
    this.emailSummarizer = new EmailSummarizer();

    const securityManager = new SecurityManager();
    const mcpBestPractices = new MCPBestPractices(securityManager);

    this.handlerRegistry = new HandlerRegistry(
      this.emailService,
      this.emailSummarizer,
      securityManager,
      mcpBestPractices
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: HandlerRegistry.getToolSchemas(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startedAt = Date.now();

      try {
        this.logger.debug('tool start', { operation: 'call_tool', toolName: name });
        const result = await this.handlerRegistry.handleTool(name, args);
        this.logger.debug('tool ok', {
          operation: 'call_tool',
          toolName: name,
          durationMs: Date.now() - startedAt,
        });
        return { content: result.content, isError: result.isError };
      } catch (error) {
        this.logger.error('tool failed', error, {
          operation: 'call_tool',
          toolName: name,
          durationMs: Date.now() - startedAt,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Erro ao executar ${name}: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    this.logger.info('starting server', {
      operation: 'server_startup',
      context: { version: this.env.MCP_SERVER_VERSION, nodeEnv: this.env.NODE_ENV },
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Validate Graph auth early — a fail here means credentials are wrong
    // and no tool call will ever succeed. We log but do NOT exit: the MCP
    // protocol channel is already open and callers need a clean error.
    try {
      const ok = await this.authProvider.validateConnection();
      if (ok) {
        this.logger.info('graph auth ok', { operation: 'auth_validation' });
      } else {
        this.logger.warn('graph auth failed — tool calls will error until fixed', {
          operation: 'auth_validation',
        });
      }
    } catch (error) {
      this.logger.error('graph auth validation threw', error, {
        operation: 'auth_validation',
      });
    }

    this.logger.info('server ready', { operation: 'server_startup' });
  }

  async shutdown(signal: string): Promise<void> {
    this.logger.info('shutting down', { operation: 'shutdown', context: { signal } });
    try {
      this.lockManager.release();
    } catch (error) {
      this.logger.error('lock release failed', error, { operation: 'shutdown' });
    }
  }
}

function bootstrap(): EmailMCPServer {
  let env: AppEnv;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n[mcp-email] ${error.message}\n\n`);
    } else {
      process.stderr.write(
        `[mcp-email] Failed to load environment: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    process.exit(1);
  }
  return new EmailMCPServer(env);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = bootstrap();

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.shutdown(signal);
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `[mcp-email] shutdown error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    server.logger.error('uncaught exception', error);
    void gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    server.logger.error('unhandled rejection', reason);
    void gracefulShutdown('unhandledRejection');
  });

  server.run().catch((error) => {
    server.logger.error('fatal startup error', error);
    process.exit(1);
  });
}
