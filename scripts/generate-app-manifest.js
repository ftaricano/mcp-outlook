#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function fail(message) {
  process.stderr.write(`[generate-app-manifest] ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    connectionId: null,
    output: '.app.json',
    pluginManifest: '.codex-plugin/plugin.json',
    force: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--connection-id') {
      options.connectionId = argv[++index];
    } else if (arg === '--output') {
      options.output = argv[++index];
    } else if (arg === '--plugin-manifest') {
      options.pluginManifest = argv[++index];
    } else if (arg === '--force') {
      options.force = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!options.connectionId?.match(/^plugin_asdk_app_[A-Za-z0-9_-]+$/)) {
    fail('--connection-id must be a real plugin_asdk_app_* identifier');
  }
  if (!options.output) fail('--output requires a file path');
  if (!options.pluginManifest) fail('--plugin-manifest requires a file path');
  return options;
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

const options = parseArgs(process.argv);
const outputPath = resolve(options.output);
const pluginManifestPath = resolve(options.pluginManifest);
if (existsSync(outputPath) && !options.force) {
  fail(`${outputPath} already exists; pass --force to replace it`);
}

let pluginManifest;
try {
  pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
} catch {
  fail(`${pluginManifestPath} must be a readable JSON plugin manifest`);
}
if (!pluginManifest || typeof pluginManifest !== 'object' || Array.isArray(pluginManifest)) {
  fail(`${pluginManifestPath} must contain a JSON object`);
}

const manifest = {
  apps: {
    outlook_multi_mailbox: {
      id: options.connectionId.replace(/^plugin_/, ''),
      required: true,
    },
  },
};
writeJsonAtomically(outputPath, manifest);
writeJsonAtomically(pluginManifestPath, {
  ...pluginManifest,
  apps: './.app.json',
});
process.stdout.write(`${outputPath}\n`);
