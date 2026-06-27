#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const defaultBundleId = 'io.github.xiitang.debrute';
const options = parseArgs(process.argv.slice(2));
const releaseDir = resolve(requiredValue(options, '--release-dir'));
const version = requiredValue(options, '--version');
const arch = requiredValue(options, '--arch');
const bundleId = options.get('--bundle-id') ?? defaultBundleId;

if (process.platform !== 'darwin') {
  throw new Error('macOS signing verification must run on macOS.');
}

if (bundleId !== defaultBundleId) {
  throw new Error(`Unsupported macOS bundle id: ${bundleId}`);
}

if (arch === 'arm64' || arch === 'x64') {
  verifyDmg(join(releaseDir, `debrute-desktop-${version}-macos-${arch}.dmg`), bundleId);
} else {
  throw new Error(`Unsupported macOS release arch: ${arch}`);
}

function verifyDmg(dmgPath, expectedBundleId) {
  run('codesign', ['--verify', '--verbose=2', dmgPath]);
  run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath]);
  run('xcrun', ['stapler', 'validate', dmgPath]);

  const mountDir = mkdtempSync(join(tmpdir(), 'debrute-dmg-'));
  try {
    run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountDir]);
    const [appPath] = collectApps(mountDir);
    if (!appPath) {
      throw new Error(`No .app bundle found inside ${dmgPath}`);
    }
    verifyApp(appPath, expectedBundleId);
  } finally {
    run('hdiutil', ['detach', mountDir], { allowFailure: true });
    rmSync(mountDir, { recursive: true, force: true });
  }
}

function verifyApp(appPath, expectedBundleId) {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  const actualBundleId = run(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', plistPath],
    { capture: true }
  );
  if (actualBundleId !== expectedBundleId) {
    throw new Error(`Expected ${appPath} to use bundle id ${expectedBundleId}, got ${actualBundleId}`);
  }

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('spctl', ['-a', '-t', 'exec', '-vv', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
}

function collectApps(root) {
  const apps = [];
  visit(root);
  return apps;

  function visit(dir) {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        continue;
      }
      if (entry.endsWith('.app')) {
        apps.push(entryPath);
        continue;
      }
      visit(entryPath);
    }
  }
}

function run(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    return options.capture ? output.trim() : '';
  } catch (error) {
    if (options.allowFailure) {
      return '';
    }
    throw error;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument list: ${argv.join(' ')}`);
    }
    values.set(key, value);
  }
  return values;
}

function requiredValue(values, key) {
  const value = values.get(key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}
