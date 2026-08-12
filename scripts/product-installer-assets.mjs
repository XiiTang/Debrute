import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  productInstallerAssetName,
  resolveHostProductReleaseTarget
} from './release-asset-contract.mjs';

export function requiredProductInstallerAssets(version, platform = process.platform, arch = process.arch) {
  const target = resolveHostProductReleaseTarget(platform, arch);
  return [productInstallerAssetName(version, target)];
}

export async function verifyProductInstallerAssets({
  releaseDir,
  version,
  platform = process.platform,
  arch = process.arch
}) {
  const files = new Set(await readdir(releaseDir));
  const expected = requiredProductInstallerAssets(version, platform, arch);
  const missing = expected.filter((name) => !files.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing Product Installer assets: ${missing.join(', ')}`);
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
  verifyProductInstallerAssets({ releaseDir, version, platform, arch })
    .then((verified) => {
      console.log(`Verified Product Installer assets: ${verified.join(', ')}`);
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
