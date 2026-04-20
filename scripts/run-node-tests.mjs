import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tsxLoaderPath = pathToFileURL(resolve(scriptDir, '../node_modules/tsx/dist/loader.mjs')).href;

const rawTargets = process.argv.slice(2);
const targets = rawTargets.length > 0 ? rawTargets : ['services'];

const discovered = new Set();

const collectTests = (targetPath) => {
  const resolvedPath = resolve(targetPath);
  const stats = statSync(resolvedPath, { throwIfNoEntry: false });

  if (!stats) {
    throw new Error(`Test target not found: ${resolvedPath}`);
  }

  if (stats.isDirectory()) {
    for (const entry of readdirSync(resolvedPath, { withFileTypes: true })) {
      collectTests(resolve(resolvedPath, entry.name));
    }
    return;
  }

  if (resolvedPath.endsWith('.test.ts')) {
    discovered.add(resolvedPath);
  }
};

for (const target of targets) {
  collectTests(target);
}

const testFiles = Array.from(discovered).sort();

if (testFiles.length === 0) {
  throw new Error(`No test files found for targets: ${targets.join(', ')}`);
}

export const buildNodeTestArgs = (files) => ['--import', tsxLoaderPath, '--test', ...files];

const result = spawnSync(
  process.execPath,
  buildNodeTestArgs(testFiles),
  {
    stdio: 'inherit',
  }
);

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

process.exit(1);
