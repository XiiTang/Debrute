import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  axisCliPayloadEntries,
  axisCliArchiveName,
  axisCliPkgFlags,
  axisCliReleaseTargets,
  checksumManifestName,
  resolveNodeModulePackageRoot
} from '../scripts/package-axis-cli.mjs';
import {
  desktopReleaseAssetName,
  expectedReleaseAssets
} from '../scripts/release-asset-contract.mjs';

describe('Axis CLI release packaging', () => {
  it('uses the public release asset naming contract', () => {
    expect(axisCliReleaseTargets.map((target) => axisCliArchiveName('0.2.0', target))).toEqual([
      'axis-cli-0.2.0-macos-arm64.tar.gz',
      'axis-cli-0.2.0-macos-x64.tar.gz',
      'axis-cli-0.2.0-linux-arm64.tar.gz',
      'axis-cli-0.2.0-linux-x64.tar.gz',
      'axis-cli-0.2.0-windows-arm64.zip',
      'axis-cli-0.2.0-windows-x64.zip'
    ]);
    expect(checksumManifestName).toBe('axis_SHA256SUMS');
  });

  it('packages CLI releases without target-architecture bytecode execution', () => {
    expect(axisCliPkgFlags).toContain('--public');
    expect(axisCliPkgFlags).toContain('--no-bytecode');
  });

  it('builds workspace references before packaging web assets', () => {
    const packagingScript = readFileSync(join(process.cwd(), 'scripts/package-axis-cli.mjs'), 'utf8');
    const workspaceBuild = "['check']";
    const webBuild = "['--filter', '@axis/web', 'build']";

    expect(packagingScript).toContain(workspaceBuild);
    expect(packagingScript.indexOf(workspaceBuild)).toBeLessThan(packagingScript.indexOf(webBuild));
  });

  it('resolves payload packages from pnpm hoisted node_modules', () => {
    const root = join(tmpdir(), `axis-pnpm-hoist-${process.pid}-${Date.now()}`);
    const packageRoot = join(root, 'node_modules', '.pnpm', 'node_modules', '@img', 'sharp-darwin-x64');
    mkdirSync(packageRoot, { recursive: true });
    try {
      expect(resolveNodeModulePackageRoot(root, '@img/sharp-darwin-x64')).toBe(packageRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defines the full GitHub Release asset contract', () => {
    expect(desktopReleaseAssetName('0.2.0', 'macos', 'arm64', 'dmg')).toBe('axis-desktop-0.2.0-macos-arm64.dmg');
    expect(expectedReleaseAssets('0.2.0')).toEqual([
      'axis-desktop-0.2.0-macos-arm64.dmg',
      'axis-desktop-0.2.0-macos-x64.dmg',
      'axis-desktop-0.2.0-windows-x64.exe',
      'axis-desktop-0.2.0-linux-x64.AppImage',
      'axis-cli-0.2.0-macos-arm64.tar.gz',
      'axis-cli-0.2.0-macos-x64.tar.gz',
      'axis-cli-0.2.0-linux-arm64.tar.gz',
      'axis-cli-0.2.0-linux-x64.tar.gz',
      'axis-cli-0.2.0-windows-arm64.zip',
      'axis-cli-0.2.0-windows-x64.zip',
      'axis_SHA256SUMS'
    ]);
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

  it('uses the actual sharp Windows native package layout', () => {
    const windowsX64Target = axisCliReleaseTargets.find((target) => target.id === 'windows-x64');
    expect(windowsX64Target).toBeDefined();
    const entries = axisCliPayloadEntries('/repo', windowsX64Target!);
    expect(entries.map((entry) => entry.to)).toContain('node_modules/@img/sharp-win32-x64');
    expect(entries.map((entry) => entry.to)).not.toContain('node_modules/@img/sharp-libvips-win32-x64');
  });

  it('keeps Desktop packages free of CLI binaries and Skills bundles', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
    const extraResources = JSON.stringify(packageJson.build.extraResources ?? []);
    expect(extraResources).not.toContain('axis-cli');
    expect(extraResources).not.toContain('skills');
    expect(packageJson.build.publish).toBeUndefined();
  });
});
