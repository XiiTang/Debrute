import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      payloadRevision: 2,
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
    expect(() => nativeRasterTargetLock('linux-x64')).toThrow('unsupported');
  });

  it('accepts only the exact platform payload with a closed checksum inventory', async () => {
    const root = fixture();
    try {
      const payload = await validateNativeRasterPayload({ root });
      expect(payload.manifest.libvipsVersion).toBe('8.18.4');
      expect(payload.manifest.rasterFormats).toEqual(NATIVE_RASTER_PAYLOAD_LOCK.rasterFormats);

      writeFileSync(join(root, 'runtime/libvips.test'), 'changed');
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
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'debrute-native-raster-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'link'), { recursive: true });
  const runtime = Buffer.from('runtime');
  const link = Buffer.from('link');
  writeFileSync(join(root, 'runtime/libvips.test'), runtime);
  writeFileSync(join(root, 'link/libvips.test'), link);
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
    runtimeFiles: [file('runtime/libvips.test', runtime)],
    linkFiles: [file('link/libvips.test', link)]
  })}\n`);
  return root;
}
