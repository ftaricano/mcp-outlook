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
import { PerformanceMonitor } from './monitoring/performanceMonitor.js';
import { AdvancedLogger } from './logging/advancedLogger.js';
import { IntegratedMonitoring } from './monitoring/integratedMonitoring.js';
import { LockManager } from './utils/lockManager.js';

class EmailMCPServer {
  private server: Server;
  private authProvider: GraphAuthProvider;
  private emailService: EmailService;
  private emailSummarizer: EmailSummarizer;
  private handlerRegistry: HandlerRegistry;
  public performanceMonitor: PerformanceMonitor;
  public logger: AdvancedLogger;
  public integratedMonitoring: IntegratedMonitoring;
  private lockManager: LockManager;
  private env: AppEnv;

  constructor(env: AppEnv) {
    this.env = env;
    this.lockManager = new LockManager();
    try {
      this.lockManager.acquire();
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      process.exit(1);
    }

    this.server = new Server(
      {
        name: this.env.MCP_SERVER_NAME,
        version: this.env.MCP_SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.authProvider = new GraphAuthProvider(this.env);
    this.emailService = new EmailService(this.authProvider);
    this.emailSummarizer = new EmailSummarizer();

    this.logger = new AdvancedLogger({
      enableFileLogging: false,
      enableConsoleLogging: false,
      logLevel: this.env.LOG_LEVEL,
      logDirectory: './logs',
      enablePerformanceLogging: false,
      enableAuditTrail: false,
    });

    this.performanceMonitor = new PerformanceMonitor({
      responseTimeThreshold: 3000,
      errorRateThreshold: 5,
      memoryThreshold: 80,
      throughputMinThreshold: 10,
    });

    const securityManager = new SecurityManager();
    const mcpBestPractices = new MCPBestPractices(securityManager);

    this.integratedMonitoring = new IntegratedMonitoring(
      this.performanceMonitor,
      this.logger,
      securityManager,
      {
        enablePerformanceMonitoring: true,
        enableAdvancedLogging: true,
        enableSecurityMonitoring: true,
        enableRealTimeAlerts: true,
        monitoringInterval: 60_000,
      }
    );

    this.handlerRegistry = new HandlerRegistry(
      this.emailService,
      this.emailSummarizer,
      securityManager,
      mcpBestPractices
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    // Register tools using the HandlerRegistry
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: HandlerRegistry.getToolSchemas()
      };
    });

    // Route all tool requests to the HandlerRegistry with performance monitoring
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const operationId = this.performanceMonitor.startOperation(`tool_${name}`, { args });
      
      try {
        this.logger.info(`Executing tool: ${name}`, {
          operation: `tool_${name}`,
          context: { toolName: name, args }
        });

        const result = await this.handlerRegistry.handleTool(name, args);
        
        this.performanceMonitor.endOperation(operationId, true);
        this.logger.info(`Tool ${name} completed successfully`, {
          operation: `tool_${name}`,
          context: { success: true, contentLength: result.content.length }
        });

        return {
          content: result.content,
          isError: result.isError
        };
      } catch (error) {
        this.performanceMonitor.endOperation(operationId, false, error instanceof Error ? error.message : 'Unknown error');
        this.logger.error(`Tool ${name} execution failed`, error instanceof Error ? error : undefined, {
          operation: `tool_${name}`,
          context: { toolName: name, args }
        });

        return {
          content: [
            {
              type: 'text',
              text: `❌ Erro ao executar ${name}: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async run() {
    try {
      // Start integrated monitoring
      this.integratedMonitoring.startMonitoring();
      this.logger.info('Starting MCP Email Server v2.0', {
        operation: 'server_startup'
      });

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      // Validate Microsoft Graph connection on startup
      const authValidationId = this.performanceMonitor.startOperation('auth_validation');
      try {
        await this.authProvider.validateConnection();
        this.performanceMonitor.endOperation(authValidationId, true);
        this.logger.info('Microsoft Graph connection validated successfully', {
          operation: 'auth_validation'
        });
      } catch (authError) {
        this.performanceMonitor.endOperation(authValidationId, false, authError instanceof Error ? authError.message : 'Auth failed');
        this.logger.error('Microsoft Graph connection validation failed', authError instanceof Error ? authError : undefined, {
          operation: 'auth_validation'
        });
        throw authError;
      }
      
      this.logger.info('🚀 MCP Email Server v2.0 successfully started', {
        operation: 'server_startup',
        context: {
          version: '2.0.0',
          features: [
            'Modular Architecture',
            'Consolidated AttachmentValidator',
            'Handler Registry',
            'Advanced Performance Monitoring',
            'Comprehensive Logging',
            'Integrated Security',
            'Real-time Health Monitoring'
          ]
        }
      });

      console.error('🚀 MCP Email Server v2.0 - Enterprise Architecture Running on stdio');
      console.error('📧 Enhanced with Performance Monitoring, Advanced Logging & Security');
      console.error('🛡️ Real-time Health Monitoring and Comprehensive Analytics Active');
    } catch (error) {
      this.logger.critical('Failed to start MCP Email Server', error instanceof Error ? error : undefined, {
        operation: 'server_startup_error'
      });
      console.error('Erro ao iniciar servidor:', error);
      throw error;
    }
  }
}

function bootstrap(): EmailMCPServer {
  let env: AppEnv;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n[mcp-email] ${error.message}\n`);
    } else {
      console.error('[mcp-email] Failed to load environment:', error);
    }
    process.exit(1);
  }
  return new EmailMCPServer(env);
}

// Run if this is the main file
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = bootstrap();
  
  // Graceful shutdown handling
  const gracefulShutdown = async (signal: string) => {
    console.error(`\n📊 Received ${signal}. Initiating graceful shutdown...`);
    try {
      // Stop monitoring and cleanup
      if (server.integratedMonitoring) {
        await server.integratedMonitoring.destroy();
      }
        await server.logger.destroy();

      if (server.performanceMonitor) {
        server.performanceMonitor.destroy();
      }
      
      // Release lock
      // @ts-ignore - access private property for shutdown
      server.lockManager.release();
      
      console.error('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Register shutdown handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });

  server.run().catch((error) => {
    console.error('Erro fatal ao iniciar servidor:', error);
    process.exit(1);
  });
}
