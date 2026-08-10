import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { archiveProductSeed } from '../../scripts/archive-product-seed.mjs';
import { assembleProductSeed } from '../../scripts/assemble-product-seed.mjs';
import { CANVAS_VIDEO_TOOLS_LOCK } from '../../scripts/canvas-video-tools-payload.mjs';

describe('desktop fresh install product payload', () => {
  it('requires an explicit Web root before changing the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-product-web-root-'));
    try {
      const destination = join(root, 'product-seed');
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'sentinel'), 'preserved');

      await expect(assembleProductSeed({
        workspaceRoot: root,
        platform: 'darwin',
        architecture: 'arm64',
        destination
      })).rejects.toThrow('Product Web root is required.');

      expect(readFileSync(join(destination, 'sentinel'), 'utf8')).toBe('preserved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates the Product platform before changing the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-product-platform-'));
    try {
      const destination = join(root, 'product-seed');
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'sentinel'), 'preserved');

      await expect(assembleProductSeed({
        workspaceRoot: root,
        webRoot: join(root, 'apps/web/dist'),
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
      mkdirSync(join(root, 'target/release/canvas-video-tools'), { recursive: true });
      mkdirSync(join(root, 'apps/web/dist'), { recursive: true });
      mkdirSync(join(root, 'apps/desktop/dist-electron/product-seed/web/assets'), { recursive: true });
      mkdirSync(join(root, 'apps/desktop/build'), { recursive: true });
      mkdirSync(join(root, 'skills/debrute-core'), { recursive: true });
      mkdirSync(join(root, 'apps/runtime/src/control'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}');
      writeFileSync(join(root, 'target/release/debrute-runtime'), 'runtime');
      writeFileSync(join(root, 'target/release/debrute'), 'cli');
      writeFileSync(join(root, 'apps/desktop/build/icon.icns'), 'icon');
      writeFileSync(join(root, 'target/release/native-raster/libvips.42.dylib'), 'libvips');
      writeFileSync(join(root, 'target/release/native-raster/LICENSE'), 'license');
      writeFileSync(join(root, 'target/release/native-raster/THIRD-PARTY-NOTICES.md'), 'notices');
      writeFileSync(join(root, 'target/release/native-raster/versions.json'), '{"vips":"8.18.4"}');
      writeCanvasVideoToolsFixture(join(root, 'target/release/canvas-video-tools'));
      chmodSync(join(root, 'target/release/canvas-video-tools/ffmpeg'), 0o755);
      chmodSync(join(root, 'target/release/canvas-video-tools/ffprobe'), 0o755);
      chmodSync(join(root, 'target/release/debrute-runtime'), 0o755);
      chmodSync(join(root, 'target/release/debrute'), 0o755);
      writeFileSync(join(root, 'apps/web/dist/index.html'), '<!doctype html>');
      writeFileSync(join(root, 'apps/desktop/dist-electron/product-seed/web/assets/stale-hash.js'), 'stale');
      writeFileSync(join(root, 'skills/debrute-core/SKILL.md'), '---\nname: debrute-core\n---\n');
      writeFileSync(join(root, 'apps/runtime/src/control/protocol.rs'), [
        'pub const CONTROL_PROTOCOL: &str = "debrute-control";',
        'pub const CONTROL_PROTOCOL_VERSION: u32 = 1;'
      ].join('\n'));

      const assembled = await assembleProductSeed({
        workspaceRoot: root,
        webRoot: join(root, 'apps/web/dist'),
        platform: 'darwin',
        architecture: 'arm64'
      });
      expect(existsSync(join(assembled.destination, 'web/assets/stale-hash.js'))).toBe(false);
      expect(assembled.manifest?.entrypoints).toEqual({
        runtime: 'runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime',
        cli: 'runtime/debrute',
        web: 'web/index.html',
        skills: 'skills/debrute-core/SKILL.md',
        nativeWorkers: 'native-workers/manifest.json'
      });
      expect(assembled.manifest?.schemaVersion).toBe(2);
      expect(assembled.manifest?.runtimeDependencies).toEqual({
        canvasVideo: {
          ffmpeg: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/ffmpeg',
          ffprobe: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/ffprobe',
          license: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/LICENSE',
          notices: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/THIRD-PARTY-NOTICES.md',
          buildConfig: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/BUILD-CONFIG.txt',
          sourceNotice: 'runtime/Debrute Runtime.app/Contents/Resources/canvas-video-tools/SOURCE.md'
        }
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

function writeCanvasVideoToolsFixture(root: string): void {
  const contents = new Map([
    ['ffmpeg', 'ffmpeg'],
    ['ffprobe', 'ffprobe'],
    ['LICENSE', 'license'],
    ['THIRD-PARTY-NOTICES.md', 'notices'],
    ['SOURCE.md', 'source'],
    ['BUILD-CONFIG.txt', 'config']
  ]);
  for (const [name, value] of contents) writeFileSync(join(root, name), value);
  const files = [...contents].map(([path, value]) => ({
    path,
    sizeBytes: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex')
  })).sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(root, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    payloadRevision: CANVAS_VIDEO_TOOLS_LOCK.payloadRevision,
    ffmpegVersion: CANVAS_VIDEO_TOOLS_LOCK.ffmpegVersion,
    platform: 'macos',
    architecture: 'arm64',
    sourceSha256: CANVAS_VIDEO_TOOLS_LOCK.source.sha256,
    configureArguments: CANVAS_VIDEO_TOOLS_LOCK.configureArguments,
    files
  }, null, 2)}\n`);
}
