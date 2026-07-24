import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { archiveProductSeed } from '../../scripts/archive-product-seed.mjs';
import { assembleProductSeed } from '../../scripts/assemble-product-seed.mjs';

describe('desktop fresh install product payload', () => {
  it('validates the Product platform before changing the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-product-platform-'));
    try {
      const destination = join(root, 'product-seed');
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'sentinel'), 'preserved');

      await expect(assembleProductSeed({
        workspaceRoot: root,
        platform: 'freebsd',
        architecture: 'x64',
        destination
      })).rejects.toThrow('Unsupported Product platform: freebsd');

      expect(readFileSync(join(destination, 'sentinel'), 'utf8')).toBe('preserved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')) as {
    build?: {
      asar?: unknown;
      asarUnpack?: unknown;
      files?: unknown;
      extraResources?: unknown;
    };
  };

  it('keeps runtime product files outside app.asar for process execution and materialization', () => {
    expect(desktopPackage.build?.asar).toBe(true);
    expect(desktopPackage.build?.asarUnpack).toEqual([]);
    expect(desktopPackage.build?.extraResources).toEqual([{
      from: 'dist-electron/product-seed',
      to: 'product-seed'
    }]);
    expect(desktopPackage.build?.files).toEqual([
      'dist-electron/**/*',
      '!dist-electron/product-seed/**/*',
      '!dist-electron/**/*.map',
      'package.json'
    ]);
  });

  it('hashes every declared seed file and rejects undeclared runtime baggage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-product-seed-'));
    try {
      mkdirSync(join(root, 'target/release'), { recursive: true });
      mkdirSync(join(root, 'target/release/native-raster'), { recursive: true });
      mkdirSync(join(root, 'apps/web/dist'), { recursive: true });
      mkdirSync(join(root, 'apps/desktop/dist-electron/product-seed/web/assets'), { recursive: true });
      mkdirSync(join(root, 'apps/desktop/build'), { recursive: true });
      mkdirSync(join(root, 'skills/debrute-core'), { recursive: true });
      mkdirSync(join(root, 'assets/model-docs/snapshots/image'), { recursive: true });
      mkdirSync(join(root, 'assets/model-docs/snapshots/video'), { recursive: true });
      mkdirSync(join(root, 'assets/model-docs/snapshots/audio'), { recursive: true });
      mkdirSync(join(root, 'apps/runtime/src/control'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}');
      writeFileSync(join(root, 'target/release/debrute-runtime'), 'runtime');
      writeFileSync(join(root, 'target/release/debrute'), 'cli');
      writeFileSync(join(root, 'apps/desktop/build/icon.icns'), 'icon');
      writeFileSync(join(root, 'target/release/native-raster/libvips.42.dylib'), 'libvips');
      writeFileSync(join(root, 'target/release/native-raster/LICENSE'), 'license');
      writeFileSync(join(root, 'target/release/native-raster/THIRD-PARTY-NOTICES.md'), 'notices');
      writeFileSync(join(root, 'target/release/native-raster/versions.json'), '{"vips":"8.18.4"}');
      chmodSync(join(root, 'target/release/debrute-runtime'), 0o755);
      chmodSync(join(root, 'target/release/debrute'), 0o755);
      writeFileSync(join(root, 'apps/web/dist/index.html'), '<!doctype html>');
      writeFileSync(join(root, 'apps/desktop/dist-electron/product-seed/web/assets/stale-hash.js'), 'stale');
      writeFileSync(join(root, 'skills/debrute-core/SKILL.md'), '---\nname: debrute-core\n---\n');
      writeFileSync(join(root, 'assets/runtime-model-catalog.json'), '{}');
      writeFileSync(join(root, 'assets/model-docs/snapshots/image/example.md'), '# Image model\n');
      writeFileSync(join(root, 'assets/model-docs/snapshots/video/example.md'), '# Video model\n');
      writeFileSync(join(root, 'assets/model-docs/snapshots/audio/example.md'), '# Audio model\n');
      writeFileSync(join(root, 'apps/runtime/src/control/protocol.rs'), [
        'pub const CONTROL_PROTOCOL: &str = "debrute-control";',
        'pub const CONTROL_PROTOCOL_VERSION: u32 = 1;'
      ].join('\n'));

      const assembled = await assembleProductSeed({ workspaceRoot: root, platform: 'darwin', architecture: 'arm64' });
      expect(existsSync(join(assembled.destination, 'web/assets/stale-hash.js'))).toBe(false);
      expect(assembled.manifest?.entrypoints).toMatchObject({
        runtime: 'runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime',
        cli: 'runtime/debrute',
        web: 'web/index.html'
      });
      expect(assembled.manifest?.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
      expect(assembled.manifest?.files.map((file) => file.path)).not.toContain('product-manifest.json');
      expect(assembled.manifest?.files.map((file) => file.path))
        .toContain('runtime/Debrute Runtime.app/Contents/libvips/libvips.42.dylib');
      expect(assembled.manifest?.files.map((file) => file.path))
        .toContain('runtime/Debrute Runtime.app/Contents/libvips/LICENSE');
      expect(assembled.manifest?.files.map((file) => file.path))
        .not.toContain('runtime/libvips/libvips.42.dylib');
      expect(assembled.manifest?.files.map((file) => file.path))
        .toContain('runtime/Debrute Runtime.app/Contents/Info.plist');
      const runtimeInfo = readFileSync(
        join(assembled.destination, 'runtime/Debrute Runtime.app/Contents/Info.plist'),
        'utf8'
      );
      expect(runtimeInfo).toContain('<key>LSUIElement</key>');
      const archived = await archiveProductSeed({
        seed: assembled.destination,
        outDir: join(root, 'release'),
        version: '1.2.3',
        platform: 'macos',
        arch: 'arm64'
      });
      const archiveEntries = new AdmZip(archived.assetPath)
        .getEntries()
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.entryName);
      expect(archiveEntries.sort()).toEqual([
        'product-manifest.json',
        ...(assembled.manifest?.files.map((file) => file.path) ?? [])
      ].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
