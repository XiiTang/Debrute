import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS } from '@debrute/canvas-core';
import {
  canvasImageSourceRevision,
  createCanvasImagePreviewConcurrencyLimiter,
  createCanvasImagePreviewService
} from '../apps/app-server/src/canvas/CanvasImagePreviewService';

describe('canvas image preview service', () => {
  it('generates fixed-width local previews and reuses the cache file', async () => {
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
        width: 256
      });
      const firstStat = await stat(first.absolutePath);
      const firstMetadata = await sharp(first.absolutePath).metadata();
      const second = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 256
      });

      expect(CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS).toEqual([256, 512, 1024, 2048]);
      expect(Object.keys(first).sort()).toEqual(['absolutePath']);
      expect(first.absolutePath).toContain('/.debrute/cache/canvas-image-previews/');
      expect(firstMetadata.width).toBe(256);
      expect(firstMetadata.height).toBe(128);
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
        service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 1024 }),
        service.resolve({ projectRoot, projectRelativePath: 'images/cover.png', revision, width: 1024 })
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

  it('reuses an existing cache file without re-reading source image metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-cache-first-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      const sourceBytes = await previewablePngBuffer();
      const fixedTime = new Date('2026-01-01T00:00:00.000Z');
      await writeFile(sourcePath, sourceBytes);
      await utimes(sourcePath, fixedTime, fixedTime);
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const first = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 256
      });

      await writeFile(sourcePath, Buffer.alloc(sourceBytes.byteLength, 0));
      await utimes(sourcePath, fixedTime, fixedTime);

      await expect(canvasImageSourceRevision(projectRoot, 'images/cover.png')).resolves.toBe(revision);
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 256
      })).resolves.toEqual(first);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('limits concurrent Canvas image preview work', async () => {
    const limit = createCanvasImagePreviewConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 8 }, (_item, index) => limit(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return index;
    })));

    expect(maxActive).toBeLessThanOrEqual(2);
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

  it('rejects source images that are too small to benefit from Canvas previews', async () => {
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

      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/small.png',
        revision,
        width: 256
      })).rejects.toThrow('Canvas image is not previewable: images/small.png');
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

  it('rejects stale revisions, unsupported widths, unsafe paths, and non-previewable images', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-service-reject-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), await previewablePngBuffer());
      await writeFile(join(projectRoot, 'images/vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />', 'utf8');
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
        width: 300
      })).rejects.toThrow('Unsupported Canvas preview width');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: '../cover.png',
        revision,
        width: 256
      })).rejects.toThrow('Project path must not contain "." or ".." segments');
      await expect(service.resolve({
        projectRoot,
        projectRelativePath: 'images/vector.svg',
        revision: await canvasImageSourceRevision(projectRoot, 'images/vector.svg'),
        width: 256
      })).rejects.toThrow('not previewable');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function previewablePngBuffer(width = 1024, height = 512): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: {
      width,
      height,
      channels: 3
    }
  }).png().toBuffer();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
