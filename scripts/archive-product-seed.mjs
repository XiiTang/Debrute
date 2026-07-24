import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { productReleaseAssetName } from './release-asset-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function archiveProductSeed(input = {}) {
  const platform = input.platform ?? publicPlatform(process.platform);
  const arch = input.arch ?? process.arch;
  if (!isSupportedProductTarget(platform, arch)) {
    throw new Error(`Unsupported Product seed release target: ${platform} ${arch}`);
  }
  const version = input.version ?? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const seed = resolve(input.seed ?? join(root, 'apps/desktop/dist-electron/product-seed'));
  const outDir = resolve(input.outDir ?? join(root, 'apps/desktop/release'));
  const manifest = JSON.parse(await readFile(join(seed, 'product-manifest.json'), 'utf8'));
  if (manifest.productVersion !== version || manifest.platform !== platform || manifest.architecture !== arch) {
    throw new Error('Product seed identity does not match the requested release archive.');
  }
  await mkdir(outDir, { recursive: true });
  const assetName = productReleaseAssetName(version, platform, arch);
  const assetPath = join(outDir, assetName);
  const archive = new AdmZip();
  archive.addLocalFolder(seed);
  await new Promise((resolveArchive, rejectArchive) => {
    archive.writeZip(assetPath, (error) => error ? rejectArchive(error) : resolveArchive());
  });
  const entries = new AdmZip(assetPath).getEntries();
  const names = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
  const expected = [
    'product-manifest.json',
    ...manifest.files.map((file) => file.path)
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Product seed archive inventory mismatch: ${basename(assetPath)}`);
  }
  return { assetName, assetPath };
}

function isSupportedProductTarget(platform, arch) {
  return (platform === 'macos' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'windows' && arch === 'x64');
}

function publicPlatform(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  archiveProductSeed({
    ...(valueAfter('--platform') ? { platform: valueAfter('--platform') } : {}),
    ...(valueAfter('--arch') ? { arch: valueAfter('--arch') } : {}),
    ...(valueAfter('--version') ? { version: valueAfter('--version') } : {}),
    ...(valueAfter('--seed') ? { seed: valueAfter('--seed') } : {}),
    ...(valueAfter('--out-dir') ? { outDir: valueAfter('--out-dir') } : {})
  }).then(({ assetPath }) => {
    console.log(`Archived Product seed: ${assetPath}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
