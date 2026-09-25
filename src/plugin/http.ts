#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { bootstrapKeychain } from '../config/keychain.js';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { resolveBooleanEnv, type PluginConfig } from './config.js';
import { createOutlookPluginServer } from './createPluginServer.js';
import { installPluginConsoleGuard } from './logging.js';
import { redactSecrets } from '../utils/redactSecrets.js';
import type { MultiMailboxService } from './MultiMailboxService.js';
import { createOutlookPluginRuntime } from './runtime.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_JSON_BODY = '1mb';

export interface OutlookHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly bearerToken?: string;
  /**
   * Serve `/mcp` without a bearer token. Off by default: without a token, any
   * local process that can reach the loopback port can read the allowed
   * mailboxes. The entrypoint sets it only from `OUTLOOK_HTTP_ALLOW_NO_AUTH=true`.
   */
  readonly allowUnauthenticated?: boolean;
  readonly version?: string;
}

export interface OutlookHttpDependencies {
  readonly service: MultiMailboxService;
  readonly config: PluginConfig;
}

/**
 * A startup refusal whose message is fixed text naming configuration variables,
 * never a value. The entrypoint prints it without redaction, which would
 * otherwise mangle the variable names the operator needs to see.
 */
export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpConfigError';
  }
}

function createHttpReadOnlyConfig(config: PluginConfig): PluginConfig {
  return Object.freeze({
    ...config,
    allowLocalHandoffs: false,
    allowWrites: false,
    allowSend: false,
    sendFromAlias: undefined,
  });
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function configuredBearerToken(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerAuthorized(header: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true;
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(tokenDigest(header.slice(7)), tokenDigest(expectedToken));
}

function bearerMiddleware(expectedToken: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!bearerAuthorized(req.header('authorization'), expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

function jsonParserErrorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const parserError = error as { type?: string; status?: number };
  if (parserError.type === 'entity.too.large' || parserError.status === 413) {
    res.status(413).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large' },
      id: null,
    });
    return;
  }

  if (error instanceof SyntaxError || parserError.status === 400) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    return;
  }

  res.status(500).json({
    jsonrpc: '2.0',
    error: { code: -32603, message: 'Internal server error' },
    id: null,
  });
}

export function createOutlookHttpApp(
  dependencies: OutlookHttpDependencies,
  options: OutlookHttpOptions = {}
): Express {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error(
      'The built-in Outlook MCP HTTP server is loopback-only; use a reviewed OAuth proxy for remote access'
    );
  }

  const bearerToken = configuredBearerToken(options.bearerToken);
  if (!bearerToken && options.allowUnauthenticated !== true) {
    throw new HttpConfigError(
      'The Outlook MCP HTTP server requires a bearer token: set OUTLOOK_HTTP_BEARER_TOKEN, or set OUTLOOK_HTTP_ALLOW_NO_AUTH=true to serve without authentication'
    );
  }

  const httpConfig = createHttpReadOnlyConfig(dependencies.config);
  const app = express();
  app.disable('x-powered-by');
  app.use(localhostHostValidation());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'mcp-outlook-plugin',
      version: options.version ?? '2.3.0',
    });
  });

  app.post(
    '/mcp',
    bearerMiddleware(bearerToken),
    express.json({ limit: MAX_JSON_BODY }),
    async (req, res) => {
      const server = createOutlookPluginServer(dependencies.service, httpConfig, options.version);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      } finally {
        await transport.close();
        await server.close();
      }
    }
  );

  app.get('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
  });
  app.delete('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
  });

  app.use(jsonParserErrorMiddleware);

  return app;
}

export function startOutlookHttpServer(
  dependencies: OutlookHttpDependencies,
  options: OutlookHttpOptions = {}
): Promise<HttpServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3010;
  const app = createOutlookHttpApp(dependencies, options);

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve(httpServer));
    httpServer.once('error', reject);
  });
}

export function isExecutedAsMain(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && moduleUrl === pathToFileURL(argvPath).href;
}

async function main(): Promise<void> {
  installPluginConsoleGuard();
  bootstrapKeychain([
    'MICROSOFT_GRAPH_CLIENT_ID',
    'MICROSOFT_GRAPH_CLIENT_SECRET',
    'MICROSOFT_GRAPH_TENANT_ID',
  ]);
  const env = loadEnv();
  const runtime = createOutlookPluginRuntime(env);
  const host = process.env.OUTLOOK_HTTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.OUTLOOK_HTTP_PORT ?? '3010');
  const bearerToken = configuredBearerToken(process.env.OUTLOOK_HTTP_BEARER_TOKEN);
  let allowUnauthenticated: boolean;
  try {
    allowUnauthenticated = resolveBooleanEnv(
      'OUTLOOK_HTTP_ALLOW_NO_AUTH',
      process.env.OUTLOOK_HTTP_ALLOW_NO_AUTH,
      false
    );
  } catch {
    throw new HttpConfigError('OUTLOOK_HTTP_ALLOW_NO_AUTH must be a boolean value');
  }

  await startOutlookHttpServer(
    { service: runtime.service, config: runtime.config },
    { host, port, bearerToken, allowUnauthenticated, version: env.MCP_SERVER_VERSION }
  );
  if (!bearerToken) {
    process.stderr.write(
      '[mcp-outlook-plugin] warning: OUTLOOK_HTTP_ALLOW_NO_AUTH=true, /mcp accepts requests without a bearer token\n'
    );
  }
  process.stderr.write(`[mcp-outlook-plugin] listening on http://${host}:${port}/mcp\n`);
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    const isValidationError =
      error instanceof EnvValidationError || error instanceof HttpConfigError;
    const message = isValidationError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Unknown HTTP startup error';
    process.stderr.write(
      `[mcp-outlook-plugin] ${isValidationError ? message : redactSecrets(message)}\n`
    );
    process.exit(1);
  });
}
