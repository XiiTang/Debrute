import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
const requiredPaths = [
  'package-lock.json',
  'node_modules',
  'apps/desktop/src/electron/main.ts',
  'apps/desktop/src/electron/preload.ts'
];
const requiredPackages = [
  'electron/package.json',
  'electron-builder/package.json',
  'vite/package.json',
  'typescript/package.json'
];

const failures = [];
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (nodeMajor < 22) {
  failures.push(`Node.js 22 or newer is required. Current: ${process.version}`);
}

for (const path of requiredPaths) {
  if (!existsSync(join(root, path))) {
    failures.push(`Missing required path: ${path}`);
  }
}

for (const packageName of requiredPackages) {
  try {
    desktopRequire.resolve(packageName);
  } catch {
    failures.push(`Missing workspace dependency: ${packageName.replace('/package.json', '')}`);
  }
}

let npmVersion = 'unknown';
try {
  npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  failures.push('npm is not available on PATH.');
}

if (process.platform !== 'darwin') {
  console.warn(`AXIS packaging is currently configured for macOS. Current platform: ${process.platform}`);
}

if (failures.length > 0) {
  console.error(['AXIS doctor failed:', ...failures.map((failure) => `- ${failure}`)].join('\n'));
  process.exit(1);
}

console.log(`AXIS doctor passed. Node ${process.version}, npm ${npmVersion}, platform ${process.platform}.`);
