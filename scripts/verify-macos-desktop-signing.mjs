#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultBundleId = 'io.github.xiitang.debrute';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}

function main(argv) {
  const options = parseArgs(argv);
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
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS release arch: ${arch}`);
  }
  verifyDmg(join(releaseDir, `debrute-desktop-${version}-macos-${arch}.dmg`), bundleId);
}

function verifyDmg(dmgPath, expectedBundleId) {
  run('codesign', ['--verify', '--verbose=2', dmgPath]);
  run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmgPath]);
  run('xcrun', ['stapler', 'validate', dmgPath]);

  const mountDir = mkdtempSync(join(tmpdir(), 'debrute-dmg-'));
  try {
    run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountDir]);
    const appPath = resolveMountedDesktopApp(mountDir, dmgPath);
    verifyApp(appPath, expectedBundleId);
  } finally {
    run('hdiutil', ['detach', mountDir], { allowFailure: true });
    rmSync(mountDir, { recursive: true, force: true });
  }
}

export function resolveMountedDesktopApp(mountDir, dmgPath) {
  const appPath = join(mountDir, 'Debrute.app');
  let appStat;
  try {
    appStat = lstatSync(appPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Expected Debrute.app inside ${dmgPath}`);
    }
    throw error;
  }
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw new Error(`Expected a real Debrute.app directory inside ${dmgPath}`);
  }
  return appPath;
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
