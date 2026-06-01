import { describe, expect, it } from 'vitest';
import {
  createGitHubAxisCliReleaseClient,
  parseAxisCliChecksums,
  resolveAxisCliRelease
} from '../apps/desktop/src/electron/axis-cli/axisCliReleaseClient';

describe('Axis CLI release client', () => {
  it('selects only the fixed asset for the current target', async () => {
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.3.0',
        assets: [{
          name: 'axis-cli-0.3.0-darwin-arm64.tar.gz',
          browser_download_url: 'https://github.com/XiiTang/AXIS/releases/download/v0.3.0/axis-cli-0.3.0-darwin-arm64.tar.gz'
        }, {
          name: 'axis-cli_SHA256SUMS',
          browser_download_url: 'https://github.com/XiiTang/AXIS/releases/download/v0.3.0/axis-cli_SHA256SUMS'
        }]
      })
    }) as Response;

    const release = await resolveAxisCliRelease({
      fetch,
      target: { id: 'darwin-arm64', executableName: 'axis', archiveExtension: 'tar.gz' }
    });

    expect(release.version).toBe('0.3.0');
    expect(release.asset.name).toBe('axis-cli-0.3.0-darwin-arm64.tar.gz');
    expect(release.checksumsAsset.name).toBe('axis-cli_SHA256SUMS');
    expect(fetch).toBeDefined();
  });

  it('parses checksums by asset filename', () => {
    expect(parseAxisCliChecksums('abc123  axis-cli-0.3.0-darwin-arm64.tar.gz\n')).toEqual(new Map([
      ['axis-cli-0.3.0-darwin-arm64.tar.gz', 'abc123']
    ]));
  });

  it('reports latest-version network failures instead of silently swallowing them', async () => {
    const client = createGitHubAxisCliReleaseClient(async () => {
      throw new Error('offline');
    });

    await expect(client.getLatestVersion()).rejects.toMatchObject({ code: 'network_unavailable' });
  });
});
