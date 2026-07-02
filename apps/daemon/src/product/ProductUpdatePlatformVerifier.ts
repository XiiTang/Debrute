import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import type { ProductUpdateReleaseAsset } from './ProductUpdateManifest.js';

export interface ProductPlatformAssetVerificationInput {
  assetPath: string;
  asset: ProductUpdateReleaseAsset;
  platform: NodeJS.Platform;
}

export interface ProductUpdatePlatformVerifierDependencies {
  execFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export function createProductUpdatePlatformVerifier(
  dependencies: ProductUpdatePlatformVerifierDependencies = nodeDependencies()
): (input: ProductPlatformAssetVerificationInput) => Promise<void> {
  return async (input) => {
    if (input.platform !== 'darwin') {
      return;
    }
    await verifyMacosDmg(input.assetPath, input.asset, dependencies);
  };
}

async function verifyMacosDmg(
  assetPath: string,
  asset: ProductUpdateReleaseAsset,
  dependencies: ProductUpdatePlatformVerifierDependencies
): Promise<void> {
  if (!assetPath.endsWith('.dmg') || !asset.name.endsWith('.dmg')) {
    throw new Error(`Unsupported macOS Debrute update asset: ${asset.name}`);
  }
  const attach = await dependencies.execFile('hdiutil', ['attach', '-nobrowse', '-readonly', assetPath]);
  const mountPoint = parseDmgMountPoint(attach.stdout);
  try {
    const found = await dependencies.execFile('find', [mountPoint, '-maxdepth', '1', '-name', '*.app', '-type', 'd', '-print', '-quit']);
    const appPath = found.stdout.trim();
    if (!appPath) {
      throw new Error(`No .app bundle found in mounted Debrute DMG: ${mountPoint}`);
    }
    const bundleId = (await dependencies.execFile('plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      join(appPath, 'Contents', 'Info.plist')
    ])).stdout.trim();
    if (bundleId !== 'io.github.xiitang.debrute') {
      throw new Error(`Expected Debrute app bundle id io.github.xiitang.debrute, got ${bundleId}`);
    }
    await dependencies.execFile('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    await dependencies.execFile('spctl', ['-a', '-t', 'exec', '-vv', appPath]);
    await dependencies.execFile('xcrun', ['stapler', 'validate', appPath]);
  } finally {
    await dependencies.execFile('hdiutil', ['detach', mountPoint]);
  }
}

function nodeDependencies(): ProductUpdatePlatformVerifierDependencies {
  return { execFile };
}

function execFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDmgMountPoint(output: string): string {
  const mountPoint = output
    .split(/\r?\n/)
    .map((line) => line.split('\t').at(-1)?.trim())
    .find((part) => part?.startsWith('/Volumes/'));
  if (!mountPoint) {
    throw new Error('Unable to determine Debrute DMG mount point.');
  }
  return mountPoint;
}
