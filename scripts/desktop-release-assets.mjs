import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { desktopReleaseAssetName } from './release-asset-contract.mjs';

export function electronBuilderPlatformName(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported Desktop release platform: ${platform}`);
}

export function requiredDesktopReleaseAssets(version, platform = process.platform, arch = process.arch) {
  const publicPlatform = electronBuilderPlatformName(platform);
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(`Unsupported macOS release arch: ${arch}`);
    }
    return [desktopReleaseAssetName(version, publicPlatform, arch, 'dmg')];
  }
  if (platform === 'win32') {
    return [desktopReleaseAssetName(version, publicPlatform, arch, 'exe')];
  }
  return [desktopReleaseAssetName(version, publicPlatform, arch, 'AppImage')];
}

export async function verifyDesktopReleaseAssets({
  releaseDir,
  version,
  platform = process.platform,
  arch = process.arch
}) {
  const files = new Set(await readdir(releaseDir));
  const expected = requiredDesktopReleaseAssets(version, platform, arch);
  const missing = expected.filter((name) => !files.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing Desktop release assets: ${missing.join(', ')}`);
  }
  return expected;
}

export function isDirectCliInvocation(moduleUrl, argvPath) {
  if (!argvPath) return false;
  return normalizeCliPath(fileURLToPath(moduleUrl)) === normalizeCliPath(argvPath);
}

function normalizeCliPath(path) {
  return path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  const releaseDir = valueAfter('--release-dir') ?? 'release';
  const version = valueAfter('--version');
  const platform = valueAfter('--platform') ?? process.platform;
  const arch = valueAfter('--arch') ?? process.arch;
  if (!version) {
    console.error('--version is required');
    process.exit(1);
  }
  verifyDesktopReleaseAssets({ releaseDir, version, platform, arch })
    .then((verified) => {
      console.log(`Verified Desktop release assets: ${verified.join(', ')}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
