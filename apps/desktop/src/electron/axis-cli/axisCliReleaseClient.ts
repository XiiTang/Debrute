import { createHash } from 'node:crypto';
import type { AxisCliTarget } from './axisCliPaths.js';
import { axisCliAssetName } from './axisCliPaths.js';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/XiiTang/AXIS/releases/latest';
const CHECKSUMS_ASSET_NAME = 'axis-cli_SHA256SUMS';

export interface AxisCliReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface AxisCliResolvedRelease {
  version: string;
  asset: AxisCliReleaseAsset;
  checksumsAsset: AxisCliReleaseAsset;
}

export interface AxisCliReleaseClient {
  getLatestVersion(): Promise<string | undefined>;
  installLatest(input: {
    target: AxisCliTarget;
    stagingArchivePath: string;
    writeArchive(path: string, data: Uint8Array): Promise<void>;
  }): Promise<{ version: string; archivePath: string }>;
}

export async function resolveAxisCliRelease(input: {
  fetch: typeof fetch;
  target: AxisCliTarget;
}): Promise<AxisCliResolvedRelease> {
  const response = await fetchResponse(input.fetch, LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) {
    throw Object.assign(new Error('AXIS CLI release was not found.'), { code: 'release_not_found' });
  }
  const release = await response.json() as { tag_name?: string; assets?: AxisCliReleaseAsset[] };
  const version = release.tag_name?.replace(/^v/, '');
  if (!version || !release.assets) {
    throw Object.assign(new Error('AXIS CLI release metadata is invalid.'), { code: 'release_not_found' });
  }
  const assetName = axisCliAssetName(version, input.target);
  const asset = release.assets.find((item) => item.name === assetName);
  const checksumsAsset = release.assets.find((item) => item.name === CHECKSUMS_ASSET_NAME);
  if (!asset || !checksumsAsset) {
    throw Object.assign(new Error(`AXIS CLI release asset is missing for ${input.target.id}.`), { code: 'release_not_found' });
  }
  return { version, asset, checksumsAsset };
}

export function parseAxisCliChecksums(text: string): Map<string, string> {
  return new Map(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [checksum, filename] = line.split(/\s+/);
      return [filename, checksum] as const;
    })
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
}

export function createGitHubAxisCliReleaseClient(fetchImpl: typeof fetch = fetch): AxisCliReleaseClient {
  return {
    async getLatestVersion() {
      const response = await fetchResponse(fetchImpl, LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) {
        throw Object.assign(new Error('AXIS CLI release was not found.'), { code: 'release_not_found' });
      }
      const release = await response.json() as { tag_name?: string };
      const version = release.tag_name?.replace(/^v/, '');
      if (!version) {
        throw Object.assign(new Error('AXIS CLI release metadata is invalid.'), { code: 'release_not_found' });
      }
      return version;
    },
    async installLatest(input) {
      const release = await resolveAxisCliRelease({ fetch: fetchImpl, target: input.target });
      const [archive, checksumsText] = await Promise.all([
        downloadBytes(fetchImpl, release.asset.browser_download_url),
        downloadText(fetchImpl, release.checksumsAsset.browser_download_url)
      ]);
      const expectedChecksum = parseAxisCliChecksums(checksumsText).get(release.asset.name);
      if (!expectedChecksum) {
        throw Object.assign(new Error(`Checksum is missing for ${release.asset.name}.`), { code: 'checksum_missing' });
      }
      const actualChecksum = createHash('sha256').update(archive).digest('hex');
      if (actualChecksum !== expectedChecksum.toLowerCase()) {
        throw Object.assign(new Error(`Checksum mismatch for ${release.asset.name}.`), { code: 'checksum_mismatch' });
      }
      await input.writeArchive(input.stagingArchivePath, archive);
      return { version: release.version, archivePath: input.stagingArchivePath };
    }
  };
}

async function downloadBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetchResponse(fetchImpl, url);
  if (!response.ok) {
    throw Object.assign(new Error('AXIS CLI download failed.'), { code: 'download_failed' });
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchResponse(fetchImpl, url);
  if (!response.ok) {
    throw Object.assign(new Error('AXIS CLI checksum download failed.'), { code: 'download_failed' });
  }
  return response.text();
}

async function fetchResponse(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw Object.assign(new Error('AXIS CLI release metadata is unavailable.'), {
      code: 'network_unavailable',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
