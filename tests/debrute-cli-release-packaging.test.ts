import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  debruteCliPayloadEntries,
  debruteCliArchiveName,
  debruteCliPkgFlags,
  debruteCliReleaseTargets,
  checksumManifestName,
  resolveNodeModulePackageRoot
} from '../scripts/package-debrute-cli.mjs';
import {
  desktopReleaseAssetName,
  expectedReleaseAssets
} from '../scripts/release-asset-contract.mjs';

describe('Debrute CLI release packaging', () => {
  it('uses the public release asset naming contract', () => {
    expect(debruteCliReleaseTargets.map((target) => debruteCliArchiveName('0.2.0', target))).toEqual([
      'debrute-cli-0.2.0-macos-arm64.tar.gz',
      'debrute-cli-0.2.0-macos-x64.tar.gz',
      'debrute-cli-0.2.0-linux-arm64.tar.gz',
      'debrute-cli-0.2.0-linux-x64.tar.gz',
      'debrute-cli-0.2.0-windows-arm64.zip',
      'debrute-cli-0.2.0-windows-x64.zip'
    ]);
    expect(checksumManifestName).toBe('debrute_SHA256SUMS');
  });

  it('packages CLI releases without target-architecture bytecode execution', () => {
    expect(debruteCliPkgFlags).toContain('--public');
    expect(debruteCliPkgFlags).toContain('--no-bytecode');
  });

  it('builds workspace references before packaging web assets', () => {
    const packagingScript = readFileSync(join(process.cwd(), 'scripts/package-debrute-cli.mjs'), 'utf8');
    const workspaceBuild = "['check']";
    const webBuild = "['--filter', '@debrute/web', 'build']";

    expect(packagingScript).toContain(workspaceBuild);
    expect(packagingScript.indexOf(workspaceBuild)).toBeLessThan(packagingScript.indexOf(webBuild));
  });

  it('resolves payload packages from pnpm hoisted node_modules', () => {
    const root = join(tmpdir(), `debrute-pnpm-hoist-${process.pid}-${Date.now()}`);
    const packageRoot = join(root, 'node_modules', '.pnpm', 'node_modules', '@img', 'sharp-darwin-x64');
    mkdirSync(packageRoot, { recursive: true });
    try {
      expect(resolveNodeModulePackageRoot(root, '@img/sharp-darwin-x64')).toBe(packageRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defines the full GitHub Release asset contract', () => {
    expect(desktopReleaseAssetName('0.2.0', 'macos', 'arm64', 'dmg')).toBe('debrute-desktop-0.2.0-macos-arm64.dmg');
    expect(expectedReleaseAssets('0.2.0')).toEqual([
      'debrute-desktop-0.2.0-macos-arm64.dmg',
      'debrute-desktop-0.2.0-macos-x64.dmg',
      'debrute-desktop-0.2.0-windows-x64.exe',
      'debrute-desktop-0.2.0-linux-x64.AppImage',
      'debrute-cli-0.2.0-macos-arm64.tar.gz',
      'debrute-cli-0.2.0-macos-x64.tar.gz',
      'debrute-cli-0.2.0-linux-arm64.tar.gz',
      'debrute-cli-0.2.0-linux-x64.tar.gz',
      'debrute-cli-0.2.0-windows-arm64.zip',
      'debrute-cli-0.2.0-windows-x64.zip',
      'debrute_SHA256SUMS'
    ]);
  });

  it('includes skills and web dist payload entries', () => {
    expect(debruteCliPayloadEntries('/repo', debruteCliReleaseTargets[0])).toEqual([
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
    const windowsX64Target = debruteCliReleaseTargets.find((target) => target.id === 'windows-x64');
    expect(windowsX64Target).toBeDefined();
    const entries = debruteCliPayloadEntries('/repo', windowsX64Target!);
    expect(entries.map((entry) => entry.to)).toContain('node_modules/@img/sharp-win32-x64');
    expect(entries.map((entry) => entry.to)).not.toContain('node_modules/@img/sharp-libvips-win32-x64');
  });

  it('keeps Desktop packages free of CLI binaries and Skills bundles', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
    const extraResources = JSON.stringify(packageJson.build.extraResources ?? []);
    expect(extraResources).not.toContain('debrute-cli');
    expect(extraResources).not.toContain('skills');
    expect(packageJson.build.publish).toBeUndefined();
  });
});
