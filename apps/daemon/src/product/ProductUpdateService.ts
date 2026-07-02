import type {
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateApplyResult,
  ProductUpdateState
} from '@debrute/app-protocol';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  parseTrustedProductUpdateManifest,
  productUpdateManifestMaxBytes,
  productUpdateManifestName,
  productUpdateManifestSignatureMaxBytes,
  productUpdateManifestSignatureName,
  productUpdateReleaseFromManifest,
  type ProductUpdateManifest,
  type ProductUpdateRelease,
  type ProductUpdateReleaseAsset
} from './ProductUpdateManifest.js';
import {
  createProductUpdatePlatformVerifier,
  type ProductPlatformAssetVerificationInput
} from './ProductUpdatePlatformVerifier.js';
import type { ProductReplacementPlan } from './ProductReplacementPlan.js';
import { DEBRUTE_UPDATE_PUBLIC_KEY_PEM } from './updateSigningPublicKey.js';

export type { ProductUpdateRelease, ProductUpdateReleaseAsset };
export type { ProductPlatformAssetVerificationInput };

export interface ProductUpdateServiceInput {
  productVersion: string;
  platform?: NodeJS.Platform;
  platformArch?: NodeJS.Architecture;
  cliDiagnostic: () => ManagedCliDiagnostic;
  desktopInstallPath?: string;
  managedProductRoot?: string;
  desktopPid?: number;
  runtimePid?: number;
  releaseSource?: () => Promise<ProductUpdateRelease | null>;
  verifyPlatformAsset?: (input: ProductPlatformAssetVerificationInput) => Promise<void>;
  spawnReplacementHelper?: (planPath: string) => Promise<void>;
  requestDesktopQuit?: () => void;
  exitRuntime?: () => void;
}

const defaultVerifyPlatformAsset = createProductUpdatePlatformVerifier();

export class ProductUpdateService {
  private updateState: ProductUpdateState;
  private availableRelease: ProductUpdateRelease | null = null;

  constructor(private readonly input: ProductUpdateServiceInput) {
    this.updateState = {
      type: 'idle',
      currentVersion: input.productVersion,
      updateAvailable: false
    };
  }

  async state(): Promise<DebruteProductState> {
    return this.productState();
  }

  async check(): Promise<DebruteProductState> {
    this.updateState = { type: 'checking', currentVersion: this.input.productVersion };
    try {
      const release = await this.releaseSource()();
      this.availableRelease = release;
      const checkedAt = new Date().toISOString();
      if (!release || compareVersions(release.version, this.input.productVersion) <= 0) {
        this.availableRelease = null;
        this.updateState = {
          type: 'idle',
          currentVersion: this.input.productVersion,
          lastCheckedAt: checkedAt,
          updateAvailable: false
        };
        return this.productState();
      }
      const asset = this.selectAsset(release);
      if (!asset) {
        this.availableRelease = null;
        this.updateState = {
          type: 'error',
          currentVersion: this.input.productVersion,
          operation: 'check',
          updateVersion: release.version,
          message: `No Debrute desktop update asset exists for ${this.platform()} ${this.platformArch()}.`
        };
        return this.productState();
      }
      this.updateState = {
        type: 'available',
        currentVersion: this.input.productVersion,
        updateVersion: release.version,
        releaseName: release.name,
        releaseDate: release.date
      };
    } catch (error) {
      this.updateState = {
        type: 'error',
        currentVersion: this.input.productVersion,
        operation: 'check',
        message: errorMessage(error)
      };
    }
    return this.productState();
  }

  async apply(): Promise<ProductUpdateApplyResult> {
    if (this.updateState.type !== 'available') {
      await this.check();
    }
    if (this.updateState.type !== 'available' || !this.availableRelease) {
      return { state: this.productState() };
    }
    try {
      const release = this.availableRelease;
      const asset = this.selectAsset(release);
      if (!asset) {
        throw new Error(`No Debrute desktop update asset exists for ${this.platform()} ${this.platformArch()}.`);
      }
      const desktopInstallPath = required(this.input.desktopInstallPath, 'desktopInstallPath');
      const managedProductRoot = required(this.input.managedProductRoot, 'managedProductRoot');
      const spawnReplacementHelper = this.spawnReplacementHelper();
      const requestDesktopQuit = requiredCallback(this.input.requestDesktopQuit, 'requestDesktopQuit');
      const exitRuntime = requiredCallback(this.input.exitRuntime, 'exitRuntime');
      const runtimePid = this.input.runtimePid ?? process.pid;
      const destinationDir = join(managedProductRoot, 'updates', release.version);
      await mkdir(destinationDir, { recursive: true });
      const downloadedAssetPath = await downloadVerifiedAsset(asset, destinationDir);
      await this.verifyPlatformAsset()({
        assetPath: downloadedAssetPath,
        asset,
        platform: this.platform()
      });
      const plan: ProductReplacementPlan = {
        currentVersion: this.input.productVersion,
        updateVersion: release.version,
        platform: this.platform(),
        desktopInstallPath,
        downloadedAssetPath,
        runtimePid,
        relaunchDesktop: true,
        ...(this.input.desktopPid !== undefined ? { desktopPid: this.input.desktopPid } : {})
      };
      const planPath = join(destinationDir, 'product-replacement-plan.json');
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      this.updateState = {
        type: 'installing',
        currentVersion: this.input.productVersion,
        updateVersion: release.version
      };
      await spawnReplacementHelper(planPath);
      requestDesktopQuit();
      exitRuntime();
    } catch (error) {
      const updateVersion = this.availableRelease?.version;
      this.updateState = {
        type: 'error',
        currentVersion: this.input.productVersion,
        operation: 'apply',
        message: errorMessage(error),
        ...(updateVersion ? { updateVersion } : {})
      };
    }
    return {
      state: this.productState()
    };
  }

