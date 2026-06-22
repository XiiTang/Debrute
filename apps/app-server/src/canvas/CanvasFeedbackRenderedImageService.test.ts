import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { canvasFeedbackRenderedProjectPath } from '@debrute/canvas-core';
import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import {
  removeCanvasFeedbackRenderedArtifact,
  removeUnexpectedCanvasFeedbackRenderedArtifacts,
  createCanvasFeedbackOverlaySvg,
  renderCanvasFeedbackAnnotatedImage
} from './CanvasFeedbackRenderedImageService';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasFeedbackRenderedImageService', () => {
  it('places rectangular labels at their top-left anchor', () => {
    const overlay = createCanvasFeedbackOverlaySvg({
      width: 200,
      height: 100,
      entry: {
        regions: [{
          id: 'region-rect',
          label: 7,
          kind: 'region',
          geometry: { type: 'rect', x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
          comment: 'rect comment',
          createdAt: NOW,
          updatedAt: NOW
        }, {
          id: 'region-edge',
          label: 9,
          kind: 'region',
          geometry: { type: 'rect', x: 0, y: 0, width: 0.1, height: 0.1 },
          comment: 'edge comment',
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    });

    expect(overlay).toContain('<circle class="badge" cx="80" cy="30" r="15" />');
    expect(overlay).toContain('<text class="label" x="80" y="30">7</text>');
    expect(overlay).toContain('<circle class="badge" cx="0" cy="0" r="15" />');
    expect(overlay).toContain('<text class="label" x="0" y="0">9</text>');
  });

  it('renders numbered feedback overlays to a caller-owned temporary PNG path', async () => {
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
      const result = await renderCanvasFeedbackAnnotatedImage({
        jobId: 'job-1',
        projectRoot,
        entry: entryFixture('page.png'),
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

  it('renders numbered feedback overlays from an AVIF source image', async () => {
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
      const result = await renderCanvasFeedbackAnnotatedImage({
        jobId: 'job-1',
        projectRoot,
        entry: entryFixture('page.avif'),
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

  it('removes obsolete rendered artifacts when an entry loses all local regions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-remove-'));
    try {
      const renderedPath = join(projectRoot, '.debrute/reviews/rendered-feedback/assets/page.png.annotated.png');
      await mkdir(join(projectRoot, '.debrute/reviews/rendered-feedback/assets'), { recursive: true });
      await writeFile(renderedPath, Buffer.from('old'));

      await removeCanvasFeedbackRenderedArtifact(projectRoot, 'assets/page.png');

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
      await mkdir(join(projectRoot, '.debrute/reviews/rendered-feedback/assets'), { recursive: true });
      await writeFile(obsoleteRenderedPath, Buffer.from('old'));

      await removeUnexpectedCanvasFeedbackRenderedArtifacts(projectRoot, new Set([
        canvasFeedbackRenderedProjectPath('assets/page.png')
      ]));

      await expect(stat(obsoleteRenderedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function entryFixture(projectRelativePath: string): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: ['needs_revision'],
    comments: [{
      id: 'comment-1',
      comment: 'overall comment',
      createdAt: NOW,
      updatedAt: NOW
    }],
    nextRegionLabel: 3,
    regions: [{
      id: 'region-1',
      label: 1,
      kind: 'pin',
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      comment: 'pin comment',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'region-2',
      label: 2,
      kind: 'region',
      geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
      comment: 'rect comment',
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
