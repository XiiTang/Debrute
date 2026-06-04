import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  axisCliPayloadEntries,
  axisCliArchiveName,
  axisCliReleaseTargets,
  checksumManifestName
} from '../scripts/package-axis-cli.mjs';

describe('Axis CLI release packaging', () => {
  it('uses the public release asset naming contract', () => {
    expect(axisCliReleaseTargets.map((target) => axisCliArchiveName('0.2.0', target))).toEqual([
      'axis-cli-0.2.0-darwin-arm64.tar.gz',
      'axis-cli-0.2.0-darwin-x64.tar.gz',
      'axis-cli-0.2.0-linux-arm64.tar.gz',
      'axis-cli-0.2.0-linux-x64.tar.gz',
      'axis-cli-0.2.0-windows-arm64.zip',
      'axis-cli-0.2.0-windows-x64.zip'
    ]);
    expect(checksumManifestName).toBe('axis-cli_SHA256SUMS');
  });

  it('includes skills and web dist payload entries', () => {
    expect(axisCliPayloadEntries('/repo', axisCliReleaseTargets[0])).toEqual([
      { from: '/repo/skills', to: 'skills', recursive: true },
      { from: '/repo/apps/web/dist', to: 'web', recursive: true },
      { from: '/repo/node_modules/sharp', to: 'node_modules/sharp', recursive: true, dereference: true, excludeNestedNodeModules: true },
      { from: '/repo/node_modules/@img/colour', to: 'node_modules/@img/colour', recursive: true, dereference: true },
      { from: '/repo/node_modules/detect-libc', to: 'node_modules/detect-libc', recursive: true, dereference: true },
      { from: '/repo/node_modules/semver', to: 'node_modules/semver', recursive: true, dereference: true },
      { from: '/repo/node_modules/@img/sharp-darwin-arm64', to: 'node_modules/@img/sharp-darwin-arm64', recursive: true, dereference: true },
      { from: '/repo/node_modules/@img/sharp-libvips-darwin-arm64', to: 'node_modules/@img/sharp-libvips-darwin-arm64', recursive: true, dereference: true }
    ]);
  });

  it('keeps Desktop packages free of CLI binaries and Skills bundles and publishes from the public AXIS repo', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
    const extraResources = JSON.stringify(packageJson.build.extraResources ?? []);
    expect(extraResources).not.toContain('axis-cli');
    expect(extraResources).not.toContain('skills');
    expect(packageJson.build.publish).toEqual([{
      provider: 'github',
      owner: 'XiiTang',
      repo: 'AXIS',
      releaseType: 'release'
    }]);
  });
});
