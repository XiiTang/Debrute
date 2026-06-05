import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
const requiredPaths = [
  'pnpm-lock.yaml',
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

if (nodeMajor !== 24) {
  failures.push(`Node.js 24 is required. Current: ${process.version}`);
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

function parsePnpmVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

function isPnpmVersionSupported(version) {
  const parsed = parsePnpmVersion(version);
  if (parsed === null) {
    return false;
  }

  if (parsed.major < 11 || parsed.major >= 12) {
    return false;
  }

  if (parsed.major === 11 && parsed.minor < 2) {
    return false;
  }

  if (parsed.major === 11 && parsed.minor === 2 && parsed.patch < 2) {
    return false;
  }

  return true;
}

let pnpmVersion = 'unknown';
try {
  pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  if (!isPnpmVersionSupported(pnpmVersion)) {
    failures.push(`pnpm >=11.2.2 <12 is required. Current: ${pnpmVersion}`);
  }
} catch {
  failures.push('pnpm is not available on PATH.');
}

if (process.platform !== 'darwin') {
  console.warn(`Debrute packaging is currently configured for macOS. Current platform: ${process.platform}`);
}

if (failures.length > 0) {
  console.error(['Debrute doctor failed:', ...failures.map((failure) => `- ${failure}`)].join('\n'));
  process.exit(1);
}

console.log(`Debrute doctor passed. Node ${process.version}, pnpm ${pnpmVersion}, platform ${process.platform}.`);
