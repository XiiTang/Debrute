import { reconcileCanvasImagePreviewCache } from '../../../apps/app-server/src/canvas/CanvasImagePreviewCacheCleanup';
import {
  canvasImagePreviewSourceInfo,
  canvasImageSourceRevision,
  createCanvasImagePreviewConcurrencyLimiter,
  createCanvasImagePreviewService
} from '../../../apps/app-server/src/canvas/CanvasImagePreviewService';
import { createCanvasRasterPreviewService, readCanvasRasterPreviewMetadata } from '../../../apps/app-server/src/canvas/CanvasRasterPreviewService';
import { DebruteAppServer } from '../../../apps/app-server/src/server/DebruteAppServer';
import { projectFileRevision, projectRelativePathCacheKey, projectRevisionCacheKey } from '@debrute/project-core';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('canvas image preview active aborts', () => {
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('keeps an active preview generation running for the cache after its last consumer aborts', async () => {
    vi.resetModules();
    const generation = deferred<void>();
    const finishGeneration = deferred<void>();
    let toBufferCalls = 0;
    vi.doMock('sharp', () => ({
      default: () => {
        const api = {
          metadata: async () => ({ width: 800, pages: 1, hasAlpha: false, mediaType: 'image/png' }),
          rotate: () => api,
          resize: () => api,
          jpeg: () => api,
          png: () => api,
          toBuffer: async () => {
            toBufferCalls += 1;
            generation.resolve();
            await finishGeneration.promise;
            return {
              data: Buffer.from('preview-cache-bytes'),
              info: { hasAlpha: false }
            };
          }
        };
        return api;
      }
    }));
    const {
      canvasImageSourceRevision,
      createCanvasImagePreviewService
    } = await import('../../../apps/app-server/src/canvas/CanvasImagePreviewService');
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-active-abort-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), Buffer.alloc(1_600_000, 1));
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const controller = new AbortController();

      const aborted = service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 512,
        abortSignal: controller.signal
      });
      await generation.promise;

      controller.abort();
      await expect(aborted).rejects.toThrow('Canvas image preview request was aborted.');
      finishGeneration.resolve();

      const cached = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 512
      });

      expect(toBufferCalls).toBe(1);
      await expect(readFile(cached.absolutePath, 'utf8')).resolves.toBe('preview-cache-bytes');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('canvas image preview service', () => {
  it('generates dynamic-width local previews and reuses the cache file', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');

      const first = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 300
      });
      const firstStat = await stat(first.absolutePath);
      const firstOutput = await sharp(first.absolutePath).toBuffer({ resolveWithObject: true });
      const second = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 300
      });

      expect(Object.keys(first).sort()).toEqual(['absolutePath']);
      const normalizedPath = first.absolutePath.replaceAll('\\', '/');
      expect(normalizedPath).toMatch(
        /\/\.debrute\/cache\/canvas-image-previews\/images%2Fcover\.png--[a-f0-9]{16}\/[^/]+%3A\d+\/preview-w300\.(jpg|png)$/
      );
      expect(firstOutput.info.width).toBe(300);
      expect(firstOutput.info.height).toBe(150);
      expect(firstOutput.info.hasAlpha).toBe(false);
      expect(second.absolutePath).toBe(first.absolutePath);
      await expect(stat(second.absolutePath)).resolves.toMatchObject({ mtimeMs: firstStat.mtimeMs });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('shares duplicate in-flight requests for the same preview key', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-dedupe-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');

      const [first, second] = await Promise.all([
        service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 777 }),
        service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 777 })
      ]);

      expect(second).toBe(first);
      expect(first.absolutePath).toBe(second.absolutePath);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not let an aborted duplicate consumer cancel a later same-key request', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-dedupe-abort-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const controller = new AbortController();

      const aborted = service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 1024,
        abortSignal: controller.signal
      });
      controller.abort();
      const active = service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 1024
      });

      await expect(aborted).rejects.toThrow('Canvas image preview request was aborted.');
      await expect(active).resolves.toMatchObject({
        absolutePath: expect.stringContaining('/.debrute/cache/canvas-image-previews/')
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates current source metadata before reusing a same-key cache file', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-cache-validated-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      const sourceBytes = await previewablePngBuffer();
      const fixedTime = new Date('2026-01-01T00:00:00.000Z');
      await writeFile(sourcePath, sourceBytes);
      await utimes(sourcePath, fixedTime, fixedTime);
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 300
      });

      await writeFile(sourcePath, Buffer.alloc(sourceBytes.byteLength, 0));
      await utimes(sourcePath, fixedTime, fixedTime);

      await expect(canvasImageSourceRevision(projectRoot, 'images/cover.png')).resolves.toBe(revision);
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 300
      })).rejects.toThrow('Canvas image preview metadata could not be read');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlinked Canvas preview cache hits instead of serving them', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-cache-symlink-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-cache-symlink-external-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const first = await service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 300 });
      await unlink(first.absolutePath);
      await symlink(externalRoot, first.absolutePath, directoryLinkType());

      await expect(service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 300 }))
        .rejects.toThrow('Project path must not be a symbolic link');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-file Canvas preview cache hits', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-cache-directory-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const first = await service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 300 });
      await rm(first.absolutePath, { force: true });
      await mkdir(first.absolutePath, { recursive: true });

      await expect(service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 300 }))
        .rejects.toThrow('Canvas preview cache candidate is not a file');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('limits concurrent Canvas image preview work', async () => {
    const limit = createCanvasImagePreviewConcurrencyLimiter(2);
    const reachedLimit = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let maxActive = 0;

    const pending = Promise.all(Array.from({ length: 8 }, (_item, index) => limit(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) reachedLimit.resolve();
      await release.promise;
      active -= 1;
      return index;
    })));

    await reachedLimit.promise;
    expect(maxActive).toBeLessThanOrEqual(2);
    release.resolve();
    await pending;
  });

  it('cancels queued Canvas image preview work before it starts', async () => {
    const limit = createCanvasImagePreviewConcurrencyLimiter(1);
    const releaseFirst = deferred<void>();
    const first = limit(async () => {
      await releaseFirst.promise;
      return 'first';
    });
    const controller = new AbortController();
    let queuedStarted = false;
    const queued = limit(async () => {
      queuedStarted = true;
      return 'queued';
    }, controller.signal);

    controller.abort();
    releaseFirst.resolve();

    await expect(first).resolves.toBe('first');
    await expect(queued).rejects.toThrow('Canvas image preview request was aborted.');
    expect(queuedStarted).toBe(false);
  });

  it('serves small source images through the Canvas preview pipeline', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-small-source-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/small.png'), await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: '#222244'
        }
      }).png().toBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/small.png');

      const preview = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/small.png',
        revision,
        width: 256
      });
      const metadata = await sharp(preview.absolutePath).metadata();

      expect(preview.absolutePath).toContain('/.debrute/cache/canvas-image-previews/');
      expect(metadata.width).toBe(256);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses a different cache key when the source revision changes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-revision-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      const service = createCanvasImagePreviewService();
      const firstRevision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const first = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision: firstRevision,
        width: 256
      });

      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer(901, 700));
      const secondRevision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const second = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision: secondRevision,
        width: 256
      });

      expect(secondRevision).not.toBe(firstRevision);
      expect(second.absolutePath).not.toBe(first.absolutePath);
      expect(dirname(second.absolutePath)).not.toBe(dirname(first.absolutePath));
      expect(basename(second.absolutePath)).toBe(basename(first.absolutePath));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not write a successful cache file when generation fails', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-failure-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/broken.png'), 'not a png', 'utf8');
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/broken.png');

      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/broken.png',
        revision,
        width: 256
      })).rejects.toThrow();
      await expect(readdir(join(projectRoot, '.debrute/cache/canvas-image-previews'))).rejects.toThrow();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects stale revisions, invalid dynamic widths, unsafe paths, and unsupported image formats', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-reject-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      await writeFile(join(projectRoot, 'images/animated.gif'), 'GIF89a', 'utf8');
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');

      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision: 'stale',
        width: 256
      })).rejects.toThrow('does not match');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 0
      })).rejects.toThrow('Canvas preview width must be a positive integer');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 12.5
      })).rejects.toThrow('Canvas preview width must be a positive integer');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 1025
      })).rejects.toThrow('Canvas preview width exceeds source width');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: '../cover.png',
        revision,
        width: 256
      })).rejects.toThrow('Project path must not contain "." or ".." segments');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/animated.gif',
        revision: await canvasImageSourceRevision(projectRoot, 'images/animated.gif'),
        width: 256
      })).rejects.toThrow('not previewable');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function previewablePngBuffer(width = 1024, height = 512): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: {
      width,
      height,
      channels: 3
    }
  }).png().toBuffer();
}

