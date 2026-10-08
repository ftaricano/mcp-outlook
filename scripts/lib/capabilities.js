import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => sha256(readFileSync(path));

// Paths and bytes both participate so renames cannot preserve the installation digest.
function treeHash(root) {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symlink in built tree');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        hash.update(`${relative(root, path)}\0${bytes.length}\0`).update(bytes);
      } else throw new Error('Unsupported built entry');
    }
  }
  visit(root);
  return hash.digest('hex');
}

export async function installationCapabilities(repoRoot, cli) {
  const root = realpathSync(repoRoot);
  const cliPath = realpathSync(cli);
  const serverEntry = realpathSync(resolve(root, 'dist/index.js'));
  const { getToolSchemas } = await import(
    pathToFileURL(resolve(root, 'dist/schemas/jsonSchemaFromZod.js')).href
  );
  const schema = getToolSchemas().find((tool) => tool.name === 'send_email')?.inputSchema;
  if (schema?.properties?.noRetry?.type !== 'boolean') throw new Error('Unsupported send schema');
  const packagePath = resolve(root, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const require = createRequire(packagePath);
  const sdkRoot = dirname(require.resolve('@microsoft/microsoft-graph-client/package.json'));
  const sdk = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'));
  const lockfile = resolve(root, 'package-lock.json');
  return {
    contractVersion: 1,
    packageVersion: pkg.version,
    installation: {
      root,
      cliPath,
      serverEntry,
      cliSha256: fileHash(cliPath),
      cliSupportSha256: treeHash(resolve(root, 'scripts/lib')),
      serverSha256: fileHash(serverEntry),
      schemaSha256: sha256(JSON.stringify(schema)),
      packageSha256: fileHash(packagePath),
      lockfileSha256: existsSync(lockfile) ? fileHash(lockfile) : null,
      buildSha256: treeHash(resolve(root, 'dist')),
      graphSdkSha256: treeHash(sdkRoot),
      graphSdkVersion: sdk.version,
      runtimePath: realpathSync(process.execPath),
      runtimeVersion: process.version,
    },
    send_email: { noRetry: true, attemptLimit: 1, maxRetries: 0, maxRedirects: 0 },
    childCleanup: {
      supported: true,
      signals: ['SIGTERM', 'SIGINT'],
      graceMs: 1000,
      inheritedProcessGroup: true,
    },
  };
}
