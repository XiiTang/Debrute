import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import {
  productReleaseAssetName,
  resolveCanonicalProductReleaseTarget,
  resolveHostProductReleaseTarget
} from './release-asset-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function archiveProductSeed(input = {}) {
  const arch = input.arch ?? process.arch;
  const target = input.platform === undefined
    ? resolveHostProductReleaseTarget(process.platform, arch)
    : resolveCanonicalProductReleaseTarget(input.platform, arch);
  const platform = target.canonicalPlatform;
  const version = input.version ?? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const seed = resolve(input.seed ?? join(root, 'apps/desktop/dist-electron/product-seed'));
  const outDir = resolve(input.outDir ?? join(root, 'apps/desktop/release'));
  const manifest = JSON.parse(await readFile(join(seed, 'product-manifest.json'), 'utf8'));
  if (manifest.productVersion !== version || manifest.platform !== platform || manifest.architecture !== arch) {
    throw new Error('Product seed identity does not match the requested release archive.');
  }
  await mkdir(outDir, { recursive: true });
  const assetName = productReleaseAssetName(version, target);
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