describe('Canvas image preview cache cleanup', () => {
  it('removes cache directories for missing sources', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-missing-'));
    try {
      const staleSourceKey = projectRelativePathCacheKey('images/missing.png');
      await mkdir(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey, '1000%3A10'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey, '1000%3A10', 'preview-w100.jpg'), 'stale');

      await reconcileCanvasImagePreviewCache({ projectRoot, files: [] });

      await expect(stat(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps only the current revision directory for previewable images', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-revision-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).png().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
      await mkdir(join(sourceCacheRoot, 'old%3A10'), { recursive: true });
      await writeFile(join(sourceCacheRoot, 'old%3A10', 'preview-w32.jpg'), 'old');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(readdir(sourceCacheRoot)).resolves.toEqual([currentRevisionKey]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories for non-previewable project files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-non-preview-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/animated.gif'), 'GIF89a');
      const sourceKey = projectRelativePathCacheKey('images/animated.gif');
      await mkdir(join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey, '1000%3A10'), { recursive: true });

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/animated.gif', kind: 'file' }]
      });

      await expect(stat(join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories when an image path is no longer metadata-previewable', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-unreadable-image-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).png().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
      await writeFile(sourcePath, 'not a png');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(stat(sourceCacheRoot))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories when source path and decoded media type differ', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-media-type-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).jpeg().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(stat(sourceCacheRoot))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

const gzipBuffer = promisify(gzip);

describe('CanvasImagePreviewService image format support', () => {
  it('marks all supported project image formats previewable when sharp can read metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-formats-'));
    try {
      await writeSupportedPreviewFixtures(projectRoot);

      for (const [path, width] of [
        ['assets/cover.png', 64],
        ['assets/photo.jpe', 65],
        ['assets/photo.jfif', 65],
        ['assets/render.webp', 66],
        ['assets/render.avif', 67],
        ['assets/scan.tif', 68],
        ['assets/scan.tiff', 68],
        ['assets/icon.svg', 69],
        ['assets/icon.svgz', 69]
      ] as const) {
        await expect(canvasImagePreviewSourceInfo(projectRoot, path)).resolves.toEqual({
          previewable: true,
          sourceWidth: width
        });
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported image-like formats before reading preview metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-excluded-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/animated.gif'), Buffer.from('GIF89a'));
      await writeFile(join(projectRoot, 'assets/internal.vips'), Buffer.from('vips'));

      await expect(canvasImagePreviewSourceInfo(projectRoot, 'assets/animated.gif')).resolves.toEqual({
        previewable: false
      });
      await expect(canvasImagePreviewSourceInfo(projectRoot, 'assets/internal.vips')).resolves.toEqual({
        previewable: false
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects a supported extension when Sharp reports a different media type', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-media-type-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/cover.png'), await rasterFixture(64, 40).jpeg().toBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'assets/cover.png');

      await expect(canvasImagePreviewSourceInfo(projectRoot, 'assets/cover.png')).resolves.toEqual({
        previewable: false
      });
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'assets/cover.png',
        revision,
        width: 32
      })).rejects.toThrow('Canvas image is not previewable: assets/cover.png');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves a preview for a newly supported AVIF source', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-avif-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/render.avif'), await rasterFixture(80, 48).avif().toBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'assets/render.avif');
      const result = await service.resolve({
        projectRoot,
        projectRelativePath: 'assets/render.avif',
        revision,
        width: 40
      });

      const metadata = await sharp(result.absolutePath).metadata();
      expect(metadata.width).toBe(40);
      expect(['jpeg', 'png']).toContain(metadata.format);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function writeSupportedPreviewFixtures(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await writeFile(join(projectRoot, 'assets/cover.png'), await rasterFixture(64, 40).png().toBuffer());
  await writeFile(join(projectRoot, 'assets/photo.jpe'), await rasterFixture(65, 40).jpeg().toBuffer());
  await writeFile(join(projectRoot, 'assets/photo.jfif'), await rasterFixture(65, 40).jpeg().toBuffer());
  await writeFile(join(projectRoot, 'assets/render.webp'), await rasterFixture(66, 40).webp().toBuffer());
  await writeFile(join(projectRoot, 'assets/render.avif'), await rasterFixture(67, 40).avif().toBuffer());
  await writeFile(join(projectRoot, 'assets/scan.tif'), await rasterFixture(68, 40).tiff().toBuffer());
  await writeFile(join(projectRoot, 'assets/scan.tiff'), await rasterFixture(68, 40).tiff().toBuffer());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="69" height="40"><rect width="69" height="40" fill="#336699"/></svg>';
  await writeFile(join(projectRoot, 'assets/icon.svg'), svg, 'utf8');
  await writeFile(join(projectRoot, 'assets/icon.svgz'), await gzipBuffer(Buffer.from(svg)));
}

function rasterFixture(width: number, height: number): Sharp {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 51, g: 102, b: 153, alpha: 1 }
    }
  });
}

