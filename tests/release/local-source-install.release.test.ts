import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localElectronBuilderArguments } from '../../apps/desktop/scripts/package-local-macos.mjs';
import { validateProductSeed } from '../../scripts/assemble-product-seed.mjs';
import { localProductPreflightArguments } from '../../scripts/install-local-macos.mjs';
import { replaceInstalledApplication } from '../../scripts/local-macos-application.mjs';

describe('local source installation', () => {
  it('packages the local application with ad-hoc signing and the local verification hook', () => {
    expect(localElectronBuilderArguments('arm64')).toEqual([
      '--dir',
      '--mac',
      '--arm64',
      '--publish',
      'never',
      '--config.directories.output=release/local',
      '--config.mac.identity=-',
      '--config.afterSign=scripts/verify-local-macos-app.cjs'
    ]);
  });

  it('exposes separate local installation and strict distribution commands', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));

    expect(rootPackage.scripts.pack).toBeUndefined();
    expect(rootPackage.scripts['pack:local']).toBe('pnpm --filter @debrute/desktop pack:local');
    expect(rootPackage.scripts['install:local']).toBe('pnpm --filter @debrute/desktop install:local');
    expect(rootPackage.scripts.dist).toBe('pnpm --filter @debrute/desktop dist');
    expect(desktopPackage.scripts.pack).toBeUndefined();
    expect(desktopPackage.scripts['pack:local'])
      .toBe('pnpm build && node scripts/package-local-macos.mjs');
    expect(desktopPackage.scripts['install:local'])
      .toBe('pnpm pack:local && node ../../scripts/install-local-macos.mjs');
    expect(desktopPackage.build.afterSign).toBe('scripts/notarize-macos-app.cjs');
  });

  it('delegates immutable Product preflight to the source Runtime', () => {
    expect(localProductPreflightArguments('/tmp/debrute-seed', '/tmp/debrute-products')).toEqual([
      'preflight-desktop-seed',
      '--seed',
      '/tmp/debrute-seed',
      '--product-root',
      '/tmp/debrute-products'
    ]);
  });

  it('rejects Product manifests outside the closed Runtime contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-local-product-contract-'));
    try {
      const seed = join(root, 'seed');
      writeProduct(seed, '0.0.3', 'source');
      const manifestPath = join(seed, 'product-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.unexpectedManifestField = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(validateProductSeed(seed)).rejects.toThrow(
        'Product seed manifest is invalid (root fields)'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Windows arm64 outside the supported Product matrix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-local-product-platform-'));
    try {
      const seed = join(root, 'seed');
      writeProduct(seed, '0.0.3', 'source');
      const manifestPath = join(seed, 'product-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.platform = 'windows';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(validateProductSeed(seed)).rejects.toThrow(
        'Product seed manifest is invalid (platform architecture)'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies a staged application before replacing the installed application', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-local-application-'));
    try {
      const source = join(root, 'build/Debrute.app');
      const applicationsDirectory = join(root, 'Applications');
      const installed = join(applicationsDirectory, 'Debrute.app');
      mkdirSync(source, { recursive: true });
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(source, 'version.txt'), 'new-source');
      writeFileSync(join(installed, 'version.txt'), 'old-installed');
      mkdirSync(join(source, 'Contents/Frameworks/Test.framework/Versions/A'), { recursive: true });
      symlinkSync('A', join(source, 'Contents/Frameworks/Test.framework/Versions/Current'));
      const verified: string[] = [];

      await replaceInstalledApplication({
        sourceApplication: source,
        applicationsDirectory,
        verifyApplication: async (application) => {
          verified.push(application);
          expect(readFileSync(join(application, 'version.txt'), 'utf8')).toBe('new-source');
          expect(readlinkSync(join(
            application,
            'Contents/Frameworks/Test.framework/Versions/Current'
          ))).toBe('A');
        }
      });

      expect(verified).toHaveLength(1);
      expect(verified[0]).not.toBe(installed);
      expect(readFileSync(join(installed, 'version.txt'), 'utf8')).toBe('new-source');
      expect(readlinkSync(join(
        installed,
        'Contents/Frameworks/Test.framework/Versions/Current'
      ))).toBe('A');
      expect(readdirSync(applicationsDirectory)).toEqual(['Debrute.app']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeProduct(directory: string, version: string, payload: string): void {
  const entrypoints = {
    runtime: 'runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime',
    web: 'web/index.html',
    cli: 'runtime/debrute',
    skills: 'skills/debrute-core/SKILL.md',
    modelDocs: 'model-docs/models.json',
    nativeWorkers: 'native-workers/manifest.json'
  };
  const contents = new Map([
    [entrypoints.runtime, `runtime-${payload}`],
    [entrypoints.web, `web-${payload}`],
    [entrypoints.cli, `cli-${payload}`],
    [entrypoints.skills, `skills-${payload}`],
    [entrypoints.modelDocs, `models-${payload}`],
    [entrypoints.nativeWorkers, `workers-${payload}`],
    ['payload.txt', payload]
  ]);
  for (const [path, content] of contents) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  chmodSync(join(directory, entrypoints.runtime), 0o755);
  chmodSync(join(directory, entrypoints.cli), 0o755);
  const files = [...contents.entries()].map(([path, content]) => {
    const bytes = Buffer.from(content);
    return {
      path,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(directory, 'product-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'debrute',
    productVersion: version,
    controlProtocol: 'debrute-control',
    controlProtocolVersion: 2,
    platform: 'macos',
    architecture: process.arch,
    entrypoints,
    files
  }, null, 2)}\n`);
}
