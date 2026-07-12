import { parseFfprobeDimensions, parseFfprobeVideoMetadata, readCanvasNodeLayoutSize } from '../../../apps/app-server/src/canvas/CanvasNodeDimensionsService';
import { readCanvasRasterPreviewMetadata } from '../../../apps/app-server/src/canvas/CanvasRasterPreviewService';
import { createCanvasTextPreviewService } from '../../../apps/app-server/src/canvas/CanvasTextPreviewService';
import { buildCanvasVideoPresentation } from '../../../apps/app-server/src/canvas/CanvasVideoPresentationService';
import { createCanvasVideoPreviewService } from '../../../apps/app-server/src/canvas/CanvasVideoPreviewService';
import type { CanvasVideoFrameExtractor } from '../../../apps/app-server/src/canvas/CanvasVideoPreviewService';
import { DebruteAppServer } from '../../../apps/app-server/src/server/DebruteAppServer';
import { canvasTextPreviewSourceProjectPath, canvasTextPreviewVariantProjectPath } from '@debrute/canvas-core';
import { projectFileRevision } from '@debrute/project-core';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

describe('canvas node dimensions', () => {
  it('keeps short directory and unknown-file nodes at their minimum generic Canvas sizes', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1840, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production/archive.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1800, height: 640 });
  });

  it('expands directory and unknown-file Canvas widths from long display names', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/long-folder-name-for-rendering-output-archive',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 4160, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/unsupported-reference-render-settings.archive',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 4160, height: 640 });
  });

  it('caps generic Canvas widths for very long directory and unknown-file names', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'outputs/this-is-an-extremely-long-folder-name-that-should-hit-the-generic-node-width-cap',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 6960, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'outputs/this-is-an-extremely-long-unsupported-file-name-that-should-hit-the-generic-node-width-cap.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 7200, height: 640 });
  });

  it('counts full-width display name characters wider than Latin characters', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/中文资料归档文件夹名称很长',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2640, height: 640 });
  });

  it('uses fixed intrinsic Canvas sizes for text and audio', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'notes/brief.md',
      nodeKind: 'file',
      mediaKind: 'text'
    })).resolves.toEqual({ width: 4200, height: 2800 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'audio/theme.mp3',
      nodeKind: 'file',
      mediaKind: 'audio'
    })).resolves.toEqual({ width: 3200, height: 960 });
  });

  it('reads intrinsic image dimensions with sharp', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-image-dimensions-'));
    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await sharp({
        create: {
          width: 37,
          height: 23,
          channels: 4,
          background: '#336699ff'
        }
      }).png().toFile(join(projectRoot, 'generated/cover.png'));

      await expect(readCanvasNodeLayoutSize({
        projectRoot,
        projectRelativePath: 'generated/cover.png',
        nodeKind: 'file',
        mediaKind: 'image'
      })).resolves.toEqual({ width: 37, height: 23 });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('parses ffprobe video stream dimensions', () => {
    expect(parseFfprobeDimensions(JSON.stringify({
      streams: [
        { codec_type: 'audio' },
        { codec_type: 'video', width: 1920, height: 1080 }
      ]
    }))).toEqual({ width: 1920, height: 1080 });
  });

  it('parses ffprobe video stream dimensions and duration', () => {
    expect(parseFfprobeVideoMetadata(JSON.stringify({
      streams: [
        { codec_type: 'audio' },
        { codec_type: 'video', width: 1920, height: 1080, duration: '12.5' }
      ],
      format: { duration: '13.25' }
    }))).toEqual({ width: 1920, height: 1080, durationSeconds: 12.5 });

    expect(parseFfprobeVideoMetadata(JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1280, height: 720 }
      ],
      format: { duration: '3.25' }
    }))).toEqual({ width: 1280, height: 720, durationSeconds: 3.25 });
  });

});