describe('CanvasRasterPreviewService', () => {
  it('writes a resized PNG preview without enlarging the source', async () => {
    await withTemporaryRoot('debrute-raster-preview-', async (root) => {
      await mkdir(join(root, 'assets'), { recursive: true });
      await sharp({
        create: {
          width: 100,
          height: 50,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0.5 }
        }
      }).png().toFile(join(root, 'assets/source.png'));

      const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
      const result = await service.generate({
        sourceAbsolutePath: join(root, 'assets/source.png'),
        outputAbsolutePath: join(root, '.debrute/cache/test.preview-w40.png'),
        width: 40
      });

      expect(result.absolutePath).toBe(join(root, '.debrute/cache/test.preview-w40.png'));
      const output = await sharp(result.absolutePath).toBuffer({ resolveWithObject: true });
      expect(output.info.width).toBe(40);
      expect(output.info.height).toBe(20);
      expect(output.info.hasAlpha).toBe(true);
    });
  });

  it('writes a resized JPEG preview for opaque sources and reports output without alpha', async () => {
    await withTemporaryRoot('debrute-raster-preview-opaque-', async (root) => {
      await mkdir(join(root, 'assets'), { recursive: true });
      await sharp({
        create: {
          width: 100,
          height: 50,
          channels: 3,
          background: { r: 255, g: 0, b: 0 }
        }
      }).jpeg().toFile(join(root, 'assets/source.jpg'));

      const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
      const result = await service.generate({
        sourceAbsolutePath: join(root, 'assets/source.jpg'),
        outputAbsolutePath: join(root, '.debrute/cache/test.preview-w40.jpg'),
        width: 40
      });

      expect(result.absolutePath).toBe(join(root, '.debrute/cache/test.preview-w40.jpg'));
      const output = await sharp(result.absolutePath).toBuffer({ resolveWithObject: true });
      expect(output.info.width).toBe(40);
      expect(output.info.height).toBe(20);
      expect(output.info.hasAlpha).toBe(false);
    });
  });

  it('reads source metadata through the shared metadata helper', async () => {
    await withTemporaryRoot('debrute-raster-metadata-', async (root) => {
      const source = join(root, 'source.jpg');
      await sharp({
        create: {
          width: 80,
          height: 60,
          channels: 3,
          background: { r: 20, g: 30, b: 40 }
        }
      }).jpeg().toFile(source);

      await expect(readCanvasRasterPreviewMetadata(source, 'source.jpg')).resolves.toMatchObject({
        width: 80,
        height: 60
      });
    });
  });

  it('rejects widths larger than the source', async () => {
    await withTemporaryRoot('debrute-raster-width-', async (root) => {
      const source = join(root, 'source.png');
      await sharp({
        create: {
          width: 50,
          height: 30,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
      }).png().toFile(source);

      const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
      await expect(service.generate({
        sourceAbsolutePath: source,
        outputAbsolutePath: join(root, 'preview.png'),
        width: 80
      })).rejects.toThrow('Canvas raster preview width exceeds source width.');
    });
  });

  it('leaves only the final file after atomic write', async () => {
    await withTemporaryRoot('debrute-raster-atomic-', async (root) => {
      const source = join(root, 'source.png');
      const output = join(root, 'cache/preview.png');
      await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 10, g: 20, b: 30, alpha: 1 }
        }
      }).png().toFile(source);

      const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
      await service.generate({ sourceAbsolutePath: source, outputAbsolutePath: output, width: 32 });

      await expect(stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(readFile(output)).resolves.toBeInstanceOf(Buffer);
    });
  });
});

