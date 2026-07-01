import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { projectFileRevision } from '@debrute/project-core';
import {
  createCanvasVideoPreviewService,
  type CanvasVideoFrameExtractor
} from './CanvasVideoPreviewService.js';
import { readCanvasRasterPreviewMetadata } from './CanvasRasterPreviewService.js';

describe('CanvasVideoPreviewService', () => {
  it('copies an explicit same-basename poster into the video preview cache before serving variants', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-explicit-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await writeFixtureImage(join(projectRoot, 'media/clip.jpg'), 320, 180);
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({ frameExtractor: frameExtractorThatFails() });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{ projectRelativePath: 'media/clip.mp4', videoRevision, currentTimeSeconds: 0 }]
      });
      const source = result.sources['media/clip.mp4'];

      expect(source).toMatchObject({
        status: 'available',
        sourceKind: 'initial-poster',
        sourceWidth: 320
      });
      if (!source || source.status !== 'available') {
        throw new Error('Expected available source.');
      }
      expect(source.sourceKey).toContain('explicit');

      const variant = await service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'media/clip.mp4',
        videoRevision,
        currentTimeSeconds: 0,
        sourceKey: source.sourceKey,
        width: 80
      });

      expect(variant.absolutePath).toContain('.debrute/cache/canvas-video-previews/canvas-1/');
      expect(variant.absolutePath).toContain('preview-w80.jpg');
      await expect(readCanvasRasterPreviewMetadata(variant.absolutePath, 'media/clip.mp4'))
        .resolves.toMatchObject({ width: 80 });
      await expect(readFile(join(projectRoot, 'media/clip.jpg'))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports a broken explicit poster without trying later candidates or auto extraction', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-broken-explicit-'));
    const frameExtractor = frameExtractorThatWrites();
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.poster.jpg'), 'not an image', 'utf8');
      await writeFixtureImage(join(projectRoot, 'media/clip.jpg'), 320, 180);
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({ frameExtractor });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision,
          currentTimeSeconds: 0
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'error',
        sourceKind: 'initial-poster',
        message: expect.stringContaining('clip.poster.jpg')
      });
      expect(frameExtractor.extractFrame).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports a non-file explicit poster candidate without trying later candidates or auto extraction', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-directory-poster-'));
    const frameExtractor = frameExtractorThatWrites();
    try {
      await mkdir(join(projectRoot, 'media/clip.poster.jpg'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await writeFixtureImage(join(projectRoot, 'media/clip.jpg'), 320, 180);
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({ frameExtractor });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision,
          currentTimeSeconds: 0
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'error',
        sourceKind: 'initial-poster',
        message: expect.stringContaining('media/clip.poster.jpg')
      });
      expect(frameExtractor.extractFrame).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('extracts a playback-frame source for non-zero playback time', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-playback-'));
    const frameExtractor = frameExtractorThatWrites();
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      await writeFixtureImage(join(projectRoot, 'media/clip.jpg'), 320, 180);
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({
        frameExtractor,
        readVideoMetadata: async () => ({ durationSeconds: 10 })
      });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision,
          currentTimeSeconds: 7.5
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'available',
        sourceKind: 'playback-frame'
      });
      expect(frameExtractor.extractFrame).toHaveBeenCalledWith(expect.objectContaining({
        projectRelativePath: 'media/clip.mp4',
        currentTimeSeconds: 7.5
      }));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports out-of-duration playback timestamps without extracting a frame', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-duration-'));
    const frameExtractor = frameExtractorThatWrites();
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({
        frameExtractor,
        readVideoMetadata: async () => ({ durationSeconds: 5 })
      });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision,
          currentTimeSeconds: 7.5
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'error',
        sourceKind: 'playback-frame',
        message: 'Canvas video playback time exceeds video duration: media/clip.mp4'
      });
      expect(frameExtractor.extractFrame).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports a source error when the requested video revision is stale', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-stale-source-'));
    const frameExtractor = frameExtractorThatWrites();
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-v1', 'utf8');
      const staleRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-v2-with-new-bytes', 'utf8');
      const service = createCanvasVideoPreviewService({ frameExtractor });

      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision: staleRevision,
          currentTimeSeconds: 0
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'error',
        sourceKind: 'initial-poster',
        message: 'Canvas video preview revision does not match source: media/clip.mp4'
      });
      expect(frameExtractor.extractFrame).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects variant requests when the requested video revision is stale even if a cached variant exists', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-stale-variant-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-v1', 'utf8');
      const staleRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({ frameExtractor: frameExtractorThatWrites() });
      const result = await service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision: staleRevision,
          currentTimeSeconds: 0
        }]
      });
      const source = result.sources['media/clip.mp4'];
      if (!source || source.status !== 'available') {
        throw new Error('Expected available source.');
      }
      await service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'media/clip.mp4',
        videoRevision: staleRevision,
        currentTimeSeconds: 0,
        sourceKey: source.sourceKey,
        width: 80
      });

      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-v2-with-new-bytes', 'utf8');

      await expect(service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'media/clip.mp4',
        videoRevision: staleRevision,
        currentTimeSeconds: 0,
        sourceKey: source.sourceKey,
        width: 80
      })).rejects.toThrow('Canvas video preview revision does not match source: media/clip.mp4');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects variant requests for a missing source key', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-missing-source-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      const videoRevision = await fileRevision(projectRoot, 'media/clip.mp4');
      const service = createCanvasVideoPreviewService({ frameExtractor: frameExtractorThatFails() });

      await expect(service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'media/clip.mp4',
        videoRevision,
        currentTimeSeconds: 0,
        sourceKey: 'missing-source',
        width: 80
      })).rejects.toThrow('Canvas video preview source is not available: media/clip.mp4');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function fileRevision(projectRoot: string, projectRelativePath: string): Promise<string> {
  const fileStat = await stat(join(projectRoot, projectRelativePath));
  return projectFileRevision(fileStat.size, fileStat.mtimeMs);
}

function frameExtractorThatWrites(): CanvasVideoFrameExtractor {
  return {
    extractFrame: vi.fn(async (input) => {
      await writeFixtureImage(input.outputAbsolutePath, 320, 180);
    })
  };
}

function frameExtractorThatFails(): CanvasVideoFrameExtractor {
  return {
    extractFrame: vi.fn(async () => {
      throw new Error('frame extraction should not run');
    })
  };
}

async function writeFixtureImage(path: string, width: number, height: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 80, b: 120 }
    }
  }).jpeg().toFile(path);
  await stat(path);
}
