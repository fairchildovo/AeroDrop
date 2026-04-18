import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
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