describe('DebruteAppServer Canvas image preview cache cleanup', () => {
  it('reconciles Canvas image preview cache when opening a project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-open-preview-cleanup-'));
    const server = new DebruteAppServer();
    try {
      await writeImageFixture(projectRoot, 'images/cover.png');
      const fixture = await writeImagePreviewCacheRevisionFixtures(projectRoot, 'images/cover.png');

      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });

      await expect(readdir(fixture.sourceCacheRoot)).resolves.toEqual([fixture.currentRevisionKey]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reconciles Canvas image preview cache when refreshing a project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-refresh-preview-cleanup-'));
    const server = new DebruteAppServer();
    try {
      await writeImageFixture(projectRoot, 'images/cover.png');
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      const fixture = await writeImagePreviewCacheRevisionFixtures(projectRoot, 'images/cover.png');

      await server.refreshProject();

      await expect(readdir(fixture.sourceCacheRoot)).resolves.toEqual([fixture.currentRevisionKey]);
    } finally {
      server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function writeImageFixture(projectRoot: string, projectRelativePath: string): Promise<void> {
  await mkdir(dirname(join(projectRoot, projectRelativePath)), { recursive: true });
  await writeFile(join(projectRoot, projectRelativePath), await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 1 }
    }
  }).png().toBuffer());
}

async function writeImagePreviewCacheRevisionFixtures(
  projectRoot: string,
  projectRelativePath: string
): Promise<{ sourceCacheRoot: string; currentRevisionKey: string }> {
  const sourceStat = await stat(join(projectRoot, projectRelativePath));
  const sourceKey = projectRelativePathCacheKey(projectRelativePath);
  const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
  const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
  await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
  await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
  await mkdir(join(sourceCacheRoot, 'old%3A10'), { recursive: true });
  await writeFile(join(sourceCacheRoot, 'old%3A10', 'preview-w32.jpg'), 'old');
  return {
    sourceCacheRoot,
    currentRevisionKey
  };
}

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

async function withTemporaryRoot<T>(
  prefix: string,
  run: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
