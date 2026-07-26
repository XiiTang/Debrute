import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LIBVIPS_VERSION,
  NATIVE_RASTER_PAYLOAD_LOCK,
  nativeRasterTargetLock,
  validateNativeRasterPayload
} from '../../scripts/native-raster-payload.mjs';

describe('native raster payload', () => {
  it('locks one archive and the same explicit format surface for every supported target', () => {
    expect(NATIVE_RASTER_PAYLOAD_LOCK).toMatchObject({
      schemaVersion: 1,
      payloadRevision: 3,
      rsVipsVersion: '0.7.0',
      libvipsVersion: '8.18.4',
      rasterFormats: ['jpeg', 'png', 'webp', 'avif', 'tiff']
    });
    expect(Object.keys(NATIVE_RASTER_PAYLOAD_LOCK.targets).sort()).toEqual([
      'macos-arm64',
      'macos-x64',
      'windows-x64'
    ]);
    for (const identity of Object.keys(NATIVE_RASTER_PAYLOAD_LOCK.targets)) {
      const target = nativeRasterTargetLock(identity);
      expect(target.url).toMatch(/^https:\/\//);
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(target.archiveFormat).toMatch(/^(nupkg|zip)$/);
    }
    expect(() => nativeRasterTargetLock('freebsd-x64')).toThrow('unsupported');
  });

  it('owns the complete Windows rs-vips import-library closure', () => {
    expect(nativeRasterTargetLock('windows-x64').importLibraryPaths).toEqual([
      'vips-dev-8.18/lib/libvips.lib',
      'vips-dev-8.18/lib/libglib-2.0.lib',
      'vips-dev-8.18/lib/libgobject-2.0.lib'
    ]);

    const runtimeBuild = readFileSync(join(process.cwd(), 'apps/runtime/build.rs'), 'utf8');
    expect(runtimeBuild).toContain('cargo::rustc-link-lib=dylib=libglib-2.0');
    expect(runtimeBuild).toContain('cargo::rustc-link-lib=dylib=libgobject-2.0');
  });

  it('rejects an incomplete target link-library closure', async () => {
    const root = fixture();
    try {
      const path = join(root, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        linkFiles: Array<{ path: string }>;
      };
      const removed = manifest.linkFiles.pop();
      if (!removed) throw new Error('Fixture must declare target link libraries.');
      rmSync(join(root, removed.path));
      writeFileSync(path, `${JSON.stringify(manifest)}\n`);

      await expect(validateNativeRasterPayload({ root })).rejects.toThrow('identity is invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only the exact platform payload with a closed checksum inventory', async () => {
    const root = fixture();
    try {
      const payload = await validateNativeRasterPayload({ root });
      expect(payload.manifest.libvipsVersion).toBe('8.18.4');
      expect(payload.manifest.rasterFormats).toEqual(NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats);

      writeFileSync(join(root, 'runtime/libc++.dll'), 'changed');
      await expect(validateNativeRasterPayload({ root })).rejects.toThrow('checksum does not match');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a prepared payload for a different target or libvips version', async () => {
    for (const mutation of [
      (manifest: Record<string, unknown>) => {
        manifest.architecture = process.arch === 'arm64' ? 'x64' : 'arm64';
      },
      (manifest: Record<string, unknown>) => {
        manifest.libvipsVersion = '8.18.3';
      }
    ]) {
      const root = fixture();
      try {
        const path = join(root, 'manifest.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        mutation(manifest);
        writeFileSync(path, `${JSON.stringify(manifest)}\n`);
        await expect(validateNativeRasterPayload({ root })).rejects.toThrow('identity is invalid');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects a payload outside the fixed link directory', async () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'alternate'));
      const path = join(root, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        linkDirectory: string;
        linkFiles: Array<{ path: string }>;
      };
      const linkName = manifest.linkFiles[0].path.slice('link/'.length);
      copyFileSync(join(root, manifest.linkFiles[0].path), join(root, 'alternate', linkName));
      manifest.linkDirectory = 'alternate';
      writeFileSync(path, `${JSON.stringify(manifest)}\n`);

      await expect(validateNativeRasterPayload({ root })).rejects.toThrow('identity is invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects files declared outside their fixed payload directories', async () => {
    const root = fixture();
    try {
      copyFileSync(join(root, 'runtime/libc++.dll'), join(root, 'link/libc++.dll'));
      const path = join(root, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        runtimeFiles: Array<Record<string, unknown>>;
        linkFiles: Array<Record<string, unknown>>;
      };
      const runtimeFile = manifest.runtimeFiles[0];
      const linkFile = manifest.linkFiles[0];
      const linkName = String(linkFile.path).slice('link/'.length);
      copyFileSync(join(root, String(linkFile.path)), join(root, 'runtime', linkName));
      manifest.runtimeFiles = [
        { ...runtimeFile, path: 'link/libc++.dll' },
        linkFile
      ];
      manifest.linkFiles = [
        runtimeFile,
        { ...linkFile, path: `runtime/${linkName}` }
      ];
      writeFileSync(path, `${JSON.stringify(manifest)}\n`);

      await expect(validateNativeRasterPayload({ root })).rejects.toThrow('declaration is invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an absolute path', '/runtime/libc++.dll'],
    ['a nested path', 'runtime/nested/libc++.dll'],
    ['a backslash path', 'runtime\\libc++.dll'],
    ['a traversal path', 'runtime/../libc++.dll']
  ])('rejects %s', async (_case, invalidPath) => {
    const root = fixture();
    try {
      const path = join(root, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        runtimeFiles: Array<Record<string, unknown>>;
      };
      manifest.runtimeFiles[0].path = invalidPath;
      writeFileSync(path, `${JSON.stringify(manifest)}\n`);

      await expect(validateNativeRasterPayload({ root })).rejects.toThrow('declaration is invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'debrute-native-raster-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'link'), { recursive: true });
  const runtime = Buffer.from('runtime');
  const link = Buffer.from('link');
  writeFileSync(join(root, 'runtime/libc++.dll'), runtime);
  const linkNames = process.platform === 'win32'
    ? ['libvips.lib', 'libglib-2.0.lib', 'libgobject-2.0.lib']
    : ['libvips.dylib', 'libglib-2.0.dylib', 'libgobject-2.0.dylib'];
  for (const name of linkNames) writeFileSync(join(root, 'link', name), link);
  const file = (path: string, bytes: Buffer) => ({
    path,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    payloadRevision: NATIVE_RASTER_PAYLOAD_LOCK.payloadRevision,
    libvipsVersion: LIBVIPS_VERSION,
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    architecture: process.arch,
    sourceArchiveSha256: nativeRasterTargetLock().sha256,
    rasterFormats: NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats,
    linkDirectory: 'link',
    runtimeFiles: [file('runtime/libc++.dll', runtime)],
    linkFiles: linkNames.map((name) => file(`link/${name}`, link))
  })}\n`);
  return root;
}
