import { createPublicKey, verify } from 'node:crypto';

export const productUpdateManifestName = 'debrute-update-manifest.json';
export const productUpdateManifestSignatureName = 'debrute-update-manifest.json.sig';
export const productUpdateManifestMaxBytes = 256 * 1024;
export const productUpdateManifestSignatureMaxBytes = 8 * 1024;

export type ProductUpdateManifestPlatform = 'macos' | 'windows' | 'linux';
export type ProductUpdateManifestArch = 'arm64' | 'x64';

export interface ProductUpdateManifestAsset {
  platform: ProductUpdateManifestPlatform;
  arch: ProductUpdateManifestArch;
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface ProductUpdateManifest {
  schemaVersion: 1;
  product: 'debrute-desktop';
  version: string;
  releaseTag: string;
  publishedAt: string;
  assets: ProductUpdateManifestAsset[];
}

export interface ProductUpdateReleaseAsset {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface ProductUpdateRelease {
  version: string;
  name: string;
  date: string;
  assets: ProductUpdateReleaseAsset[];
}

export function parseTrustedProductUpdateManifest(input: {
  manifestBytes: Uint8Array;
  signatureText: string;
  publicKeyPem: string;
}): ProductUpdateManifest {
  const signature = Buffer.from(input.signatureText.trim(), 'base64');
  if (signature.byteLength === 0) {
    throw new Error('Product update manifest signature is empty.');
  }
  if (!verify(null, input.manifestBytes, createPublicKey(input.publicKeyPem), signature)) {
    throw new Error('Product update manifest signature is invalid.');
  }
  return parseProductUpdateManifest(input.manifestBytes);
}

export function parseProductUpdateManifest(bytes: Uint8Array): ProductUpdateManifest {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  if (!isRecord(value)) {
    throw new Error('Product update manifest must be an object.');
  }
  rejectUnsupportedFields(value, [
    'schemaVersion',
    'product',
    'version',
    'releaseTag',
    'publishedAt',
    'assets'
  ], 'Product update manifest');
  if (value.schemaVersion !== 1) {
    throw new Error('Product update manifest schemaVersion must be 1.');
  }
  if (value.product !== 'debrute-desktop') {
    throw new Error('Product update manifest product must be debrute-desktop.');
  }
  const version = stringField(value, 'version');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Product update manifest version is invalid: ${version}`);
  }
  const releaseTag = stringField(value, 'releaseTag');
  if (releaseTag !== `v${version}`) {
    throw new Error(`Product update manifest releaseTag must be v${version}.`);
  }
  const publishedAt = stringField(value, 'publishedAt');
  if (!isUtcIsoTimestamp(publishedAt)) {
    throw new Error('Product update manifest publishedAt must be a UTC ISO timestamp.');
  }
  if (!Array.isArray(value.assets)) {
    throw new Error('Product update manifest assets must be an array.');
  }
  const assets = value.assets.map((asset) => parseManifestAsset(asset, version, releaseTag));
  assertUniqueAssetTargets(assets);
  return {
    schemaVersion: 1,
    product: 'debrute-desktop',
    version,
    releaseTag,
    publishedAt,
    assets
  };
}

export function productUpdateReleaseFromManifest(manifest: ProductUpdateManifest): ProductUpdateRelease {
  return {
    version: manifest.version,
    name: `Debrute ${manifest.version}`,
    date: manifest.publishedAt,
    assets: manifest.assets.map((asset) => ({
      platform: nodePlatformFromManifestPlatform(asset.platform),
      arch: asset.arch,
      name: asset.name,
      url: asset.url,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes
    }))
  };
}

function parseManifestAsset(value: unknown, version: string, releaseTag: string): ProductUpdateManifestAsset {
  if (!isRecord(value)) {
    throw new Error('Product update manifest asset must be an object.');
  }
  rejectUnsupportedFields(value, [
    'platform',
    'arch',
    'name',
    'url',
    'sha256',
    'sizeBytes'
  ], 'Product update manifest asset');
  const platform = platformField(value, 'platform');
  const arch = archField(value, 'arch');
  if (!isSupportedReleaseTarget(platform, arch)) {
    throw new Error(`Product update manifest asset release target is unsupported: ${platform} ${arch}.`);
  }
  const name = stringField(value, 'name');
  const url = stringField(value, 'url');
  const sha256 = stringField(value, 'sha256');
  const sizeBytes = numberField(value, 'sizeBytes');
  const extension = platform === 'macos' ? 'dmg' : platform === 'windows' ? 'exe' : 'AppImage';
  const expectedName = `debrute-desktop-${version}-${platform}-${arch}.${extension}`;
  const expectedUrl = `https://github.com/xiitang/debrute/releases/download/${releaseTag}/${expectedName}`;
  if (name !== expectedName) {
    throw new Error(`Product update manifest asset name must be ${expectedName}.`);
  }
  if (url !== expectedUrl) {
    throw new Error(`Product update manifest asset URL must be ${expectedUrl}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Product update manifest asset sha256 is invalid for ${name}.`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Product update manifest asset sizeBytes is invalid for ${name}.`);
  }
  return { platform, arch, name, url, sha256, sizeBytes };
}

function assertUniqueAssetTargets(assets: ProductUpdateManifestAsset[]): void {
  const targets = new Set<string>();
  for (const asset of assets) {
    const target = `${asset.platform}/${asset.arch}`;
    if (targets.has(target)) {
      throw new Error(`Product update manifest contains duplicate platform and architecture: ${asset.platform} ${asset.arch}.`);
    }
    targets.add(target);
  }
}

function nodePlatformFromManifestPlatform(platform: ProductUpdateManifestPlatform): NodeJS.Platform {
  if (platform === 'macos') {
    return 'darwin';
  }
  if (platform === 'windows') {
    return 'win32';
  }
  return 'linux';
}

function isSupportedReleaseTarget(platform: ProductUpdateManifestPlatform, arch: ProductUpdateManifestArch): boolean {
  return platform === 'macos' || arch === 'x64';
}

function platformField(value: Record<string, unknown>, key: string): ProductUpdateManifestPlatform {
  const field = stringField(value, key);
  if (field !== 'macos' && field !== 'windows' && field !== 'linux') {
    throw new Error(`Product update manifest ${key} is invalid: ${field}`);
  }
  return field;
}

function archField(value: Record<string, unknown>, key: string): ProductUpdateManifestArch {
  const field = stringField(value, key);
  if (field !== 'arm64' && field !== 'x64') {
    throw new Error(`Product update manifest ${key} is invalid: ${field}`);
  }
  return field;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(`Product update manifest ${key} must be a non-empty string.`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`Product update manifest ${key} must be a number.`);
  }
  return field;
}

function rejectUnsupportedFields(value: Record<string, unknown>, allowedFields: string[], label: string): void {
  const allowed = new Set(allowedFields);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unsupported.join(', ')}.`);
  }
}

function isUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
