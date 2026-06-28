import type {
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateApplyResult,
  ProductUpdateState
} from '@debrute/app-protocol';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch } from 'node:os';
import { basename, join } from 'node:path';
import type { ProductReplacementPlan } from './ProductReplacementPlan.js';

export interface ProductUpdateReleaseAsset {
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  name: string;
  url: string;
}

export interface ProductUpdateRelease {
  version: string;
  name?: string;
  date?: string;
  checksumManifestUrl: string;
  assets: ProductUpdateReleaseAsset[];
}

export interface ProductChecksumVerificationInput {
  assetPath: string;
  checksumManifestPath: string;
  assetName: string;
}

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
  downloadAsset?: (asset: ProductUpdateReleaseAsset, destinationDir: string) => Promise<string>;
  downloadChecksumManifest?: (release: ProductUpdateRelease, destinationDir: string) => Promise<string>;
  verifyChecksum?: (input: ProductChecksumVerificationInput) => Promise<void>;
  spawnReplacementHelper?: (planPath: string) => Promise<void>;
  requestDesktopQuit?: () => void;
  exitRuntime?: () => void;
}

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
        ...(release.name ? { releaseName: release.name } : {}),
        ...(release.date ? { releaseDate: release.date } : {})
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
      const downloadedAssetPath = await this.downloadAsset()(asset, destinationDir);
      const checksumManifestPath = await this.downloadChecksumManifest()(release, destinationDir);
      await this.verifyChecksum()({
        assetPath: downloadedAssetPath,
        checksumManifestPath,
        assetName: basename(asset.name)
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
    return release.assets.find((asset) => asset.platform === platform && (!asset.arch || asset.arch === platformArch)) ?? null;
  }

  private releaseSource(): () => Promise<ProductUpdateRelease | null> {
    return this.input.releaseSource ?? defaultReleaseSource;
  }

  private downloadAsset(): (asset: ProductUpdateReleaseAsset, destinationDir: string) => Promise<string> {
    return this.input.downloadAsset ?? defaultDownloadAsset;
  }

  private downloadChecksumManifest(): (release: ProductUpdateRelease, destinationDir: string) => Promise<string> {
    return this.input.downloadChecksumManifest ?? defaultDownloadChecksumManifest;
  }

  private verifyChecksum(): (input: ProductChecksumVerificationInput) => Promise<void> {
    return this.input.verifyChecksum ?? defaultVerifyChecksum;
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
  return parseGitHubRelease(await response.json());
}

function parseGitHubRelease(value: unknown): ProductUpdateRelease {
  if (!isRecord(value)) {
    throw new Error('GitHub release response must be an object.');
  }
  const tagName = stringField(value, 'tag_name');
  const version = tagName.startsWith('v') ? tagName.slice(1) : tagName;
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) {
    throw new Error('GitHub release assets must be an array.');
  }
  const checksumAsset = assetsValue
    .filter(isRecord)
    .find((asset) => asset.name === 'debrute_SHA256SUMS');
  if (!checksumAsset) {
    throw new Error('GitHub release is missing debrute_SHA256SUMS.');
  }
  const assets = assetsValue
    .filter(isRecord)
    .map(parseGitHubReleaseAsset)
    .filter((asset): asset is ProductUpdateReleaseAsset => asset !== null);
  const releaseName = optionalStringField(value, 'name');
  const releaseDate = optionalStringField(value, 'published_at');
  return {
    version,
    checksumManifestUrl: stringField(checksumAsset, 'browser_download_url'),
    assets,
    ...(releaseName ? { name: releaseName } : {}),
    ...(releaseDate ? { date: releaseDate } : {})
  };
}

function parseGitHubReleaseAsset(value: Record<string, unknown>): ProductUpdateReleaseAsset | null {
  const name = stringField(value, 'name');
  const url = stringField(value, 'browser_download_url');
  const match = /^debrute-desktop-[^-]+-(macos|windows|linux)-(arm64|x64)\.(dmg|exe|AppImage)$/.exec(name);
  if (!match) {
    return null;
  }
  const releasePlatform = match[1];
  const releaseArch = match[2];
  if (!releasePlatform || !releaseArch) {
    return null;
  }
  return {
    platform: platformFromReleaseName(releasePlatform),
    arch: releaseArch === 'x64' ? 'x64' : 'arm64',
    name,
    url
  };
}

function platformFromReleaseName(value: string): NodeJS.Platform {
  if (value === 'macos') {
    return 'darwin';
  }
  if (value === 'windows') {
    return 'win32';
  }
  return 'linux';
}

async function defaultDownloadAsset(asset: ProductUpdateReleaseAsset, destinationDir: string): Promise<string> {
  return downloadToFile(asset.url, join(destinationDir, asset.name));
}

async function defaultDownloadChecksumManifest(release: ProductUpdateRelease, destinationDir: string): Promise<string> {
  return downloadToFile(release.checksumManifestUrl, join(destinationDir, 'debrute_SHA256SUMS'));
}

async function downloadToFile(url: string, path: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url} with HTTP ${response.status}.`);
  }
  await mkdir(join(path, '..'), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  return path;
}

async function defaultVerifyChecksum(input: ProductChecksumVerificationInput): Promise<void> {
  const manifest = await readFile(input.checksumManifestPath, 'utf8');
  const expected = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(` ${input.assetName}`) || line.endsWith(` *${input.assetName}`))
    ?.split(/\s+/)[0];
  if (!expected) {
    throw new Error(`Checksum manifest does not contain ${input.assetName}.`);
  }
  const actual = createHash('sha256').update(await readFile(input.assetPath)).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${input.assetName}.`);
  }
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

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() !== '' ? field : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
