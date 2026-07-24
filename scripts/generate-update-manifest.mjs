import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopReleaseTargets,
  expectedDesktopReleaseAssets,
  expectedProductReleaseAssets,
  productReleaseAssetName,
  productReleaseTargets,
  updateManifestName,
  updateManifestSignatureName
} from './release-asset-contract.mjs';

export { updateManifestName, updateManifestSignatureName };

export async function generateUpdateManifest(input) {
  const {
    releaseDir,
    version,
    privateKeyPem,
    publishedAt = new Date().toISOString()
  } = parseGeneratorOptions(input);
  const resolvedReleaseDir = resolve(releaseDir);
  const expectedDesktopAssets = expectedDesktopReleaseAssets(version);
  const expectedProductAssets = expectedProductReleaseAssets(version);
  const releaseFiles = await readdir(resolvedReleaseDir);
  const allowedInputFiles = new Set([
    ...expectedDesktopAssets,
    ...expectedProductAssets,
    updateManifestName,
    updateManifestSignatureName
  ]);
  const unexpected = releaseFiles.filter((name) => !allowedInputFiles.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release assets: ${unexpected.join(', ')}`);
  }
  const missing = [];
  for (const assetName of [...expectedDesktopAssets, ...expectedProductAssets]) {
    try {
      await stat(join(resolvedReleaseDir, assetName));
    } catch {
      missing.push(assetName);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing release assets: ${missing.join(', ')}`);
  }
  if (!privateKeyPem?.trim()) {
    throw new Error('DEBRUTE_UPDATE_SIGNING_PRIVATE_KEY_PEM is required.');
  }
  const releaseTag = `v${version}`;
  const desktopAssets = await Promise.all(desktopReleaseTargets.map(async (target) => {
    const name = `debrute-desktop-${version}-${target.platform}-${target.arch}.${target.extension}`;
    const bytes = await readFile(join(resolvedReleaseDir, name));
    return {
      kind: 'desktop',
      platform: target.platform,
      arch: target.arch,
      name,
      url: `https://github.com/xiitang/debrute/releases/download/${releaseTag}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength
    };
  }));
  const productAssets = await Promise.all(productReleaseTargets.map(async (target) => {
    const name = productReleaseAssetName(version, target.platform, target.arch);
    const bytes = await readFile(join(resolvedReleaseDir, name));
    return {
      kind: 'product',
      platform: target.platform,
      arch: target.arch,
      name,
      url: `https://github.com/xiitang/debrute/releases/download/${releaseTag}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength
    };
  }));
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    product: 'debrute',
    version,
    releaseTag,
    publishedAt,
    assets: [...desktopAssets, ...productAssets]
  }, null, 2)}\n`, 'utf8');
  const signature = sign(null, manifestBytes, createPrivateKey(privateKeyPem)).toString('base64');
  await writeFile(join(resolvedReleaseDir, updateManifestName), manifestBytes);
  await writeFile(join(resolvedReleaseDir, updateManifestSignatureName), `${signature}\n`, 'utf8');
}

function parseGeneratorOptions(input) {
  const allowed = new Set(['releaseDir', 'version', 'privateKeyPem', 'publishedAt']);
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported update manifest generator options: ${unsupported.join(', ')}`);
  }
  return input;
}

function isDirectCliInvocation(moduleUrl, argvPath) {
  if (!argvPath) {
    return false;
  }
  return normalizeCliPath(fileURLToPath(moduleUrl)) === normalizeCliPath(argvPath);
}

function normalizeCliPath(path) {
  return path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  const releaseDir = valueAfter('--release-dir') ?? 'release-upload';
  const version = valueAfter('--version');
  if (!version) {
    console.error('--version is required');
    process.exit(1);
  }
  generateUpdateManifest({
    releaseDir,
    version,
    privateKeyPem: process.env.DEBRUTE_UPDATE_SIGNING_PRIVATE_KEY_PEM
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