describe('CanvasTextPreviewService', { tags: ['canvas-text'] }, () => {
  it('saves source.png as the only initial source artifact', async () => {
    await withTemporaryRoot('debrute-text-preview-source-', async (projectRoot) => {
      const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 1200, 640);
      const service = createCanvasTextPreviewService();

      await expect(service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        sourceTemporaryPath: sourceUpload
      })).resolves.toEqual({
        ok: true,
        source: {
          projectRelativePath: 'notes/scene.md',
          fingerprint: 'fingerprint-a',
          status: 'available'
        }
      });

      const sourcePath = join(projectRoot, canvasTextPreviewSourceProjectPath({
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a'
      }));
      await expect(pathExists(sourcePath)).resolves.toBe(true);
      await expect(readdir(dirname(sourcePath))).resolves.toEqual(['source.png']);
    });
  });

  it('isolates an invalid source from other availability results in the same batch', async () => {
    await withTemporaryRoot('debrute-text-preview-availability-', async (projectRoot) => {
      const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
      const service = createCanvasTextPreviewService();
      await service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        sourceTemporaryPath: sourceUpload
      });

      await expect(service.readSources({
        projectRoot,
        canvasId: 'canvas-1',
        sources: [
          { projectRelativePath: 'notes/scene.md', fingerprint: 'fingerprint-a' },
          { projectRelativePath: 'notes/missing.md', fingerprint: 'fingerprint-missing' },
          { projectRelativePath: '../invalid.md', fingerprint: 'fingerprint-invalid' }
        ]
      })).resolves.toEqual({
        sources: {
          'notes/scene.md': {
            projectRelativePath: 'notes/scene.md',
            fingerprint: 'fingerprint-a',
            status: 'available'
          },
          'notes/missing.md': {
            projectRelativePath: 'notes/missing.md',
            fingerprint: 'fingerprint-missing',
            status: 'missing'
          },
          '../invalid.md': {
            projectRelativePath: '../invalid.md',
            fingerprint: 'fingerprint-invalid',
            status: 'error',
            message: 'Project path must not contain "." or ".." segments: ../invalid.md'
          }
        }
      });
    });
  });

  it('generates a requested variant from source.png when missing', async () => {
    await withTemporaryRoot('debrute-text-preview-variant-', async (projectRoot) => {
      const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
      const service = createCanvasTextPreviewService();
      await service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        sourceTemporaryPath: sourceUpload
      });

      const result = await service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        width: 80
      });

      expect(result.absolutePath).toContain('preview-w80.png');
      await expect(readCanvasRasterPreviewMetadata(result.absolutePath, 'notes/scene.md'))
        .resolves.toMatchObject({ width: 80 });
    });
  });

  it('deduplicates concurrent variant generation for the same source key and width', async () => {
    await withTemporaryRoot('debrute-text-preview-dedupe-', async (projectRoot) => {
      const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
      const service = createCanvasTextPreviewService();
      await service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        sourceTemporaryPath: sourceUpload
      });

      const input = {
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        width: 80
      };

      const [first, second] = await Promise.all([
        service.resolveVariant(input),
        service.resolveVariant(input)
      ]);

      expect(first).toBe(second);
      expect(first.absolutePath).toContain('preview-w80.png');
      await expect(readCanvasRasterPreviewMetadata(first.absolutePath, 'notes/scene.md'))
        .resolves.toMatchObject({ width: 80 });
    });
  });

  it('fails variant resolution when source.png is missing', async () => {
    await withTemporaryRoot('debrute-text-preview-missing-', async (projectRoot) => {
      const service = createCanvasTextPreviewService();

      await expect(service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/missing.md',
        fingerprint: 'fingerprint-missing',
        width: 80
      })).rejects.toThrow('Canvas text preview source is not available: notes/missing.md');
    });
  });

  it('does not replace or regenerate source.png when variant generation fails', async () => {
    await withTemporaryRoot('debrute-text-preview-variant-failure-', async (projectRoot) => {
      const sourceUpload = join(projectRoot, 'invalid-source-upload.png');
      const sourceBytes = Buffer.from('not-a-png', 'utf8');
      await writeFile(sourceUpload, sourceBytes);
      const service = createCanvasTextPreviewService();
      const source = {
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'generated/long-line.json',
        fingerprint: 'fingerprint-current'
      };

      await service.saveSource({ ...source, sourceTemporaryPath: sourceUpload });
      await expect(service.resolveVariant({ ...source, width: 80 })).rejects.toThrow();

      const sourcePath = join(projectRoot, canvasTextPreviewSourceProjectPath(source));
      const variantPath = join(projectRoot, canvasTextPreviewVariantProjectPath({ ...source, width: 80 }));
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
      await expect(stat(variantPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps variant files isolated by fingerprint', async () => {
    await withTemporaryRoot('debrute-text-preview-isolated-', async (projectRoot) => {
      const firstSource = await writeFixturePng(projectRoot, 'first.png', 64, 32, { r: 255, g: 0, b: 0, alpha: 1 });
      const secondSource = await writeFixturePng(projectRoot, 'second.png', 64, 32, { r: 0, g: 0, b: 255, alpha: 1 });
      const service = createCanvasTextPreviewService();

      await service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        sourceTemporaryPath: firstSource
      });
      const firstVariant = await service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        width: 64
      });
      const firstVariantHash = sha256(await readFile(firstVariant.absolutePath));

      await service.saveSource({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-b',
        sourceTemporaryPath: secondSource
      });
      const secondVariant = await service.resolveVariant({
        projectRoot,
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-b',
        width: 64
      });

      expect(secondVariant.absolutePath).not.toBe(firstVariant.absolutePath);
      expect(sha256(await readFile(firstVariant.absolutePath))).toBe(firstVariantHash);
      expect(sha256(await readFile(secondVariant.absolutePath))).not.toBe(firstVariantHash);
      expect(secondVariant.absolutePath).toBe(join(projectRoot, canvasTextPreviewVariantProjectPath({
        canvasId: 'canvas-1',
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-b',
        width: 64
      })));
    });
  });
});

