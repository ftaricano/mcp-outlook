#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootstrapKeychain } from '../config/keychain.js';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { createOutlookPluginServer } from './createPluginServer.js';
import { installPluginConsoleGuard } from './logging.js';
import { createOutlookPluginRuntime } from './runtime.js';
import { redactSecrets } from '../utils/redactSecrets.js';

installPluginConsoleGuard();
bootstrapKeychain();

async function main(): Promise<void> {
  const env = loadEnv();
  const runtime = createOutlookPluginRuntime(env);
  const server = createOutlookPluginServer(runtime.service, runtime.config, env.MCP_SERVER_VERSION);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const isValidationError = error instanceof EnvValidationError;
  const message = isValidationError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Unknown plugin startup error';
  process.stderr.write(
    `[mcp-outlook-plugin] ${isValidationError ? message : redactSecrets(message)}\n`
  );
  process.exit(1);
});
