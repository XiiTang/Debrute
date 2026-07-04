import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  canvasFeedbackRenderedMomentProjectPath,
  canvasFeedbackRenderedProjectPath,
  type CanvasFeedbackEntry
} from '@debrute/canvas-core';
import {
  createCanvasFeedbackOverlaySvg,
  removeCanvasFeedbackRenderedArtifact,
  removeUnexpectedCanvasFeedbackRenderedArtifacts,
  renderCanvasFeedbackArtifact
} from './CanvasFeedbackArtifactService';
import type { CanvasVideoFrameExtractorInput } from './CanvasVideoFrameExtractor';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasFeedbackArtifactService', () => {
  it('places rectangular labels at their top-left anchor', () => {
    const overlay = createCanvasFeedbackOverlaySvg({
      width: 200,
      height: 100,
      items: [{
        id: 'item-rect',
        label: 7,
        kind: 'region',
        scope: 'file',
        geometry: { type: 'rect', x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
        comment: 'rect comment',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-edge',
        label: 9,
        kind: 'region',
        scope: 'file',
        geometry: { type: 'rect', x: 0, y: 0, width: 0.1, height: 0.1 },
        comment: 'edge comment',
        createdAt: NOW,
        updatedAt: NOW
      }]
    });

    expect(overlay).toContain('<circle class="badge" cx="80" cy="30" r="15" />');
    expect(overlay).toContain('<text class="label" x="80" y="30">7</text>');
    expect(overlay).toContain('<circle class="badge" cx="0" cy="0" r="15" />');
    expect(overlay).toContain('<text class="label" x="0" y="0">9</text>');
  });

  it('renders image feedback overlays to a caller-owned temporary PNG path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-'));
    try {
      await writeFile(join(projectRoot, 'page.png'), await sharp({
        create: {
          width: 120,
          height: 80,
          channels: 4,
          background: { r: 240, g: 240, b: 240, alpha: 1 }
        }
      }).png().toBuffer());

      const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/page.png.annotated.png.job-1.tmp');
      const result = await renderCanvasFeedbackArtifact({
        jobId: 'job-1',
        projectRoot,
        artifact: {
          kind: 'image',
          projectRelativePath: 'page.png',
          entry: entryFixture('page.png')
        },
        outputPath
      });

      expect(result).toMatchObject({
        ok: true,
        jobId: 'job-1',
        outputPath,
        width: 120,
        height: 80
      });
      const output = await sharp(outputPath).metadata();
      expect(output.width).toBe(120);
      expect(output.height).toBe(80);
      expect(output.format).toBe('png');
      const outputBytes = await readFile(outputPath);
      expect(outputBytes.includes(Buffer.from('pin comment'))).toBe(false);
      expect(outputBytes.includes(Buffer.from('rect comment'))).toBe(false);
      expect(await countNonBackgroundPixels(outputPath, { r: 240, g: 240, b: 240 })).toBeGreaterThan(0);
      await expect(stat(join(projectRoot, canvasFeedbackRenderedProjectPath('page.png')))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('renders image feedback overlays from an AVIF source image', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-render-avif-'));
    try {
      await writeFile(join(projectRoot, 'page.avif'), await sharp({
        create: {
          width: 96,
          height: 64,
          channels: 4,
          background: { r: 240, g: 240, b: 240, alpha: 1 }
        }
      }).avif().toBuffer());

      const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/page.avif.annotated.png.job-1.tmp');
      const result = await renderCanvasFeedbackArtifact({
        jobId: 'job-1',
        projectRoot,
        artifact: {
          kind: 'image',
          projectRelativePath: 'page.avif',
          entry: entryFixture('page.avif')
        },
        outputPath
      });

      expect(result).toMatchObject({
        ok: true,
        jobId: 'job-1',
        outputPath,
        width: 96,
        height: 64
      });
      const output = await sharp(outputPath).metadata();
      expect(output.width).toBe(96);
      expect(output.height).toBe(64);
      expect(output.format).toBe('png');
      expect(await countNonBackgroundPixels(outputPath, { r: 240, g: 240, b: 240 })).toBeGreaterThan(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('renders video moment artifacts from an extracted frame and moment spatial items', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-artifact-'));
    try {
      await writeFile(join(projectRoot, 'frame.png'), await sharp({
        create: {
          width: 160,
          height: 90,
          channels: 4,
          background: { r: 16, g: 16, b: 16, alpha: 1 }
        }
      }).png().toBuffer());
      await writeFile(join(projectRoot, 'clip.mp4'), 'video');
      const extractFrame = vi.fn(async (input: CanvasVideoFrameExtractorInput) => {
        await mkdir(dirname(input.outputAbsolutePath), { recursive: true });
        await copyFile(join(projectRoot, 'frame.png'), input.outputAbsolutePath);
      });

      const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/clip.mp4.moment-M1.annotated.png.job-1.tmp');
      const result = await renderCanvasFeedbackArtifact({
        jobId: 'job-1',
        projectRoot,
        artifact: {
          kind: 'video-moment',
          projectRelativePath: 'clip.mp4',
          moment: { label: 'M1', currentTimeSeconds: 4.25 },
          entry: videoEntryFixture('clip.mp4')
        },
        outputPath
      }, {
        frameExtractor: { extractFrame }
      });

      expect(result).toMatchObject({
        ok: true,
        jobId: 'job-1',
        outputPath,
        width: 160,
        height: 90
      });
      expect(extractFrame).toHaveBeenCalledWith(expect.objectContaining({
        projectRelativePath: 'clip.mp4',
        currentTimeSeconds: 4.25
      }));
      const outputBytes = await readFile(outputPath);
      expect(outputBytes.includes(Buffer.from('look here'))).toBe(false);
      expect(await countNonBackgroundPixels(outputPath, { r: 16, g: 16, b: 16 })).toBeGreaterThan(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('renders video moment artifacts even when the moment has only a comment item', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-comment-artifact-'));
    try {
      await writeFile(join(projectRoot, 'frame.png'), await sharp({
        create: {
          width: 160,
          height: 90,
          channels: 4,
          background: { r: 16, g: 16, b: 16, alpha: 1 }
        }
      }).png().toBuffer());
      await writeFile(join(projectRoot, 'clip.mp4'), 'video');
      const extractFrame = vi.fn(async (input: CanvasVideoFrameExtractorInput) => {
        await mkdir(dirname(input.outputAbsolutePath), { recursive: true });
        await copyFile(join(projectRoot, 'frame.png'), input.outputAbsolutePath);
      });

      const outputPath = join(projectRoot, '.debrute/reviews/rendered-feedback/clip.mp4.moment-M1.annotated.png.job-1.tmp');
      const result = await renderCanvasFeedbackArtifact({
        jobId: 'job-1',
        projectRoot,
        artifact: {
          kind: 'video-moment',
          projectRelativePath: 'clip.mp4',
          moment: { label: 'M1', currentTimeSeconds: 4.25 },
          entry: videoCommentOnlyEntryFixture('clip.mp4')
        },
        outputPath
      }, {
        frameExtractor: { extractFrame }
      });

      expect(result).toMatchObject({
        ok: true,
        width: 160,
        height: 90
      });
      expect(await countNonBackgroundPixels(outputPath, { r: 16, g: 16, b: 16 })).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes rendered artifacts by artifact project path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-remove-'));
    try {
      const renderedProjectPath = canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1');
      const renderedPath = join(projectRoot, renderedProjectPath);
      await mkdir(dirname(renderedPath), { recursive: true });
      await writeFile(renderedPath, Buffer.from('old'));

      await removeCanvasFeedbackRenderedArtifact(projectRoot, renderedProjectPath);

      await expect(stat(renderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reconciles rendered artifacts from the current feedback document', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-current-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/page.png'), await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 4,
          background: { r: 240, g: 240, b: 240, alpha: 1 }
        }
      }).png().toBuffer());
      const obsoleteRenderedPath = join(projectRoot, '.debrute/reviews/rendered-feedback/assets/old.png.annotated.png');
      await mkdir(dirname(obsoleteRenderedPath), { recursive: true });
      await writeFile(obsoleteRenderedPath, Buffer.from('old'));

      await removeUnexpectedCanvasFeedbackRenderedArtifacts(projectRoot, new Set([
        canvasFeedbackRenderedProjectPath('assets/page.png')
      ]));

      await expect(stat(obsoleteRenderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps in-flight temporary frame files while reconciling rendered artifacts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-current-temp-'));
    try {
      const expectedRenderedPath = join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1'));
      const tempFramePath = `${expectedRenderedPath}.job-1.tmp.frame.png`;
      const obsoleteTmpNamedRenderedPath = join(projectRoot, canvasFeedbackRenderedMomentProjectPath('assets/clip.tmp.mp4', 'M1'));
      await mkdir(dirname(tempFramePath), { recursive: true });
      await writeFile(tempFramePath, Buffer.from('frame'));
      await writeFile(obsoleteTmpNamedRenderedPath, Buffer.from('old'));

      await removeUnexpectedCanvasFeedbackRenderedArtifacts(projectRoot, new Set([
        canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M1')
      ]));

      await expect(stat(tempFramePath)).resolves.toMatchObject({ size: 5 });
      await expect(stat(obsoleteTmpNamedRenderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function entryFixture(projectRelativePath: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: ['needs_revision'],
    nextMomentLabel: 1,
    nextSpatialLabel: 3,
    items: [{
      id: 'item-1',
      label: 1,
      kind: 'pin',
      scope: 'file',
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      comment: 'pin comment',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'item-2',
      label: 2,
      kind: 'region',
      scope: 'file',
      geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
      comment: 'rect comment',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'item-comment',
      kind: 'comment',
      scope: 'file',
      comment: 'overall comment',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}

function videoEntryFixture(projectRelativePath: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: [],
    nextMomentLabel: 2,
    nextSpatialLabel: 3,
    items: [{
      id: 'item-comment',
      kind: 'comment',
      scope: 'moment',
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'look here',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'item-pin',
      kind: 'pin',
      scope: 'moment',
      label: 1,
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'pin',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'item-region',
      kind: 'region',
      scope: 'moment',
      label: 2,
      geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'rect',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}

function videoCommentOnlyEntryFixture(projectRelativePath: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: [],
    nextMomentLabel: 2,
    nextSpatialLabel: 1,
    items: [{
      id: 'item-comment',
      kind: 'comment',
      scope: 'moment',
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'look here',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}

async function countNonBackgroundPixels(
  path: string,
  background: { r: number; g: number; b: number }
): Promise<number> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  let changed = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset] !== background.r || data[offset + 1] !== background.g || data[offset + 2] !== background.b) {
      changed += 1;
    }
  }
  return changed;
}