async function writeFixturePng(
  projectRoot: string,
  name: string,
  width: number,
  height: number,
  background = { r: 30, g: 40, b: 50, alpha: 1 }
): Promise<string> {
  const outputPath = join(projectRoot, name);
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  }).png().toFile(outputPath);
  return outputPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('CanvasVideoPresentationService', { tags: ['canvas-video'] }, () => {
  it('builds playback metadata and VTT companions without poster data', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-tracks-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.poster.webp'), 'poster', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.en.captions.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.zh-CN.subtitles.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.chapters.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.thumbnails.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/cover.jpg'), 'not-a-poster', 'utf8');
      const presentation = await buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'media/clip.mp4',
        width: 640,
        height: 360,
        durationSeconds: 5
      });

      expect(presentation).not.toHaveProperty('poster');
      expect(presentation.kind).toBe('video');
      expect(presentation.width).toBe(640);
      expect(presentation.height).toBe(360);
      expect(presentation.durationSeconds).toBe(5);
      expect(presentation.textTracks).toEqual([
        expect.objectContaining({ projectRelativePath: 'media/clip.en.captions.vtt', kind: 'captions', srclang: 'en', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.zh-CN.subtitles.vtt', kind: 'subtitles', srclang: 'zh-CN', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.chapters.vtt', kind: 'chapters', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.thumbnails.vtt', kind: 'metadata', label: 'thumbnails', default: false })
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces unsafe existing VTT companion paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-track-error-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-outside-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await symlink(outsideRoot, join(projectRoot, 'media/clip.en.captions.vtt'), directoryLinkType());

      await expect(buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'media/clip.mp4',
        width: 640,
        height: 360
      })).rejects.toThrow('Project path escapes project root through a symlink: media/clip.en.captions.vtt');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe('CanvasVideoPreviewService', { tags: ['canvas-video'] }, () => {
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
        readVideoMetadata: async () => ({ width: 320, height: 180, durationSeconds: 10 })
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
        readVideoMetadata: async () => ({ width: 320, height: 180, durationSeconds: 5 })
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

describe('DebruteAppServer Canvas video previews', { tags: ['canvas-video'] }, () => {
  it('uses the integration env path for Canvas video preview frame extraction', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-preview-env-path-'));
    const integrationBin = join(projectRoot, 'integration-bin');
    const framePath = join(projectRoot, 'fixtures/frame.png');
    const server = new DebruteAppServer({
      integrationEnvPath: integrationBin,
      canvasVideoFrameExtractorFactory: ({ envPath }) => {
        if (envPath !== integrationBin) {
          throw new Error(`Unexpected Canvas video frame extraction PATH: ${String(envPath)}`);
        }
        return {
          extractFrame: async ({ outputAbsolutePath }) => {
            await mkdir(dirname(outputAbsolutePath), { recursive: true });
            await sharp(framePath).toFile(outputAbsolutePath);
          }
        };
      }
    });
    try {
      await server.openProject(projectRoot, {
        initializeIfMissing: true,
        createDefaultCanvas: true,
        watchFiles: false
      });
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video-bytes', 'utf8');
      const videoStat = await stat(join(projectRoot, 'media/clip.mp4'));
      const videoRevision = projectFileRevision(videoStat.size, videoStat.mtimeMs);
      await writeImageFixture(projectRoot, 'fixtures/frame.png');

      const result = await server.readCanvasVideoPreviewSources({
        canvasId: 'canvas-1',
        targets: [{
          projectRelativePath: 'media/clip.mp4',
          videoRevision,
          currentTimeSeconds: 0
        }]
      });

      expect(result.sources['media/clip.mp4']).toMatchObject({
        status: 'available',
        sourceKind: 'initial-poster',
        sourceWidth: 32
      });
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
