import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createCanvasTextPreviewService,
  type CanvasTextPreviewService
} from './CanvasTextPreviewService';
import type { CanvasRasterPreviewService } from './CanvasRasterPreviewService';

describe('CanvasTextPreviewService', () => {
  it('saves a browser source image and descriptor at the mapped text preview path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-source-'));
    const sourceUpload = join(projectRoot, 'upload.png');
    await sharp({
      create: {
        width: 1200,
        height: 640,
        channels: 4,
        background: { r: 20, g: 20, b: 20, alpha: 1 }
      }
    }).png().toFile(sourceUpload);

    const service = createCanvasTextPreviewService();
    const descriptor = await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      contentCssWidth: 600,
      contentCssHeight: 320,
      scrollTop: 0,
      scrollLeft: 0,
      sourceTemporaryPath: sourceUpload
    });

    expect(descriptor).toMatchObject({
      fingerprint: 'fingerprint-a',
      sourceWidth: 1200,
      sourceHeight: 640,
      contentCssWidth: 600,
      contentCssHeight: 320,
      variants: []
    });
    await expect(stat(join(projectRoot, '.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.source.png'))).resolves.toBeTruthy();
    await expect(readFile(join(projectRoot, '.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.preview.json'), 'utf8'))
      .resolves.toContain('fingerprint-a');
  });

  it('reconciles missing variants from an existing source image', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-variants-'));
    const sourceUpload = join(projectRoot, 'upload.png');
    await sharp({
      create: {
        width: 320,
        height: 160,
        channels: 4,
        background: { r: 30, g: 40, b: 50, alpha: 1 }
      }
    }).png().toFile(sourceUpload);

    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      contentCssWidth: 160,
      contentCssHeight: 80,
      scrollTop: 0,
      scrollLeft: 0,
      sourceTemporaryPath: sourceUpload
    });

    const result = await service.reconcile({
      projectRoot,
      canvasId: 'canvas-1',
      devicePixelRatio: 1,
      nodes: [{
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        contentCssWidth: 160,
        contentCssHeight: 80,
        scrollTop: 0,
        scrollLeft: 0
      }]
    });

    expect(result.descriptors['notes/scene.md']?.variants).toEqual([10, 15, 20, 29, 40, 57, 80, 114, 160, 227, 320]);
    await expect(stat(join(projectRoot, '.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.preview-w160.png'))).resolves.toBeTruthy();
  });

  it('generates missing variants in parallel', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-parallel-'));
    const sourceUpload = join(projectRoot, 'upload.png');
    await sharp({
      create: {
        width: 320,
        height: 160,
        channels: 4,
        background: { r: 30, g: 40, b: 50, alpha: 1 }
      }
    }).png().toFile(sourceUpload);

    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      contentCssWidth: 160,
      contentCssHeight: 80,
      scrollTop: 0,
      scrollLeft: 0,
      sourceTemporaryPath: sourceUpload
    });
    const concurrency = observeTextPreviewVariantConcurrency(service);

    await service.reconcile({
      projectRoot,
      canvasId: 'canvas-1',
      devicePixelRatio: 1,
      nodes: [{
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        contentCssWidth: 160,
        contentCssHeight: 80,
        scrollTop: 0,
        scrollLeft: 0
      }]
    });

    expect(concurrency.callCount).toBeGreaterThan(1);
    expect(concurrency.maxActive).toBeGreaterThan(1);
  });

  it('does not create variants when the source fingerprint does not match the node fingerprint', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-stale-'));
    const sourceUpload = join(projectRoot, 'upload.png');
    await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    }).png().toFile(sourceUpload);

    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      contentCssWidth: 100,
      contentCssHeight: 50,
      scrollTop: 0,
      scrollLeft: 0,
      sourceTemporaryPath: sourceUpload
    });

    const result = await service.reconcile({
      projectRoot,
      canvasId: 'canvas-1',
      devicePixelRatio: 1,
      nodes: [{
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-b',
        contentCssWidth: 100,
        contentCssHeight: 50,
        scrollTop: 0,
        scrollLeft: 0
      }]
    });

    expect(result.descriptors).toEqual({});
  });

  it('regenerates existing variant files after a source fingerprint change', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-replace-'));
    const firstSource = join(projectRoot, 'first.png');
    const secondSource = join(projectRoot, 'second.png');
    await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 }
      }
    }).png().toFile(firstSource);
    await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 }
      }
    }).png().toFile(secondSource);

    const service = createCanvasTextPreviewService();
    const commonInput = {
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      contentCssWidth: 32,
      contentCssHeight: 16,
      scrollTop: 0,
      scrollLeft: 0
    };
    await service.saveSource({
      ...commonInput,
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: firstSource
    });
    await service.reconcile({
      ...commonInput,
      devicePixelRatio: 1,
      nodes: [{
        projectRelativePath: commonInput.projectRelativePath,
        fingerprint: 'fingerprint-a',
        contentCssWidth: commonInput.contentCssWidth,
        contentCssHeight: commonInput.contentCssHeight,
        scrollTop: commonInput.scrollTop,
        scrollLeft: commonInput.scrollLeft
      }]
    });
    const variantPath = join(projectRoot, '.debrute/cache/canvas-text-previews/canvas-1/notes/scene.md.preview-w64.png');
    const firstVariantHash = sha256(await readFile(variantPath));

    await service.saveSource({
      ...commonInput,
      fingerprint: 'fingerprint-b',
      sourceTemporaryPath: secondSource
    });
    const result = await service.reconcile({
      ...commonInput,
      devicePixelRatio: 1,
      nodes: [{
        projectRelativePath: commonInput.projectRelativePath,
        fingerprint: 'fingerprint-b',
        contentCssWidth: commonInput.contentCssWidth,
        contentCssHeight: commonInput.contentCssHeight,
        scrollTop: commonInput.scrollTop,
        scrollLeft: commonInput.scrollLeft
      }]
    });

    expect(result.descriptors['notes/scene.md']?.variants).toContain(64);
    expect(sha256(await readFile(variantPath))).not.toBe(firstVariantHash);
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function observeTextPreviewVariantConcurrency(service: CanvasTextPreviewService): {
  readonly callCount: number;
  readonly maxActive: number;
} {
  let active = 0;
  let callCount = 0;
  let maxActive = 0;
  const rasterPreviewService: CanvasRasterPreviewService = {
    generate: async (input) => {
      active += 1;
      callCount += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { absolutePath: input.outputAbsolutePath };
    }
  };
  (service as unknown as { rasterPreviewService: CanvasRasterPreviewService }).rasterPreviewService = rasterPreviewService;
  return {
    get callCount() {
      return callCount;
    },
    get maxActive() {
      return maxActive;
    }
  };
}
