import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  managedCliRuntimePayloadEntries,
  managedCliPkgFlags,
  managedCliRuntimeTargets
} from '../scripts/package-debrute-cli.mjs';
import { nodePtyRuntimePayloadEntries } from '../scripts/node-pty-runtime-payload.mjs';
import {
  desktopReleaseAssetName,
  expectedReleaseAssets
} from '../scripts/release-asset-contract.mjs';
import { resolveNodeModulePackageRoot } from '../scripts/sharp-runtime-payload.mjs';
import photoshopCepViteConfig from '../apps/photoshop-cep-plugin/vite.config';
import photoshopUxpViteConfig from '../apps/photoshop-uxp-plugin/vite.config';

describe('Debrute managed CLI runtime packaging', () => {
  it('does not define public standalone CLI release archives', () => {
    const packagingScript = readFileSync(join(process.cwd(), 'scripts/package-debrute-cli.mjs'), 'utf8');

    expect(packagingScript).not.toContain('release/debrute-cli');
    expect(packagingScript).not.toContain('tar -czf');
    expect(packagingScript).not.toContain('AdmZip');
    expect(expectedReleaseAssets('0.2.0')).toEqual([
      'debrute-desktop-0.2.0-macos-arm64.dmg',
      'debrute-desktop-0.2.0-macos-x64.dmg',
      'debrute-desktop-0.2.0-windows-x64.exe',
      'debrute-desktop-0.2.0-linux-x64.AppImage',
      'debrute_SHA256SUMS'
    ]);
  });

  it('packages managed CLI runtime targets without target-architecture bytecode execution', () => {
    expect(managedCliPkgFlags).toContain('--public');
    expect(managedCliPkgFlags).toContain('--no-bytecode');
    expect(managedCliRuntimeTargets.map((target) => target.pkgTarget)).toEqual([
      'node24-macos-arm64',
      'node24-macos-x64',
      'node24-linux-arm64',
      'node24-linux-x64',
      'node24-win-arm64',
      'node24-win-x64'
    ]);

    const packagingScript = readFileSync(join(process.cwd(), 'scripts/package-debrute-cli.mjs'), 'utf8');
    expect(packagingScript).toContain("target: 'node24'");
    expect(packagingScript).toContain("external: ['node-pty', 'sharp']");
    expect(packagingScript).not.toContain('node22');
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

  it('defines the desktop GitHub Release asset contract', () => {
    expect(desktopReleaseAssetName('0.2.0', 'macos', 'arm64', 'dmg')).toBe('debrute-desktop-0.2.0-macos-arm64.dmg');
    expect(expectedReleaseAssets('0.2.0')).not.toContain('debrute-cli-0.2.0-macos-arm64.tar.gz');
  });

  it('builds Photoshop plugin packages with relative panel asset URLs', () => {
    expect((photoshopUxpViteConfig as { base?: string }).base).toBe('./');
    expect((photoshopCepViteConfig as { base?: string }).base).toBe('./');
  });

  it('includes native runtime payload entries without duplicating desktop web dist', () => {
    const root = createRootWithCliRuntimePackages([
      'sharp',
      '@img/colour',
      'detect-libc',
      'semver',
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    try {
      expect(managedCliRuntimePayloadEntries(root, managedCliRuntimeTargets[0])).toEqual([
        { from: join(root, 'packages/capability-runtime/src/imageModels/officialDocs/snapshots'), to: 'official-docs/imageModels/snapshots', recursive: true, dereference: false },
        { from: join(root, 'packages/capability-runtime/src/videoModels/officialDocs/snapshots'), to: 'official-docs/videoModels/snapshots', recursive: true, dereference: false },
        { from: join(root, 'node_modules/sharp'), to: 'node_modules/sharp', recursive: true, dereference: true, excludeNestedNodeModules: true },
        { from: join(root, 'node_modules/@img/colour'), to: 'node_modules/@img/colour', recursive: true, dereference: true },
        { from: join(root, 'node_modules/detect-libc'), to: 'node_modules/detect-libc', recursive: true, dereference: true },
        { from: join(root, 'node_modules/semver'), to: 'node_modules/semver', recursive: true, dereference: true },
        { from: join(root, 'node_modules/@img/sharp-darwin-arm64'), to: 'node_modules/@img/sharp-darwin-arm64', recursive: true, dereference: true },
        { from: join(root, 'node_modules/@img/sharp-libvips-darwin-arm64'), to: 'node_modules/@img/sharp-libvips-darwin-arm64', recursive: true, dereference: true },
        { from: join(root, 'node_modules/node-pty/package.json'), to: 'node_modules/node-pty/package.json', recursive: false, dereference: true },
        {
          from: join(root, 'node_modules/node-pty/lib'),
          to: 'node_modules/node-pty/lib',
          recursive: true,
          dereference: true,
          filter: expect.any(Function)
        },
        {
          from: join(root, 'node_modules/node-pty/prebuilds/darwin-arm64'),
          to: 'node_modules/node-pty/prebuilds/darwin-arm64',
          recursive: true,
          dereference: true,
          filter: expect.any(Function),
          executable: true,
          executableRelativePath: 'spawn-helper'
        }
      ]);
      expect(managedCliRuntimePayloadEntries(root, managedCliRuntimeTargets[0]).map((entry) => entry.to)).not.toContain('skills');
      expect(managedCliRuntimePayloadEntries(root, managedCliRuntimeTargets[0]).map((entry) => entry.to)).not.toContain('web');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters CLI node-pty payload to the target prebuild and runtime JavaScript files', () => {
    const root = createRootWithCliRuntimePackages([
      'sharp',
      '@img/colour',
      'detect-libc',
      'semver',
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    try {
      const entries = managedCliRuntimePayloadEntries(root, managedCliRuntimeTargets[0]);
      const libEntry = entries.find((entry) => entry.to === 'node_modules/node-pty/lib');
      const prebuildEntry = entries.find((entry) => entry.to === 'node_modules/node-pty/prebuilds/darwin-arm64');

      expect(entries.map((entry) => entry.to)).toContain('node_modules/node-pty/package.json');
      expect(entries.map((entry) => entry.to)).toContain('node_modules/node-pty/lib');
      expect(entries.map((entry) => entry.to)).toContain('node_modules/node-pty/prebuilds/darwin-arm64');
      expect(entries.map((entry) => entry.to)).not.toContain('node_modules/node-pty/prebuilds/darwin-x64');
      expect(prebuildEntry).toMatchObject({ executable: true, executableRelativePath: 'spawn-helper' });
      expect(libEntry?.filter?.(join(root, 'node_modules/node-pty/lib/index.js'))).toBe(true);
      expect(libEntry?.filter?.(join(root, 'node_modules/node-pty/lib/terminal.test.js'))).toBe(false);
      expect(libEntry?.filter?.(join(root, 'node_modules/node-pty/lib/windowsTerminal.js'))).toBe(false);
      expect(prebuildEntry?.filter?.(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node'))).toBe(true);
      expect(prebuildEntry?.filter?.(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'))).toBe(true);
      expect(prebuildEntry?.filter?.(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.pdb'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not require a Linux node-pty spawn helper when node-pty did not build one', () => {
    const root = createRootWithNodePackages(['node-pty']);
    const nodePtyRoot = join(root, 'node_modules/node-pty');
    mkdirSync(join(nodePtyRoot, 'lib'), { recursive: true });
    mkdirSync(join(nodePtyRoot, 'build/Release'), { recursive: true });
    writeFileSync(join(nodePtyRoot, 'package.json'), '{}');
    writeFileSync(join(nodePtyRoot, 'lib/index.js'), '');
    writeFileSync(join(nodePtyRoot, 'build/Release/pty.node'), '');
    try {
      const linuxX64Target = managedCliRuntimeTargets.find((target) => target.id === 'linux-x64');
      expect(linuxX64Target).toBeDefined();
      const entries = nodePtyRuntimePayloadEntries(root, linuxX64Target!);

      expect(entries.map((entry) => entry.to)).toContain('node_modules/node-pty/build/Release/pty.node');
      expect(entries.map((entry) => entry.to)).not.toContain('node_modules/node-pty/build/Release/spawn-helper');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the actual sharp Windows native package layout', () => {
    const windowsX64Target = managedCliRuntimeTargets.find((target) => target.id === 'windows-x64');
    expect(windowsX64Target).toBeDefined();
    const root = createRootWithCliRuntimePackages([
      'sharp',
      '@img/colour',
      'detect-libc',
      'semver',
      '@img/sharp-win32-x64'
    ]);
    try {
      const entries = managedCliRuntimePayloadEntries(root, windowsX64Target!);
      expect(entries.map((entry) => entry.to)).toContain('node_modules/@img/sharp-win32-x64');
      expect(entries.map((entry) => entry.to)).not.toContain('node_modules/@img/sharp-libvips-win32-x64');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies sharp runtime dependencies into Desktop app resources', async () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
    expect(packageJson.build.afterPack).toBe('scripts/package-sharp-runtime.mjs');

    const hookPath = join(process.cwd(), 'apps/desktop', packageJson.build.afterPack);
    expect(existsSync(hookPath)).toBe(true);

    const hook = await import(pathToFileURL(hookPath).href) as {
      default: (context: {
        appOutDir: string;
        electronPlatformName: string;
        arch: number;
        packager: { appInfo: { productFilename: string } };
      }) => Promise<void>;
    };
    const root = join(tmpdir(), `debrute-desktop-sharp-${process.pid}-${Date.now()}`);
    try {
      await hook.default({
        appOutDir: join(root, 'out'),
        electronPlatformName: 'darwin',
        arch: 3,
        packager: { appInfo: { productFilename: 'Debrute' } }
      });

      expect(existsSync(join(root, 'out', 'Debrute.app', 'Contents', 'Resources', 'node_modules', 'sharp'))).toBe(true);
      expect(existsSync(join(root, 'out', 'Debrute.app', 'Contents', 'Resources', 'node_modules', '@img', 'sharp-darwin-arm64'))).toBe(true);
      expect(existsSync(join(root, 'out', 'Debrute.app', 'Contents', 'Resources', 'node_modules', '@img', 'sharp-libvips-darwin-arm64'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createRootWithNodePackages(packageNames: string[]) {
  const root = join(tmpdir(), `debrute-packaging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  for (const packageName of packageNames) {
    mkdirSync(join(root, 'node_modules', ...packageName.split('/')), { recursive: true });
  }
  return root;
}

function createRootWithCliRuntimePackages(packageNames: string[]) {
  const root = createRootWithNodePackages([...packageNames, 'node-pty']);
  const nodePtyRoot = join(root, 'node_modules/node-pty');
  mkdirSync(join(nodePtyRoot, 'lib'), { recursive: true });
  mkdirSync(join(nodePtyRoot, 'prebuilds/darwin-arm64'), { recursive: true });
  mkdirSync(join(nodePtyRoot, 'prebuilds/darwin-x64'), { recursive: true });
  writeFileSync(join(nodePtyRoot, 'package.json'), '{}');
  writeFileSync(join(nodePtyRoot, 'lib/index.js'), '');
  writeFileSync(join(nodePtyRoot, 'lib/terminal.test.js'), '');
  writeFileSync(join(nodePtyRoot, 'lib/windowsTerminal.js'), '');
  writeFileSync(join(nodePtyRoot, 'prebuilds/darwin-arm64/pty.node'), '');
  writeFileSync(join(nodePtyRoot, 'prebuilds/darwin-arm64/spawn-helper'), '');
  writeFileSync(join(nodePtyRoot, 'prebuilds/darwin-arm64/pty.pdb'), '');
  writeFileSync(join(nodePtyRoot, 'prebuilds/darwin-x64/pty.node'), '');
  return root;
}