  private productState(): DebruteProductState {
    return {
      productVersion: this.input.productVersion,
      platform: this.input.platform ?? process.platform,
      cli: this.input.cliDiagnostic(),
      update: this.updateState
    };
  }

  private platform(): NodeJS.Platform {
    return this.input.platform ?? process.platform;
  }

  private platformArch(): NodeJS.Architecture {
    return this.input.platformArch ?? arch();
  }

  private selectAsset(release: ProductUpdateRelease): ProductUpdateReleaseAsset | null {
    const platform = this.platform();
    const platformArch = this.platformArch();
    return release.assets.find((asset) => asset.platform === platform && asset.arch === platformArch) ?? null;
  }

  private releaseSource(): () => Promise<ProductUpdateRelease | null> {
    return this.input.releaseSource ?? defaultReleaseSource;
  }

  private verifyPlatformAsset(): (input: ProductPlatformAssetVerificationInput) => Promise<void> {
    return this.input.verifyPlatformAsset ?? defaultVerifyPlatformAsset;
  }

  private spawnReplacementHelper(): (planPath: string) => Promise<void> {
    if (!this.input.spawnReplacementHelper) {
      throw new Error('Product update spawnReplacementHelper is required.');
    }
    return this.input.spawnReplacementHelper;
  }
}

async function defaultReleaseSource(): Promise<ProductUpdateRelease | null> {
  const response = await fetch('https://api.github.com/repos/xiitang/debrute/releases/latest', {
    headers: { accept: 'application/vnd.github+json' }
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
  }
  return productUpdateReleaseFromManifest(await downloadTrustedManifestFromGitHubRelease(await response.json()));
}

async function downloadTrustedManifestFromGitHubRelease(value: unknown): Promise<ProductUpdateManifest> {
  if (!isRecord(value)) {
    throw new Error('GitHub release response must be an object.');
  }
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) {
    throw new Error('GitHub release assets must be an array.');
  }
  const manifestAsset = findNamedGitHubAsset(assetsValue, productUpdateManifestName);
  const signatureAsset = findNamedGitHubAsset(assetsValue, productUpdateManifestSignatureName);
  const manifestBytes = await downloadBytesWithLimit(
    stringField(manifestAsset, 'browser_download_url'),
    productUpdateManifestMaxBytes,
    productUpdateManifestName
  );
  const signatureText = Buffer.from(await downloadBytesWithLimit(
    stringField(signatureAsset, 'browser_download_url'),
    productUpdateManifestSignatureMaxBytes,
    productUpdateManifestSignatureName
  )).toString('utf8');
  return parseTrustedProductUpdateManifest({
    manifestBytes,
    signatureText,
    publicKeyPem: DEBRUTE_UPDATE_PUBLIC_KEY_PEM
  });
}

function findNamedGitHubAsset(assets: unknown[], name: string): Record<string, unknown> {
  const asset = assets.filter(isRecord).find((candidate) => candidate.name === name);
  if (!asset) {
    throw new Error(`GitHub release is missing ${name}.`);
  }
  return asset;
}

async function downloadVerifiedAsset(asset: ProductUpdateReleaseAsset, destinationDir: string): Promise<string> {
  const destinationPath = join(destinationDir, asset.name);
  const response = await fetch(asset.url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${asset.url} with HTTP ${response.status}.`);
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > asset.sizeBytes) {
        callback(new Error(`Downloaded update asset exceeds signed size for ${asset.name}.`));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    verifier,
    createWriteStream(destinationPath)
  );
  if (size !== asset.sizeBytes) {
    throw new Error(`Size mismatch for ${asset.name}.`);
  }
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error(`Hash mismatch for ${asset.name}.`);
  }
  return destinationPath;
}

async function downloadBytesWithLimit(url: string, maxBytes: number, label: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${url} with HTTP ${response.status}.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new Error(`Downloaded ${label} exceeds ${maxBytes} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function required(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Product update ${label} is required.`);
  }
  return value;
}

function requiredCallback<T extends (...args: never[]) => unknown>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`Product update ${label} is required.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(`GitHub release ${key} must be a non-empty string.`);
  }
  return field;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
